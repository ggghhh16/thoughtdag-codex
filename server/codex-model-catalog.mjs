import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { windowsCodexLaunch } from './codex-windows-launch.mjs';

const moduleRequire = createRequire(import.meta.url);

export const CODEX_FALLBACK_MODEL_ID = 'codex';
export const DEFAULT_MODEL_SPEED = 'standard';

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 20;

export class CodexModelCatalogError extends Error {
  constructor(message, { code = 'CODEX_MODEL_CATALOG_ERROR', statusCode = 503, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CodexModelCatalogError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class CodexModelSelectionError extends Error {
  constructor(message, { code = 'INVALID_CODEX_MODEL' } = {}) {
    super(message);
    this.name = 'CodexModelSelectionError';
    this.code = code;
    this.statusCode = 400;
  }
}

function resolveBundledCliPath(cliPath) {
  if (cliPath) return cliPath;
  try {
    return moduleRequire.resolve('@openai/codex/bin/codex.js');
  } catch (error) {
    throw new CodexModelCatalogError('The bundled Codex model catalog is unavailable.', {
      code: 'CODEX_UNAVAILABLE',
      cause: error,
    });
  }
}

/**
 * Query the version-matched Codex App Server over its documented JSONL stdio
 * transport. The short-lived process is used only for model/list discovery.
 */
export function queryCodexModels({
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  nodePath = process.execPath,
  cliPath,
  spawnImpl = spawn,
} = {}) {
  const resolvedCliPath = resolveBundledCliPath(cliPath);
  const windowsLaunch = cliPath ? null : windowsCodexLaunch({ env });

  return new Promise((resolve, reject) => {
    let child;
    let lines;
    let timer;
    let settled = false;
    let initialized = false;
    let requestId = 1;
    let activeRequestId;
    let pageCount = 0;
    let outputBytes = 0;
    const entries = [];
    const childEnv = { ...env };
    if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';

    const stopChild = () => {
      try { child?.stdin?.end(); } catch { /* already closed */ }
      try { child?.kill(); } catch { /* already stopped */ }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines?.close();
      stopChild();
      callback(value);
    };
    const fail = (message, code = 'CODEX_MODEL_CATALOG_ERROR', cause) => {
      finish(reject, new CodexModelCatalogError(message, { code, cause }));
    };
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        fail('The Codex model catalog connection closed unexpectedly.', 'CODEX_UNAVAILABLE', error);
      }
    };
    const requestPage = (cursor) => {
      pageCount += 1;
      if (pageCount > MAX_PAGES) {
        fail('The Codex model catalog returned too many pages.');
        return;
      }
      activeRequestId = requestId;
      requestId += 1;
      send({
        method: 'model/list',
        id: activeRequestId,
        params: {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        },
      });
    };

    try {
      child = spawnImpl(
        windowsLaunch?.executablePath || nodePath,
        windowsLaunch ? ['app-server'] : [resolvedCliPath, 'app-server'],
        {
        env: windowsLaunch?.env || childEnv,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      fail('The bundled Codex model catalog could not start.', 'CODEX_UNAVAILABLE', error);
      return;
    }

    child.stderr?.resume();
    lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (settled || !line.trim()) return;
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fail('The Codex model catalog response was too large.');
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail('The Codex model catalog returned invalid JSON.', 'CODEX_MODEL_CATALOG_PROTOCOL', error);
        return;
      }

      if (message.id === 0 && !initialized) {
        if (message.error) {
          fail('The Codex model catalog initialization failed.', 'CODEX_MODEL_CATALOG_PROTOCOL');
          return;
        }
        initialized = true;
        send({ method: 'initialized', params: {} });
        requestPage();
        return;
      }

      if (message.id !== activeRequestId) return;
      if (message.error) {
        fail('Codex could not list the models available to this login.', 'CODEX_MODEL_CATALOG_REQUEST');
        return;
      }
      const page = message.result;
      if (!page || !Array.isArray(page.data)) {
        fail('The Codex model catalog returned an invalid response.', 'CODEX_MODEL_CATALOG_PROTOCOL');
        return;
      }
      entries.push(...page.data);
      if (typeof page.nextCursor === 'string' && page.nextCursor) requestPage(page.nextCursor);
      else finish(resolve, entries);
    });

    child.once('error', (error) => {
      fail('The bundled Codex model catalog failed.', 'CODEX_UNAVAILABLE', error);
    });
    child.once('exit', (code, signal) => {
      if (!settled) {
        fail(
          'The bundled Codex model catalog stopped before responding.',
          signal ? 'CODEX_MODEL_CATALOG_INTERRUPTED' : `CODEX_MODEL_CATALOG_EXIT_${code ?? 'UNKNOWN'}`,
        );
      }
    });

    timer = setTimeout(() => {
      fail('The Codex model catalog request timed out.', 'CODEX_MODEL_CATALOG_TIMEOUT');
    }, Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timer.unref?.();

    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'thoughtdag_codex',
          title: 'ThoughtDAG Codex',
          version: '0.2.6',
        },
      },
    });
  });
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeEfforts(rawEfforts, rawDefault) {
  const seen = new Set();
  const efforts = [];
  for (const raw of Array.isArray(rawEfforts) ? rawEfforts : []) {
    const reasoningEffort = cleanString(typeof raw === 'string' ? raw : raw?.reasoningEffort);
    if (!reasoningEffort || seen.has(reasoningEffort)) continue;
    seen.add(reasoningEffort);
    efforts.push({
      reasoningEffort,
      description: cleanString(typeof raw === 'object' ? raw?.description : undefined) || '',
    });
  }
  const defaultReasoningEffort = cleanString(rawDefault) || null;
  if (defaultReasoningEffort && !seen.has(defaultReasoningEffort)) {
    efforts.unshift({ reasoningEffort: defaultReasoningEffort, description: '' });
  }
  return { efforts, defaultReasoningEffort };
}

function normalizeServiceTiers(rawTiers) {
  const seen = new Set();
  const tiers = [];
  for (const raw of Array.isArray(rawTiers) ? rawTiers : []) {
    const id = cleanString(typeof raw === 'string' ? raw : raw?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tiers.push({
      id,
      name: cleanString(typeof raw === 'object' ? raw?.name : undefined) || id,
      description: cleanString(typeof raw === 'object' ? raw?.description : undefined) || '',
    });
  }
  return tiers;
}

export function normalizeCodexModels(entries) {
  const models = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.hidden === true) continue;
    const id = cleanString(entry?.id) || cleanString(entry?.model);
    const runtimeModel = cleanString(entry?.model) || id;
    if (!id || !runtimeModel || seen.has(id)) continue;
    seen.add(id);
    const { efforts, defaultReasoningEffort } = normalizeEfforts(
      entry?.supportedReasoningEfforts,
      entry?.defaultReasoningEffort,
    );
    const inputModalities = Array.isArray(entry?.inputModalities)
      ? [...new Set(entry.inputModalities.map(cleanString).filter(Boolean))]
      : ['text', 'image'];
    const additionalSpeedTiers = Array.isArray(entry?.additionalSpeedTiers)
      ? [...new Set(entry.additionalSpeedTiers.map(cleanString).filter(Boolean))]
      : [];
    const serviceTiers = normalizeServiceTiers(entry?.serviceTiers);
    const fastServiceTier = serviceTiers.find((tier) => tier.id === 'priority')
      || serviceTiers.find((tier) => tier.id === 'fast');
    models.push({
      id,
      runtimeModel,
      name: cleanString(entry?.displayName) || id,
      description: cleanString(entry?.description) || '',
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'].find(value => efforts.some(e => e.reasoningEffort === value)) || defaultReasoningEffort,
      inputModalities,
      vision: inputModalities.includes('image'),
      additionalSpeedTiers,
      serviceTiers,
      defaultServiceTier: cleanString(entry?.defaultServiceTier) || null,
      supportsFastMode: Boolean(fastServiceTier || additionalSpeedTiers.includes('fast')),
      fastServiceTierId: fastServiceTier?.id || (additionalSpeedTiers.includes('fast') ? 'fast' : null),
      isDefault: entry?.isDefault === true,
    });
  }
  return models;
}

function createFallbackCatalog() {
  return {
    source: 'fallback',
    defaultModelId: CODEX_FALLBACK_MODEL_ID,
    warning: 'The live Codex model catalog is unavailable. Using the Codex default configuration.',
    models: [{
      id: CODEX_FALLBACK_MODEL_ID,
      runtimeModel: null,
      name: 'Codex default configuration',
      description: 'Uses the model and reasoning effort selected by the local Codex configuration.',
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text', 'image'],
      vision: true,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      supportsFastMode: false,
      fastServiceTierId: null,
      isDefault: true,
    }],
  };
}

export function createCodexModelCatalog({
  env = process.env,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  queryModels = queryCodexModels,
  logger = console,
} = {}) {
  let cached;
  let inFlight;

  const load = async () => {
    try {
      const models = normalizeCodexModels(await queryModels({ env }));
      if (models.length === 0) throw new CodexModelCatalogError('No picker-visible Codex models were returned.');
      const defaultModel = models.find((model) => model.isDefault) || models[0];
      return {
        source: 'app-server',
        defaultModelId: defaultModel.id,
        warning: null,
        models,
      };
    } catch {
      logger.warn?.('Codex model catalog unavailable; using the Codex default configuration.');
      return createFallbackCatalog();
    }
  };

  const getCatalog = async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && cached?.expiresAt > now) return cached.catalog;
    if (!inFlight) {
      inFlight = load()
        .then((catalog) => {
          const requestedTtl = Math.max(1_000, Number(cacheTtlMs) || DEFAULT_CACHE_TTL_MS);
          const ttl = catalog.source === 'fallback' ? Math.min(requestedTtl, 5_000) : requestedTtl;
          cached = { catalog, expiresAt: Date.now() + ttl };
          return catalog;
        })
        .finally(() => { inFlight = undefined; });
    }
    return inFlight;
  };

  return { getCatalog };
}

export function publicModel(model) {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    provider: 'codex',
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    inputModalities: model.inputModalities,
    vision: model.vision,
    serviceTiers: model.serviceTiers,
    defaultServiceTier: model.defaultServiceTier,
    supportsFastMode: model.supportsFastMode,
    isDefault: model.isDefault,
  };
}

function optionalRequestString(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new CodexModelSelectionError(`${field} must be a non-empty string.`, {
      code: field === 'model'
        ? 'INVALID_CODEX_MODEL'
        : field === 'modelSpeed'
          ? 'INVALID_MODEL_SPEED'
          : 'INVALID_REASONING_EFFORT',
    });
  }
  return value.trim();
}

export function validateModelSelection(catalog, { model, reasoningEffort, modelSpeed } = {}) {
  const requestedModel = optionalRequestString(model, 'model') || catalog.defaultModelId;
  const selected = catalog.models.find((candidate) => candidate.id === requestedModel);
  if (!selected) {
    throw new CodexModelSelectionError(`Model "${requestedModel}" is not available in the current Codex catalog.`);
  }

  const requestedEffort = optionalRequestString(reasoningEffort, 'reasoningEffort');
  const selectedEffort = requestedEffort || selected.defaultReasoningEffort || undefined;
  if (selectedEffort) {
    const allowed = selected.supportedReasoningEfforts
      .map((effort) => effort.reasoningEffort);
    if (!allowed.includes(selectedEffort)) {
      throw new CodexModelSelectionError(
        `Reasoning effort "${selectedEffort}" is not supported by model "${selected.id}".`,
        { code: 'INVALID_REASONING_EFFORT' },
      );
    }
  }

  const requestedSpeed = optionalRequestString(modelSpeed, 'modelSpeed') || DEFAULT_MODEL_SPEED;
  if (requestedSpeed !== 'standard' && requestedSpeed !== 'fast') {
    throw new CodexModelSelectionError('modelSpeed must be standard or fast.', {
      code: 'INVALID_MODEL_SPEED',
    });
  }
  // A canvas node can pin a model independently of the toolbar. If that
  // pinned model has no priority tier, run it at standard speed instead of
  // turning an otherwise-valid generation into a model capability error.
  const effectiveSpeed = requestedSpeed === 'fast' && selected.supportsFastMode
    ? 'fast'
    : 'standard';

  return {
    modelId: selected.id,
    runtimeModel: selected.runtimeModel || undefined,
    reasoningEffort: selectedEffort,
    modelSpeed: effectiveSpeed,
    requestedModelSpeed: requestedSpeed,
    serviceTier: effectiveSpeed === 'fast'
      ? selected.fastServiceTierId || 'priority'
      : 'default',
    catalogSource: catalog.source,
  };
}
