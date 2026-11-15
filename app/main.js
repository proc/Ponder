const { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const ai = require('./ai');

const exe = process.platform === 'win32' ? '.exe' : '';
const binDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', 'bin');

let win = null;

// The app was called Board before. Its settings (engines, Lichess, the game
// database, and what the window remembers) are brought along the first
// time Ponder starts; the old folder is left as it was.
(function bringSettingsAlong() {
  try {
    const now = app.getPath('userData');
    const old = path.join(app.getPath('appData'), 'board');
    const files = ['engines.json', 'lichess.json', 'database.json'];
    if (path.resolve(old).toLowerCase() === path.resolve(now).toLowerCase() || !fs.existsSync(old)) return;
    if (files.some((f) => fs.existsSync(path.join(now, f)))) return;
    fs.mkdirSync(now, { recursive: true });
    for (const f of files) {
      if (fs.existsSync(path.join(old, f))) fs.copyFileSync(path.join(old, f), path.join(now, f));
    }
    const storage = path.join(old, 'Local Storage');
    if (fs.existsSync(storage) && !fs.existsSync(path.join(now, 'Local Storage'))) {
      fs.cpSync(storage, path.join(now, 'Local Storage'), { recursive: true });
    }
  } catch { /* start with fresh settings */ }
})();

// Where games and tournaments are saved unless another place is chosen:
// Documents/Ponder, or Documents/Board when that is where they already are.
function documentsDir() {
  const docs = app.getPath('documents');
  const now = path.join(docs, 'Ponder');
  const old = path.join(docs, 'Board');
  return !fs.existsSync(now) && fs.existsSync(old) ? old : now;
}

// ---------------------------------------------------------------------------
// Go backend: one child process, JSON lines over stdin/stdout.
// ---------------------------------------------------------------------------
const backend = {
  proc: null,
  nextId: 1,
  pending: new Map(),

  start() {
    const bin = path.join(binDir, 'backend' + exe);
    if (!fs.existsSync(bin)) {
      dialog.showErrorBox('Backend not built',
        `Could not find ${bin}.\n\nRun "npm run build:backend" (requires Go) and start again.`);
      app.exit(1);
      return;
    }
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.event) {
        if (win && !win.isDestroyed()) win.webContents.send('backend-event', msg.event, msg.data);
      } else if (this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) resolve(msg.data ?? null);
        else reject(new Error(msg.error || 'backend error'));
      }
    });
    this.proc.on('exit', () => {
      this.proc = null;
      for (const { reject } of this.pending.values()) reject(new Error('The backend stopped unexpectedly'));
      this.pending.clear();
    });
    this.proc.stdin.on('error', () => {});
  },

  request(cmd, args) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('The backend is not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args: args ?? {} }) + '\n');
    });
  },

  // Closing stdin makes the backend quit its engines and exit.
  stop() {
    if (this.proc) this.proc.stdin.end();
  },
};

// ---------------------------------------------------------------------------
// Engine registry, saved in the user's app-data folder.
// ---------------------------------------------------------------------------
const engineFile = () => path.join(app.getPath('userData'), 'engines.json');
// Engines that ship with the app. Their paths follow the app, so they are
// never stored.
const BUILTIN_ENGINES = [
  { id: 'builtin-basic', name: 'Ponder Basic (built-in)', file: 'basicengine' },
  { id: 'builtin-random', name: 'Random Mover (built-in)', file: 'randomengine' },
];
const builtinPath = (id) => path.join(binDir, (BUILTIN_ENGINES.find((b) => b.id === id)?.file ?? 'randomengine') + exe);

function loadEngines() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(engineFile(), 'utf8')); } catch { /* first run */ }
  if (!Array.isArray(list)) list = [];
  for (const b of [...BUILTIN_ENGINES].reverse()) {
    if (!list.some((e) => e.id === b.id)) list.unshift({ id: b.id, name: b.name, builtin: true, args: [], options: {} });
  }
  // The built-in engine moves with the app, so its path is never stored.
  return list.map((e) => (e.builtin ? { ...e, path: builtinPath(e.id) } : e));
}

function saveEngines(list) {
  fs.mkdirSync(path.dirname(engineFile()), { recursive: true });
  fs.writeFileSync(engineFile(), JSON.stringify(list, null, 2));
  return list;
}


ipcMain.handle('backend', (_e, cmd, args) => backend.request(String(cmd), args));
ipcMain.handle('engines:list', () => loadEngines());

ipcMain.handle('engines:add', async () => {
  const filters = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [];
  const pick = await dialog.showOpenDialog(win, {
    title: 'Choose a UCI engine', properties: ['openFile'], filters,
  });
  if (pick.canceled || !pick.filePaths[0]) return null;
  const file = pick.filePaths[0];
  // An engine that needs command-line options to speak UCI is still added,
  // so its options can be set; the error is passed on.
  let name = path.basename(file).replace(/\.exe$/i, '');
  let error = '';
  try {
    name = (await backend.request('probe', { path: file })).name || name;
  } catch (err) {
    error = err.message;
  }
  const list = loadEngines();
  const engine = { id: crypto.randomUUID(), name, path: file, args: [], options: {} };
  list.push(engine);
  saveEngines(list);
  return { engine, error };
});

ipcMain.handle('engines:remove', (_e, id) =>
  saveEngines(loadEngines().filter((e) => e.id !== id || e.builtin)));

ipcMain.handle('engines:update', (_e, id, patch) => {
  const list = loadEngines();
  const engine = list.find((e) => e.id === id);
  if (!engine) throw new Error('Unknown engine');
  if (typeof patch?.name === 'string' && patch.name.trim()) engine.name = patch.name.trim();
  if (Array.isArray(patch?.args) && !engine.builtin) engine.args = patch.args.map(String);
  if (patch?.options && typeof patch.options === 'object') {
    engine.options = Object.fromEntries(
      Object.entries(patch.options).map(([k, v]) => [String(k), String(v)]));
  }
  return saveEngines(list);
});

ipcMain.handle('engines:probe', (_e, id) => {
  const engine = loadEngines().find((e) => e.id === id);
  if (!engine) throw new Error('Unknown engine');
  return backend.request('probe', { path: engine.path, args: engine.args });
});

// A file or folder for an engine option (tablebases, network, book, log).
ipcMain.handle('engines:choosePath', async (_e, kind, title) => {
  const pick = await dialog.showOpenDialog(win, {
    title: `Choose ${kind === 'folder' ? 'a folder' : 'a file'} for ${title ?? 'the option'}`,
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
  });
  return pick.canceled ? null : pick.filePaths[0] ?? null;
});

// How busy the computer's processors are: the share of time they were not
// idle since the last time this was asked (0 to 1), over all of them.
let cpuBefore = null;
function cpuTimes() {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}
ipcMain.handle('system:cpu', () => {
  const now = cpuTimes();
  const before = cpuBefore;
  cpuBefore = now;
  const cores = os.cpus().length;
  if (!before || now.total <= before.total) return { load: null, cores };
  const load = 1 - (now.idle - before.idle) / (now.total - before.total);
  return { load: Math.min(1, Math.max(0, load)), cores };
});

// Piece themes: each folder in svg/ holding all twelve <color>-<name>.svg
// files is a theme named after the folder, e.g. svg/minimalist/white-king.svg.
const svgDir = app.isPackaged
  ? path.join(process.resourcesPath, 'svg')
  : path.join(__dirname, '..', 'svg');
const PIECE_FILE = /^(white|black)-(king|queen|rook|bishop|knight|pawn)\.svg$/;

ipcMain.handle('themes:load', () => {
  const themes = {};
  let dirs = [];
  try { dirs = fs.readdirSync(svgDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* none */ }
  for (const dir of dirs) {
    const pieces = {};
    for (const file of fs.readdirSync(path.join(svgDir, dir.name))) {
      if (PIECE_FILE.test(file)) pieces[file.slice(0, -4)] = fs.readFileSync(path.join(svgDir, dir.name, file), 'utf8');
    }
    if (Object.keys(pieces).length === 12) themes[dir.name] = pieces;
    else console.warn(`svg/${dir.name}: needs all 12 piece files, found ${Object.keys(pieces).length}; skipped`);
  }
  return themes;
});

// Save a PGN through the Save dialog. Returns the path, or null if cancelled.
let lastPgnDir = null;
ipcMain.handle('pgn:save', async (_e, pgn) => {
  pgn = String(pgn);
  const tag = (name) => pgn.match(new RegExp(`^\\[${name} "((?:[^"\\\\]|\\\\.)*)"\\]`, 'm'))?.[1].replace(/\\(.)/g, '$1') ?? '';
  // e.g. "Stockfish 17 vs You 2026-11-11.pgn"
  const date = tag('Date').replace(/\./g, '-').replace(/\?/g, '').replace(/-+$/, '');
  const base = `${tag('White') || 'White'} vs ${tag('Black') || 'Black'}${date ? ' ' + date : ''}`
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export PGN',
    defaultPath: path.join(lastPgnDir ?? app.getPath('documents'), base + '.pgn'),
    filters: [{ name: 'PGN', extensions: ['pgn'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  let file = result.filePath;
  if (!path.extname(file)) file += '.pgn';
  fs.writeFileSync(file, pgn.endsWith('\n') ? pgn : pgn + '\n');
  lastPgnDir = path.dirname(file);
  return file;
});

// Choose a PGN file in the Open dialog. Returns { name, path }, or null. The
// Go backend reads the file itself, a game at a time, so there is no size limit.
ipcMain.handle('pgn:open', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open PGN',
    defaultPath: lastPgnDir ?? app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: 'PGN', extensions: ['pgn'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  lastPgnDir = path.dirname(file);
  return { name: path.basename(file), path: file };
});

// Where to write games exported from the Games list. Returns the path, or
// null. The Go backend writes the file.
ipcMain.handle('pgn:exportPath', async (_e, name) => {
  const base = String(name || 'Games').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\.pgn$/i, '').slice(0, 120) || 'Games';
  const result = await dialog.showSaveDialog(win, {
    title: 'Export games',
    defaultPath: path.join(lastPgnDir ?? app.getPath('documents'), base + '.pgn'),
    filters: [{ name: 'PGN', extensions: ['pgn'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  let file = result.filePath;
  if (!path.extname(file)) file += '.pgn';
  lastPgnDir = path.dirname(file);
  return file;
});

// Test positions: an EPD file, read whole (suites are small).
ipcMain.handle('epd:open', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open test positions (EPD)',
    defaultPath: lastPgnDir ?? app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: 'EPD', extensions: ['epd', 'fen', 'txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('That file is too large for a set of test positions (over 20 MB).');
  return { name: path.basename(file), path: file, text: fs.readFileSync(file, 'utf8') };
});

ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

// ---------------------------------------------------------------------------
// The PGN database: finished games can be added to a PGN file. Settings in
// database.json; the backend appends the games.
// ---------------------------------------------------------------------------
const databaseFile = () => path.join(app.getPath('userData'), 'database.json');
const DATABASE_DEFAULTS = () => ({
  enabled: false,
  path: path.join(documentsDir(), 'Games.pgn'),
  local: true, lichess: true, watched: false,
});

function loadDatabase() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(databaseFile(), 'utf8')); } catch { /* first run */ }
  return { ...DATABASE_DEFAULTS(), ...saved };
}

function applyDatabase(db) {
  return backend.request('setDatabase', {
    path: db.enabled ? db.path : '', local: db.local, lichess: db.lichess, watched: db.watched,
  });
}

ipcMain.handle('database:settings', () => {
  const db = loadDatabase();
  return { ...db, exists: fs.existsSync(db.path) };
});

ipcMain.handle('database:save', async (_e, patch) => {
  const db = loadDatabase();
  for (const k of ['enabled', 'local', 'lichess', 'watched']) if (typeof patch?.[k] === 'boolean') db[k] = patch[k];
  if (typeof patch?.path === 'string' && patch.path.trim()) db.path = path.resolve(patch.path.trim());
  fs.mkdirSync(path.dirname(databaseFile()), { recursive: true });
  fs.writeFileSync(databaseFile(), JSON.stringify(db, null, 2));
  await applyDatabase(db);
  return { ...db, exists: fs.existsSync(db.path) };
});

// Tournaments: where games are saved, and openings files.
const tournamentDir = () => path.join(documentsDir(), 'Tournaments');
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

ipcMain.handle('tournament:defaultPgn', (_e, a, b) => {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  // A match is named after its two engines; the other formats after themselves.
  return path.join(tournamentDir(), `${b ? `${safeName(a)} vs ${safeName(b)}` : safeName(a)} ${stamp}.pgn`);
});

ipcMain.handle('tournament:choosePgn', async (_e, current) => {
  const result = await dialog.showSaveDialog(win, {
    title: 'Save tournament games',
    buttonLabel: 'Use this file',
    defaultPath: current || tournamentDir(),
    filters: [{ name: 'PGN', extensions: ['pgn'] }],
    properties: ['createDirectory'],
  });
  if (result.canceled || !result.filePath) return null;
  return path.extname(result.filePath) ? result.filePath : result.filePath + '.pgn';
});

// The match report: one self-contained HTML file next to the games file,
// opened in its own window.
const reportTemplate = () => fs.readFileSync(path.join(__dirname, 'report', 'report.html'), 'utf8');

function themePiecesAsDataUrls(theme) {
  const out = {};
  try {
    const dir = path.join(svgDir, path.basename(String(theme || 'minimalist')));
    for (const file of fs.readdirSync(dir)) {
      if (PIECE_FILE.test(file)) {
        out[file.slice(0, -4)] = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(dir, file)).toString('base64');
      }
    }
  } catch { /* the report falls back to piece symbols */ }
  return out;
}

// JSON inside <script>: nothing in it may close the element.
const scriptJSON = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const reportFiles = new Map(); // report window → its file

function showReport(file) {
  const w = new BrowserWindow({
    width: 1400, height: 950, title: 'Match report', backgroundColor: '#f3f2ee', autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: path.join(__dirname, 'report-preload.js'),
    },
  });
  const id = w.webContents.id;
  reportFiles.set(id, file);
  w.on('closed', () => reportFiles.delete(id));
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.loadFile(file);
  return w;
}

// Where reports were last saved.
let lastReportDir = null;

async function saveReportAs(file, ext) {
  const base = path.basename(file, '.html') + (ext === 'pdf' ? '.pdf' : '.html');
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() ?? win, {
    title: ext === 'pdf' ? 'Save the report as PDF' : 'Save the report',
    defaultPath: path.join(lastReportDir ?? app.getPath('documents'), base),
    filters: ext === 'pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Web page', extensions: ['html'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return null;
  let out = result.filePath;
  if (!path.extname(out)) out += ext === 'pdf' ? '.pdf' : '.html';
  lastReportDir = path.dirname(out);
  return out;
}

// From the report window: save its page, or a PDF of it.
ipcMain.handle('report:save', async (e) => {
  const file = reportFiles.get(e.sender.id);
  if (!file) throw new Error('This report has no file');
  const out = await saveReportAs(file, 'html');
  if (!out) return null;
  if (path.resolve(out) !== path.resolve(file)) fs.copyFileSync(file, out);
  return out;
});
ipcMain.handle('report:pdf', async (e) => {
  const file = reportFiles.get(e.sender.id);
  if (!file) throw new Error('This report has no file');
  const out = await saveReportAs(file, 'pdf');
  if (!out) return null;
  const pdf = await e.sender.printToPDF({ printBackground: true, landscape: true, pageSize: 'A4', margins: { marginType: 'default' } });
  fs.writeFileSync(out, pdf);
  return out;
});
ipcMain.handle('report:show', (e, file) => shell.showItemInFolder(String(file)));

// From the Tournament tab: save the report made last.
ipcMain.handle('tournament:saveReport', async (_e, file) => {
  if (!String(file).endsWith('.html') || !fs.existsSync(file)) throw new Error('Make the report first');
  const out = await saveReportAs(file, 'html');
  if (!out) return null;
  if (path.resolve(out) !== path.resolve(file)) fs.copyFileSync(file, out);
  return out;
});

ipcMain.handle('tournament:report', async (_e, theme) => {
  const data = await backend.request('tournamentReport');
  const names = data.status.names;
  const stamp = new Date(data.started).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  const dir = data.status.pgnPath ? path.dirname(data.status.pgnPath) : tournamentDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(names[0])} vs ${safeName(names[1])} ${stamp} report.html`);
  const html = reportTemplate()
    .replace('__DATA__', () => scriptJSON(data))
    .replace('__PIECES__', () => scriptJSON(themePiecesAsDataUrls(theme)));
  fs.writeFileSync(file, html);
  showReport(file);
  return file;
});

ipcMain.handle('tournament:openReport', (_e, file) => {
  if (!String(file).endsWith('.html') || !fs.existsSync(file)) throw new Error('The report file is gone');
  showReport(file);
});
ipcMain.handle('tournament:showFile', (_e, file) => shell.showItemInFolder(String(file)));

ipcMain.handle('tournament:chooseOpenings', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Openings for the tournament',
    filters: [{ name: 'Openings (EPD, PGN)', extensions: ['epd', 'pgn'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Choose the database file. An existing file is added to, never replaced.
ipcMain.handle('database:choose', async () => {
  const db = loadDatabase();
  const result = await dialog.showSaveDialog(win, {
    title: 'PGN database for finished games',
    buttonLabel: 'Use this file',
    message: 'Finished games are added to the end of this file; an existing file is kept.',
    defaultPath: db.path,
    filters: [{ name: 'PGN', extensions: ['pgn'] }],
    properties: ['createDirectory'],
  });
  if (result.canceled || !result.filePath) return null;
  let file = result.filePath;
  if (!path.extname(file)) file += '.pgn';
  return file;
});

// Links to Lichess (games, challenges, token page) open in the browser.
ipcMain.handle('open-external', (_e, url) => {
  const u = new URL(String(url));
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links can be opened');
  return shell.openExternal(u.toString());
});

// ---------------------------------------------------------------------------
// Lichess: settings in lichess.json. The API token is encrypted with the
// system keychain (safeStorage) and never sent back to the window.
// ---------------------------------------------------------------------------
const lichessFile = () => path.join(app.getPath('userData'), 'lichess.json');
const LICHESS_DEFAULTS = {
  baseUrl: 'https://lichess.org',
  engineId: 'builtin-basic',
  autoConnect: false,
  // Let the engine think on its opponent's time (UCI pondering).
  ponder: true,
  // Seconds a challenge you (or your engine) sent waits for an answer
  // before it is withdrawn; 0: it waits until answered or cancelled.
  challengeTimeout: 30,
  policy: {
    rated: true, casual: true, humans: true, bots: true,
    minMinutes: 0, maxMinutes: 0, maxGames: 1,
    speeds: { ultraBullet: true, bullet: true, blitz: true, rapid: true, classical: true },
    minIncrement: 0, maxIncrement: 0, minRating: 0, maxRating: 0, noFromPosition: false,
  },
  // What the engine says in the chat of its games ({me}, {opponent}: the
  // names). An empty message is not sent.
  // When the engine offers or accepts a draw (as lichess-bot's
  // offer_draw_* options): its score within `score` centipawns of zero for
  // `moves` of its moves in a row with at most `pieces` pieces on the board,
  // or a position the Lichess tablebase calls a draw.
  draw: { enabled: true, score: 0, egtbZero: true, moves: 10, pieces: 10 },
  greeting: {
    hello: "Hi! I'm {me}. Good luck!",
    goodbye: 'Good game!',
    helloSpectators: "Hi! I'm {me}.",
    goodbyeSpectators: 'Thanks for watching!',
  },
};
const GREETING_MAX = 140;

function loadLichess() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(lichessFile(), 'utf8')); } catch { /* first run */ }
  return {
    ...LICHESS_DEFAULTS, ...saved,
    policy: { ...LICHESS_DEFAULTS.policy, ...saved.policy },
    greeting: { ...LICHESS_DEFAULTS.greeting, ...saved.greeting },
    draw: { ...LICHESS_DEFAULTS.draw, ...saved.draw },
  };
}

function saveLichess(settings) {
  fs.mkdirSync(path.dirname(lichessFile()), { recursive: true });
  fs.writeFileSync(lichessFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

// Electron's safeStorage, through its asynchronous calls (the synchronous
// ones are deprecated, and gone in Electron 46). An Electron from before the
// asynchronous calls existed still gets the old ones.
async function canEncrypt() {
  try {
    if (safeStorage.isAsyncEncryptionAvailable) return await safeStorage.isAsyncEncryptionAvailable();
    return safeStorage.isEncryptionAvailable();
  } catch { return false; }
}

async function encryptSecret(text) {
  const buf = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text);
  return buf.toString('base64');
}

// Reads the secret kept encrypted in settings[key] ('' if it cannot be
// read). When the system's key has changed, it is stored again under the
// new one.
async function decryptSecret(settings, key) {
  try {
    const buf = Buffer.from(settings[key], 'base64');
    if (!safeStorage.decryptStringAsync) return safeStorage.decryptString(buf);
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf);
    if (shouldReEncrypt && result) {
      try {
        const again = await encryptSecret(result);
        const now = loadLichess();
        if (now[key] === settings[key]) { now[key] = again; saveLichess(now); }
        settings[key] = again;
      } catch { /* keep the old one */ }
    }
    return result;
  } catch { return ''; }
}

async function lichessToken(settings) {
  if (settings.token) return decryptSecret(settings, 'token');
  return settings.plainToken ?? '';
}

// The person's own account (Board API), signed in with Lichess (OAuth) or
// with a pasted token; kept like the bot's token.
async function accountToken(settings) {
  if (settings.accountToken) return decryptSecret(settings, 'accountToken');
  return settings.plainAccountToken ?? '';
}

// Either token: yours, or else the bot's.
const anyToken = async (settings) => (await accountToken(settings)) || lichessToken(settings);

async function setAccountToken(settings, token) {
  delete settings.accountToken;
  delete settings.plainAccountToken;
  token = (token ?? '').trim();
  if (token && await canEncrypt()) settings.accountToken = await encryptSecret(token);
  else if (token) settings.plainAccountToken = token;
}

// What the window may see: everything but the tokens.
async function publicLichess(settings) {
  const { token, plainToken, accountToken: _a, plainAccountToken: _p, ...rest } = settings;
  return {
    ...rest,
    greetingDefaults: LICHESS_DEFAULTS.greeting,
    drawDefaults: LICHESS_DEFAULTS.draw,
    hasToken: Boolean(await lichessToken(settings)),
    hasAccount: Boolean(await accountToken(settings)),
    encrypted: !plainToken,
    canEncrypt: await canEncrypt(),
  };
}

const challengeTimeout = (settings) => (Number.isFinite(settings.challengeTimeout) ? settings.challengeTimeout : LICHESS_DEFAULTS.challengeTimeout);

function lichessEngine(settings) {
  const list = loadEngines();
  const e = list.find((x) => x.id === settings.engineId) ?? list[0];
  return { name: e.name, path: e.path, args: e.args ?? [], options: e.options ?? {} };
}

ipcMain.handle('lichess:settings', () => publicLichess(loadLichess()));

// ---------------------------------------------------------------------------
// AI: the provider (OpenAI, Claude, Google AI, or an OpenAI-compatible
// server, a local one by default), and for each its model and key, so that
// switching between them keeps both. The local server's address, model and
// key are kept at the top level (as before there were providers), the
// others under "providers". Keys are encrypted with the system keychain
// when there is one, and never sent back to the window. Nothing is sent
// until AI annotate, the chat or the live commentary asks.
// ---------------------------------------------------------------------------
const aiFile = () => path.join(app.getPath('userData'), 'ai.json');
function loadAi() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(aiFile(), 'utf8')) ?? {}; } catch { /* first run */ }
  return { ...ai.DEFAULTS, ...saved };
}
function saveAi(settings) {
  fs.mkdirSync(path.dirname(aiFile()), { recursive: true });
  fs.writeFileSync(aiFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}
// The chosen provider's part of the settings: { model, key, plainKey }.
function aiSlot(s, provider = s.provider) {
  if (!ai.PROVIDERS[provider] || provider === 'local') return s;
  s.providers ??= {};
  s.providers[provider] ??= {};
  return s.providers[provider];
}
const aiProvider = (s) => (ai.PROVIDERS[s.provider] ? s.provider : 'local');
// What ai.js is given: the provider, the address, the model and the key.
async function aiRequest(s) {
  const slot = aiSlot(s, aiProvider(s));
  return { provider: aiProvider(s), baseUrl: s.baseUrl, model: slot.model ?? '', key: await aiKey(slot) };
}
async function aiKey(settings) {
  if (settings.plainKey) return settings.plainKey;
  if (!settings.key) return '';
  try {
    const buf = Buffer.from(settings.key, 'base64');
    if (safeStorage.decryptStringAsync) return (await safeStorage.decryptStringAsync(buf)).result ?? '';
    return safeStorage.decryptString(buf);
  } catch { return ''; }
}
const publicAi = (s) => {
  const provider = aiProvider(s);
  const slot = aiSlot(s, provider);
  return {
    provider, baseUrl: s.baseUrl, model: slot.model ?? '', hasKey: Boolean(slot.key || slot.plainKey), defaultUrl: ai.DEFAULTS.baseUrl,
    providers: Object.entries(ai.PROVIDERS).map(([id, p]) => ({
      id, name: p.name, needsKey: p.needsKey, modelHint: p.modelHint ?? '', defaultModel: p.defaultModel ?? '',
      hasKey: Boolean(aiSlot(s, id).key || aiSlot(s, id).plainKey),
    })),
  };
};

ipcMain.handle('ai:settings', () => publicAi(loadAi()));
ipcMain.handle('ai:save', async (_e, patch) => {
  const s = loadAi();
  if (typeof patch?.provider === 'string' && ai.PROVIDERS[patch.provider]) s.provider = patch.provider;
  if (typeof patch?.baseUrl === 'string') s.baseUrl = ai.normalizeBase(patch.baseUrl);
  // The model and key are the chosen provider's.
  const slot = aiSlot(s, aiProvider(s));
  if (typeof patch?.model === 'string') slot.model = patch.model.trim();
  if (typeof patch?.key === 'string') {
    delete slot.key;
    delete slot.plainKey;
    const key = patch.key.trim();
    if (key && await canEncrypt()) slot.key = await encryptSecret(key);
    else if (key) slot.plainKey = key;
  }
  saveAi(s);
  return publicAi(s);
});

// The request in flight. It has no time limit: a local model may take as
// long as it needs, and the request ends when it answers or Stop is pressed.
let aiRun = null;
ipcMain.handle('ai:models', async () => {
  const s = loadAi();
  return ai.listModels(await aiRequest(s), { signal: AbortSignal.timeout(15000) });
});
ipcMain.handle('ai:annotate', async (_e, game) => {
  const s = loadAi();
  aiRun?.abort();
  const run = aiRun = new AbortController();
  try {
    return await ai.annotate(await aiRequest(s), game ?? {}, { signal: run.signal });
  } finally {
    if (aiRun === run) aiRun = null;
  }
});
ipcMain.handle('ai:cancel', () => { aiRun?.abort(); });

// The AI tab's chat: the answer is streamed to the window as "aiChat"
// events ({ id, delta }) and returned whole. One answer at a time.
// The chat and the live commentary each have a channel of their own, so
// one does not cut the other off: a new request ends the one before it on
// the same channel only.
const aiChatRuns = new Map(); // channel -> its request in flight
ipcMain.handle('ai:chat', async (_e, id, messages, channel = 'chat') => {
  const s = loadAi();
  channel = String(channel);
  aiChatRuns.get(channel)?.abort();
  const run = new AbortController();
  aiChatRuns.set(channel, run);
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => ['system', 'user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  try {
    return await ai.chat(await aiRequest(s), list, {
      signal: run.signal,
      onDelta: (delta) => { if (win && !win.isDestroyed()) win.webContents.send('backend-event', 'aiChat', { id, delta }); },
      onThinking: (thinking) => { if (win && !win.isDestroyed()) win.webContents.send('backend-event', 'aiChat', { id, thinking }); },
    });
  } finally {
    if (aiChatRuns.get(channel) === run) aiChatRuns.delete(channel);
  }
});
ipcMain.handle('ai:chatCancel', (_e, channel = 'chat') => { aiChatRuns.get(String(channel))?.abort(); });

ipcMain.handle('lichess:save', async (_e, patch) => {
  const settings = loadLichess();
  patch = patch ?? {};
  if (typeof patch.baseUrl === 'string') {
    const url = patch.baseUrl.trim().replace(/\/+$/, '') || LICHESS_DEFAULTS.baseUrl;
    if (!/^https?:\/\//.test(url)) throw new Error('The server address must start with https://');
    settings.baseUrl = url;
  }
  if (typeof patch.engineId === 'string') settings.engineId = patch.engineId;
  if (typeof patch.autoConnect === 'boolean') settings.autoConnect = patch.autoConnect;
  if (typeof patch.ponder === 'boolean') settings.ponder = patch.ponder;
  if ('challengeTimeout' in patch) settings.challengeTimeout = Math.max(0, Math.min(3600, Math.round(Number(patch.challengeTimeout) || 0)));
  if (patch.policy && typeof patch.policy === 'object') {
    const p = { ...settings.policy };
    for (const k of ['rated', 'casual', 'humans', 'bots']) if (k in patch.policy) p[k] = Boolean(patch.policy[k]);
    for (const k of ['minMinutes', 'maxMinutes']) if (k in patch.policy) p[k] = Math.max(0, Number(patch.policy[k]) || 0);
    for (const k of ['minIncrement', 'maxIncrement', 'minRating', 'maxRating']) if (k in patch.policy) p[k] = Math.max(0, Math.round(Number(patch.policy[k]) || 0));
    if ('noFromPosition' in patch.policy) p.noFromPosition = Boolean(patch.policy.noFromPosition);
    if (patch.policy.speeds && typeof patch.policy.speeds === 'object') {
      p.speeds = { ...LICHESS_DEFAULTS.policy.speeds, ...p.speeds };
      for (const k of Object.keys(LICHESS_DEFAULTS.policy.speeds)) if (k in patch.policy.speeds) p.speeds[k] = Boolean(patch.policy.speeds[k]);
    }
    if ('maxGames' in patch.policy) p.maxGames = Math.min(8, Math.max(1, Math.round(Number(patch.policy.maxGames) || 1)));
    settings.policy = p;
  }
  if (patch.draw && typeof patch.draw === 'object') {
    const d = { ...settings.draw };
    const whole = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) && v !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback);
    for (const k of ['enabled', 'egtbZero']) if (k in patch.draw) d[k] = Boolean(patch.draw[k]);
    if ('score' in patch.draw) d.score = whole(patch.draw.score, 0, 1000, d.score);
    if ('moves' in patch.draw) d.moves = whole(patch.draw.moves, 1, 100, d.moves);
    if ('pieces' in patch.draw) d.pieces = whole(patch.draw.pieces, 2, 32, d.pieces);
    settings.draw = d;
  }
  if (patch.greeting && typeof patch.greeting === 'object') {
    const g = { ...settings.greeting };
    for (const k of Object.keys(LICHESS_DEFAULTS.greeting)) {
      if (typeof patch.greeting[k] === 'string') g[k] = [...patch.greeting[k].replace(/\s+/g, ' ').trim()].slice(0, GREETING_MAX).join('');
    }
    settings.greeting = g;
  }
  if (typeof patch.token === 'string') {
    const token = patch.token.trim();
    delete settings.token;
    delete settings.plainToken;
    if (token && await canEncrypt()) settings.token = await encryptSecret(token);
    else if (token) settings.plainToken = token;
  }
  if (typeof patch.accountToken === 'string') await setAccountToken(settings, patch.accountToken);
  saveLichess(settings);
  return publicLichess(settings);
});

// Sign in with Lichess: OAuth with PKCE, which needs no registered app. The
// browser comes back to a one-off local server with a code, swapped for a
// token that may play games (board:play) and send and answer challenges.
const OAUTH_CLIENT = 'ponder-chess-gui';
const OAUTH_SCOPES = 'board:play challenge:read challenge:write';
let signIn = null; // the sign-in in progress: { server, reject }

ipcMain.handle('lichess:signIn', async () => {
  signIn?.cancel?.();
  const settings = loadLichess();
  const base = (settings.baseUrl || LICHESS_DEFAULTS.baseUrl).replace(/\/+$/, '');
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const http = require('http');
  const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <body style="font:16px system-ui;margin:4rem auto;max-width:30rem;text-align:center;color:#2b2b2b">
    <h2>${title}</h2><p>${text}</p></body>`;
  let redirect = '';
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, redirect);
      if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const err = url.searchParams.get('error');
      const got = url.searchParams.get('code');
      const ok = !err && got && url.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? page('Signed in to Ponder', 'You can close this tab and go back to Ponder.')
        : page('Not signed in', err === 'access_denied' ? 'The sign-in was cancelled.' : 'Something went wrong; try again from Ponder.'));
      done();
      if (ok) resolve(got);
      else reject(new Error(err === 'access_denied' ? 'The sign-in was cancelled.' : 'Lichess did not sign you in.'));
    });
    const timer = setTimeout(() => { done(); reject(new Error('The sign-in timed out.')); }, 5 * 60 * 1000);
    const done = () => { clearTimeout(timer); server.close(); signIn = null; };
    signIn = { cancel: () => { done(); reject(new Error('cancelled')); } };
    server.on('error', (e) => { done(); reject(e); });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}/`;
      const q = new URLSearchParams({
        response_type: 'code', client_id: OAUTH_CLIENT, redirect_uri: redirect,
        code_challenge_method: 'S256', code_challenge: challenge, scope: OAUTH_SCOPES, state,
      });
      shell.openExternal(`${base}/oauth?${q}`);
    });
  });
  const res = await fetch(`${base}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: OAUTH_CLIENT }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Lichess did not give a token (${data.error_description || data.error || res.status}).`);
  const now = loadLichess();
  await setAccountToken(now, data.access_token);
  saveLichess(now);
  win?.focus();
  return publicLichess(now);
});

ipcMain.handle('lichess:signInCancel', () => { signIn?.cancel?.(); });

// Sign out: forget the token (and revoke it, if Lichess can be reached).
ipcMain.handle('lichess:signOut', async () => {
  const settings = loadLichess();
  const token = await accountToken(settings);
  await setAccountToken(settings, '');
  saveLichess(settings);
  await backend.request('lichessAcctDisconnect', {}).catch(() => {});
  if (token) {
    const base = (settings.baseUrl || LICHESS_DEFAULTS.baseUrl).replace(/\/+$/, '');
    fetch(`${base}/api/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  return publicLichess(settings);
});

ipcMain.handle('lichess:accountConnect', async () => {
  const settings = loadLichess();
  return backend.request('lichessAcctConnect', { baseUrl: settings.baseUrl, token: await accountToken(settings), challengeTimeout: challengeTimeout(settings) });
});

ipcMain.handle('lichess:connect', async () => {
  const settings = loadLichess();
  return backend.request('lichessConnect', {
    baseUrl: settings.baseUrl, token: await lichessToken(settings),
    engine: lichessEngine(settings), policy: settings.policy, greeting: settings.greeting, ponder: settings.ponder !== false, draw: settings.draw, challengeTimeout: challengeTimeout(settings),
  });
});

// Lichess's public data: the opening explorer, puzzles and game PGNs. The
// explorer needs a Lichess account, so the saved token is sent with it.
const explorerCache = new Map();

async function lichessBases() {
  const settings = loadLichess();
  const base = (settings.baseUrl || LICHESS_DEFAULTS.baseUrl).replace(/\/+$/, '');
  const explorer = /^https:\/\/lichess\.org$/.test(base) ? 'https://explorer.lichess.org' : base;
  return { base, explorer, token: await anyToken(settings) };
}

async function lichessGet(url, { token, accept = 'application/json', text = false } = {}) {
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error(`Could not reach Lichess (${err.cause?.code ?? err.message})`);
  }
  if (res.status === 401) throw new Error('needs-token');
  if (res.status === 429) throw new Error('Lichess asked to slow down; try again in a minute.');
  if (!res.ok) throw new Error(`Lichess answered ${res.status}`);
  return text ? res.text() : res.json();
}

ipcMain.handle('lichess:explorer', async (_e, db, fen, opts = {}) => {
  const { explorer, token } = await lichessBases();
  const q = new URLSearchParams({ fen, moves: '15', topGames: db === 'masters' ? '8' : '4' });
  if (db === 'lichess') {
    q.set('speeds', (opts.speeds ?? ['blitz', 'rapid', 'classical']).join(','));
    q.set('ratings', (opts.ratings ?? [1600, 1800, 2000, 2200, 2500]).join(','));
    q.set('recentGames', '4');
  }
  const url = `${explorer}/${db === 'masters' ? 'masters' : 'lichess'}?${q}`;
  if (explorerCache.has(url)) return explorerCache.get(url);
  try {
    const data = await lichessGet(url, { token });
    explorerCache.set(url, data);
    if (explorerCache.size > 500) explorerCache.delete(explorerCache.keys().next().value);
    return data;
  } catch (err) {
    if (err.message === 'needs-token') {
      throw new Error(token ? 'Lichess did not accept the saved token for the opening explorer.' : 'The Lichess opening explorer needs a Lichess account: add an API token in Settings → Lichess. The built-in book works without one.');
    }
    throw err;
  }
});

// Everything about the players of a Lichess game. A token (yours, or the
// bot's) lets Lichess make fresh rating histories.
ipcMain.handle('lichess:players', async (_e, users, perf) => {
  const settings = loadLichess();
  return backend.request('lichessPlayers', {
    baseUrl: settings.baseUrl, token: await anyToken(settings),
    users: (users ?? []).map(String).slice(0, 2), perf: String(perf ?? ''),
  });
});

ipcMain.handle('lichess:gamePgn', async (_e, db, id) => {
  const { base, explorer, token } = await lichessBases();
  const url = db === 'masters' ? `${explorer}/masters/pgn/${encodeURIComponent(id)}` : `${base}/game/export/${encodeURIComponent(id)}?evals=false&clocks=false`;
  return lichessGet(url, { token, accept: 'application/x-chess-pgn', text: true });
});

// Puzzles are fetched without the token: a Bot account cannot solve them.
ipcMain.handle('lichess:puzzle', async (_e, kind, opts = {}) => {
  const { base } = await lichessBases();
  if (kind === 'daily') return lichessGet(`${base}/api/puzzle/daily`);
  const q = new URLSearchParams();
  if (opts.angle) q.set('angle', opts.angle);
  if (opts.difficulty) q.set('difficulty', opts.difficulty);
  return lichessGet(`${base}/api/puzzle/next?${q}`);
});

ipcMain.handle('puzzles:chooseFile', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Lichess puzzle database (lichess_db_puzzle.csv)',
    filters: [{ name: 'Puzzle database', extensions: ['csv', 'zst'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('lichess:configure', () => {
  const settings = loadLichess();
  return backend.request('lichessConfigure', { engine: lichessEngine(settings), policy: settings.policy, greeting: settings.greeting, ponder: settings.ponder !== false, draw: settings.draw, challengeTimeout: challengeTimeout(settings) });
});

// ---------------------------------------------------------------------------
function createWindow() {
  // The layout is built for a full screen: the window opens maximised, and
  // F11 switches to full screen (on macOS also the green button or ⌃⌘F).
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#f5f5f7',
    title: 'Ponder',
    // macOS: no title bar, the window's buttons over the page's top strip.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    icon: path.join(__dirname, 'icon.png'), // Windows and Linux; macOS takes the bundle's
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  // Run from source, the Dock would show Electron's icon.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch { /* keep Electron's */ }
  }
  backend.start();
  applyDatabase(loadDatabase()).catch(() => {});
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => backend.stop());
