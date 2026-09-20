import type { ThoughtEdge, ThoughtNode } from '../types';
import { countTokens, generateId } from '../utils';
import { COLORS } from './constants';
import type { ImportableConversation } from './import-chat';
import { t } from '../i18n';

export interface CodexThreadSummary {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceKind?: string;
  threadSource?: string;
}

export interface CodexThreadTurn {
  id: string;
  userText: string;
  assistantText: string;
  reasoningSummary?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CodexThreadDetail extends CodexThreadSummary {
  turns: CodexThreadTurn[];
  latestTurnId?: string;
  /** Renderer-owned import policy. Archived official tasks are snapshots,
   *  never resumable links: continuing from their cards starts a clean task. */
  archived?: boolean;
}

export interface CodexThreadPage {
  threads: CodexThreadSummary[];
  nextCursor?: string;
}

export interface CodexThreadListOptions {
  search?: string;
  cursor?: string;
  limit?: number;
  archived?: boolean;
  signal?: AbortSignal;
}

function desktopBridge(): DesktopBridge | undefined {
  return window.desktop;
}

export function codexThreadImportAvailable(): boolean {
  const bridge = desktopBridge();
  return typeof bridge?.listCodexThreads === 'function' && typeof bridge.readCodexThread === 'function';
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** App Server timestamps are Unix seconds. Accept ISO strings as a
 * compatibility courtesy, but expose one representation to every consumer. */
export function codexTimestampIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  let milliseconds: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    milliseconds = Math.abs(value) < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() && Number.isFinite(numeric)) {
      milliseconds = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    } else {
      milliseconds = Date.parse(value);
    }
  } else {
    return undefined;
  }
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

function normalizeSummary(value: unknown): CodexThreadSummary | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = asText(raw.id);
  if (!id) return null;
  return {
    id,
    name: asText(raw.name),
    preview: asText(raw.preview),
    cwd: asText(raw.cwd),
    projectId: asText(raw.projectId),
    createdAt: codexTimestampIso(raw.createdAt),
    updatedAt: codexTimestampIso(raw.updatedAt),
    sourceKind: asText(raw.sourceKind),
    threadSource: asText(raw.threadSource),
  };
}

export async function listCodexThreads(
  options: CodexThreadListOptions = {},
): Promise<CodexThreadPage> {
  const bridge = desktopBridge();
  if (!bridge?.listCodexThreads) throw new Error(t('codexImport.desktopOnly'));
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const payload = await bridge.listCodexThreads({
    ...(options.search?.trim() ? { search: options.search.trim() } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: options.limit ?? 30,
    archived: options.archived === true,
  }) as { threads?: unknown; nextCursor?: unknown };
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return {
    threads: Array.isArray(payload.threads)
      ? payload.threads.map(normalizeSummary).filter((item): item is CodexThreadSummary => !!item)
      : [],
    nextCursor: asText(payload.nextCursor),
  };
}

export async function getCodexThread(threadId: string, signal?: AbortSignal): Promise<CodexThreadDetail> {
  const bridge = desktopBridge();
  if (!bridge?.readCodexThread) throw new Error(t('codexImport.desktopOnly'));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const payload = await bridge.readCodexThread(threadId) as { thread?: unknown };
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!payload.thread || typeof payload.thread !== 'object') throw new Error('Invalid Codex thread response');
  const raw = payload.thread as Record<string, unknown>;
  const summary = normalizeSummary(raw);
  if (!summary) throw new Error('Codex thread response is missing an id');
  const turns = Array.isArray(raw.turns)
    ? raw.turns.flatMap((value): CodexThreadTurn[] => {
        if (!value || typeof value !== 'object') return [];
        const turn = value as Record<string, unknown>;
        const id = asText(turn.id);
        const userText = typeof turn.userText === 'string' ? turn.userText.trim() : '';
        const assistantText = typeof turn.assistantText === 'string' ? turn.assistantText.trim() : '';
        // A half-written turn cannot be resumed safely from a canvas card.
        if (!id || !userText || !assistantText) return [];
        return [{
          id,
          userText,
          assistantText,
          reasoningSummary: asText(turn.reasoningSummary),
          status: asText(turn.status),
          startedAt: codexTimestampIso(turn.startedAt),
          completedAt: codexTimestampIso(turn.completedAt),
        }];
      })
    : [];
  return { ...summary, turns, latestTurnId: asText(raw.latestTurnId) };
}

function importedEdge(source: string, target: string, createdAt?: string): ThoughtEdge {
  return {
    id: `edge-${source}-${target}`,
    source,
    target,
    type: 'smoothstep',
    sourceHandle: 'continue',
    targetHandle: 'top',
    style: { stroke: COLORS.accent, strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed', color: COLORS.accent, width: 18, height: 18 } as ThoughtEdge['markerEnd'],
    data: createdAt ? { createdAt } : {},
  };
}

/** One official task becomes one independent canvas. Every App Server turn is
 *  one card, in the source order, and the final card retains enough identity
 *  for a new child to resume that exact Codex task. */
export function buildCodexThreadGraph(
  thread: CodexThreadDetail,
  idFactory: () => string = generateId,
): { nodes: ThoughtNode[]; edges: ThoughtEdge[] } {
  const nodes: ThoughtNode[] = [];
  const edges: ThoughtEdge[] = [];
  const fallbackAt = thread.updatedAt ?? thread.createdAt ?? new Date().toISOString();
  const resumable = thread.archived !== true;

  const completedTurns = thread.turns.filter((turn) => turn.id && turn.userText.trim() && turn.assistantText.trim());
  completedTurns.forEach((turn, index) => {
    const id = idFactory();
    const question = turn.userText.trim();
    const response = turn.assistantText.trim();
    const askedAt = turn.startedAt ?? turn.completedAt ?? fallbackAt;
    const at = turn.completedAt ?? turn.startedAt ?? fallbackAt;
    const node: ThoughtNode = {
      id,
      type: 'thought',
      position: { x: 120, y: 100 + index * 190 },
      dragHandle: '.drag-handle',
      data: {
        question,
        questions: [question],
        response,
        responses: [response],
        responseIndex: 0,
        isCollapsed: true,
        isEditing: false,
        isEditingResponse: false,
        isLoading: false,
        tokenCount: countTokens(question) + countTokens(response),
        highlights: [],
        highlightMode: 'tag',
        attachments: [],
        excludedAttachmentIds: [],
        includedAttachmentIds: [],
        roleMode: 'inherit',
        isRoot: index === 0,
        isBranch: false,
        createdAt: at,
        askedAt,
        generatedAts: [at],
        lastGeneratedAt: at,
        ...(turn.reasoningSummary ? { reasonings: [turn.reasoningSummary] } : {}),
        ...(resumable ? {
          codexThreadIds: [thread.id],
          codexTurnIds: [turn.id],
        } : {}),
      },
    };
    nodes.push(node);
    const parent = nodes[index - 1];
    if (parent) edges.push(importedEdge(parent.id, id, at));
  });
  return { nodes, edges };
}

export function codexThreadTitle(thread: CodexThreadSummary): string {
  return thread.name?.trim()
    || thread.preview?.trim().split(/\r?\n/, 1)[0]?.slice(0, 80)
    || `Codex ${thread.id.slice(0, 8)}`;
}

export function asImportableCodexConversation(thread: CodexThreadDetail): ImportableConversation {
  return {
    title: codexThreadTitle(thread),
    messageCount: thread.turns.length,
    source: 'codex',
    codexThreadId: thread.id,
    build: () => buildCodexThreadGraph(thread),
  };
}

/** JSON files are an untrusted interchange boundary. Thread ids inside a
 *  shared backup must never gain authority to resume or fork a task from the
 *  recipient's local Codex store. Official imports set these links again via
 *  the authenticated desktop bridge. */
export function detachCodexConversationLinks(nodes: ThoughtNode[]): ThoughtNode[] {
  return nodes.map((node) => {
    if (!node.data.codexThreadIds && !node.data.codexTurnIds) return node;
    return {
      ...node,
      data: {
        ...node.data,
        codexThreadIds: undefined,
        codexTurnIds: undefined,
      },
    };
  });
}
