const { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, shell, Menu, protocol, net, powerSaveBlocker, session, systemPreferences } = require('electron');
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
    // The computer analysis keeps the positions it has analysed here.
    const env = { ...process.env, PONDER_REVIEW_CACHE: path.join(app.getPath('userData'), 'review-cache.json') };
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env });
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

// Background music from your own folder: the audio files in it (and its
// subfolders, a few levels down), as file URLs the page can play.
const MUSIC_TYPES = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.webm']);
ipcMain.handle('music:chooseFolder', async () => {
  const pick = await dialog.showOpenDialog(win, { title: 'Choose a folder of music', properties: ['openDirectory'] });
  return pick.canceled ? null : pick.filePaths[0] ?? null;
});
ipcMain.handle('music:list', async (_e, folder) => {
  const { pathToFileURL } = require('url');
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= 5000 || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (e.isFile() && MUSIC_TYPES.has(path.extname(e.name).toLowerCase())) {
        found.push({ name: path.basename(e.name, path.extname(e.name)), url: pathToFileURL(full).href });
      }
    }
  }
  if (typeof folder === 'string' && folder) await walk(folder, 0);
  return found;
});

// Radio stations of your own. The page cannot play a stream sent over
// plain http (it is upgraded to https, which most such streams do not
// have), so those are played through ponder-radio://, which fetches them
// here. A link to a playlist (.pls, .m3u) is read for the stream in it.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ponder-radio', privileges: { stream: true, supportFetchAPI: true, secure: true, standard: true } },
]);
function webUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}
function handleRadioProtocol() {
  protocol.handle('ponder-radio', (req) => {
    const target = webUrl(new URL(req.url).searchParams.get('u'));
    if (!target) return new Response('Not a web address', { status: 400 });
    const headers = { 'User-Agent': 'Ponder' };
    const range = req.headers.get('range');
    if (range) headers.Range = range;
    return net.fetch(target.href, { headers, bypassCustomProtocolHandlers: true });
  });
}
const PLAYLIST_TYPES = /mpegurl|scpls|x-scpls|pls\+xml|^text\//i;
ipcMain.handle('music:resolve', async (_e, raw) => {
  const u = webUrl(raw);
  if (!u) throw new Error('Give a web address that starts with http:// or https://');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await net.fetch(u.href, { headers: { 'User-Agent': 'Ponder' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`the station answered ${res.status} ${res.statusText}`.trim());
    const type = res.headers.get('content-type') ?? '';
    const listed = /\.(pls|m3u)$/i.test(u.pathname);
    if (!listed && !PLAYLIST_TYPES.test(type)) {
      res.body?.cancel().catch(() => {});
      if (/\.m3u8$/i.test(u.pathname) || /apple|x-mpegurl/i.test(type)) throw new Error('that is an HLS stream, which Ponder cannot play: look for an MP3 or AAC stream');
      return { url: res.url || u.href, type };
    }
    if (/html/i.test(type)) {
      res.body?.cancel().catch(() => {});
      throw new Error('that address is a web page, not a stream: look on the station\'s site for its stream or playlist link');
    }
    const text = (await res.text()).slice(0, 100000);
    if (/^#EXT-X-/m.test(text)) throw new Error('that is an HLS stream, which Ponder cannot play: look for an MP3 or AAC stream');
    // .pls: File1=…; .m3u: a line that is a web address.
    const found = text.split(/\r?\n/).map((l) => l.trim().replace(/^File\d+=/i, '')).find((l) => webUrl(l));
    if (!found) throw new Error('no stream was found in that playlist');
    return { url: found, type: 'playlist' };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('the station did not answer');
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

// Where to write a binpack made from a PGN file: beside it, by default.
// Returns the path, or null. The Go backend writes the file.
ipcMain.handle('binpack:savePath', async (_e, from) => {
  const src = String(from || '');
  const dir = src ? path.dirname(src) : (lastPgnDir ?? app.getPath('documents'));
  const base = (src ? path.basename(src).replace(/\.pgn$/i, '') : 'Games') || 'Games';
  const result = await dialog.showSaveDialog(win, {
    title: 'Save the binpack',
    defaultPath: path.join(dir, base + '.binpack'),
    filters: [{ name: 'Stockfish binpack', extensions: ['binpack'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  let file = result.filePath;
  if (!path.extname(file)) file += '.binpack';
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

// Keeping the screen on (no screensaver, no display sleep) while asked to.
let awakeId = null;
ipcMain.handle('power:keepAwake', (_e, on) => {
  if (on && awakeId == null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && awakeId != null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
  return awakeId != null;
});
// Voice commands (renderer/voice.js): the speech model, and the microphone.
const voiceModel = require('./voice-model');
let voiceInstalling = null;
ipcMain.handle('voice:status', () => voiceModel.status(app.getPath('userData')));
ipcMain.handle('voice:install', (e) => {
  voiceInstalling ??= voiceModel.install(app.getPath('userData'), (url, opts) => net.fetch(url, opts),
    (p) => { if (!e.sender.isDestroyed()) e.sender.send('voice:progress', p); })
    .finally(() => { voiceInstalling = null; });
  return voiceInstalling;
});
ipcMain.handle('voice:model', () => voiceModel.read(app.getPath('userData')));
// macOS asks once, in its own dialog; the answer is kept in System Settings.
ipcMain.handle('voice:micAccess', async () => {
  if (process.platform !== 'darwin') return true;
  const now = systemPreferences.getMediaAccessStatus('microphone');
  if (now === 'granted') return true;
  if (now === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
  return false;
});
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('clipboard:read', () => clipboard.readText());

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
    greetings: saved.greetings && typeof saved.greetings === 'object' ? saved.greetings : {},
    draw: { ...LICHESS_DEFAULTS.draw, ...saved.draw },
    ...savedTokens(saved),
  };
}

// The bot's tokens, one per Lichess account: [{ id, username, title, token
// (encrypted) | plainToken }], with activeToken the id of the one used. A
// single token saved before there could be several becomes the first.
function savedTokens(saved) {
  let tokens = Array.isArray(saved.tokens) ? saved.tokens.filter((t) => t && t.id && (t.token || t.plainToken)) : [];
  if (!tokens.length && (saved.token || saved.plainToken)) {
    tokens = [{ id: 'tok1', username: '', ...(saved.token ? { token: saved.token } : { plainToken: saved.plainToken }) }];
  }
  const activeToken = tokens.some((t) => t.id === saved.activeToken) ? saved.activeToken : tokens[0]?.id ?? '';
  return { tokens, activeToken, token: undefined, plainToken: undefined };
}

const activeTokenEntry = (settings) => settings.tokens?.find((t) => t.id === settings.activeToken);

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
// holder is settings, or else one of settings.tokens (the bot's tokens).
async function decryptSecret(settings, key, holder = settings) {
  try {
    const buf = Buffer.from(holder[key], 'base64');
    if (!safeStorage.decryptStringAsync) return safeStorage.decryptString(buf);
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf);
    if (shouldReEncrypt && result) {
      try {
        const again = await encryptSecret(result);
        const now = loadLichess();
        const there = holder === settings ? now : now.tokens.find((t) => t.id === holder.id);
        if (there && there[key] === holder[key]) { there[key] = again; saveLichess(now); }
        holder[key] = again;
      } catch { /* keep the old one */ }
    }
    return result;
  } catch { return ''; }
}

async function tokenOf(settings, entry) {
  if (!entry) return '';
  if (entry.token) return decryptSecret(settings, 'token', entry);
  return entry.plainToken ?? '';
}

// The bot's token in use.
const lichessToken = (settings) => tokenOf(settings, activeTokenEntry(settings));

// Who a token belongs to, asked of Lichess; null if it cannot say.
async function tokenAccount(settings, token) {
  const base = (settings.baseUrl || LICHESS_DEFAULTS.baseUrl).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/account`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401) throw new Error('Lichess did not accept that token.');
    if (!res.ok) return null;
    const a = await res.json();
    return { username: a.username ?? '', title: a.title ?? '' };
  } catch (err) {
    if (err.message.startsWith('Lichess did not accept')) throw err;
    return null;
  }
}

// Adds a token (or replaces the one saved for the same account) and makes
// it the one in use.
async function addToken(settings, token) {
  const who = await tokenAccount(settings, token);
  const secret = await canEncrypt() ? { token: await encryptSecret(token) } : { plainToken: token };
  const tokens = settings.tokens ?? [];
  let entry = null;
  for (const t of tokens) {
    if ((who?.username && t.username.toLowerCase() === who.username.toLowerCase()) || (await tokenOf(settings, t)) === token) entry = t;
  }
  if (!entry) {
    let n = tokens.length + 1;
    while (tokens.some((t) => t.id === `tok${n}`)) n++;
    entry = { id: `tok${n}`, username: '' };
    tokens.push(entry);
  }
  delete entry.token;
  delete entry.plainToken;
  Object.assign(entry, secret);
  if (who) { entry.username = who.username; entry.title = who.title; }
  settings.tokens = tokens;
  settings.activeToken = entry.id;
}

// Fills in the account names of tokens saved without one.
async function nameTokens(settings) {
  let changed = false;
  for (const t of settings.tokens ?? []) {
    if (t.username) continue;
    const who = await tokenAccount(settings, await tokenOf(settings, t)).catch(() => null);
    if (who?.username) { t.username = who.username; t.title = who.title; changed = true; }
  }
  if (changed) {
    const now = loadLichess();
    for (const t of now.tokens) {
      const named = settings.tokens.find((x) => x.id === t.id);
      if (named?.username && !t.username) { t.username = named.username; t.title = named.title; }
    }
    saveLichess(now);
  }
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
  const { token, plainToken, tokens, accountToken: _a, plainAccountToken: _p, ...rest } = settings;
  return {
    ...rest,
    tokens: (tokens ?? []).map((t) => ({ id: t.id, username: t.username, title: t.title ?? '', encrypted: !t.plainToken })),
    greetingDefaults: LICHESS_DEFAULTS.greeting,
    drawDefaults: LICHESS_DEFAULTS.draw,
    hasToken: Boolean(await lichessToken(settings)),
    hasAccount: Boolean(await accountToken(settings)),
    encrypted: !activeTokenEntry(settings)?.plainToken,
    canEncrypt: await canEncrypt(),
  };
}

const challengeTimeout = (settings) => (Number.isFinite(settings.challengeTimeout) ? settings.challengeTimeout : LICHESS_DEFAULTS.challengeTimeout);

function lichessEngine(settings) {
  const list = loadEngines();
  const e = list.find((x) => x.id === settings.engineId) ?? list[0];
  return { name: e.name, path: e.path, args: e.args ?? [], options: e.options ?? {} };
}

// The chat messages of the bot's engine: its own, or else those for every
// engine.
function lichessGreeting(settings) {
  const list = loadEngines();
  const e = list.find((x) => x.id === settings.engineId) ?? list[0];
  const own = e && settings.greetings?.[e.id];
  return own ? { ...LICHESS_DEFAULTS.greeting, ...own } : settings.greeting;
}

ipcMain.handle('lichess:settings', async () => {
  const settings = loadLichess();
  // Names come later for tokens saved without one: never a wait here.
  if (settings.tokens.some((t) => !t.username)) nameTokens(settings).catch(() => {});
  return publicLichess(settings);
});
// Your engine's game in progress gets its engine started again, with the
// options as now saved (Settings → Engines).
ipcMain.handle('lichess:reloadEngine', (_e, id) => backend.request('lichessReloadEngine', { id: String(id ?? ''), engine: lichessEngine(loadLichess()) }));

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
// A server on this computer or the local network (localhost, 127.x, ::1,
// a .local name, a private address): it may need no key. Any other
// address is a hosted service, which is not asked without one.
function isLocalAddress(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}
// The request for the AI server, or an error, with nothing sent, when it
// has no key and needs one: a hosted provider, or a server elsewhere.
// AI is off until turned on in Settings → AI. Settings saved before there
// was a switch count as on when a model or key was chosen.
function aiEnabled(s) {
  if (typeof s.enabled === 'boolean') return s.enabled;
  const used = (x) => Boolean(x?.model || x?.key || x?.plainKey);
  return used(s) || Object.values(s.providers ?? {}).some(used);
}
async function aiRequestWithKey(s) {
  if (!aiEnabled(s)) throw new Error('AI is off: turn it on in Settings → AI.');
  const req = await aiRequest(s);
  if (req.key) return req;
  const p = ai.PROVIDERS[req.provider];
  if (p.needsKey) throw new Error(`No API key for ${p.name}: add one in Settings → AI.`);
  if (!isLocalAddress(ai.normalizeBase(req.baseUrl))) throw new Error('No API key for the AI endpoint: add one in Settings → AI (a server on this computer or network needs none).');
  return req;
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
    enabled: aiEnabled(s), provider, baseUrl: s.baseUrl, model: slot.model ?? '', hasKey: Boolean(slot.key || slot.plainKey), defaultUrl: ai.DEFAULTS.baseUrl,
    // The AI chat's thinking level for this provider, and the levels the
    // model takes ('default' when the one chosen is not among them).
    thinkingLevels: ai.thinkingLevels(provider, slot.model || ai.PROVIDERS[provider].defaultModel || ''),
    thinking: ai.thinkingLevelFor(provider, slot.model || ai.PROVIDERS[provider].defaultModel || '', slot.thinking ?? 'default'),
    contextWindow: slot.contextWindow ?? null,
    providers: Object.entries(ai.PROVIDERS).map(([id, p]) => ({
      id, name: p.name, needsKey: p.needsKey, modelHint: p.modelHint ?? '', defaultModel: p.defaultModel ?? '',
      hasKey: Boolean(aiSlot(s, id).key || aiSlot(s, id).plainKey),
    })),
  };
};

ipcMain.handle('ai:settings', () => publicAi(loadAi()));
ipcMain.handle('ai:save', async (_e, patch) => {
  const s = loadAi();
  if (typeof patch?.enabled === 'boolean') s.enabled = patch.enabled;
  if (typeof patch?.provider === 'string' && ai.PROVIDERS[patch.provider]) s.provider = patch.provider;
  if (typeof patch?.baseUrl === 'string') s.baseUrl = ai.normalizeBase(patch.baseUrl);
  // The model and key are the chosen provider's.
  const slot = aiSlot(s, aiProvider(s));
  if (typeof patch?.model === 'string') slot.model = patch.model.trim();
  // The AI chat's thinking level, kept for the provider (a model that does
  // not take it is asked at its default).
  if (typeof patch?.thinking === 'string' && ai.THINKING_LEVELS.includes(patch.thinking)) slot.thinking = patch.thinking;
  // The context window given by hand ('' or 0: found from the provider).
  if ('contextWindow' in (patch ?? {})) {
    const n = Math.round(Number(patch.contextWindow));
    if (Number.isFinite(n) && n > 0) slot.contextWindow = n; else delete slot.contextWindow;
    aiWindows.clear();
  }
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
  return ai.listModels(await aiRequestWithKey(s), { signal: AbortSignal.timeout(15000) });
});
ipcMain.handle('ai:annotate', async (_e, game) => {
  const s = loadAi();
  aiRun?.abort();
  const run = aiRun = new AbortController();
  try {
    return await ai.annotate(await aiRequestWithKey(s), game ?? {}, { signal: run.signal });
  } finally {
    if (aiRun === run) aiRun = null;
  }
});
ipcMain.handle('ai:cancel', () => { aiRun?.abort(); });

// How many tokens the model can take in: as set in Settings → AI, else as
// the provider says (asked once per model). null when nobody says.
const aiWindows = new Map();
ipcMain.handle('ai:contextWindow', async (_e, model) => {
  const s = loadAi();
  const req = await aiRequest(s);
  const set = aiSlot(s, aiProvider(s)).contextWindow;
  if (set) return set;
  try { await aiRequestWithKey(s); } catch { return null; } // no key: not asked
  const name = String(model || req.model || '');
  const key = `${req.provider}|${req.provider === 'local' ? s.baseUrl : ''}|${name}`;
  if (!aiWindows.has(key)) aiWindows.set(key, ai.contextWindow(req, name).catch(() => null));
  const n = await aiWindows.get(key);
  if (n == null) aiWindows.delete(key); // asked again next time: the server may have loaded it since
  return n;
});

// The AI tab's chat: the answer is streamed to the window as "aiChat"
// events ({ id, delta }) and returned whole. One answer at a time.
// The chat and the live commentary each have a channel of their own, so
// one does not cut the other off: a new request ends the one before it on
// the same channel only.
const aiChatRuns = new Map(); // channel -> its request in flight
ipcMain.handle('ai:chat', async (_e, id, messages, channel = 'chat', options = {}) => {
  const s = loadAi();
  channel = String(channel);
  aiChatRuns.get(channel)?.abort();
  const run = new AbortController();
  aiChatRuns.set(channel, run);
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => ['system', 'user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  try {
    // maxTokens: a cap on the answer, for short ones (the engine's chat).
    const maxTokens = Number.isFinite(+options?.maxTokens) ? Math.min(4000, Math.max(0, Math.round(+options.maxTokens))) : 0;
    // The thinking level chosen in the AI chat is for its own messages: the
    // commentary and the engine's chat ask as they always have.
    const thinking = channel === 'chat' ? aiSlot(s, aiProvider(s)).thinking ?? 'default' : 'default';
    return await ai.chat(await aiRequestWithKey(s), list, {
      signal: run.signal, maxTokens, thinking,
      onDelta: (delta) => { if (win && !win.isDestroyed()) win.webContents.send('backend-event', 'aiChat', { id, delta }); },
      onThinking: (thinking) => { if (win && !win.isDestroyed()) win.webContents.send('backend-event', 'aiChat', { id, thinking }); },
    });
  } finally {
    if (aiChatRuns.get(channel) === run) aiChatRuns.delete(channel);
  }
});
ipcMain.handle('ai:chatCancel', (_e, channel = 'chat') => { aiChatRuns.get(String(channel))?.abort(); });

// Speech for the live commentary and the announcer, kept under "tts" in
// the AI settings. The service is chosen: OpenAI, Google AI, or a server of
// your own (Claude is listed, but Anthropic offers no speech). Each service
// keeps its own model, voice, speaking style and key, under
// "tts.providers", so that switching keeps them; a server of your own keeps
// its address and the rest at the top of "tts", as before there was a
// choice. Keys are encrypted like the AI keys and never sent back to the
// window. With no key of its own, OpenAI and Google AI use the key of the
// AI chat's OpenAI or Google AI. Nothing is sent until a comment is read
// aloud with the speech service as the voice, or Test voice is pressed.
// Settings from before the choice (an address, model, voice and key at the
// top) are moved to OpenAI's place when the address was OpenAI's.
function ttsSettings(s) {
  s.tts ??= {};
  const t = s.tts;
  if (!ai.TTS_PROVIDERS[t.provider]) {
    // On or off as it was, before the fields it is judged by are moved.
    if (typeof t.enabled !== 'boolean') t.enabled = ttsEnabled(s);
    t.provider = ai.ttsProviderOf(t);
    if (t.provider === 'openai') {
      const slot = (t.providers ??= {}).openai ??= {};
      for (const k of ['model', 'voice', 'instructions', 'key', 'plainKey']) if (t[k] !== undefined) { slot[k] ??= t[k]; delete t[k]; }
      delete t.baseUrl;
    }
  }
  return t;
}
// The part of the speech settings of one service.
function ttsSlot(s, p = ttsSettings(s).provider) {
  const t = ttsSettings(s);
  if (p === 'custom') return t;
  t.providers ??= {};
  return (t.providers[p] ??= {});
}
// Off until turned on; settings saved before the switch count as on when
// a model, voice, key or address of their own was set.
function ttsEnabled(s) {
  const t = s.tts ?? {};
  if (typeof t.enabled === 'boolean') return t.enabled;
  return Boolean(t.model || t.voice || t.key || t.plainKey || (t.baseUrl && t.baseUrl !== ai.TTS_DEFAULTS.baseUrl));
}
const ttsHasOwnKey = (slot) => Boolean(slot.key || slot.plainKey);
// The AI chat's key that a service may use when it has none of its own.
const ttsAiSlot = (s, p) => (ai.TTS_PROVIDERS[p]?.aiProvider ? aiSlot(s, ai.TTS_PROVIDERS[p].aiProvider) : null);
const publicTts = (s) => {
  const t = ttsSettings(s);
  const p = t.provider;
  const slot = ttsSlot(s, p);
  const usesAiKey = (id) => !ttsHasOwnKey(ttsSlot(s, id)) && Boolean(ttsAiSlot(s, id) && ttsHasOwnKey(ttsAiSlot(s, id)));
  return {
    enabled: ttsEnabled(s), provider: p,
    baseUrl: p === 'custom' ? (t.baseUrl ?? '') : '', model: slot.model ?? '', voice: slot.voice ?? '', instructions: slot.instructions ?? '',
    hasKey: ttsHasOwnKey(slot), usesAiKey: usesAiKey(p),
    providers: Object.entries(ai.TTS_PROVIDERS).map(([id, x]) => ({
      id, name: x.name, unavailable: Boolean(x.unavailable), note: x.note ?? '',
      defaultModel: x.model ?? '', defaultVoice: x.voice ?? '', models: x.models ?? [], voices: x.voices ?? [],
    })),
  };
};
ipcMain.handle('tts:settings', () => publicTts(loadAi()));
ipcMain.handle('tts:save', async (_e, patch) => {
  const s = loadAi();
  const t = ttsSettings(s);
  patch = patch ?? {};
  if (typeof patch.enabled === 'boolean') t.enabled = patch.enabled;
  if (typeof patch.provider === 'string') {
    const x = ai.TTS_PROVIDERS[patch.provider];
    if (!x) throw new Error('There is no such speech service.');
    if (x.unavailable) throw new Error(x.note);
    t.provider = patch.provider;
  }
  if (typeof patch.baseUrl === 'string' && t.provider === 'custom') t.baseUrl = ai.speechBase(patch.baseUrl);
  const slot = ttsSlot(s, t.provider);
  for (const k of ['model', 'voice', 'instructions']) {
    if (typeof patch[k] === 'string') { const v = patch[k].trim(); if (v) slot[k] = v; else delete slot[k]; }
  }
  if (typeof patch.key === 'string') {
    delete slot.key;
    delete slot.plainKey;
    const key = patch.key.trim();
    if (key && await canEncrypt()) slot.key = await encryptSecret(key);
    else if (key) slot.plainKey = key;
  }
  saveAi(s);
  return publicTts(s);
});
// What ai.js is given for the chosen service: its model, voice, style,
// address (a server of your own) and key: its own, or the AI chat's.
// With no key, a hosted service is not asked (a server on this computer or
// network may need none).
async function ttsRequest(s) {
  if (!ttsEnabled(s)) throw new Error('The speech service is off: turn it on in Settings → AI.');
  const t = ttsSettings(s);
  const p = t.provider;
  const x = ai.TTS_PROVIDERS[p];
  if (x.unavailable) throw new Error(x.note);
  const slot = ttsSlot(s, p);
  const key = (await aiKey(slot)) || (ttsAiSlot(s, p) ? await aiKey(ttsAiSlot(s, p)) : '');
  const req = { provider: p, model: slot.model ?? '', voice: slot.voice ?? '', instructions: slot.instructions ?? '', key };
  if (p === 'custom') {
    req.baseUrl = ai.speechBase(t.baseUrl);
    if (!key && !isLocalAddress(req.baseUrl)) throw new Error('No API key for the speech server: add one in Settings → AI (a server on this computer or network needs none).');
  } else if (!key) throw new Error(`No API key for ${x.name}: add one under Commentary voice in Settings → AI, or for ${x.name} as the AI provider.`);
  return req;
}
ipcMain.handle('tts:speak', async (_e, text, opts) => {
  return ai.speech(await ttsRequest(loadAi()), String(text ?? ''), { speed: Number(opts?.speed) || 1, signal: AbortSignal.timeout(60000) });
});
// Its models and voices, for Refresh in Settings → AI.
ipcMain.handle('tts:models', async () => {
  return ai.speechModels(await ttsRequest(loadAi()), { signal: AbortSignal.timeout(15000) });
});
// The voices of one model (the voices follow the model chosen).
ipcMain.handle('tts:voices', async (_e, model) => {
  const req = await ttsRequest(loadAi());
  return ai.speechVoices({ ...req, model: String(model ?? '') || req.model }, { signal: AbortSignal.timeout(15000) });
});

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
  const cleanGreeting = (from, base) => {
    const g = { ...base };
    for (const k of Object.keys(LICHESS_DEFAULTS.greeting)) {
      if (typeof from[k] === 'string') g[k] = [...from[k].replace(/\s+/g, ' ').trim()].slice(0, GREETING_MAX).join('');
    }
    return g;
  };
  if (patch.greeting && typeof patch.greeting === 'object') settings.greeting = cleanGreeting(patch.greeting, settings.greeting);
  // Engines' own messages, by engine id; null: back to those for every engine.
  if (patch.greetings && typeof patch.greetings === 'object') {
    const all = { ...settings.greetings };
    const ids = new Set(loadEngines().map((e) => e.id));
    for (const [id, g] of Object.entries(patch.greetings)) {
      if (g && typeof g === 'object') all[id] = cleanGreeting(g, settings.greeting);
      else delete all[id];
    }
    for (const id of Object.keys(all)) if (!ids.has(id)) delete all[id];
    settings.greetings = all;
  }
  // A token typed in: added to the bot's tokens and used from now on.
  if (typeof patch.token === 'string' && patch.token.trim()) await addToken(settings, patch.token.trim());
  // Forgetting one; the next saved one is used instead.
  if (typeof patch.forgetToken === 'string') {
    settings.tokens = settings.tokens.filter((t) => t.id !== patch.forgetToken);
    if (settings.activeToken === patch.forgetToken) settings.activeToken = settings.tokens[0]?.id ?? '';
  }
  if (typeof patch.activeToken === 'string' && settings.tokens.some((t) => t.id === patch.activeToken)) settings.activeToken = patch.activeToken;
  if (typeof patch.accountToken === 'string') await setAccountToken(settings, patch.accountToken);
  saveLichess(settings);
  return publicLichess(settings);
});

// Sign in with Lichess: OAuth with PKCE, which needs no registered app. The
// browser comes back to a one-off local server with a code, swapped for a
// token that may play games (board:play), send and answer challenges, and
// read the players followed (follow:read) for the Lichess home.
const OAUTH_CLIENT = 'ponder-chess-gui';
const OAUTH_SCOPES = 'board:play challenge:read challenge:write follow:read';
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
    engine: lichessEngine(settings), policy: settings.policy, greeting: lichessGreeting(settings), ponder: settings.ponder !== false, draw: settings.draw, challengeTimeout: challengeTimeout(settings),
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
  return backend.request('lichessConfigure', { engine: lichessEngine(settings), policy: settings.policy, greeting: lichessGreeting(settings), ponder: settings.ponder !== false, draw: settings.draw, challengeTimeout: challengeTimeout(settings) });
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
    autoHideMenuBar: true, // Windows and Linux: the menu bar shows with Alt
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

// ---------------------------------------------------------------------------
// The application menu: Ponder's own commands, grouped as a chess program
// would, in place of Electron's default. Each command is sent to the page,
// which does what the button or key for it does. Shortcuts that are a
// single key (F, Z, L…) are the page's own: on Windows and Linux they are
// only shown beside the item; on macOS, where a menu cannot show a key
// without taking it from text fields, they are left out (Help → Keyboard
// Shortcuts lists them).
// ---------------------------------------------------------------------------
function buildMenu() {
  const mac = process.platform === 'darwin';
  const send = (cmd, arg) => () => {
    const w = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    w.webContents.send('menu', cmd, arg);
  };
  // A command; key is a page shortcut (shown only), accel a real one.
  const item = (label, cmd, { key, accel, arg } = {}) => ({
    label, click: send(cmd, arg),
    ...(accel ? { accelerator: accel } : key && !mac ? { accelerator: key, registerAccelerator: false } : {}),
  });
  const sep = { type: 'separator' };

  const template = [
    ...(mac ? [{
      label: 'Ponder',
      submenu: [
        { role: 'about', label: 'About Ponder' },
        sep,
        item('Settings…', 'settings', { accel: 'Cmd+,' }),
        sep,
        { role: 'services' },
        sep,
        { role: 'hide', label: 'Hide Ponder' }, { role: 'hideOthers' }, { role: 'unhide' },
        sep,
        { role: 'quit', label: 'Quit Ponder' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        item('New Game…', 'newGame', { accel: 'CmdOrCtrl+N' }),
        sep,
        item('Open PGN…', 'open', { accel: 'CmdOrCtrl+O' }),
        item('Open Game Database', 'database', { accel: 'CmdOrCtrl+Shift+O' }),
        item('Test Positions…', 'positions'),
        item('Convert PGN to Binpack…', 'binpack'),
        sep,
        item('Save Game…', 'save', { accel: 'CmdOrCtrl+S' }),
        item('Copy Game as PGN', 'copyPgn', { accel: 'CmdOrCtrl+Shift+C' }),
        item('Copy Position as FEN', 'copyFen', { accel: 'CmdOrCtrl+Alt+C' }),
        item('Paste Game or Position', 'paste', { accel: 'CmdOrCtrl+Shift+V' }),
        ...(mac ? [sep, { role: 'close' }] : [sep, item('Settings…', 'settings', { accel: 'Ctrl+,' }), sep, { role: 'quit', label: 'Exit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, sep,
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Game',
      submenu: [
        item('Takeback', 'takeback', { key: 'B' }),
        item('Voice Commands', 'voice', { key: 'T' }),
        sep,
        item('First Move', 'first', { key: 'Home' }),
        item('Previous Move', 'prev', { key: 'Left' }),
        item('Next Move', 'next', { key: 'Right' }),
        item('Last Move', 'last', { key: 'End' }),
        sep,
        item('Flip Board', 'flip', { key: 'F' }),
        item('Annotate', 'annotate', { key: 'A' }),
      ],
    },
    {
      label: 'Analysis',
      submenu: [
        item('Analyse Position', 'analysis', { key: 'L' }),
        item('Pause or Resume Analysis', 'pause', { key: 'P' }),
        sep,
        item('Opening Explorer', 'tab', { arg: 'explorer' }),
        item('Ask the AI About the Game', 'ai', { accel: 'CmdOrCtrl+J' }),
        sep,
        item('Engines…', 'settings', { arg: 'engines' }),
        item('Analysis Settings…', 'settings', { arg: 'analysis' }),
      ],
    },
    {
      label: 'Lichess',
      submenu: [
        item('Play', 'lichess', { arg: 'play' }),
        item('Watch Lichess TV', 'lichess', { arg: 'watch' }),
        item('Your Bot', 'lichess', { arg: 'engine' }),
        item('Puzzles', 'tab', { arg: 'puzzles' }),
        sep,
        item('Lichess Settings…', 'settings', { arg: 'lichess' }),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Moves', 'tab', { arg: 'moves', accel: 'CmdOrCtrl+1' }),
        item('Explorer', 'tab', { arg: 'explorer', accel: 'CmdOrCtrl+2' }),
        item('Puzzles', 'tab', { arg: 'puzzles', accel: 'CmdOrCtrl+3' }),
        item('Games', 'tab', { arg: 'games', accel: 'CmdOrCtrl+4' }),
        item('Lichess', 'tab', { arg: 'lichess', accel: 'CmdOrCtrl+5' }),
        item('Tournament', 'tab', { arg: 'tournament', accel: 'CmdOrCtrl+6' }),
        sep,
        item('Zen Mode', 'zen', { key: 'Z' }),
        item('Appearance…', 'settings', { arg: 'appearance' }),
        sep,
        item('Sounds On or Off', 'sounds', { key: 'M' }),
        item('Classical Music On or Off', 'music', { key: 'U' }),
        sep,
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        sep,
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [sep, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        item('Keyboard Shortcuts', 'keys', { key: '?' }),
        sep,
        { label: 'Lichess.org', click: () => shell.openExternal('https://lichess.org') },
        { label: 'UCI Engines and Options', click: () => shell.openExternal('https://backscattering.de/chess/uci/') },
        { label: 'Stockfish', click: () => shell.openExternal('https://stockfishchess.org') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Run from source, the Dock would show Electron's icon.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch { /* keep Electron's */ }
  }
  app.setAboutPanelOptions({
    applicationName: 'Ponder', applicationVersion: app.getVersion(),
    credits: 'A chess program: play engines and people, analyse, train, and run your engine on Lichess.',
  });
  buildMenu();
  handleRadioProtocol();
  // The microphone is for voice commands only: the app's own pages may use
  // it, for sound alone (never the camera). Other requests are answered as
  // Electron always has.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media') return callback(true);
    const audioOnly = (details.mediaTypes ?? []).every((t) => t === 'audio');
    callback(audioOnly && String(details.requestingUrl ?? wc.getURL()).startsWith('file:'));
  });
  backend.start();
  applyDatabase(loadDatabase()).catch(() => {});
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => backend.stop());
