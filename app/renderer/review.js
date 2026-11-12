'use strict';
// Computer analysis of a finished game, as on Lichess: the analysis engine
// evaluates every position; the moves list then marks inaccuracies,
// mistakes and blunders, and an advantage chart and per-player accuracy sit
// above it. Loaded after renderer.js, whose helpers it uses.

const rv = {
  cache: new Map(), // key → result
  running: null,    // { key, done, total }
  error: '',
  errorKey: '',
};
const REVIEW_TIMES = [[200, 'Fast'], [600, 'Normal'], [1500, 'Deep']];

const reviewKey = () => (state ? `${state.startFen}|${state.moves.map((m) => m.uci).join(' ')}` : '');
const reviewable = () => Boolean(state?.players && state.moves.length > 0 && !state.active && !state.external?.live);
function currentReview() { return state ? rv.cache.get(reviewKey()) ?? null : null; }
function reviewRunning() { return Boolean(rv.running); }

function reviewMoveTime() {
  const saved = +localStorage.getItem('reviewMoveTime');
  return REVIEW_TIMES.some(([ms]) => ms === saved) ? saved : 600;
}

async function startReview() {
  const s = analysisSettings();
  const engine = engines.find((e) => e.id === s.engineId) ?? engines[0];
  if (!engine) return;
  const key = reviewKey();
  rv.error = '';
  rv.running = { key, done: 0, total: state.moves.length + 1 };
  renderReview();
  syncAnalysis();
  try {
    await api.backend('reviewStart', {
      key, startFen: state.startFen, moves: state.moves.map((m) => m.uci), moveTimeMs: reviewMoveTime(),
      engine: { name: engine.name, path: engine.path, args: engine.args ?? [], options: engine.options ?? {} },
    });
  } catch (err) {
    rv.running = null;
    rv.error = errorText(err);
    rv.errorKey = key;
    renderReview();
  }
}

function onReviewEvent(p) {
  if (p.state === 'running') {
    rv.running = { key: p.key, done: p.done, total: p.total };
  } else {
    if (rv.running?.key === p.key) rv.running = null;
    if (p.state === 'done') {
      rv.cache.set(p.key, { ...p, moveTimeMs: reviewMoveTime() });
      if (p.key === reviewKey()) renderMoves();
    } else if (p.state === 'error') {
      rv.error = p.error;
      rv.errorKey = p.key;
    }
    syncAnalysis();
    renderAnalysis();
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

function renderReview() {
  const box = $('#review');
  if (!box) return;
  const key = reviewKey();
  const result = currentReview();
  if (!state?.players || !state.moves.length) { box.replaceChildren(); box.hidden = true; return; }
  if (rv.running?.key === key) {
    const pct = Math.round((rv.running.done / rv.running.total) * 100);
    const stop = el('button', { type: 'button', className: 'small', textContent: 'Stop' });
    stop.onclick = () => api.backend('reviewStop');
    box.replaceChildren(el('div', { className: 'review-run' }, [
      el('span', { textContent: `Computer analysis… ${rv.running.done} / ${rv.running.total}` }),
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
  const time = el('select', { title: 'Time the engine spends on each position' },
    REVIEW_TIMES.map(([ms, name]) => el('option', { value: ms, textContent: `${name} · ${ms / 1000}s a move` })));
  time.value = reviewMoveTime();
  time.onchange = () => localStorage.setItem('reviewMoveTime', time.value);
  const go = el('button', { type: 'button', className: 'small primary', textContent: 'Computer analysis' });
  go.onclick = startReview;
  const s = analysisSettings();
  const engine = engines.find((e) => e.id === s.engineId) ?? engines[0];
  const parts = [go, time, el('span', { className: 'hint', textContent: `with ${engine?.name ?? 'the analysis engine'}` })];
  box.replaceChildren(el('div', { className: 'review-ask' }, parts));
  if (rv.error && rv.errorKey === key) box.append(el('p', { className: 'error', textContent: rv.error }));
  box.hidden = false;
}

// The advantage chart: White's winning chances move by move; the light area
// is White's, the dark Black's. Mistakes are dots in their colour.
function advantageChart(result) {
  const pos = result.positions;
  const n = pos.length - 1;
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
  svg.append(svgEl('polygon', { points: `0,${H} ${pts.join(' ')} ${W},${H}`, class: 'adv-white' }));
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
    tip.textContent = `${ply ? moveLabel(ply) : 'Start'}  ${evalText(pos[ply])}`;
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
      el('td', { className: 'who' }, [el('span', { className: `side-dot ${side}` }), p?.name ?? side]),
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
  const again = el('button', { type: 'button', className: 'link', textContent: 'Analyse again' });
  again.onclick = () => { rv.cache.delete(reviewKey()); startReview(); };
  return el('div', { className: 'review-sum' }, [
    el('table', {}, [el('thead', {}, [head]), el('tbody', {}, [row('white'), row('black')])]),
    el('div', { className: 'hint' }, [`${result.engine} · ${(result.moveTimeMs ?? 0) / 1000}s a move · `, again]),
  ]);
}
