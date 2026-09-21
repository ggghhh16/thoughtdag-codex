import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
const definitions = source.slice(0, source.indexOf('async function desktopServerJson'))
  + source.slice(source.indexOf('function setupProjectChannel()'), source.indexOf('function setupCodexHistoryChannel()'));

test('native project picker, allowed paths, registrations, explorer, and a real permanent git worktree', async () => {
  fs.mkdirSync('.test-build', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.test-build/native-folders-'));
  const repo = path.join(root, 'repo'), state = path.join(root, 'state'), other = path.join(root, 'other');
  for (const dir of [repo, state, other]) fs.mkdirSync(dir);
  execFileSync('git', ['init', repo], { windowsHide: true, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'proof.txt'), 'worktree fixture');
  execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: repo, windowsHide: true, stdio: 'pipe' });
  const handlers = new Map(), opened = [];
  const frame = { url: 'http://127.0.0.1:31173/' }, webContents = { mainFrame: null }; webContents.mainFrame = frame;
  const event = { sender: webContents, senderFrame: frame };
  let selected = repo, destination = path.join(root, 'permanent-worktree'), canceled = false, registrations = 0;
  const electron = {
    app: { isPackaged: false, getPath: () => state },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: {
      showOpenDialog: async () => ({ canceled, filePaths: [selected] }),
      showSaveDialog: async () => ({ canceled, filePath: destination }),
    },
    shell: { openPath: async (value) => { opened.push(value); return ''; } },
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : require(name),
    process, console, URL, __dirname: path.resolve('desktop'), Buffer,
    fetch: async (_url, options) => {
      const requested = JSON.parse(options.body).path;
      return { ok: true, json: async () => ({ project: { id: `opaque-${++registrations}`, path: fs.realpathSync(requested), name: path.basename(requested) } }) };
    },
    testWin: { webContents },
  });
  vm.runInContext(definitions + '\nserverPort = 31173; win = testWin; setupProjectChannel();', context);
  const call = (name, ...args) => handlers.get(name)(event, ...args);
  const chosen = await call('project:select');
  assert.equal(chosen.project.path, repo); assert.equal(registrations, 1);
  await call('project:clear');
  assert.equal(await call('project:get'), null);
  const activated = await call('project:activate', repo);
  assert.equal(activated.id, chosen.project.id); assert.equal(registrations, 1, 'repeat canvas switches reuse the server registration');
  await assert.rejects(call('project:activate', other), /native folder picker/);
  await assert.rejects(handlers.get('project:activate')({ ...event, sender: {} }, repo), /untrusted renderer/);
  await assert.rejects(call('project:select', { activate: 'no' }), /Invalid project picker options/);
  selected = other;
  await call('project:select', { activate: false });
  assert.equal((await call('project:get')).path, repo, 'adding a project must not change the active canvas directory');
  await call('project:open', other); assert.deepEqual(opened, [other]);
  canceled = true;
  assert.equal((await call('project:worktree', repo)).canceled, true);
  assert.equal(fs.existsSync(destination), false);
  canceled = false;
  const tree = await call('project:worktree', repo);
  assert.equal(tree.project.path, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'proof.txt'), 'utf8'), 'worktree fixture');
  assert.match(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, windowsHide: true, encoding: 'utf8' }), /permanent-worktree/);
  assert.equal((await call('project:get')).path, repo, 'worktree creation must not silently move a canvas');
  await assert.rejects(call('project:worktree', repo), /已存在/);
  destination = path.join(root, 'not-a-repo-tree');
  await assert.rejects(call('project:worktree', other));
  assert.equal(fs.existsSync(destination), false);
});
