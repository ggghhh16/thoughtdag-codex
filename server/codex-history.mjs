const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 4096;
const MAX_SEARCH_LENGTH = 200;

// Explicitly include every user-facing Codex entry point. Omitting this field
// would make app-server default to only cli/vscode and hide app-server or exec
// conversations from the import picker. Sub-agent threads are intentionally
// excluded because they are implementation details rather than conversations
// the user started.
export const CODEX_HISTORY_SOURCE_KINDS = Object.freeze([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CodexHistoryValidationError extends Error {
  constructor(message, code = 'INVALID_CODEX_HISTORY_REQUEST') {
    super(message);
    this.name = 'CodexHistoryValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

function optionalScalar(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new CodexHistoryValidationError(`${name} must be a string.`);
  }
  return value;
}

/** Convert untrusted HTTP query values into the official thread/list params. */
export function normalizeCodexThreadListParams({ cursor, limit, search, archived } = {}) {
  const normalizedCursor = optionalScalar(cursor, 'cursor');
  if (normalizedCursor && (
    normalizedCursor.length > MAX_CURSOR_LENGTH
    || /[\u0000-\u001f\u007f]/.test(normalizedCursor)
  )) {
    throw new CodexHistoryValidationError('cursor is invalid.', 'INVALID_CODEX_CURSOR');
  }

  let normalizedLimit = DEFAULT_PAGE_SIZE;
  if (limit !== undefined && limit !== null && limit !== '') {
    const rawLimit = typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : limit;
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_SIZE) {
      throw new CodexHistoryValidationError(
        `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`,
        'INVALID_CODEX_HISTORY_LIMIT',
      );
    }
    normalizedLimit = rawLimit;
  }

  const normalizedSearch = optionalScalar(search, 'search')?.trim();
  if (normalizedSearch && normalizedSearch.length > MAX_SEARCH_LENGTH) {
    throw new CodexHistoryValidationError(
      `search must be at most ${MAX_SEARCH_LENGTH} characters.`,
      'INVALID_CODEX_HISTORY_SEARCH',
    );
  }

  let normalizedArchived = false;
  if (archived !== undefined) {
    if (archived === true || archived === 'true') normalizedArchived = true;
    else if (archived === false || archived === 'false') normalizedArchived = false;
    else {
      throw new CodexHistoryValidationError(
        'archived must be true or false.',
        'INVALID_CODEX_HISTORY_ARCHIVED',
      );
    }
  }

  return {
    ...(normalizedCursor ? { cursor: normalizedCursor } : {}),
    limit: normalizedLimit,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    sourceKinds: [...CODEX_HISTORY_SOURCE_KINDS],
    archived: normalizedArchived,
    ...(normalizedSearch ? { searchTerm: normalizedSearch } : {}),
  };
}

/** Codex-generated thread IDs are UUIDs; accepting canonical UUIDs also keeps legacy logs usable. */
export function normalizeCodexThreadId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CodexHistoryValidationError(
      'threadId must be a canonical Codex UUID.',
      'INVALID_CODEX_THREAD_ID',
    );
  }
  return value.toLowerCase();
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function sourceKind(source) {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    if (typeof source.custom === 'string') return 'custom';
    if (source.subAgent !== undefined) return 'subAgent';
  }
  return 'unknown';
}

function itemTextParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item?.type === 'text')
    .map((item) => text(item?.text))
    .filter(Boolean);
}

function reasoningSummary(items) {
  const summaries = [];
  for (const item of items) {
    if (item?.type !== 'reasoning' || !Array.isArray(item.summary)) continue;
    for (const part of item.summary) {
      const value = text(typeof part === 'string' ? part : part?.text);
      if (value) summaries.push(value);
    }
  }
  return summaries.length > 0 ? summaries.join('\n\n') : null;
}

/** Reduce one raw App Server turn to conversation text only. */
export function codexTurnDto(turn, originalIndex = 0) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const userText = items
    .filter((item) => item?.type === 'userMessage')
    .flatMap((item) => itemTextParts(item.content))
    .join('\n\n');

  const agentMessages = items
    .filter((item) => item?.type === 'agentMessage' && text(item.text))
    .map((item) => ({ phase: item.phase, text: text(item.text) }));
  const finalMessages = agentMessages.filter((item) => item.phase === 'final_answer');
  const compatibleMessages = agentMessages.filter((item) => item.phase !== 'commentary');
  const assistantText = finalMessages.length > 0
    ? finalMessages.map((item) => item.text).join('\n\n')
    : compatibleMessages.at(-1)?.text || '';
  const summary = reasoningSummary(items);

  const id = typeof turn?.id === 'string' ? turn.id : '';
  return {
    id,
    userText,
    assistantText,
    ...(summary ? { reasoningSummary: summary } : {}),
    status: typeof turn?.status === 'string' ? turn.status : 'unknown',
    startedAt: finiteNumber(turn?.startedAt),
    completedAt: finiteNumber(turn?.completedAt),
    durationMs: finiteNumber(turn?.durationMs),
    // Only used internally to keep sorting stable when old rollouts have no timestamps.
    _originalIndex: originalIndex,
  };
}

function sortedConversationTurns(rawTurns) {
  return (Array.isArray(rawTurns) ? rawTurns : [])
    .map((turn, index) => codexTurnDto(turn, index))
    // Never turn interrupted, failed, tool-only, or half-written history into
    // a completed ThoughtDAG question/answer card.
    .filter((turn) => turn.id
      && turn.status === 'completed'
      && turn.userText
      && turn.assistantText)
    .sort((left, right) => {
      const leftTime = left.startedAt ?? left.completedAt;
      const rightTime = right.startedAt ?? right.completedAt;
      if (leftTime === null && rightTime === null) return left._originalIndex - right._originalIndex;
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return leftTime - rightTime || left._originalIndex - right._originalIndex;
    })
    .map(({ _originalIndex, ...turn }) => turn);
}

/** Stable metadata shared by list and detail responses. */
export function codexThreadDto(thread, { includeTurns = false } = {}) {
  const preview = text(thread?.preview);
  const id = typeof thread?.id === 'string' ? thread.id : '';
  const name = text(thread?.name) || preview || 'Untitled Codex conversation';
  const turns = includeTurns ? sortedConversationTurns(thread?.turns) : undefined;
  return {
    id,
    name,
    preview,
    cwd: typeof thread?.cwd === 'string' ? thread.cwd : null,
    projectId: typeof thread?.projectId === 'string' ? thread.projectId : null,
    sourceKind: sourceKind(thread?.source),
    threadSource: typeof thread?.threadSource === 'string' ? thread.threadSource : null,
    modelProvider: typeof thread?.modelProvider === 'string' ? thread.modelProvider : null,
    createdAt: finiteNumber(thread?.createdAt),
    updatedAt: finiteNumber(thread?.updatedAt),
    recencyAt: finiteNumber(thread?.recencyAt),
    status: typeof thread?.status?.type === 'string' ? thread.status.type : 'unknown',
    isPinned: thread?.isPinned === true,
    ...(includeTurns ? {
      turns,
      turnCount: turns.length,
    } : {}),
  };
}

export function codexThreadListDto(result) {
  const threads = (Array.isArray(result?.data) ? result.data : [])
    .filter((thread) => thread?.ephemeral !== true)
    .map((thread) => codexThreadDto(thread));
  return {
    threads,
    nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null,
  };
}

export function codexThreadDetailDto(result) {
  if (!result?.thread || typeof result.thread !== 'object') {
    throw new Error('Codex App Server returned an invalid thread/read response.');
  }
  return { thread: codexThreadDto(result.thread, { includeTurns: true }) };
}
