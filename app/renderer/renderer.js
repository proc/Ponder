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
  if (state) { renderBoard(); renderMoves(); }
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

function renderBoard() {
  renderCaptured();
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
    $('.kind', box).textContent = kind;
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
    return el('div', { className: 'vline' }, [...lineElements(first), del]);
  }));
}

$('#nav-first').onclick = () => showPly(0);
$('#nav-prev').onclick = () => stepBack();
$('#nav-next').onclick = () => stepForward();
$('#nav-last').onclick = () => showPly(livePly());
// Zen mode, as on Lichess: only the board and the players.
function toggleZen() {
  document.body.classList.toggle('zen');
  try { localStorage.setItem('zen', document.body.classList.contains('zen') ? '1' : ''); } catch { /* ignore */ }
}
$('#zen-exit').onclick = toggleZen;
$('#btn-keys').onclick = () => $('#dlg-keys').showModal();
if (localStorage.getItem('zen')) document.body.classList.add('zen');

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
const ENGINE_LOG_MAX = 200;

function numberedFromPly(ply, san) {
  const fen = ply === 0 ? state.startFen : state.moves[ply - 1]?.fen ?? state.fen;
  return numberedLine(fen, san);
}

function logEngineInfo(info) {
  const log = engineLog[info.side] ??= [];
  const row = {
    ply: info.ply, depth: info.depth, score: info.hasEval ? formatEval(info) : '',
    nodes: info.nodes ? formatCount(info.nodes) : '', line: info.pv?.length ? numberedFromPly(info.ply, info.pv) : '',
  };
  // One row per depth of each search: a later update at the same depth replaces it.
  if (log[0] && log[0].ply === row.ply && log[0].depth === row.depth) log[0] = row;
  else log.unshift(row);
  if (log.length > ENGINE_LOG_MAX) log.length = ENGINE_LOG_MAX;
}

function renderEngineInfo() {
  for (const side of ['white', 'black']) {
    const panel = $(`#engine-${side}`);
    const player = state.players?.[side];
    panel.hidden = !player || player.type !== 'engine';
    if (panel.hidden) continue;
    if (!panel.firstChild) {
      panel.append(
        el('div', { className: 'head' }, [
          el('span', { className: 'engine-name' }),
          el('span', { className: 'side' }),
          el('span', { className: 'eval' }),
        ]),
        el('div', { className: 'stats' }),
        el('div', { className: 'pv' }),
        el('div', { className: 'log' }),
        el('div', { className: 'messages' }),
      );
    }
    const info = engineInfo[side];
    $('.engine-name', panel).textContent = player.name;
    $('.engine-name', panel).title = player.name;
    $('.side', panel).textContent = side;
    $('.eval', panel).textContent = info ? formatEval(info) : '';
    $('.stats', panel).textContent = info
      ? [`depth ${info.depth}`, info.nodes ? `${formatCount(info.nodes)} nodes` : '',
        info.nps ? `${formatCount(info.nps)} n/s` : ''].filter(Boolean).join(' · ')
      : 'waiting for its first search';
    $('.pv', panel).textContent = info?.pv?.length ? numberedFromPly(info.ply, info.pv) : '';

    const log = engineLog[side] ?? [];
    const rows = log.map((r, i) => {
      // The move being searched for: its number from the position searched.
      const fen = r.ply === 0 ? state.startFen : state.moves[r.ply - 1]?.fen ?? state.fen;
      const [, turn, , , , fullmove] = fen.split(' ');
      const label = `${fullmove}${turn === 'w' ? '.' : '…'}`;
      return el('div', { className: 'log-row' + (i > 0 && log[i - 1].ply !== r.ply ? ' new-move' : '') }, [
        el('span', { className: 'num', textContent: i === 0 || log[i - 1].ply !== r.ply ? label : '' }),
        el('span', { className: 'depth', textContent: r.depth }),
        el('span', { className: 'score', textContent: r.score }),
        el('span', { className: 'nodes', textContent: r.nodes }),
        el('span', { className: 'line', textContent: r.line }),
      ]);
    });
    if (rows.length) {
      rows.unshift(el('div', { className: 'log-row head' }, ['Move', 'Depth', 'Score', 'Nodes', 'Line']
        .map((t, k) => el('span', { className: ['num', 'depth', 'score', 'nodes', 'line'][k], textContent: t }))));
    }
    $('.log', panel).replaceChildren(...rows);

    const messages = (engineStrings[side] ?? []).map((m) => el('div', {
      className: 'message' + (m.opening ? ' opening' : ''), textContent: m.text, title: m.text,
    }));
    $('.messages', panel).replaceChildren(...messages);
    $('.messages', panel).hidden = messages.length === 0;
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

// The Game card: a loaded game's PGN tags, or the set-up of a game in play.
function renderGameInfo() {
  const rows = [];
  const add = (label, value, mono = false) => {
    if (!value) return;
    rows.push(el('dt', { textContent: label }), el('dd', { textContent: value, className: mono ? 'mono' : '' }));
  };
  if (state.loaded) {
    for (const t of state.tags ?? []) add(t.name, t.value, t.name === 'FEN');
  } else if (state.external) {
    add('Event', state.external.label);
    for (const side of ['white', 'black']) {
      const p = state.players[side];
      add(side === 'white' ? 'White' : 'Black', `${p.name}${p.rating ? ' ' + p.rating : ''}${p.type === 'engine' && state.external.kind === 'bot' ? ' (your engine)' : ''}`);
    }
    add('Moves', state.moves.length ? String(Math.ceil(state.moves.length / 2)) : '');
    add('Result', state.external.live ? 'In progress' : state.result === '*' ? state.reason : `${state.result} — ${state.reason}`);
    const link = el('a', { href: '#', textContent: state.external.url.replace(/^https?:\/\//, '') });
    link.onclick = (e) => { e.preventDefault(); api.openExternal(state.external.url); };
    rows.push(el('dt', { textContent: 'Site' }), el('dd', {}, [link]));
  } else if (state.players) {
    for (const side of ['white', 'black']) {
      const p = state.players[side];
      add(side === 'white' ? 'White' : 'Black', `${p.name} (${p.type})`);
    }
    const [w, b] = ['white', 'black'].map((side) => describeTimeControl(state.players[side].timeControl));
    if (w === b) add('Time control', w);
    else { add('White clock', w); add('Black clock', b); }
    const standard = state.startFen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - ');
    add('Start', standard ? 'Standard position' : state.startFen, !standard);
    add('Moves', state.moves.length ? String(Math.ceil(state.moves.length / 2)) : '');
    if (!state.active && state.result) add('Result', state.result === '*' ? state.reason : `${state.result} — ${state.reason}`);
  }
  $('#game-info').hidden = rows.length === 0;
  $('#game-details').replaceChildren(...rows);
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
  box.title = `${text}\n${book ? 'From the built-in opening book' : 'Reported by the engine or the PGN file'}`;
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
  // In a Lichess game, the side to cheer for is your engine.
  const mine = next.external ? 'engine' : 'human';
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
  }
}

function applyState(next) {
  const prev = state;
  const newGame = !state || next.game !== state.game;
  const wasLive = !state || isLive();
  state = next;
  stateAt = performance.now();
  if (newGame) { tree = { branches: new Map() }; varNode = null; if (puzzleView) window.leavePuzzle?.(); }
  if (newGame || (wasLive && !varNode)) viewPly = null;
  if (newGame) { engineInfo = {}; engineStrings = {}; engineLog = {}; engineScores = []; }
  else if (next.moves.length < (prev?.moves.length ?? 0)) engineScores.length = next.moves.length + 1; // takeback
  // A Lichess game is shown from your engine's side.
  if (newGame && next.external) flipped = next.external.side === 'black';
  if (prev) playStateSounds(prev, next, newGame);
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
    engineInfo[data.side] = data;
    if (data.hasEval && data.ply != null) {
      const name = state?.players?.[data.side]?.name ?? '';
      engineScores[data.ply + 1] = { cp: data.cp, mate: data.mate, isMate: data.isMate, depth: data.depth, name };
    }
    logEngineInfo(data);
    renderEngineInfo();
  } else if (event === 'analysis') {
    // Only results for the position we asked about count.
    if (analysis.on && !analysis.held && data.fen === analysis.sentFen) {
      analysis.data = data;
      renderAnalysis();
    }
  } else if (event === 'pgnProgress') {
    if (openingFile) {
      const pct = data.total > 0 ? Math.floor((data.done / data.total) * 100) : 0;
      setStatus(`Reading ${data.name}… ${pct}%`);
    }
  } else if (event === 'review') {
    onReviewEvent(data);
  } else if (event === 'tournament') {
    tournamentStatus(data);
  } else if (event === 'databaseSaved') {
    onDatabaseSaved(data);
  } else if (event === 'lichess') {
    lichessStatus(data);
  } else if (event === 'lichessAccount') {
    window.lichessAccountStatus?.(data);
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
    ann.annotator = `Board (${review.engine})`;
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
let listRequest = 0;
async function fetchGames() {
  if (!collection) return renderGames();
  const id = ++listRequest;
  const list = await command('listGames', { filter: $('#games-filter').value, limit: GAME_LIST_LIMIT });
  if (id !== listRequest || !collection || !list) return; // superseded
  collection.list = list;
  renderGames();
}

function renderGames() {
  const has = !!collection;
  $('#games-empty').hidden = has;
  $('#games-head').hidden = !has;
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
  const rows = list.games.map((g) => {
    const error = collection.errors[g.index] ?? g.error;
    const row = el('button', { type: 'button', className: 'game-row' }, [
      cell('c-num', (g.index + 1).toLocaleString()),
      cell('c-white', g.white || '?'),
      cell('c-black', g.black || '?'),
      cell('c-result', g.result || '*'),
      cell('c-event', g.event === '?' ? '' : g.event),
      cell('c-date', date(g.date)),
      cell('c-round', round(g.round)),
      cell('c-plies', String(Math.ceil(g.plies / 2))),
      error ? el('span', { className: 'c-error', textContent: error }) : '',
    ]);
    if (g.index === current) row.classList.add('current');
    if (error) row.classList.add('broken');
    row.onclick = () => selectGame(g.index);
    return row;
  });
  if (rows.length) {
    rows.unshift(el('div', { className: 'game-row head' }, ['#', 'White', 'Black', 'Result', 'Event', 'Date', 'Round', 'Moves']
      .map((t, k) => el('span', { className: ['c-num', 'c-white', 'c-black', 'c-result', 'c-event', 'c-date', 'c-round', 'c-plies'][k], textContent: t }))));
  }
  if (rows.length === 0 && collection.list) rows.push(el('p', { className: 'hint', textContent: 'No games match.' }));
  $('#games-list').replaceChildren(...rows);
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
  if (collection && collection.path === ev.path) {
    const r = await command('refreshPgn', { path: ev.path });
    if (r?.refreshed) {
      collection.total = r.total;
      await fetchGames();
    }
  }
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
async function openPgn(given) {
  if (typeof given?.path !== 'string') given = null; // e.g. a click event
  if (openingFile) return;
  if (state?.active && !(await confirmDialog('Opening a PGN file ends the game in progress.', given ? 'Open database' : 'Open file…'))) return;
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
  $('#btn-open').disabled = $('#games-open').disabled = true;
  setStatus(`Reading ${file.name}…`);
  let result;
  try {
    result = await api.backend('openPgn', { path: file.path });
  } catch (err) {
    setStatus(errorText(err));
    return;
  } finally {
    openingFile = false;
    $('#btn-open').disabled = $('#games-open').disabled = false;
  }
  collection = { source: result.name, path: file.path, total: result.total, errors: result.errors ?? {}, list: null };
  $('#games-filter').value = '';
  renderGames();
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
  optionInputs = [];
  const rows = [];
  for (const opt of info.options ?? []) {
    if (opt.type === 'button') continue;
    const value = engine.options?.[opt.name] ?? opt.default;
    let input;
    if (opt.type === 'check') {
      input = el('input', { type: 'checkbox', checked: value === 'true' });
      input.read = () => String(input.checked);
      input.write = (v) => { input.checked = v === 'true'; };
    } else if (opt.type === 'combo') {
      input = el('select', {}, (opt.vars ?? []).map((v) => el('option', { value: v, textContent: v })));
      input.value = value;
    } else if (opt.type === 'spin') {
      input = el('input', { type: 'number', value, step: 1 });
      if (opt.min != null) input.min = opt.min;
      if (opt.max != null) input.max = opt.max;
      input.title = `${opt.min ?? ''} – ${opt.max ?? ''}`;
    } else {
      input = el('input', { type: 'text', value, spellcheck: false });
    }
    input.read ??= () => input.value;
    input.write ??= (v) => { input.value = v; };
    optionInputs.push({ opt, input });
    rows.push(el('label', { className: 'row' }, [opt.name, input]));
  }
  if (rows.length === 0) rows.push(el('p', { textContent: 'This engine has no options.' }));
  $('#options-body').replaceChildren(...rows);
  dlgOptions.showModal();
}

$('#options-cancel').onclick = () => dlgOptions.close();
$('#options-reset').onclick = () => optionInputs.forEach(({ opt, input }) => input.write(opt.default));
$('#form-options').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Only keep values that differ from the engine's own defaults.
  const options = {};
  for (const { opt, input } of optionInputs) {
    const value = input.read();
    if (value !== opt.default) options[opt.name] = value;
  }
  engines = await api.engines.update(optionsEngine.id, { options });
  renderEngineList();
  dlgOptions.close();
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
const analysis = { on: false, sentFen: null, data: null, paused: false, held: false, error: '' };

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
  panel.classList.toggle('collapsed', analysis.paused || !!analysis.error);
  panel.classList.toggle('held', analysis.held && !analysis.paused);
  const pause = $('#analysis-pause');
  pause.hidden = !analysis.on || analysis.paused || !!analysis.error;
  pause.textContent = analysis.held ? '▶ Resume' : '⏸ Pause';
  pause.title = analysis.held
    ? 'Resume the analysis on the position on the board (P)'
    : 'Pause the analysis: the engine stops thinking and the lines stay as they are (P)';
  pause.setAttribute('aria-pressed', analysis.held);
  const data = analysis.data;
  $('#analysis-engine-name').textContent = data?.engine ?? '';
  const stats = [];
  if (analysis.held) stats.push('paused');
  if (data?.state === 'running' && data.depth) {
    stats.push(`depth ${data.depth}`);
    if (data.nps && !analysis.held) stats.push(`${formatCount(data.nps)} n/s`);
  }
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
    rows.push(...data.lines.map((line, i) => el('div', { className: 'analysis-line' }, [
      ...(swatches ? [el('span', { className: `line-swatch l${i + 1}`, title: i ? `Arrow colour of line ${i + 1}` : 'The best line: its arrow' })] : []),
      el('span', { className: 'score ' + (line.isMate ? (line.mate > 0 ? 'white' : 'black') : line.cp > 0 ? 'white' : line.cp < 0 ? 'black' : ''), textContent: formatScore(line) }),
      el('span', { className: 'pv', textContent: numberedLine(data.fen, line.san), title: numberedLine(data.fen, line.san) }),
    ])));
  }
  $('#analysis-lines').replaceChildren(...rows);
  renderEvalBar();
  renderArrow();
}

// The bar shows White's expected score from the best line's evaluation.
function renderEvalBar() {
  const bar = $('#evalbar');
  // Paused lines count only on the position they are for.
  const current = !analysis.held || analysis.data?.fen === shownFen();
  const line = analysis.data?.state === 'running' && current ? analysis.data.lines?.[0] : null;
  const show = analysis.on && !analysis.paused && analysisSettings().evalBar;
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
  lines.forEach((line, i) => {
    const move = line.uci?.[0];
    if (!move) return;
    const [x1, y1] = center(move.slice(0, 2));
    const [x2, y2] = center(move.slice(2, 4));
    // Stop short of the target square's centre so the head sits on it.
    const len = Math.hypot(x2 - x1, y2 - y1);
    const k = (len - 0.32) / len;
    const a = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    a.setAttribute('class', `line-arrow l${i + 1}`);
    a.setAttribute('x1', x1);
    a.setAttribute('y1', y1);
    a.setAttribute('x2', x1 + (x2 - x1) * k);
    a.setAttribute('y2', y1 + (y2 - y1) * k);
    a.setAttribute('marker-end', `url(#head-line-${i + 1})`);
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
})();
