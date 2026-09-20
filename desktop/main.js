// ThoughtDAG Codex desktop shell — a thin window around the SAME app:
// the bundled server.mjs runs as a child, serves the built dist on a
// local port, and this window points at it. No second stack: everything
// the web app is, the desktop app is.
const { app, BrowserWindow, dialog, shell, utilityProcess, ipcMain } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const net = require('net');

// Development: the repo root (live dist + server.mjs + root node_modules).
// Packaged: a self-contained payload under Resources — same three files,
// prepared by scripts/prepare-payload.mjs with production deps only.
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'payload')
  : path.join(__dirname, '..');
let serverProc = null;
let win = null;
let serverPort = null;
let currentProject = null;
const desktopControlToken = crypto.randomBytes(32).toString('hex');
const FIXED_SERVER_PORT = 31173;
const LEGACY_STORAGE_PORT = 31174;

function assertTrustedRenderer(event) {
  const url = event.senderFrame?.url || event.sender?.getURL?.() || '';
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* rejected below */ }
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || !serverPort || origin !== `http://127.0.0.1:${serverPort}`) {
    throw new Error('Desktop bridge rejected an untrusted renderer.');
  }
}

function projectStateFile() {
  return path.join(app.getPath('userData'), 'codex-project.json');
}

function readSavedProjectPath() {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectStateFile(), 'utf8'));
    return typeof parsed?.path === 'string' && parsed.path.trim() ? parsed.path : null;
  } catch {
    return null;
  }
}

function saveProjectPath(projectPath) {
  const file = projectStateFile();
  if (!projectPath) {
    try { fs.unlinkSync(file); } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[desktop] failed to clear project state:', error);
    }
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ path: projectPath }, null, 2), 'utf8');
}

async function registerProjectDirectory(projectPath) {
  if (!serverPort) throw new Error('Local Codex server is not ready.');
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/desktop/projects/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-thoughtdag-desktop-token': desktopControlToken,
    },
    body: JSON.stringify({ path: projectPath }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Project registration failed (HTTP ${response.status}).`);
  const project = payload.project;
  if (!project || typeof project.id !== 'string' || typeof project.path !== 'string') {
    throw new Error('Local Codex server returned an invalid project registration.');
  }
  return { id: project.id, name: project.name || path.basename(project.path), path: project.path };
}

async function desktopServerJson(pathname) {
  if (!serverPort) throw new Error('Local Codex server is not ready.');
  const response = await fetch(`http://127.0.0.1:${serverPort}${pathname}`, {
    headers: {
      'x-thoughtdag-desktop-token': desktopControlToken,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Local Codex request failed (HTTP ${response.status}).`);
  }
  return payload;
}

async function restoreProjectDirectory() {
  currentProject = null;
  const savedPath = readSavedProjectPath();
  if (!savedPath) return;
  try {
    currentProject = await registerProjectDirectory(savedPath);
  } catch (error) {
    console.warn('[desktop] saved project is no longer available:', error);
    saveProjectPath(null);
  }
}

// The renderer origin is part of IndexedDB's identity. Moving to a fallback
// port silently presents a different (apparently empty) database, so desktop
// releases deliberately own one stable loopback origin instead.
function portIsAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function waitForFixedPort(port, tries = 16) {
  for (let i = 0; i < tries; i++) {
    if (await portIsAvailable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function waitReady(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/models`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function boot() {
  const port = FIXED_SERVER_PORT;
  serverPort = port;
  if (!(await waitForFixedPort(port))) {
    serverPort = null;
    dialog.showErrorBox(
      'ThoughtDAG Codex 无法启动',
      `固定本地端口 127.0.0.1:${port} 正在被其他程序占用。\n\n请关闭占用该端口的程序后重新启动。为了保护已有画布，桌面端不会再切换到其他端口。`,
    );
    app.quit();
    return;
  }
  serverProc = utilityProcess.fork(path.join(ROOT, 'server.mjs'), [], {
    cwd: ROOT, // .env resolves from the project root, same as `npm run server`
    // HOST is forced to loopback AFTER the spread: the desktop shell only ever
    // connects to 127.0.0.1, so the bundled server must never bind anything
    // else — not even if the user's ambient environment carries HOST=0.0.0.0.
    // Source builds also reject non-loopback binding: this is a local app.
    env: {
      ...process.env,
      PORT: String(port),
      SERVE_DIST: path.join(ROOT, 'dist'),
      HOST: '127.0.0.1',
      THOUGHTDAG_DESKTOP_CONTROL_TOKEN: desktopControlToken,
    },
    stdio: 'pipe',
    serviceName: 'thoughtdag-codex-server',
  });
  serverProc.stdout?.on('data', (d) => console.log('[server]', String(d).trimEnd()));
  serverProc.stderr?.on('data', (d) => console.error('[server]', String(d).trimEnd()));

  win = new BrowserWindow({
    width: 1500,
    height: 950,
    title: 'ThoughtDAG Codex',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  // splash first: the window exists from the first moment, breathing,
  // while the bundled server warms up behind it
  win.loadFile(path.join(__dirname, 'splash.html'));
  // external links belong to the system browser, not this window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The preload bridge can open a native directory picker, so never expose it
  // to a document that navigated away from this app's loopback origin.
  win.webContents.on('will-navigate', (event, url) => {
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* rejected below */ }
    if (origin === `http://127.0.0.1:${port}`) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const ready = await waitReady(port);
  if (!ready) {
    win.loadURL(`data:text/html,<pre>ThoughtDAG Codex server failed to start on port ${port}.\nCheck the terminal output.</pre>`);
    return;
  }
  await restoreProjectDirectory();
  // ?dv= identifies the desktop build to the web layer. Keep su=1 while the
  // fork has no trusted update feed so the web layer cannot fall back to the
  // original project's download endpoint.
  win.loadURL(`http://127.0.0.1:${port}/?dv=${encodeURIComponent(app.getVersion())}&su=1`);
}

function isLegacyStorageKey(key) {
  return key === 'thoughtdag'
    || key === 'thoughtdag:projects'
    || key.startsWith('thoughtdag:project:')
    || key.startsWith('att-content:');
}

function listenTemporaryServer(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeTemporaryServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Read the former fallback origin in an invisible, sandboxed renderer. The
// browser process owns IndexedDB, so loading that exact origin is the only
// reliable way to recover it. The returned snapshot is strictly allowlisted;
// directory handles, permissions and unrelated site data never cross IPC.
async function readLegacyStorageSnapshot() {
  const migrationServer = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
      'content-security-policy': "default-src 'none'",
    });
    response.end('<!doctype html><meta charset="utf-8"><title>ThoughtDAG storage migration</title>');
  });
  let legacyWindow = null;
  let listening = false;
  try {
    await listenTemporaryServer(migrationServer, LEGACY_STORAGE_PORT);
    listening = true;
    legacyWindow = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    await legacyWindow.loadURL(`http://127.0.0.1:${LEGACY_STORAGE_PORT}/`);
    const entries = await legacyWindow.webContents.executeJavaScript(`
      (async () => {
        const allowed = (key) => typeof key === 'string' && (
          key === 'thoughtdag' ||
          key === 'thoughtdag:projects' ||
          key.startsWith('thoughtdag:project:') ||
          key.startsWith('att-content:')
        );
        if (typeof indexedDB.databases === 'function') {
          const databases = await indexedDB.databases();
          if (!databases.some((database) => database.name === 'keyval-store')) return [];
        }
        return await new Promise((resolve, reject) => {
          const request = indexedDB.open('keyval-store');
          request.onerror = () => reject(request.error || new Error('Unable to open legacy IndexedDB.'));
          request.onblocked = () => reject(new Error('Legacy IndexedDB is blocked by another window.'));
          request.onsuccess = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('keyval')) {
              database.close();
              resolve([]);
              return;
            }
            const output = [];
            const transaction = database.transaction('keyval', 'readonly');
            const cursorRequest = transaction.objectStore('keyval').openCursor();
            cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Unable to read legacy IndexedDB.'));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              if (allowed(cursor.key)) output.push([cursor.key, cursor.value]);
              cursor.continue();
            };
            transaction.onerror = () => reject(transaction.error || new Error('Legacy IndexedDB transaction failed.'));
            transaction.oncomplete = () => {
              database.close();
              resolve(output);
            };
          };
        });
      })()
    `, true);
    if (!Array.isArray(entries)) throw new Error('Legacy storage returned an invalid snapshot.');
    return entries.filter((entry) => Array.isArray(entry)
      && typeof entry[0] === 'string'
      && isLegacyStorageKey(entry[0]));
  } finally {
    if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.destroy();
    if (listening) await closeTemporaryServer(migrationServer);
  }
}

// Automatic updates are deliberately disabled until this fork owns a signed,
// trusted release feed. Keep the bridge handlers present so older web bundles
// degrade safely without trying the original project's updater or download URL.
function sendUpdate(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('update:event', payload);
}

function setupDisabledUpdateChannel() {
  ipcMain.handle('update:check', (event) => {
    assertTrustedRenderer(event);
    sendUpdate({ kind: 'dev' });
  });
}

function setupProjectChannel() {
  ipcMain.handle('project:get', (event) => {
    assertTrustedRenderer(event);
    return currentProject;
  });
  ipcMain.handle('project:select', async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Codex 项目文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, project: currentProject };

    const next = await registerProjectDirectory(result.filePaths[0]);
    currentProject = next;
    saveProjectPath(next.path);
    // Keep earlier opaque registrations alive for already-started requests.
    // They disappear with this local server process and are no longer exposed
    // by the renderer once currentProject changes.
    return { canceled: false, project: next };
  });
  ipcMain.handle('project:clear', async (event) => {
    assertTrustedRenderer(event);
    currentProject = null;
    saveProjectPath(null);
    return null;
  });
}

function setupCodexHistoryChannel() {
  ipcMain.handle('codex-history:list', async (event, options = {}) => {
    assertTrustedRenderer(event);
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Invalid Codex history list options.');
    }
    const allowedOptions = new Set(['search', 'cursor', 'limit', 'archived']);
    if (Object.keys(options).some((key) => !allowedOptions.has(key))) {
      throw new Error('Invalid Codex history list options.');
    }
    const query = new URLSearchParams();
    if (typeof options.search === 'string' && options.search.trim()) {
      query.set('search', options.search.trim());
    }
    if (typeof options.cursor === 'string' && options.cursor) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.archived !== undefined) {
      if (typeof options.archived !== 'boolean') {
        throw new Error('Invalid Codex history archived filter.');
      }
      query.set('archived', String(options.archived));
    }
    return desktopServerJson(`/api/codex/threads?${query}`);
  });
  ipcMain.handle('codex-history:read', async (event, threadId) => {
    assertTrustedRenderer(event);
    if (typeof threadId !== 'string' || !threadId) {
      throw new Error('Invalid Codex thread id.');
    }
    return desktopServerJson(`/api/codex/threads/${encodeURIComponent(threadId)}`);
  });
}

function setupStorageMigrationChannel() {
  ipcMain.handle('storage:read-legacy-31174', async (event) => {
    assertTrustedRenderer(event);
    return readLegacyStorageSnapshot();
  });
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    setupDisabledUpdateChannel();
    setupProjectChannel();
    setupCodexHistoryChannel();
    setupStorageMigrationChannel();
    void boot();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
      return;
    }
    // macOS keeps the app resident. Stop the paired local server so Activate
    // can boot one clean replacement instead of leaking a utility process.
    serverProc?.kill();
    serverProc = null;
    serverPort = null;
    currentProject = null;
  });
  app.on('will-quit', () => { serverProc?.kill(); });
}
