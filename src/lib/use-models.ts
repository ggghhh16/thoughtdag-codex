import { useEffect, useState } from 'react';
import { API_BASE } from './constants';

export type CodexConnectionStatus = 'ready' | 'not_logged_in' | 'unavailable';

export interface ReasoningEffortInfo {
  id: string;
  description?: string;
}

export interface ServiceTierInfo {
  id: string;
  name: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  vision: boolean;
  reasoningEfforts: ReasoningEffortInfo[];
  defaultReasoningEffort: string | null;
  serviceTiers: ServiceTierInfo[];
  supportsFastMode: boolean;
  isDefault: boolean;
}

export interface Capabilities {
  webSearch: boolean;
  searchEngine: string;
  scholarSearch: boolean;
  vision: boolean;
  /** Opt-in MCP tools exposed by the local Codex runtime. */
  mcp?: boolean;
  /** True when every generation is owned by the local Codex proxy. */
  codexOnly?: boolean;
  /** Current local Codex connection state, when reported by the proxy. */
  status?: CodexConnectionStatus;
  modelSelection?: boolean;
  reasoningEffort?: boolean;
  modelSpeed?: boolean;
  projectDirectories?: boolean;
  projectFileAccess?: boolean;
}

export interface CodexModelStatus {
  status: CodexConnectionStatus;
  message?: string;
  model?: string;
}

export type ModelData = {
  models: ModelInfo[];
  default: string | null;
  capabilities?: Capabilities;
  codex?: CodexModelStatus;
};

// Model list is fetched once per session and shared by every picker.
// This catalog only reads the local Codex proxy.
let cache: ModelData | null = null;
let inflight: Promise<ModelData | null> | null = null;
const listeners = new Set<(d: ModelData) => void>();

function normalizeModelData(raw: unknown): ModelData {
  const d = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const codexRaw = d.codex && typeof d.codex === 'object'
    ? d.codex as Record<string, unknown>
    : null;
  const status = codexRaw && ['ready', 'not_logged_in', 'unavailable'].includes(String(codexRaw.status))
    ? String(codexRaw.status) as CodexConnectionStatus
    : undefined;
  const capabilitiesRaw = d.capabilities && typeof d.capabilities === 'object'
    ? d.capabilities as Record<string, unknown>
    : null;
  const models = Array.isArray(d.models)
    ? d.models.flatMap((entry): ModelInfo[] => {
        if (!entry || typeof entry !== 'object') return [];
        const model = entry as Record<string, unknown>;
        const id = typeof model.id === 'string' ? model.id : '';
        if (!id) return [];
        const effortsRaw = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
          : Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
        const reasoningEfforts = effortsRaw.flatMap((effort): ReasoningEffortInfo[] => {
          if (typeof effort === 'string' && effort) return [{ id: effort }];
          if (!effort || typeof effort !== 'object') return [];
          const item = effort as Record<string, unknown>;
          const effortId = [item.reasoningEffort, item.id, item.value].find((value) => typeof value === 'string' && value) as string | undefined;
          if (!effortId) return [];
          return [{
            id: effortId,
            ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}),
          }];
        });
        const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : [];
        const serviceTiers = Array.isArray(model.serviceTiers)
          ? model.serviceTiers.flatMap((tier): ServiceTierInfo[] => {
              if (!tier || typeof tier !== 'object') return [];
              const item = tier as Record<string, unknown>;
              if (typeof item.id !== 'string' || !item.id) return [];
              return [{
                id: item.id,
                name: typeof item.name === 'string' && item.name ? item.name : item.id,
                ...(typeof item.description === 'string' && item.description
                  ? { description: item.description }
                  : {}),
              }];
            })
          : [];
        return [{
          id,
          name: typeof model.name === 'string' && model.name
            ? model.name
            : typeof model.displayName === 'string' && model.displayName ? model.displayName : id,
          vision: model.vision !== false && (modalities.length === 0 || modalities.includes('image')),
          reasoningEfforts,
          defaultReasoningEffort: typeof model.defaultReasoningEffort === 'string'
            ? model.defaultReasoningEffort
            : null,
          serviceTiers,
          supportsFastMode: model.supportsFastMode === true
            || serviceTiers.some((tier) => tier.id === 'priority' || tier.id === 'fast'),
          isDefault: model.isDefault === true,
        }];
      })
    : [];
  const capabilities = capabilitiesRaw ? {
    webSearch: capabilitiesRaw.webSearch === true,
    searchEngine: typeof capabilitiesRaw.searchEngine === 'string' ? capabilitiesRaw.searchEngine : 'codex',
    scholarSearch: capabilitiesRaw.scholarSearch === true,
    vision: capabilitiesRaw.vision === true || models.some((m) => m.vision),
    mcp: capabilitiesRaw.mcp === true,
    codexOnly: true,
    modelSelection: capabilitiesRaw.modelSelection === true,
    reasoningEffort: capabilitiesRaw.reasoningEffort === true,
    modelSpeed: capabilitiesRaw.modelSpeed === true,
    projectDirectories: capabilitiesRaw.projectDirectories === true,
    projectFileAccess: capabilitiesRaw.projectFileAccess === true,
    status: status ?? (['ready', 'not_logged_in', 'unavailable'].includes(String(capabilitiesRaw.status))
      ? String(capabilitiesRaw.status) as CodexConnectionStatus
      : undefined),
  } satisfies Capabilities : undefined;

  return {
    models,
    default: typeof d.default === 'string'
      ? d.default
      : models.find((model) => model.isDefault)?.id ?? null,
    capabilities,
    codex: status ? {
      status,
      ...(typeof codexRaw?.message === 'string' ? { message: codexRaw.message } : {}),
      ...(typeof codexRaw?.model === 'string' ? { model: codexRaw.model } : {}),
    } : undefined,
  };
}

async function fetchModels(): Promise<ModelData> {
  const response = await fetch(`${API_BASE}/api/models`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return normalizeModelData(await response.json());
}

/** Imperative access to the same per-session model cache. */
export function getModelsOnce(): Promise<ModelData | null> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetchModels()
    .then((data) => {
      setModelsCache(data);
      return data;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/** Re-fetch only from the local Codex proxy and notify every picker. */
export async function refreshModels(): Promise<ModelData | null> {
  try {
    const data = await fetchModels();
    setModelsCache(data);
    return data;
  } catch {
    return null;
  }
}

/** Family-level id retained so old imported pins can still reconcile. */
function modelBasename(id: string): string {
  return (id.split('/').pop() ?? id).toLowerCase();
}

/** Reconcile a pinned model id against the models exposed by Codex. */
export function reconcileModelId(pinned: string, models: ModelInfo[]): string | null {
  if (models.some((m) => m.id === pinned)) return pinned;
  const base = modelBasename(pinned);
  const match = models.find((m) => modelBasename(m.id) === base);
  return match ? match.id : null;
}

/** Keep a persisted effort only when the effective model currently supports it. */
export function reconcileReasoningEffort(
  effort: string | null | undefined,
  modelId: string | null | undefined,
  models: ModelInfo[],
): string | null {
  if (!effort || !modelId) return null;
  const model = models.find((entry) => entry.id === modelId);
  return model?.reasoningEfforts.some((entry) => entry.id === effort) ? effort : null;
}

/** Replace the shared cache and notify every subscribed picker. */
export function setModelsCache(data: ModelData): void {
  cache = data;
  for (const listener of listeners) listener(data);
}

export function useModels(): ModelData | null {
  const [data, setData] = useState<ModelData | null>(cache);
  useEffect(() => {
    const listener = (next: ModelData) => setData(next);
    listeners.add(listener);
    if (!cache) {
      void getModelsOnce().then((next) => {
        if (listeners.has(listener) && next) setData(next);
      });
    }
    return () => { listeners.delete(listener); };
  }, []);
  return data;
}
