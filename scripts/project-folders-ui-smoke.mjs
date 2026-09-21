import assert from 'node:assert/strict';
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const server = await preview({ configFile: false, preview: { host: '127.0.0.1', port: 0 } });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(10000);
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
await mkdir('.test-build', { recursive: true });
try {
  await page.addInitScript(() => {
    localStorage.setItem('thoughtdag.seeded', 'yes'); localStorage.setItem('thoughtdag.tutorialDone', 'yes');
    localStorage.setItem('thoughtdag.lang', 'zh'); localStorage.setItem('thoughtdag.theme', 'dark');
    const fromPath = (path) => ({ id: `registered:${path}`, name: path.split('/').at(-1), path });
    window.calls = [];
    window.desktop = {
      checkForUpdates: async () => {},
      getProjectFolder: async () => fromPath(localStorage.getItem('test.activePath') || 'D:/Code'),
      activateProjectFolder: async (path) => { window.calls.push(['activate', path]); if (window.failActivation) throw new Error('Folder unavailable'); localStorage.setItem('test.activePath', path); return fromPath(path); },
      selectProjectFolder: async () => ({ canceled: false, project: fromPath('D:/NewProject') }),
      clearProjectFolder: async () => { window.calls.push(['clear']); return null; },
      openProjectFolder: async (path) => { window.calls.push(['open', path]); },
      createProjectWorktree: async (path) => { window.calls.push(['worktree', path]); return { canceled: false, project: fromPath('D:/Code-worktree') }; },
    };
    window.readMeta = async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => resolve(r.result); });
      const result = await new Promise((resolve) => { const r = db.transaction('keyval').objectStore('keyval').get('thoughtdag:projects'); r.onsuccess = () => resolve(r.result); }); db.close(); return result;
    };
  });
  await page.goto(origin);
  await page.getByRole('button', { name: /My Canvas/ }).waitFor();
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => resolve(r.result); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keyval', 'readwrite'); const store = tx.objectStore('keyval');
      store.put({ projects: ['a', 'b', 'c'].map((id, i) => ({ id, name: ['开始Java学习路线 J1', 'My Canvas', 'Java学习 J0'][i], createdAt: 1, updatedAt: 3000 - i * 1000 })), activeId: 'a' }, 'thoughtdag:projects');
      for (const id of ['a', 'b', 'c']) store.put({ version: 1, state: { nodes: [{ id: `node-${id}`, type: 'thought', position: { x: 400, y: 200 }, data: { question: `保留原始问题 ${id}`, response: `保留原始回答 ${id}`, responses: [`保留原始回答 ${id}`], responseIndex: 0, highlights: [], isRoot: true } }], edges: [], events: [] } }, `thoughtdag:project:${id}`);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); db.close();
  });
  await page.reload();
  const open = async () => { if (!(await page.locator('[data-project-list]').count())) await page.locator('button').filter({ hasText: /开始Java学习路线 J1|My Canvas|Java学习 J0|Untitled/ }).first().click(); };
  await open();
  let meta = await page.evaluate(() => window.readMeta());
  assert.equal(meta.folders.length, 1); assert.ok(meta.projects.every((p) => p.folderId === meta.folders[0].id));
  const codeId = meta.folders[0].id;
  const folder = (id) => page.locator(`[data-folder-id="${id}"]`);
  const row = (id) => page.locator(`[data-canvas-id="${id}"]`);
  const context = async (id) => { await open(); await folder(id).locator('button').first().click({ button: 'right' }); };
  const menu = (name) => page.getByRole('menuitem', { name, exact: true });
  assert.equal(await row('a').locator('button').first().evaluate((e) => getComputedStyle(e.firstElementChild).fontSize), '13px');
  assert.equal(await row('a').locator('button').first().evaluate((e) => getComputedStyle(e.lastElementChild).fontSize), '11px');
  console.log('LEGACY_MIGRATION_AND_COMPACT_TYPE_OK');

  // Drag c before a and inspect both the source frame and insertion line.
  await row('c').hover(); await page.mouse.down();
  const source = await row('c').boundingBox(), target = await row('a').boundingBox();
  await page.mouse.move(source.x + 40, source.y + 10, { steps: 5 });
  await page.mouse.move(target.x + 45, target.y + 4, { steps: 12 });
  await page.mouse.move(target.x + 46, target.y + 5);
  await page.locator('.canvas-insert-line').waitFor();
  assert.match(await row('c').getAttribute('class'), /ring-1/);
  await page.screenshot({ path: '.test-build/project-drag.png' });
  await page.mouse.up();
  await page.waitForFunction(async () => (await window.readMeta()).projects[0].id === 'c');
  await page.reload(); await open();
  assert.deepEqual(await page.locator('[data-canvas-id]').evaluateAll((els) => els.map((e) => e.dataset.canvasId)), ['c', 'a', 'b']);
  await row('c').locator('button').first().focus(); await page.keyboard.press('Alt+ArrowDown');
  await page.waitForFunction(async () => (await window.readMeta()).projects[0].id === 'a');
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction(async () => (await window.readMeta()).projects[0].id === 'c');
  console.log('DRAG_FRAME_INSERTION_LINE_ORDER_RELOAD_OK');

  await context(codeId); await page.screenshot({ path: '.test-build/project-context-menu.png' });
  for (const label of ['置顶', '编辑', '分区', '在资源管理器中打开', '创建永久工作树', '全部标为已读', '归档画布', '移除项目']) assert.equal(await menu(label).count(), 1);
  await menu('置顶').click(); await page.waitForFunction(async () => (await window.readMeta()).folders[0].pinned);
  await context(codeId); await menu('编辑').click(); await page.getByRole('textbox', { name: '名称' }).fill('代码项目'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await folder(codeId).getByText('代码项目', { exact: true }).waitFor();
  await context(codeId); await menu('分区').click(); await menu('新建分区').click(); await page.getByRole('textbox', { name: '名称' }).fill('学习'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await context(codeId); await menu('取消置顶').click();
  await page.getByText('学习', { exact: true }).waitFor();
  await context(codeId); await menu('在资源管理器中打开').click();
  assert.ok(await page.evaluate(() => window.calls.some((c) => c[0] === 'open' && c[1] === 'D:/Code')));
  await context(codeId); await menu('全部标为已读').click();
  await page.waitForFunction(async () => (await window.readMeta()).projects.every((p) => p.readAt > p.updatedAt));
  await context(codeId); await menu('创建永久工作树').click();
  await page.waitForFunction(async () => (await window.readMeta()).folders.length === 2);
  meta = await page.evaluate(() => window.readMeta()); const worktreeId = meta.folders.find((f) => f.path === 'D:/Code-worktree').id;
  console.log('CONTEXT_PIN_EDIT_SECTIONS_READ_OPEN_WORKTREE_OK');

  // Move the active canvas into an empty project; its directory must switch too.
  await row('a').dragTo(folder(worktreeId).locator('button').first());
  await page.waitForFunction(async () => (await window.readMeta()).projects.find((p) => p.id === 'a').folderId !== (await window.readMeta()).projects.find((p) => p.id === 'b').folderId);
  assert.ok(await page.evaluate(() => window.calls.some((c) => c[0] === 'activate' && c[1] === 'D:/Code-worktree')));
  await page.reload(); await open(); assert.equal(await folder(worktreeId).locator('[data-canvas-id="a"]').count(), 1);
  await row('b').locator('button').first().click(); await open();
  assert.ok(await page.evaluate(() => window.calls.some((c) => c[0] === 'activate' && c[1] === 'D:/Code')));
  await row('b').hover(); await row('b').getByRole('button', { name: '创建副本', exact: true }).click(); await open();
  meta = await page.evaluate(() => window.readMeta()); assert.equal(meta.projects.find((p) => p.id === meta.activeId).folderId, codeId);
  await page.getByText('保留原始问题 b', { exact: true }).waitFor();
  console.log('CROSS_PROJECT_MOVE_SWITCH_DUPLICATE_AND_RELOAD_OK');

  await context(codeId); await menu('归档画布').click(); await page.getByRole('button', { name: '已归档画布', exact: true }).click();
  assert.equal(await folder(codeId).locator('[data-canvas-id]').count(), 3);
  await context(codeId); await menu('恢复全部画布').click(); await page.getByRole('button', { name: '返回画布列表', exact: true }).click();
  await folder(codeId).locator('button').first().click(); assert.equal(await folder(codeId).locator('[data-canvas-id]').count(), 0);
  await page.reload(); await open(); assert.equal(await folder(codeId).locator('[data-canvas-id]').count(), 0);
  await folder(codeId).locator('button').first().click();
  await context(codeId); await menu('移除项目').click(); await page.getByRole('button', { name: '移除项目', exact: true }).click();
  await open(); await page.waitForFunction(async () => (await window.readMeta()).folders.length === 1);
  meta = await page.evaluate(() => window.readMeta()); assert.equal(meta.projects.length, 4); assert.equal(meta.projects.filter((p) => !p.folderId).length, 3);
  await page.getByText('保留原始问题 b', { exact: true }).waitFor();
  console.log('ARCHIVE_RESTORE_COLLAPSE_REMOVE_PRESERVES_CANVASES_OK');

  await page.getByRole('button', { name: '添加项目文件夹…', exact: true }).click();
  await page.waitForFunction(async () => (await window.readMeta()).folders.length === 2);
  assert.equal((await page.evaluate(() => window.readMeta())).projects.find((p) => p.id === meta.activeId).folderId, null);
  console.log('ADDING_FOLDER_PRESERVES_ACTIVE_CANVAS_MEMBERSHIP_OK');

  await page.evaluate(() => { window.failActivation = true; });
  await row('a').locator('button').first().click();
  await page.getByText('Folder unavailable', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.readMeta())).activeId, meta.activeId);
  await open(); await page.screenshot({ path: '.test-build/project-final.png' });
  assert.deepEqual(errors, []);
  console.log('FAILED_DIRECTORY_SWITCH_PRESERVES_ACTIVE_CANVAS_OK');
} finally {
  await browser.close(); await new Promise((resolve) => server.httpServer.close(resolve));
}
