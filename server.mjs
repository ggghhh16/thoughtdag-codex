import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  CODEX_LOGICAL_MODEL,
  CodexAdapterError,
  createCodexAdapter,
  isAbortError,
  normalizePermissionMode,
  redactSensitive,
} from './server/codex-adapter.mjs';
import {
  DESKTOP_CONTROL_HEADER,
  createProjectRegistry,
} from './server/project-registry.mjs';
import { createSafeRemoteUrlGuard } from './server/safe-remote-url.mjs';
import { readBoundedText } from './server/pinned-http.mjs';
import { createLocalRequestGuard, requireLoopbackHost } from './server/http-security.mjs';

// In Electron utilityProcess, pdfjs does not consider itself in Node because
// process.versions.electron changes its environment check. Point its fake
// worker at the bundled worker module so desktop extraction keeps working.
if (process.versions.electron) {
  GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
}

// Minimal .env loader avoids another runtime dependency and works on Node 18.
try {
  for (const line of fs.readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2];
  }
} catch { /* .env is optional */ }

const PORT = Number(process.env.PORT) || 3001;
const HOST = requireLoopbackHost(process.env.HOST || '127.0.0.1');
const codexAdapter = createCodexAdapter();
const projectRegistry = createProjectRegistry();

// Optional dependency: poppler's pdftoppm renders PDF pages as images for
// vision. PDF text extraction remains available when it is absent.
let POPPLER_AVAILABLE = true;
try {
  execFileSync('pdftoppm', ['-v'], { stdio: 'ignore', windowsHide: true });
} catch {
  POPPLER_AVAILABLE = false;
  console.warn('pdftoppm was not found; PDF page rendering is disabled.');
}

const app = express();
app.disable('x-powered-by');
app.use(createLocalRequestGuard({ port: PORT, extraOrigins: process.env.THOUGHTDAG_ALLOWED_ORIGINS || '' }));
const ALLOWED_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGIN.test(origin)) return callback(null, true);
    callback(null, false);
  },
}));
app.use(express.json({ limit: '384mb' }));

// PDF text extraction (pdfjs-dist) + optional page rendering (pdftoppm).
app.post('/api/pdf-extract', async (req, res) => {
  let tempDirectory;
  try {
    const { base64, renderImages = true } = req.body ?? {};
    const dpi = Math.min(300, Math.max(72, Math.round(Number(req.body?.dpi)) || 150));
    if (!base64) return res.status(400).json({ error: 'Missing base64 field' });
    const buffer = Buffer.from(base64, 'base64');
    console.log(`PDF extract: ${buffer.length} bytes, header: ${buffer.slice(0, 5).toString()}`);

    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
    const pdfPath = path.join(tempDirectory, 'input.pdf');
    fs.writeFileSync(pdfPath, buffer);

    let text = '';
    let numPages = 0;
    try {
      const document = await getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
      numPages = document.numPages;
      const pageTexts = [];
      for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
        try {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          pageTexts.push(content.items.map((item) => item.str).join(' '));
        } catch {
          pageTexts.push('');
        }
      }
      text = pageTexts.join('\n\n');
      await document.destroy();
    } catch (error) {
      console.warn('pdfjs text extraction failed:', error?.message || 'unknown error');
    }

    const pageImages = [];
    if (renderImages && POPPLER_AVAILABLE) {
      try {
        const outputPrefix = path.join(tempDirectory, 'page');
        execFileSync('pdftoppm', ['-png', '-r', String(dpi), pdfPath, outputPrefix], {
          timeout: 60000,
          windowsHide: true,
        });
        const files = fs.readdirSync(tempDirectory)
          .filter((file) => file.startsWith('page-') && file.endsWith('.png'))
          .sort();
        for (const file of files) {
          pageImages.push(fs.readFileSync(path.join(tempDirectory, file)).toString('base64'));
        }
      } catch (error) {
        console.warn('pdftoppm rendering failed:', error?.message || 'unknown error');
      }
    }

    console.log(`PDF done: ${numPages} pages, ${text.length} chars, ${pageImages.length} images`);
    res.json({
      text,
      numPages,
      images: pageImages.length > 0 ? pageImages : undefined,
      imagesUnavailable: !POPPLER_AVAILABLE || undefined,
    });
  } catch (error) {
    console.error('PDF extract error:', error?.message || 'unknown error');
    res.status(500).json({ error: error?.message || 'PDF extraction failed' });
  } finally {
    if (tempDirectory) {
      try { fs.rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
});

const { fetchWithSafeRedirects } = createSafeRemoteUrlGuard();

// Capture a bounded, inert text snapshot for a link node. Every redirect is
// revalidated so a public URL cannot bounce the proxy into a private network.
app.post('/api/fetch-url', async (req, res) => {
  const { url } = req.body ?? {};
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetchWithSafeRedirects(url, controller.signal);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Page responded HTTP ${response.status}`); }
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/.test(contentType)) {
      await response.body?.cancel();
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    const html = await readBoundedText(response);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
      .replace(/\s+/g, ' ')
      .trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*(\s*\n\s*)+/g, '\n\n')
      .trim();
    res.json({ title, text, html, fetchedAt: new Date().toISOString() });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Fetch failed' });
  } finally {
    clearTimeout(timer);
  }
});

async function modelsPayload() {
  const status = await codexAdapter.status();
  return codexAdapter.modelsPayload(status);
}

app.get('/api/codex/status', async (_req, res) => res.json(await codexAdapter.status()));
app.get('/api/models', async (_req, res) => res.json(await modelsPayload()));

app.get('/api/codex/threads', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    projectRegistry.authenticate(req.get(DESKTOP_CONTROL_HEADER));
    const payload = await codexAdapter.listPersistentThreads({
      cursor: req.query.cursor,
      limit: req.query.limit,
      search: req.query.search,
      archived: req.query.archived,
    });
    res.json(payload);
  } catch (error) {
    sendCodexHistoryError(res, error, 'list');
  }
});

app.get('/api/codex/threads/:threadId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    projectRegistry.authenticate(req.get(DESKTOP_CONTROL_HEADER));
    res.json(await codexAdapter.readPersistentThread(req.params.threadId));
  } catch (error) {
    sendCodexHistoryError(res, error, 'read');
  }
});

// The CLI owns MCP discovery, so server names are not inspected or exposed.
// capabilities.mcp from /api/models tells the UI whether opt-in is available.
app.get('/api/tools', (_req, res) => res.json({ mcpServers: [] }));

function sendProjectRegistryError(res, error) {
  res.status(error?.statusCode || 500).json({
    error: safeCodexError(error),
    code: error?.code || 'PROJECT_REGISTRY_ERROR',
  });
}

app.post('/api/desktop/projects/register', async (req, res) => {
  try {
    projectRegistry.authenticate(req.get(DESKTOP_CONTROL_HEADER));
    const project = await projectRegistry.register(req.body?.path);
    res.status(201).json({ project });
  } catch (error) {
    sendProjectRegistryError(res, error);
  }
});

app.delete('/api/desktop/projects/:id', (req, res) => {
  try {
    projectRegistry.authenticate(req.get(DESKTOP_CONTROL_HEADER));
    projectRegistry.unregister(req.params.id);
    res.status(204).end();
  } catch (error) {
    sendProjectRegistryError(res, error);
  }
});

function rejectLegacyProviderConfiguration(_req, res) {
  res.status(410).json({
    error: 'This is a Codex-only backend and does not accept browser provider credentials.',
    code: 'CODEX_ONLY',
  });
}
app.post('/api/probe-models', rejectLegacyProviderConfiguration);
app.post('/api/runtime-providers', rejectLegacyProviderConfiguration);
app.post('/api/runtime-key', rejectLegacyProviderConfiguration);

const activeRequestControllers = new Set();

function bindRequestAbort(req, res) {
  const controller = new AbortController();
  activeRequestControllers.add(controller);
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', onClose);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    detach() {
      activeRequestControllers.delete(controller);
      req.off('aborted', abort);
      res.off('close', onClose);
    },
  };
}

function safeCodexError(error) {
  return redactSensitive(error?.message || 'Codex request failed', { env: process.env })
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1000);
}

function sendCodexHistoryError(res, error, operation) {
  const rawStatus = Number(error?.statusCode);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : 500;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'CODEX_HISTORY_FAILED';
  const diagnostic = safeCodexError(error);
  console.error(`Codex history ${operation} error:`, code, diagnostic);
  const validation = status === 400;
  res.status(status).json({
    error: validation
      ? diagnostic
      : operation === 'list'
        ? 'Unable to list Codex conversations.'
        : 'Unable to read the requested Codex conversation.',
    code,
  });
}

function codexErrorBody(error) {
  return {
    error: `[${CODEX_LOGICAL_MODEL}] ${safeCodexError(error)}`,
    code: error?.code || 'CODEX_REQUEST_FAILED',
  };
}

const FORBIDDEN_PROJECT_FIELDS = [
  'path',
  'cwd',
  'directory',
  'project',
  'projectPath',
  'projectDirectory',
  'workingDirectory',
];

async function resolveGenerationContext(body = {}) {
  for (const field of FORBIDDEN_PROJECT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw new CodexAdapterError('Generation requests accept projectId, not project directory paths.', {
        code: 'RAW_PROJECT_PATH_NOT_ALLOWED',
        statusCode: 400,
      });
    }
  }
  const projectDirectory = await projectRegistry.resolve(body.projectId);
  const selection = await codexAdapter.resolveModelSelection({
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    modelSpeed: body.modelSpeed,
  });
  return {
    model: selection.modelId,
    reasoningEffort: selection.reasoningEffort,
    modelSpeed: selection.modelSpeed,
    permissionMode: normalizePermissionMode(body.permissionMode),
    projectDirectory,
  };
}

app.post('/api/codex', async (req, res) => {
  const { messages, images, webSearch, scholarSearch, mcpTools } = req.body ?? {};
  const requestAbort = bindRequestAbort(req, res);
  try {
    const generationContext = await resolveGenerationContext(req.body ?? {});
    const result = await codexAdapter.run({
      messages,
      images,
      ...generationContext,
      webSearch: webSearch === true,
      scholarSearch: scholarSearch === true,
      mcpTools,
      signal: requestAbort.signal,
    });
    if (!res.destroyed && !res.writableEnded) res.json(result);
  } catch (error) {
    if (!isAbortError(error) && !res.destroyed && !res.writableEnded) {
      const message = safeCodexError(error);
      console.error('Codex generation error:', error?.code || 'CODEX_REQUEST_FAILED', message);
      res.status(error?.statusCode || 500).json(codexErrorBody(error));
    }
  } finally {
    requestAbort.detach();
  }
});

const interactions = new Map();
app.post('/api/interactions/:id', (req, res) => {
  const pending = interactions.get(req.params.id);
  if (!pending || req.get('X-ThoughtDAG-Interaction') !== pending.token) {
    return res.status(404).json({ error: 'Interaction is no longer active.' });
  }
  interactions.delete(req.params.id);
  pending.resolve(req.body?.result);
  res.json({ ok: true });
});

app.post('/api/stream', async (req, res) => {
  const { messages, images, webSearch, scholarSearch, mcpTools, codexLink } = req.body ?? {};
  const requestAbort = bindRequestAbort(req, res);
  let generationContext;
  try {
    generationContext = await resolveGenerationContext(req.body ?? {});
  } catch (error) {
    if (!isAbortError(error) && !res.destroyed && !res.writableEnded) {
      const message = safeCodexError(error);
      console.error('Codex stream validation error:', error?.code || 'CODEX_REQUEST_FAILED', message);
      res.status(error?.statusCode || 500).json(codexErrorBody(error));
    }
    requestAbort.detach();
    return;
  }
  let finished = false;
  const interactionIds = new Set();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const writeFrame = (payload) => {
    if (finished || res.destroyed || res.writableEnded) return false;
    return res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (!res.destroyed && !res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };

  try {
    const result = await codexAdapter.runStream({
      messages,
      images,
      ...generationContext,
      webSearch: webSearch === true,
      scholarSearch: scholarSearch === true,
      mcpTools,
      codexLink,
      signal: requestAbort.signal,
      onInteraction(message) {
        const supported = ['item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
        if (!supported.includes(message.method)) return Promise.reject(new Error('Unsupported interaction: ' + message.method));
        const id = randomUUID();
        const token = randomUUID();
        return new Promise((resolve, reject) => {
          const abort = () => { interactions.delete(id); interactionIds.delete(id); reject(new Error('Generation stopped.')); };
          interactions.set(id, { token, resolve(result) { requestAbort.signal.removeEventListener('abort', abort); interactionIds.delete(id); resolve(result); } });
          interactionIds.add(id);
          requestAbort.signal.addEventListener('abort', abort, { once: true });
          writeFrame({ interaction: { id, token, method: message.method, params: message.params } });
        });
      },
      onEvent(event) {
        if (event.type === 'snapshot') writeFrame({ snapshot: event.snapshot });
        else if (event.type === 'metadata') writeFrame({ metadata: event.metadata });
        else if (event.type === 'text') writeFrame({ text: event.text });
        else if (event.type === 'reasoning') writeFrame({ reasoning: event.text });
        else if (event.type === 'tool') writeFrame({ tool: event.tool });
      },
    });
    writeFrame({ snapshot: { text: result.text, reasoning: result.reasoning || '', commentary: result.commentary || '' } });
    if (result.usage) writeFrame({ usage: result.usage });
    writeFrame({
      status: result.status || 'completed',
      contextCompacted: result.contextCompacted === true,
      model: result.model,
      reasoningEffort: result.reasoningEffort || null,
      modelSpeed: result.modelSpeed,
      serviceTier: result.serviceTier,
      threadId: result.threadId,
      turnId: result.turnId,
      threadMode: result.threadMode,
    });
    finish();
  } catch (error) {
    if (!isAbortError(error) && !res.destroyed && !res.writableEnded) {
      const message = safeCodexError(error);
      console.error('Codex stream error:', error?.code || 'CODEX_REQUEST_FAILED', message);
      writeFrame(codexErrorBody(error));
      finish();
    }
  } finally {
    for (const id of interactionIds) interactions.delete(id);
    requestAbort.detach();
  }
});

if (process.env.SERVE_DIST) {
  const distDirectory = process.env.SERVE_DIST;
  app.use(express.static(distDirectory));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile('index.html', { root: distDirectory });
  });
}

const httpServer = app.listen(PORT, HOST, (error) => {
  if (error) {
    console.error(`ThoughtDAG Codex proxy failed to listen on ${HOST}:${PORT}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ThoughtDAG Codex proxy running on http://localhost:${PORT}`);
  void codexAdapter.status().then((status) => {
    console.log(`Codex status: ${status.status}; model: ${status.model}`);
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const controller of activeRequestControllers) controller.abort();
    codexAdapter.close?.();
    httpServer.close(() => process.exit(0));
    const timer = setTimeout(() => process.exit(0), 2000);
    timer.unref?.();
  });
}
