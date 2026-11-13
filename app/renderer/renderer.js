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
      pieces[key] = { url: URL.createObjectURL(new Blob([framed], { type: 'image/svg+xml' })), h, pad };
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
  sounds.setVoice(name === 'cyberpunk' ? 'synth' : 'wood');
  if (save) {
    try { localStorage.setItem('theme', name); } catch { /* storage unavailable */ }
  }
  if (state) { renderBoard(); renderMoves(); renderGameInfo(); } // the Game card's preview is drawn in the theme
}

function savedTheme() {
  try { return localStorage.getItem('theme') || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}

function pieceImage(type, white, name = theme) {
  const key = `${white ? 'white' : 'black'}-${PIECE_NAMES[type]}`;
  const art = themes[name]?.pieces[key];
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
const positionCache = new Map(); // fen → { legal, check, status }
let puzzleView = null;   // set by puzzles.js while a puzzle is on the board
let engineInfo = {};     // latest search info per side
let engineStrings = {};  // recent "info string" messages per side, newest last
const engineMsgOpen = {}; // side -> whether all messages are shown
let engineLineOpen = {};  // side -> the plies whose line is shown in full
const MAX_STRINGS = 12;
let drag = null;

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
        group.append(img);
      }
      groups.push(group);
    }
    const lead = side === 'white' ? diff : -diff;
    if (lead > 0) groups.push(el('span', { className: 'cap-lead', textContent: `+${lead}` }));
    box.replaceChildren(...groups);
    const names = ['p', 'n', 'b', 'r', 'q'].filter((t) => taken[t]).map((t) => `${taken[t]} ${PIECE_NAMES[t]}${taken[t] > 1 ? 's' : ''}`);
    box.title = names.length ? `Captured: ${names.join(', ')}${lead > 0 ? ` · ahead by ${lead}` : ''}` : '';
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
    // The taken piece stays a moment and fades under the arriving one.
    const [col, row] = at(sq);
    const p = before[sq];
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

function renderBoard() {
  renderCaptured();
  const before = lastPieces;
  const pieces = parseBoard(shownFen());
  const last = lastMoveUci();
  // Dots for legal moves; none for a premove (anything goes until it is played).
  const targets = selected && canMove() ? targetsFor(selected) : [];
  const turnKing = shownFen().split(' ')[1] === 'w' ? 'K' : 'k';
  const inCheck = /[+#]$/.test(lastMoveSan());

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
}

function squareAt(x, y) {
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

function renderPlayers() {
  const bottom = flipped ? 'black' : 'white';
  const top = flipped ? 'white' : 'black';
  for (const [id, side] of [['#player-top', top], ['#player-bottom', bottom]]) {
    const box = $(id);
    const player = state.players?.[side];
    box.dataset.side = side;
    $('.name', box).textContent = player ? player.name : side === 'white' ? 'White' : 'Black';
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
  state.moves.forEach((move, i) => {
    const white = whiteNext;
    if (white) nodes.push(num());
    else if (!open) nodes.push(num(), empty('…')); // Black first, or after a comment
    const j = review?.judgments?.[i];
    const node = el('button', { type: 'button', className: 'move' }, sanLabel(move.san, white));
    if (j?.glyph) {
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
    if (j?.kind || alts?.length) {
      if (white) nodes.push(empty());
      open = false;
    }
    if (j?.kind) {
      if (white) nodes.push(empty());
      const kind = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[j.kind];
      const comment = el('div', { className: `comment ${j.kind}` }, [el('b', { textContent: kind + '.' })]);
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
  box.replaceChildren(...nodes);
  (box.querySelector('.move.current, .vmove.current') ?? box.lastElementChild)?.scrollIntoView({ block: 'nearest' });
  $('#nav-first').disabled = $('#nav-prev').disabled = ply === 0 && !varNode;
  $('#nav-next').disabled = varNode ? !varNode.children.length : ply === livePly();
  $('#nav-last').disabled = ply === livePly() && !varNode;
  window.renderReview?.();
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
    const b = el('button', { type: 'button', className: 'vmove' + (node === varNode ? ' current' : '') }, sanLabel(node.san, white));
    b.onclick = () => goNode(node);
    out.push(b);
  };
  move(first, true);
  let cur = first;
  let renumber = false;
  while (cur.children.length) {
    const [main, ...alts] = cur.children;
    move(main, renumber);
    renumber = false;
    for (const alt of alts) {
      out.push(el('span', { className: 'vsub' }, ['(', ...lineElements(alt), ')']));
      renumber = true;
    }
    cur = main;
  }
  return out;
}

// The same line as PGN text.
function lineText(first) {
  const out = [];
  const move = (node, numbered) => {
    const { n, white } = plyNumber(node.ply);
    if (white) out.push(`${n}.`);
    else if (numbered) out.push(`${n}...`);
    out.push(node.san);
  };
  move(first, true);
  let cur = first;
  let renumber = false;
  while (cur.children.length) {
    const [main, ...alts] = cur.children;
    move(main, renumber);
    renumber = false;
    for (const alt of alts) { out.push(`(${lineText(alt)})`); renumber = true; }
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

window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || !state) return;
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
  stats.textContent = info
    ? [info.pondering ? 'pondering' : '', `depth ${info.depth}`, info.nodes ? `${formatCount(info.nodes)} nodes` : '',
      info.nps ? `${formatCount(info.nps)} n/s` : ''].filter(Boolean).join(' · ')
    : '';
  stats.title = !info ? '' : info.pondering ? "Thinking on its opponent's time" : 'Its search for its move';
}

// An engine's window, in the manner of the Analysis window: a header (who,
// how deep, how fast), then one row per move it searched, newest first: the
// score, and the line it had in mind. Rows keep to one line; a click wraps one.
function renderEngineInfo() {
  for (const side of ['white', 'black']) {
    const panel = $(`#engine-${side}`);
    const player = state.players?.[side];
    panel.hidden = !player || player.type !== 'engine';
    if (panel.hidden) continue;
    if (!panel.firstChild) {
      panel.append(
        el('div', { className: 'head' }, [
          el('span', { className: 'side-dot ' + side, title: side === 'white' ? 'White' : 'Black' }),
          el('span', { className: 'engine-name' }),
          el('span', { className: 'stats' }),
        ]),
        el('div', { className: 'lines' }),
        el('div', { className: 'messages' }),
      );
    }
    $('.engine-name', panel).textContent = player.name;
    $('.engine-name', panel).title = player.name;
    renderEngineHead(side);

    const log = engineLog[side] ?? [];
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
  }
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
  if (total > 2 && workspace.style.getPropertyValue('--tabs-w') !== `${total}px`) workspace.style.setProperty('--tabs-w', `${total}px`);
  const room = row.clientWidth;
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

function playStateSounds(prev, next, newGame) {
  // Tournament games go by too fast to hear every move.
  if (next.external?.kind === 'tournament') return;
  if (newGame) {
    lowTime = {};
    if ((next.active && !next.loaded) || (next.external?.live && next.moves.length === 0)) sounds.play('start');
    return;
  }
  const ended = (prev.active && !next.active) || (prev.external?.live && next.external && !next.external.live && next.result !== '*');
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
  if (!st || st !== state || st.result === '*' || st.external?.kind === 'tournament') return;
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
}

function renderGameOver(st, focus) {
  const head = resultHeadline(st);
  gameOverFor = st.game;
  const box = $('#game-over');
  box.className = head.kind;
  $('#go-badge').textContent = head.badge;
  $('#go-title').textContent = head.title;
  $('#go-reason').textContent = (st.reason ?? '').replace(/^(White|Black) wins /, '') || st.result.replace('1/2-1/2', '½-½');
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
  if (newGame) { tree = { branches: new Map() }; varNode = null; if (puzzleView) window.leavePuzzle?.(); }
  if (newGame || (wasLive && !varNode)) viewPly = null;
  // A game opened from a file starts at its first move, to be stepped
  // through, rather than at its last.
  if (newGame && next.loaded && next.moves.length > 1) viewPly = 1;
  if (newGame) { engineInfo = {}; engineStrings = {}; engineLog = {}; engineScores = []; engineLineOpen = {}; }
  else if (next.moves.length < (prev?.moves.length ?? 0)) engineScores.length = next.moves.length + 1; // takeback
  // A Lichess game is shown from your engine's side.
  if (newGame && next.external) flipped = next.external.side === 'black';
  if (prev) playStateSounds(prev, next, newGame);
  if (gameOverFor != null && (newGame || next.result === '*')) hideGameOver();
  window.syncPlayersInfo?.();
  window.renderPositionBar?.();
  window.syncChat?.();
  if (prev && !newGame && next.external?.ratingDiff && JSON.stringify(next.external.ratingDiff) !== JSON.stringify(prev.external?.ratingDiff)) {
    setTimeout(() => ratingDiffArrived(state), 0);
  }
  if (newGame || !state.active) premove = null;
  if (!state.humanToMove && !premoveMode()) selected = null;
  renderBoard();
  renderPlayers();
  renderStatus();
  renderMoves();
  renderOpening();
  renderEngineInfo();
  renderGameInfo();
  renderGames();
  syncAnalysis();
  renderAnalysis();
  playPremove();
}

api.onEvent((event, data) => {
  if (event === 'state') {
    applyState(data);
  } else if (event === 'engineInfo') {
    // The move an engine chose comes with its last line when there was one;
    // otherwise only the moves (for the arrows) are new.
    const prev = engineInfo[data.side];
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
function pgnAnnotations() {
  if (!state?.moves) return null;
  const ann = { nags: {}, comments: {}, variations: {} };
  const review = window.currentReview?.();
  if (review) {
    const NAG = { inaccuracy: 6, mistake: 2, blunder: 4 };
    review.positions.forEach((p, ply) => {
      if (ply === 0) return;
      let ev = '';
      if (p.final === 'checkmate') ev = '';
      else if (p.mate) ev = `[%eval #${p.mate}]`;
      else ev = `[%eval ${(p.cp / 100).toFixed(2)}]`;
      const j = review.judgments[ply - 1];
      let text = ev;
      if (j?.kind) {
        ann.nags[ply] = NAG[j.kind];
        const kind = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[j.kind];
        text += ` ${kind}.${j.best ? ` ${j.best} was best.` : ''}`;
      }
      if (text.trim()) ann.comments[ply] = text.trim();
    });
    ann.annotator = `Ponder (${review.engine})`;
  }
  for (const [p, lines] of tree.branches) {
    if (!lines.length) continue;
    const text = lines.map((l) => `(${lineText(l)})`).join(' ');
    if (p < state.moves.length) ann.variations[p + 1] = text;
    else ann.after = `Analysis: ${lines.map((l) => lineText(l)).join('; ')}`;
  }
  const empty = !review && !tree.branches.size;
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
  $('#games-count').textContent = has ? collection.total.toLocaleString() : '';
  if (!has) {
    $('#games-list').replaceChildren();
    $('#games-note').hidden = true;
    return;
  }
  const n = collection.total;
  $('#games-file').textContent = `${collection.source} · ${n.toLocaleString()} game${n === 1 ? '' : 's'}`;
  $('#games-file').title = collection.source;
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

async function openDatabase() {
  database = await api.database.settings();
  if (!database.exists) {
    setStatus(`${database.path.split(/[\\/]/).pop()} has no games yet. Finished games are added when they end.`);
    return;
  }
  await openPgn({ name: database.path.split(/[\\/]/).pop(), path: database.path });
}

function renderDatabaseButton() {
  $('#games-open-db').hidden = !database?.enabled;
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
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== 's' && key !== 'o') return;
  e.preventDefault();
  if (document.querySelector('dialog[open]')) return;
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

function renderEngineList() {
  const rows = engines.map((engine) => {
    const name = el('input', { type: 'text', value: engine.name, maxLength: 60 });
    name.onchange = async () => { engines = await api.engines.update(engine.id, { name: name.value }); fillEngineSelects(); fillAnalysisSettings(); };
    const changed = Object.keys(engine.options ?? {}).length;
    const options = el('button', { type: 'button', textContent: changed ? `Options (${changed})` : 'Options' });
    options.onclick = () => openOptions(engine);
    const remove = el('button', { type: 'button', textContent: 'Remove', disabled: !!engine.builtin });
    remove.onclick = async () => { engines = await api.engines.remove(engine.id); renderEngineList(); fillEngineSelects(); fillAnalysisSettings(); };
    const parts = [name, el('div', { className: 'path', textContent: engine.builtin ? 'Bundled with the app' : `\u200E${engine.path}\u200E`, title: engine.builtin ? '' : engine.path })];
    if (!engine.builtin) {
      const args = el('input', {
        type: 'text', className: 'engine-args', value: joinArgs(engine.args), spellcheck: false,
        placeholder: 'Command-line options, e.g. --uci or -threads 4 (none)',
        title: 'Passed to the engine when it starts. Spaces separate options; put an option with spaces in quotes.',
      });
      const note = el('div', { className: 'engine-args-note' });
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
      parts.push(el('label', { className: 'engine-args-row' }, [el('span', { textContent: 'Command line' }), args]), note);
    }
    return el('div', { className: 'engine-row' }, [el('div', { className: 'grow' }, parts), options, remove]);
  });
  $('#engine-list').replaceChildren(...rows);
}

$('#engine-add').onclick = async () => {
  engineError(null);
  const btn = $('#engine-add');
  btn.disabled = true;
  try {
    const added = await api.engines.add();
    engines = await api.engines.list();
    renderEngineList();
    fillEngineSelects();
    fillAnalysisSettings();
    if (added?.error) {
      engineError(`${added.engine.name} was added, but did not start as a UCI engine (${added.error}). If it needs command-line options, enter them under its name.`);
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

async function openOptions(engine) {
  engineError(null);
  let info;
  try {
    info = await api.engines.probe(engine.id);
  } catch (err) {
    engineError(err);
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
  // The analysis engine picks the new options up at once.
  if (analysis.on && analysisSettings().engineId === optionsEngine.id) { stopAnalysis(); startAnalysis(); }
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

$('#sound-on').onchange = (e) => sounds.setEnabled(e.target.checked);
$('#moves-figurines').onchange = (e) => setMovesPref('figurines', e.target.checked);
$('#anim-speed').onchange = (e) => setAnimSpeed(e.target.value);
$('#result-card').onchange = (e) => setResultCard(e.target.checked);
$('#moves-scores').onchange = (e) => setMovesPref('scores', e.target.checked);
$('#sound-volume').oninput = (e) => sounds.setVolume(e.target.value / 100);
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
  $('#moves-figurines').checked = movesPrefs.figurines;
  $('#anim-speed').value = animSpeed;
  $('#result-card').checked = resultCard;
  $('#moves-scores').checked = movesPrefs.scores;
  $('#sound-volume').value = Math.round(sounds.volume * 100);
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

// "+0.35", "−1.20", "M3", "−M2" from White's point of view.
function formatScore(line) {
  if (line.isMate) return (line.mate > 0 ? '' : '−') + 'M' + Math.abs(line.mate);
  const p = line.cp / 100;
  return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(2);
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
  const panel = $('#analysis');
  panel.hidden = !on;
  panel.classList.toggle('held', analysis.held && !analysis.paused);
  const pause = $('#analysis-pause');
  pause.hidden = !analysis.on || analysis.paused || !!analysis.error;
  pause.textContent = analysis.held ? '▶' : '⏸';
  pause.setAttribute('aria-label', analysis.held ? 'Resume the analysis' : 'Pause the analysis');
  pause.title = analysis.held
    ? 'Resume the analysis on the position on the board (P)'
    : 'Pause the analysis: the engine stops thinking and the lines stay as they are (P)';
  pause.setAttribute('aria-pressed', analysis.held);
  const data = analysis.data;
  $('#analysis-engine-name').textContent = data?.engine ?? '';
  const stats = [];
  if (analysis.held) stats.push('paused');
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
    rows = [el('p', { className: 'hint', textContent: analysis.held ? 'Paused. Resume to analyse the position on the board.' : 'Thinking…' })];
  } else {
    rows = [];
    if (analysis.held && data.fen !== shownFen()) {
      rows.push(el('p', { className: 'hint held-note', textContent: 'Paused — these lines are for the position when you paused. Resume to analyse this one.' }));
    }
    const swatches = analysisSettings().altArrows && data.lines.length > 1;
    // One row a line, whatever its length: the whole line shows on hover,
    // or wrapped once the row is clicked.
    rows.push(...data.lines.map((line, i) => {
      const text = numberedLine(data.fen, line.san);
      const open = analysis.open.has(i);
      const row = el('div', { className: 'analysis-line' + (open ? ' open' : ''), title: open ? 'Click to show one row' : 'Click to show the whole line' }, [
        el('span', { className: `line-swatch l${i + 1}` + (swatches ? '' : ' none'), title: !swatches ? '' : i ? `Arrow colour of line ${i + 1}` : 'The best line: its arrow' }),
        el('span', { className: 'score ' + (line.isMate ? (line.mate > 0 ? 'white' : 'black') : line.cp > 0 ? 'white' : line.cp < 0 ? 'black' : ''), textContent: formatScore(line) }),
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
  return engineScores[p + 1] ?? engineScores[p] ?? null;
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
    label = formatScore(line).replace('+', '').replace('−', '');
  } else if (analysis.data?.state === 'over' && analysis.data.message === 'Checkmate') {
    white = state.turn === 'white' ? 0 : 1;
  }
  bar.classList.toggle('flipped', flipped);
  bar.style.setProperty('--white', (white * 100).toFixed(1) + '%');
  const labelEl = $('.label', bar);
  labelEl.textContent = label;
  labelEl.className = 'label ' + (white >= 0.5 ? 'at-white' : 'at-black');
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
      out.push({ move: info.best, cls: 'l1 engine-best', head: 'head-line-1', title: `${name} means to play this` });
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
  const drawn = lines.map((line, i) => ({ move: line.uci?.[0], cls: `l${i + 1}`, head: `head-line-${i + 1}` }));
  // The reply the analysis expects to its best move (the ponder move).
  if (lines[0]?.uci?.[1]) drawn.push({ move: lines[0].uci[1], cls: 'engine-ponder', head: 'head-ponder' });
  drawn.push(...engineArrows());
  drawn.forEach(({ move, cls, head, title }) => {
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
  });
  box.replaceChildren(...arrows);
}

// ---------------------------------------------------------------------------
(async function init() {
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
  // The other scripts (lichess.js, tournament.js, …) load after this one;
  // the awaits above can finish before they have.
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  initLichess();
  initTournament();
  listDatabase();
})();
