// 22PM desktop shell (Electron main process).
// Serves the built app from inside the bundle, gives it a real project folder on disk, grants MIDI,
// places the output window on a chosen display, and flushes the autosave before quitting.
const { app, BrowserWindow, Menu, dialog, ipcMain, net, powerSaveBlocker, protocol, screen, session, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isMac = process.platform === 'darwin';
const DEV_URL = process.env.ELECTRON_DEV_URL || '';
const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const APP_URL = `${SCHEME}://22pm/index.html`;

// Linux is only used for automated tests; macOS has WebGPU on by default.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  if (process.env.TWENTYTWO_SOFTWARE_GPU) {
    app.commandLine.appendSwitch('enable-features', 'Vulkan');
    app.commandLine.appendSwitch('use-angle', 'swiftshader');
    app.commandLine.appendSwitch('use-vulkan', 'swiftshader');
  }
}
// Show-safe: never throttle the render loop because a window lost focus.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

if (process.env.TWENTYTWO_USER_DATA) app.setPath('userData', process.env.TWENTYTWO_USER_DATA);

// ---- settings and the project folder -------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const defaultProject = () => path.join(app.getPath('documents'), '22PM', 'Délután 10');
function projectRoot() {
  const root = process.env.TWENTYTWO_PROJECT || readSettings().projectRoot || defaultProject();
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function addRecent(root) {
  const recent = [root, ...(readSettings().recent || []).filter((r) => r !== root)].slice(0, 8);
  writeSettings({ projectRoot: root, recent });
}

/** Resolve a project-relative path, refusing anything that escapes the project folder. */
function inProject(rel) {
  const root = projectRoot();
  const full = path.resolve(root, String(rel));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path outside the project: ${rel}`);
  return full;
}

async function writeAtomic(full, data) {
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, typeof data === 'string' ? data : Buffer.from(data));
  await fsp.rename(tmp, full);
}

// ---- windows --------------------------------------------------------------------------------

let mainWindow = null;
let outputDisplayId = null;
let outputBlocker = null;
let flushed = false;

function createMainWindow() {
  const s = readSettings();
  const b = s.bounds && screen.getAllDisplays().some((d) => rectsOverlap(d.workArea, s.bounds)) ? s.bounds : { width: 1600, height: 1000 };
  mainWindow = new BrowserWindow({
    ...b,
    minWidth: 1100,
    minHeight: 700,
    title: '22PM',
    backgroundColor: '#0b0c0e',
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (s.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // TWENTYTWO_LITE: small demo scene, for tests on software GPUs (same as ?lite in the browser).
  mainWindow.loadURL((DEV_URL || APP_URL) + (process.env.TWENTYTWO_LITE ? '?lite' : ''));

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    writeSettings({ bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  // Before closing, let the page write its last autosave.
  mainWindow.on('close', (e) => {
    if (flushed || !mainWindow) return;
    e.preventDefault();
    saveBounds();
    const done = () => { flushed = true; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); };
    const timer = setTimeout(done, 3000);
    ipcMain.once('app:flushed', () => { clearTimeout(timer); done(); });
    mainWindow.webContents.send('app:flush');
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // The LED output window: frameless, black, fullscreen on the chosen display.
  mainWindow.webContents.setWindowOpenHandler(({ frameName, url }) => {
    if (frameName === '22pm-output') {
      const d = screen.getAllDisplays().find((x) => x.id === outputDisplayId) || screen.getPrimaryDisplay();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
          frame: false, backgroundColor: '#000000', title: '22PM output', autoHideMenuBar: true,
          fullscreenable: true, show: true,
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    // Links (docs, GitHub) open in the real browser.
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-create-window', (win, { frameName }) => {
    if (frameName !== '22pm-output') return;
    const d = screen.getAllDisplays().find((x) => x.id === outputDisplayId);
    const primary = screen.getPrimaryDisplay();
    // On another display, cover it completely. On the main display, stay a normal window so the UI stays reachable.
    if (d && d.id !== primary.id) {
      win.setBounds(d.bounds);
      if (isMac) win.setSimpleFullScreen(true); else win.setFullScreen(true);
    } else {
      win.setBounds({ x: primary.workArea.x + 60, y: primary.workArea.y + 60, width: 960, height: 540 });
    }
    outputBlocker = powerSaveBlocker.start('prevent-display-sleep');
    win.on('closed', () => {
      if (outputBlocker != null && powerSaveBlocker.isStarted(outputBlocker)) powerSaveBlocker.stop(outputBlocker);
      outputBlocker = null;
    });
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.split('?')[0] !== mainWindow.webContents.getURL().split('?')[0]) e.preventDefault();
  });
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// ---- menu -----------------------------------------------------------------------------------

function send(cmd) { mainWindow?.webContents.send('menu', cmd); }

function buildMenu() {
  const recent = (readSettings().recent || []).filter((r) => fs.existsSync(r));
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+O', click: () => chooseProject(false) },
        { label: 'New Project Folder…', accelerator: 'CmdOrCtrl+Shift+N', click: () => chooseProject(true) },
        { label: 'Open Recent', submenu: recent.length ? recent.map((r) => ({ label: r, click: () => switchProject(r) })) : [{ label: 'None', enabled: false }] },
        { type: 'separator' },
        { label: 'Show Project in Finder', click: () => shell.openPath(projectRoot()) },
        { label: 'Import Splat or Audio…', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
        { type: 'separator' },
        { label: 'Render…', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('render') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Undo/redo go to the page, which decides between text undo and project undo.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false, click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Train', accelerator: 'CmdOrCtrl+1', click: () => send('tab:train') },
        { label: 'Edit', accelerator: 'CmdOrCtrl+2', click: () => send('tab:edit') },
        { label: 'Animate', accelerator: 'CmdOrCtrl+3', click: () => send('tab:animate') },
        { label: 'Show', accelerator: 'CmdOrCtrl+4', click: () => send('tab:show') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        // Reload is deliberately not on a shortcut: an accidental Cmd+R mid-show would blank the output.
        { label: 'Reload', click: () => mainWindow?.reload() },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: () => send('shortcuts') },
        { label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/vikkrc/22PM') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function chooseProject(create) {
  if (!mainWindow) return;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: create ? 'New project folder' : 'Open project folder',
    message: create ? 'Choose or create an empty folder for the new project' : 'Choose a 22PM project folder (it contains show.json)',
    buttonLabel: create ? 'Create Here' : 'Open',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  const dir = r.filePaths[0];
  if (create && fs.existsSync(path.join(dir, 'show.json'))) {
    await dialog.showMessageBox(mainWindow, { type: 'warning', message: 'That folder already has a project in it.', detail: 'Choose an empty folder for a new project, or use Open Project Folder.' });
    return;
  }
  if (!create && !fs.existsSync(path.join(dir, 'show.json'))) {
    const c = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Start New Project Here', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'This folder has no 22PM project yet.', detail: 'Start a new project in it?',
    });
    if (c.response !== 0) return;
  }
  switchProject(dir);
}

function switchProject(dir) {
  if (!mainWindow) return;
  const go = () => { addRecent(dir); buildMenu(); flushed = false; mainWindow.webContents.reload(); };
  // Save the current project first.
  const timer = setTimeout(go, 3000);
  ipcMain.once('app:flushed', () => { clearTimeout(timer); go(); });
  mainWindow.webContents.send('app:flush');
}

/** Default folder for rendered video: the last one used, else Movies, else Documents. */
function exportDir() {
  const last = readSettings().lastExportDir;
  if (last && fs.existsSync(last)) return last;
  for (const name of ['movies', 'documents', 'home']) {
    try { const p = app.getPath(name); if (fs.existsSync(p)) return p; } catch { /* not on this system */ }
  }
  return projectRoot();
}

// ---- IPC ------------------------------------------------------------------------------------

// Render output can go anywhere the user picked in a save dialog, and nowhere else.
const allowed = new Map();
let nextHandle = 1;

function registerIpc() {
  ipcMain.handle('project:info', () => ({ root: projectRoot(), name: path.basename(projectRoot()), version: app.getVersion() }));
  ipcMain.handle('project:reveal', (_e, rel) => (rel ? shell.showItemInFolder(inProject(rel)) : shell.openPath(projectRoot())));
  ipcMain.handle('project:choose', (_e, create) => chooseProject(!!create));

  ipcMain.handle('fs:read', async (_e, rel) => {
    try { return new Uint8Array(await fsp.readFile(inProject(rel))); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  });
  ipcMain.handle('fs:write', (_e, rel, data) => writeAtomic(inProject(rel), data));
  ipcMain.handle('fs:remove', async (_e, rel) => { await fsp.rm(inProject(rel), { force: true }); });

  ipcMain.handle('dialog:save', async (_e, opts) => {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(exportDir(), opts.name), filters: opts.filters });
    if (r.canceled || !r.filePath) return null;
    writeSettings({ lastExportDir: path.dirname(r.filePath) });
    const handle = nextHandle++;
    allowed.set(handle, { kind: 'file', path: r.filePath, fd: await fsp.open(r.filePath, 'w') });
    return { handle, path: r.filePath };
  });
  ipcMain.handle('dialog:dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Folder for the PNG sequence', buttonLabel: 'Render Here', defaultPath: exportDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    writeSettings({ lastExportDir: r.filePaths[0] });
    const handle = nextHandle++;
    allowed.set(handle, { kind: 'dir', path: r.filePaths[0] });
    return { handle, path: r.filePaths[0] };
  });
  ipcMain.handle('out:write', async (_e, handle, data, position) => {
    const h = allowed.get(handle);
    if (!h || h.kind !== 'file') throw new Error('Unknown output file');
    const buf = Buffer.from(data);
    await h.fd.write(buf, 0, buf.length, position);
  });
  ipcMain.handle('out:writeFile', async (_e, handle, name, data) => {
    const h = allowed.get(handle);
    if (!h || h.kind !== 'dir') throw new Error('Unknown output folder');
    const base = path.basename(String(name));
    await fsp.writeFile(path.join(h.path, base), Buffer.from(data));
  });
  ipcMain.handle('out:close', async (_e, handle) => {
    const h = allowed.get(handle);
    allowed.delete(handle);
    if (h?.kind === 'file') await h.fd.close();
  });
  ipcMain.handle('out:reveal', (_e, p) => shell.showItemInFolder(p));

  ipcMain.handle('displays', () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id, primary: d.id === primary,
      label: `${d.label || `Display ${i + 1}`} · ${d.size.width}×${d.size.height}${d.id === primary ? ' (main)' : ''}`,
      width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor),
    }));
  });
  ipcMain.handle('output:display', (_e, id) => { outputDisplayId = id; });
}

// ---- boot -----------------------------------------------------------------------------------

app.whenReady().then(() => {
  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // Timecode comes in over MIDI (with SysEx for full-frame messages).
  const allow = new Set(['midi', 'midiSysex', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allow.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allow.has(perm));

  addRecent(projectRoot());
  registerIpc();
  buildMenu();
  createMainWindow();
  app.on('activate', () => { if (!mainWindow) { flushed = false; createMainWindow(); } });
});

app.on('window-all-closed', () => app.quit());
