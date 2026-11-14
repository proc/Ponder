'use strict';
// Test positions: the Win at Chess suite built in, and any EPD file you open
// (Bratko-Kopec, Arasan, your own). Pick a position to put it on the board
// and analyse it; a bar over the moves keeps its number, the side to move,
// the solution (hidden until asked for), whether the analysis has found it,
// and buttons to the previous and next position.

const tp = {
  suites: [],        // { name, positions: [{ fen, id, bm: [], am: [], comment }] }
  suite: 0,          // index into suites
  index: -1,         // the position on the board (-1: none)
  fen: '',           // its FEN, to notice when the board moves on
  reveal: false,     // the solution is shown
  filter: '',
  selected: 0,       // row selected in the list
  show: 'all',       // list filter by test result: all, solved, failed
  // Engine tests: results by suite, then by position index.
  results: new Map(),
  run: null,         // the run under way: { key, suite, engine, total, done, solved, started, timeMs }
  last: null,        // the last finished run, for its summary
};
const tpResults = (suite) => {
  if (!tp.results.has(suite)) tp.results.set(suite, new Map());
  return tp.results.get(suite);
};

// One EPD line: four FEN fields, then operations like `bm Qg6; id "WAC.001";`.
function parseEpd(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split(/\s+/);
    if (f.length < 4 || !/^[1-8pnbrqkPNBRQK/]+$/.test(f[0]) || !/^[wb]$/.test(f[1])) continue;
    let fen = f.slice(0, 4).join(' ');
    let rest = f.slice(4).join(' ');
    // Some files carry the move counters too (a full FEN).
    const counters = rest.match(/^(\d+)\s+(\d+)(\s+|$)/);
    if (counters) { fen += ` ${counters[1]} ${counters[2]}`; rest = rest.slice(counters[0].length); } else fen += ' 0 1';
    const ops = {};
    for (const op of rest.match(/[A-Za-z][\w]*\s*(?:"[^"]*"|[^;]*)\s*;/g) ?? []) {
      const m = op.match(/^([A-Za-z]\w*)\s*(.*?)\s*;$/);
      if (m) ops[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    out.push({
      fen,
      id: ops.id || `#${out.length + 1}`,
      bm: (ops.bm ?? '').split(/\s+/).filter(Boolean),
      am: (ops.am ?? '').split(/\s+/).filter(Boolean),
      comment: ops.c0 ?? '',
    });
  }
  return out;
}

tp.suites.push({ name: 'Win at Chess (WAC)', builtin: true, positions: parseEpd(WAC_EPD) });

const sanKey = (san) => String(san).replace(/[+#!?]/g, '');
const tpCurrent = () => tp.suites[tp.suite]?.positions[tp.index] ?? null;

// ---------------------------------------------------------------------------
// The dialog: suites, a search, the list, and a preview of the selected one.
// ---------------------------------------------------------------------------
const dlgPositions = $('#dlg-positions');

function openPositions() {
  tp.selected = tp.index >= 0 ? tp.index : tp.selected;
  fillTestEngines();
  renderPositionSuites();
  $('#tp-filter').value = tp.filter;
  renderPositionList();
  renderTestProgress();
  dlgPositions.showModal();
  $('#tp-filter').focus();
}

function renderPositionSuites() {
  const sel = $('#tp-suite');
  sel.replaceChildren(...tp.suites.map((s, i) => el('option', { value: i, textContent: `${s.name} · ${s.positions.length}` })));
  sel.value = String(tp.suite);
}

function tpFiltered() {
  const q = tp.filter.trim().toLowerCase();
  const list = tp.suites[tp.suite]?.positions ?? [];
  const results = tpResults(tp.suite);
  return list.map((p, i) => ({ p, i })).filter(({ p, i }) => {
    const r = results.get(i);
    if (tp.show === 'solved' && !r?.solved) return false;
    if (tp.show === 'failed' && (!r || r.solved)) return false;
    if (!q) return true;
    // A number finds that position (WAC.42, 42); text searches ids and comments.
    if (/^\d+$/.test(q)) return String(i + 1) === q || p.id.replace(/\D/g, '').replace(/^0+/, '') === q.replace(/^0+/, '');
    return p.id.toLowerCase().includes(q) || p.comment.toLowerCase().includes(q);
  });
}

function renderPositionList() {
  const rows = tpFiltered();
  if (!rows.some(({ i }) => i === tp.selected) && rows.length) tp.selected = rows[0].i;
  $('#tp-list').replaceChildren(...rows.map(({ p, i }) => {
    const white = p.fen.split(' ')[1] === 'w';
    const r = tpResults(tp.suite).get(i);
    const row = el('button', { type: 'button', className: 'tp-row' + (i === tp.selected ? ' selected' : '') + (i === tp.index && tp.suite === tpShownSuite() ? ' current' : '') }, [
      el('span', { className: 'tp-id', textContent: p.id }),
      el('span', { className: `tp-side ${white ? 'w' : 'b'}`, textContent: white ? 'White to move' : 'Black to move' }),
      r ? resultBadge(r, p) : el('span', { className: 'tp-tag', textContent: p.bm.length ? 'find the best move' : p.am.length ? 'avoid a move' : '' }),
    ]);
    row.dataset.i = i;
    row.onclick = () => { tp.selected = i; renderPositionList(); };
    row.ondblclick = () => loadPosition(tp.suite, i);
    return row;
  }));
  $('#tp-count').textContent = `${rows.length} of ${tp.suites[tp.suite]?.positions.length ?? 0}`;
  $('#tp-list .selected')?.scrollIntoView({ block: 'nearest' });
  renderPositionPreview();
}

let tpShown = { suite: -1 };
const tpShownSuite = () => tpShown.suite;

function renderPositionPreview() {
  const p = tp.suites[tp.suite]?.positions[tp.selected];
  const box = $('#tp-preview');
  if (!p) { box.replaceChildren(); $('#tp-load').disabled = true; return; }
  $('#tp-load').disabled = false;
  box.replaceChildren(miniBoard(p.fen), el('div', { className: 'tp-preview-text' }, [
    el('b', { textContent: p.id }),
    el('span', { textContent: p.fen.split(' ')[1] === 'w' ? ' · White to move' : ' · Black to move' }),
    ...(p.comment ? [el('div', { className: 'hint', textContent: p.comment })] : []),
  ]));
}

// A small picture of a position, in the board's colours and pieces; from
// Black's side when flip is set. Its size is the --mini CSS variable.
function miniBoard(fen, flip = false) {
  const rows = fen.split(' ')[0].split('/');
  const squares = [];
  rows.forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < +ch; k++, c++) squares.push(el('div', { className: 'square ' + ((r + c) % 2 ? 'dark' : 'light') }));
      } else {
        squares.push(el('div', { className: 'square ' + ((r + c) % 2 ? 'dark' : 'light') }, [pieceImage(ch.toLowerCase(), ch === ch.toUpperCase())]));
        c++;
      }
    }
  });
  if (flip) squares.reverse(); // a half turn: the squares keep their colours
  return themeElement(el('div', { className: 'tp-mini' }, squares), theme);
}

$('#tp-suite').onchange = (e) => { tp.suite = +e.target.value; tp.selected = 0; renderPositionList(); renderTestProgress(); };
$('#tp-filter').oninput = (e) => { tp.filter = e.target.value; renderPositionList(); };
$('#tp-filter').onkeydown = (e) => {
  const rows = tpFiltered();
  const at = rows.findIndex(({ i }) => i === tp.selected);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { tp.selected = next.i; renderPositionList(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (rows.length) loadPosition(tp.suite, tp.selected);
  }
};
$('#tp-load').onclick = () => loadPosition(tp.suite, tp.selected);
$('#tp-cancel').onclick = () => dlgPositions.close();
$('#tp-open').onclick = async () => {
  let file;
  try { file = await api.openEpd(); } catch (err) { $('#tp-error').textContent = errorText(err); $('#tp-error').hidden = false; return; }
  if (!file) return;
  const positions = parseEpd(file.text);
  if (!positions.length) {
    $('#tp-error').textContent = `${file.name} has no positions Ponder can read (EPD: a FEN's first four fields, then operations such as bm and id).`;
    $('#tp-error').hidden = false;
    return;
  }
  $('#tp-error').hidden = true;
  const existing = tp.suites.findIndex((s) => s.path === file.path);
  const suite = { name: file.name.replace(/\.epd$/i, ''), path: file.path, positions };
  if (existing >= 0) tp.suites[existing] = suite; else tp.suites.push(suite);
  tp.suite = existing >= 0 ? existing : tp.suites.length - 1;
  tp.selected = 0;
  tp.filter = '';
  $('#tp-filter').value = '';
  renderPositionSuites();
  renderPositionList();
  renderTestProgress();
};

// ---------------------------------------------------------------------------
// On the board.
// ---------------------------------------------------------------------------
async function loadPosition(suite, index) {
  const p = tp.suites[suite]?.positions[index];
  if (!p) return;
  if (state?.active && !state.external) {
    const ok = await confirmDialog('Put this position on the board? The game you are playing will be abandoned.', 'Load position');
    if (!ok) return;
  }
  const pgn = `[Event "${p.id.replace(/"/g, '')}"]\n[Site "${tp.suites[suite].name.replace(/"/g, '')}"]\n[SetUp "1"]\n[FEN "${p.fen}"]\n[Result "*"]\n\n*\n`;
  try {
    await api.backend('loadPgnText', { pgn, source: tp.suites[suite].name });
  } catch (err) {
    $('#tp-error').textContent = errorText(err);
    $('#tp-error').hidden = false;
    return;
  }
  tp.suite = suite;
  tp.index = index;
  tp.selected = index;
  tpShown = { suite };
  tp.reveal = false;
  tp.fen = p.fen;
  if (dlgPositions.open) dlgPositions.close();
  // The side to move at the bottom, and the analysis on.
  flipped = p.fen.split(' ')[1] === 'b';
  renderBoard();
  renderPlayers?.();
  if (!analysis.on) $('#btn-analysis').click();
  renderPositionBar();
  // Reviewing missed positions: the solution and the engine's move go into
  // the moves list as two lines, and the solution is shown.
  const r = tpResults(suite).get(index);
  if (tp.suites[suite].review && r && !r.error) {
    tp.reveal = true;
    // Wait for the board to have the position (the state comes as an event).
    const key = p.fen.split(' ').slice(0, 4).join(' ');
    for (let t = 0; t < 40 && state?.startFen?.split(' ').slice(0, 4).join(' ') !== key; t++) await new Promise((res) => setTimeout(res, 25));
    if (tp.suite !== suite || tp.index !== index) return;
    const engine = tp.suites[suite].engine ?? 'Engine';
    const score = tpScore(r, p);
    const want = p.bm.length ? (r.want ?? []) : [];
    for (const u of want) await addLine(0, [u], p.bm.length > 1 ? 'A solution' : 'Solution', 'good');
    await addLine(0, r.pvUci?.length ? r.pvUci : [r.uci], `${engine}${r.depth ? ` · d${r.depth}` : ''} · ${score}`, 'bad');
    renderPositionBar();
  }
}

// While the loaded position (or a line played from it) is on the board.
function positionActive() {
  if (tp.index < 0 || !state?.loaded || state.startFen?.split(' ').slice(0, 4).join(' ') !== tp.fen.split(' ').slice(0, 4).join(' ')) return false;
  return true;
}

function renderPositionBar() {
  const bar = $('#tp-bar');
  if (!positionActive()) { bar.hidden = true; if (tp.index >= 0 && state && !state.loaded) tp.index = -1; return; }
  const p = tpCurrent();
  const list = tp.suites[tp.suite].positions;
  const white = p.fen.split(' ')[1] === 'w';
  const parts = [
    el('span', { className: 'tp-bar-id', textContent: p.id }),
    el('span', { className: 'tp-bar-n', textContent: `${tp.index + 1} / ${list.length}` }),
    el('span', { className: `tp-side ${white ? 'w' : 'b'}`, textContent: white ? 'White to move' : 'Black to move' }),
  ];
  // The solution, and what the analysis thinks.
  const want = p.bm.length ? p.bm : p.am;
  if (want.length) {
    const sol = el('span', { className: 'tp-solution' });
    if (tp.reveal) {
      sol.append(el('span', { className: 'tp-label', textContent: p.bm.length ? 'Best' : 'Avoid' }), el('b', { textContent: want.join(' / ') }));
    } else {
      const show = el('button', { type: 'button', className: 'small', textContent: 'Show solution' });
      show.onclick = () => { tp.reveal = true; renderPositionBar(); };
      sol.append(show);
    }
    parts.push(sol);
    const found = analysisVerdict(p);
    if (found) parts.push(found);
  }
  const prev = el('button', { type: 'button', className: 'small', textContent: '◀', title: 'Previous position' });
  prev.disabled = tp.index === 0;
  prev.onclick = () => loadPosition(tp.suite, tp.index - 1);
  const next = el('button', { type: 'button', className: 'small', textContent: '▶', title: 'Next position' });
  next.disabled = tp.index >= list.length - 1;
  next.onclick = () => loadPosition(tp.suite, tp.index + 1);
  // Test the engine on this position (with the dialog's time and engine).
  const r = tpResults(tp.suite).get(tp.index);
  const testing = tp.run && tp.run.suite === tp.suite && tp.run.single === tp.index;
  if (testing) parts.push(el('span', { className: 'tp-verdict no', textContent: `Testing ${tp.run.engine} for ${fmtMs(tp.run.timeMs)}…` }));
  else if (r && tp.reveal) parts.push(resultBadge(r, p));
  else if (r) parts.push(el('span', { className: 'tp-result ' + (r.error ? 'err' : r.solved ? 'ok' : 'no'), textContent: r.error ? 'Test failed' : r.solved ? `✓ Test: solved in ${fmtMs(r.foundMs)}` : '✗ Test: not solved' }));
  const test = el('button', { type: 'button', className: 'small', textContent: 'Test engine', title: `Run ${engines.find((e) => e.id === ($('#tp-engine').value || localStorage.getItem('tpEngine') || analysisSettings().engineId))?.name ?? 'the engine'} on this position for ${fmtMs(testSettings().time)} (set in Positions…)` });
  test.disabled = Boolean(tp.run);
  test.onclick = () => { fillTestEngines(); runEngineTest(tp.suite, [tp.index]); };
  const all = el('button', { type: 'button', className: 'small', textContent: 'All…', title: 'Choose another position' });
  all.onclick = openPositions;
  parts.push(el('span', { className: 'tp-bar-nav' }, [test, prev, next, all]));
  bar.replaceChildren(...parts);
  bar.hidden = false;
}

// Whether the analysis of the starting position plays the solution.
function analysisVerdict(p) {
  const data = analysis.data;
  if (!analysis.on || !data || data.fen?.split(' ').slice(0, 4).join(' ') !== p.fen.split(' ').slice(0, 4).join(' ')) return null;
  const top = data.lines?.[0];
  const move = top?.san?.[0];
  if (!move) return null;
  const ok = p.bm.length ? p.bm.some((m) => sanKey(m) === sanKey(move)) : !p.am.some((m) => sanKey(m) === sanKey(move));
  const depth = top.depth ? ` at depth ${top.depth}` : '';
  if (!tp.reveal) {
    return el('span', { className: 'tp-verdict ' + (ok ? 'ok' : 'no'), textContent: ok ? `Engine found it${depth}` : `Engine not there yet${depth}` });
  }
  return el('span', { className: 'tp-verdict ' + (ok ? 'ok' : 'no'), textContent: ok ? `✓ engine plays ${move}${depth}` : `✗ engine plays ${move}${depth}` });
}

// ---------------------------------------------------------------------------
// Testing an engine: every position (or one) for a set time each.
// ---------------------------------------------------------------------------
function resultBadge(r, p) {
  if (r.error) return el('span', { className: 'tp-result err', textContent: '– ' + r.error, title: r.error });
  const depth = r.depth ? ` · d${r.depth}` : '';
  if (r.solved) {
    return el('span', { className: 'tp-result ok', title: `Played ${r.move}; settled on it after ${r.foundMs} ms${depth}` },
      [el('b', { textContent: '✓ ' + r.move }), ` ${fmtMs(r.foundMs)}${depth}`]);
  }
  const want = p?.bm?.length ? `wanted ${p.bm.join(' / ')}` : p?.am?.length ? `should avoid ${p.am.join(' / ')}` : '';
  return el('span', { className: 'tp-result no', title: `Played ${r.move}${want ? '; ' + want : ''}${depth}` },
    [el('b', { textContent: '✗ ' + (r.move || '?') }), depth]);
}
const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function fillTestEngines() {
  const sel = $('#tp-engine');
  const current = sel.value || localStorage.getItem('tpEngine') || analysisSettings().engineId;
  sel.replaceChildren(...engines.map((e) => el('option', { value: e.id, textContent: e.name })));
  if (engines.some((e) => e.id === current)) sel.value = current;
}

function testSettings() {
  const time = Math.max(50, Math.min(600000, Math.round(+$('#tp-time').value || 1000)));
  const conc = Math.max(1, Math.min(32, Math.round(+$('#tp-conc').value || 1)));
  return { time, conc };
}

function loadTestSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('tpTest') ?? '{}');
    if (s.time) $('#tp-time').value = s.time;
    if (s.conc) $('#tp-conc').value = s.conc;
  } catch { /* defaults */ }
}
loadTestSettings();
for (const id of ['#tp-time', '#tp-conc']) {
  $(id).addEventListener('change', () => {
    const { time, conc } = testSettings();
    $('#tp-time').value = time;
    $('#tp-conc').value = conc;
    try { localStorage.setItem('tpTest', JSON.stringify({ time, conc })); } catch { /* ignore */ }
  });
}
$('#tp-engine').addEventListener('change', (e) => { try { localStorage.setItem('tpEngine', e.target.value); } catch { /* ignore */ } });

// Runs the engine on positions (indexes into the suite); [] means all.
async function runEngineTest(suite, indexes) {
  const engine = engines.find((e) => e.id === $('#tp-engine').value) ?? engines.find((e) => e.id === analysisSettings().engineId) ?? engines[0];
  if (!engine) return;
  const list = tp.suites[suite].positions;
  const pick = indexes.length ? indexes : list.map((_, i) => i);
  const { time, conc } = testSettings();
  const key = `t${Date.now()}`;
  const results = tpResults(suite);
  for (const i of pick) results.delete(i);
  tp.run = { key, suite, pick, engine: engine.name, total: pick.length, done: 0, solved: 0, started: Date.now(), timeMs: time, conc, single: pick.length === 1 ? pick[0] : null };
  try {
    await api.backend('epdTestStart', {
      key, moveTimeMs: time, concurrency: conc,
      engine: { name: engine.name, path: engine.path, args: engine.args ?? [], options: engine.options ?? {} },
      positions: pick.map((i) => ({ index: i, id: list[i].id, fen: list[i].fen, bm: list[i].bm, am: list[i].am })),
    });
    $('#tp-error').hidden = true;
  } catch (err) {
    tp.run = null;
    $('#tp-error').textContent = errorText(err);
    $('#tp-error').hidden = false;
  }
  renderTestProgress();
  if (dlgPositions.open) renderPositionList();
  renderPositionBar();
}

function epdTestEvent(ev) {
  const run = tp.run;
  if (!run || ev.key !== run.key) return;
  if (ev.result) tpResults(run.suite).set(ev.result.index, ev.result);
  run.done = ev.done;
  run.solved = ev.solved;
  if (ev.state !== 'running') {
    tp.last = { ...run, state: ev.state, error: ev.error, finished: Date.now() };
    tp.run = null;
    if (ev.state === 'error') { $('#tp-error').textContent = ev.error; $('#tp-error').hidden = false; }
    // A run of several positions ends on its results.
    if (run.total > 1 && run.done > 0) openTestResults();
  }
  renderTestProgress();
  if (dlgPositions.open && run.suite === tp.suite) renderPositionList();
  renderPositionBar();
}

function renderTestProgress() {
  const run = tp.run;
  const shown = run ?? tp.last;
  const running = Boolean(run);
  $('#tp-run-all').hidden = running;
  $('#tp-run-one').hidden = running;
  $('#tp-run-stop').hidden = !running;
  $('#tp-run-all').textContent = `Test all ${tp.suites[tp.suite]?.positions.length ?? ''}`;
  const box = $('#tp-progress');
  box.hidden = !shown || shown.suite !== tp.suite;
  // The Positions button says how a long run is going.
  $('#btn-positions').textContent = running && run.total > 1 ? `Positions… ${run.done}/${run.total}` : 'Positions…';
  if (box.hidden) return;
  const pct = shown.total ? (shown.done / shown.total) * 100 : 0;
  $('#tp-progress-fill').style.width = `${pct}%`;
  const rate = shown.done ? `${Math.round((shown.solved / shown.done) * 100)}%` : '';
  let text = `${shown.engine}: solved ${shown.solved} of ${shown.done}${shown.done < shown.total ? ` (${shown.done}/${shown.total} done)` : ''}${rate ? ` · ${rate}` : ''} · ${fmtMs(shown.timeMs)} each`;
  if (running && shown.done < shown.total) {
    const left = Math.ceil(((shown.total - shown.done) * shown.timeMs) / shown.conc / 1000);
    text += ` · about ${left >= 90 ? `${Math.round(left / 60)} min` : `${left} s`} left`;
  } else if (!running && shown.state === 'stopped') text += ' · stopped';
  else if (!running && shown.state === 'error') text += ' · stopped by an error';
  $('#tp-progress-text').textContent = text;
  const missed = shown.done - shown.solved;
  const review = $('#tp-review');
  review.hidden = running || !missed || tp.suites[shown.suite]?.review;
  review.textContent = `Review missed (${missed})`;
  $('#tp-results').hidden = running || shown.total < 2 || !shown.done;
}

// The positions the engine missed, as a set of their own to go through:
// ◀ ▶ step through only those, and each shows the solution and the
// engine's line in the moves list.
// Returns the set's number, and where each missed position is in it.
function missedSuite() {
  const from = tp.last?.suite ?? tp.suite;
  const src = tp.suites[from];
  const results = tpResults(from);
  const missed = src.positions.map((p, i) => ({ p, i, r: results.get(i) })).filter(({ r }) => r && !r.solved && !r.error);
  if (!missed.length) return null;
  const run = tp.last;
  const name = `Missed: ${src.name.replace(/^Missed: /, '')}${run ? ` · ${run.engine} · ${fmtMs(run.timeMs)}` : ''}`;
  const suite = { name, review: true, engine: run?.engine, positions: missed.map(({ p }) => p) };
  const existing = tp.suites.findIndex((s) => s.name === name);
  const at = existing >= 0 ? existing : tp.suites.length;
  tp.suites[at] = suite;
  const map = new Map();
  missed.forEach(({ r }, k) => map.set(k, { ...r, index: k }));
  tp.results.set(at, map);
  return { at, where: new Map(missed.map(({ i }, k) => [i, k])) };
}
function reviewMissed() {
  const set = missedSuite();
  if (set) loadPosition(set.at, 0);
}

// ---------------------------------------------------------------------------
// The results of a run: its figures, and each position it missed, with what
// was wanted and what the engine played, to put on the board.
// ---------------------------------------------------------------------------
const dlgTestResults = $('#dlg-test-results');

// The engine's score, from White's side like the analysis.
function tpScore(r, p) {
  const sign = p.fen.split(' ')[1] === 'b' ? -1 : 1;
  if (r.mate) return `#${sign * r.mate}`;
  const cp = sign * r.cp;
  return `${cp > 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
}
const fmtCount = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)));

function testRunStats(run) {
  const results = tpResults(run.suite);
  const rows = (run.pick ?? []).map((i) => ({ i, p: tp.suites[run.suite].positions[i], r: results.get(i) })).filter(({ p, r }) => p && r);
  const solved = rows.filter(({ r }) => r.solved);
  const errors = rows.filter(({ r }) => r.error);
  const missed = rows.filter(({ r }) => !r.solved && !r.error);
  const searched = rows.filter(({ r }) => !r.error);
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const times = solved.map(({ r }) => r.foundMs).filter((t) => t >= 0).sort((a, b) => a - b);
  const nodes = searched.reduce((a, { r }) => a + (r.nodes ?? 0), 0);
  return {
    rows, solved, errors, missed,
    avgSolve: avg(times),
    medianSolve: times.length ? times[Math.floor((times.length - 1) / 2)] : 0,
    slowest: times.length ? times[times.length - 1] : 0,
    avgDepth: avg(searched.map(({ r }) => r.depth).filter(Boolean)),
    avgDepthMissed: avg(missed.map(({ r }) => r.depth).filter(Boolean)),
    nodes,
    nps: searched.length ? nodes / ((searched.length * run.timeMs) / 1000) : 0,
    took: (run.finished ?? Date.now()) - run.started,
  };
}

function openTestResults() {
  const run = tp.last;
  if (!run || !tp.suites[run.suite]) return;
  const st = testRunStats(run);
  const suite = tp.suites[run.suite];
  const ended = run.state === 'stopped' ? ` Stopped after ${run.done} of ${run.total}.` : run.state === 'error' ? ` Stopped by an error after ${run.done} of ${run.total}.` : '';
  $('#tr-what').textContent = `${run.engine} on ${suite.name}: ${fmtMs(run.timeMs)} a position${run.conc > 1 ? `, ${run.conc} at once` : ''}.${ended}`;
  const tile = (label, value, note = '', cls = '') => el('div', { className: 'tr-stat ' + cls }, [
    el('span', { className: 'tr-stat-label', textContent: label }),
    el('b', { textContent: value }),
    el('span', { className: 'tr-stat-note', textContent: note }),
  ]);
  const done = st.rows.length;
  const took = st.took >= 90000 ? `${Math.round(st.took / 60000)} min` : st.took >= 10000 ? `${Math.round(st.took / 1000)} s` : `${(st.took / 1000).toFixed(1)} s`;
  $('#tr-stats').replaceChildren(
    tile('Solved', `${st.solved.length} / ${done}`, done ? `${((st.solved.length / done) * 100).toFixed(1)}%` : '', 'ok'),
    tile('Missed', String(st.missed.length), st.errors.length ? `${st.errors.length} with an error` : done ? `${((st.missed.length / done) * 100).toFixed(1)}%` : '', st.missed.length ? 'no' : ''),
    tile('Time to solve', st.solved.length ? fmtMs(Math.round(st.avgSolve)) : '–', st.solved.length ? `median ${fmtMs(st.medianSolve)} · slowest ${fmtMs(st.slowest)}` : ''),
    tile('Depth', st.avgDepth ? st.avgDepth.toFixed(1) : '–', st.missed.length && st.avgDepthMissed ? `${st.avgDepthMissed.toFixed(1)} on the missed` : 'average reached'),
    tile('Speed', st.nps ? `${fmtCount(st.nps)}/s` : '–', st.nodes ? `${fmtCount(st.nodes)} nodes` : ''),
    tile('Run time', took, `${done} position${done === 1 ? '' : 's'}`),
  );
  const failed = [...st.missed, ...st.errors];
  $('#tr-missed-title').textContent = failed.length ? `Not solved (${failed.length})` : 'Every position solved';
  $('#tr-missed-hint').textContent = failed.length ? 'Put one on the board to go through it: the solution and the engine\'s line are added to the moves.' : '';
  const set = st.missed.length ? missedSuite() : null;
  $('#tr-list').hidden = !failed.length;
  $('#tr-list').replaceChildren(...failed.map(({ i, p, r }) => {
    const white = p.fen.split(' ')[1] === 'w';
    const task = p.bm.length ? `Find the best move: ${p.bm.join(' or ')}` : p.am.length ? `Avoid ${p.am.join(' and ')}` : 'No solution given';
    const lines = [
      el('div', { className: 'tr-row-head' }, [
        el('span', { className: 'tp-id', textContent: p.id }),
        el('span', { className: `tp-side ${white ? 'w' : 'b'}`, textContent: white ? 'White to move' : 'Black to move' }),
      ]),
      el('div', { className: 'tr-task', textContent: task }),
    ];
    if (p.comment) lines.push(el('div', { className: 'hint', textContent: p.comment }));
    if (r.error) lines.push(el('div', { className: 'tr-played err', textContent: `The engine failed: ${r.error}` }));
    else {
      lines.push(el('div', { className: 'tr-played' }, [
        'Played ', el('b', { textContent: r.move || '?' }),
        el('span', { className: 'tr-fig', textContent: `${r.depth ? ` · depth ${r.depth}` : ''} · ${tpScore(r, p)}${r.nodes ? ` · ${fmtCount(r.nodes)} nodes` : ''}` }),
      ]));
      if (r.pv?.length > 1) lines.push(el('div', { className: 'tr-pv', textContent: r.pv.join(' ') }));
    }
    const load = el('button', { type: 'button', className: 'small', textContent: 'Load on board', title: 'Put this position on the board, with the solution and the engine\'s line' });
    load.onclick = () => {
      dlgTestResults.close();
      const k = set?.where.get(i);
      if (k != null) loadPosition(set.at, k); else loadPosition(run.suite, i);
    };
    const mini = miniBoard(p.fen, !white);
    return el('div', { className: 'tr-row' }, [mini, el('div', { className: 'tr-row-text' }, lines), load]);
  }));
  $('#tr-review').hidden = !st.missed.length;
  $('#tr-review').textContent = `Review all missed (${st.missed.length})`;
  if (!dlgTestResults.open) dlgTestResults.showModal();
}
$('#tr-review').onclick = () => { dlgTestResults.close(); reviewMissed(); };
$('#tp-results').onclick = openTestResults;
window.openTestResults = openTestResults;

$('#tp-review').onclick = reviewMissed;
$('#tp-run-all').onclick = () => runEngineTest(tp.suite, []);
$('#tp-run-one').onclick = () => runEngineTest(tp.suite, [tp.selected]);
$('#tp-run-stop').onclick = () => api.backend('epdTestStop');
for (const r of document.querySelectorAll('input[name="tp-show"]')) {
  r.onchange = () => { tp.show = r.value; renderPositionList(); };
}

$('#btn-positions').onclick = openPositions;
