import { consumeGenerationStream } from './generation-stream';
import { requestGenerationInteraction, removeGenerationInteraction } from './generation-interactions';
import { API_BASE } from './constants';
import { useUiStore, type ModelSpeed, type PermissionMode } from './ui-store';
import { getModelsOnce, reconcileReasoningEffort, type ModelData } from './use-models';
import { ensureDesktopProjectHydrated } from './desktop-project';
import { withUrlSnapshots } from './url-context';
import { errorText } from './error-text';

const API_URL = `${API_BASE}/api/codex`;
const STREAM_URL = `${API_BASE}/api/stream`;
const PDF_EXTRACT_URL = `${API_BASE}/api/pdf-extract`;

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ImageAttachment {
  data: string; // base64
  mimeType: string;
  /** The image's companion text (its index) is already in the messages. */
  hasCompanion?: boolean;
}

export interface PdfExtractResult {
  text: string;
  numPages: number;
  images?: string[]; // base64 PNG per page (absent if poppler unavailable)
  imagesUnavailable?: boolean;
}

// Extract text + page images from a PDF via the proxy. Throws on HTTP errors.
export async function extractPdf(base64: string): Promise<PdfExtractResult> {
  const res = await fetch(PDF_EXTRACT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64 }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(errorText(err, `HTTP ${res.status}`));
  }
  return res.json();
}

export interface LinkSnapshot { title: string; text: string; fetchedAt: string; html?: string }

// Server-side URL fetch for link nodes (browsers can't: CORS). Returns a
// stamped text snapshot — see /api/fetch-url in server.mjs.
export async function fetchUrlSnapshot(url: string, signal?: AbortSignal): Promise<LinkSnapshot> {
  try {
    const res = await fetch(`${API_BASE}/api/fetch-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal,
    });
    if (!res.ok) {
      // Our endpoint always answers JSON; a non-JSON 404 is Express itself
      // saying the route doesn't exist — i.e. a proxy started before the
      // endpoint was added. Tell the user the actual fix.
      const err = await res.json().catch(() => ({
        error: res.status === 404
          ? 'Proxy has no /api/fetch-url — restart it (npm run server)'
          : `HTTP ${res.status}`,
      }));
      throw new Error(errorText(err, `HTTP ${res.status}`));
    }
    return res.json();
  } catch (err: unknown) {
    throw wrapError(err); // network failures get the "is the proxy running?" hint
  }
}

// Wrap transport failures with an actionable hint. Errors always THROW —
// callers decide how to surface them (toast, placeholder, silent).
function wrapError(err: unknown): Error {
  if (err instanceof DOMException && err.name === 'AbortError') return err as unknown as Error;
  const message = err instanceof Error ? err.message : 'Unknown error';
  return new Error(
    /fetch|network|Failed to fetch/i.test(message)
      ? `${message} — is the proxy running? (npm run server)`
      : message
  );
}


// The user's model choice outranks the vision stand-in: when the chosen
// model cannot see images but every image already has its companion text
// in the messages, drop the pixels and keep the model. The reroute (with
// its announcement + rescue) remains the fallback for UNindexed images.
async function imagesForModel(
  modelId: string | undefined,
  images?: ImageAttachment[],
  knownModels?: ModelData | null,
): Promise<ImageAttachment[] | undefined> {
  if (!images?.length) return images;
  const data = knownModels === undefined ? await getModelsOnce() : knownModels;
  // no explicit choice = the catalog default answers (mirror of the proxy)
  const effective = modelId ?? data?.default ?? undefined;
  const info = effective ? data?.models.find((m) => m.id === effective) : undefined;
  // explicit false only: unknown vision keeps the pixels so the first real
  // request can serve as the capability probe
  if (info && info.vision === false && images.every((i) => i.hasCompanion)) return undefined;
  return images;
}

// Old canvases and localStorage may still carry a provider-era model id.
// Never forward it to the Codex-only proxy: use it only when the local
// catalog explicitly exposes the id, otherwise fall back to Codex default.
async function resolveGenerationConfig(modelOverride?: string, includeProject = false): Promise<{
  modelId?: string;
  reasoningEffort?: string;
  modelSpeed: ModelSpeed;
  projectId?: string;
  permissionMode: PermissionMode;
  modelData: ModelData | null;
}> {
  if (includeProject) await ensureDesktopProjectHydrated();
  // One Zustand object is the start-of-request snapshot. Later UI changes
  // affect only later requests, never a half-resolved model/effort/project.
  const state = useUiStore.getState();
  const selectedModel = state.selectedModel;
  const selectedReasoningEffort = state.selectedReasoningEffort;
  const requestedModelSpeed = state.modelSpeed;
  // Only a foreground conversation turn may inherit the user's project
  // permission choice. Background summaries/judges receive explicit canvas
  // context and always stay read-only with no ambient host access.
  const permissionMode: PermissionMode = includeProject ? state.permissionMode : 'readonly';
  // Project tools are reserved for foreground conversation turns. Background
  // judges/summaries already receive their explicit canvas context and should
  // not gain ambient file access merely because a folder is selected.
  const projectId = includeProject ? state.codexProjectFolder?.id : undefined;
  const data = await getModelsOnce();
  const requestedModel = modelOverride || selectedModel || undefined;
  const modelId = requestedModel && data?.models.some((model) => model.id === requestedModel)
    ? requestedModel
    : data?.default ?? undefined;
  const reasoningEffort = reconcileReasoningEffort(
    selectedReasoningEffort,
    modelId,
    data?.models ?? [],
  ) ?? undefined;
  const effectiveModel = modelId ? data?.models.find((model) => model.id === modelId) : undefined;
  const modelSpeed: ModelSpeed = requestedModelSpeed === 'fast' && effectiveModel?.supportsFastMode === false
    ? 'standard'
    : requestedModelSpeed;
  return { modelId, reasoningEffort, modelSpeed, projectId, permissionMode, modelData: data };
}

// Non-streaming call (used for background summaries)
export async function llmCall(contextMessages: ContextMessage[], images?: ImageAttachment[], modelOverride?: string): Promise<string> {
  const { modelId, reasoningEffort, modelSpeed, projectId, permissionMode, modelData } = await resolveGenerationConfig(modelOverride);
  images = await imagesForModel(modelId, images, modelData);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: contextMessages,
        images: images?.length ? images : undefined,
        model: modelId,
        reasoningEffort,
        modelSpeed,
        projectId,
        permissionMode,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorText(err, `HTTP ${res.status}`));
    }

    const data = await res.json();
    return data.text;
  } catch (err: unknown) {
    throw wrapError(err);
  }
}

export interface StreamCallbacks {
  /** The model started a tool call (web_search / arxiv_search / semantic_scholar). */
  onToolCall?: (name: string, query: string) => void;
  /** Codex web search is active for this generation. */
  onGatewaySearch?: () => void;
  /** All sources consulted during generation (sent once, at the end). */
  onSources?: (sources: import('../types').Reference[]) => void;
  /** Reasoning/thinking tokens (models that emit them; never enters context). */
  onReasoning?: (chunk: string, fullSoFar: string) => void;
  /** The chosen model cannot see images: a vision model answers instead. */
  onRerouted?: (from: string, to: string) => void;
  /** The vision stand-in failed; the original model answers from the
      images' companion text. */
  onImageFallback?: (model: string) => void;
  /** Persistent Codex App Server identity returned by the stream's final
      frame. It is stored alongside the answer version by the node pipeline. */
  onFinal?: (metadata: CodexStreamMetadata) => void;
  onCommentary?: (text: string) => void;
}

export type CodexThreadMode = 'start' | 'resume' | 'fork';

export interface CodexLinkRequest {
  mode: CodexThreadMode;
  threadId?: string;
  turnId?: string;
}

export interface CodexStreamMetadata {
  status?: string;
  model?: string;
  reasoningEffort?: string;
  modelSpeed?: string;
  serviceTier?: string;
  contextCompacted?: boolean;
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number; cachedInputTokens?: number };
  threadId?: string;
  turnId?: string;
  threadMode?: CodexThreadMode;
}

export interface ToolPrefs {
  web?: boolean;
  scholar?: boolean;
  mcp?: boolean;
}

// Streaming call — invokes onChunk with each text delta, returns full text
export async function llmCallStream(
  contextMessages: ContextMessage[],
  onChunk: (chunk: string, fullSoFar: string) => void,
  signal?: AbortSignal,
  images?: ImageAttachment[],
  callbacks?: StreamCallbacks,
  toolPrefs?: ToolPrefs,
  modelOverride?: string,
  codexLink?: CodexLinkRequest,
): Promise<string> {
  if (contextMessages.some(message => message.content.startsWith('[PDF visual unavailable:'))) throw new Error('PDF 页面图像尚未准备好。请等待提取完成，或在附件中明确选择仅文字。 / PDF page images are unavailable.');
  const { modelId, reasoningEffort, modelSpeed, projectId, permissionMode, modelData } = await resolveGenerationConfig(modelOverride, true);
  images = await imagesForModel(modelId, images, modelData);
  const cbs = callbacks ?? {};
  // Codex web search is model-driven: it may decide not to open a literal
  // URL. Deterministically snapshot URLs already present in the wired
  // context when web access is enabled, so "inspect this link" receives
  // the page rather than just its address. Link material already carrying a
  // snapshot is detected and never fetched twice.
  const urlContext = toolPrefs?.web
    ? await withUrlSnapshots(contextMessages, fetchUrlSnapshot, signal)
    : { messages: contextMessages, sources: [] };
  if (urlContext.sources.length > 0) cbs.onSources?.(urlContext.sources);
  return proxyStream(images, onChunk);

  async function proxyStream(imgs: ImageAttachment[] | undefined, chunkCb: typeof onChunk): Promise<string> {
  try {
    const res = await fetch(STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: urlContext.messages,
        images: imgs?.length ? imgs : undefined,
        webSearch: toolPrefs?.web,
        scholarSearch: toolPrefs?.scholar,
        mcpTools: toolPrefs?.mcp,
        model: modelId,
        reasoningEffort,
        modelSpeed,
        projectId,
        permissionMode,
        codexLink,
      }),
      signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorText(err, `HTTP ${res.status}`));
    }

    return await consumeGenerationStream(res, {
      onText: chunkCb,
      onReasoning: cbs.onReasoning,
      onCommentary: cbs.onCommentary,
      onMetadata: cbs.onFinal,
      onTool: (name, query) => cbs.onToolCall?.(name, query || name),
      onInteractionsClosed: ids => ids.forEach(removeGenerationInteraction),
      onInteraction: interaction => requestGenerationInteraction(interaction, signal),
    });
  } catch (err: unknown) {
    // AbortError passes through untouched for stop-generation handling
    throw wrapError(err);
  }
  }
}
