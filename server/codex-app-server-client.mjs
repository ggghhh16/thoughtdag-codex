import { TurnContent } from './turn-content.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { windowsCodexLaunch } from './codex-windows-launch.mjs';

const moduleRequire = createRequire(import.meta.url);

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 32 * 1024;
const TRANSIENT_CODEX_ENV_KEYS = new Set([
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_CI',
  'THOUGHTDAG_DESKTOP_CONTROL_TOKEN',
]);

const AGENT_MESSAGE_DELTA = 'item/agentMessage/delta';
const REASONING_SUMMARY_DELTA = 'item/reasoning/summaryTextDelta';
const REASONING_TEXT_DELTA = 'item/reasoning/textDelta';
const TURN_COMPLETED = 'turn/completed';

export class CodexAppServerError extends Error {
  constructor(message, { code = 'CODEX_APP_SERVER_ERROR', cause } = {}) {
    super(message, { cause });
    this.name = 'CodexAppServerError';
    this.code = code;
  }
}

export class CodexAppServerRpcError extends CodexAppServerError {
  constructor(method, error = {}) {
    const rpcCode = error && typeof error === 'object' ? error.code : undefined;
    const rpcMessage = error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : 'Unknown JSON-RPC error';
    super(`Codex App Server request ${method} failed${rpcCode === undefined ? '' : ` (${rpcCode})`}: ${rpcMessage}`, {
      code: 'CODEX_APP_SERVER_RPC_ERROR',
    });
    this.method = method;
    this.rpcCode = rpcCode;
    this.rpcData = error && typeof error === 'object' ? error.data : undefined;
  }
}

export class CodexAppServerAbortError extends CodexAppServerError {
  constructor(message = 'The Codex turn was aborted.') {
    super(message, { code: 'CODEX_APP_SERVER_ABORTED' });
    this.name = 'AbortError';
  }
}

/** Keep a nested ThoughtDAG run from accidentally inheriting its parent Codex session. */
export function sanitizeCodexAppServerEnv(sourceEnv = process.env) {
  const childEnv = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value === undefined || TRANSIENT_CODEX_ENV_KEYS.has(key.toUpperCase())) continue;
    childEnv[key] = String(value);
  }
  return childEnv;
}

function boundedInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : fallback;
}

function normalizeClientInfo(clientInfo = {}) {
  return {
    name: typeof clientInfo.name === 'string' && clientInfo.name.trim()
      ? clientInfo.name.trim()
      : 'thoughtdag_codex',
    title: typeof clientInfo.title === 'string' && clientInfo.title.trim()
      ? clientInfo.title.trim()
      : 'ThoughtDAG Codex',
    version: typeof clientInfo.version === 'string' && clientInfo.version.trim()
      ? clientInfo.version.trim()
      : '0.0.0',
  };
}

function normalizeCapabilities(capabilities = {}) {
  return {
    experimentalApi: capabilities.experimentalApi === true,
    requestAttestation: capabilities.requestAttestation === true,
    ...(capabilities.mcpServerOpenaiFormElicitation === undefined ? {} : {
      mcpServerOpenaiFormElicitation: capabilities.mcpServerOpenaiFormElicitation === true,
    }),
    ...(Array.isArray(capabilities.optOutNotificationMethods) ? {
      optOutNotificationMethods: capabilities.optOutNotificationMethods.filter(
        (method) => typeof method === 'string' && method,
      ),
    } : {}),
    ...(capabilities.extensions && typeof capabilities.extensions === 'object' ? {
      extensions: capabilities.extensions,
    } : {}),
  };
}

export function resolveCodexAppServerLaunch({ env, configOverrides = [], extraArgs = [] } = {}) {
  const childEnv = sanitizeCodexAppServerEnv(env);
  const appServerArgs = ['app-server', '--stdio'];
  for (const override of configOverrides) {
    if (typeof override !== 'string' || !override.trim()) continue;
    appServerArgs.push('-c', override);
  }
  for (const argument of extraArgs) {
    if (typeof argument === 'string' && argument) appServerArgs.push(argument);
  }

  const windowsLaunch = windowsCodexLaunch({ env: childEnv });
  if (windowsLaunch) {
    return {
      command: windowsLaunch.executablePath,
      args: appServerArgs,
      env: windowsLaunch.env,
    };
  }

  const cliPath = moduleRequire.resolve('@openai/codex/bin/codex.js');
  if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';
  return {
    command: process.execPath,
    args: [cliPath, ...appServerArgs],
    env: childEnv,
  };
}

function rpcErrorPayload(code, message, data) {
  return {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  };
}

function turnIdFromCompleted(params) {
  return params?.turn && typeof params.turn.id === 'string' ? params.turn.id : undefined;
}

function notificationTurnId(message) {
  if (message?.params && typeof message.params.turnId === 'string') return message.params.turnId;
  if (message?.method === TURN_COMPLETED) return turnIdFromCompleted(message.params);
  return undefined;
}

function notificationThreadId(message) {
  return message?.params && typeof message.params.threadId === 'string'
    ? message.params.threadId
    : undefined;
}

/**
 * One long-lived JSONL/JSON-RPC connection to `codex app-server --stdio`.
 *
 * The class is intentionally transport-focused: callers own thread settings and
 * context construction, while this layer owns lifecycle, framing, request IDs,
 * fail-closed server requests, and turn event collection.
 */
export class CodexAppServerClient extends EventEmitter {
  constructor({
    env = process.env,
    configOverrides = [],
    extraArgs = [],
    launch,
    launchResolver = resolveCodexAppServerLaunch,
    spawnImpl = spawn,
    clientInfo,
    capabilities,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    logger = console,
  } = {}) {
    super();
    this.env = env;
    this.configOverrides = [...configOverrides];
    this.extraArgs = [...extraArgs];
    this.launch = launch;
    this.launchResolver = launchResolver;
    this.spawnImpl = spawnImpl;
    this.clientInfo = normalizeClientInfo(clientInfo);
    this.capabilities = normalizeCapabilities(capabilities);
    this.requestTimeoutMs = boundedInteger(
      requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      100,
    );
    this.maxLineBytes = boundedInteger(maxLineBytes, DEFAULT_MAX_LINE_BYTES, 1024);
    this.logger = logger;

    this.child = undefined;
    this.connectPromise = undefined;
    this.connected = false;
    this.closed = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.turnRequestHandlers = new Map();
    this.stdoutBuffer = '';
    this.stdoutBufferBytes = 0;
    this.stderrTail = '';
    this.generation = 0;
    this.initializeResult = undefined;
  }

  get isConnected() {
    return this.connected && Boolean(this.child);
  }

  async connect() {
    if (this.closed) {
      throw new CodexAppServerError('Codex App Server client is closed.', {
        code: 'CODEX_APP_SERVER_CLOSED',
      });
    }
    if (this.isConnected) return this.initializeResult;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.#connectOnce();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async #connectOnce() {
    const launch = this.launch || this.launchResolver({
      env: this.env,
      configOverrides: this.configOverrides,
      extraArgs: this.extraArgs,
    });
    if (!launch || typeof launch.command !== 'string' || !Array.isArray(launch.args)) {
      throw new CodexAppServerError('Codex App Server launch configuration is invalid.', {
        code: 'CODEX_APP_SERVER_UNAVAILABLE',
      });
    }

    const generation = ++this.generation;
    this.stdoutBuffer = '';
    this.stdoutBufferBytes = 0;
    this.stderrTail = '';
    let child;
    try {
      child = this.spawnImpl(launch.command, launch.args, {
        env: launch.env || sanitizeCodexAppServerEnv(this.env),
        cwd: launch.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      throw new CodexAppServerError('Codex App Server could not start.', {
        code: 'CODEX_APP_SERVER_UNAVAILABLE', cause,
      });
    }

    this.child = child;
    this.#attachChild(child, generation);

    try {
      const initializeResult = await this.#requestConnected('initialize', {
        clientInfo: this.clientInfo,
        capabilities: this.capabilities,
      });
      if (this.child !== child || generation !== this.generation) {
        throw new CodexAppServerError('Codex App Server stopped during initialization.', {
          code: 'CODEX_APP_SERVER_CLOSED',
        });
      }
      await this.#writeMessage({ method: 'initialized' }, child);
      this.connected = true;
      this.initializeResult = initializeResult;
      this.emit('connected', initializeResult);
      return initializeResult;
    } catch (error) {
      this.#terminateGeneration(child, generation, error);
      throw error;
    }
  }

  #attachChild(child, generation) {
    // setEncoding uses Node's StringDecoder, so a multibyte UTF-8 character
    // split across OS pipe chunks is not replaced with U+FFFD.
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this.#consumeStdout(chunk, child, generation));
    child.stderr?.on('data', (chunk) => {
      if (child !== this.child || generation !== this.generation) return;
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_BYTES);
      this.emit('stderr', String(chunk));
    });
    child.stdin?.once('error', (cause) => {
      this.#terminateGeneration(child, generation, new CodexAppServerError(
        'Codex App Server input stream failed.',
        { code: 'CODEX_APP_SERVER_CLOSED', cause },
      ));
    });
    child.stdout?.once('error', (cause) => {
      this.#terminateGeneration(child, generation, new CodexAppServerError(
        'Codex App Server output stream failed.',
        { code: 'CODEX_APP_SERVER_CLOSED', cause },
      ));
    });
    child.once('error', (cause) => {
      this.#terminateGeneration(child, generation, new CodexAppServerError(
        'Codex App Server process failed.',
        { code: 'CODEX_APP_SERVER_UNAVAILABLE', cause },
      ));
    });
    child.once('exit', (code, signal) => {
      const details = this.stderrTail.trim();
      const suffix = details ? `\n${details}` : '';
      this.#terminateGeneration(child, generation, new CodexAppServerError(
        `Codex App Server exited (${signal ?? code ?? 'unknown'}).${suffix}`,
        { code: 'CODEX_APP_SERVER_CLOSED' },
      ));
    });
  }

  #consumeStdout(chunk, child, generation) {
    if (child !== this.child || generation !== this.generation) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    this.stdoutBuffer += text;
    this.stdoutBufferBytes += Buffer.byteLength(text);
    if (this.stdoutBufferBytes > this.maxLineBytes && !this.stdoutBuffer.includes('\n')) {
      this.#terminateGeneration(child, generation, new CodexAppServerError(
        'Codex App Server emitted an oversized JSONL frame.',
        { code: 'CODEX_APP_SERVER_PROTOCOL_ERROR' },
      ));
      return;
    }

    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.stdoutBufferBytes = Buffer.byteLength(this.stdoutBuffer);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.#terminateGeneration(child, generation, new CodexAppServerError(
          'Codex App Server emitted an oversized JSONL frame.',
          { code: 'CODEX_APP_SERVER_PROTOCOL_ERROR' },
        ));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        this.#terminateGeneration(child, generation, new CodexAppServerError(
          'Codex App Server emitted invalid JSONL.',
          { code: 'CODEX_APP_SERVER_PROTOCOL_ERROR', cause },
        ));
        return;
      }
      this.#handleMessage(message, child);
    }
  }

  #handleMessage(message, child) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const hasId = Object.hasOwn(message, 'id');
    if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      && !Object.hasOwn(message, 'method')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.hasOwn(message, 'error')) {
        pending.reject(new CodexAppServerRpcError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    if (hasId) {
      const handler = this.turnRequestHandlers.get(message.params?.threadId);
      if (handler) {
        Promise.resolve().then(() => handler(message)).then(
          result => this.#writeMessage({ id: message.id, result }, child),
          () => this.#rejectServerRequest(message, child),
        ).catch(error => this.logger?.warn?.(error));
      } else this.#rejectServerRequest(message, child);
      return;
    }
    this.emit('notification', message);
    this.emit(`notification:${message.method}`, message.params, message);
  }

  #rejectServerRequest(message, child) {
    const reason = 'ThoughtDAG does not grant interactive approval or credentials through this transport.';
    let result;
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        result = { decision: 'decline' };
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        result = { decision: { denied: { rejection: reason } } };
        break;
      case 'mcpServer/elicitation/request':
        result = { action: 'decline', content: null, _meta: null };
        break;
      case 'item/tool/requestUserInput':
        result = { answers: {} };
        break;
      default:
        this.#writeMessage({
          id: message.id,
          error: rpcErrorPayload(-32601, reason, { method: message.method }),
        }, child).catch(() => {});
        this.emit('serverRequestRejected', message);
        return;
    }
    this.#writeMessage({ id: message.id, result }, child).catch(() => {});
    this.emit('serverRequestRejected', message);
  }

  #terminateGeneration(child, generation, error) {
    if (child !== this.child || generation !== this.generation) return;
    this.child = undefined;
    this.connected = false;
    this.initializeResult = undefined;
    this.stdoutBuffer = '';
    this.stdoutBufferBytes = 0;
    try { child.stdin?.destroy(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already stopped */ }
    this.#rejectAll(error);
    this.emit('disconnected', error);
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async #writeMessage(message, child = this.child) {
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new CodexAppServerError('Codex App Server input is not writable.', {
        code: 'CODEX_APP_SERVER_CLOSED',
      });
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise((resolve, reject) => {
      child.stdin.write(line, (cause) => {
        if (cause) reject(new CodexAppServerError('Writing to Codex App Server failed.', {
          code: 'CODEX_APP_SERVER_CLOSED', cause,
        }));
        else resolve();
      });
    });
  }

  #requestConnected(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CodexAppServerError(`Codex App Server request ${method} timed out.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
        }));
      }, boundedInteger(timeoutMs, this.requestTimeoutMs, 100));
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.#writeMessage({ method, id, params }, this.child).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async request(method, params, options) {
    if (typeof method !== 'string' || !method) {
      throw new TypeError('Codex App Server request method must be a non-empty string.');
    }
    await this.connect();
    return this.#requestConnected(method, params, options);
  }

  async notify(method, params) {
    if (typeof method !== 'string' || !method) {
      throw new TypeError('Codex App Server notification method must be a non-empty string.');
    }
    await this.connect();
    await this.#writeMessage({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(listener) {
    this.on('notification', listener);
    return () => this.off('notification', listener);
  }

  startThread(params = {}) {
    return this.request('thread/start', params);
  }

  resumeThread(params) {
    return this.request('thread/resume', params);
  }

  forkThread(params) {
    return this.request('thread/fork', params);
  }

  listThreads(params = {}) {
    return this.request('thread/list', params);
  }

  readThread(params) {
    return this.request('thread/read', params);
  }

  listThreadTurns(params) {
    return this.request('thread/turns/list', params);
  }

  listThreadItems(params) {
    return this.request('thread/items/list', params);
  }

  injectItems(params) {
    return this.request('thread/inject_items', params);
  }

  interruptTurn(params) {
    return this.request('turn/interrupt', params);
  }

  /**
   * Start one turn, relay its streamed notifications, and resolve only when
   * `turn/completed` arrives. Text fields contain the raw concatenated deltas;
   * consumers can inspect item IDs/phases through `onNotification` when needed.
   */
  async startTurn(params, {
    signal,
    timeoutMs,
    onAgentMessageDelta,
    onReasoningDelta,
    onNotification,
    onSnapshot,
    onServerRequest,
  } = {}) {
    if (!params || typeof params.threadId !== 'string' || !params.threadId) {
      throw new TypeError('turn/start requires a non-empty threadId.');
    }
    if (signal?.aborted) throw new CodexAppServerAbortError();

    const content = new TurnContent();
    let snapshotTimer;
    const publishSnapshot = () => {
      clearTimeout(snapshotTimer); snapshotTimer = undefined;
      try { onSnapshot?.(content.snapshot()); } catch (error) { this.logger?.warn?.(error); }
    };
    const buffered = [];
    let turnId;
    let started;
    let completed;
    let resolveCompletion;
    let rejectCompletion;
    let completionTimer;
    let text = '';
    let reasoning = '';
    let reasoningSummary = '';
    let aborted = false;

    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // `abort` can win while the turn/start request is still in flight. Keep
    // the internal completion rejection observed until this method unwinds.
    completion.catch(() => {});

    const dispatch = (message) => {
      if (notificationThreadId(message) !== params.threadId) return;
      const eventTurnId = notificationTurnId(message);
      if (!turnId) {
        buffered.push(message);
        return;
      }
      if (eventTurnId && eventTurnId !== turnId) return;
      try { onNotification?.(message); } catch (error) { this.logger?.warn?.(error); }
      content.apply(message.method, message.params);
      if (message.method === 'turn/completed' || message.method === 'item/completed') publishSnapshot();
      else if (!snapshotTimer && onSnapshot) snapshotTimer = setTimeout(publishSnapshot, 100);
      const delta = typeof message.params?.delta === 'string' ? message.params.delta : '';
      if (message.method === AGENT_MESSAGE_DELTA) {
        text += delta;
        try { onAgentMessageDelta?.(delta, message.params); } catch (error) { this.logger?.warn?.(error); }
      } else if (message.method === REASONING_SUMMARY_DELTA) {
        reasoningSummary += delta;
        try {
          onReasoningDelta?.(delta, { kind: 'summary', ...message.params });
        } catch (error) { this.logger?.warn?.(error); }
      } else if (message.method === REASONING_TEXT_DELTA) {
        reasoning += delta;
        try {
          onReasoningDelta?.(delta, { kind: 'content', ...message.params });
        } catch (error) { this.logger?.warn?.(error); }
      } else if (message.method === TURN_COMPLETED) {
        completed = message.params;
        resolveCompletion(message.params);
      }
    };

    if (onServerRequest) this.turnRequestHandlers.set(params.threadId, onServerRequest);
    const unsubscribe = this.onNotification(dispatch);
    const onDisconnected = (error) => rejectCompletion(error);
    this.once('disconnected', onDisconnected);

    let abortHandler;
    const abortPromise = signal ? new Promise((resolve, reject) => {
      abortHandler = () => {
        aborted = true;
        const error = new CodexAppServerAbortError();
        rejectCompletion(error);
        reject(error);
        if (turnId) {
          this.interruptTurn({ threadId: params.threadId, turnId }).catch(() => {});
        }
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }) : undefined;

    try {
      const startRequest = this.request('turn/start', params, { timeoutMs });
      startRequest.then((result) => {
        const pendingTurnId = result?.turn?.id;
        if (aborted && typeof pendingTurnId === 'string' && pendingTurnId) {
          this.interruptTurn({ threadId: params.threadId, turnId: pendingTurnId }).catch(() => {});
        }
      }).catch(() => {});
      started = abortPromise
        ? await Promise.race([startRequest, abortPromise])
        : await startRequest;
      turnId = started?.turn?.id;
      if (typeof turnId !== 'string' || !turnId) {
        throw new CodexAppServerError('turn/start did not return a turn id.', {
          code: 'CODEX_APP_SERVER_PROTOCOL_ERROR',
        });
      }

      for (const message of buffered.splice(0)) dispatch(message);
      if (aborted) {
        this.interruptTurn({ threadId: params.threadId, turnId }).catch(() => {});
        throw new CodexAppServerAbortError();
      }

      if (timeoutMs !== undefined) {
        completionTimer = setTimeout(() => {
          this.interruptTurn({ threadId: params.threadId, turnId }).catch(() => {});
          rejectCompletion(new CodexAppServerError('Codex App Server turn timed out.', {
            code: 'CODEX_APP_SERVER_TIMEOUT',
          }));
        }, boundedInteger(timeoutMs, this.requestTimeoutMs, 100));
        completionTimer.unref?.();
      }

      completed ||= abortPromise
        ? await Promise.race([completion, abortPromise])
        : await completion;
      return {
        threadId: params.threadId,
        turnId,
        turn: completed.turn,
        start: started,
        text,
        reasoning,
        reasoningSummary,
        ...content.snapshot(),
      };
    } finally {
      clearTimeout(completionTimer);
      clearTimeout(snapshotTimer);
      unsubscribe();
      if (onServerRequest) this.turnRequestHandlers.delete(params.threadId);
      this.off('disconnected', onDisconnected);
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    const generation = this.generation;
    const error = new CodexAppServerError('Codex App Server client was closed.', {
      code: 'CODEX_APP_SERVER_CLOSED',
    });
    if (child) this.#terminateGeneration(child, generation, error);
    else this.#rejectAll(error);
    this.removeAllListeners();
  }
}

export function createCodexAppServerClient(options) {
  return new CodexAppServerClient(options);
}
