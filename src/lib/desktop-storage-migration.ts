import { get as idbGet, set as idbSet } from 'idb-keyval';

const META_KEY = 'thoughtdag:projects';
const LEGACY_CANVAS_KEY = 'thoughtdag';
const PROJECT_PREFIX = 'thoughtdag:project:';
const ATTACHMENT_PREFIX = 'att-content:';
export const DESKTOP_ORIGIN_MIGRATION_MARKER = 'thoughtdag:desktop-origin-migration:31174-to-31173:v1';

export type LegacyStorageEntry = [key: string, value: unknown];

export interface MigrationStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

interface StoredProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  kind?: 'chat' | 'paradigm';
  instantiatedFrom?: { name: string; at: string };
}

interface StoredProjectsMeta {
  projects: StoredProjectMeta[];
  activeId: string;
}

export interface DesktopStorageMigrationResult {
  projectsImported: number;
  attachmentsImported: number;
  conflictsCopied: number;
}

const defaultStorage: MigrationStorage = {
  get: (key) => idbGet(key),
  set: (key, value) => idbSet(key, value),
};

export function isDesktopLegacyStorageKey(key: unknown): key is string {
  return typeof key === 'string' && (
    key === LEGACY_CANVAS_KEY
    || key === META_KEY
    || key.startsWith(PROJECT_PREFIX)
    || key.startsWith(ATTACHMENT_PREFIX)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseProjectsMeta(value: unknown): StoredProjectsMeta | null {
  if (typeof value === 'string') {
    try { return parseProjectsMeta(JSON.parse(value) as unknown); } catch { return null; }
  }
  const record = asRecord(value);
  if (!record || !Array.isArray(record.projects)) return null;
  const projects: StoredProjectMeta[] = [];
  const seen = new Set<string>();
  for (const candidate of record.projects) {
    const item = asRecord(candidate);
    if (!item || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) continue;
    seen.add(item.id);
    const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
      ? item.createdAt : Date.now();
    const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
      ? item.updatedAt : createdAt;
    const project: StoredProjectMeta = {
      ...item,
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : 'Recovered Canvas',
      createdAt,
      updatedAt,
    } as StoredProjectMeta;
    if (project.kind !== 'chat' && project.kind !== 'paradigm') delete project.kind;
    projects.push(project);
  }
  return {
    projects,
    activeId: typeof record.activeId === 'string' ? record.activeId : '',
  };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function recoveryName(name: string): string {
  return name.endsWith('（从旧端口恢复）') ? name : `${name}（从旧端口恢复）`;
}

async function deterministicRecoveryUuid(sourceId: string, attempt: number): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`thoughtdag:31174:${sourceId}:${attempt}`),
  ));
  // RFC 4122-shaped, deterministic UUID. Stable IDs make a partially written
  // migration safe to retry without accumulating orphan canvas copies.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function recoveredProjectId(
  sourceId: string,
  graph: unknown,
  storage: MigrationStorage,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = await deterministicRecoveryUuid(sourceId, attempt);
    const existing = await storage.get(`${PROJECT_PREFIX}${id}`);
    if (existing === undefined || valuesEqual(existing, graph)) return id;
  }
  throw new Error(`Unable to allocate a recovery project id for ${sourceId}.`);
}

/**
 * Merge an allowlisted snapshot from the former :31174 origin into the
 * current :31173 IndexedDB. Writes are idempotent and never replace primary
 * data. Exposed separately so the conflict rules can be regression-tested.
 */
export async function mergeDesktopLegacyStorage(
  snapshot: LegacyStorageEntry[],
  storage: MigrationStorage = defaultStorage,
): Promise<DesktopStorageMigrationResult> {
  const legacy = new Map<string, unknown>();
  for (const entry of snapshot) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isDesktopLegacyStorageKey(entry[0])) continue;
    legacy.set(entry[0], entry[1]);
  }

  const primaryMeta = parseProjectsMeta(await storage.get(META_KEY));
  const secondaryMeta = parseProjectsMeta(legacy.get(META_KEY));
  const projects = primaryMeta ? [...primaryMeta.projects] : [];
  const projectIds = new Set(projects.map((project) => project.id));
  const sourceToDestination = new Map<string, string>();
  let projectsImported = 0;
  let attachmentsImported = 0;
  let conflictsCopied = 0;

  for (const [key, value] of legacy) {
    if (!key.startsWith(ATTACHMENT_PREFIX)) continue;
    if (await storage.get(key) !== undefined) continue;
    await storage.set(key, value);
    attachmentsImported++;
  }

  const secondaryById = new Map((secondaryMeta?.projects ?? []).map((project) => [project.id, project]));
  const sourceIds = new Set<string>(secondaryById.keys());
  for (const key of legacy.keys()) {
    if (key.startsWith(PROJECT_PREFIX) && key.length > PROJECT_PREFIX.length) {
      sourceIds.add(key.slice(PROJECT_PREFIX.length));
    }
  }

  for (const sourceId of sourceIds) {
    const sourceKey = `${PROJECT_PREFIX}${sourceId}`;
    const hasGraph = legacy.has(sourceKey);
    const graph = legacy.get(sourceKey);
    const primaryGraph = hasGraph ? await storage.get(sourceKey) : undefined;
    let destinationId = sourceId;
    let conflict = false;

    if (hasGraph && primaryGraph === undefined) {
      await storage.set(sourceKey, graph);
    } else if (hasGraph && !valuesEqual(primaryGraph, graph)) {
      destinationId = await recoveredProjectId(sourceId, graph, storage);
      const destinationKey = `${PROJECT_PREFIX}${destinationId}`;
      if (await storage.get(destinationKey) === undefined) await storage.set(destinationKey, graph);
      conflict = true;
      conflictsCopied++;
    } else if (!hasGraph && projectIds.has(sourceId)) {
      sourceToDestination.set(sourceId, sourceId);
      continue;
    }

    sourceToDestination.set(sourceId, destinationId);
    if (projectIds.has(destinationId)) continue;
    const sourceMeta = secondaryById.get(sourceId);
    const now = Date.now();
    projects.push({
      ...(sourceMeta ?? {}),
      id: destinationId,
      name: conflict
        ? recoveryName(sourceMeta?.name || 'Recovered Canvas')
        : sourceMeta?.name || 'Recovered Canvas',
      createdAt: sourceMeta?.createdAt ?? now,
      updatedAt: sourceMeta?.updatedAt ?? now,
    });
    projectIds.add(destinationId);
    projectsImported++;
  }

  // Very old builds had one bare `thoughtdag` canvas and no project list.
  // Only use it when no project-scoped data exists, otherwise it is normally
  // the stale pre-migration copy of a canvas already represented above.
  if (sourceIds.size === 0 && legacy.has(LEGACY_CANVAS_KEY)) {
    const graph = legacy.get(LEGACY_CANVAS_KEY);
    let matchingId: string | null = null;
    for (const project of projects) {
      if (valuesEqual(await storage.get(`${PROJECT_PREFIX}${project.id}`), graph)) {
        matchingId = project.id;
        break;
      }
    }
    if (!matchingId) {
      const destinationId = await recoveredProjectId('legacy-canvas', graph, storage);
      const destinationKey = `${PROJECT_PREFIX}${destinationId}`;
      if (await storage.get(destinationKey) === undefined) await storage.set(destinationKey, graph);
      if (!projectIds.has(destinationId)) {
        const now = Date.now();
        projects.push({
          id: destinationId,
          name: 'My Canvas（从旧端口恢复）',
          createdAt: now,
          updatedAt: now,
        });
        projectIds.add(destinationId);
        projectsImported++;
      }
    }
  }

  if (projectsImported > 0) {
    const primaryActive = primaryMeta?.activeId;
    const secondaryActive = secondaryMeta?.activeId
      ? sourceToDestination.get(secondaryMeta.activeId)
      : undefined;
    const activeId = primaryActive && projectIds.has(primaryActive)
      ? primaryActive
      : secondaryActive && projectIds.has(secondaryActive)
        ? secondaryActive
        : projects[0]?.id || '';
    await storage.set(META_KEY, { projects, activeId } satisfies StoredProjectsMeta);
  }

  return { projectsImported, attachmentsImported, conflictsCopied };
}

/** Run once on the fixed :31173 renderer, before project hydration. */
export async function migrateDesktopLegacyStorage(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.desktop?.readLegacyStorage31174) return false;
  if (localStorage.getItem(DESKTOP_ORIGIN_MIGRATION_MARKER) === 'complete') return true;
  try {
    const snapshot = await window.desktop.readLegacyStorage31174();
    const result = await mergeDesktopLegacyStorage(snapshot);
    localStorage.setItem(DESKTOP_ORIGIN_MIGRATION_MARKER, 'complete');
    if (result.projectsImported || result.attachmentsImported) {
      console.info('[thoughtdag] recovered legacy desktop storage:', result);
    }
    return true;
  } catch (error) {
    // Do not set the completion marker: a temporarily occupied :31174 port or
    // interrupted write should be retried on the next desktop launch.
    console.warn('[thoughtdag] legacy desktop storage migration deferred:', error);
    return false;
  }
}
