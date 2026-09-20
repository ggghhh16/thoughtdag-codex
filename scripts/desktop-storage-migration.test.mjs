import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  isDesktopLegacyStorageKey,
  mergeDesktopLegacyStorage,
} from '../src/lib/desktop-storage-migration.ts';

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  async get(key) {
    return this.values.get(key);
  }

  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

const meta = (projects, activeId) => ({ projects, activeId });
const project = (id, name) => ({ id, name, createdAt: 10, updatedAt: 20 });

test('imports legacy projects and preserves the legacy active canvas when primary is empty', async () => {
  const storage = new MemoryStorage();
  const snapshot = [
    ['thoughtdag:projects', meta([project('a', 'Alpha'), project('b', 'Beta')], 'b')],
    ['thoughtdag:project:a', { state: { nodes: ['a'] }, version: 1 }],
    ['thoughtdag:project:b', { state: { nodes: ['b'] }, version: 1 }],
    ['att-content:pdf-1', 'base64-pdf'],
  ];

  const result = await mergeDesktopLegacyStorage(snapshot, storage);

  assert.deepEqual(result, { projectsImported: 2, attachmentsImported: 1, conflictsCopied: 0 });
  assert.deepEqual(await storage.get('thoughtdag:project:a'), snapshot[1][1]);
  assert.deepEqual(await storage.get('thoughtdag:project:b'), snapshot[2][1]);
  assert.equal(await storage.get('att-content:pdf-1'), 'base64-pdf');
  assert.equal((await storage.get('thoughtdag:projects')).activeId, 'b');
});

test('keeps the primary graph and copies a different same-id legacy graph under a recovered UUID', async () => {
  const primaryGraph = { state: { nodes: ['primary'] }, version: 1 };
  const legacyGraph = { state: { nodes: ['legacy'] }, version: 1 };
  const storage = new MemoryStorage([
    ['thoughtdag:projects', meta([project('same-id', 'Primary')], 'same-id')],
    ['thoughtdag:project:same-id', primaryGraph],
    ['att-content:shared', 'primary-attachment'],
  ]);

  const result = await mergeDesktopLegacyStorage([
    ['thoughtdag:projects', meta([project('same-id', 'Legacy')], 'same-id')],
    ['thoughtdag:project:same-id', legacyGraph],
    ['att-content:shared', 'legacy-must-not-overwrite'],
  ], storage);

  assert.deepEqual(result, { projectsImported: 1, attachmentsImported: 0, conflictsCopied: 1 });
  assert.deepEqual(await storage.get('thoughtdag:project:same-id'), primaryGraph);
  assert.equal(await storage.get('att-content:shared'), 'primary-attachment');
  const mergedMeta = await storage.get('thoughtdag:projects');
  assert.equal(mergedMeta.activeId, 'same-id');
  assert.equal(mergedMeta.projects.length, 2);
  const recovered = mergedMeta.projects.find((item) => item.id !== 'same-id');
  assert.match(recovered.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(recovered.name, 'Legacy（从旧端口恢复）');
  assert.deepEqual(await storage.get(`thoughtdag:project:${recovered.id}`), legacyGraph);
});

test('does not duplicate an identical same-id graph', async () => {
  const graph = { state: { nodes: ['same'] }, version: 1 };
  const storage = new MemoryStorage([
    ['thoughtdag:projects', meta([project('a', 'Primary')], 'a')],
    ['thoughtdag:project:a', graph],
  ]);

  const result = await mergeDesktopLegacyStorage([
    ['thoughtdag:projects', meta([project('a', 'Legacy')], 'a')],
    ['thoughtdag:project:a', structuredClone(graph)],
  ], storage);

  assert.deepEqual(result, { projectsImported: 0, attachmentsImported: 0, conflictsCopied: 0 });
  assert.deepEqual(await storage.get('thoughtdag:projects'), meta([project('a', 'Primary')], 'a'));
});

test('recovers the pre-project bare canvas and rejects non-ThoughtDAG keys', async () => {
  const storage = new MemoryStorage();
  const graph = JSON.stringify({ state: { nodes: ['old'] }, version: 0 });
  const result = await mergeDesktopLegacyStorage([
    ['thoughtdag', graph],
    ['thoughtdag.backupDirHandle', { sensitive: true }],
    ['unrelated', 'nope'],
  ], storage);

  assert.equal(result.projectsImported, 1);
  const mergedMeta = await storage.get('thoughtdag:projects');
  assert.equal(mergedMeta.projects[0].name, 'My Canvas（从旧端口恢复）');
  assert.equal(await storage.get(`thoughtdag:project:${mergedMeta.activeId}`), graph);
  assert.equal(await storage.get('thoughtdag.backupDirHandle'), undefined);
  assert.equal(await storage.get('unrelated'), undefined);
  assert.equal(isDesktopLegacyStorageKey('att-content:x'), true);
  assert.equal(isDesktopLegacyStorageKey('thoughtdag.backupDirHandle'), false);
});

test('desktop main owns fixed 31173 and exposes only the migration bridge', async () => {
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const [main, preload] = await Promise.all([
    readFile(path.join(repo, 'desktop', 'main.js'), 'utf8'),
    readFile(path.join(repo, 'desktop', 'preload.js'), 'utf8'),
  ]);
  assert.match(main, /const FIXED_SERVER_PORT = 31173;/);
  assert.doesNotMatch(main, /function freePort\s*\(/);
  assert.match(main, /ipcMain\.handle\('storage:read-legacy-31174'/);
  assert.match(preload, /readLegacyStorage31174/);
});
