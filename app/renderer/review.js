'use strict';
// Computer analysis of a finished game, as on Lichess: the analysis engine
// evaluates every position; the moves list then marks inaccuracies,
// mistakes and blunders, and an advantage chart and per-player accuracy sit
// above it. Loaded after renderer.js, whose helpers it uses.

const rv = {
  cache: new Map(), // key → result
  unsaved: new Set(), // keys of results not yet written into the game's PGN
  waiting: new Map(), // key → functions to call when its run ends (reviewEnded)
  running: null,    // { key, done, total }
  error: '',
  errorKey: '',
};
const REVIEW_TIMES = [[200, 'Fast'], [600, 'Normal'], [1500, 'Deep']];

const reviewKey = () => (state ? `${state.startFen}|${state.moves.map((m) => m.uci).join(' ')}` : '');
const reviewable = () => Boolean(state?.players && state.moves.length > 0 && !state.active && !state.external?.live);
// A promise of how the run for key ends: done, stopped or error.
function reviewEnded(key) {
  return new Promise((resolve) => {
    if (!rv.waiting.has(key)) rv.waiting.set(key, []);
    rv.waiting.get(key).push(resolve);
  });
}

// The game on the board has an analysis its PGN does not have yet.
window.reviewNeedsSave = () => Boolean(state) && rv.unsaved.has(reviewKey());
window.reviewSaved = () => { if (state) rv.unsaved.delete(reviewKey()); };
function currentReview() { return state ? rv.cache.get(reviewKey()) ?? null : null; }
function reviewRunning() { return Boolean(rv.running); }

// Swarm: how many copies of the engine analyse the game at once, each
// taking the next position no other has; 1 is one engine on its own.
const SWARM_MAX = 32;
function reviewSwarm() {
  const n = Math.round(+localStorage.getItem('reviewSwarm'));
  return n >= 1 ? Math.min(n, SWARM_MAX) : 1;
}

function reviewMoveTime() {
  const saved = +localStorage.getItem('reviewMoveTime');
  return REVIEW_TIMES.some(([ms]) => ms === saved) ? saved : 600;
}

// Comments from the analysis: with "Comment the moves" on, each inaccuracy,
// mistake and blunder gets a comment (what was better, the line, and how
// the evaluation moved) and its mark, as annotations you can edit and save.
// A comment or mark already on a move is left alone, whoever made it.
const reviewComments = () => localStorage.getItem('reviewComments') === '1';
const hasReviewComments = () => [...notes.moves.values()].some((a) => a.auto);

function reviewCommentText(result, j) {
  const before = result.positions[j.ply - 1];
  const after = result.positions[j.ply];
  const { white } = plyNumber(j.ply);
  const mover = white ? 1 : -1;
  const kind = { inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[j.kind];
  const parts = [`${kind}.`];
  // Mates won or thrown away, from the mover's side.
  const mateFor = (p) => (p?.mate ? p.mate * mover : 0);
  if (mateFor(before) > 0 && mateFor(after) <= 0) parts.push(`Missed mate in ${mateFor(before)}.`);
  else if (mateFor(after) < 0 && mateFor(before) >= 0) parts.push(`Allows mate in ${-mateFor(after)}.`);
  if (j.best) {
    // The better line, numbered from the move it replaces.
    const line = (before.pv ?? []).slice(0, 5).map((san, i) => {
      const { n, white: w } = plyNumber(j.ply + i);
      return w ? `${n}. ${san}` : i === 0 ? `${n}... ${san}` : san;
    }).join(' ');
    parts.push(line && before.pv[0] === j.best && before.pv.length > 1 ? `${j.best} was best: ${line}.` : `${j.best} was best.`);
  }
  if (before && after) parts.push(`The evaluation went from ${evalText(before)} to ${evalText(after)}.`);
  return parts.join(' ');
}

function removeReviewComments() {
  for (const [ply, a] of [...notes.moves]) {
    if (!a.auto && !a.autoNag) continue;
    if (a.auto) { a.comment = ''; a.auto = false; }
    if (a.autoNag) { a.nag = 0; a.autoNag = false; }
    if (annEmpty(a)) notes.moves.delete(ply);
  }
}

// Fills in only what is not there: a move that already has a comment keeps
// it, and one that already has a mark keeps that, wherever they came from
// (you, the file, the AI, an earlier analysis). Nothing is taken off first;
// "Remove its comments" does that when asked.
function applyReviewComments(result, draw = {}) {
  const NAG = { inaccuracy: 6, mistake: 2, blunder: 4 };
  let n = 0;
  for (const j of result.judgments ?? []) {
    if (!j?.kind) continue;
    const a = notes.moves.get(j.ply) ?? annBlank();
    let used = false;
    if (!a.comment) { a.comment = reviewCommentText(result, j); a.auto = true; used = true; }
    if (!a.nag) { a.nag = NAG[j.kind]; a.autoNag = true; used = true; }
    if (used) { notes.moves.set(j.ply, a); n++; }
  }
  if (n) notes.dirty = true;
  renderMoves(draw);
  return n;
}

// A new analysis of the game on the board: the marks and comments an
// earlier analysis left on the moves it has judged (in this session, or
// saved in the file) give way to its own. Yours and the AI's stay.
function refreshReviewNotes(draw = {}) {
  const result = currentReview();
  if (!result || result.live) return;
  const judged = (result.judgments ?? []).length; // a stopped one: its moves only
  for (const [ply, a] of [...notes.moves]) {
    if (ply > judged || (!a.auto && !a.autoNag)) continue;
    if (a.auto) { a.comment = ''; a.auto = false; }
    if (a.autoNag) { a.nag = 0; a.autoNag = false; }
    if (annEmpty(a)) notes.moves.delete(ply);
  }
  if (reviewComments()) applyReviewComments(result, draw);
  else renderMoves(draw);
}
// (Global: annotate.js calls it when a game is opened.)

// Positions analysed before (with this engine and at least this much time
// a move) are not searched again: the backend keeps them, so carrying on
// after a stop, adding moves or changing one searches only what is new.
async function startReview() {
  const s = analysisSettings();
  const engine = engines.find((e) => e.id === s.engineId) ?? engines[0];
  if (!engine) return;
  const key = reviewKey();
  rv.error = '';
  rv.running = { key, done: 0, total: state.moves.length + 1, swarm: reviewSwarm() };
  // The analysis so far, filled in move by move as it runs (onReviewEvent)
  // and shown in the moves list meanwhile; the finished result replaces it.
  rv.cache.set(key, {
    key, engine: engine.name, live: true, partial: true, moveTimeMs: reviewMoveTime(), prev: rv.cache.get(key),
    positions: [], judgments: [],
  });
  renderReview();
  syncAnalysis();
  try {
    await api.backend('reviewStart', {
      key, startFen: state.startFen, moves: state.moves.map((m) => m.uci), moveTimeMs: reviewMoveTime(), swarm: reviewSwarm(),
      engine: { name: engine.name, path: engine.path, args: engine.args ?? [], options: engine.options ?? {} },
    });
  } catch (err) {
    rv.running = null;
    dropLiveReview(key);
    rv.error = errorText(err);
    rv.errorKey = key;
    renderReview();
  }
}

// A run that left nothing to keep: what was there before it comes back.
function dropLiveReview(key) {
  const live = rv.cache.get(key);
  if (!live?.live) return;
  if (live.prev) rv.cache.set(key, live.prev); else rv.cache.delete(key);
  if (key === reviewKey()) renderMoves();
}

// Moves judged while the analysis runs are drawn in batches, as the
// engines' own scores are, not at every position.
let reviewDrawTimer = null;
function scheduleReviewDraw() {
  if (reviewDrawTimer) return;
  reviewDrawTimer = setTimeout(() => {
    reviewDrawTimer = null;
    const live = currentReview();
    if (!live?.live) return;
    if (reviewComments()) applyReviewComments(live, { steady: true }); else renderMoves({ steady: true });
  }, 400);
}

function onReviewEvent(p) {
  if (p.state === 'running') {
    rv.running = { key: p.key, done: p.done, total: p.total, reused: p.reused ?? 0, searched: p.searched ?? 0, swarm: rv.running?.swarm ?? 1 };
    const live = rv.cache.get(p.key);
    if (p.position && live?.live) {
      // With a swarm they come in any order: each in its place.
      live.positions[p.ply ?? p.done - 1] = p.position;
      for (const j of p.moveJudgments ?? []) live.judgments[j.ply - 1] = j;
      if (p.key === reviewKey()) scheduleReviewDraw();
    }
  } else {
    if (rv.running?.key === p.key) rv.running = null;
    for (const f of rv.waiting.get(p.key) ?? []) f(p.state);
    rv.waiting.delete(p.key);
    clearTimeout(reviewDrawTimer);
    reviewDrawTimer = null;
    if (p.state === 'done' || (p.state === 'stopped' && p.positions?.length >= 2)) {
      // Stopped early: the moves analysed so far are kept and shown.
      const partial = p.state === 'stopped' && p.positions.length < p.total;
      rv.cache.set(p.key, { ...p, partial, moveTimeMs: reviewMoveTime() });
      // Its evaluations and marks go into the game's PGN, as any annotation
      // does: saved by themselves now, or when the game is next on the board.
      rv.unsaved.add(p.key);
      if (p.key === reviewKey()) {
        notes.dirty = true;
        refreshReviewNotes({ steady: true });
      }
    } else {
      dropLiveReview(p.key);
      if (p.state === 'error') {
        rv.error = p.error;
        rv.errorKey = p.key;
      }
    }
    syncAnalysis();
    renderAnalysis();
    window.refreshGamesAnalysed?.(); // the game may be one of the list's
  }
  if (p.key === reviewKey()) renderReview();
}

// Winning chances, −1…1, from an evaluation (White's side): Lichess's curve.
function winChances(pos) {
  if (pos.final === 'checkmate' || pos.mate) return pos.cp > 0 ? 1 : -1;
  const cp = Math.max(-1000, Math.min(1000, pos.cp));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

function evalText(pos) {
  if (pos.final === 'checkmate') return pos.cp > 0 ? '1-0' : '0-1';
  if (pos.final === 'stalemate') return '½-½';
  if (pos.mate) return `#${pos.mate}`;
  const v = pos.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}

// The settings of Computer analysis, as controls: time a move, swarm,
// Comment the moves, and which engine (chosen in Settings → Analysis).
// Shown in the Moves tab and, for the games chosen, in the Games tab; both
// keep them in the same place, so a change in one holds for the other.
function reviewSettingsControls(where = 'moves') {
  const time = el('select', { className: 'review-time', title: 'Time the engine spends on each position' },
    REVIEW_TIMES.map(([ms, name]) => el('option', { value: ms, textContent: `${name} · ${ms / 1000}s a move` })));
  time.value = reviewMoveTime();
  time.onchange = () => { localStorage.setItem('reviewMoveTime', time.value); reviewSettingsChanged(where); };
  // Swarm: up to one engine per processor core is offered (more is allowed
  // by hand, up to the most the backend runs).
  const cores = Math.max(1, Math.min(SWARM_MAX, navigator.hardwareConcurrency || 4));
  const counts = [...new Set([1, 2, 4, 6, 8, 12, 16, 24, 32].filter((n) => n <= cores).concat(cores, reviewSwarm()))].sort((a, b) => a - b);
  const swarm = el('select', {
    className: 'review-swarm',
    title: 'Swarm: how many copies of the engine analyse the game at once, each taking the next position not yet taken. '
      + `Each runs with the engine's own options, Threads included, so the threads in use are this times its Threads. This computer has ${navigator.hardwareConcurrency || '?'} cores.`,
  }, counts.map((n) => el('option', { value: n, textContent: n === 1 ? '1 engine' : `Swarm · ${n} engines` })));
  swarm.value = reviewSwarm();
  swarm.onchange = () => { localStorage.setItem('reviewSwarm', swarm.value); reviewSettingsChanged(where); };
  const box = el('input', { type: 'checkbox', checked: reviewComments() });
  box.onchange = () => { localStorage.setItem('reviewComments', box.checked ? '1' : ''); reviewSettingsChanged(where); };
  const comments = el('label', { className: 'check review-comments', title: 'Write a comment on each inaccuracy, mistake and blunder: the better move and line, and how the evaluation moved. They become annotations you can edit and save.' }, [box, ' Comment the moves']);
  const engine = el('span', { className: 'hint review-engine', textContent: `with ${reviewEngineName()}`, title: 'The analysis engine: chosen in Settings → Analysis' });
  return [time, swarm, comments, engine];
}

const reviewEngineName = () => {
  const s = analysisSettings();
  return (engines.find((e) => e.id === s.engineId) ?? engines[0])?.name ?? 'the analysis engine';
};

// The same settings in words, for while a run goes on.
function reviewSettingsText() {
  const n = reviewSwarm();
  return `${reviewEngineName()} · ${reviewMoveTime() / 1000}s a move${n > 1 ? ` · ${n} engines` : ''}${reviewComments() ? ' · commenting the moves' : ''}`;
}

// A setting changed in one tab: the other shows it too (the one in use is
// left as it is, keeping the keyboard where it was).
function reviewSettingsChanged(where) {
  if (where !== 'moves') renderReview();
  if (where !== 'games') window.renderGamesSelection?.();
}

function renderReview() {
  const box = $('#review');
  if (!box) return;
  const key = reviewKey();
  const result = currentReview();
  if (!state?.players || !state.moves.length) { box.replaceChildren(); box.hidden = true; return; }
  if (rv.running?.key === key) {
    const pct = Math.round((rv.running.done / rv.running.total) * 100);
    // Positions analysed before (with this engine and at least this much
    // time) are not searched again: the count is of the ones left.
    const { reused = 0, searched = 0, total } = rv.running;
    const swarm = rv.running.swarm > 1 ? ` · ${rv.running.swarm} engines` : '';
    const text = reused
      ? `Computer analysis… ${searched} of ${total - reused} positions (${reused} already analysed)${swarm}`
      : `Computer analysis… ${rv.running.done} / ${total}${swarm}`;
    const stop = el('button', { type: 'button', className: 'small', textContent: 'Stop' });
    stop.onclick = () => api.backend('reviewStop');
    box.replaceChildren(el('div', { className: 'review-run' }, [
      el('span', { textContent: text }),
      el('div', { className: 'review-bar' }, [el('div', { style: `width:${pct}%` })]),
      stop,
    ]));
    box.hidden = false;
    return;
  }
  if (result) {
    box.replaceChildren(advantageChart(result), reviewSummary(result));
    box.hidden = false;
    return;
  }
  if (!reviewable()) { box.replaceChildren(); box.hidden = true; return; }
  const go = el('button', { type: 'button', className: 'small primary', textContent: 'Computer analysis' });
  go.onclick = () => startReview();
  const parts = [go, ...reviewSettingsControls()];
  box.replaceChildren(el('div', { className: 'review-ask' }, parts));
  if (rv.error && rv.errorKey === key) box.append(el('p', { className: 'error', textContent: rv.error }));
  box.hidden = false;
}

// The advantage chart: White's winning chances move by move; the light area
// is White's, the dark Black's. Mistakes are dots in their colour.
function advantageChart(result) {
  const pos = result.positions;
  // A stopped analysis covers the first moves only: the chart keeps the
  // whole game's width and the rest stays empty.
  const n = result.partial ? Math.max(pos.length - 1, state.moves.length) : pos.length - 1;
  const last = pos.length - 1;
  const W = 600, H = 80;
  const X = (i) => (n ? (i / n) * W : 0);
  const Y = (c) => H / 2 - c * (H / 2 - 2);
  const pts = pos.map((p, i) => `${X(i).toFixed(1)},${Y(winChances(p)).toFixed(1)}`);
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'adv-svg', role: 'img', 'aria-label': 'Advantage chart' });
  svg.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'adv-black' }));
  svg.append(svgEl('polygon', { points: `0,${H} ${pts.join(' ')} ${X(last).toFixed(1)},${H}`, class: 'adv-white' }));
  if (last < n) svg.append(svgEl('rect', { x: X(last), y: 0, width: W - X(last), height: H, class: 'adv-todo' }));
  svg.append(svgEl('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, class: 'adv-mid' }));
  svg.append(svgEl('polyline', { points: pts.join(' '), class: 'adv-line' }));
  const cur = svgEl('line', { x1: X(shownPly()), x2: X(shownPly()), y1: 0, y2: H, class: 'adv-cur' });
  svg.append(cur);
  const wrap = el('div', { className: 'adv' }, [svg]);
  for (const j of result.judgments) {
    if (!j.kind) continue;
    const p = pos[j.ply];
    wrap.append(el('span', {
      className: `adv-dot ${j.kind}`, title: `${moveLabel(j.ply)} ${j.glyph}`,
      style: `left:${(j.ply / n) * 100}%;top:${(Y(winChances(p)) / H) * 100}%`,
    }));
  }
  const tip = el('div', { className: 'adv-tip', hidden: true });
  wrap.append(tip);
  const plyAt = (ev) => {
    const r = wrap.getBoundingClientRect();
    return Math.max(0, Math.min(n, Math.round(((ev.clientX - r.left) / r.width) * n)));
  };
  wrap.addEventListener('mousemove', (ev) => {
    const ply = plyAt(ev);
    tip.textContent = `${ply ? moveLabel(ply) : 'Start'}  ${pos[ply] ? evalText(pos[ply]) : 'not analysed'}`;
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    tip.style.left = `${Math.min(r.width - tip.offsetWidth, Math.max(0, ev.clientX - r.left - tip.offsetWidth / 2))}px`;
  });
  wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
  wrap.addEventListener('click', (ev) => showPly(plyAt(ev)));
  return wrap;
}

function moveLabel(ply) {
  const [, turn, , , , fullmove] = state.startFen.split(' ');
  const first = turn === 'w' ? 0 : 1;
  const idx = ply - 1 + first;
  const number = (+fullmove || 1) + Math.floor(idx / 2);
  return `${number}${idx % 2 === 0 ? '.' : '…'} ${state.moves[ply - 1]?.san ?? ''}`;
}

function reviewSummary(result) {
  const row = (side) => {
    const s = result[side];
    const p = state.players?.[side];
    return el('tr', {}, [
      el('td', { className: 'who' }, [el('span', { className: `side-dot ${side}` }),
        ...[lichessUser(side) ? flagSpan(lichessUser(side)) : null].filter(Boolean), p?.name ?? side]),
      el('td', { className: 'n inaccuracy', title: 'Inaccuracies', textContent: s.inaccuracies }),
      el('td', { className: 'n mistake', title: 'Mistakes', textContent: s.mistakes }),
      el('td', { className: 'n blunder', title: 'Blunders', textContent: s.blunders }),
      el('td', { className: 'n', title: 'Average centipawn loss', textContent: Math.round(s.acpl) }),
      el('td', { className: 'n acc', title: 'Accuracy', textContent: `${Math.round(s.accuracy)}%` }),
    ]);
  };
  const head = el('tr', {}, ['', '?!', '?', '??', 'ACPL', 'Accuracy'].map((t, i) => el('th', {
    className: i ? 'n' : '', textContent: t,
    title: ['', 'Inaccuracies', 'Mistakes', 'Blunders', 'Average centipawn loss', 'Accuracy'][i],
  })));
  // Back to the choice of time a move: a longer one searches again.
  const again = el('button', { type: 'button', className: 'link', textContent: 'Analyse again…' });
  again.title = 'Choose the time a move and run it again. Positions already analysed with at least that much time are not searched again.';
  again.onclick = () => { rv.cache.delete(reviewKey()); renderMoves({ steady: true }); renderReview(); };
  // A stopped analysis carries on after the moves it has.
  const go = el('button', { type: 'button', className: 'small primary', textContent: 'Continue' });
  go.title = 'Analyse the rest of the game, keeping what is done';
  go.onclick = () => startReview();
  const done = result.positions.length - 1;
  const commented = hasReviewComments();
  const comment = el('button', { type: 'button', className: 'link', textContent: commented ? 'Remove its comments' : 'Comment the moves' });
  comment.title = commented ? 'Take the analysis’s comments off the moves; yours stay' : 'Write a comment on each inaccuracy, mistake and blunder';
  comment.onclick = () => {
    if (commented) { removeReviewComments(); notes.dirty = true; renderMoves(); } else applyReviewComments(result);
  };
  return el('div', { className: 'review-sum' }, [
    ...(result.partial ? [el('div', { className: 'review-partial' }, [
      el('span', { textContent: `Stopped early: ${done} of ${state.moves.length} moves analysed (up to ${moveLabel(done)}). The figures cover those moves only.` }), go])] : []),
    el('table', {}, [el('thead', {}, [head]), el('tbody', {}, [row('white'), row('black')])]),
    el('div', { className: 'hint' }, [`${result.engine} · ${(result.moveTimeMs ?? 0) / 1000}s a move · `, again,
      ...(result.judgments?.some((j) => j.kind) || commented ? [' · ', comment] : [])]),
  ]);
}
