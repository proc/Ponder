const { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const exe = process.platform === 'win32' ? '.exe' : '';
const binDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, '..', 'bin');

let win = null;

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
  { id: 'builtin-basic', name: 'Board Basic (built-in)', file: 'basicengine' },
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

ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

// ---------------------------------------------------------------------------
// The PGN database: finished games can be added to a PGN file. Settings in
// database.json; the backend appends the games.
// ---------------------------------------------------------------------------
const databaseFile = () => path.join(app.getPath('userData'), 'database.json');
const DATABASE_DEFAULTS = () => ({
  enabled: false,
  path: path.join(app.getPath('documents'), 'Board', 'Games.pgn'),
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
const tournamentDir = () => path.join(app.getPath('documents'), 'Board', 'Tournaments');
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

ipcMain.handle('tournament:defaultPgn', (_e, a, b) => {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
  return path.join(tournamentDir(), `${safeName(a)} vs ${safeName(b)} ${stamp}.pgn`);
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
  policy: {
    rated: true, casual: true, humans: true, bots: true,
    minMinutes: 0, maxMinutes: 0, maxGames: 1,
  },
};

function loadLichess() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(lichessFile(), 'utf8')); } catch { /* first run */ }
  return { ...LICHESS_DEFAULTS, ...saved, policy: { ...LICHESS_DEFAULTS.policy, ...saved.policy } };
}

function saveLichess(settings) {
  fs.mkdirSync(path.dirname(lichessFile()), { recursive: true });
  fs.writeFileSync(lichessFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function lichessToken(settings) {
  if (settings.token) {
    try { return safeStorage.decryptString(Buffer.from(settings.token, 'base64')); } catch { return ''; }
  }
  return settings.plainToken ?? '';
}

// The person's own account (Board API), signed in with Lichess (OAuth) or
// with a pasted token; kept like the bot's token.
function accountToken(settings) {
  if (settings.accountToken) {
    try { return safeStorage.decryptString(Buffer.from(settings.accountToken, 'base64')); } catch { return ''; }
  }
  return settings.plainAccountToken ?? '';
}

function setAccountToken(settings, token) {
  delete settings.accountToken;
  delete settings.plainAccountToken;
  token = (token ?? '').trim();
  if (token && safeStorage.isEncryptionAvailable()) settings.accountToken = safeStorage.encryptString(token).toString('base64');
  else if (token) settings.plainAccountToken = token;
}

// What the window may see: everything but the tokens.
function publicLichess(settings) {
  const { token, plainToken, accountToken: _a, plainAccountToken: _p, ...rest } = settings;
  return {
    ...rest,
    hasToken: Boolean(lichessToken(settings)),
    hasAccount: Boolean(accountToken(settings)),
    encrypted: !plainToken,
    canEncrypt: safeStorage.isEncryptionAvailable(),
  };
}

function lichessEngine(settings) {
  const list = loadEngines();
  const e = list.find((x) => x.id === settings.engineId) ?? list[0];
  return { name: e.name, path: e.path, args: e.args ?? [], options: e.options ?? {} };
}

ipcMain.handle('lichess:settings', () => publicLichess(loadLichess()));

ipcMain.handle('lichess:save', (_e, patch) => {
  const settings = loadLichess();
  patch = patch ?? {};
  if (typeof patch.baseUrl === 'string') {
    const url = patch.baseUrl.trim().replace(/\/+$/, '') || LICHESS_DEFAULTS.baseUrl;
    if (!/^https?:\/\//.test(url)) throw new Error('The server address must start with https://');
    settings.baseUrl = url;
  }
  if (typeof patch.engineId === 'string') settings.engineId = patch.engineId;
  if (typeof patch.autoConnect === 'boolean') settings.autoConnect = patch.autoConnect;
  if (patch.policy && typeof patch.policy === 'object') {
    const p = { ...settings.policy };
    for (const k of ['rated', 'casual', 'humans', 'bots']) if (k in patch.policy) p[k] = Boolean(patch.policy[k]);
    for (const k of ['minMinutes', 'maxMinutes']) if (k in patch.policy) p[k] = Math.max(0, Number(patch.policy[k]) || 0);
    if ('maxGames' in patch.policy) p.maxGames = Math.min(8, Math.max(1, Math.round(Number(patch.policy.maxGames) || 1)));
    settings.policy = p;
  }
  if (typeof patch.token === 'string') {
    const token = patch.token.trim();
    delete settings.token;
    delete settings.plainToken;
    if (token && safeStorage.isEncryptionAvailable()) settings.token = safeStorage.encryptString(token).toString('base64');
    else if (token) settings.plainToken = token;
  }
  if (typeof patch.accountToken === 'string') setAccountToken(settings, patch.accountToken);
  saveLichess(settings);
  return publicLichess(settings);
});

// Sign in with Lichess: OAuth with PKCE, which needs no registered app. The
// browser comes back to a one-off local server with a code, swapped for a
// token that may play games (board:play) and send and answer challenges.
const OAUTH_CLIENT = 'board-chess-gui';
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
      res.end(ok ? page('Signed in to Board', 'You can close this tab and go back to Board.')
        : page('Not signed in', err === 'access_denied' ? 'The sign-in was cancelled.' : 'Something went wrong; try again from Board.'));
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
  setAccountToken(now, data.access_token);
  saveLichess(now);
  win?.focus();
  return publicLichess(now);
});

ipcMain.handle('lichess:signInCancel', () => { signIn?.cancel?.(); });

// Sign out: forget the token (and revoke it, if Lichess can be reached).
ipcMain.handle('lichess:signOut', async () => {
  const settings = loadLichess();
  const token = accountToken(settings);
  setAccountToken(settings, '');
  saveLichess(settings);
  await backend.request('lichessAcctDisconnect', {}).catch(() => {});
  if (token) {
    const base = (settings.baseUrl || LICHESS_DEFAULTS.baseUrl).replace(/\/+$/, '');
    fetch(`${base}/api/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  return publicLichess(settings);
});

ipcMain.handle('lichess:accountConnect', () => {
  const settings = loadLichess();
  return backend.request('lichessAcctConnect', { baseUrl: settings.baseUrl, token: accountToken(settings) });
});

ipcMain.handle('lichess:connect', () => {
  const settings = loadLichess();
  return backend.request('lichessConnect', {
    baseUrl: settings.baseUrl, token: lichessToken(settings),
    engine: lichessEngine(settings), policy: settings.policy,
  });
});

// Lichess's public data: the opening explorer, puzzles and game PGNs. The
// explorer needs a Lichess account, so the saved token is sent with it.
const explorerCache = new Map();

function lichessBases() {
  const settings = loadLichess();
  const base = (settings.baseUrl || LICHESS_DEFAULTS.baseUrl).replace(/\/+$/, '');
  const explorer = /^https:\/\/lichess\.org$/.test(base) ? 'https://explorer.lichess.org' : base;
  return { base, explorer, token: accountToken(settings) || lichessToken(settings) };
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
  const { explorer, token } = lichessBases();
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

ipcMain.handle('lichess:gamePgn', async (_e, db, id) => {
  const { base, explorer, token } = lichessBases();
  const url = db === 'masters' ? `${explorer}/masters/pgn/${encodeURIComponent(id)}` : `${base}/game/export/${encodeURIComponent(id)}?evals=false&clocks=false`;
  return lichessGet(url, { token, accept: 'application/x-chess-pgn', text: true });
});

// Puzzles are fetched without the token: a Bot account cannot solve them.
ipcMain.handle('lichess:puzzle', async (_e, kind, opts = {}) => {
  const { base } = lichessBases();
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
  return backend.request('lichessConfigure', { engine: lichessEngine(settings), policy: settings.policy });
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
    backgroundColor: '#f3f2ee',
    title: 'Board',
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
  backend.start();
  applyDatabase(loadDatabase()).catch(() => {});
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => backend.stop());
