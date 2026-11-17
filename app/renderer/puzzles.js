'use strict';
// Puzzles, as on Lichess: from lichess.org (next, by theme and difficulty,
// or the daily puzzle), or offline from the Lichess puzzle database file.
// The puzzle is played on the board; the opponent's replies come by
// themselves. Loaded after renderer.js.

const PZ_THEMES = [
  ['', 'Any theme'], ['mateIn1', 'Mate in 1'], ['mateIn2', 'Mate in 2'], ['mateIn3', 'Mate in 3'], ['fork', 'Fork'],
  ['pin', 'Pin'], ['skewer', 'Skewer'], ['discoveredAttack', 'Discovered attack'], ['hangingPiece', 'Hanging piece'],
  ['sacrifice', 'Sacrifice'], ['deflection', 'Deflection'], ['backRankMate', 'Back-rank mate'], ['endgame', 'Endgame'],
  ['middlegame', 'Middlegame'], ['opening', 'Opening'], ['short', 'Short'], ['long', 'Long'], ['crushing', 'Crushing'],
];

let pz = null; // the puzzle being played
const pzStats = (() => {
  try { return { solved: 0, failed: 0, streak: 0, rating: 1500, ...JSON.parse(localStorage.getItem('puzzleStats') || '{}') }; } catch { return { solved: 0, failed: 0, streak: 0, rating: 1500 }; }
})();
let pzSource = localStorage.getItem('puzzleSource') || 'lichess';

function puzzleUnsolved() { return Boolean(pz && !pz.done); }

for (const [id] of [['#pz-theme'], ['#pz-file-theme']]) {
  $(id).replaceChildren(...PZ_THEMES.map(([v, t]) => el('option', { value: v, textContent: t })));
}
$('#pz-theme').value = localStorage.getItem('puzzleTheme') || '';
$('#pz-theme').onchange = () => localStorage.setItem('puzzleTheme', $('#pz-theme').value);
$('#pz-difficulty').value = localStorage.getItem('puzzleDifficulty') || 'normal';
$('#pz-difficulty').onchange = () => localStorage.setItem('puzzleDifficulty', $('#pz-difficulty').value);
$('#pz-min').value = localStorage.getItem('puzzleMin') || '';
$('#pz-max').value = localStorage.getItem('puzzleMax') || '';
$('#pz-min').onchange = () => localStorage.setItem('puzzleMin', $('#pz-min').value);
$('#pz-max').onchange = () => localStorage.setItem('puzzleMax', $('#pz-max').value);

function setPuzzleSource(src) {
  pzSource = src;
  localStorage.setItem('puzzleSource', src);
  for (const b of document.querySelectorAll('#pz-source button')) b.classList.toggle('on', b.dataset.src === src);
  $('#pz-lichess-opts').hidden = src !== 'lichess';
  $('#pz-file-opts').hidden = src !== 'file';
  $('#pz-daily').hidden = src !== 'lichess';
}
for (const b of document.querySelectorAll('#pz-source button')) b.onclick = () => setPuzzleSource(b.dataset.src);
setPuzzleSource(pzSource);

function pzError(text) {
  $('#pz-error').textContent = text ?? '';
  $('#pz-error').hidden = !text;
}

let pzFile = null; // { path, count }
async function openPuzzleFile(path) {
  pzError('');
  $('#pz-file-name').textContent = 'Reading…';
  try {
    pzFile = await api.backend('puzzleFileOpen', { path });
    localStorage.setItem('puzzleFile', path);
  } catch (err) {
    pzFile = null;
    pzError(errorText(err));
  }
  renderPuzzleFile();
}
function renderPuzzleFile() {
  $('#pz-file-name').textContent = pzFile ? `${pzFile.path.split(/[\\/]/).pop()} · ${pzFile.count.toLocaleString()} puzzles`
    : 'lichess_db_puzzle.csv from database.lichess.org (decompressed)';
}
$('#pz-file-open').onclick = async () => {
  const path = await api.lichess.choosePuzzleFile();
  if (path) openPuzzleFile(path);
};

// ---------------------------------------------------------------------------
// Loading a puzzle
// ---------------------------------------------------------------------------
async function nextPuzzle(kind = 'next') {
  pzError('');
  $('#pz-next').disabled = $('#pz-daily').disabled = true;
  try {
    if (pzSource === 'file' && kind !== 'daily') {
      if (!pzFile) throw new Error('Open the puzzle file first.');
      const p = await api.backend('puzzleRandom', { min: +$('#pz-min').value || 0, max: +$('#pz-max').value || 0, theme: $('#pz-file-theme').value });
      // The file's position is before the opponent's move, which starts the puzzle.
      const first = await api.backend('applyMove', { fen: p.fen, uci: p.moves[0] });
      startPuzzle({
        id: p.id, rating: p.rating, themes: p.themes, url: p.gameUrl,
        fen: first.fen, lastMove: first.uci, lastSan: first.san, solution: p.moves.slice(1),
      });
    } else {
      const data = await api.lichess.puzzle(kind, { angle: $('#pz-theme').value, difficulty: $('#pz-difficulty').value });
      const pos = await api.backend('pgnPosition', { pgn: data.game.pgn });
      const lastSan = data.game.pgn.trim().split(/\s+/).filter((t) => !/^\d+\./.test(t)).pop();
      startPuzzle({
        id: data.puzzle.id, rating: data.puzzle.rating, themes: data.puzzle.themes,
        url: `https://lichess.org/training/${data.puzzle.id}`,
        fen: data.puzzle.fen || pos.fen, lastMove: data.puzzle.lastMove || pos.lastMove, lastSan,
        solution: data.puzzle.solution, daily: kind === 'daily',
      });
    }
  } catch (err) {
    pzError(errorText(err));
  } finally {
    $('#pz-next').disabled = $('#pz-daily').disabled = false;
  }
}
$('#pz-next').onclick = () => nextPuzzle('next');
$('#pz-daily').onclick = () => nextPuzzle('daily');

function startPuzzle(p) {
  const color = p.fen.split(' ')[1] === 'w' ? 'white' : 'black';
  pz = { ...p, color, step: 0, done: false, failed: false, history: [], wrong: false };
  puzzleView = { fen: p.fen, lastMove: p.lastMove, lastSan: p.lastSan, canMove: true };
  flipped = color === 'black';
  selected = null;
  stopAnalysisForPuzzle();
  renderPuzzle();
  renderBoard();
  renderCaptured();
  sounds.play('move');
}

function stopAnalysisForPuzzle() {
  if (typeof syncAnalysis === 'function') { syncAnalysis(); renderAnalysis(); }
}

function leavePuzzle() {
  pz = null;
  puzzleView = null;
  selected = null;
  renderPuzzle();
  if (state) { renderBoard(); renderMoves(); renderOpening(); renderStatus(); syncAnalysis(); renderAnalysis(); }
}
$('#pz-leave').onclick = leavePuzzle;

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------
async function applyPuzzleMove(uci) {
  const r = await api.backend('applyMove', { fen: puzzleView.fen, uci });
  pz.history.push({ ...puzzleView });
  puzzleView.fen = r.fen;
  puzzleView.lastMove = r.uci;
  puzzleView.lastSan = r.san;
  pz.played = [...(pz.played ?? []), r.san];
  sounds.play(moveSound(r));
  renderBoard();
  renderPuzzle();
  return r;
}

async function puzzleMove(uci) {
  if (!pz || pz.done || !puzzleView.canMove) return;
  const expected = pz.solution[pz.step];
  puzzleView.canMove = false;
  const r = await applyPuzzleMove(uci);
  // Any mate is right on the last move, as on Lichess.
  const mates = /#$/.test(r.san) && pz.step === pz.solution.length - 1;
  if (uci === expected || mates) {
    pz.step++;
    pz.wrong = false;
    if (pz.step >= pz.solution.length) { finishPuzzle(true); return; }
    // The opponent's reply.
    setTimeout(async () => {
      if (!pz) return;
      await applyPuzzleMove(pz.solution[pz.step]);
      pz.step++;
      if (pz.step >= pz.solution.length) { finishPuzzle(true); return; }
      puzzleView.canMove = true;
      renderBoard();
      renderPuzzle();
    }, 450);
    renderPuzzle();
    return;
  }
  // Wrong: take it back after a moment.
  pz.wrong = true;
  if (!pz.failed) { pz.failed = true; scorePuzzle(false); }
  sounds.play('illegal');
  renderPuzzle();
  setTimeout(() => {
    if (!pz) return;
    const prev = pz.history.pop();
    Object.assign(puzzleView, prev, { canMove: true });
    pz.played.pop();
    renderBoard();
    renderPuzzle();
  }, 700);
}

function finishPuzzle(solved) {
  pz.done = true;
  puzzleView.canMove = false;
  if (solved && !pz.failed) scorePuzzle(true);
  if (solved && !pz.failed) sounds.play('win');
  renderPuzzle();
  renderBoard();
  syncAnalysis();
  renderAnalysis();
}

// A simple Elo-style puzzle rating, kept on this computer.
function scorePuzzle(win) {
  const expected = 1 / (1 + 10 ** ((pz.rating - pzStats.rating) / 400));
  pzStats.rating = Math.round(pzStats.rating + 32 * ((win ? 1 : 0) - expected));
  if (win) { pzStats.solved++; pzStats.streak++; } else { pzStats.failed++; pzStats.streak = 0; }
  localStorage.setItem('puzzleStats', JSON.stringify(pzStats));
}

$('#pz-hint').onclick = () => {
  if (!pz || pz.done || !puzzleView.canMove) return;
  selected = pz.solution[pz.step].slice(0, 2);
  if (!pz.failed) { pz.failed = true; scorePuzzle(false); }
  renderBoard();
  renderPuzzle();
};

$('#pz-solution').onclick = async () => {
  if (!pz || pz.done) return;
  if (!pz.failed) { pz.failed = true; scorePuzzle(false); }
  puzzleView.canMove = false;
  pz.viewing = true;
  while (pz && pz.step < pz.solution.length) {
    await applyPuzzleMove(pz.solution[pz.step]);
    pz.step++;
    await new Promise((r) => setTimeout(r, 650));
  }
  if (pz) finishPuzzle(false);
};

$('#pz-retry').onclick = () => {
  if (!pz) return;
  const { history, ...p } = pz;
  const first = history[0] ?? puzzleView;
  startPuzzle({ ...p, fen: first.fen, lastMove: first.lastMove, lastSan: first.lastSan });
};

function renderPuzzle() {
  const card = $('#pz-card');
  card.hidden = !pz;
  $('#pz-rating').textContent = pzStats.rating;
  $('#pz-solved').textContent = pzStats.solved;
  $('#pz-failed').textContent = pzStats.failed;
  $('#pz-streak').textContent = pzStats.streak;
  document.body.classList.toggle('puzzling', Boolean(pz));
  if (!pz) return;
  const side = pz.color === 'white' ? 'White' : 'Black';
  let status;
  let cls = '';
  if (pz.done && !pz.failed) { status = 'Puzzle solved!'; cls = 'good'; }
  else if (pz.done) { status = pz.viewing ? 'That was the solution.' : 'Puzzle complete.'; }
  else if (pz.wrong) { status = 'That’s not the move! Try something else.'; cls = 'bad'; }
  else if (pz.step > 0) { status = 'Best move! Keep going…'; cls = 'good'; }
  else status = `Your turn: find the best move for ${side}.`;
  $('#pz-status').textContent = status;
  $('#pz-status').className = 'pz-status ' + cls;
  // The badge: a tick when solved, a cross on a wrong move, else the side to play.
  const badge = $('#pz-badge');
  badge.className = 'pz-badge ' + (pz.done && !pz.failed ? 'good' : pz.wrong ? 'bad' : pz.done ? 'done' : pz.color);
  badge.textContent = pz.done && !pz.failed ? '✓' : pz.wrong ? '✕' : pz.done ? '•' : '';
  setStatus(`Puzzle · ${status}`);
  const info = [`Rating ${pz.rating}`];
  if (pz.daily) info.unshift('Daily puzzle');
  const box = $('#pz-info');
  box.replaceChildren(info.join(' · '), ' · ');
  const link = el('a', { href: '#', textContent: `#${pz.id}` });
  link.onclick = (e) => { e.preventDefault(); api.openExternal(pz.url); };
  box.append(link);
  if (pz.done) box.append(el('div', { className: 'pz-themes', textContent: (pz.themes ?? []).join(' · ') }));
  $('#pz-line').replaceChildren(...(pz.played ?? []).map((m) => el('span', { className: 'pz-move', textContent: m })));
  $('#pz-hint').hidden = $('#pz-solution').hidden = pz.done;
  $('#pz-retry').hidden = !pz.done;
}

renderPuzzle();
if (localStorage.getItem('puzzleFile') && pzSource === 'file') openPuzzleFile(localStorage.getItem('puzzleFile'));
