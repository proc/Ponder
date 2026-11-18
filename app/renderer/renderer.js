'use strict';
/* global createTimeControlEditor, el, sounds */

const api = window.board;
const $ = (sel, root = document) => root.querySelector(sel);

const PIECE_NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

// ---------------------------------------------------------------------------
// Themes. Each folder in svg/ is a piece set (svg/<theme>/<color>-<name>.svg);
// the board and UI colours for a theme live in style.css under
// [data-theme="<theme>"]. Sets are drawn at different scales, so each is sized
// from its own tallest piece.
// ---------------------------------------------------------------------------
const DEFAULT_THEME = 'minimalist';
// On macOS the window has no title bar: the page leaves a strip for the
// window's buttons (see html.mac-chrome in style.css).
if (/Electron/.test(navigator.userAgent) && /Mac/.test(navigator.platform)) document.documentElement.classList.add('mac-chrome');
// Windows' emoji font has no country flags: they come from a font of
// flags only (style.css), used there.
if (/^Win/.test(navigator.platform)) document.documentElement.classList.add('win');

const themes = {};    // name -> { pieces: { "white-king": { url, h, pad } }, maxH }
let theme = DEFAULT_THEME;

async function loadThemes() {
  const sets = await api.loadThemes();
  for (const [name, files] of Object.entries(sets)) {
    const pieces = {};
    let maxH = 0;
    for (const [key, svg] of Object.entries(files)) {
      const box = svg.match(/viewBox="([\d.\s-]+)"/)?.[1].trim().split(/\s+/).map(Number);
      if (!box || box.length !== 4) continue;
      const [x, y, w, h] = box;
      // A blur filter (glow, drop shadow) paints outside the drawing's own
      // frame; widen the frame by three standard deviations so it isn't cut
      // off. The extra margin is even on all sides, so the drawing stays centred.
      const blur = Math.max(0, ...[...svg.matchAll(/stdDeviation="([\d.]+)/g)].map((m) => +m[1]));
      const pad = Math.ceil(blur * 3);
      const framed = svg.replace(/viewBox="[^"]*"/, `viewBox="${x - pad} ${y - pad} ${w + 2 * pad} ${h + 2 * pad}"`);
      pieces[key] = { url: URL.createObjectURL(new Blob([framed], { type: 'image/svg+xml' })), h, pad, aspect: (w + 2 * pad) / (h + 2 * pad) };
      maxH = Math.max(maxH, h);
    }
    if (Object.keys(pieces).length === 12) themes[name] = { pieces, maxH };
  }
}

const themeNames = () => Object.keys(themes).sort((a, b) =>
  (a === DEFAULT_THEME ? -1 : b === DEFAULT_THEME ? 1 : a.localeCompare(b)));
const themeLabel = (name) => name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Mark an element as showing a theme: its colours and its piece scale.
function themeElement(node, name) {
  node.dataset.theme = name;
  node.style.setProperty('--piece-max', themes[name]?.maxH ?? 1);
  return node;
}

function setTheme(name, { save = true } = {}) {
  if (!themes[name]) name = themes[DEFAULT_THEME] ? DEFAULT_THEME : themeNames()[0];
  if (!name) return;
  theme = name;
  themeElement(document.documentElement, name);
  sounds.setVoice({ cyberpunk: 'synth', dusk: 'arcade' }[name] ?? 'wood');
  if (save) {
    try { localStorage.setItem('theme', name); } catch { /* storage unavailable */ }
  }
  window.board3d?.restyle(); // the 3D board's colours follow the theme
  if (state) { renderBoard(); renderMoves(); renderGameInfo(); } // the Game card's preview is drawn in the theme
}

// How see-through the glass is (Settings → Appearance): 0 is solid, 100
// nearly clear. The styles read it as --glass-t, with --glass-k and
// --glass-blur easing off the extra body and the frosting past the middle;
// it is kept on this computer.
const GLASS_DEFAULT = 48;
let glassTransparency = (() => {
  try { const v = parseInt(localStorage.getItem('glassTransparency'), 10); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : GLASS_DEFAULT; } catch { return GLASS_DEFAULT; }
})();
function setGlassTransparency(v, { save = true } = {}) {
  glassTransparency = Math.max(0, Math.min(100, Math.round(+v || 0)));
  const t = glassTransparency, root = document.documentElement.style;
  root.setProperty('--glass-t', `${t}%`);
  root.setProperty('--glass-k', String(Math.max(0, Math.min(1, (100 - t) / 50))));
  root.setProperty('--glass-blur', String(t <= 60 ? 1 : 1 - ((t - 60) / 40) * 0.8));
  if ($('#glass-transparency-value')) $('#glass-transparency-value').textContent = `${glassTransparency}%`;
  if (save) try { localStorage.setItem('glassTransparency', String(glassTransparency)); } catch { /* storage unavailable */ }
}
setGlassTransparency(glassTransparency, { save: false });

function savedTheme() {
  try { return localStorage.getItem('theme') || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}

// Glass pieces (Glassify board): each piece of a theme drawn once into an
// image of glass (a body of clear or smoked glass in its shape, the drawing
// over it partly see-through, a sheen across the top), so that on the board
// it costs no more than the plain piece: no masks or filters to redraw while
// it slides. Made the first time they are needed; until then the plain piece.
const glassArt = new Map(); // "theme/key" -> art, or a promise of it
const GLASS_PX = 360;       // height drawn: sharp on a large board on a 2x screen
async function makeGlassPiece(art, white) {
  const img = new Image();
  img.src = art.url;
  await img.decode();
  const H = GLASS_PX;
  const W = Math.max(1, Math.round(H * (art.aspect || 1)));
  const layer = (fill) => {
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = fill(g);
    g.fillRect(0, 0, W, H);
    return c;
  };
  const vertical = (g, stops) => {
    const grad = g.createLinearGradient(0, 0, W * 0.09, H);
    for (const [at, colour] of stops) grad.addColorStop(at, colour);
    return grad;
  };
  const body = layer((g) => vertical(g, white
    ? [[0, 'rgba(255,255,255,.72)'], [1, 'rgba(255,255,255,.38)']]
    : [[0, 'rgba(52,52,60,.7)'], [1, 'rgba(10,10,16,.82)']]));
  const sheen = layer((g) => vertical(g, [[0, 'rgba(255,255,255,.7)'], [0.26, 'rgba(255,255,255,.28)'], [0.48, 'rgba(255,255,255,0)'],
    [0.82, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,.2)']]));
  const out = new OffscreenCanvas(W, H);
  const g = out.getContext('2d');
  g.drawImage(body, 0, 0);
  g.globalAlpha = 0.72;
  g.drawImage(img, 0, 0, W, H);
  g.globalAlpha = 1;
  g.drawImage(sheen, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  return { ...art, url: URL.createObjectURL(blob) };
}
let glassRedraw = 0;
function glassPieceArt(name, key, art) {
  const id = `${name}/${key}`;
  const got = glassArt.get(id);
  if (got && !(got instanceof Promise)) return got;
  if (!got) {
    glassArt.set(id, makeGlassPiece(art, key.startsWith('white')).then((g) => {
      glassArt.set(id, g);
      // Once they are made, the board shows them.
      cancelAnimationFrame(glassRedraw);
      glassRedraw = requestAnimationFrame(() => { if (state && glassBoard) renderBoard(); });
      return g;
    }, () => { glassArt.set(id, art); return art; }));
  }
  return art;
}

function pieceImage(type, white, name = theme) {
  const key = `${white ? 'white' : 'black'}-${PIECE_NAMES[type]}`;
  let art = themes[name]?.pieces[key];
  if (art && glassBoard) art = glassPieceArt(name, key, art);
  const img = el('img', { className: 'piece', alt: key.replace('-', ' '), draggable: false });
  if (art) {
    img.src = art.url;
    img.style.setProperty('--h', art.h);
    img.style.setProperty('--pad', art.pad);
  }
  return img;
}

const FILES = 'abcdefgh';

// ---------------------------------------------------------------------------
// Moves list: a figurine of the piece that moved before each move, and the
// evaluation after it (from the computer analysis, or else what the engine
// that played the move reported). Both can be turned off in Settings.
// ---------------------------------------------------------------------------
const movesPrefs = (() => {
  const read = (k) => { try { return localStorage.getItem(k) !== 'off'; } catch { return true; } };
  return { figurines: read('moves.figurines'), scores: read('moves.scores') };
})();
function setMovesPref(key, on) {
  movesPrefs[key] = on;
  try { localStorage.setItem(`moves.${key}`, on ? 'on' : 'off'); } catch {}
  if (state) renderMoves();
}

// The piece a SAN move moves: castling is a king move, no letter a pawn.
function sanPiece(san) {
  if (/^O-O/.test(san)) return 'k';
  const c = san[0];
  return 'KQRBN'.includes(c) ? c.toLowerCase() : 'p';
}

// A move's label: figurine, then the SAN without its piece letter.
function sanLabel(san, white) {
  if (!movesPrefs.figurines || !san) return [el('span', { className: 'san', textContent: san ?? '' })];
  const type = sanPiece(san);
  const img = pieceImage(type, white);
  img.className = 'fig';
  img.alt = '';
  const fig = img.src ? img : el('span', { className: 'fig-text', textContent: '♔♕♖♗♘♙'['kqrbnp'.indexOf(type)] });
  fig.setAttribute('aria-hidden', 'true');
  const text = type === 'p' || type === 'k' && san.startsWith('O') ? san : san.slice(1);
  return [fig, el('span', { className: 'san', textContent: text, title: `${PIECE_NAMES[type]} ${san}` })];
}

// Evaluations the playing engines reported, by ply (White's view).
let engineScores = [];

function scoreText(s) {
  if (s.final === 'checkmate') return s.cp > 0 ? '1-0' : '0-1';
  if (s.final === 'stalemate') return '½-½';
  if (s.mate) return `#${s.mate}`;
  const v = s.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}

// The score to show after ply p: the computer analysis, else the engine's own.
function moveScore(p, review) {
  const pos = review?.positions?.[p];
  if (pos && (pos.final || pos.depth || pos.mate || pos.cp !== undefined)) {
    const tip = pos.final ? pos.final : `Computer analysis, depth ${pos.depth ?? '?'}${pos.bestS ? ` · best ${pos.bestS}` : ''}`;
    return { text: scoreText(pos), cls: 's-review', tip, side: Math.sign(pos.mate ? pos.mate : pos.cp) };
  }
  const e = engineScores[p];
  if (e) {
    const s = e.isMate ? { mate: e.mate, cp: e.mate > 0 ? 1 : -1 } : { cp: e.cp };
    return { text: scoreText(s), cls: 's-engine', tip: `${e.name ? e.name + "'s" : "The engine's"} own evaluation, depth ${e.depth}`, side: Math.sign(e.isMate ? e.mate : e.cp) };
  }
  return null;
}

function scoreElement(p, review) {
  if (!movesPrefs.scores) return null;
  const s = moveScore(p, review);
  if (!s) return null;
  const cls = `score ${s.cls}${s.side > 0 ? ' plus' : s.side < 0 ? ' minus' : ''}`;
  return el('span', { className: cls, textContent: s.text, title: s.tip });
}

let state = null;        // latest snapshot from the backend
let stateAt = 0;         // performance.now() when it arrived, for ticking clocks
let engines = [];
let flipped = false;
let selected = null;     // selected square name, e.g. "e2"
let viewPly = null;      // null = follow the live position, else a ply index
// Side variations, as on Lichess's analysis board: alternatives to the
// game's moves, explored on the board once a game is over (or opened from
// a file). branches: ply p → first moves of lines replacing move p+1.
let tree = { branches: new Map() };
let varNode = null;      // the variation move shown, or null on the game's moves
// Your annotations of the game's moves, by ply (1 = the first move): each
// { nag, pos, other, comment, cmds }. Moves in variations carry theirs as
// node.ann. before is the comment ahead of the first move.
let notes = { before: null, moves: new Map(), dirty: false };
const NAG_MOVE = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!' };
const NAG_POS = { 10: '=', 13: '∞', 14: '⩲', 15: '⩱', 16: '±', 17: '∓', 18: '+−', 19: '−+' };
const NAG_KIND = { 1: 'good', 3: 'good', 5: 'interesting', 6: 'inaccuracy', 2: 'mistake', 4: 'blunder' };
const NAG_TITLE = { 1: 'Good move', 2: 'Mistake', 3: 'Brilliant move', 4: 'Blunder', 5: 'Interesting move', 6: 'Dubious move',
  10: 'Equal', 13: 'Unclear', 14: 'White is slightly better', 15: 'Black is slightly better', 16: 'White is better', 17: 'Black is better', 18: 'White is winning', 19: 'Black is winning' };
const KIND_LABEL = { good: 'Good move', interesting: 'Interesting', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' };
// A comment as a row of the moves list, in the colour of its kind (blunder,
// mistake, inaccuracy, good, interesting); a kind named at its start is bold.
// ai: the comment is the AI model's (AI annotate, the live commentary): it
// wears an AI badge and its own look.
function commentRow(text, kind = '', tag = 'div', cls = 'comment user', ai = false) {
  const label = Object.values(KIND_LABEL).concat('Brilliant move', 'Dubious move').find((l) => text.startsWith(l + '.'));
  const kids = label ? [el('b', { textContent: label + '.' }), text.slice(label.length + 1)] : [text];
  if (ai) {
    const badge = el('span', { className: 'ai-badge', title: 'Written by the AI model. Edit it and it becomes yours.' });
    badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3v18"/><path d="M3 12h18"/><path d="M5.6 5.6l12.8 12.8"/><path d="M18.4 5.6L5.6 18.4"/></g></svg>';
    badge.append('AI');
    badge.setAttribute('aria-label', 'From the AI');
    kids.unshift(badge);
  }
  const row = el(tag, { className: `${cls}${kind ? ' ' + kind : ''}${ai ? ' ai' : ''}` }, kids);
  if (kind) row.title = KIND_LABEL[kind];
  return row;
}
// The glyphs of an annotation, as elements for a move button.
function annGlyphs(a) {
  const out = [];
  if (a?.nag) out.push(el('span', { className: `glyph ${NAG_KIND[a.nag]}`, textContent: NAG_MOVE[a.nag], title: NAG_TITLE[a.nag] }));
  if (a?.pos) out.push(el('span', { className: 'glyph pos', textContent: NAG_POS[a.pos], title: NAG_TITLE[a.pos] }));
  return out;
}
const positionCache = new Map(); // fen → { legal, check, status }
let puzzleView = null;   // set by puzzles.js while a puzzle is on the board
let engineInfo = {};     // latest search info per side
let engineStrings = {};  // recent "info string" messages per side, newest last
const engineMsgOpen = {}; // side -> whether all messages are shown
let engineLineOpen = {};  // side -> the plies whose line is shown in full
const MAX_STRINGS = 12;
let drag = null;

// A notification: a card in the top right corner that goes by itself after
// a while (errors stay longer), or when closed. The same text twice in a
// row shows once.
function notify(text, { title = '', kind = 'error', ms } = {}) {
  if (!text) return;
  let box = document.querySelector('#toasts');
  if (!box) {
    box = el('div', { id: 'toasts' });
    box.setAttribute('aria-live', 'assertive');
    document.body.append(box);
  }
  const same = [...box.children].find((t) => t.dataset.key === `${kind}|${title}|${text}`);
  if (same) same.remove();
  const close = el('button', { type: 'button', className: 'toast-close', textContent: '✕', title: 'Dismiss' });
  close.setAttribute('aria-label', 'Dismiss');
  const toast = el('div', { className: `toast is-${kind}` }, [
    el('div', { className: 'toast-body' }, [...(title ? [el('b', { textContent: title })] : []), el('span', { textContent: text })]),
    close,
  ]);
  toast.dataset.key = `${kind}|${title}|${text}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const gone = () => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 220); };
  close.onclick = gone;
  let timer = setTimeout(gone, ms ?? (kind === 'error' ? 9000 : 6000));
  // Reading it keeps it there.
  toast.onmouseenter = () => clearTimeout(timer);
  toast.onmouseleave = () => { timer = setTimeout(gone, 2500); };
  box.append(toast);
  while (box.children.length > 4) box.firstElementChild.remove();
}

const errorText = (err) => String(err?.message ?? err)
  .replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
const boardEl = $('#board');

function parseBoard(fen) {
  const squares = {};
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') { file += +ch; continue; }
      squares[FILES[file] + (8 - i)] = ch;
      file++;
    }
  });
  return squares;
}

const livePly = () => state.moves.length;
// The game's ply shown; in a variation, the ply it branches from.
const shownPly = () => (varNode ? varNode.base : viewPly === null ? livePly() : viewPly);
const isLive = () => !varNode && !puzzleView && (viewPly === null || viewPly === livePly());
const mainFen = (ply) => (ply === 0 ? state.startFen : state.moves[ply - 1].fen);
const shownFen = () => (puzzleView ? puzzleView.fen : varNode ? varNode.fen : mainFen(shownPly()));
const lastMoveUci = () => (puzzleView ? puzzleView.lastMove ?? '' : varNode ? varNode.uci : shownPly() > 0 ? state.moves[shownPly() - 1].uci : '');
const lastMoveSan = () => (puzzleView ? puzzleView.lastSan ?? '' : varNode ? varNode.san : shownPly() > 0 ? state.moves[shownPly() - 1].san : '');
// Exploring: moves on the board make variations instead of playing.
const exploring = () => Boolean(state && !puzzleView && !state.active && !state.external?.live);
const canMove = () => $('#promotion').hidden && (puzzleView ? puzzleView.canMove
  : (state.humanToMove && isLive()) || exploring());

// Legal moves of the position shown: the backend's for the live game,
// otherwise asked for once per position.
function legalFor(fen) {
  const known = positionCache.get(fen);
  if (known) return known.legal;
  if (!positionCache.has(fen + '?')) {
    positionCache.set(fen + '?', true);
    api.backend('positionInfo', { fen }).then((info) => {
      positionCache.set(fen, info);
      if (positionCache.size > 4000) positionCache.clear();
      if (shownFen() === fen) renderBoard();
    }).catch(() => positionCache.delete(fen + '?'));
  }
  return [];
}
const movesFrom = (sq) => (state.humanToMove && isLive() ? state.legalMoves : legalFor(shownFen())).filter((m) => m.startsWith(sq));

// ---------------------------------------------------------------------------
// Premoves, as on Lichess: during the engine's turn you can queue a move;
// it is played the moment it becomes your turn, if it is legal then.
// ---------------------------------------------------------------------------
let premove = null; // { from, to }

// Your own game on Lichess, being played on the board.
const playLive = () => Boolean(state?.external?.kind === 'play' && state.external.live);

// The colour of the one human in a game against an engine (or you, in your
// Lichess game).
function humanSide() {
  if (!state?.players) return null;
  if (playLive()) return state.external.side;
  const humans = ['white', 'black'].filter((s) => state.players[s]?.type === 'human');
  const engineSide = ['white', 'black'].find((s) => state.players[s]?.type === 'engine');
  return humans.length === 1 && engineSide ? humans[0] : null;
}
const premoveMode = () => Boolean((state?.active || playLive()) && isLive() && !state.humanToMove && humanSide()
  && state.turn !== humanSide() && $('#promotion').hidden);

function ownPiece(sq, side) {
  const p = parseBoard(shownFen())[sq];
  return Boolean(p) && (p === p.toUpperCase()) === (side === 'white');
}

// Where the piece on sq may go: legal moves on your turn; during the
// engine's turn (a premove), any square not holding one of your pieces.
function targetsFor(sq) {
  if (canMove()) return movesFrom(sq).map((m) => m.slice(2, 4));
  if (premoveMode() && ownPiece(sq, humanSide())) {
    const out = [];
    for (const f of FILES) for (let r = 1; r <= 8; r++) if (!ownPiece(f + r, humanSide()) && f + r !== sq) out.push(f + r);
    return out;
  }
  return [];
}

function setPremove(from, to) {
  premove = { from, to };
  selected = null;
  renderBoard();
}

function clearPremove() {
  if (!premove) return;
  premove = null;
  renderBoard();
}

// Called on every new state: play the premove when it is our turn.
function playPremove() {
  if (!premove) return;
  if (!(state.active || playLive()) || !isLive()) { premove = null; return; }
  if (!state.humanToMove) return;
  const { from, to } = premove;
  premove = null;
  const options = state.legalMoves.filter((m) => m.startsWith(from + to));
  if (!options.length) { renderBoard(); return; }
  const move = options.find((m) => m.endsWith('q')) ?? options[0]; // promotions become queens
  api.backend('move', { uci: move }).catch((err) => { setStatus(errorText(err)); renderBoard(); });
}

// ---------------------------------------------------------------------------
// Drawing on the board, as on Lichess: right-drag for an arrow, right-click
// for a circle; Shift red, Alt blue, both yellow, otherwise green. A left
// click, or another move, clears them.
// ---------------------------------------------------------------------------
let shapes = [];   // { from, to, color }
let shapeDraw = null;
let shapesPly = -1;

const shapeColor = (e) => (e.shiftKey && e.altKey ? 'yellow' : e.shiftKey ? 'red' : e.altKey ? 'blue' : 'green');

function squareCenter(sq) {
  const file = sq.charCodeAt(0) - 97;
  const rank = +sq[1];
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank - 1 : 8 - rank;
  return [col + 0.5, row + 0.5];
}

function renderShapes() {
  const g = $('#shapes');
  if (!g) return;
  if (state && shapesPly !== shownPly()) { shapes = []; shapesPly = shownPly(); }
  const NS = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const all = shapeDraw?.to ? [...shapes, { ...shapeDraw, preview: true }] : shapes;
  g.replaceChildren(...all.map((sh) => {
    const [x1, y1] = squareCenter(sh.from);
    if (sh.from === sh.to) {
      return make('circle', { cx: x1, cy: y1, r: 0.46, class: `shape circle ${sh.color}${sh.preview ? ' preview' : ''}` });
    }
    const [x2, y2] = squareCenter(sh.to);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const k = (len - 0.3) / len;
    return make('line', {
      x1, y1, x2: x1 + (x2 - x1) * k, y2: y1 + (y2 - y1) * k,
      class: `shape arrow ${sh.color}${sh.preview ? ' preview' : ''}`, 'marker-end': `url(#head-${sh.color})`,
    });
  }));
}

function toggleShape(sh) {
  const i = shapes.findIndex((x) => x.from === sh.from && x.to === sh.to);
  if (i >= 0 && shapes[i].color === sh.color) shapes.splice(i, 1);
  else if (i >= 0) shapes[i] = sh;
  else shapes.push(sh);
  shapesPly = state ? shownPly() : -1;
}

boardEl.addEventListener('contextmenu', (e) => e.preventDefault());
boardEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 2) return;
  e.preventDefault();
  // A right click also cancels a premove or a selection.
  if (premove || selected) { premove = null; selected = null; renderBoard(); }
  const sq = e.target.closest('.square')?.dataset.sq;
  if (sq) shapeDraw = { from: sq, to: sq, color: shapeColor(e) };
});
window.addEventListener('pointermove', (e) => {
  if (!shapeDraw) return;
  const sq = squareAt(e.clientX, e.clientY);
  if (sq && sq !== shapeDraw.to) { shapeDraw.to = sq; renderShapes(); }
});
window.addEventListener('pointerup', (e) => {
  if (!shapeDraw || e.button !== 2) return;
  const sh = { from: shapeDraw.from, to: squareAt(e.clientX, e.clientY) ?? shapeDraw.to, color: shapeColor(e) };
  shapeDraw = null;
  toggleShape(sh);
  renderShapes();
});

// ---------------------------------------------------------------------------
// Captured pieces, beside each player: the opponent's pieces they have
// taken in the position shown, and their lead in material.
// ---------------------------------------------------------------------------
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function countPieces(fen) {
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if (t in PIECE_VALUES) counts[ch === t ? 'b' : 'w'][t]++;
  }
  return counts;
}

// Pieces each side has lost since the start of the game. A promoted pawn
// is not a lost pawn: the extra piece it became makes up for it.
function lostPieces(startFen, fen) {
  const start = countPieces(startFen);
  const now = countPieces(fen);
  const lost = {};
  for (const c of ['w', 'b']) {
    lost[c] = {};
    let promoted = 0;
    for (const t of ['n', 'b', 'r', 'q']) promoted += Math.max(0, now[c][t] - start[c][t]);
    for (const t of ['p', 'n', 'b', 'r', 'q']) lost[c][t] = Math.max(0, start[c][t] - now[c][t]);
    lost[c].p = Math.max(0, lost[c].p - promoted);
  }
  const material = (c) => Object.entries(now[c]).reduce((sum, [t, n]) => sum + PIECE_VALUES[t] * n, 0);
  return { lost, diff: material('w') - material('b') };
}

function renderCaptured() {
  const bars = { [flipped ? 'black' : 'white']: '#player-bottom', [flipped ? 'white' : 'black']: '#player-top' };
  const { lost, diff } = state?.startFen && !puzzleView ? lostPieces(state.startFen, shownFen()) : { lost: null, diff: 0 };
  for (const side of ['white', 'black']) {
    const box = $('.captured', $(bars[side]));
    if (!lost) { box.replaceChildren(); continue; }
    // White's bar shows the black pieces White has taken, and so on.
    const taken = lost[side === 'white' ? 'b' : 'w'];
    const groups = [];
    for (const t of ['p', 'n', 'b', 'r', 'q']) {
      if (!taken[t]) continue;
      const group = el('span', { className: 'cap-group' });
      for (let i = 0; i < taken[t]; i++) {
        const img = pieceImage(t, side !== 'white');
        img.className = 'cap-piece';
        img.dataset.type = t;
        group.append(img);
      }
      groups.push(group);
    }
    const lead = side === 'white' ? diff : -diff;
    if (lead > 0) groups.push(el('span', { className: 'cap-lead', textContent: `+${lead}` }));
    box.replaceChildren(...groups);
    const names = ['p', 'n', 'b', 'r', 'q'].filter((t) => taken[t]).map((t) => `${taken[t]} ${PIECE_NAMES[t]}${taken[t] > 1 ? 's' : ''}`);
    box.title = names.length ? `Captured: ${names.join(', ')}${lead > 0 ? ` · ahead by ${lead}` : ''}` : '';
    // A piece still flying here has its place kept empty in the new row.
    for (const flight of typeof capFlights === 'undefined' ? [] : capFlights) {
      if (flight.captor !== side) continue;
      const place = [...box.querySelectorAll('.cap-piece')].filter((img) => img.dataset.type === flight.type).at(-1);
      if (place) { place.style.visibility = 'hidden'; flight.place = place; }
    }
  }
}

// ---------------------------------------------------------------------------
// Move animation: pieces slide from where they were to where they are now,
// and a captured piece fades as the capturing piece arrives.
// ---------------------------------------------------------------------------
const ANIM_SPEEDS = { off: 0, fast: 120, normal: 200, slow: 320 };
let animSpeed = (() => {
  try {
    const saved = localStorage.getItem('animSpeed');
    if (saved in ANIM_SPEEDS) return saved;
  } catch { /* storage unavailable */ }
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'normal';
})();
function setAnimSpeed(speed) {
  animSpeed = speed in ANIM_SPEEDS ? speed : 'normal';
  try { localStorage.setItem('animSpeed', animSpeed); } catch { /* storage unavailable */ }
}
let lastPieces = null;   // the placement drawn last, square → piece
let lastFlipped = false;
let dropped = null;      // a move just dragged into place: no slide for it
let sliding = null;      // the animation under way: { before, start, after }

// Pairs of squares a piece moved between, and the squares where a piece was
// taken, from one placement to the next. Null when too much changed to be a
// move (a new game, a jump through the game), so nothing animates.
function placementChanges(before, after) {
  const gone = [];
  const came = [];
  for (const f of FILES) {
    for (let r = 1; r <= 8; r++) {
      const sq = f + r;
      if (before[sq] === after[sq]) continue;
      if (before[sq]) gone.push(sq);
      if (after[sq]) came.push(sq);
    }
  }
  if (!came.length || came.length > 2 || gone.length > 4) return null;
  const sameColor = (a, b) => (a === a.toUpperCase()) === (b === b.toUpperCase());
  const dist = (a, b) => Math.hypot(a.charCodeAt(0) - b.charCodeAt(0), a[1] - b[1]);
  const moves = [];
  const left = [...gone];
  const take = (to, ok) => {
    let best = -1;
    left.forEach((from, i) => {
      if (ok(before[from]) && (best < 0 || dist(from, to) < dist(left[best], to))) best = i;
    });
    if (best < 0) return false;
    moves.push({ from: left[best], to });
    left.splice(best, 1);
    return true;
  };
  const appeared = [];
  for (const to of came) {
    const p = after[to];
    const white = p === p.toUpperCase();
    // The same piece; a pawn that promoted; going back, a promoted piece
    // turning into its pawn again; else a piece taken back onto the board.
    if (take(to, (q) => q === p) || take(to, (q) => q === (white ? 'P' : 'p'))
      || (/p/i.test(p) && take(to, (q) => sameColor(q, p)))) continue;
    appeared.push(to);
  }
  // What is left was taken: on the square a piece moved to, or en passant.
  if (!moves.length) return null;
  return { moves, captured: left.filter((sq) => before[sq]), appeared };
}

// elapsed: how far into the animation to start, when the board is redrawn
// while pieces are still sliding.
function animateBoard(before, elapsed = 0) {
  const ms = ANIM_SPEEDS[animSpeed];
  if (!ms || !before || lastFlipped !== flipped) return;
  const now = parseBoard(shownFen());
  const change = placementChanges(before, now);
  if (!change) return;
  if (!elapsed) sliding = { before, start: performance.now(), after: now, dropped };
  const run = (node, frames, easing) => {
    const a = node.animate(frames, { duration: ms, easing });
    a.currentTime = elapsed;
    return a;
  };
  const at = (sq) => {
    const file = sq.charCodeAt(0) - 97;
    const rank = +sq[1];
    return [flipped ? 7 - file : file, flipped ? rank - 1 : 8 - rank];
  };
  const layer = $('.pieces', boardEl);
  for (const sq of change.captured) {
    const [col, row] = at(sq);
    const p = before[sq];
    // The taken piece lifts off its square and flies, shrinking, into the
    // captured pieces of the player who took it. (Once per capture: a
    // redraw mid-flight leaves it flying.)
    if (!elapsed && flyCaptured(p, col, row)) continue;
    if (elapsed && document.querySelector('.cap-flyer')) continue;
    // No row to fly to: it stays a moment and fades under the arriving one.
    const ghost = el('div', { className: 'slot fading' }, [pieceImage(p.toLowerCase(), p === p.toUpperCase())]);
    ghost.style.left = col * 12.5 + '%';
    ghost.style.top = row * 12.5 + '%';
    layer.prepend(ghost);
    run(ghost, [{ opacity: 1 }, { opacity: 0 }], 'ease-in').onfinish = () => ghost.remove();
  }
  for (const sq of change.appeared) {
    const slot = $(`.slot[data-sq="${sq}"]`, layer);
    if (slot) run(slot, [{ opacity: 0 }, { opacity: 1 }], 'ease-out');
  }
  const hand = sliding?.dropped;
  for (const { from, to } of change.moves) {
    if (hand && hand.from === from && hand.to === to) continue; // already put there by hand
    const slot = $(`.slot[data-sq="${to}"]`, layer);
    if (!slot) continue;
    const [fc, fr] = at(from);
    const [tc, tr] = at(to);
    slot.classList.add('moving');
    run(slot, [
      { transform: `translate(${(fc - tc) * 100}%, ${(fr - tr) * 100}%)` },
      { transform: 'none' },
    ], 'cubic-bezier(.25, .8, .35, 1)').onfinish = () => slot.classList.remove('moving');
  }
}

// Sends a captured piece from its square (col, row on the board as shown) to
// its place among the captor's captured pieces. False when there is no such
// place (a puzzle, no game), so the caller fades it instead.
const capFlights = new Set(); // pieces in the air: { captor, type, place }
function flyCaptured(piece, col, row) {
  const white = piece === piece.toUpperCase();
  const type = piece.toLowerCase();
  // White's pieces are taken by Black, and shown on Black's bar.
  const captor = white ? 'black' : 'white';
  const bar = $(captor === (flipped ? 'black' : 'white') ? '#player-bottom' : '#player-top');
  // Its place in the row: the last piece of its kind there (just added).
  const kind = PIECE_NAMES[type];
  const places = [...bar.querySelectorAll('.cap-piece')].filter((img) => img.dataset.type === type);
  const place = places.at(-1);
  const board = boardEl.getBoundingClientRect();
  if (!place || !board.width || !kind) return false;
  const size = board.width / 8;
  const flyer = pieceImage(type, white);
  flyer.className = 'cap-flyer';
  flyer.alt = '';
  Object.assign(flyer.style, { left: `${board.left + col * size}px`, top: `${board.top + row * size}px`, width: `${size}px`, height: `${size}px` });
  document.body.append(flyer);
  const to = place.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (board.left + (col + 0.5) * size);
  const dy = to.top + to.height / 2 - (board.top + (row + 0.5) * size);
  const scale = Math.max(0.12, to.width / size);
  // The place stays empty until the piece lands in it (also when the row
  // is drawn again meanwhile: renderCaptured keeps it hidden).
  const flight = { captor, type, place };
  capFlights.add(flight);
  place.style.visibility = 'hidden';
  const land = () => { flyer.remove(); flight.place.style.visibility = ''; capFlights.delete(flight); };
  const ms = Math.max(450, Math.min(900, ANIM_SPEEDS[animSpeed] * 3.2));
  // It spins on the way: two full turns, toward the side it flies to, to
  // land upright (not when the system asks for less motion).
  const turn = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : (dx < 0 ? -720 : 720);
  const anim = flyer.animate([
    { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1, offset: 0 },
    { transform: `translate(0, ${-size * 0.38}px) scale(1.14) rotate(${turn * 0.12}deg)`, opacity: 1, offset: 0.3, easing: 'cubic-bezier(.5, 0, .3, 1)' },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${turn}deg)`, opacity: 0.35, offset: 1 },
  ], { duration: ms, easing: 'cubic-bezier(.2, .7, .3, 1)' });
  anim.onfinish = land;
  anim.oncancel = land;
  setTimeout(land, ms + 200);
  return true;
}

// Pieces under attack: for each piece, how many enemy pieces could capture
// it less how many of its own side guard it (by how the pieces move; a
// pinned piece still counts, one lined up behind another does not). Only
// pieces with more attackers than defenders are in the result, each with
// { net, attackers, defenders }.
// Glassify board: translucent squares over a wash of colour, and pieces of
// glass (a bright rim, a sheen across the top). Off by default.
let glassBoard = (() => { try { return localStorage.getItem('glassBoard') === 'on'; } catch { return false; } })();
document.body.classList.toggle('glass-board', glassBoard);
// 3D board: board3d.js draws the board and pieces in 3D over this one.
let board3dOn = (() => { try { return localStorage.getItem('board3d') === 'on'; } catch { return false; } })();
function setBoard3d(on, { save = true } = {}) {
  const ok = window.board3d ? window.board3d.setActive(on) : !on;
  board3dOn = Boolean(on) && ok !== false;
  if (save) try { localStorage.setItem('board3d', board3dOn ? 'on' : 'off'); } catch { /* storage unavailable */ }
  if ($('#board-3d')) $('#board-3d').checked = board3dOn;
}
// board3d.js is a module: it runs after this script, and says when it is there.
if (window.board3d) setBoard3d(board3dOn, { save: false });
else window.addEventListener('board3d-ready', () => setBoard3d(board3dOn, { save: false }), { once: true });
let attackMarks = (() => { try { return localStorage.getItem('attackMarks') !== 'off'; } catch { return true; } })();
function attackCounts(pieces) {
  const at = (f, r) => (f >= 0 && f < 8 && r >= 1 && r <= 8 ? pieces[FILES[f] + r] : undefined);
  const all = {};
  const hit = (f, r, white) => {
    const target = at(f, r);
    if (!target) return;
    const c = all[FILES[f] + r] ??= { attackers: 0, defenders: 0 };
    if ((target === target.toUpperCase()) !== white) c.attackers++;
    else c.defenders++;
  };
  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const LINE = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [sq, piece] of Object.entries(pieces)) {
    const f = FILES.indexOf(sq[0]);
    const r = +sq[1];
    const white = piece === piece.toUpperCase();
    const slide = (dirs) => {
      for (const [df, dr] of dirs) {
        for (let x = f + df, y = r + dr; x >= 0 && x < 8 && y >= 1 && y <= 8; x += df, y += dr) {
          if (at(x, y)) { hit(x, y, white); break; }
        }
      }
    };
    switch (piece.toLowerCase()) {
      case 'p': hit(f - 1, r + (white ? 1 : -1), white); hit(f + 1, r + (white ? 1 : -1), white); break;
      case 'n': for (const [df, dr] of KNIGHT) hit(f + df, r + dr, white); break;
      case 'k': for (const [df, dr] of [...DIAG, ...LINE]) hit(f + df, r + dr, white); break;
      case 'b': slide(DIAG); break;
      case 'r': slide(LINE); break;
      case 'q': slide([...DIAG, ...LINE]); break;
      default:
    }
  }
  const counts = {};
  for (const [sq, c] of Object.entries(all)) {
    if (c.attackers > c.defenders) counts[sq] = { ...c, net: c.attackers - c.defenders };
  }
  return counts;
}

function renderBoard() {
  renderCaptured();
  const before = lastPieces;
  const pieces = parseBoard(shownFen());
  const last = lastMoveUci();
  // Dots for legal moves; none for a premove (anything goes until it is played).
  const targets = selected && canMove() ? targetsFor(selected) : [];
  const turnKing = shownFen().split(' ')[1] === 'w' ? 'K' : 'k';
  const inCheck = /[+#]$/.test(lastMoveSan());

  const attacked = attackMarks ? attackCounts(pieces) : {};
  const nodes = [];
  const slots = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row + 1 : 8 - row;
      const sq = FILES[file] + rank;
      const piece = pieces[sq];
      const node = el('div', { className: 'square ' + ((file + rank) % 2 ? 'dark' : 'light') });
      node.dataset.sq = sq;
      if (sq === last.slice(0, 2) || sq === last.slice(2, 4)) node.classList.add('last');
      if (sq === selected) node.classList.add('selected');
      if (premove && (sq === premove.from || sq === premove.to)) node.classList.add('premove');
      if (targets.includes(sq)) node.classList.add(piece ? 'capture' : 'target');
      if (inCheck && piece === turnKing) node.classList.add('check');
      if (col === 0) node.append(el('span', { className: 'coord rank', textContent: rank }));
      if (row === 7) node.append(el('span', { className: 'coord file', textContent: FILES[file] }));
      if (piece) {
        const white = piece === piece.toUpperCase();
        // Pieces sit in their own layer above the squares so that a glow can
        // spill over neighbouring squares.
        const slot = el('div', { className: 'slot' }, [pieceImage(piece.toLowerCase(), white)]);
        slot.dataset.sq = sq;
        slot.style.left = col * 12.5 + '%';
        slot.style.top = row * 12.5 + '%';
        if (attacked[sq]) {
          const { net: n, attackers, defenders } = attacked[sq];
          const mark = el('span', { className: 'attack-mark' + (n > 1 ? ' many' : ''),
            title: `${attackers} attacking, ${defenders} defending: ${n} more attacker${n === 1 ? '' : 's'} than defenders` });
          mark.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 1v3.2M8 11.8V15M1 8h3.2M11.8 8H15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
          mark.append(el('b', { textContent: `+${n}` }));
          mark.setAttribute('aria-label', mark.title);
          slot.append(mark);
        }
        slots.push(slot);
        node.classList.add('occupied');
      }
      nodes.push(node);
    }
  }
  boardEl.replaceChildren(
    el('div', { className: 'squares' }, nodes),
    el('div', { className: 'pieces' }, slots),
  );
  // Slide what moved since the last drawing. Drawing the same position again
  // (a selection, legal moves arriving) carries on with any slide under way.
  const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((sq) => a[sq] === b[sq]);
  if (before && !same(before, pieces)) {
    sliding = null;
    animateBoard(before);
    dropped = null;
  } else if (sliding && same(sliding.after, pieces)) {
    const elapsed = performance.now() - sliding.start;
    if (elapsed < ANIM_SPEEDS[animSpeed]) animateBoard(sliding.before, elapsed);
    else sliding = null;
  }
  lastPieces = pieces;
  lastFlipped = flipped;
  boardEl.classList.toggle('movable', canMove() || premoveMode());
  // Ask for the legal moves ahead of the first click.
  if (puzzleView || exploring()) legalFor(shownFen());
  renderShapes();
  window.explorerFollow?.();
  window.board3d?.sync(); // the 3D board, when it is on, copies this one
}

function squareAt(x, y) {
  // The 3D board covers this one: the square under the pointer there.
  if (window.board3d?.active) return window.board3d.squareAt(x, y);
  return document.elementFromPoint(x, y)?.closest('.square')?.dataset.sq ?? null;
}

boardEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state) return;
  if (shapes.length) { shapes = []; renderShapes(); }
  if (!canMove() && !premoveMode()) return;
  const sq = e.target.closest('.square')?.dataset.sq;
  if (!sq) return;
  if (selected && selected !== sq && targetsFor(selected).includes(sq)) {
    moveOrPremove(selected, sq);
    return;
  }
  if (premove && !ownPiece(sq, humanSide())) { clearPremove(); return; }
  if (targetsFor(sq).length === 0) {
    if (selected && sq !== selected) sounds.play('illegal');
    selected = null;
    renderBoard();
    return;
  }
  const wasSelected = selected === sq;
  selected = sq;
  renderBoard();
  drag = { from: sq, x: e.clientX, y: e.clientY, ghost: null, wasSelected };
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    const piece = $(`.slot[data-sq="${drag.from}"] .piece`);
    if (!piece) { drag = null; return; }
    drag.ghost = piece.cloneNode(true);
    drag.ghost.classList.add('ghost');
    drag.ghost.style.height = piece.getBoundingClientRect().height + 'px';
    document.body.append(drag.ghost);
    piece.classList.add('lifted');
  }
  drag.ghost.style.left = e.clientX + 'px';
  drag.ghost.style.top = e.clientY + 'px';
});

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { from, ghost, wasSelected } = drag;
  drag = null;
  if (!ghost) {
    // A plain click: clicking the selected piece again deselects it.
    if (wasSelected) { selected = null; renderBoard(); }
    return;
  }
  ghost.remove();
  const to = squareAt(e.clientX, e.clientY);
  if (to && to !== from && targetsFor(from).includes(to)) {
    dropped = { from, to };
    moveOrPremove(from, to);
  } else {
    if (to && to !== from) sounds.play('illegal');
    selected = null;
    renderBoard();
  }
});

function moveOrPremove(from, to) {
  if (canMove()) tryMove(from, to);
  else if (premoveMode()) setPremove(from, to);
}

async function tryMove(from, to) {
  const options = movesFrom(from).filter((m) => m.startsWith(from + to));
  selected = null;
  let move = options[0];
  if (options.length > 1) {
    renderBoard();
    const promo = await askPromotion(to, shownFen().split(' ')[1] === 'w');
    if (!promo) return;
    move = from + to + promo;
  }
  if (puzzleView) { puzzleMove(move); return; }
  if (exploring()) { explore(move); return; }
  try {
    await api.backend('move', { uci: move });
  } catch (err) {
    setStatus(errorText(err));
    renderBoard();
  }
}

function askPromotion(sq, white) {
  const box = $('#promotion');
  return new Promise((resolve) => {
    const done = (value) => {
      box.hidden = true;
      box.replaceChildren();
      renderBoard();
      resolve(value);
    };
    const buttons = ['q', 'r', 'b', 'n'].map((p) => {
      const b = el('button', { type: 'button', title: PIECE_NAMES[p] }, [pieceImage(p, white)]);
      b.onclick = () => done(p);
      return b;
    });
    const cancel = el('button', { type: 'button', className: 'cancel', textContent: 'Cancel' });
    cancel.onclick = () => done(null);
    box.replaceChildren(el('div', { className: 'choices' }, [...buttons, cancel]));
    box.hidden = false;
    boardEl.classList.remove('movable');
  });
}

// ---------------------------------------------------------------------------
// Players, clocks, status
// ---------------------------------------------------------------------------
function formatClock(ms) {
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  const mm = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(mm).padStart(2, '0')}:${ss}`;
  if (total < 20000) return `${mm}:${ss}.${Math.floor((total % 1000) / 100)}`;
  return `${mm}:${ss}`;
}

// A side's Lichess username, for their flag: the Lichess game being played
// or watched, or a game from a file that was played on Lichess (its Site),
// whose names are then Lichess usernames. '' when there is none.
function lichessUser(side) {
  const live = state?.external?.users?.[side];
  if (live) return live;
  const tags = state?.tags ?? [];
  const tag = (n) => tags.find((t) => t.name === n)?.value ?? '';
  if (!/lichess\.org/i.test(tag('Site'))) return '';
  const name = tag(side === 'white' ? 'White' : 'Black');
  return name && name !== '?' ? name : '';
}

function renderPlayers() {
  const bottom = flipped ? 'black' : 'white';
  const top = flipped ? 'white' : 'black';
  for (const [id, side] of [['#player-top', top], ['#player-bottom', bottom]]) {
    const box = $(id);
    const player = state.players?.[side];
    box.dataset.side = side;
    $('.name', box).textContent = player ? player.name : side === 'white' ? 'White' : 'Black';
    // The country flag of a Lichess player, before the name.
    const flagBox = $('.pflag', box);
    const code = typeof flagFor === 'function' ? flagFor(lichessUser(side)) : '';
    const emoji = code ? flagEmoji(code) : '';
    flagBox.hidden = !emoji;
    flagBox.textContent = emoji;
    flagBox.title = emoji ? flagName(code) : '';
    let kind = side;
    if (player?.type === 'engine' || player?.type === 'human' || player?.type === 'lichess') kind += ' · ' + player.type;
    if (player?.rating) kind += ' · ' + player.rating;
    const rd = state.external?.ratingDiff?.[side];
    if (player?.rating && rd != null) kind += ` ${ratingDelta(rd)}`;
    $('.kind', box).textContent = kind;
    // After the game, each side's score: 1, 0 or ½.
    const over = state.result && state.result !== '*' && !state.active && !state.external?.live;
    const chip = $('.score-chip', box);
    chip.hidden = !over;
    if (over) {
      const pt = state.result === '1/2-1/2' ? '½' : (state.result === '1-0') === (side === 'white') ? '1' : '0';
      chip.textContent = pt;
      chip.className = 'score-chip' + (pt === '1' ? ' won' : '');
      chip.title = pt === '1' ? 'Won' : pt === '0' ? 'Lost' : 'Drawn';
    }
    const live = Boolean(state.external?.live);
    box.classList.toggle('to-move', (state.active || live) && state.turn === side);
    // Game actions: each person resigns from their own bar; Draw (between
    // two people) and Abort sit on the bar nearest you. None show unless a
    // game is being played.
    const nearest = id === '#player-bottom';
    const humans = ['white', 'black'].filter((s) => state.players?.[s]?.type === 'human').length;
    // In a Lichess game on the board, the bot resigns or aborts from its
    // bar; in your own Lichess game, you do (and offer draws, ask for takebacks).
    const ours = live && ((state.external.kind === 'bot' && player?.type === 'engine')
      || (state.external.kind === 'play' && side === state.external.side));
    const play = ours && state.external.kind === 'play';
    const offers = play ? window.playGameOnBoard?.() : null;
    $('.resign', box).hidden = !((state.active && player?.type === 'human') || ours);
    $('.resign', box).dataset.side = side;
    $('.draw', box).hidden = !((state.active && nearest && humans === 2) || (play && !offers?.draw));
    $('.draw', box).title = play ? 'Offer a draw' : 'Agree a draw';
    $('.abort', box).hidden = !((state.active && nearest) || (ours && state.moves.length < 2));
    $('.takeback', box).hidden = !(state.canTakeback && player?.type === 'human' && (humans === 1 || nearest) && !offers?.takeback);
    $('.takeback', box).title = play ? 'Ask your opponent to take back your last move' : 'Take back your last move';
    // An engine in a game played here can be swapped or reloaded mid-game.
    const loading = Boolean(state.loading?.includes(side));
    const swap = $('.engine', box);
    swap.hidden = !(state.active && !state.external && player?.type === 'engine');
    swap.dataset.side = side;
    swap.disabled = loading;
    swap.textContent = loading ? '⇄ Starting…' : '⇄ Engine';
    if (loading) $('.kind', box).textContent = `${side} · engine starting…`;
  }
  renderClocks();
  window.renderPlayOffer?.();
  window.markPlayerNames?.();
}

function renderClocks() {
  if (!state) return;
  for (const box of document.querySelectorAll('.player')) {
    const side = box.dataset.side;
    const clock = state.clocks?.[side];
    const out = $('.clock', box);
    if (!clock || !clock.timed) {
      out.textContent = '';
      out.classList.remove('low', 'running');
      continue;
    }
    let ms = clock.ms;
    const running = state.running === side;
    if (running) ms -= performance.now() - stateAt;
    if (running) checkLowTime(side, ms);
    out.textContent = formatClock(ms);
    out.classList.toggle('running', running);
    out.classList.toggle('low', ms < 20000);
  }
}
setInterval(renderClocks, 100);

// Warn once when a person's clock drops below LOW_TIME_MS; again only after
// an increment or a new time control lifts it back above.
const LOW_TIME_MS = 10000;
let lowTime = {};
function checkLowTime(side, ms) {
  const player = state.players?.[side];
  if (player?.type !== 'human' || (player.timeControl?.kind !== 'clock' && !playLive())) return;
  if (ms >= LOW_TIME_MS) lowTime[side] = false;
  else if (lowTime[side] === false && ms > 0) {
    lowTime[side] = true;
    sounds.play('lowtime');
    window.announcer?.onLowTime(side);
  }
}

function setStatus(text) {
  $('#status').textContent = text;
}

function renderStatus() {
  if (!state.players) {
    setStatus('Start a new game to play.');
  } else if (state.external?.live) {
    const player = state.players[state.turn];
    const side = state.turn === 'white' ? 'White' : 'Black';
    const who = player.type === 'engine' ? `${player.name} is thinking…` : `${side} (${player.name}) to move`;
    setStatus(`${state.external.label} — ${who}${state.check ? ' — check' : ''}`);
  } else if (!state.active) {
    const outcome = state.result === '*' ? state.reason : `${state.reason} · ${state.result}`;
    let source = state.source;
    if (state.loaded && collection?.source === state.source && collection.total > 1) {
      source += ` · game ${(state.index + 1).toLocaleString()} of ${collection.total.toLocaleString()}`;
    }
    if (state.external) setStatus(`${state.external.label} — ${outcome}`);
    else setStatus(state.loaded && source ? `${source} — ${outcome}` : outcome);
  } else {
    const player = state.players[state.turn];
    const side = state.turn === 'white' ? 'White' : 'Black';
    setStatus(player.type === 'engine' ? `${player.name} is thinking…` : `${side} to move${state.check ? ' — check' : ''}`);
  }
  $('#btn-pgn').disabled = $('#btn-export').disabled = !state.players;
}

// ---------------------------------------------------------------------------
// Move list and history browsing
// ---------------------------------------------------------------------------
// The moves, one row per move number as on Lichess: number, White's move,
// Black's move. With a computer analysis, mistakes carry ?! ? ?? and a
// comment row with the better move, and the result ends the list.
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// What the Moves tab shows before there are moves: a way into each part
// of the app, a box to paste a game or a position, and the latest games
// in the open file (the game database, usually).
const START_ICONS = {
  new: '<path d="M12 5v14M5 12h14"/>',
  lichess: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  puzzles: '<path d="M10 3h4v3a2 2 0 1 0 4 0h3v5h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4V6h6z"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  explorer: '<path d="M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/>',
  analysis: '<path d="M3 17l5-5 4 4 8-8M14 8h6v6"/>',
};
function startScreen() {
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${START_ICONS[name]}</g>`;
    return svg;
  };
  const tile = (name, title, sub, run, primary = false) => {
    const b = el('button', { type: 'button', className: 'ms-tile' + (primary ? ' ms-main' : '') }, [
      el('span', { className: 'ms-icon' }, [icon(name)]),
      el('span', { className: 'ms-text' }, [el('b', { textContent: title }), el('span', { textContent: sub })]),
    ]);
    b.onclick = run;
    return b;
  };
  const tiles = el('div', { className: 'ms-tiles' }, [
    tile('new', 'New game', 'Play an engine, a friend, or watch two engines', () => $('#btn-new').click(), true),
    tile('lichess', 'Lichess', 'Play online, watch TV, or run your bot', () => showTab('lichess')),
    tile('puzzles', 'Puzzles', 'Train tactics at your rating', () => showTab('puzzles')),
    tile('explorer', 'Openings', 'Explore what masters and Lichess play', () => showTab('explorer')),
    tile('open', 'Open PGN', 'Load games from a file', () => openPgn()),
    tile('analysis', 'Analyse', 'Turn on the engine and move freely', () => { if ($('#btn-analysis').getAttribute('aria-pressed') !== 'true') $('#btn-analysis').click(); }),
  ]);

  const input = el('textarea', { className: 'ms-paste-text', rows: 2, spellcheck: false, placeholder: 'Paste a PGN or a FEN' });
  const load = el('button', { type: 'button', className: 'small', textContent: 'Load', disabled: true });
  const note = el('p', { className: 'ms-note', hidden: true });
  input.oninput = () => { load.disabled = !input.value.trim(); note.hidden = true; };
  input.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !load.disabled) load.click(); };
  load.onclick = async () => {
    load.disabled = true;
    const err = await loadPastedText(input.value);
    if (err) {
      note.textContent = err;
      note.hidden = false;
      load.disabled = false;
    }
  };
  const paste = el('div', { className: 'ms-card ms-paste' }, [
    el('div', { className: 'ms-head' }, [el('b', { textContent: 'Paste a game' }), el('span', { textContent: '⌘/Ctrl+Enter' })]),
    el('div', { className: 'ms-paste-row' }, [input, load]),
    note,
  ]);

  const recent = el('div', { className: 'ms-card ms-recent', hidden: true });
  fillRecentGames(recent);
  return el('div', { className: 'ms' }, [
    el('p', { className: 'ms-hint', textContent: 'Move a piece on the board to start analysing, or:' }),
    tiles, recent, paste,
  ]);
}

// A game (PGN) or a position (FEN) from the clipboard or the start screen,
// put on the board. Returns what went wrong, or '' when it is on the board.
async function loadPastedText(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'There is nothing to paste: copy a PGN or a FEN first.';
  // A FEN is one line of six fields (or four) starting with the ranks.
  const fen = /^[1-8pnbrqkPNBRQK]+(\/[1-8pnbrqkPNBRQK]+){7}\s+[wb]\s/.test(text) && !text.includes('\n');
  if (state?.active && !state.external && !(await confirmDialog('Put this on the board? The game you are playing will be abandoned.', 'Load'))) return '';
  const pgn = fen ? `[SetUp "1"]\n[FEN "${text.replace(/"/g, '')}"]\n[Result "*"]\n\n*\n` : text;
  try {
    await api.backend('loadPgnText', { pgn, source: fen ? 'Position' : 'Pasted game' });
    return '';
  } catch (err) {
    return fen ? `That position could not be set up: ${errorText(err)}` : `That is not a game Ponder can read: ${errorText(err)}`;
  }
}

// The latest games of the open file, newest first. Fetched again only
// when the file or its number of games changes.
async function fillRecentGames(card) {
  if (!collection) return;
  const key = `${collection.path}:${collection.total}`;
  if (fillRecentGames.key !== key) {
    fillRecentGames.key = key;
    fillRecentGames.games = api.backend('listGames', { filter: '', limit: 5, sort: 'index', desc: true })
      .then((list) => list?.games ?? [], () => []);
  }
  const games = await fillRecentGames.games;
  if (!games.length || !card.isConnected) return;
  const results = { '1-0': '1–0', '0-1': '0–1', '1/2-1/2': '½–½' };
  const name = (n, g) => {
    const span = el('span', { className: 'ms-player', textContent: n || '?' });
    const flag = g.lichess && n ? flagSpan(n) : null;
    if (flag) span.prepend(flag);
    return span;
  };
  const isDb = database?.path && collection.path === database.path;
  card.replaceChildren(
    el('div', { className: 'ms-head' }, [
      el('b', { textContent: isDb ? 'Recent games' : `Latest in ${collection.source}` }),
      Object.assign(el('button', { type: 'button', className: 'ms-link', textContent: 'All games' }), { onclick: () => showTab('games') }),
    ]),
    ...games.map((g) => {
      const row = el('button', { type: 'button', className: 'ms-game' }, [
        el('span', { className: 'ms-players' }, [name(g.white, g), el('span', { className: 'ms-vs', textContent: 'vs' }), name(g.black, g)]),
        el('b', { className: 'ms-res', textContent: results[g.result] ?? '*' }),
        el('span', { className: 'ms-date', textContent: (g.date ?? '').replace(/\.\?\?/g, '').replace(/^\?+$/, '') }),
      ]);
      row.onclick = () => selectGame(g.index);
      return row;
    }),
  );
  card.hidden = false;
}

function renderMoves() {
  const box = $('#moves');
  const [, turn, , , , fullmove] = state.startFen.split(' ');
  let number = +fullmove || 1;
  let whiteNext = turn === 'w';
  const review = window.currentReview?.() ?? null;
  const nodes = [];
  let open = false; // a row waiting for Black's move
  const ply = shownPly();
  const num = () => el('span', { className: 'num', textContent: number });
  const empty = (text = '') => el('span', { className: 'move empty', textContent: text });
  // The annotation of the move shown opens up: larger, and easier to read.
  // It grows into place when the move is gone to, not each time the list
  // is drawn again (typing a comment draws it at every key).
  const at = `${state.game}:${ply}:${varNode ? varNode.fen : ''}`;
  const arrived = at !== renderMoves.at;
  renderMoves.at = at;
  const shown = (row, on) => { if (on) row.classList.add('current', ...(arrived ? ['opening'] : [])); return row; };
  if (notes.before?.comment) nodes.push(shown(commentRow(notes.before.comment, '', 'div', 'comment user', Boolean(notes.before.ai)), ply === 0 && !varNode));
  state.moves.forEach((move, i) => {
    const white = whiteNext;
    if (white) nodes.push(num());
    else if (!open) nodes.push(num(), empty('…')); // Black first, or after a comment
    const j = review?.judgments?.[i];
    const node = el('button', { type: 'button', className: 'move' }, sanLabel(move.san, white));
    const a = notes.moves.get(i + 1);
    // Your own mark on the move stands in for the computer's.
    if (a?.nag || a?.pos) node.append(...annGlyphs(a));
    // The colour of the move's annotation: your mark, else the computer's.
    const kind = NAG_KIND[a?.nag] ?? j?.kind ?? '';
    if (a?.nag) node.classList.add(kind);
    if (j?.glyph && !a?.nag) {
      node.append(el('span', { className: `glyph ${j.kind}`, textContent: j.glyph }));
      node.classList.add(j.kind);
    }
    const score = scoreElement(i + 1, review);
    if (score) node.append(score);
    if (i + 1 === ply && !varNode) node.classList.add('current');
    else if (i + 1 === ply && varNode) node.classList.add('branch');
    node.onclick = () => showPly(i + 1);
    nodes.push(node);
    open = white;
    const alts = tree.branches.get(i);
    if (j?.kind || alts?.length || a?.comment) {
      if (white) nodes.push(empty());
      open = false;
    }
    if (a?.comment) nodes.push(shown(commentRow(a.comment, kind, 'div', 'comment user', Boolean(a.ai)), i + 1 === ply && !varNode));
    if (j?.kind && !a?.comment) { // a comment on the move says it already
      const kind = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[j.kind];
      const comment = shown(el('div', { className: `comment ${j.kind}` }, [el('b', { textContent: kind + '.' })]), i + 1 === ply && !varNode);
      if (j.best) {
        const best = el('button', { type: 'button', className: 'best', title: 'Show the position before this move' }, sanLabel(j.best, white));
        best.onclick = () => showPly(i);
        comment.append(' ', best, ' was best.');
      }
      nodes.push(comment);
      open = false;
    }
    if (alts?.length) nodes.push(variationBlock(alts));
    if (!white) number++;
    whiteNext = !white;
  });
  if (open) nodes.push(el('span', { className: 'move empty' }));
  // Lines that continue after the last move.
  const after = tree.branches.get(state.moves.length);
  if (after?.length) nodes.push(variationBlock(after));
  if (state.result && state.result !== '*' && !state.active && !state.external?.live) {
    nodes.push(el('div', { className: 'result-row' }, [
      el('b', { textContent: state.result.replace('1/2-1/2', '½-½') }),
      el('span', { textContent: state.reason ?? '' }),
    ]));
  }
  // Nothing to list yet: ways to begin, in place of an empty list.
  const blank = !nodes.length && !state.active && !state.external && state.startFen === START_FEN;
  box.classList.toggle('start', blank);
  if (blank) nodes.push(startScreen());
  box.replaceChildren(...nodes);
  if (!blank) (box.querySelector('.move.current, .vmove.current') ?? box.lastElementChild)?.scrollIntoView({ block: 'nearest' });
  $('#nav-first').disabled = $('#nav-prev').disabled = ply === 0 && !varNode;
  $('#nav-next').disabled = varNode ? !varNode.children.length : ply === livePly();
  $('#nav-last').disabled = ply === livePly() && !varNode;
  window.renderReview?.();
  window.renderAnnotate?.();
  window.autosaveAnnotations?.();
}

function showPly(ply) {
  if (!state) return;
  if (puzzleView) window.leavePuzzle?.();
  ply = Math.max(0, Math.min(livePly(), ply));
  if (ply === shownPly() + 1 && !varNode) sounds.play(moveSound(state.moves[ply - 1]));
  varNode = null;
  viewPly = ply === livePly() ? null : ply;
  selected = null;
  renderOpening();
  renderBoard();
  renderMoves();
  syncAnalysis();
  renderAnalysis();
}

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------
function goNode(node) {
  if (!node) return;
  if (node !== varNode) sounds.play(moveSound(node));
  varNode = node;
  viewPly = node.base;
  selected = null;
  renderOpening();
  renderBoard();
  renderMoves();
  syncAnalysis();
  renderAnalysis();
}

function stepBack() {
  if (puzzleView) return;
  if (varNode) {
    if (varNode.parent) goNode(varNode.parent);
    else showPly(varNode.base);
  } else showPly(shownPly() - 1);
}

function stepForward() {
  if (puzzleView) return;
  if (varNode) { if (varNode.children[0]) goNode(varNode.children[0]); } else showPly(shownPly() + 1);
}

// A move played on the board while exploring: follow the game or an
// existing line if it is the same move, otherwise start a new line.
async function explore(uci) {
  const fen = shownFen();
  let siblings;
  let parent = null;
  let base;
  if (varNode) {
    parent = varNode;
    siblings = varNode.children;
    base = varNode.base;
  } else {
    base = shownPly();
    if (base < livePly() && state.moves[base].uci === uci) { showPly(base + 1); return; }
    siblings = tree.branches.get(base) ?? [];
  }
  const existing = siblings.find((n) => n.uci === uci);
  if (existing) { goNode(existing); return; }
  let r;
  try {
    r = await api.backend('applyMove', { fen, uci });
  } catch (err) {
    setStatus(errorText(err));
    return;
  }
  if (shownFen() !== fen) return; // moved on meanwhile
  const node = { uci: r.uci, san: r.san, fen: r.fen, opening: r.opening ?? '', parent, base, children: [],
    ply: (parent ? parent.ply : base) + 1 };
  siblings.push(node);
  if (!parent) tree.branches.set(base, siblings);
  // A line tried on the board is not saved by itself: it waits for Save
  // (or for a comment or mark on one of its moves, which keeps it).
  notes.loose = true;
  goNode(node);
}

// Adds a line of moves (UCI) as a side variation at ply base, without
// going into it; note and mark label it in the moves list (e.g. the
// solution of a test position, and what the engine played instead).
async function addLine(base, ucis, note = '', mark = '') {
  let fen = base === 0 ? state.startFen : state.moves[base - 1]?.fen;
  if (!fen || !ucis.length) return null;
  const game = state.game;
  const siblings = tree.branches.get(base) ?? [];
  let first = siblings.find((n) => n.uci === ucis[0]);
  let parent = null;
  for (const uci of ucis) {
    const list = parent ? parent.children : siblings;
    let node = list.find((n) => n.uci === uci);
    if (!node) {
      let r;
      try { r = await api.backend('applyMove', { fen, uci }); } catch { break; }
      if (state.game !== game) return null; // another game meanwhile
      node = { uci: r.uci, san: r.san, fen: r.fen, opening: r.opening ?? '', parent, base, children: [], ply: (parent ? parent.ply : base) + 1 };
      list.push(node);
    }
    first ??= node;
    parent = node;
    fen = node.fen;
  }
  if (!first) return null;
  if (note) { first.note = note; first.mark = mark; }
  tree.branches.set(base, siblings);
  renderMoves();
  return first;
}

// Removes a whole line (from its first move).
function deleteLine(node) {
  const list = node.parent ? node.parent.children : tree.branches.get(node.base);
  const i = list?.indexOf(node) ?? -1;
  if (i < 0) return;
  list.splice(i, 1);
  notes.loose = true; // a line taken off: written at the next save
  if (!node.parent && !list.length) tree.branches.delete(node.base);
  // Leave the line if we are in it.
  for (let n = varNode; n; n = n.parent) {
    if (n === node) { if (node.parent) goNode(node.parent); else showPly(node.base); return; }
  }
  renderMoves();
}

// Move number and colour of a ply (1 = the first move of the game).
function plyNumber(ply) {
  const [, turn, , , , fullmove] = state.startFen.split(' ');
  const idx = ply - 1 + (turn === 'b' ? 1 : 0);
  return { n: (+fullmove || 1) + Math.floor(idx / 2), white: idx % 2 === 0 };
}

// A line as elements: moves with numbers, sub-lines in parentheses.
function lineElements(first) {
  const out = [];
  const move = (node, numbered) => {
    const { n, white } = plyNumber(node.ply);
    if (white || numbered) out.push(el('span', { className: 'vnum', textContent: white ? `${n}.` : `${n}…` }));
    const b = el('button', { type: 'button', className: 'vmove' + (node === varNode ? ' current' : '') }, [...sanLabel(node.san, white), ...annGlyphs(node.ann)]);
    b.onclick = () => goNode(node);
    out.push(b);
    if (node.ann?.comment) {
      const row = commentRow(node.ann.comment, NAG_KIND[node.ann.nag] ?? '', 'span', 'vcomment');
      if (node === varNode) row.classList.add('current');
      out.push(row);
    }
    return Boolean(node.ann?.comment);
  };
  let renumber = move(first, true);
  let cur = first;
  while (cur.children.length) {
    const [main, ...alts] = cur.children;
    renumber = move(main, renumber);
    for (const alt of alts) {
      out.push(el('span', { className: 'vsub' }, ['(', ...lineElements(alt), ')']));
      renumber = true;
    }
    cur = main;
  }
  return out;
}

// The same line as PGN text.
// kept: only the moves that are the game's to keep (node.keep: from its
// file, annotated, or saved by hand), not lines merely tried on the board.
function lineText(first, kept = false) {
  const out = [];
  const move = (node, numbered) => {
    const { n, white } = plyNumber(node.ply);
    if (white) out.push(`${n}.`);
    else if (numbered) out.push(`${n}...`);
    out.push(node.san);
    const a = node.ann;
    for (const nag of [a?.nag, a?.pos, ...(a?.other ?? [])]) if (nag) out.push(`$${nag}`);
    const text = [a?.cmds, a?.comment].filter(Boolean).join(' ').replace(/[{}]/g, '').trim();
    if (text) out.push(`{ ${text} }`);
    return Boolean(text);
  };
  let renumber = move(first, true);
  let cur = first;
  for (;;) {
    const next = kept ? cur.children.filter((c) => c.keep) : cur.children;
    if (!next.length) break;
    const [main, ...alts] = next;
    renumber = move(main, renumber);
    for (const alt of alts) { out.push(`(${lineText(alt, kept)})`); renumber = true; }
    cur = main;
  }
  return out.join(' ');
}

function variationBlock(lines) {
  return el('div', { className: 'variations' }, lines.map((first) => {
    const del = el('button', { type: 'button', className: 'vdel', textContent: '✕', title: 'Delete this line' });
    del.onclick = (e) => { e.stopPropagation(); deleteLine(first); };
    const note = first.note ? [el('span', { className: `vnote ${first.mark ?? ''}`, textContent: first.note })] : [];
    return el('div', { className: 'vline' + (first.mark ? ` ${first.mark}` : '') }, [...note, ...lineElements(first), del]);
  }));
}

$('#nav-first').onclick = () => showPly(0);
$('#nav-prev').onclick = () => stepBack();
$('#nav-next').onclick = () => stepForward();
$('#nav-last').onclick = () => showPly(livePly());
// Zen mode, as on Lichess: only the board and the players.
function toggleZen() {
  document.body.classList.toggle('zen');
  syncZenButton();
  try { localStorage.setItem('zen', document.body.classList.contains('zen') ? '1' : ''); } catch { /* ignore */ }
}
$('#zen-exit').onclick = toggleZen;
$('#btn-zen').onclick = toggleZen;
$('#btn-keys').onclick = () => $('#dlg-keys').showModal();
if (localStorage.getItem('zen')) document.body.classList.add('zen');
function syncZenButton() {
  const on = document.body.classList.contains('zen');
  const b = $('#btn-zen');
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Leave zen mode (Z)' : 'Zen mode: only the board and the players (Z)';
}
syncZenButton();

// The speaker by the board: sounds on or off, the same switch as Settings →
// General → Sounds.
function syncSoundButton() {
  const on = sounds.enabled;
  const b = $('#btn-sound');
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('muted', !on);
  b.title = on ? 'Sounds are on: click to mute (M)' : 'Sounds are off: click to turn them on (M)';
  if ($('#sound-on')) $('#sound-on').checked = on;
}
function toggleSounds() {
  sounds.setEnabled(!sounds.enabled);
  syncSoundButton();
  if (sounds.enabled) sounds.play('move'); // heard at once: they are back
}
$('#btn-sound').onclick = toggleSounds;
syncSoundButton();

window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog:modal') || !state) return;
  if (e.key === 'ArrowLeft') stepBack();
  else if (e.key === 'ArrowRight') stepForward();
  else if (e.key === 'ArrowUp') showPly(0);
  else if (e.key === 'ArrowDown') showPly(livePly());
  else if (e.key === 'Home') showPly(0);
  else if (e.key === 'End') showPly(livePly());
  else if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  else if (e.key === 'p' || e.key === 'P') toggleAnalysisHold();
  else if (e.key === 'f' || e.key === 'F') $('#btn-flip').click();
  else if (e.key === 'z' || e.key === 'Z') toggleZen();
  else if (e.key === 'm' || e.key === 'M') toggleSounds();
  else if (e.key === 'l' || e.key === 'L') $('#btn-analysis').click();
  else if (e.key === 'b' || e.key === 'B') takeback();
  else if (e.key === '?') $('#dlg-keys').showModal();
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// Engine output
// ---------------------------------------------------------------------------
function formatEval(info) {
  if (!info.hasEval) return '';
  if (info.isMate) return (info.mate > 0 ? '+' : '−') + 'M' + Math.abs(info.mate);
  const pawns = info.cp / 100;
  return (pawns > 0 ? '+' : pawns < 0 ? '−' : '') + Math.abs(pawns).toFixed(2);
}

function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(n);
}

// The engine windows for engines playing a game: name, evaluation, the
// current line, a log of the search (one row per depth, newest first) and
// the engine's own messages. The panels stay in place so their size is kept.
let engineLog = {}; // side -> [{ ply, depth, score, nodes, line }]
// What each engine's searches came to over the game, for its window's
// statistics: side -> { moves: ply -> { depth, nodes, nps, hit }, pondered }.
let engineSearch = {};

// A ponder hit: the opponent played the reply the engine was thinking
// about. It is called out over the piece that just moved, once, the
// moment the move arrives (the backend says so with the move itself).
const ponderHitsShown = new Set();
function popPonderHit(data) {
  const key = `${state?.game}:${data.side}:${data.ply}`;
  if (!state || ponderHitsShown.has(key)) return;
  ponderHitsShown.add(key);
  // At once, as the piece sets off for its square: waiting for it to
  // arrive made the call feel late.
  showPonderHit(data);
}
function showPonderHit(data) {
  // Only for the move just played, on the live board.
  const move = state.moves[data.ply - 1];
  if (!move || data.ply !== state.moves.length || !isLive()) return;
  sounds.play('ponderhit'); // heard in zen mode too, where the label is not shown
  if (document.body.classList.contains('zen')) return;
  const to = move.uci.slice(2, 4);
  const file = to.charCodeAt(0) - 97;
  const rank = +to[1];
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank - 1 : 8 - rank;
  const pop = el('div', { className: 'ponder-pop' }, [el('span', { textContent: 'Ponder hit!' })]);
  pop.setAttribute('role', 'status');
  pop.title = `${state.players?.[data.side]?.name ?? 'The engine'} expected this move and was already thinking about its answer`;
  // Centred on the piece, but kept inside the board on the edge files.
  pop.style.left = `${Math.min(86, Math.max(14, (col + 0.5) * 12.5))}%`;
  pop.style.top = `${row * 12.5}%`;
  $('.board-wrap').append(pop);
  const done = () => pop.remove();
  // Its own animation, not the burst behind it (which ends sooner).
  pop.addEventListener('animationend', (e) => { if (!e.pseudoElement) done(); });
  setTimeout(done, 2500); // in case animations are off
}

// Every line of a search counts: the last one for a move is what it reached.
function noteEngineSearch(data) {
  if (data.ply == null) return;
  const s = engineSearch[data.side] ??= { moves: new Map(), pondered: new Set() };
  if (data.pondering) { s.pondered.add(data.ply); return; }
  if (!data.depth && !data.ponderHit) return;
  const m = s.moves.get(data.ply) ?? { depth: 0, nodes: 0, nps: 0, hit: false };
  if (data.depth) m.depth = data.depth;
  if (data.nodes) m.nodes = data.nodes;
  if (data.nps) m.nps = data.nps;
  if (data.ponderHit) m.hit = true;
  s.moves.set(data.ply, m);
}

// The averages under an engine window's header.
function engineSummary(side) {
  const s = engineSearch[side];
  const moves = [...(s?.moves.values() ?? [])].filter((m) => m.depth > 0);
  if (!moves.length) return null;
  const avg = (key) => {
    const have = moves.filter((m) => m[key] > 0);
    return have.length ? have.reduce((sum, m) => sum + m[key], 0) / have.length : 0;
  };
  const stat = (label, value, title) => el('span', { className: 'engine-stat', title }, [el('span', { textContent: label }), el('b', { textContent: value })]);
  const out = [stat('Avg depth', avg('depth').toFixed(1), `Average depth of its search for each of its ${moves.length} moves`)];
  if (avg('nodes')) out.push(stat('Nodes / move', formatCount(Math.round(avg('nodes'))), 'Average positions searched for a move'));
  if (avg('nps')) out.push(stat('Speed', `${formatCount(Math.round(avg('nps')))} n/s`, 'Average positions searched a second'));
  const hits = [...s.moves.values()].filter((m) => m.hit).length;
  // Each move after its first could have been pondered on; where the engine
  // reported its pondering, those are the tries.
  const tries = Math.max(hits, s.pondered.size, 0);
  if (tries) {
    out.push(stat('Ponder hits', `${Math.round((hits / tries) * 100)}% (${hits}/${tries})`,
      `The opponent played the reply it was thinking about ${hits} time${hits === 1 ? '' : 's'} out of ${tries}`));
  }
  out.push(stat('Moves', String(moves.length), 'Moves it searched'));
  return out;
}
const ENGINE_LOG_MAX = 60;

function numberedFromPly(ply, san) {
  const fen = ply === 0 ? state.startFen : state.moves[ply - 1]?.fen ?? state.fen;
  return numberedLine(fen, san);
}

// One row per move the engine searched: its deepest line for that move.
function logEngineInfo(info) {
  let log = engineLog[info.side] ??= [];
  // The row of a ponder search goes once the engine searches its own move
  // (or ponders anew): what it expected is settled.
  if (log.some((r) => r.pondering && (!info.pondering || r.ply !== info.ply))) {
    log = engineLog[info.side] = log.filter((r) => !r.pondering || (info.pondering && r.ply === info.ply));
  }
  const row = {
    pondering: Boolean(info.pondering),
    // The opponent played the reply the engine was pondering on.
    hit: Boolean(info.ponderHit),
    ply: info.ply, depth: info.depth, score: info.hasEval ? formatEval(info) : '',
    // The chip's colour: who the score favours (scores are from White's side).
    tone: !info.hasEval ? '' : (info.isMate ? info.mate : info.cp) > 0 ? 'white' : (info.isMate ? info.mate : info.cp) < 0 ? 'black' : '',
    nodes: info.nodes ? formatCount(info.nodes) : '', line: info.pv?.length ? numberedFromPly(info.ply, info.pv) : '',
    wdl: info.wdl ?? null,
  };
  // One row a move, newest first, however the lines arrive (a game put on
  // the board later brings its earlier moves at once).
  const at = log.findIndex((r) => r.ply === row.ply && r.pondering === row.pondering);
  if (at >= 0) log[at] = row;
  else {
    log.unshift(row);
    if (log.length > 1 && log[1].ply > row.ply) log.sort((a, b) => b.ply - a.ply);
  }
  if (log.length > ENGINE_LOG_MAX) log.length = ENGINE_LOG_MAX;
}

// The header's numbers: how deep the search is and how fast it goes. They
// change many times a second, so they are drawn on their own.
function renderEngineHead(side) {
  const stats = $(`#engine-${side} .stats`);
  if (!stats) return;
  const info = engineInfo[side];
  // Once the game is over the engine is not searching any more: the header
  // says so in place of its live numbers, and the window is dimmed a little.
  const stopped = engineStopped();
  const panel = $(`#engine-${side}`);
  panel.classList.toggle('stopped', stopped);
  const pill = $('.engine-stopped', panel);
  if (pill) pill.hidden = !stopped;
  // The depth has a place of its own, in large figures.
  const badge = $(`#engine-${side} .depth-badge`);
  if (badge) {
    badge.hidden = !info?.depth;
    if (info?.depth) $('b', badge).textContent = info.depth;
    badge.title = info?.depth ? `The search has reached depth ${info.depth}${info.pondering ? ", on its opponent's time" : ''}` : '';
  }
  if ($(`#engine-${side}`).classList.contains('float-hidden')) syncEnginePill();
  stats.hidden = stopped;
  stats.textContent = info
    ? [info.pondering ? 'pondering' : '', info.nodes ? `${formatCount(info.nodes)} nodes` : '',
      info.nps ? `${formatCount(info.nps)} n/s` : ''].filter(Boolean).join(' · ')
    : '';
  stats.title = !info ? '' : info.pondering ? "Thinking on its opponent's time" : 'Its search for its move';
  if (badge && stopped && info?.depth) badge.title = `Its last search reached depth ${info.depth}`;
}

// The engines are stopped: the game they played is over (on this board, or
// your engine's Lichess game shown here).
function engineStopped() {
  return Boolean(state && !state.active && !state.external?.live);
}

// While your engine's Lichess game is on the board, its window leaves the
// side panel and floats over the app: drag it by its header, fold it down
// to the header with the arrow (or a double-click). Where it is and whether
// it is folded are remembered.
const engineFloat = (() => { try { return JSON.parse(localStorage.getItem('engineFloat')) || {}; } catch { return {}; } })();
function saveEngineFloat() {
  try { localStorage.setItem('engineFloat', JSON.stringify(engineFloat)); } catch { /* not kept */ }
}

// Puts the window where it was left (bottom right at first), inside the app.
function placeEngineFloat(panel) {
  const m = 8;
  // The size it was dragged to, as far as the app's window allows.
  const sized = engineFloat.w > 0 && engineFloat.h > 0;
  const folded = panel.classList.contains('folded');
  panel.classList.toggle('sized', sized && !folded);
  panel.style.width = sized ? Math.round(Math.max(220, Math.min(window.innerWidth - 2 * m, engineFloat.w))) + 'px' : '';
  panel.style.height = sized && !folded ? Math.round(Math.max(110, Math.min(window.innerHeight - 2 * m, engineFloat.h))) + 'px' : '';
  const r = panel.getBoundingClientRect();
  const fit = (v, size, room) => Math.round(Math.max(m, Math.min(room - size - m, v ?? room - size - 2 * m)));
  panel.style.left = fit(engineFloat.x, r.width, window.innerWidth) + 'px';
  panel.style.top = fit(engineFloat.y, r.height, window.innerHeight) + 'px';
}

// The floating window hidden: a button at the bottom right, with the depth
// the search is at, brings it back.
function syncEnginePill() {
  const pill = $('#engine-pill');
  const panel = document.querySelector('.engine.floating.float-hidden');
  pill.hidden = !panel;
  if (!panel) return;
  const side = panel.id.replace('engine-', '');
  const depth = engineInfo[side]?.depth;
  $('.pill-name', pill).textContent = state.players?.[side]?.name ?? 'Engine';
  $('.pill-depth', pill).hidden = !depth;
  if (depth) $('.pill-depth b', pill).textContent = depth;
}
function hideEngineFloat(hidden) {
  engineFloat.hidden = Boolean(hidden);
  saveEngineFloat();
  renderEngineInfo();
}
$('#engine-pill').onclick = () => hideEngineFloat(false);

function foldEngineFloat(panel, folded) {
  engineFloat.folded = Boolean(folded);
  saveEngineFloat();
  floatEngine(panel, true);
}

function floatEngine(panel, on) {
  if (on !== panel.classList.contains('floating')) {
    panel.classList.toggle('floating', on);
    if (on) document.body.append(panel);
    else {
      $('#info').insertBefore(panel, $('#chat'));
      panel.classList.remove('folded', 'sized', 'float-hidden');
      for (const k of ['left', 'top', 'width', 'height']) panel.style[k] = '';
    }
  }
  if (!on) return;
  const head = $('.head', panel);
  const toggle = $('.float-toggle', panel);
  if (!head.dataset.floatWired) {
    head.dataset.floatWired = '1';
    toggle.onclick = () => foldEngineFloat(panel, !engineFloat.folded);
    toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
    const close = $('.float-close', panel);
    close.onclick = () => hideEngineFloat(true);
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    head.addEventListener('dblclick', (e) => {
      if (panel.classList.contains('floating') && !e.target.closest('button')) foldEngineFloat(panel, !engineFloat.folded);
    });
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !panel.classList.contains('floating')) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      try { head.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
      panel.classList.add('dragging');
      const move = (ev) => {
        engineFloat.x = ev.clientX - dx;
        engineFloat.y = ev.clientY - dy;
        placeEngineFloat(panel);
      };
      const up = () => {
        try { head.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        panel.classList.remove('dragging');
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        // Kept as it ended up: inside the window.
        engineFloat.x = parseFloat(panel.style.left);
        engineFloat.y = parseFloat(panel.style.top);
        saveEngineFloat();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }
  if (!$('.float-grip', panel)) {
    // The corner to drag the window's size by; a double-click gives it its
    // own size back.
    const grip = el('div', { className: 'float-grip', title: 'Drag to resize · double-click to reset' });
    panel.append(grip);
    grip.addEventListener('dblclick', () => {
      delete engineFloat.w;
      delete engineFloat.h;
      saveEngineFloat();
      placeEngineFloat(panel);
    });
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      const dw = r.width - e.clientX;
      const dh = r.height - e.clientY;
      // The corner moves; the window's top left stays where it is.
      engineFloat.x = r.left;
      engineFloat.y = r.top;
      try { grip.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
      panel.classList.add('resizing');
      const move = (ev) => {
        engineFloat.w = Math.max(220, Math.min(ev.clientX + dw, window.innerWidth - 8 - r.left));
        engineFloat.h = Math.max(110, Math.min(ev.clientY + dh, window.innerHeight - 8 - r.top));
        placeEngineFloat(panel);
      };
      const up = () => {
        try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        panel.classList.remove('resizing');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        if (engineFloat.w > 0) {
          engineFloat.w = parseFloat(panel.style.width);
          engineFloat.h = parseFloat(panel.style.height);
        }
        saveEngineFloat();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }
  panel.classList.toggle('float-hidden', Boolean(engineFloat.hidden));
  const folded = Boolean(engineFloat.folded);
  panel.classList.toggle('folded', folded);
  toggle.textContent = folded ? '▸' : '▾';
  toggle.title = folded ? 'Show the engine\'s lines' : 'Fold the window down to this bar';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(!folded));
  head.title = 'Drag to move · double-click to fold';
  placeEngineFloat(panel);
}
window.addEventListener('resize', () => {
  for (const panel of document.querySelectorAll('.engine.floating')) placeEngineFloat(panel);
});

// An engine's window, in the manner of the Analysis window: a header (who,
// how deep, how fast), then one row per move it searched, newest first: the
// score, and the line it had in mind. Rows keep to one line; a click wraps one.
function renderEngineInfo() {
  for (const side of ['white', 'black']) {
    const panel = $(`#engine-${side}`);
    const player = state.players?.[side];
    panel.hidden = !player || player.type !== 'engine';
    if (panel.hidden) { floatEngine(panel, false); continue; }
    if (!panel.firstChild) {
      panel.append(
        el('div', { className: 'head' }, [
          el('span', { className: 'side-dot ' + side, title: side === 'white' ? 'White' : 'Black' }),
          el('span', { className: 'engine-name' }),
          el('span', { className: 'engine-stopped', hidden: true, textContent: 'Stopped', title: 'The game is over: the engine is not searching' }),
          el('span', { className: 'depth-badge', hidden: true }, [el('small', { textContent: 'Depth' }), el('b')]),
          el('span', { className: 'stats' }),
          el('button', { type: 'button', className: 'float-toggle' }),
          el('button', { type: 'button', className: 'float-toggle float-close', textContent: '✕', title: 'Hide the engine window (a button at the bottom right brings it back)', ariaLabel: 'Hide the engine window' }),
        ]),
        el('div', { className: 'engine-sum', hidden: true }),
        el('div', { className: 'wdl-sum engine-wdl', hidden: true }),
        el('div', { className: 'lines' }),
        el('div', { className: 'messages' }),
      );
    }
    const sum = engineSummary(side);
    $('.engine-sum', panel).hidden = !sum;
    if (sum) $('.engine-sum', panel).replaceChildren(...sum);
    $('.engine-name', panel).textContent = player.name;
    $('.engine-name', panel).title = player.name;
    renderEngineHead(side);
    // Your engine's Lichess game: its window floats over the app.
    floatEngine(panel, state.external?.kind === 'bot');

    const log = engineLog[side] ?? [];
    // Its latest win/draw/loss chances, for the move it searched last.
    const wdlRow = log.find((r) => r.wdl && !r.pondering);
    const wdlBox = $('.engine-wdl', panel);
    if (wdlBox) {
      wdlBox.hidden = !wdlRow;
      if (wdlRow) wdlBox.replaceChildren(...wdlSummary(wdlRow.wdl));
    }
    const openLines = engineLineOpen[side] ??= new Set();
    const rows = log.map((r) => {
      // The move searched for: its number from the position searched.
      const fen = r.ply === 0 ? state.startFen : state.moves[r.ply - 1]?.fen ?? state.fen;
      const [, turn, , , , fullmove] = fen.split(' ');
      const isOpen = openLines.has(r.ply);
      const row = el('div', { className: 'analysis-line' + (isOpen ? ' open' : '') + (r.pondering ? ' pondering' : ''), title: isOpen ? 'Click to show one row' : 'Click to show the whole line' }, [
        el('span', {
          className: 'num', textContent: r.pondering ? 'ponder' : `${fullmove}${turn === 'w' ? '.' : '…'}`,
          title: r.pondering ? `Thinking on its opponent's time, about the reply it expects: depth ${r.depth}${r.nodes ? `, ${r.nodes} nodes` : ''}`
            : `Its search for move ${fullmove}, to depth ${r.depth}${r.nodes ? `, ${r.nodes} nodes` : ''}`,
        }),
        el('span', { className: 'score ' + r.tone, textContent: r.score || '–' }),
        ...(log.some((x) => x.wdl) ? [r.wdl ? wdlBar(r.wdl, true) : el('span', { className: 'wdl-bar mini none' })] : []),
        // How deep the search for this move got.
        ...(r.depth ? [el('span', {
          className: 'depth', textContent: `d${r.depth}`,
          title: `${r.pondering ? 'Pondering has reached' : 'The search for this move reached'} depth ${r.depth}${r.nodes ? `, ${r.nodes} nodes` : ''}`,
        })] : []),
        ...(r.hit ? [el('span', {
          className: 'ponder-hit', textContent: 'hit',
          title: 'Ponder hit: the opponent played the reply it expected, so it had been thinking about this move on their time',
        })] : []),
        el('span', { className: 'pv', textContent: r.line, title: isOpen ? '' : r.line }),
      ]);
      if (r.hit) row.classList.add('hit');
      row.onclick = () => {
        if (String(window.getSelection?.() ?? '')) return; // selecting text, not toggling
        if (!openLines.delete(r.ply)) openLines.add(r.ply);
        renderEngineInfo();
      };
      return row;
    });
    if (!rows.length) rows.push(el('p', { className: 'hint', textContent: 'Waiting for its first search…' }));
    $('.lines', panel).replaceChildren(...rows);

    // Only the newest message until clicked; then all of them, wrapped.
    const all = engineStrings[side] ?? [];
    const open = !!engineMsgOpen[side];
    const shown = open ? all : all.slice(-1);
    const messages = shown.map((m) => el('div', {
      className: 'message' + (m.opening ? ' opening' : ''), textContent: m.text, title: open ? '' : m.text,
    }));
    const box = $('.messages', panel);
    if (all.length > 1) {
      messages.push(el('div', { className: 'more', textContent: open ? 'Show less' : `Show all ${all.length}` }));
    }
    box.replaceChildren(...messages);
    box.hidden = all.length === 0;
    box.classList.toggle('open', open);
    box.classList.toggle('expandable', all.length > 1 || open);
    box.setAttribute('aria-expanded', String(open));
    if (!box.dataset.wired) {
      box.dataset.wired = '1';
      box.tabIndex = 0;
      box.setAttribute('role', 'button');
      box.title = 'Click to show all of the engine\'s messages';
      const toggle = () => {
        if ((engineStrings[side] ?? []).length < 2 && !engineMsgOpen[side]) return;
        engineMsgOpen[side] = !engineMsgOpen[side];
        renderEngineInfo();
      };
      box.addEventListener('click', () => {
        if (String(window.getSelection?.() ?? '')) return; // selecting text, not toggling
        toggle();
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    }
    // Its rows have changed its height: keep the floating window in view.
    if (panel.classList.contains('floating')) placeEngineFloat(panel);
  }
  syncEnginePill();
}

// ---------------------------------------------------------------------------
// Resizing: the handle between the list and the info column sets its width
// (or height, when stacked); the handle under each engine window sets that
// window's height. Sizes are remembered; double-click a handle to reset it.
// ---------------------------------------------------------------------------
const layout = (() => {
  try { return JSON.parse(localStorage.getItem('layout') ?? '{}') ?? {}; } catch { return {}; }
})();
function saveLayout() {
  try { localStorage.setItem('layout', JSON.stringify(layout)); } catch { /* ignore */ }
}

const workspace = $('.workspace');
const infoSplit = $('#split-info');
const isStacked = () => getComputedStyle(workspace).gridTemplateColumns.trim().split(/\s+/).length < 3;

function applyLayout() {
  const tab = workspace.dataset.tab || 'moves';
  const left = layout[tab === 'moves' ? 'movesW' : 'paneW'];
  if (left) workspace.style.setProperty('--left', left + 'px');
  else workspace.style.removeProperty('--left');
  if (layout.infoH) workspace.style.setProperty('--info-h', layout.infoH + 'px');
  else workspace.style.removeProperty('--info-h');
  for (const panel of document.querySelectorAll('.resizable')) {
    const h = layout.panels?.[panel.dataset.size];
    if (h) panel.style.setProperty('--size', h + 'px');
    else panel.style.removeProperty('--size');
  }
  placeInfo();
}

// The tabs keep to one row: the panel is made wide enough for them when
// there is room (--tabs-w), and those that still do not fit go into the
// More menu, the open tab always staying in the row.
function fitTabs() {
  const row = $('.tabs');
  const more = $('#tab-more');
  const tabs = [...row.querySelectorAll('.tab:not(.tab-more)')];
  for (const t of tabs) t.hidden = false;
  more.hidden = true;
  const widths = tabs.map((t) => t.getBoundingClientRect().width);
  const total = Math.ceil(widths.reduce((a, b) => a + b, 0)) + 2;
  // The row's own padding and margins: room the panel must have besides.
  const cs = getComputedStyle(row);
  const around = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
  const wide = Math.ceil(total + around);
  if (total > 2 && workspace.style.getPropertyValue('--tabs-w') !== `${wide}px`) workspace.style.setProperty('--tabs-w', `${wide}px`);
  // The row is only as wide as its tabs: the room is what the panel has.
  const room = row.parentElement.clientWidth - around;
  const out = [];
  if (total > room + 1 && room > 0) {
    more.hidden = false;
    let used = total + more.getBoundingClientRect().width;
    for (let i = tabs.length - 1; i >= 0 && used > room; i--) {
      if (tabs[i].classList.contains('active')) continue;
      used -= widths[i];
      out.unshift(tabs[i]);
    }
    for (const t of out) t.hidden = true;
  }
  more.classList.toggle('has-count', out.some((t) => t.querySelector('.count')?.textContent.trim()));
  more.title = out.length ? `More: ${out.map((t) => t.firstChild.textContent.trim()).join(', ')}` : '';
  if (!out.length) closeTabMenu();
  fitTabs.out = out;
}

function closeTabMenu() {
  $('#tab-menu').hidden = true;
  $('#tab-more').setAttribute('aria-expanded', 'false');
}
$('#tab-more').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#tab-menu');
  if (!menu.hidden) { closeTabMenu(); return; }
  menu.replaceChildren(...(fitTabs.out ?? []).map((t) => {
    const b = el('button', { type: 'button', role: 'menuitem' }, [t.firstChild.textContent.trim()]);
    const count = t.querySelector('.count')?.textContent.trim();
    if (count) b.append(el('span', { className: 'count', textContent: count }));
    b.onclick = () => { closeTabMenu(); t.click(); };
    return b;
  }));
  menu.hidden = false;
  $('#tab-more').setAttribute('aria-expanded', 'true');
};
document.addEventListener('click', (e) => { if (!e.target.closest?.('#tab-menu')) closeTabMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTabMenu(); });

// Where things go for the room there is: side by side, the computer
// analysis (chart and summary) sits in the info column, above the Game card,
// rather than above the moves; and the last engine window shown fills the
// column's height.
function placeInfo() {
  fitTabs();
  if (workspace.classList.contains('no-info')) workspace.classList.remove('no-info');
  const stacked = isStacked();
  infoSplit.classList.toggle('stacked', stacked);
  const review = $('#review');
  const info = $('#info');
  if (!stacked && review.parentElement !== info) info.insertBefore(review, $('#game-info'));
  else if (stacked && review.parentElement === info) $('#pane-moves').prepend(review);
  const shown = [...info.querySelectorAll(':scope > .resizable')].filter((p) => !p.hidden && !p.classList.contains('collapsed'));
  for (const p of info.querySelectorAll(':scope > .resizable')) {
    const fill = p === shown.at(-1);
    if (p.classList.contains('fill') !== fill) p.classList.toggle('fill', fill);
  }
  const empty = ![...info.children].some((c) => !c.hidden && !c.classList.contains('splitter'));
  if (empty) workspace.classList.add('no-info');
}
// Engine windows come and go (hidden, or collapsed when paused).
new MutationObserver(() => placeInfo()).observe($('#info'), { subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
// The tab row changes width when a count (games, challenges) appears.
new MutationObserver(() => placeInfo()).observe($('.tabs'), { subtree: true, childList: true, characterData: true });

// Drag with the pointer captured: onStart gets the pointerdown, onMove each
// pointermove. axis() says which way the handle moves ('x' or 'y'), for the
// cursor shown everywhere while dragging.
function dragHandle(handle, axis, onStart, onMove, onEnd) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    handle.classList.add('dragging');
    const cls = axis() === 'x' ? 'resizing-x' : 'resizing-y';
    document.body.classList.add(cls);
    onStart(e);
    const move = (ev) => onMove(ev);
    const up = () => {
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      handle.classList.remove('dragging');
      document.body.classList.remove(cls);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onEnd();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

dragHandle(infoSplit, () => (isStacked() ? 'y' : 'x'), () => {}, (e) => {
  const r = workspace.getBoundingClientRect();
  if (isStacked()) {
    layout.infoH = Math.round(Math.max(96, Math.min(r.height - 100, r.bottom - e.clientY)));
  } else {
    layout[workspace.dataset.tab === 'moves' ? 'movesW' : 'paneW'] = Math.round(Math.max(200, Math.min(r.width - 200, e.clientX - r.left)));
  }
  applyLayout();
}, saveLayout);
infoSplit.addEventListener('dblclick', () => {
  delete layout[isStacked() ? 'infoH' : workspace.dataset.tab === 'moves' ? 'movesW' : 'paneW'];
  applyLayout();
  saveLayout();
});

for (const handle of document.querySelectorAll('.info > .splitter.h')) {
  const panel = handle.previousElementSibling;
  let startY = 0;
  let startH = 0;
  dragHandle(handle, () => 'y', (e) => {
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
  }, (e) => {
    const h = Math.round(Math.max(64, startH + e.clientY - startY));
    layout.panels = { ...layout.panels, [panel.dataset.size]: h };
    applyLayout();
  }, saveLayout);
  handle.addEventListener('dblclick', () => {
    if (layout.panels) delete layout.panels[panel.dataset.size];
    applyLayout();
    saveLayout();
  });
}

new ResizeObserver(() => placeInfo()).observe(workspace);
applyLayout();

// How a time control reads in the Game card, e.g. "40 moves in 90 min + 30 s, then 30 min + 30 s".
function describeTimeControl(tc) {
  const time = (ms) => (ms % 60000 === 0 ? `${ms / 60000} min` : `${+(ms / 1000).toFixed(1)} s`);
  switch (tc?.kind) {
    case 'clock':
      return tc.stages.map((s, i) => {
        let text = s.moves ? `${s.moves} moves in ${time(s.baseMs)}` : (i > 0 ? `then ${time(s.baseMs)}` : time(s.baseMs));
        if (s.incMs) text += ` + ${+(s.incMs / 1000).toFixed(1)} s`;
        return text;
      }).join(', ');
    case 'movetime': return `${+(tc.moveTimeMs / 1000).toFixed(1)} s per move`;
    case 'depth': return `depth ${tc.depth}`;
    case 'none': return 'no clock';
  }
  return '';
}

// The Game card: what the game is (event, players, how it stands), then the
// details (time control, opening, moves, date, site), and for a loaded PGN,
// its other tags tucked away.
function renderGameInfo() {
  const card = $('#game-info');
  if (!state?.players && !state?.loaded) { card.hidden = true; return; }
  const tags = new Map((state.tags ?? []).map((t) => [t.name, t.value]));
  const tag = (name) => {
    const v = tags.get(name);
    return v && v !== '?' && v !== '????.??.??' && v !== '-' ? v : '';
  };
  const ext = state.external;
  const over = state.result && state.result !== '*' && !state.active && !ext?.live;
  const live = state.active || ext?.live;

  // Title: the event, and where it comes from.
  let title = '';
  let source = '';
  if (state.loaded) {
    title = tag('Event') || 'Loaded game';
    source = [tag('Round') && `Round ${tag('Round')}`].filter(Boolean).join(' · ');
  } else if (ext) {
    title = (ext.label ?? '').replace(/^Lichess · /, '').replace(/^Watching \S+ · /, '') || 'Lichess game';
    title = title.charAt(0).toUpperCase() + title.slice(1);
    source = { spectate: 'Watching on Lichess', bot: 'Your engine on Lichess', play: 'You on Lichess', tournament: 'Tournament' }[ext.kind] ?? 'Lichess';
  } else {
    const types = ['white', 'black'].map((s) => state.players[s]?.type);
    title = types.every((t) => t === 'human') ? 'Human vs Human' : types.every((t) => t === 'engine') ? 'Computer vs Computer' : 'Human vs Computer';
    source = 'On this board';
  }

  // How it stands.
  let status;
  let statusKind = '';
  if (live) { status = 'In progress'; statusKind = 'live'; }
  else if (over) { status = state.result.replace('1/2-1/2', '½–½').replace('-', '–'); statusKind = 'over'; }
  else if (state.loaded && (tag('Result') || '*') !== '*') { status = tag('Result').replace('1/2-1/2', '½–½'); statusKind = 'over'; }
  else status = state.moves.length ? 'Unfinished' : 'Not started';
  const reason = over ? state.reason ?? '' : (state.loaded ? tag('Termination') : '') || (!live && state.result === '*' ? state.reason ?? '' : '');

  // The players: colour, name, rating (and its change), kind, score.
  const diff = ext?.ratingDiff;
  const result = over ? state.result : (state.loaded ? tag('Result') : '');
  const point = (side) => (!result || result === '*' ? '' : result === '1/2-1/2' ? '½' : (result === '1-0') === (side === 'white') ? '1' : '0');
  const players = ['white', 'black'].map((side) => {
    const p = state.players?.[side] ?? {};
    const name = p.name || tag(side === 'white' ? 'White' : 'Black') || (side === 'white' ? 'White' : 'Black');
    const rating = p.rating || tag(side === 'white' ? 'WhiteElo' : 'BlackElo');
    let kind = p.type === 'engine' ? (ext?.kind === 'bot' ? 'your engine' : 'engine') : p.type === 'human' ? (ext ? 'you' : 'human') : '';
    if (/^you$/i.test(name)) kind = ''; // "You" says it already
    const pt = point(side);
    const d = diff?.[side];
    return el('div', { className: `gi-player ${side}` + (pt === '1' ? ' won' : '') + (live && state.turn === side ? ' to-move' : '') }, [
      el('span', { className: `gi-dot ${side}`, title: side === 'white' ? 'White' : 'Black' }),
      ...[typeof flagSpan === 'function' ? flagSpan(lichessUser(side)) : null].filter(Boolean),
      el('span', { className: 'gi-name', textContent: name, title: name }),
      ...(kind ? [el('span', { className: 'gi-kind', textContent: kind })] : []),
      el('span', { className: 'gi-rating' }, rating ? [String(rating), ...(d != null ? [el('span', { className: 'gi-diff ' + (d > 0 ? 'up' : d < 0 ? 'down' : ''), textContent: ` ${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}` })] : [])] : []),
      el('span', { className: 'gi-pt' + (pt ? '' : ' none'), textContent: pt }),
    ]);
  });

  // Details.
  const facts = [];
  const fact = (label, value, opts = {}) => {
    if (!value) return;
    const v = typeof value === 'string' ? el('span', { textContent: value, className: opts.mono ? 'mono' : '' }) : value;
    facts.push(el('div', { className: 'gi-fact' }, [el('span', { className: 'gi-label', textContent: label }), v]));
  };
  // Time control.
  let tc = '';
  if (state.loaded) {
    // PGN gives seconds ("600+0"): shown as minutes, the way clocks are named.
    tc = tag('TimeControl');
    const m = tc.match(/^(\d+)(?:\+(\d+))?$/);
    if (m && +m[1] > 0) tc = `${+(+m[1] / 60).toFixed(2)}+${+(m[2] ?? 0)}`;
  } else if (ext) tc = (ext.label ?? '').match(/\b(\d+(?:\.\d+)?\+\d+)\b/)?.[1] ?? '';
  else if (state.players) {
    const [w, b] = ['white', 'black'].map((side) => describeTimeControl(state.players[side].timeControl));
    tc = w === b ? w : `White ${w} · Black ${b}`;
  }
  fact('Time control', tc);
  // The opening reached in the game.
  let opening = '';
  for (const m of state.moves ?? []) if (m.opening) opening = m.opening;
  opening ||= state.startOpening || (state.loaded ? [tag('ECO'), tag('Opening')].filter(Boolean).join(' ') : '') || state.opening || '';
  if (opening) {
    const m = opening.match(/^([A-E]\d\d)\b[\s:,-]*(.*)$/);
    const name = m ? el('span', {}, [el('span', { className: 'gi-eco', textContent: m[1] }), m[2]]) : el('span', { textContent: opening });
    name.classList.add('gi-opening');
    name.dataset.opening = opening;
    fact('Opening', name);
  }
  fact('Moves', state.moves.length ? String(Math.ceil(state.moves.length / 2)) : '');
  fact('Date', state.loaded ? tag('Date').replace(/\.\?\?/g, '') : '');
  const standard = (state.startFen ?? '').startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - ');
  if (state.startFen && !standard) fact('Start position', state.startFen, { mono: true, wide: true });
  const site = ext?.url || (state.loaded ? tag('Site') : '');
  if (site) {
    if (/^https?:\/\//.test(site)) {
      const a = el('a', { href: '#', textContent: site.replace(/^https?:\/\//, '').replace(/\/(white|black)$/, '') + ' ↗', title: site });
      a.onclick = (e) => { e.preventDefault(); api.openExternal(site); };
      fact('Site', a, { wide: true });
    } else fact('Site', site, { wide: true });
  }

  const main = [
    el('div', { className: 'gi-head' }, [
      el('div', { className: 'gi-title' }, [
        el('span', { className: 'gi-event', textContent: title, title }),
        el('span', { className: `gi-status ${statusKind}`, textContent: status }),
      ]),
      ...(source || reason ? [el('div', { className: 'gi-sub' }, [source, reason && source ? ' · ' : '', reason].filter(Boolean).join(''))] : []),
    ]),
    el('div', { className: 'gi-players' }, players),
    ...(facts.length ? [el('div', { className: 'gi-facts' }, facts)] : []),
  ];
  // A loaded game's other tags.
  if (state.loaded) {
    const shown = new Set(['Event', 'Round', 'White', 'Black', 'WhiteElo', 'BlackElo', 'Result', 'TimeControl', 'ECO', 'Opening', 'Date', 'Site', 'FEN', 'SetUp', 'Termination']);
    const rest = (state.tags ?? []).filter((t) => !shown.has(t.name) && t.value && t.value !== '?');
    if (rest.length) {
      main.push(el('details', { className: 'gi-tags' }, [
        el('summary', { textContent: `${rest.length} more PGN tag${rest.length === 1 ? '' : 's'}` }),
        el('dl', {}, rest.flatMap((t) => [el('dt', { textContent: t.name }), el('dd', { textContent: t.value })])),
      ]));
    }
  }
  const preview = gamePreview(live);
  card.hidden = false;
  const details = $('#game-details');
  details.classList.toggle('has-preview', Boolean(preview));
  details.replaceChildren(...(preview ? [preview] : []), el('div', { className: 'gi-main' }, main));
}

// A picture of the game in the Game card: a board showing it from its
// middle, or as it ended, for a glance at what kind of game it was.
// Clicking the board goes to that move. Not while the game is being played
// (its middle keeps moving), nor for a handful of moves.
const PREVIEW_MIN_PLIES = 8;
let previewAt = 'middle'; // or 'end'
function gamePreview(live) {
  const n = state.moves?.length ?? 0;
  if (live || n < PREVIEW_MIN_PLIES || typeof miniBoard !== 'function') return null;
  const ply = previewAt === 'end' ? n : Math.ceil(n / 2);
  const move = state.moves[ply - 1];
  const label = numberedLine(mainFen(ply - 1), [move.san]);
  const board = miniBoard(move.fen, state.external?.side === 'black');
  board.classList.add('gi-mini');
  const button = el('button', { type: 'button', className: 'gi-preview', title: `Go to ${label}` }, [board]);
  button.setAttribute('aria-label', `The position after ${label}: go to that move`);
  button.onclick = () => showPly(ply);
  const pick = el('span', { className: 'gi-pick', role: 'radiogroup', ariaLabel: 'Position shown' }, [['middle', 'Middle'], ['end', 'End']].map(([at, text]) => {
    const b = el('button', { type: 'button', role: 'radio', className: at === previewAt ? 'on' : '', textContent: text });
    b.setAttribute('aria-checked', String(at === previewAt));
    b.onclick = () => { if (previewAt !== at) { previewAt = at; renderGameInfo(); } };
    return b;
  }));
  return el('div', { className: 'gi-board' }, [
    button,
    el('div', { className: 'gi-cap' }, [
      el('span', { className: 'gi-cap-text' }, [
        el('span', { className: 'gi-preview-move', textContent: `After ${label}` }),
        el('span', { className: 'gi-preview-of', textContent: `Move ${Math.ceil(ply / 2)} of ${Math.ceil(n / 2)}` }),
      ]),
      pick,
    ]),
  ]);
}

// The opening of the position on the board: the built-in book's name for the
// most specific line reached by the shown move, or else what an engine or
// the PGN file reported. Names look like "B20 Sicilian Defense"; the ECO
// code is shown apart.
function renderOpening() {
  const box = $('#opening');
  if (puzzleView) { box.hidden = true; return; }
  const ply = shownPly();
  let book = ply === 0 ? state.startOpening : state.moves[ply - 1]?.opening;
  for (let n = varNode; n; n = n.parent) if (n.opening) { book = n.opening; break; }
  const text = book || state.opening || '';
  const match = text.match(/^([A-E]\d\d)\b[\s:,-]*(.*)$/);
  $('.eco', box).textContent = match ? match[1] : '';
  $('.name', box).textContent = match ? match[2] : text;
  box.dataset.opening = text; // pointing at it brings up the opening's card
  box.hidden = !text;
}

// ---------------------------------------------------------------------------
// Backend events
// ---------------------------------------------------------------------------
// What a move sounds like, from its SAN: check matters most.
function moveSound(move) {
  const san = move?.san ?? '';
  if (/[+#]/.test(san)) return 'check';
  if (san.includes('=')) return 'promote';
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('x')) return 'capture';
  return 'move';
}

// The end-of-game sound: a win or loss for the person playing the computer,
// otherwise a draw or neutral chord. An aborted game is silent.
function endSound(next) {
  if (next.result === '*') return null;
  if (next.result === '1/2-1/2') return 'draw';
  // In a Lichess game, the side to cheer for is yours (your own game) or
  // your engine's.
  const mine = next.external && next.external.kind !== 'play' ? 'engine' : 'human';
  const humans = ['white', 'black'].filter((s) => next.players?.[s]?.type === mine);
  if (humans.length !== 1) return 'end';
  const humanWon = (next.result === '1-0') === (humans[0] === 'white');
  return humanWon ? 'win' : 'loss';
}

// Keeping the screen awake (Settings → General → Screen): never, while a
// game is played (on the board, a live Lichess game, a tournament), or always.
let keepAwake = 'game';
try { keepAwake = localStorage.getItem('keepAwake') || 'game'; } catch { /* the default */ }
let awakeNow = false;
function syncKeepAwake() {
  const playing = Boolean(state && (state.active || state.external?.live)) || $('#tab-tournament')?.classList.contains('live');
  const want = keepAwake === 'always' || (keepAwake === 'game' && playing);
  if (want === awakeNow) return;
  awakeNow = want;
  window.board.keepAwake?.(want).catch(() => { awakeNow = !want; });
}
setInterval(syncKeepAwake, 5000); // a tournament's tab, which has no state of its own here
$('#keep-awake').value = keepAwake;
$('#keep-awake').onchange = (e) => {
  keepAwake = e.target.value;
  try { localStorage.setItem('keepAwake', keepAwake); } catch { /* not kept */ }
  syncKeepAwake();
};
syncKeepAwake();

function playStateSounds(prev, next, newGame) {
  window.announcer?.onState(prev, next, newGame); // announcer.js says it too
  // Tournament games go by too fast to hear every move.
  if (next.external?.kind === 'tournament') return;
  if (newGame) {
    lowTime = {};
    // The versus screen has a sound of its own, in place of the start sound.
    if (window.versusWanted?.(next, prev)) return;
    if ((next.active && !next.loaded) || (next.external?.live && next.moves.length === 0)) sounds.play('start');
    return;
  }
  const ended = (prev.active && !next.active) || (prev.external?.live && next.external && !next.external.live && next.result !== '*')
    // A watched game whose result comes a moment after it stopped being live.
    || (prev.external && next.external && !next.external.live && prev.result === '*' && next.result !== '*');
  if (next.moves.length === prev.moves.length + 1) sounds.play(moveSound(next.moves.at(-1)));
  if (ended) {
    const end = endSound(next);
    if (end) setTimeout(() => sounds.play(end), next.moves.length > prev.moves.length ? 300 : 0);
    // Let the last move land on the board first.
    if (next.result !== '*') setTimeout(() => showGameOver(next), ANIM_SPEEDS[animSpeed] + 150);
  }
}

// ---------------------------------------------------------------------------
// Game over: a card over the board saying who won and how, a 1 / 0 / ½ on
// the player bars, and a desktop notification when the window is not in
// front.
// ---------------------------------------------------------------------------
let resultCard = (() => { try { return localStorage.getItem('resultCard') !== 'off'; } catch { return true; } })();
let gameOverFor = null; // the game the card is showing

// From whose side the result is told: 'white'/'black' for the one person
// (or your engine on Lichess), null when there is none (two people, two
// engines, someone else's game).
function resultSide(st) {
  if (st.external?.kind === 'spectate' || st.external?.kind === 'tournament') return null;
  const mine = st.external && st.external.kind !== 'play' ? 'engine' : 'human';
  const ours = ['white', 'black'].filter((s) => st.players?.[s]?.type === mine);
  return ours.length === 1 ? ours[0] : null;
}

function resultHeadline(st) {
  const side = resultSide(st);
  const drawn = st.result === '1/2-1/2';
  const winner = st.result === '1-0' ? 'white' : st.result === '0-1' ? 'black' : null;
  const name = (s) => st.players?.[s]?.name || (s === 'white' ? 'White' : 'Black');
  if (drawn) return { kind: 'draw', title: 'Draw', badge: '½' };
  if (!winner) return { kind: 'neutral', title: 'Game over', badge: '•' };
  if (side) {
    const engine = st.external && st.external.kind !== 'play';
    const won = side === winner;
    return won
      ? { kind: 'win', title: engine ? 'Your engine won!' : 'You won!', badge: '✓' }
      : { kind: 'loss', title: engine ? 'Your engine lost' : 'You lost', badge: '✕' };
  }
  return { kind: 'neutral', title: `${name(winner)} wins`, badge: winner === 'white' ? '1-0' : '0-1' };
}

// A rated Lichess game whose rating changes are still to come from Lichess.
const ratingGaveUp = new Set(); // games whose rating changes never came
const awaitingRating = (st) => Boolean(st.external && /\bRated\b/.test(st.external.label ?? '') && !st.external.ratingDiff && !ratingGaveUp.has(st.game));
const ratingDelta = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
let pendingNotice = null; // { game, timer }: the notification waits for the rating changes

function showGameOver(st) {
  // The game as it stands now: a watched game is told again after it ends
  // (its rating changes, the end of its stream), and those later reports
  // of the same finished game must not keep the result from showing.
  if (!st || !state || st.game !== state.game || state.result === '*' || state.external?.live || state.active) return;
  st = state;
  if (st.external?.kind === 'tournament') return;
  const head = resultHeadline(st);
  clearTimeout(pendingNotice?.timer);
  pendingNotice = null;
  if (awaitingRating(st)) {
    // Lichess has the rating changes a moment later: say them too, but
    // do not wait more than a few seconds for them.
    pendingNotice = { game: st.game, timer: setTimeout(() => { pendingNotice = null; notifyGameOver(state, resultHeadline(state)); }, 6000) };
    setTimeout(() => {
      if (!state?.external?.ratingDiff && state?.game === st.game) {
        ratingGaveUp.add(st.game);
        if (gameOverFor === st.game && !$('#game-over').hidden) renderGameOver(state, false);
      }
    }, 20000);
  } else {
    notifyGameOver(st, head);
  }
  window.showKo?.(st);
  if (!resultCard) return;
  renderGameOver(st, true);
}

// The rating changes arrived (or changed) after the game ended.
function ratingDiffArrived(st) {
  if (pendingNotice && pendingNotice.game === st.game) {
    clearTimeout(pendingNotice.timer);
    pendingNotice = null;
    notifyGameOver(st, resultHeadline(st));
  }
  if (gameOverFor === st.game && !$('#game-over').hidden) renderGameOver(st, false);
  window.updateKo?.();
}

function renderGameOver(st, focus) {
  const head = resultHeadline(st);
  gameOverFor = st.game;
  const box = $('#game-over');
  box.className = head.kind;
  $('#go-badge').textContent = head.badge;
  $('#go-title').textContent = head.title;
  $('#go-reason').textContent = (st.reason ?? '').replace(/^(White|Black) wins /, '').replace(/^Draw\s+(?=\S)/, '') || st.result.replace('1/2-1/2', '½-½');
  const pts = st.result === '1-0' ? ['1', '0'] : st.result === '0-1' ? ['0', '1'] : ['½', '½'];
  const diff = st.external?.ratingDiff;
  const side = (s, pt) => {
    const p = st.players?.[s];
    const parts = [el('span', { className: `dot ${s}` }), p?.name || (s === 'white' ? 'White' : 'Black')];
    if (p?.rating) {
      const d = diff?.[s];
      parts.push(el('span', { className: 'go-rating' }, [
        p.rating,
        ...(d != null ? [el('span', { className: 'go-diff ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'even'), textContent: ` ${ratingDelta(d)}` })] : []),
      ]));
    }
    parts.push(el('span', { className: 'pt', textContent: pt }));
    return el('span', { className: 'side' + (pt === '1' ? ' won' : '') }, parts);
  };
  $('#go-players').replaceChildren(side('white', pts[0]), el('span', { className: 'vs', textContent: '–' }), side('black', pts[1]));
  // Your (or your engine's) rating change, large; or a note that it is coming.
  const mine = resultSide(st);
  const rating = $('#go-rating');
  rating.className = 'go-rating-line';
  if (diff && mine && st.players?.[mine]?.rating) {
    const d = diff[mine];
    const before = Number(st.players[mine].rating);
    rating.className += d > 0 ? ' up' : d < 0 ? ' down' : '';
    rating.replaceChildren(el('b', { textContent: `${ratingDelta(d)}` }), ` rating · ${before} → ${before + d}`);
  } else if (awaitingRating(st)) {
    rating.textContent = 'Rating change: waiting for Lichess…';
    rating.className += ' waiting';
  } else {
    rating.replaceChildren();
  }
  rating.hidden = !rating.textContent;
  const acts = [];
  const close = el('button', { type: 'button', textContent: 'Close' });
  close.onclick = hideGameOver;
  if (st.moves.length > 0 && typeof startReview === 'function') {
    const analyse = el('button', { type: 'button', className: 'primary', textContent: 'Computer analysis' });
    analyse.onclick = () => { hideGameOver(); showTab('moves'); startReview(); };
    acts.push(analyse);
  }
  if (window.canAnalyseWithAi?.()) {
    const ai = el('button', { type: 'button', textContent: 'Analyze with AI', title: 'Ask the AI model to go over this game, in the AI panel (the model is set in Settings → AI)' });
    ai.onclick = () => { hideGameOver(); window.analyseGameWithAi(); };
    acts.push(ai);
  }
  if (!st.external) {
    const again = el('button', { type: 'button', textContent: 'New game' });
    again.onclick = () => { hideGameOver(); $('#btn-new').click(); };
    acts.push(again);
  }
  acts.push(close);
  $('#go-actions').replaceChildren(...acts);
  box.hidden = false;
  if (focus) (acts[0] ?? close).focus();
}

function hideGameOver() {
  $('#game-over').hidden = true;
  gameOverFor = null;
}
$('#game-over').addEventListener('click', (e) => { if (e.target.id === 'game-over') hideGameOver(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#game-over').hidden) hideGameOver(); });

function notifyGameOver(st, head) {
  if (document.hasFocus() || typeof Notification === 'undefined') return;
  const diff = st.external?.ratingDiff;
  const who = (s) => `${st.players?.[s]?.name ?? (s === 'white' ? 'White' : 'Black')}${diff ? ` (${ratingDelta(diff[s])})` : ''}`;
  const mine = resultSide(st);
  const lines = [st.reason || st.result, `${who('white')} – ${who('black')}`];
  if (diff && mine && st.players?.[mine]?.rating) lines.splice(1, 0, `Rating ${ratingDelta(diff[mine])}: ${st.players[mine].rating} → ${Number(st.players[mine].rating) + diff[mine]}`);
  const body = lines.join('\n');
  try {
    const n = new Notification(head.title, { body, silent: true });
    n.onclick = () => window.focus();
  } catch { /* notifications unavailable */ }
}

function setResultCard(on) {
  resultCard = on;
  try { localStorage.setItem('resultCard', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  if (!on) hideGameOver();
}

function applyState(next) {
  const prev = state;
  const newGame = !state || next.game !== state.game;
  const wasLive = !state || isLive();
  state = next;
  stateAt = performance.now();
  if (newGame) {
    tree = { branches: new Map() }; varNode = null; if (puzzleView) window.leavePuzzle?.();
    notes = { before: null, moves: new Map(), dirty: false };
  }
  // A takeback takes the notes on the moves it removed.
  for (const ply of [...notes.moves.keys()]) if (ply > next.moves.length) notes.moves.delete(ply);
  // Watching a game (someone's on Lichess, your engine's, a tournament's):
  // the analysis rests when the game ends and takes up again with the next
  // one. Not if you paused it yourself, and not once you have turned it off.
  if (typeof analysis !== 'undefined' && analysis.on) {
    const watched = (st) => Boolean(st?.external && st.external.kind !== 'play');
    // Over: no longer followed, or decided (the result can arrive first).
    const over = (st) => !st.external.live || st.result !== '*';
    if (analysis.autoHeld && (newGame || (watched(next) && !over(next)))) {
      // The next game, or this one going again (reconnected to it).
      analysis.held = false;
      analysis.autoHeld = false;
    } else if (prev && !newGame && watched(prev) && !over(prev) && watched(next) && over(next) && !analysis.held) {
      analysis.held = true;
      analysis.autoHeld = true;
    }
  }
  if (newGame || (wasLive && !varNode)) viewPly = null;
  // A game opened from a file starts at its first move, to be stepped
  // through, rather than at its last.
  if (newGame && next.loaded && next.moves.length > 1) viewPly = 1;
  if (newGame) { engineInfo = {}; engineStrings = {}; engineLog = {}; engineSearch = {}; engineScores = []; engineLineOpen = {}; ponderHitsShown.clear(); }
  else if (next.moves.length < (prev?.moves.length ?? 0)) engineScores.length = next.moves.length + 1; // takeback
  // Your engine's next Lichess game brings its window back, open, however
  // it was left (hidden, or folded down to its header).
  if (newGame && next.external?.kind === 'bot' && next.external.live && (engineFloat.hidden || engineFloat.folded)) {
    engineFloat.hidden = false;
    engineFloat.folded = false;
    saveEngineFloat();
  }
  // A Lichess game is shown from your engine's side.
  if (newGame && next.external) flipped = next.external.side === 'black';
  if (prev) playStateSounds(prev, next, newGame);
  syncKeepAwake();
  if (gameOverFor != null && (newGame || next.result === '*')) hideGameOver();
  // The board's game going on (or another taking the board) ends its result
  // screen; not that of a game that ended off the board.
  if ((newGame || next.result === '*') && typeof ko !== 'undefined' && !ko.bg && !(newGame && window.keepKoFor?.(prev))) { window.hideKo?.(true); ko.shown = null; }
  window.syncPlayersInfo?.();
  // The row of small boards marks the game that is on the board.
  if (newGame && typeof renderWatchStrip === 'function') renderWatchStrip();
  if (newGame) window.maybeVersus?.(prev);
  window.renderPositionBar?.();
  window.syncChat?.();
  window.syncMatchHistory?.();
  window.syncCommentary?.();
  if (prev && !newGame && next.external?.ratingDiff && JSON.stringify(next.external.ratingDiff) !== JSON.stringify(prev.external?.ratingDiff)) {
    setTimeout(() => ratingDiffArrived(state), 0);
  }
  if (newGame || !state.active) premove = null;
  if (!state.humanToMove && !premoveMode()) selected = null;
  renderBoard();
  renderPlayers();
  renderStatus();
  renderMoves();
  if (newGame) window.loadAnnotations?.();
  renderOpening();
  renderEngineInfo();
  renderGameInfo();
  renderGames();
  syncAnalysis();
  renderAnalysis();
  playPremove();
}

api.onEvent((event, data) => {
  if (event === 'aiChat') { window.onAiChat?.(data); window.onAiCommentary?.(data); return; }
  if (event === 'state') {
    applyState(data);
  } else if (event === 'ponderHit') {
    // With the opponent's move, before the engine has said anything more.
    noteEngineSearch({ ...data, ponderHit: true });
    popPonderHit(data);
    renderEngineInfo(); // the count of hits under the header
  } else if (event === 'engineInfo') {
    // The move an engine chose comes with its last line when there was one;
    // otherwise only the moves (for the arrows) are new.
    const prev = engineInfo[data.side];
    noteEngineSearch(data);
    if (data.ponderHit) popPonderHit(data);
    if (data.stats) {
      // Between two lines of a search: how deep it has got and how fast it
      // goes. Only the window's header changes.
      const same = prev && prev.ply === data.ply && Boolean(prev.pondering) === Boolean(data.pondering);
      engineInfo[data.side] = same
        ? { ...prev, depth: data.depth || prev.depth, nodes: data.nodes || prev.nodes, nps: data.nps || prev.nps }
        : { side: data.side, ply: data.ply, depth: data.depth, nodes: data.nodes, nps: data.nps, pondering: data.pondering, pv: [] };
      renderEngineHead(data.side);
      return;
    }
    engineInfo[data.side] = data.played && !data.depth && prev
      ? { ...prev, ply: data.ply, best: data.best, ponder: data.ponder, played: true, pondering: false } : data;
    if (data.pondering) {
      // Thinking on the opponent's time: a row of its own, no score for the game.
      logEngineInfo(data);
      renderEngineInfo();
      renderArrow();
      return;
    }
    if (data.hasEval && data.ply != null) {
      const name = state?.players?.[data.side]?.name ?? '';
      engineScores[data.ply + 1] = { cp: data.cp, mate: data.mate, isMate: data.isMate, depth: data.depth, name };
    }
    if (data.depth) logEngineInfo(data);
    else if (data.ponderHit) {
      // A hit answered at once, with no line of its own: its row is marked.
      const row = (engineLog[data.side] ?? []).find((r) => r.ply === data.ply && !r.pondering);
      if (row) row.hit = true;
    }
    renderEngineInfo();
    renderArrow();
    // Your engine's Lichess game shows its scores: after each of its moves
    // in the list, and on the bar beside the board.
    if (state?.external?.kind === 'bot') {
      renderEvalBar();
      scheduleMoveScores();
    }
  } else if (event === 'analysis') {
    // Only results for the position we asked about count.
    if (analysis.on && !analysis.held && data.fen === analysis.sentFen) {
      analysis.data = data;
      renderAnalysis();
    }
  } else if (event === 'pgnProgress') {
    // Only a file being opened onto the board reports here: the database
    // listed quietly at startup leaves the status alone.
    if (openingFile && !openingQuietly) {
      const pct = data.total > 0 ? Math.floor((data.done / data.total) * 100) : 0;
      setStatus(`Reading ${data.name}… ${pct}%`);
    }
  } else if (event === 'epdtest') {
    window.epdTestEvent?.(data);
  } else if (event === 'review') {
    onReviewEvent(data);
  } else if (event === 'tournament') {
    tournamentStatus(data);
  } else if (event === 'pgnChanged') {
    refreshGames(data.path);
  } else if (event === 'databaseSaved') {
    onDatabaseSaved(data);
  } else if (event === 'lichess') {
    lichessStatus(data);
  } else if (event === 'lichessAccount') {
    window.lichessAccountStatus?.(data);
  } else if (event === 'lichessChat') {
    window.lichessChatEvent?.(data);
  } else if (event === 'lichessWatch') {
    lichessWatchStatus(data);
  } else if (event === 'engineString') {
    const list = engineStrings[data.side] ??= [];
    // Engines often repeat a message every move; keep one copy, moved to the end.
    const i = list.findIndex((m) => m.text === data.text);
    if (i >= 0) list.splice(i, 1);
    list.push(data);
    if (list.length > MAX_STRINGS) list.shift();
    renderEngineInfo();
  }
});

// ---------------------------------------------------------------------------
// Game buttons
// ---------------------------------------------------------------------------
async function command(cmd, args) {
  try {
    return await api.backend(cmd, args);
  } catch (err) {
    setStatus(errorText(err));
    return null;
  }
}

$('#btn-flip').onclick = () => { flipped = !flipped; renderBoard(); renderPlayers(); renderAnalysis(); };
async function resign(side) {
  if (state?.external?.live) {
    if (await confirmDialog(`Resign the Lichess game against ${opponentName()}?`, 'Resign')) lichessCommand('lichessResign', { id: state.external.id });
    return;
  }
  if (!state?.active) return;
  const name = state.players[side]?.name;
  const label = side === 'white' ? 'White' : 'Black';
  const who = name && name !== label ? `${name} (${label})` : label;
  if (await confirmDialog(`Resign the game as ${who}?`, 'Resign')) command('resign', { side });
}
for (const btn of document.querySelectorAll('.player .resign')) btn.onclick = () => resign(btn.dataset.side);
async function takeback() {
  if (!state?.canTakeback) return;
  premove = null;
  selected = null;
  try {
    await api.backend('takeback');
  } catch (err) {
    setStatus(errorText(err));
  }
}
for (const btn of document.querySelectorAll('.player .takeback')) btn.onclick = takeback;

// Swapping or reloading the engine of a side, mid-game: the menu of the
// "⇄ Engine" button in its bar. Reload starts it again with its saved
// options (as they are now in Settings → Engines); another engine takes
// over from the position reached, on the same clock.
const engineMenu = $('#engine-menu');
function closeEngineMenu() { engineMenu.hidden = true; }
async function replaceEngine(side, player) {
  closeEngineMenu();
  try {
    await api.backend('replaceEngine', { side, player });
  } catch (err) {
    notify(String(err.message || err), { title: player.enginePath ? 'The engine was not swapped' : 'The engine was not reloaded' });
  }
}
async function openEngineMenu(btn) {
  const side = btn.dataset.side;
  const now = state?.players?.[side];
  if (!now || now.type !== 'engine') return;
  try { engines = await api.engines.list(); } catch { /* the list as it was */ }
  const asPlayer = (e) => ({ name: e.name, enginePath: e.path, engineArgs: e.args ?? [], options: e.options ?? {} });
  const current = engines.find((e) => e.path === now.enginePath && e.name === now.name) ?? engines.find((e) => e.path === now.enginePath);
  const item = (label, sub, onclick, checked = false) => {
    const b = el('button', { type: 'button', role: 'menuitem' }, [label]);
    if (sub) b.append(el('span', { className: 'count', textContent: sub }));
    if (checked) b.classList.add('current');
    b.onclick = onclick;
    return b;
  };
  const others = engines.filter((e) => e !== current);
  engineMenu.replaceChildren(
    el('div', { className: 'menu-head', textContent: `${side === 'white' ? 'White' : 'Black'}: ${now.name}` }),
    item('↻ Reload', current ? 'with its saved options' : 'as it was started', () => replaceEngine(side, current ? asPlayer(current) : {})),
    ...(others.length ? [el('div', { className: 'menu-head', textContent: 'Swap for' })] : []),
    ...others.map((e) => item(e.name, '', () => replaceEngine(side, asPlayer(e)))),
  );
  const r = btn.getBoundingClientRect();
  engineMenu.hidden = false;
  const w = engineMenu.offsetWidth, h = engineMenu.offsetHeight;
  engineMenu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  engineMenu.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  engineMenu.firstElementChild?.nextElementSibling?.focus();
}
for (const btn of document.querySelectorAll('.player .act.engine')) {
  btn.onclick = (e) => { e.stopPropagation(); if (engineMenu.hidden) openEngineMenu(btn); else closeEngineMenu(); };
}
document.addEventListener('click', (e) => { if (!e.target.closest?.('#engine-menu')) closeEngineMenu(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEngineMenu(); });
for (const btn of document.querySelectorAll('.player .draw')) {
  btn.onclick = async () => {
    if (playLive()) {
      if (await confirmDialog(`Offer ${opponentName()} a draw?`, 'Offer draw')) command('draw');
      return;
    }
    if (state?.active && await confirmDialog('Agree a draw? The game ends ½–½.', 'Agree draw')) command('draw');
  };
}
for (const btn of document.querySelectorAll('.player .abort')) {
  btn.onclick = async () => {
    if (state?.external?.live) {
      if (await confirmDialog('Abort the Lichess game? It ends without a result.', 'Abort game')) lichessCommand('lichessAbort', { id: state.external.id });
      return;
    }
    if (state?.active && await confirmDialog('Abort the game? It ends without a result.', 'Abort game')) command('abort');
  };
}
// The analysis to save with the game, in Lichess's PGN form: the
// evaluation after each move as [%eval], ?! ? ?? with a comment naming the
// better move, and the side variations.
// kept: for a save made by itself, which leaves out the lines you have only
// tried on the board (Save, Copy and Save… write them all).
function pgnAnnotations({ kept = false } = {}) {
  if (!state?.moves) return null;
  const ann = { nags: {}, comments: {}, variations: {} };
  const review = window.currentReview?.();
  // The computer's part, by ply: evaluation, mark and what it says.
  const auto = {};
  if (review) {
    const NAG = { inaccuracy: 6, mistake: 2, blunder: 4 };
    review.positions.forEach((p, ply) => {
      if (ply === 0) return;
      const it = auto[ply] = { ev: '', nag: 0, text: '' };
      if (p.final === 'checkmate') it.ev = '';
      else if (p.mate) it.ev = `[%eval #${p.mate}]`;
      else it.ev = `[%eval ${(p.cp / 100).toFixed(2)}]`;
      const j = review.judgments[ply - 1];
      if (j?.kind) {
        it.nag = NAG[j.kind];
        const kind = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[j.kind];
        it.text = `${kind}.${j.best ? ` ${j.best} was best.` : ''}`;
      }
    });
    ann.annotator = `Ponder (${review.engine})`;
  }
  // Yours come first: your mark and comment stand in for the computer's.
  for (let ply = 1; ply <= state.moves.length; ply++) {
    const a = notes.moves.get(ply);
    const it = auto[ply];
    const nags = [a?.nag || it?.nag, a?.pos, ...(a?.other ?? [])].filter(Boolean);
    if (nags.length) ann.nags[ply] = nags;
    // An evaluation the game already carries (from its file) is kept: the
    // analysis adds its own only where there is none.
    const hasEval = /\[%eval[^\]]*\]/.test(a?.cmds ?? '');
    // "[%ai]" marks a comment as the AI's in the file, so that it is known
    // as such when the game is opened again (PGN readers pass over such tags).
    const text = [a?.cmds, a?.ai && a.comment ? '[%ai]' : '', hasEval ? '' : it?.ev, a?.comment || it?.text].filter(Boolean).join(' ').trim();
    if (text) ann.comments[ply] = text;
  }
  if (notes.before?.comment) ann.before = `${notes.before.ai ? '[%ai] ' : ''}${notes.before.comment}`;
  if (!ann.annotator && notes.aiModel && [...notes.moves.values()].some((a) => a.ai)) ann.annotator = `AI (${notes.aiModel})`;
  let anyLine = false;
  for (const [p, all] of tree.branches) {
    const lines = kept ? all.filter((l) => l.keep) : all;
    if (!lines.length) continue;
    anyLine = true;
    const text = lines.map((l) => `(${lineText(l, kept)})`).join(' ');
    if (p < state.moves.length) ann.variations[p + 1] = text;
    else ann.after = `Analysis: ${lines.map((l) => lineText(l, kept)).join('; ')}`;
  }
  const empty = !review && !anyLine && !notes.moves.size && !notes.before?.comment;
  return empty ? null : ann;
}

const gamePgn = () => command('pgn', { annotations: pgnAnnotations() });

$('#btn-pgn').onclick = async () => {
  const pgn = await gamePgn();
  if (!pgn) return;
  await api.copyText(pgn);
  const btn = $('#btn-pgn');
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
};

async function exportPgn() {
  if (!state?.players) return;
  const pgn = await gamePgn();
  if (!pgn) return;
  try {
    const file = await api.savePgn(pgn);
    if (file) setStatus(`Saved ${file.split(/[\\/]/).pop()}`);
  } catch (err) {
    setStatus('Could not save the PGN: ' + errorText(err));
  }
}
$('#btn-export').onclick = exportPgn;

// A yes/no question in a small dialog. Resolves true if confirmed.
function confirmDialog(text, okLabel) {
  const dlg = $('#dlg-confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  return new Promise((resolve) => {
    const finish = (value) => {
      dlg.onclose = null;
      dlg.close();
      resolve(value);
    };
    $('#form-confirm').onsubmit = (e) => { e.preventDefault(); finish(true); };
    $('#confirm-cancel').onclick = () => finish(false);
    dlg.onclose = () => resolve(false); // Esc
    dlg.showModal();
    $('#confirm-ok').focus();
  });
}

// ---------------------------------------------------------------------------
// Side panel tabs: Moves and Games
// ---------------------------------------------------------------------------
function showTab(name) {
  for (const tab of ['moves', 'explorer', 'puzzles', 'games', 'lichess', 'tournament']) {
    const on = tab === name;
    $(`#tab-${tab}`).classList.toggle('active', on);
    $(`#tab-${tab}`).setAttribute('aria-selected', on);
    $(`#pane-${tab}`).hidden = !on;
  }
  workspace.dataset.tab = name;
  applyLayout();
  if (name === 'games') $('#games-list .game-row.current')?.scrollIntoView({ block: 'center' });
  else $('#moves .current')?.scrollIntoView({ block: 'nearest' });
}
$('#tab-moves').onclick = () => showTab('moves');
$('#tab-games').onclick = () => showTab('games');
$('#tab-lichess').onclick = () => showTab('lichess');
$('#tab-explorer').onclick = () => { showTab('explorer'); window.renderExplorer?.(); };
$('#tab-puzzles').onclick = () => showTab('puzzles');
$('#tab-tournament').onclick = () => { window.fillTournamentEngines?.(); showTab('tournament'); };

// ---------------------------------------------------------------------------
// Games: every game in the open PGN file
// ---------------------------------------------------------------------------
let collection = null; // { source, total, errors: { index: message }, list: { matched, games } }
const GAME_LIST_LIMIT = 1000;

const currentIndex = () => (state?.loaded && collection && state.source === collection.source ? state.index : -1);

// Ask the backend for the rows matching the filter. Only the rows shown are
// sent, however many games the file holds.
// How the list is sorted: by a column, up or down. Kept between sessions.
const GAME_COLUMNS = [
  ['index', 'c-num', '#', 'Place in the file'], ['white', 'c-white', 'White'], ['black', 'c-black', 'Black'],
  ['result', 'c-result', 'Result'], ['event', 'c-event', 'Event'], ['date', 'c-date', 'Date'],
  ['round', 'c-round', 'Round'], ['moves', 'c-plies', 'Moves'],
];
const gamesSort = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('gamesSort') ?? '{}') ?? {};
    if (GAME_COLUMNS.some(([by]) => by === saved.by)) return { by: saved.by, desc: Boolean(saved.desc) };
  } catch { /* file order */ }
  return { by: 'index', desc: false };
})();
function sortGames(by) {
  if (gamesSort.by === by) gamesSort.desc = !gamesSort.desc;
  // Dates and lengths are most often wanted newest and longest first.
  else Object.assign(gamesSort, { by, desc: by === 'date' || by === 'moves' });
  try { localStorage.setItem('gamesSort', JSON.stringify(gamesSort)); } catch { /* ignore */ }
  fetchGames();
}

// The search: what the Search panel asks of the games listed.
const searchFields = () => [...$('#games-search').querySelectorAll('[data-q]')];
function gamesQuery() {
  const q = {};
  for (const f of searchFields()) {
    const v = f.value.trim();
    if (!v) continue;
    q[f.dataset.q] = f.type === 'number' ? Math.max(0, Math.round(+v) || 0) : v;
  }
  return q;
}
const searchCount = () => Object.values(gamesQuery()).filter(Boolean).length;
function clearGamesSearch() {
  for (const f of searchFields()) f.value = '';
}
function renderGamesSearch() {
  const n = searchCount();
  $('#games-search-count').textContent = n ? String(n) : '';
  $('#games-search-clear').disabled = !n;
  const list = collection?.list;
  $('#games-search-note').textContent = !n ? 'Fill in what the games must have; every part must hold.'
    : list ? `${list.matched.toLocaleString()} of ${collection.total.toLocaleString()} games match.` : '';
}
$('#games-search-toggle').onclick = () => {
  const open = $('#games-search').hidden;
  $('#games-search').hidden = !open;
  $('#games-search-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#gs-player').focus();
};
let searchTimer = null;
$('#games-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(fetchGames, 150);
});
$('#games-search').onsubmit = (e) => { e.preventDefault(); clearTimeout(searchTimer); fetchGames(); };
$('#games-search-clear').onclick = () => { clearGamesSearch(); fetchGames(); };

let listRequest = 0;
async function fetchGames() {
  if (!collection) return renderGames();
  const id = ++listRequest;
  const list = await command('listGames', {
    filter: $('#games-filter').value, limit: GAME_LIST_LIMIT, query: gamesQuery(), sort: gamesSort.by, desc: gamesSort.desc,
  });
  if (id !== listRequest || !collection || !list) return; // superseded
  collection.list = list;
  renderGames();
}

function renderGames() {
  const has = !!collection;
  $('#games-empty').hidden = has;
  $('#games-head').hidden = !has;
  $('#games-tools').hidden = !has;
  if (!has) { $('#games-search').hidden = true; $('#games-search-toggle').setAttribute('aria-expanded', 'false'); }
  // Edit and Delete act on the game on the board, when it is from this file.
  const shown = has ? currentIndex() : -1;
  $('#games-edit').disabled = $('#games-delete').disabled = shown < 0;
  if (!has) {
    $('#games-list').replaceChildren();
    $('#games-note').hidden = true;
    return;
  }
  const n = collection.total;
  $('#games-file').textContent = `${collection.source} · ${n.toLocaleString()} game${n === 1 ? '' : 's'}`;
  $('#games-file').title = collection.source;
  renderDatabaseButton();
  const list = collection.list ?? { matched: 0, games: [] };
  const current = currentIndex();
  const cell = (cls, text) => el('span', { className: cls, textContent: text, title: text });
  const date = (d) => (d ?? '').replace(/\.\?\?/g, '').replace(/^\?+$/, '');
  const round = (r) => (r && r !== '-' && r !== '?' ? r : '');
  // The result is a small badge; the winner's name stands out.
  const results = { '1-0': ['1–0', 'white'], '0-1': ['0–1', 'black'], '1/2-1/2': ['½–½', 'draw'] };
  const rows = list.games.map((g) => {
    const error = collection.errors[g.index] ?? g.error;
    const [resText, resKind] = results[g.result] ?? ['*', 'open'];
    const player = (cls, name, won) => {
      const c = cell(cls + (won ? ' won' : ''), name || '?');
      // A game played on Lichess: the names are Lichess players, with flags.
      const flag = g.lichess && name ? flagSpan(name) : null;
      if (flag) c.prepend(flag);
      c.prepend(el('i', { className: 'side' }));
      return c;
    };
    const row = el('button', { type: 'button', className: 'game-row' }, [
      cell('c-num', (g.index + 1).toLocaleString()),
      player('c-white', g.white, resKind === 'white'),
      player('c-black', g.black, resKind === 'black'),
      el('span', { className: 'c-result', title: g.result || '*' }, [el('b', { className: `res ${resKind}`, textContent: resText })]),
      cell('c-event', g.event === '?' ? '' : g.event),
      cell('c-date', date(g.date)),
      cell('c-round', round(g.round)),
      cell('c-plies', String(Math.ceil(g.plies / 2))),
      error ? el('span', { className: 'c-error', textContent: error }) : '',
    ]);
    row.dataset.index = g.index;
    if (g.index === current) row.classList.add('current');
    if (error) row.classList.add('broken');
    row.onclick = () => selectGame(g.index);
    return row;
  });
  if (rows.length) {
    rows.unshift(el('div', { className: 'game-row head' }, GAME_COLUMNS.map(([by, cls, text, hint]) => {
      const on = gamesSort.by === by;
      const b = el('button', {
        type: 'button', className: `sort ${cls}` + (on ? ' on' : '') + (on && gamesSort.desc ? ' desc' : ''), textContent: text,
        title: `Sort by ${(hint ?? text).toLowerCase()}${on ? (gamesSort.desc ? ': now downwards, click for upwards' : ': now upwards, click for downwards') : ''}`,
      });
      b.setAttribute('aria-sort', on ? (gamesSort.desc ? 'descending' : 'ascending') : 'none');
      b.onclick = () => sortGames(by);
      return b;
    })));
  }
  renderGamesSearch();
  if (rows.length === 0 && collection.list) rows.push(el('p', { className: 'hint', textContent: 'No games match.' }));
  // The list is drawn again; the row that had the keyboard keeps it.
  const focused = document.activeElement?.closest?.('#games-list .game-row')?.dataset.index ?? gamesFocus;
  gamesFocus = null;
  $('#games-list').replaceChildren(...rows);
  if (focused != null) {
    const all = [...$('#games-list').querySelectorAll('.game-row[data-index]')];
    (all.find((r) => r.dataset.index === String(focused)) ?? (all.length && +focused > +all.at(-1).dataset.index ? all.at(-1) : null))?.focus({ preventScroll: true });
  }
  const note = $('#games-note');
  note.hidden = list.matched <= list.games.length;
  note.textContent = `Showing the first ${list.games.length.toLocaleString()} of ${list.matched.toLocaleString()} matching games; filter to narrow the list.`;
}

let filterTimer = null;
$('#games-filter').oninput = () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(fetchGames, 120);
};
$('#games-filter').onkeydown = async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(filterTimer);
    await fetchGames();
    $('#games-list .game-row:not(.head)')?.click();
  }
};
$('#games-open').onclick = () => openPgn();
$('#games-open-db').onclick = () => openDatabase();
$('#games-db').onclick = () => openDatabase();

// ---------------------------------------------------------------------------
// The game database: finished games are added to a PGN file.
// ---------------------------------------------------------------------------
let database = null;

// The game database is listed in the Games tab from the start (and as soon
// as it has its first game), without taking the board.
async function listDatabase() {
  if (collection || openingFile) return;
  try { database = await api.database.settings(); } catch { return; }
  if (!database?.exists) return;
  await openPgn({ name: database.path.split(/[\\/]/).pop(), path: database.path }, { list: true });
}

// The open file changed (a game was added to it, here or by another
// program): read it again and show the list as it is now.
let refreshing = null;
async function refreshGames(path) {
  if (!collection || (path && path !== collection.path)) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const r = await api.backend('refreshPgn', { path: collection.path });
      if (r?.refreshed && collection) {
        collection.total = r.total;
        collection.errors = {};
        await fetchGames();
      }
    } catch (err) {
      setStatus(errorText(err));
    }
  })();
  try { await refreshing; } finally { refreshing = null; }
}

// Reload: read the open file again, whether or not it looks changed.
$('#games-reload').onclick = async () => {
  if (!collection) return;
  const b = $('#games-reload');
  b.disabled = true;
  b.classList.add('busy');
  const source = collection.source;
  try {
    await refreshGames();
    if (collection) setStatus(`Reloaded ${source}: ${collection.total.toLocaleString()} game${collection.total === 1 ? '' : 's'}`);
  } finally {
    b.disabled = false;
    b.classList.remove('busy');
  }
};

// --- Changing the open file: import, export, delete, edit a game's info ---

function gamesChanged(total) {
  collection.total = total;
  collection.errors = {};
  return fetchGames();
}

$('#games-import').onclick = async () => {
  if (!collection) return;
  let file;
  try { file = await api.openPgn(); } catch (err) { setStatus(errorText(err)); return; }
  if (!file) return;
  setStatus(`Importing ${file.name}…`);
  try {
    const r = await api.backend('pgnImport', { path: file.path });
    await gamesChanged(r.total);
    setStatus(`${r.imported.toLocaleString()} game${r.imported === 1 ? '' : 's'} from ${file.name} added to ${collection.source}.`);
  } catch (err) {
    setStatus(errorText(err));
  }
};

$('#games-export').onclick = async () => {
  if (!collection) return;
  const filter = $('#games-filter').value.trim();
  const query = gamesQuery();
  const narrowed = filter || searchCount() > 0;
  const n = narrowed ? collection.list?.matched ?? 0 : collection.total;
  if (!n) { setStatus('No games to export.'); return; }
  let file;
  try {
    file = await api.exportPgnPath(narrowed ? `${collection.source.replace(/\.pgn$/i, '')} ${filter || 'selection'}` : collection.source);
  } catch (err) { setStatus(errorText(err)); return; }
  if (!file) return;
  try {
    const r = await api.backend('pgnExport', { path: file, filter, query });
    setStatus(`${r.exported.toLocaleString()} game${r.exported === 1 ? '' : 's'} exported to ${r.name}.`);
  } catch (err) {
    setStatus(errorText(err));
  }
};

const gameTitle = (index) => {
  const g = collection?.list?.games.find((x) => x.index === index);
  const names = g ? `${g.white || '?'} – ${g.black || '?'}` : `${state.players?.white?.name ?? '?'} – ${state.players?.black?.name ?? '?'}`;
  return `game ${(index + 1).toLocaleString()} (${names})`;
};

// Deletes game index from the open file, after asking. With keepFocus the
// keyboard stays in the list, on the game that takes its place.
let gamesFocus = null; // the row to give the keyboard to when the list is next drawn
async function deleteGame(index, keepFocus = false) {
  if (!collection || index < 0) return;
  const source = collection.source;
  const before = collection.total;
  const ok = await confirmDialog(`Delete ${gameTitle(index)} from ${source}? It is removed from the file and cannot be brought back.`, 'Delete game');
  // The file may have changed while the question was up.
  if (!ok || !collection || collection.source !== source || collection.total !== before) return;
  const shown = index === currentIndex();
  try {
    const r = await api.backend('pgnDelete', { indices: [index] });
    if (keepFocus) gamesFocus = index;
    await gamesChanged(r.total);
    setStatus(`Game deleted from ${source}.${shown ? ' It stays on the board until you show another.' : ''}`);
  } catch (err) {
    setStatus(errorText(err));
  }
}
$('#games-delete').onclick = () => deleteGame(currentIndex());
// Delete (or Backspace, the Mac's delete key) on a game in the list.
$('#games-list').addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const row = e.target.closest?.('.game-row[data-index]');
  if (!row) return;
  e.preventDefault();
  deleteGame(+row.dataset.index, true);
});

const dlgGameInfo = $('#dlg-game-info');
const gameInfoFields = () => [...dlgGameInfo.querySelectorAll('[data-tag]')];
let editingGame = -1;

$('#games-edit').onclick = async () => {
  const index = currentIndex();
  if (index < 0) return;
  let tags;
  try {
    tags = new Map((await api.backend('pgnTags', { index })).tags.map((t) => [t.name, t.value]));
  } catch (err) { setStatus(errorText(err)); return; }
  editingGame = index;
  const blank = (v) => (!v || v === '?' || v === '-' || /^\?+(\.\?+)*$/.test(v) ? '' : v);
  for (const f of gameInfoFields()) {
    const v = tags.get(f.dataset.tag) ?? '';
    if (f.dataset.tag === 'Result') f.value = ['1-0', '0-1', '1/2-1/2'].includes(v) ? v : '*';
    else f.value = blank(v);
    f.dataset.was = f.value;
  }
  $('#gi-edit-which').textContent = `${gameTitle(index).replace(/^g/, 'G')} in ${collection.source}`;
  $('#gi-edit-error').hidden = true;
  dlgGameInfo.showModal();
};
$('#gi-edit-cancel').onclick = () => dlgGameInfo.close();
$('#form-game-info').onsubmit = async (e) => {
  e.preventDefault();
  const error = (text) => { $('#gi-edit-error').textContent = text; $('#gi-edit-error').hidden = false; };
  const tags = gameInfoFields().filter((f) => f.value.trim() !== f.dataset.was).map((f) => ({ name: f.dataset.tag, value: f.value.trim() }));
  if (!tags.length) { dlgGameInfo.close(); return; }
  const date = tags.find((t) => t.name === 'Date')?.value;
  if (date && !/^[\d?]{4}(\.[\d?]{2}){0,2}$/.test(date)) return error('Write the date as YYYY.MM.DD (YYYY or YYYY.MM also work).');
  for (const name of ['WhiteElo', 'BlackElo']) {
    const v = tags.find((t) => t.name === name)?.value;
    if (v && !/^\d{1,5}$/.test(v)) return error('A rating is a number.');
  }
  if (date) tags.find((t) => t.name === 'Date').value = [...date.split('.'), '??', '??'].slice(0, 3).join('.');
  const index = editingGame;
  $('#gi-edit-save').disabled = true;
  try {
    const r = await api.backend('pgnEdit', { index, tags });
    dlgGameInfo.close();
    await gamesChanged(r.total);
    // The board shows this game: show it again with its new details.
    if (index === currentIndex()) await api.backend('selectGame', { index }).catch(() => {});
    setStatus(`Game info saved to ${collection.source}.`);
  } catch (err) {
    error(errorText(err));
  } finally {
    $('#gi-edit-save').disabled = false;
  }
};

// Lists the game database (the default file finished games go to) in the
// Games tab. The board keeps what it shows; click a game to load it.
async function openDatabase() {
  database = await api.database.settings();
  if (!database?.path) { setStatus('No game database is set (Settings → Database).'); return; }
  const name = database.path.split(/[\\/]/).pop();
  if (!database.exists) {
    setStatus(`${name} has no games yet. Finished games are added when they end.`);
    return;
  }
  showTab('games');
  await openPgn({ name, path: database.path }, { list: true });
  renderDatabaseButton();
}

// The button in the list's header: off while the database is what is listed.
function renderDatabaseButton() {
  const btn = $('#games-db');
  const listed = Boolean(collection && database?.path && collection.path === database.path);
  btn.disabled = listed;
  btn.title = listed ? 'The game database is listed' : `List the games in your game database${database?.path ? ` (${database.path.split(/[\\/]/).pop()})` : ''}, where finished games are kept`;
}

// A game was added: keep the Games list up to date when it shows the file.
async function onDatabaseSaved(ev) {
  if (ev.error) {
    setStatus(`Could not save the game to ${ev.name}: ${ev.error}`);
    return;
  }
  if (database) database.exists = true;
  if (collection) await refreshGames(ev.path);
  else await listDatabase(); // its first game: the list appears
  // The game now has a place in a file: annotations made while it was
  // played (the commentary's, yours) can be saved into it.
  window.autosaveAnnotations?.(true);
  if (state && !state.active && !state.external?.live && ev.kind !== 'lichess' && ev.kind !== 'watched') {
    setStatus(`${$('#status').textContent} · saved to ${ev.name}`);
  } else if (ev.kind !== 'local') {
    flashNote(`Game saved to ${ev.name}`);
  }
}

// A short message in the status bar that does not replace the game status.
function flashNote(text) {
  const box = $('#status');
  const before = box.textContent;
  box.textContent = `${before} · ${text}`;
  setTimeout(() => { if (box.textContent === `${before} · ${text}`) box.textContent = before; }, 4000);
}

function fillDatabaseSettings() {
  $('#db-on').checked = database.enabled;
  $('#db-path').value = database.path;
  $('#db-path').title = database.path;
  $('#db-local').checked = database.local;
  $('#db-lichess').checked = database.lichess;
  $('#db-watched').checked = database.watched;
  for (const id of ['#db-path', '#db-choose', '#db-local', '#db-lichess', '#db-watched']) $(id).disabled = !database.enabled;
  $('#db-error').hidden = true;
  renderDatabaseButton();
}

async function saveDatabaseSettings(patch) {
  try {
    database = await api.database.save(patch);
    fillDatabaseSettings();
  } catch (err) {
    $('#db-error').textContent = errorText(err);
    $('#db-error').hidden = false;
  }
}
$('#db-on').onchange = (e) => saveDatabaseSettings({ enabled: e.target.checked });
for (const k of ['local', 'lichess', 'watched']) $('#db-' + k).onchange = (e) => saveDatabaseSettings({ [k]: e.target.checked });
$('#db-choose').onclick = async () => {
  const file = await api.database.choose();
  if (file) saveDatabaseSettings({ path: file });
};
$('#db-open').onclick = async () => {
  dlgSettings.close();
  await openDatabase();
};
$('#games-close').onclick = async () => {
  await command('closePgn');
  collection = null;
  $('#games-filter').value = '';
  clearGamesSearch();
  renderGames();
  renderStatus();
};

async function selectGame(index) {
  if (index === currentIndex()) return;
  if (state?.active && !(await confirmDialog('Showing a game from the file ends the game in progress.', 'Show game'))) return;
  try {
    await api.backend('selectGame', { index });
    delete collection.errors[index];
  } catch (err) {
    collection.errors[index] = errorText(err);
  }
  renderGames();
}

let openingFile = false;
let openingQuietly = false; // the file is only being listed (no status messages)
// With list, the file is only listed in the Games tab: the board and the
// tab shown stay as they are.
async function openPgn(given, { list = false } = {}) {
  if (typeof given?.path !== 'string') given = null; // e.g. a click event
  if (openingFile) return;
  if (!list && state?.active && !(await confirmDialog('Opening a PGN file ends the game in progress.', given ? 'Open database' : 'Open file…'))) return;
  let file = given;
  if (!file) {
    try {
      file = await api.openPgn();
    } catch (err) {
      setStatus(errorText(err));
      return;
    }
  }
  if (!file) return;
  openingFile = true;
  openingQuietly = list;
  $('#btn-open').disabled = $('#games-open').disabled = true;
  if (!list) setStatus(`Reading ${file.name}…`);
  let result;
  try {
    result = await api.backend('openPgn', { path: file.path, list });
  } catch (err) {
    if (!list) setStatus(errorText(err));
    return;
  } finally {
    openingFile = false;
    $('#btn-open').disabled = $('#games-open').disabled = false;
  }
  collection = { source: result.name, path: file.path, total: result.total, errors: result.errors ?? {}, list: null };
  $('#games-filter').value = '';
  clearGamesSearch();
  renderGames();
  if (list) { await fetchGames(); return; }
  showTab('games');
  await fetchGames();
  renderStatus();
  if (result.index < 0) setStatus(`None of the games in ${result.name} could be loaded.`);
}
$('#btn-open').onclick = () => openPgn();
// In the app, Ctrl/⌘+O and S come from the application menu; these are
// for when there is none (the page open on its own).
window.addEventListener('keydown', (e) => {
  if (api.onMenu) return;
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== 's' && key !== 'o') return;
  e.preventDefault();
  if (document.querySelector('dialog:modal')) return;
  if (key === 's') exportPgn();
  else openPgn();
});

// ---------------------------------------------------------------------------
// New game dialog
// ---------------------------------------------------------------------------
const dlgNew = $('#dlg-new');
const slots = [...document.querySelectorAll('#dlg-new fieldset[data-slot]')].map((box) => ({
  box,
  legend: $('legend', box),
  name: $('.human-name', box),
  engine: $('.engine-select', box),
  tc: createTimeControlEditor($('.tc', box)),
}));
const sharedTc = createTimeControlEditor($('#shared-tc'));

const mode = () => $('input[name="mode"]:checked').value;
// Which slots are engines in each mode. In "hc" slot 0 is you, slot 1 the computer.
const slotIsEngine = () => ({ hh: [false, false], hc: [false, true], cc: [true, true] }[mode()]);

function kindsFor(isEngine) {
  return isEngine ? ['clock', 'movetime', 'depth'] : ['clock', 'movetime', 'none'];
}

function syncNewDialog() {
  const m = mode();
  const isEngine = slotIsEngine();
  const same = $('#same-tc').checked;
  $('#row-color').hidden = m !== 'hc';
  slots.forEach((slot, i) => {
    slot.legend.textContent = m === 'hc' ? ['You', 'Computer'][i] : ['White', 'Black'][i];
    $('.who-human', slot.box).hidden = isEngine[i];
    $('.who-engine', slot.box).hidden = !isEngine[i];
    $('.tc', slot.box).hidden = same;
    slot.tc.setKinds(kindsFor(isEngine[i]));
  });
  $('#shared-tc-box').hidden = !same;
  // A shared control must suit both players.
  sharedTc.setKinds(kindsFor(isEngine[0]).filter((k) => kindsFor(isEngine[1]).includes(k)));
}

function fillEngineSelects() {
  for (const slot of slots) {
    const current = slot.engine.value;
    slot.engine.replaceChildren(...engines.map((e) => el('option', { value: e.id, textContent: e.name })));
    if (engines.some((e) => e.id === current)) slot.engine.value = current;
  }
  // The Tournament tab lists the engines too.
  if (typeof refreshTournamentEngines === 'function') refreshTournamentEngines();
  // So does the Lichess tab, for the engine your bot plays with.
  window.fillLichessEngine?.();
}

function saveSetup() {
  localStorage.setItem('setup', JSON.stringify({
    mode: mode(),
    color: $('#human-color').value,
    same: $('#same-tc').checked,
    shared: sharedTc.snapshot(),
    slots: slots.map((s) => ({ name: s.name.value, engine: s.engine.value, tc: s.tc.snapshot() })),
  }));
}

function loadSetup() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('setup')); } catch { /* ignore */ }
  if (!saved) return;
  const radio = $(`input[name="mode"][value="${saved.mode}"]`);
  if (radio) radio.checked = true;
  $('#human-color').value = saved.color ?? 'white';
  $('#same-tc').checked = saved.same !== false;
  syncNewDialog();
  sharedTc.set(saved.shared);
  slots.forEach((slot, i) => {
    const s = saved.slots?.[i];
    if (!s) return;
    slot.name.value = s.name || slot.name.value;
    if (engines.some((e) => e.id === s.engine)) slot.engine.value = s.engine;
    slot.tc.set(s.tc);
  });
}

function buildConfig() {
  const m = mode();
  const isEngine = slotIsEngine();
  const same = $('#same-tc').checked;
  const players = slots.map((slot, i) => {
    const timeControl = same ? sharedTc.get() : slot.tc.get();
    if (!isEngine[i]) {
      const fallback = m === 'hc' ? 'You' : ['White', 'Black'][i];
      return { type: 'human', name: slot.name.value.trim() || fallback, timeControl };
    }
    const engine = engines.find((e) => e.id === slot.engine.value);
    if (!engine) throw new Error('Choose an engine first (add one under Engines).');
    return {
      type: 'engine', name: engine.name, enginePath: engine.path,
      engineArgs: engine.args ?? [], options: engine.options ?? {}, timeControl,
    };
  });
  let humanIsBlack = false;
  if (m === 'hc') {
    const color = $('#human-color').value;
    humanIsBlack = color === 'black' || (color === 'random' && Math.random() < 0.5);
  }
  const [white, black] = humanIsBlack ? [players[1], players[0]] : players;
  return { config: { white, black, fen: $('#start-fen').value.trim() }, humanIsBlack };
}

$('#btn-new').onclick = async () => {
  engines = await api.engines.list();
  fillEngineSelects();
  syncNewDialog();
  $('#new-error').hidden = true;
  dlgNew.showModal();
};
$('#new-cancel').onclick = () => dlgNew.close();
$('#mode').onchange = syncNewDialog;
$('#same-tc').onchange = syncNewDialog;

$('#form-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#new-error');
  const submit = $('#form-new button[type="submit"]');
  submit.disabled = true;
  try {
    const { config, humanIsBlack } = buildConfig();
    await api.backend('newGame', config);
    saveSetup();
    flipped = humanIsBlack;
    renderBoard();
    renderPlayers();
    dlgNew.close();
  } catch (err) {
    error.textContent = errorText(err);
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Engine manager
// ---------------------------------------------------------------------------
const dlgOptions = $('#dlg-options');

function engineError(err) {
  const box = $('#engine-error');
  box.textContent = err ? errorText(err) : '';
  box.hidden = !err;
}

// Command-line options are edited as one line, split like a shell would:
// spaces separate, quotes ("…" or '…') keep spaces, \ escapes.
function splitArgs(line) {
  const args = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) throw new Error('A quote is not closed.');
  if (started) args.push(cur);
  return args;
}

function joinArgs(args) {
  return (args ?? []).map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');
}

// The engine manager: a dense list on the left (sorted by name, with a
// search box, arrow keys to move) and the chosen engine's details on the
// right, so twenty engines and more stay easy to find and edit.
let engineSel = null;
const engineSort = (a, b) => (!!b.builtin - !!a.builtin) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function engineUses(engine) {
  const uses = [];
  if (engine.id === analysisSettings().engineId) uses.push('Analysis');
  if (typeof lx !== 'undefined' && engine.id === lx.settings?.engineId) uses.push('Lichess');
  return uses;
}

function engineShown() {
  const query = $('#engine-filter').value.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  return engines.filter((e) => {
    const text = `${e.name} ${e.path ?? ''} ${(e.args ?? []).join(' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }).sort(engineSort);
}

function renderEngineList() {
  if (!engines.some((e) => e.id === engineSel)) engineSel = (engines.find((e) => e.id === analysisSettings().engineId) ?? [...engines].sort(engineSort)[0])?.id ?? null;
  renderEngineItems();
  renderEngineDetail();
}

function renderEngineItems() {
  const shown = engineShown();
  const query = $('#engine-filter').value.trim();
  $('#engine-count').textContent = query ? `${shown.length} of ${engines.length}` : `${engines.length} engine${engines.length === 1 ? '' : 's'}`;
  const items = shown.map((engine) => {
    const uses = engineUses(engine);
    const item = el('button', {
      type: 'button', role: 'option', className: 'engine-item', tabIndex: engine.id === engineSel ? 0 : -1,
      ariaSelected: String(engine.id === engineSel), title: engine.builtin ? engine.name : `${engine.name}\n${engine.path}`,
    }, [
      el('span', { className: 'engine-item-name', textContent: engine.name }),
      ...(Object.keys(engine.options ?? {}).length || engine.args?.length ? [el('span', { className: 'engine-mark set', title: 'Options or a command line are set' })] : []),
      ...(uses.length ? [el('span', { className: 'engine-mark use', title: `Used for ${uses.join(' and ')}` })] : []),
    ]);
    item.dataset.id = engine.id;
    item.onclick = () => selectEngine(engine.id);
    return item;
  });
  const list = $('#engine-list');
  list.replaceChildren(...(items.length ? items : [el('p', { className: 'hint engine-none', textContent: engines.length ? 'No engine matches.' : 'No engines yet.' })]));
}

function selectEngine(id, { focus = true } = {}) {
  engineSel = id;
  for (const item of $('#engine-list').querySelectorAll('.engine-item')) {
    const on = item.dataset.id === id;
    item.ariaSelected = String(on);
    item.tabIndex = on ? 0 : -1;
    if (on) { item.scrollIntoView({ block: 'nearest' }); if (focus) item.focus(); }
  }
  renderEngineDetail();
}

function engineChanged() { fillEngineSelects(); fillAnalysisSettings(); }

function renderEngineDetail() {
  const box = $('#engine-detail');
  const engine = engines.find((e) => e.id === engineSel);
  if (!engine) { box.replaceChildren(el('p', { className: 'hint', textContent: 'Add an engine to see it here.' })); return; }

  const name = el('input', { type: 'text', className: 'engine-detail-name', value: engine.name, maxLength: 60, ariaLabel: 'Name', spellcheck: false, readOnly: !!engine.builtin });
  name.onchange = async () => {
    if (!name.value.trim()) { name.value = engine.name; return; }
    engines = await api.engines.update(engine.id, { name: name.value.trim() });
    renderEngineItems(); engineChanged();
  };
  name.onkeydown = (e) => { if (e.key === 'Enter') name.blur(); };
  const tags = [
    ...(engine.builtin ? ['Built-in'] : []),
    ...engineUses(engine).map((u) => `${u} engine`),
  ].map((t) => el('span', { className: 'tag', textContent: t }));

  const fields = [];
  fields.push(el('div', { className: 'engine-field' }, [el('span', { textContent: 'Program' }),
    el('span', { className: 'engine-path', textContent: engine.builtin ? 'Bundled with the app' : engine.path })]));

  if (!engine.builtin) {
    const args = el('input', {
      type: 'text', className: 'engine-args', value: joinArgs(engine.args), spellcheck: false,
      placeholder: 'None, e.g. --uci or -threads 4',
      title: 'Passed to the engine when it starts. Spaces separate options; put an option with spaces in quotes.',
    });
    const note = el('div', { className: 'engine-args-note' });
    args.onkeydown = (e) => { if (e.key === 'Enter') args.blur(); };
    args.onchange = async () => {
      let list;
      try {
        list = splitArgs(args.value);
      } catch (err) {
        note.textContent = errorText(err);
        note.className = 'engine-args-note error';
        return;
      }
      engines = await api.engines.update(engine.id, { args: list });
      args.value = joinArgs(list);
      renderEngineItems();
      // Check that the engine starts with them.
      note.textContent = 'Starting the engine…';
      note.className = 'engine-args-note';
      try {
        const info = await api.engines.probe(engine.id);
        note.textContent = `Starts with these options: ${info.name}${info.author ? ' by ' + info.author : ''}`;
        engineError(null);
      } catch (err) {
        note.textContent = `The engine did not start with these options: ${errorText(err)}`;
        note.className = 'engine-args-note error';
      }
    };
    fields.push(el('label', { className: 'engine-field' }, [el('span', { textContent: 'Command line' }), el('span', {}, [args, note])]));
  }

  const set = Object.entries(engine.options ?? {});
  const optionsBtn = el('button', { type: 'button', className: 'small', textContent: 'Edit options…', title: 'The engine’s own settings: threads, hash size and more' });
  optionsBtn.onclick = () => openOptions(engine);
  fields.push(el('div', { className: 'engine-field engine-field-top' }, [el('span', { textContent: 'Options' }),
    el('span', { className: 'engine-opts' }, [
      ...(set.length
        ? set.map(([k, v]) => el('span', { className: 'engine-opt', textContent: `${k} ${v === true ? 'on' : v === false ? 'off' : v}`, title: `${k}: ${v}` }))
        : [el('span', { className: 'hint', textContent: 'All at the engine’s defaults' })]),
    ]),
    el('span', {}, [optionsBtn])]));

  const foot = [];
  if (!engine.builtin) {
    const remove = el('button', { type: 'button', className: 'small danger', textContent: 'Remove engine' });
    remove.onclick = async () => {
      const order = engineShown();
      const at = order.findIndex((e) => e.id === engine.id);
      engines = await api.engines.remove(engine.id);
      engineSel = (order[at + 1] ?? order[at - 1])?.id ?? null;
      renderEngineList(); engineChanged();
    };
    foot.push(remove);
  }

  box.replaceChildren(
    el('div', { className: 'engine-detail-head' }, [name, ...(tags.length ? [el('div', { className: 'engine-tags' }, tags)] : [])]),
    el('div', { className: 'engine-fields' }, fields),
    el('div', { className: 'engine-foot' }, foot),
  );
}

// Keys: arrows, Home and End move through the list; in the search box,
// Down goes to the list and Enter picks the first match.
$('#engine-list').onkeydown = (e) => {
  const order = engineShown();
  const at = order.findIndex((x) => x.id === engineSel);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: order.length - 1, PageDown: at + 8, PageUp: at - 8 }[e.key];
  if (to === undefined || !order.length) return;
  e.preventDefault();
  if (e.key === 'ArrowUp' && at <= 0) { $('#engine-filter').focus(); return; }
  selectEngine(order[Math.max(0, Math.min(order.length - 1, to))].id);
};
$('#engine-filter').oninput = () => {
  const shown = engineShown();
  if (shown.length && !shown.some((e) => e.id === engineSel)) { engineSel = shown[0].id; renderEngineDetail(); }
  renderEngineItems();
};
$('#engine-filter').onkeydown = (e) => {
  const shown = engineShown();
  if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; renderEngineItems(); selectEngine(engineSel, { focus: false }); }
  else if ((e.key === 'ArrowDown' || e.key === 'Enter') && shown.length) {
    e.preventDefault();
    selectEngine(shown.some((x) => x.id === engineSel) && e.key === 'ArrowDown' ? engineSel : shown[0].id);
  }
};

$('#engine-add').onclick = async () => {
  engineError(null);
  const btn = $('#engine-add');
  btn.disabled = true;
  try {
    const added = await api.engines.add();
    engines = await api.engines.list();
    if (added?.engine) {
      engineSel = added.engine.id;
      $('#engine-filter').value = '';
    }
    renderEngineList();
    if (added?.engine) selectEngine(added.engine.id, { focus: false });
    engineChanged();
    if (added?.error) {
      engineError(`${added.engine.name} was added, but did not start as a UCI engine (${added.error}). If it needs command-line options, enter them beside Command line.`);
    } else if (added?.engine) {
      // A new engine: straight to its UCI options (threads, hash, …).
      const engine = engines.find((e) => e.id === added.engine.id);
      if (engine) await openOptions(engine);
    }
  } catch (err) {
    engineError(err);
  } finally {
    btn.disabled = false;
  }
};

let optionsEngine = null;
let optionInputs = [];

// Engine options, grouped the way most engines' options fall, so a long
// list (tuning parameters and all) stays easy to find your way in.
const OPTION_GROUPS = [
  { id: 'basic', title: 'Basics', test: /^(hash|threads|multipv|ponder|move ?overhead|minimum ?thinking ?time|slow ?mover|nodestime|contempt|skill ?level|uci_limitstrength|uci_elo|uci_showwdl|uci_chess960|clear ?hash)$/i },
  { id: 'eval', title: 'Evaluation and opening book', test: /nnue|eval ?file|network|net|book/i },
  { id: 'tb', title: 'Endgame tablebases', test: /syzygy|tablebase|egtb|gaviota/i },
  { id: 'log', title: 'Logging', test: /log|debug/i },
  { id: 'other', title: 'Search and tuning', test: /.*/ },
];
// What Ponder does with some standard options, shown under them.
const OPTION_NOTES = {
  multipv: 'Analysis sets its own number of lines (Settings → Analysis); this applies when the engine plays.',
  ponder: 'Used for Lichess bot games, where it is turned on for you when Think on the opponent’s time is set (Settings → Lichess). Elsewhere engines do not think on the opponent’s time.',
  hash: 'Memory for the search, in MB. Each running copy of the engine (a game, analysis, the Lichess bot, tournament games) uses this much.',
  threads: `CPU threads for the search. This computer has ${navigator.hardwareConcurrency || '?'}.`,
  'move overhead': 'Milliseconds kept back on each move for delays (Lichess games, a slow computer).',
  syzygypath: 'The folder with the Syzygy tablebase files (several folders: separate them with ' + (navigator.platform.startsWith('Win') ? ';' : ':') + ').',
};
const isPathOption = (o) => o.type === 'string' && /path|dir|folder|file/i.test(o.name);
const wantsFolder = (o) => /path|dir|folder/i.test(o.name) && !/file/i.test(o.name);

// report: where an engine that does not start says so (Settings → Engines
// by default; the Lichess tab passes its own).
async function openOptions(engine, report = engineError) {
  report(null);
  let info;
  try {
    info = await api.engines.probe(engine.id);
    if (!info) throw new Error(`${engine.name} did not answer.`);
  } catch (err) {
    report(err);
    return;
  }
  optionsEngine = engine;
  $('#options-title').textContent = `${engine.name} — options`;
  $('#options-engine').textContent = [info.name, info.author && `by ${info.author}`].filter(Boolean).join(' ');
  optionInputs = [];
  const groups = new Map(OPTION_GROUPS.map((g) => [g.id, []]));
  for (const opt of info.options ?? []) {
    if (opt.type === 'button') continue;
    const value = engine.options?.[opt.name] ?? opt.default;
    const row = optionRow(opt, value);
    groups.get(OPTION_GROUPS.find((g) => g.test.test(opt.name)).id).push(row);
  }
  const body = [];
  for (const g of OPTION_GROUPS) {
    const rows = groups.get(g.id);
    if (!rows.length) continue;
    body.push(el('section', { className: 'opt-group' }, [el('h3', { textContent: `${g.title} (${rows.length})` }), ...rows]));
  }
  if (!body.length) body.push(el('p', { textContent: 'This engine has no options.' }));
  $('#options-body').replaceChildren(...body);
  $('#options-search').value = '';
  $('#options-changed').checked = false;
  $('#options-tools').hidden = optionInputs.length < 8;
  $('#options-error').hidden = true;
  filterOptions();
  updateOptionsSummary();
  dlgOptions.showModal();
}

// One option: its name, the control, its default and range, and a reset.
function optionRow(opt, value) {
  let input;
  const extra = [];
  if (opt.type === 'check') {
    input = el('input', { type: 'checkbox', checked: value === 'true' });
    input.read = () => String(input.checked);
    input.write = (v) => { input.checked = v === 'true'; };
  } else if (opt.type === 'combo') {
    input = el('select', {}, (opt.vars ?? []).map((v) => el('option', { value: v, textContent: v })));
    input.value = value;
  } else if (opt.type === 'spin') {
    input = el('input', { type: 'number', value, step: 1, className: 'opt-num' });
    if (opt.min != null) input.min = opt.min;
    if (opt.max != null) input.max = opt.max;
    // A slider too, when the range is small enough to slide through.
    if (opt.min != null && opt.max != null && opt.max - opt.min > 0 && opt.max - opt.min <= 2000 && !/^hash$/i.test(opt.name)) {
      const slider = el('input', { type: 'range', min: opt.min, max: opt.max, step: 1, value, className: 'opt-slider', tabIndex: -1 });
      slider.oninput = () => { input.value = slider.value; changed(); };
      input.addEventListener('input', () => { slider.value = input.value; });
      input.slider = slider;
      extra.push(slider);
    }
    if (/^hash$/i.test(opt.name)) extra.push(el('span', { className: 'opt-unit', textContent: 'MB' }));
  } else {
    input = el('input', { type: 'text', value: value === '<empty>' ? '' : value, spellcheck: false, className: 'opt-text' });
    if (/^<.*>$/.test(opt.default ?? '')) input.placeholder = opt.default;
    if (isPathOption(opt)) {
      const browse = el('button', { type: 'button', className: 'small', textContent: 'Browse…' });
      browse.onclick = async () => {
        const picked = await api.engines.choosePath(wantsFolder(opt) ? 'folder' : 'file', opt.name);
        if (picked) { input.value = picked; changed(); }
      };
      extra.push(browse);
    }
  }
  input.read ??= () => input.value;
  input.write ??= (v) => { input.value = v; if (input.slider) input.slider.value = v; };
  input.id = `opt-${optionInputs.length}`;
  const reset = el('button', { type: 'button', className: 'opt-reset', textContent: '↺', title: `Back to the engine’s default: ${opt.default === '' ? '(empty)' : opt.default}` });
  const def = opt.type === 'spin' && opt.min != null
    ? `default ${opt.default} · ${opt.min}–${opt.max}`
    : opt.type === 'check' ? `default ${opt.default === 'true' ? 'on' : 'off'}` : `default ${opt.default === '' ? '(empty)' : opt.default}`;
  const note = OPTION_NOTES[opt.name.toLowerCase()];
  const row = el('div', { className: 'opt-row' }, [
    el('label', { className: 'opt-name', htmlFor: input.id, textContent: opt.name }),
    el('span', { className: 'opt-control' }, [input, ...extra]),
    el('span', { className: 'opt-default', textContent: def }),
    reset,
    ...(note ? [el('span', { className: 'opt-note', textContent: note })] : []),
  ]);
  row.dataset.name = opt.name.toLowerCase();
  const entry = { opt, input, row };
  const changed = () => {
    const v = input.read();
    row.classList.toggle('changed', v !== opt.default && !(opt.default === '<empty>' && v === ''));
    row.classList.remove('invalid');
    updateOptionsSummary();
    if ($('#options-changed').checked) filterOptions();
  };
  reset.onclick = () => { input.write(opt.type === 'string' && opt.default === '<empty>' ? '' : opt.default); changed(); };
  input.addEventListener('input', changed);
  input.addEventListener('change', changed);
  entry.changed = changed;
  optionInputs.push(entry);
  changed();
  return row;
}

function updateOptionsSummary() {
  const n = optionInputs.filter((o) => o.row.classList.contains('changed')).length;
  $('#options-summary').textContent = `${optionInputs.length} options${n ? ` · ${n} changed from the engine’s defaults` : ''}`;
}

function filterOptions() {
  const q = $('#options-search').value.trim().toLowerCase();
  const onlyChanged = $('#options-changed').checked;
  for (const { row } of optionInputs) {
    row.hidden = (q && !row.dataset.name.includes(q)) || (onlyChanged && !row.classList.contains('changed'));
  }
  for (const group of document.querySelectorAll('#options-body .opt-group')) {
    group.hidden = ![...group.querySelectorAll('.opt-row')].some((r) => !r.hidden);
  }
}
$('#options-search').oninput = filterOptions;
$('#options-changed').onchange = filterOptions;

$('#options-cancel').onclick = () => dlgOptions.close();
$('#options-reset').onclick = () => optionInputs.forEach((o) => { o.input.write(o.opt.type === 'string' && o.opt.default === '<empty>' ? '' : o.opt.default); o.changed(); });
$('#form-options').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Numbers must be whole and within the engine's range.
  const bad = [];
  for (const { opt, input, row } of optionInputs) {
    if (opt.type !== 'spin') continue;
    const n = Number(input.value);
    const ok = input.value.trim() !== '' && Number.isInteger(n) && (opt.min == null || n >= opt.min) && (opt.max == null || n <= opt.max);
    row.classList.toggle('invalid', !ok);
    if (!ok) bad.push(`${opt.name} (${opt.min ?? '…'}–${opt.max ?? '…'})`);
  }
  if (bad.length) {
    $('#options-error').textContent = `Out of range: ${bad.join(', ')}.`;
    $('#options-error').hidden = false;
    $('#options-search').value = '';
    $('#options-changed').checked = false;
    filterOptions();
    $('#options-body .opt-row.invalid')?.scrollIntoView({ block: 'center' });
    return;
  }
  // Only keep values that differ from the engine's own defaults.
  const options = {};
  for (const { opt, input } of optionInputs) {
    let value = input.read();
    if (opt.type === 'string' && value === '' && opt.default === '<empty>') value = opt.default;
    if (value !== opt.default) options[opt.name] = value;
  }
  engines = await api.engines.update(optionsEngine.id, { options });
  renderEngineList();
  dlgOptions.close();
  const saved = engines.find((e) => e.id === optionsEngine.id) ?? optionsEngine;
  // The analysis engine picks the new options up at once.
  const restarted = analysis.on && analysisSettings().engineId === saved.id;
  if (restarted) { stopAnalysis(); startAnalysis(); }
  // Copies of it playing now (the game on the board, the Lichess bot's
  // games) are sent them too, between two searches; new Lichess games
  // start with them.
  let reached = 0;
  try {
    const r = await api.backend('engineOptions', {
      path: saved.path, args: saved.args ?? [],
      options: Object.fromEntries(Object.entries(saved.options ?? options).map(([k, v]) => [k, String(v)])),
    });
    reached = r?.engines ?? 0;
  } catch (err) {
    flashNote(`The options could not be sent to the running engine: ${errorText(err)}`);
  }
  window.lichessEngineChanged?.(saved.id);
  if (reached || restarted) {
    const where = [reached ? `${reached === 1 ? 'the engine' : `${reached} copies of the engine`} playing now` : '', restarted ? 'the analysis' : ''].filter(Boolean).join(' and ');
    flashNote(`${saved.name}: options sent to ${where}`);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const dlgSettings = $('#dlg-settings');

// A small sample of the theme: four squares with a few pieces on them.
function themePreview(name) {
  const sample = [['k', true], ['q', false], ['n', true], ['p', false]];
  const squares = sample.map(([type, white], i) =>
    el('div', { className: 'square ' + (i % 2 ? 'dark' : 'light') }, [pieceImage(type, white, name)]));
  return themeElement(el('div', { className: 'theme-preview' }, squares), name);
}

function renderThemeList() {
  const options = themeNames().map((name) => {
    const radio = el('input', { type: 'radio', name: 'theme', value: name, checked: name === theme });
    radio.onchange = () => setTheme(name);
    return el('label', { className: 'theme-option' }, [
      radio,
      themePreview(name),
      el('span', { className: 'theme-name', textContent: themeLabel(name) + (name === DEFAULT_THEME ? ' (default)' : '') }),
    ]);
  });
  if (options.length === 0) options.push(el('p', { textContent: 'No piece sets were found in the svg folder.' }));
  $('#theme-list').replaceChildren(...options);
}

$('#sound-on').onchange = (e) => { sounds.setEnabled(e.target.checked); syncSoundButton(); };
$('#moves-figurines').onchange = (e) => setMovesPref('figurines', e.target.checked);
$('#anim-speed').onchange = (e) => setAnimSpeed(e.target.value);
$('#result-card').onchange = (e) => setResultCard(e.target.checked);
$('#versus-on').onchange = (e) => window.setVersus?.(e.target.checked);
$('#ko-on').onchange = (e) => window.setKo?.(e.target.checked);
$('#bot-switch').onchange = (e) => window.setBotAutoSwitch?.(e.target.checked);
$('#glass-board').onchange = (e) => {
  glassBoard = e.target.checked;
  try { localStorage.setItem('glassBoard', glassBoard ? 'on' : 'off'); } catch { /* storage unavailable */ }
  document.body.classList.toggle('glass-board', glassBoard);
  window.board3d?.restyle();
  if (state) renderBoard();
};
$('#board-3d').onchange = (e) => setBoard3d(e.target.checked);
$('#board-3d-auto').onchange = (e) => window.board3d?.setAutoCamera(e.target.checked);
$('#board-3d-fx').onchange = (e) => window.board3d?.setCaptureEffects(e.target.checked);
$('#attack-marks').onchange = (e) => {
  attackMarks = e.target.checked;
  try { localStorage.setItem('attackMarks', attackMarks ? 'on' : 'off'); } catch { /* storage unavailable */ }
  if (state) renderBoard();
};
$('#moves-scores').onchange = (e) => setMovesPref('scores', e.target.checked);
$('#sound-volume').oninput = (e) => sounds.setVolume(e.target.value / 100);
// The glass changes as the slider moves; double-click it for the usual amount.
$('#glass-transparency').oninput = (e) => setGlassTransparency(e.target.value);
$('#glass-transparency').ondblclick = () => { $('#glass-transparency').value = GLASS_DEFAULT; setGlassTransparency(GLASS_DEFAULT); };
$('#sound-test').onclick = () => {
  sounds.play('move');
  setTimeout(() => sounds.play('capture'), 350);
  setTimeout(() => sounds.play('check'), 700);
};

function showSettingsPane(name) {
  for (const tab of document.querySelectorAll('.settings-tabs .tab')) {
    tab.classList.toggle('active', tab.dataset.pane === name);
    tab.setAttribute('aria-selected', tab.dataset.pane === name);
  }
  for (const pane of document.querySelectorAll('.settings-pane')) pane.hidden = pane.dataset.pane !== name;
}
for (const tab of document.querySelectorAll('.settings-tabs .tab')) tab.onclick = () => showSettingsPane(tab.dataset.pane);

async function openSettings(pane) {
  $('#sound-on').checked = sounds.enabled;
  window.refreshAnnouncerSettings?.();
  $('#moves-figurines').checked = movesPrefs.figurines;
  $('#anim-speed').value = animSpeed;
  $('#result-card').checked = resultCard;
  $('#attack-marks').checked = attackMarks;
  $('#glass-board').checked = glassBoard;
  $('#board-3d').checked = board3dOn;
  $('#board-3d-auto').checked = Boolean(window.board3d?.autoCamera);
  $('#board-3d-fx').checked = window.board3d?.captureEffects ?? true;
  if (typeof vs !== 'undefined') $('#versus-on').checked = vs.on;
  if (typeof ko !== 'undefined') $('#ko-on').checked = ko.on;
  $('#bot-switch').checked = window.botAutoSwitchOn?.() ?? true;
  window.fillAiSettings?.();
  $('#moves-scores').checked = movesPrefs.scores;
  $('#sound-volume').value = Math.round(sounds.volume * 100);
  $('#glass-transparency').value = glassTransparency;
  setGlassTransparency(glassTransparency, { save: false });
  renderThemeList();
  engines = await api.engines.list();
  engineError(null);
  renderEngineList();
  fillAnalysisSettings();
  await fillLichessSettings();
  database = await api.database.settings();
  fillDatabaseSettings();
  if (pane) showSettingsPane(pane);
  dlgSettings.showModal();
}
$('#btn-settings').onclick = () => openSettings();
$('#form-settings').addEventListener('submit', (e) => {
  e.preventDefault();
  dlgSettings.close();
});
// However the dialog closes, apply analysis changes (engine, lines, options).
dlgSettings.addEventListener('close', () => {
  saveLichessSettings();
  if (analysis.on) startAnalysis();
  renderAnalysis();
});

// ---------------------------------------------------------------------------
// Analysis: an engine of the user's choice analyses the position on the board.
// ---------------------------------------------------------------------------
const ANALYSIS_DEFAULTS = { engineId: 'builtin-basic', lines: 3, evalBar: true, altArrows: true };
function analysisSettings() {
  try { return { ...ANALYSIS_DEFAULTS, ...JSON.parse(localStorage.getItem('analysis') ?? '{}') }; } catch { return { ...ANALYSIS_DEFAULTS }; }
}
function saveAnalysisSettings(patch) {
  try { localStorage.setItem('analysis', JSON.stringify({ ...analysisSettings(), ...patch })); } catch { /* ignore */ }
}

function fillAnalysisSettings() {
  const cfg = analysisSettings();
  const select = $('#analysis-engine');
  select.replaceChildren(...engines.map((e) => el('option', { value: e.id, textContent: e.name })));
  select.value = engines.some((e) => e.id === cfg.engineId) ? cfg.engineId : (engines[0]?.id ?? '');
  $('#analysis-lines-setting').value = cfg.lines;
  $('#analysis-lines-setting-value').textContent = cfg.lines;
  $('#analysis-evalbar').checked = cfg.evalBar;
  $('#analysis-altarrows').checked = cfg.altArrows;
}
$('#analysis-engine').onchange = (e) => saveAnalysisSettings({ engineId: e.target.value });
$('#analysis-lines-setting').oninput = (e) => {
  $('#analysis-lines-setting-value').textContent = e.target.value;
  saveAnalysisSettings({ lines: +e.target.value });
};
$('#analysis-evalbar').onchange = (e) => { saveAnalysisSettings({ evalBar: e.target.checked }); renderAnalysis(); };
$('#analysis-altarrows').onchange = (e) => { saveAnalysisSettings({ altArrows: e.target.checked }); renderAnalysis(); };

// paused: by the app, while an engine plays; held: paused by the user, with
// the last lines kept on screen.
const analysis = { on: false, sentFen: null, data: null, paused: false, held: false, error: '', open: new Set() };

// Analysis pauses while an engine is playing: it would share the computer
// with the engine in the game.
const engineIsPlaying = () => (state?.active && ['white', 'black'].some((s) => state.players?.[s]?.type === 'engine'))
  || playLive()
  || Boolean(window.lichessPlaying?.()) || Boolean(window.tournamentRunning?.()) || Boolean(window.reviewRunning?.())
  || Boolean(window.puzzleUnsolved?.());

async function startAnalysis() {
  engines = await api.engines.list();
  const cfg = analysisSettings();
  const engine = engines.find((e) => e.id === cfg.engineId) ?? engines[0];
  analysis.error = '';
  if (!engine) {
    analysis.error = 'Add an engine in Settings → Engines first.';
  } else {
    try {
      await api.backend('analysisStart', {
        name: engine.name, path: engine.path, args: engine.args ?? [], options: engine.options ?? {}, lines: cfg.lines,
      });
      analysis.on = true;
      analysis.sentFen = null;
      syncAnalysis();
    } catch (err) {
      analysis.error = errorText(err);
    }
  }
  renderAnalysis();
}

function stopAnalysis() {
  analysis.on = false;
  analysis.held = false;
  analysis.autoHeld = false; // stopped: it does not come back with the next game
  analysis.sentFen = null;
  analysis.data = null;
  analysis.error = '';
  command('analysisStop');
  renderAnalysis();
}

$('#btn-analysis').onclick = () => {
  if (analysis.on || analysis.error) stopAnalysis();
  else startAnalysis();
};

// Pause keeps the engine loaded but idle; Resume picks up the position on
// the board.
function toggleAnalysisHold() {
  if (!analysis.on || analysis.paused) return;
  analysis.held = !analysis.held;
  analysis.autoHeld = false; // yours now: paused or resumed by hand
  syncAnalysis();
  renderAnalysis();
}
$('#analysis-pause').onclick = toggleAnalysisHold;

// Point the analysis at the position on the board (or pause it).
function syncAnalysis() {
  if (!analysis.on || !state) return;
  analysis.paused = engineIsPlaying();
  const fen = analysis.paused || analysis.held ? '' : shownFen();
  if (fen === analysis.sentFen) return;
  analysis.sentFen = fen;
  // A pause by the user keeps the last lines on screen.
  if (!analysis.held || analysis.paused) analysis.data = null;
  command('analysisPosition', { fen });
  renderAnalysis();
}

// The computer's processor load, on the Analysis button while the analysis
// is on: asked for once a second.
const cpu = { timer: null, load: null, cores: 0, paused: false };
function watchCpu(on) {
  if (on === !!cpu.timer) return;
  if (!on) {
    clearInterval(cpu.timer);
    cpu.timer = null;
    cpu.load = null;
    renderCpu();
    return;
  }
  const ask = async () => {
    let got = null;
    try { got = await window.board.cpuLoad(); } catch { /* no reading */ }
    if (!cpu.timer) return;
    cpu.load = typeof got?.load === 'number' ? got.load : null;
    cpu.cores = got?.cores || 0;
    renderCpu();
  };
  cpu.timer = setInterval(ask, 1000);
  ask(); // the first answer only starts the measuring
}
function renderCpu() {
  const box = $('#analysis-cpu');
  // The analysis is on but not searching (paused by you, by a game ending,
  // or while an engine plays): the meter gives way to the word.
  if (cpu.paused && cpu.timer) {
    box.hidden = false;
    box.classList.add('paused');
    box.classList.remove('busy');
    $('#analysis-cpu-pct').textContent = 'Paused';
    box.removeAttribute('aria-valuenow');
    box.title = 'The analysis is paused';
    box.setAttribute('aria-label', box.title);
    return;
  }
  box.classList.remove('paused');
  const pct = cpu.load === null ? null : Math.round(cpu.load * 100);
  box.hidden = pct === null;
  // A meter: the bar fills with the load, the figure beside it.
  $('#analysis-cpu-fill').style.width = `${pct ?? 0}%`;
  $('#analysis-cpu-pct').textContent = pct === null ? '' : `${pct}%`;
  if (pct === null) box.removeAttribute('aria-valuenow'); else box.setAttribute('aria-valuenow', pct);
  box.classList.toggle('busy', pct !== null && pct >= 90);
  const cores = cpu.cores ? ` of ${cpu.cores} processor core${cpu.cores === 1 ? '' : 's'}` : '';
  box.title = pct === null ? '' : `CPU usage: ${pct}%${cores} (the whole computer, every program)`;
  box.setAttribute('aria-label', box.title);
}

// "+0.35", "−1.20", "M3", "−M2" from White's point of view.
function formatScore(line) {
  if (line.isMate) return (line.mate > 0 ? '' : '−') + 'M' + Math.abs(line.mate);
  const p = line.cp / 100;
  return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(2);
}

// Win/draw/loss chances, as engines report them with UCI_ShowWDL: three
// numbers in thousandths, White's win first (the backend turns them White's
// way). Shown as a bar of three parts and as percentages.
function wdlPercents(wdl) {
  const total = wdl.reduce((a, b) => a + b, 0) || 1;
  const exact = wdl.map((n) => (n * 100) / total);
  const out = exact.map(Math.floor);
  // Round so the three still add up to 100.
  const order = exact.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < 100 - out.reduce((a, b) => a + b, 0); k++) out[order[k][1]]++;
  return out;
}

function wdlText(wdl) {
  const [w, d, l] = wdlPercents(wdl);
  return `White wins ${w}% · draw ${d}% · Black wins ${l}%`;
}

function wdlBar(wdl, mini = false) {
  const p = wdlPercents(wdl);
  return el('span', { className: 'wdl-bar' + (mini ? ' mini' : ''), title: `The engine's chances: ${wdlText(wdl)}`, role: 'img', ariaLabel: wdlText(wdl) },
    ['w', 'd', 'l'].map((k, i) => el('i', { className: k, style: `flex-grow: ${p[i]}` })));
}

// The bar with the three figures under it, for a window's best line.
function wdlSummary(wdl) {
  const [w, d, l] = wdlPercents(wdl);
  return [
    // The figures first, large enough to read at a glance, then the bar.
    el('span', { className: 'wdl-nums' }, [
      el('span', { className: 'w' }, [el('b', { textContent: `${w}%` }), ' White']),
      el('span', { className: 'd' }, [el('b', { textContent: `${d}%` }), ' Draw']),
      el('span', { className: 'l' }, [el('b', { textContent: `${l}%` }), ' Black']),
    ]),
    wdlBar(wdl),
  ];
}

// Numbered moves of a line, e.g. "12… Nf6 13. Bg5 Be7".
function numberedLine(fen, san) {
  const [, turn, , , , fullmove] = fen.split(' ');
  let number = +fullmove || 1;
  let white = turn === 'w';
  return san.map((m, i) => {
    const prefix = white ? `${number}. ` : i === 0 ? `${number}… ` : '';
    if (!white) number++;
    white = !white;
    return prefix + m;
  }).join(' ');
}

function renderAnalysis() {
  const on = analysis.on || !!analysis.error;
  $('#btn-analysis').setAttribute('aria-pressed', on);
  $('#btn-analysis').classList.toggle('active', on);
  // The icon turns while the engine is thinking, and stands still while the
  // analysis is paused.
  const thinking = analysis.on && !analysis.held && !analysis.paused && !analysis.error
    && analysis.data?.state !== 'over' && analysis.data?.state !== 'error';
  $('#btn-analysis').classList.toggle('on', analysis.on);
  $('#btn-analysis').classList.toggle('working', thinking);
  cpu.paused = analysis.on && (analysis.held || analysis.paused);
  watchCpu(analysis.on);
  renderCpu();
  const panel = $('#analysis');
  panel.hidden = !on;
  panel.classList.toggle('held', analysis.held && !analysis.paused);
  const pause = $('#analysis-pause');
  pause.hidden = !analysis.on || analysis.paused || !!analysis.error;
  pause.textContent = analysis.held ? '▶' : '⏸';
  pause.setAttribute('aria-label', analysis.held ? 'Resume the analysis' : 'Pause the analysis');
  pause.title = analysis.autoHeld
    ? 'The game ended, so the analysis is resting: it takes up again with the next game. Resume it now on this position (P)'
    : analysis.held
    ? 'Resume the analysis on the position on the board (P)'
    : 'Pause the analysis: the engine stops thinking and the lines stay as they are (P)';
  pause.setAttribute('aria-pressed', analysis.held);
  const data = analysis.data;
  $('#analysis-engine-name').textContent = data?.engine ?? '';
  const stats = [];
  if (analysis.held) stats.push(analysis.autoHeld ? 'paused: the game ended' : 'paused');
  if (data?.state === 'running' && data.depth) {
    stats.push(`d${data.depth}`);
    if (data.nodes) stats.push(`${formatCount(data.nodes)} nodes`);
    if (data.nps && !analysis.held) stats.push(`${formatCount(data.nps)} n/s`);
  }
  $('#analysis-stats').title = data?.depth ? `Depth ${data.depth}` : '';
  $('#analysis-stats').textContent = stats.join(' · ');
  let rows = [];
  if (analysis.error) {
    rows = [el('p', { className: 'error', textContent: analysis.error })];
  } else if (analysis.paused) {
    rows = [el('p', { className: 'hint', textContent: playLive()
      ? 'Off during your Lichess game: Lichess does not allow engine help. It comes back when the game ends.'
      : 'Paused while an engine is playing. It resumes when the game ends.' })];
  } else if (data?.state === 'over' || data?.state === 'error') {
    rows = [el('p', { className: data.state === 'error' ? 'error' : 'hint', textContent: data.message })];
  } else if (!data?.lines?.length) {
    rows = [el('p', { className: 'hint', textContent: analysis.autoHeld ? 'The game ended: the analysis is resting, and takes up again with the next game. Resume to analyse this position now.' : analysis.held ? 'Paused. Resume to analyse the position on the board.' : 'Thinking…' })];
  } else {
    rows = [];
    if (analysis.held && data.fen !== shownFen()) {
      rows.push(el('p', { className: 'hint held-note', textContent: 'Paused — these lines are for the position when you paused. Resume to analyse this one.' }));
    }
    const swatches = analysisSettings().altArrows && data.lines.length > 1;
    // Win/draw/loss chances, when the engine reports them.
    const anyWdl = data.lines.some((l) => l.wdl);
    // One row a line, whatever its length: the whole line shows on hover,
    // or wrapped once the row is clicked.
    rows.push(...data.lines.map((line, i) => {
      const text = numberedLine(data.fen, line.san);
      const open = analysis.open.has(i);
      const row = el('div', { className: 'analysis-line' + (open ? ' open' : ''), title: open ? 'Click to show one row' : 'Click to show the whole line' }, [
        el('span', { className: `line-swatch l${i + 1}` + (swatches ? '' : ' none'), title: !swatches ? '' : i ? `Arrow colour of line ${i + 1}` : 'The best line: its arrow' }),
        el('span', { className: 'score ' + (line.isMate ? (line.mate > 0 ? 'white' : 'black') : line.cp > 0 ? 'white' : line.cp < 0 ? 'black' : ''), textContent: formatScore(line) }),
        ...(anyWdl ? [line.wdl ? wdlBar(line.wdl, true) : el('span', { className: 'wdl-bar mini none' })] : []),
        el('span', { className: 'pv', textContent: text, title: open ? '' : text }),
      ]);
      row.onclick = () => {
        if (String(window.getSelection?.() ?? '')) return; // selecting text, not toggling
        if (!analysis.open.delete(i)) analysis.open.add(i);
        renderAnalysis();
      };
      return row;
    }));
  }
  $('#analysis-lines').replaceChildren(...rows);
  const best = !analysis.error && !analysis.paused && data?.state !== 'over' && data?.state !== 'error' ? data?.lines?.[0] : null;
  $('#analysis-wdl').hidden = !best?.wdl;
  if (best?.wdl) $('#analysis-wdl').replaceChildren(...wdlSummary(best.wdl));
  renderEvalBar();
  renderArrow();
  window.renderPositionBar?.();
}

// The bar shows White's expected score from the best line's evaluation.
// Your engine's own score for the position shown, in its Lichess game: from
// its search in that position, or else from the one before the last move.
function botScore() {
  if (state?.external?.kind !== 'bot' || varNode || puzzleView) return null;
  const p = shownPly();
  // The score of the move shown, else the engine's latest before it: the
  // opponent's moves have none of their own, and neither has a move the
  // engine played at once (a ponder hit, a book move) or one it has only
  // begun to search, so the bar keeps the last word rather than vanishing.
  for (let i = Math.min(p + 1, engineScores.length - 1); i >= 1; i--) {
    if (engineScores[i]) return engineScores[i];
  }
  return null;
}

// The moves list is drawn again for new scores, but not at every line of a search.
let moveScoresTimer = null;
function scheduleMoveScores() {
  if (moveScoresTimer) return;
  moveScoresTimer = setTimeout(() => { moveScoresTimer = null; renderMoves(); }, 400);
}

function renderEvalBar() {
  const bar = $('#evalbar');
  // Paused lines count only on the position they are for.
  const current = !analysis.held || analysis.data?.fen === shownFen();
  let line = analysis.data?.state === 'running' && current ? analysis.data.lines?.[0] : null;
  let show = analysis.on && !analysis.paused && analysisSettings().evalBar;
  // No analysis (it is off while your engine plays): the engine's own score.
  const own = show ? null : botScore();
  if (own && analysisSettings().evalBar) { line = own; show = true; }
  bar.title = own ? `${own.name ? own.name + "'s" : "Your engine's"} own evaluation, depth ${own.depth} (White's view)` : "Evaluation (White's view)";
  bar.hidden = !show;
  if (!show) return;
  let white = 0.5;
  let label = '';
  if (line) {
    if (line.isMate) white = line.mate > 0 ? 1 : 0;
    else white = 1 / (1 + Math.pow(10, -line.cp / 400));
    // One decimal on the bar, so it can be set large; the tooltip has it all.
    const pawns = Math.abs(line.cp / 100);
    // With its sign, now that it sits in the middle: plus is White's lead.
    const sign = (line.isMate ? line.mate : line.cp) > 0 ? '+' : (line.isMate ? line.mate : line.cp) < 0 ? '−' : '';
    // Ten pawns and more go without the decimal, to stay large in the bar's width.
    label = sign + (line.isMate ? `M${Math.abs(line.mate)}` : pawns >= 10 ? pawns.toFixed(0) : pawns.toFixed(1));
    bar.title += `: ${formatScore(line)}`;
  } else if (analysis.data?.state === 'over' && analysis.data.message === 'Checkmate') {
    white = state.turn === 'white' ? 0 : 1;
  }
  bar.classList.toggle('flipped', flipped);
  bar.style.setProperty('--white', (white * 100).toFixed(1) + '%');
  const labelEl = $('.label', bar);
  labelEl.textContent = label;
  // A long one (a mate in ten or more) is set a little smaller, to fit.
  labelEl.className = 'label ' + (white >= 0.5 ? 'at-white' : 'at-black') + ([...label].length > 4 ? ' tight' : '');
  // A face at each end: White's and Black's, smiling as the score favours
  // its side, flat when it is level, frowning as it goes against it.
  const lead = Math.max(-1, Math.min(1, (white - 0.5) * 2.6)); // +1 White happy … −1 Black happy
  setEvalFace($('#face-white'), lead, 'White');
  setEvalFace($('#face-black'), -lead, 'Black');
}

// Draws a face's mood, from −1 (frowning) through 0 (flat) to +1 (smiling):
// the mouth bends, the brows tilt, and the eyes narrow a little with a grin.
function setEvalFace(face, mood, who) {
  const m = Math.round(mood * 20) / 20;
  if (face.dataset.mood === String(m)) return;
  face.dataset.mood = String(m);
  // The mouth: its corners rise with a smile and drop with a frown, and
  // its middle goes the other way.
  const ends = 16 - m * 1.6;
  const mid = 16 + m * 4.4;
  const half = 4.2 + Math.abs(m) * 0.9;
  $('.mouth', face).setAttribute('d', `M${(12 - half).toFixed(2)} ${ends.toFixed(2)} Q12 ${mid.toFixed(2)} ${(12 + half).toFixed(2)} ${ends.toFixed(2)}`);
  // Brows: level when content, drawn together and down in a frown.
  const tilt = m < 0 ? -m * 1.5 : -m * 0.5;
  $('.brow.l', face).setAttribute('d', `M6.6 ${(8.2 - tilt).toFixed(2)} 9.8 ${(8.2 + tilt).toFixed(2)}`);
  $('.brow.r', face).setAttribute('d', `M14.2 ${(8.2 + tilt).toFixed(2)} 17.4 ${(8.2 - tilt).toFixed(2)}`);
  for (const eye of face.querySelectorAll('.eye')) eye.setAttribute('ry', (1.25 - Math.max(0, m) * 0.45).toFixed(2));
  face.classList.toggle('happy', m > 0.15);
  face.classList.toggle('sad', m < -0.15);
  const mood2 = m > 0.6 ? 'is delighted' : m > 0.15 ? 'is pleased' : m < -0.6 ? 'is in despair' : m < -0.15 ? 'is worried' : 'is unmoved';
  face.setAttribute('aria-label', `${who} ${mood2}`);
}

// An arrow for the best line's first move.
// Arrows for the analysis: the best line's first move, and with the setting
// on, the other lines' first moves in their own colours (best drawn last,
// on top).
// Watching your engine play on Lichess: an arrow for the move it means to
// play and one for the reply it expects (its ponder move). While it thinks
// they follow its search; once it has moved, the expected reply stays until
// the opponent answers.
function engineArrows() {
  const ext = state?.external;
  if (!(ext?.kind === 'bot' && ext.live) || !isLive()) return [];
  const n = state.moves.length;
  const out = [];
  for (const side of ['white', 'black']) {
    const info = engineInfo[side];
    if (state.players?.[side]?.type !== 'engine') continue;
    const name = state.players[side].name;
    if (info?.pondering) {
      // Thinking on the opponent's time: the reply it is thinking about.
      if (info.ply === n && info.ponder) out.push({ move: info.ponder, cls: 'engine-ponder', head: 'head-ponder', title: `${name} expects this reply` });
      continue;
    }
    if (!info?.best) continue;
    if (info.ply === n) {
      // Still searching: the arrow shows the depth reached so far.
      const label = !info.played && info.depth ? `d${info.depth}` : '';
      out.push({ move: info.best, cls: 'l1 engine-best', head: 'head-line-1', title: `${name} means to play this`, label });
      if (info.ponder) out.push({ move: info.ponder, cls: 'engine-ponder', head: 'head-ponder', title: `${name} expects this reply` });
    } else if (info.ply === n - 1 && info.ponder && state.moves[n - 1].uci === info.best) {
      out.push({ move: info.ponder, cls: 'engine-ponder', head: 'head-ponder', title: `${name} expects this reply` });
    }
  }
  return out;
}

function renderArrow() {
  const box = $('#line-arrows');
  const cfg = analysisSettings();
  const data = analysis.data;
  const lines = data?.state === 'running' && !analysis.paused && cfg.evalBar && analysis.on && data.fen === shownFen()
    ? (data.lines ?? []).slice(0, cfg.altArrows ? 5 : 1) : [];
  const center = (sq) => {
    const file = sq.charCodeAt(0) - 97;
    const rank = +sq[1];
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank - 1 : 8 - rank;
    return [col + 0.5, row + 0.5];
  };
  const arrows = [];
  const marks = [];
  // The best move's arrow carries how deep the search is.
  const drawn = lines.map((line, i) => ({ move: line.uci?.[0], cls: `l${i + 1}`, head: `head-line-${i + 1}`,
    label: i === 0 && line.depth ? `d${line.depth}` : '' }));
  // The reply the analysis expects to its best move (the ponder move).
  if (lines[0]?.uci?.[1]) drawn.push({ move: lines[0].uci[1], cls: 'engine-ponder', head: 'head-ponder' });
  drawn.push(...engineArrows());
  drawn.forEach(({ move, cls, head, title, label }) => {
    if (!move) return;
    const [x1, y1] = center(move.slice(0, 2));
    const [x2, y2] = center(move.slice(2, 4));
    // Stop short of the target square's centre so the head sits on it.
    const len = Math.hypot(x2 - x1, y2 - y1);
    const k = (len - 0.32) / len;
    const a = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    a.setAttribute('class', `line-arrow ${cls}`);
    a.setAttribute('x1', x1);
    a.setAttribute('y1', y1);
    a.setAttribute('x2', x1 + (x2 - x1) * k);
    a.setAttribute('y2', y1 + (y2 - y1) * k);
    a.setAttribute('marker-end', `url(#${head})`);
    if (title) a.append(Object.assign(document.createElementNS('http://www.w3.org/2000/svg', 'title'), { textContent: title }));
    arrows.unshift(a);
    if (label) {
      // A small tag on the middle of the arrow: the depth, upright.
      const NS = 'http://www.w3.org/2000/svg';
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'arrow-label');
      g.setAttribute('transform', `translate(${(x1 + x2) / 2} ${(y1 + y2) / 2})`);
      const w = label.length * 0.075 + 0.13;
      const box = document.createElementNS(NS, 'rect');
      for (const [k, v] of Object.entries({ x: -w / 2, y: -0.105, width: w, height: 0.21, rx: 0.105 })) box.setAttribute(k, v);
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('y', 0.05);
      text.textContent = label;
      const tip = document.createElementNS(NS, 'title');
      tip.textContent = `Depth of the search for the best move so far${title ? ` (${title})` : ''}`;
      g.append(box, text, tip);
      marks.push(g);
    }
    // The ponder move: a thought bubble on the corner of the piece expected
    // to move, its dots pulsing.
    if (cls.includes('engine-ponder')) {
      const NS = 'http://www.w3.org/2000/svg';
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'ponder-mark');
      g.setAttribute('transform', `translate(${x1 + 0.3} ${y1 - 0.3})`);
      const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); g.append(n); return n; };
      add('circle', { class: 'tail', cx: -0.2, cy: 0.2, r: 0.035 });
      add('circle', { class: 'tail', cx: -0.13, cy: 0.13, r: 0.055 });
      add('rect', { class: 'bubble', x: -0.19, y: -0.13, width: 0.38, height: 0.26, rx: 0.13 });
      [-0.09, 0, 0.09].forEach((dx, i) => add('circle', { class: `dot d${i + 1}`, cx: dx, cy: 0, r: 0.033 }));
      add('title', {}).textContent = title ?? 'The reply the engine expects (its ponder move)';
      marks.push(g);
    }
  });
  box.replaceChildren(...arrows, ...marks);
}

// ---------------------------------------------------------------------------
(async function init() {
  // The other scripts (flags.js, lichess.js, chat.js, …) load after this one,
  // and drawing the game uses them: wait for them before anything is drawn.
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  await loadThemes();
  setTheme(savedTheme(), { save: false });
  engines = await api.engines.list();
  fillEngineSelects();
  syncNewDialog();
  loadSetup();
  syncNewDialog();
  applyState(await api.backend('state'));
  database = await api.database.settings();
  renderDatabaseButton();
  initLichess();
  initTournament();
  // The game database opens with the app, listed in the Games tab; the
  // app starts on the Moves tab (its start screen shows the latest games).
  await listDatabase();
  if (collection && database?.path && collection.path === database.path) {
    renderDatabaseButton();
    renderMoves(); // the start screen's latest games, now there are some
  }
})();
