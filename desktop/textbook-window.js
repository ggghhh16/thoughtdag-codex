const path = require('node:path');
const { createTextbookFiles } = require('./textbook-files');

function dockBounds(main, area, preferredWidth = 480) {
  const width = Math.min(preferredWidth, area.width);
  const height = Math.min(main.height, area.height);
  // When the display cannot fit both windows, keep the reader on-screen as
  // a normal independent window; the user can detach it or use the taskbar.
  return { x: Math.max(area.x, Math.min(main.x - width, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(main.y, area.y + area.height - height)), width, height };
}

function setupTextbookWindow({ app, BrowserWindow, ipcMain, dialog, screen, shell, getWindow, getPort, assertTrustedRenderer }) {
  const files = createTextbookFiles(path.join(app.getPath('userData'), 'textbook-folders.json'));
  let reader = null, docked = true, adjusting = false, width = 480;
  let readerReady = false, pendingReveal = null;
  const pending = new Map();
  function trusted(event, mainOnly = false) {
    if (mainOnly || !reader || event.sender !== reader.webContents) return assertTrustedRenderer(event);
    if (event.senderFrame !== reader.webContents.mainFrame || new URL(event.senderFrame.url).origin !== `http://127.0.0.1:${getPort()}`) throw new Error('Untrusted textbook window');
  }
  const send = (channel, value) => { if (reader && !reader.isDestroyed()) reader.webContents.send(channel, value); };
  function dock() {
    const main = getWindow();
    if (!reader || reader.isDestroyed() || !main || !docked) return;
    adjusting = true;
    reader.setBounds(dockBounds(main.getBounds(), screen.getDisplayMatching(main.getBounds()).workArea, width));
    adjusting = false;
  }
  function displayChanged() {
    if (!reader || reader.isDestroyed()) return;
    if (docked) { dock(); return; }
    const bounds = reader.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const visible = dockBounds({ ...bounds, x: bounds.x + bounds.width }, area, bounds.width);
    reader.setBounds(visible);
  }
  function open() {
    const main = getWindow();
    if (reader && !reader.isDestroyed()) { reader.show(); reader.focus(); return; }
    const area = screen.getDisplayMatching(main.getBounds()).workArea;
    if (main.getBounds().x - area.x < width && area.width >= 1180 && !main.isMaximized()) {
      main.setBounds({ x: area.x + width, y: area.y, width: area.width - width, height: area.height });
    }
    reader = new BrowserWindow({ ...dockBounds(main.getBounds(), area, width), minWidth: 320, minHeight: 320,
      title: 'Markdown 阅读', backgroundColor: '#0d1117',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    reader.removeMenu();
    reader.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
    reader.webContents.on('will-navigate', (event, url) => { event.preventDefault(); if (/^https?:/i.test(url)) void shell.openExternal(url); });
    reader.on('resize', () => { if (!adjusting) width = reader.getBounds().width; });
    reader.on('closed', () => { reader = null; for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ error: '阅读窗已关闭。' }); } pending.clear(); });
    readerReady = false;
    const cleanup = () => { main.off('move', dock); main.off('resize', dock); main.off('closed', close); screen.off('display-metrics-changed', displayChanged); screen.off('display-removed', displayChanged); };
    const close = () => { if (reader && !reader.isDestroyed()) reader.close(); };
    reader.once('closed', cleanup);
    main.on('move', dock); main.on('resize', dock); main.once('closed', close);
    screen.on('display-metrics-changed', displayChanged); screen.on('display-removed', displayChanged);
    void reader.loadURL(`http://127.0.0.1:${getPort()}/?textbook=1`);
  }
  ipcMain.handle('textbook:open', (event) => { trusted(event, true); open(); });
  ipcMain.handle('textbook:dock', (event, value) => { trusted(event); docked = !!value; dock(); return docked; });
  ipcMain.handle('textbook:files', async (event, request) => {
    trusted(event);
    switch (request.action) {
      case 'select': {
        const result = await dialog.showOpenDialog(reader || getWindow(), { title: request.lang === 'en' ? 'Choose a Markdown folder' : '选择 Markdown 文件夹', properties: ['openDirectory'] });
        return result.canceled ? null : files.register(result.filePaths[0], request.replaceId);
      }
      case 'list': return files.list(request.libraryId);
      case 'read': return files.read(request.libraryId, request.relativePath);
      case 'save': return files.save(request.libraryId, request.relativePath, request.version, request.content);
      case 'image': return files.image(request.libraryId, request.relativePath);
      default: throw new Error('Unknown textbook file operation');
    }
  });
  ipcMain.handle('textbook:command', (event, command) => {
    trusted(event);
    if (command.action === 'snapshot' && reader && event.sender === reader.webContents) readerReady = true;
    if (pending.has(command.id)) return { error: '此操作正在处理。' };
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(command.id); resolve({ error: '主窗口未响应，请重试。' }); }, 15000);
      pending.set(command.id, { resolve, timer, action: command.action });
      getWindow().webContents.send('textbook:command', command);
    });
  });
  ipcMain.on('textbook:reply', (event, { id, reply }) => {
    trusted(event, true);
    const job = pending.get(id); if (!job) return;
    clearTimeout(job.timer); pending.delete(id); job.resolve(reply);
    if (job.action === 'snapshot' && pendingReveal) { send('textbook:reveal', pendingReveal); pendingReveal = null; }
  });
  ipcMain.on('textbook:publish', (event, value) => { trusted(event, true); send('textbook:snapshot', value); });
  ipcMain.handle('textbook:reveal', (event, value) => {
    trusted(event, true); pendingReveal = value; open();
    if (readerReady && !reader.webContents.isLoading()) { send('textbook:reveal', value); pendingReveal = null; }
  });
}
module.exports = { setupTextbookWindow, dockBounds };
