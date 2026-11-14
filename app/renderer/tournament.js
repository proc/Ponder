'use strict';
// Tournament: many games between engines. Two play a match, with Elo and an
// SPRT; more play a round robin, a gauntlet, a knockout or a Swiss. The Go
// backend plays them; this file draws the Tournament tab (the results of the
// formats for several engines are in tournament-table.js).
// Loaded after renderer.js, whose helpers ($, el, api, state, …) it uses.

const tn = {
  status: { state: 'idle' },
  pgnPath: '', // chosen by the user; '' for a new file per tournament
  openingsPath: '',
  entrants: [], // engine ids, for the formats with several engines, in order
};

function tournamentRunning() {
  return tn.status.state === 'running' || tn.status.state === 'stopping';
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const TN_FIELDS = ['tn-tckind', 'tn-base', 'tn-inc', 'tn-movetime', 'tn-nodes', 'tn-games', 'tn-concurrency', 'tn-openings',
  'tn-random', 'tn-plies', 'tn-sprt', 'tn-elo0', 'tn-elo1', 'tn-alpha', 'tn-beta', 'tn-adj-draw', 'tn-draw-from', 'tn-draw-moves',
  'tn-draw-score', 'tn-adj-resign', 'tn-resign-moves', 'tn-resign-score', 'tn-maxmoves', 'tn-save', 'tn-e1', 'tn-e2',
  'tn-format', 'tn-pairgames', 'tn-rounds'];

function saveTournamentForm() {
  const saved = { pgnPath: tn.pgnPath, openingsPath: tn.openingsPath, entrants: tn.entrants };
  for (const id of TN_FIELDS) {
    const input = $('#' + id);
    saved[id] = input.type === 'checkbox' ? input.checked : input.value;
  }
  try { localStorage.setItem('tournament', JSON.stringify(saved)); } catch { /* ignore */ }
}

function loadTournamentForm() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('tournament') ?? '{}') ?? {}; } catch { /* ignore */ }
  for (const id of TN_FIELDS) {
    if (!(id in saved)) continue;
    const input = $('#' + id);
    if (input.type === 'checkbox') input.checked = Boolean(saved[id]);
    else if (input.tagName !== 'SELECT' || [...input.options].some((o) => o.value === saved[id])) input.value = saved[id];
  }
  tn.pgnPath = saved.pgnPath ?? '';
  tn.openingsPath = saved.openingsPath ?? '';
  tn.entrants = Array.isArray(saved.entrants) ? saved.entrants.filter((id) => engines.some((e) => e.id === id)) : [];
  // To begin with: every engine there is, and at least three seats.
  if (!Array.isArray(saved.entrants)) tn.entrants = engines.slice(0, 8).map((e) => e.id);
  while (engines.length && tn.entrants.length < 3) tn.entrants.push(engines[tn.entrants.length % engines.length].id);
}

const TN_MAX_ENGINES = 32;
const TN_NOTES = {
  match: 'Many games between two engines, in pairs from the same opening with colours reversed, several at a time. The SPRT stops as soon as it can tell whether the first engine is stronger by the Elo you set.',
  roundrobin: 'Every engine plays a match against every other. The most points wins; ties are split by Sonneborn–Berger.',
  gauntlet: 'The first engine plays a match against each of the others, which do not meet each other.',
  knockout: 'The engines are seeded in the order listed, the best first. The loser of each match is out; a level match plays on, two games at a time, and after three such pairs the higher seed goes through.',
  swiss: 'In each round the engines are paired with others on the same points that they have not met. With an odd number, one sits the round out for half its points.',
};

// The engines of a tournament of several: a row each, in seeding order.
function renderEntrants() {
  const box = $('#tn-entrants');
  box.replaceChildren(...tn.entrants.map((id, i) => {
    const select = el('select', { ariaLabel: `Engine ${i + 1}` }, engines.map((e) => el('option', { value: e.id, textContent: e.name })));
    select.value = id;
    select.onchange = () => { tn.entrants[i] = select.value; };
    const remove = el('button', { type: 'button', className: 'small tn-remove', textContent: '✕', title: 'Take this engine out', ariaLabel: `Take engine ${i + 1} out`, disabled: tn.entrants.length <= 2 });
    remove.onclick = () => { tn.entrants.splice(i, 1); renderEntrants(); syncTournamentForm(); saveTournamentForm(); };
    const up = el('button', { type: 'button', className: 'small tn-remove', textContent: '↑', title: 'Move up', ariaLabel: `Move engine ${i + 1} up`, disabled: i === 0 });
    up.onclick = () => { [tn.entrants[i - 1], tn.entrants[i]] = [tn.entrants[i], tn.entrants[i - 1]]; renderEntrants(); saveTournamentForm(); };
    return el('div', { className: 'tn-entrant' }, [el('span', { className: 'tn-seed', textContent: String(i + 1) }), select, up, remove]);
  }));
  $('#tn-add-engine').disabled = !engines.length || tn.entrants.length >= TN_MAX_ENGINES;
}
$('#tn-add-engine').onclick = () => {
  if (!engines.length) return;
  // The first engine not in yet, else the first again.
  const next = engines.find((e) => !tn.entrants.includes(e.id)) ?? engines[0];
  tn.entrants.push(next.id);
  renderEntrants();
  syncTournamentForm();
  saveTournamentForm();
};

// How many games the format will play.
function plannedTournamentGames() {
  const n = tn.entrants.length;
  const per = Math.max(2, Math.round(Number($('#tn-pairgames').value) || 2));
  const g = per + (per % 2);
  const rounds = Math.round(Number($('#tn-rounds').value)) || Math.ceil(Math.log2(Math.max(2, n)));
  switch ($('#tn-format').value) {
    case 'roundrobin': return { games: (n * (n - 1)) / 2 * g, text: `${(n * (n - 1)) / 2} matches` };
    case 'gauntlet': return { games: (n - 1) * g, text: `${n - 1} matches` };
    case 'knockout': return { games: (n - 1) * g, text: `${n - 1} matches, more if any is level`, atLeast: true };
    case 'swiss': return { games: rounds * Math.floor(n / 2) * g, text: `${rounds} rounds` };
    default: return { games: 0, text: '' };
  }
}

function fillTournamentEngines() {
  for (const [id, fallback] of [['#tn-e1', 0], ['#tn-e2', 1]]) {
    const select = $(id);
    const before = select.value;
    select.replaceChildren(...engines.map((e) => el('option', { value: e.id, textContent: e.name })));
    if (engines.some((e) => e.id === before)) select.value = before;
    else if (engines[fallback]) select.value = engines[fallback].id;
  }
}

// The engines have changed (one added, renamed or removed in Settings): the
// lists here follow, keeping what was chosen where it is still there.
function refreshTournamentEngines() {
  if (!tn.ready) return; // not set up yet: initTournament fills the lists
  fillTournamentEngines();
  const before = tn.entrants.length;
  tn.entrants = tn.entrants.filter((id) => engines.some((e) => e.id === id));
  renderEntrants();
  syncTournamentForm();
  if (tn.entrants.length !== before) saveTournamentForm();
}

function syncTournamentForm() {
  const format = $('#tn-format').value;
  const multi = format !== 'match';
  for (const node of document.querySelectorAll('#tn-setup .tn-only-match')) node.hidden = multi;
  for (const node of document.querySelectorAll('#tn-setup .tn-only-multi')) node.hidden = !multi;
  for (const node of document.querySelectorAll('#tn-setup .tn-only-swiss')) node.hidden = format !== 'swiss';
  $('#tn-format-note').textContent = TN_NOTES[format] ?? '';
  if (multi) {
    const plan = plannedTournamentGames();
    $('#tn-plan').textContent = `two games from each opening, colours reversed · ${plan.atLeast ? 'at least ' : ''}${plan.games} games in all (${plan.text})`;
    $('#tn-entrants-note').textContent = format === 'knockout' ? 'in seeding order, the best first' : format === 'gauntlet' ? 'the first plays all the others' : '';
  }
  const kind = $('#tn-tckind').value;
  $('#tn-tc-clock').hidden = kind !== 'clock';
  $('#tn-tc-movetime').hidden = kind !== 'movetime';
  $('#tn-tc-nodes').hidden = kind !== 'nodes';
  const file = $('#tn-openings').value === 'file';
  $('#tn-openings-file').hidden = !file;
  $('#tn-openings-file').textContent = tn.openingsPath ? tn.openingsPath.split(/[\\/]/).pop() : 'no file chosen';
  $('#tn-openings-file').title = tn.openingsPath;
  $('#tn-random').disabled = $('#tn-openings').value === 'start';
  $('#tn-plies').disabled = $('#tn-openings').value === 'start';
  for (const input of document.querySelectorAll('.tn-sprt input[type=number]')) input.disabled = !$('#tn-sprt').checked;
  for (const id of ['tn-draw-from', 'tn-draw-moves', 'tn-draw-score']) $('#' + id).disabled = !$('#tn-adj-draw').checked;
  for (const id of ['tn-resign-moves', 'tn-resign-score']) $('#' + id).disabled = !$('#tn-adj-resign').checked;
  $('#tn-pgn').textContent = !$('#tn-save').checked ? 'not saved' : tn.pgnPath || 'a new file in your Tournaments folder';
  $('#tn-pgn').title = tn.pgnPath;
  $('#tn-pgn-choose').disabled = !$('#tn-save').checked;
}

$('#tn-setup').addEventListener('change', (e) => {
  if (e.target.id === 'tn-openings' && e.target.value === 'file' && !tn.openingsPath) chooseOpeningsFile();
  syncTournamentForm();
  saveTournamentForm();
});
$('#tn-openings-file').onclick = () => chooseOpeningsFile();

async function chooseOpeningsFile() {
  const file = await api.tournament.chooseOpenings();
  if (file) tn.openingsPath = file;
  else if (!tn.openingsPath) $('#tn-openings').value = 'book';
  syncTournamentForm();
  saveTournamentForm();
}

$('#tn-pgn-choose').onclick = async () => {
  const file = await api.tournament.choosePgn(tn.pgnPath);
  if (file) tn.pgnPath = file;
  syncTournamentForm();
  saveTournamentForm();
};

function tnError(text) {
  $('#tn-error').textContent = text ?? '';
  $('#tn-error').hidden = !text;
}

$('#tn-setup').onsubmit = async (e) => {
  e.preventDefault();
  tnError('');
  const spec = (id) => {
    const engine = engines.find((x) => x.id === $(id).value);
    return engine && { name: engine.name, path: engine.path, args: engine.args ?? [], options: engine.options ?? {} };
  };
  const format = $('#tn-format').value;
  const multi = format !== 'match';
  const byId = (id) => {
    const engine = engines.find((x) => x.id === id);
    return engine && { name: engine.name, path: engine.path, args: engine.args ?? [], options: engine.options ?? {} };
  };
  const a = spec('#tn-e1');
  const b = spec('#tn-e2');
  if (!multi && (!a || !b)) return tnError('Choose both engines (add engines in Settings → Engines).');
  const field = multi ? tn.entrants.map(byId) : [a, b];
  if (field.some((e) => !e)) return tnError('One of the engines is no longer there: choose another (Settings → Engines).');
  if (multi && field.length < 2) return tnError('Add at least two engines.');
  const num = (id) => Number($('#' + id).value) || 0;
  const kind = $('#tn-tckind').value;
  const timeControl = kind === 'clock'
    ? { baseMs: Math.round(num('tn-base') * 1000), incMs: Math.round(num('tn-inc') * 1000) }
    : kind === 'movetime' ? { moveTimeMs: Math.round(num('tn-movetime') * 1000) } : { nodes: Math.round(num('tn-nodes')) };
  let games = Math.max(0, Math.round(num('tn-games')));
  if (games % 2) games++;
  const source = $('#tn-openings').value;
  if (source === 'file' && !tn.openingsPath) return tnError('Choose an openings file.');
  let pgnPath = '';
  if ($('#tn-save').checked) {
    pgnPath = tn.pgnPath || (multi
      ? await api.tournament.defaultPgn(`${TN_FORMATS[format]}, ${field.length} engines`, '')
      : await api.tournament.defaultPgn(a.name, b.name));
  }
  const cfg = {
    engines: field, format, timeControl, games,
    pairGames: Math.max(2, Math.round(num('tn-pairgames'))), rounds: Math.max(0, Math.round(num('tn-rounds'))),
    concurrency: Math.max(1, Math.round(num('tn-concurrency'))),
    openings: { source, path: tn.openingsPath, order: $('#tn-random').checked ? 'random' : 'sequential', plies: num('tn-plies') },
    sprt: { enabled: !multi && $('#tn-sprt').checked, elo0: num('tn-elo0'), elo1: num('tn-elo1'), alpha: num('tn-alpha'), beta: num('tn-beta') },
    adjudication: {
      draw: $('#tn-adj-draw').checked, drawMoveNumber: num('tn-draw-from'), drawMoves: num('tn-draw-moves'), drawScore: num('tn-draw-score'),
      resign: $('#tn-adj-resign').checked, resignMoves: num('tn-resign-moves'), resignScore: num('tn-resign-score'),
      maxMoves: num('tn-maxmoves'),
    },
    pgnPath,
  };
  if (state?.active && !(await confirmDialog('Start the tournament? The game you are playing here will be abandoned so the engines get the whole computer.', 'Start tournament'))) return;
  saveTournamentForm();
  $('#tn-start').disabled = true;
  try {
    if (state?.active) await api.backend('abort').catch(() => {});
    await api.backend('tournamentStart', cfg);
  } catch (err) {
    tnError(errorText(err));
  } finally {
    $('#tn-start').disabled = false;
  }
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
$('#tn-pause').onclick = async () => {
  const btn = $('#tn-pause');
  btn.disabled = true;
  try { await api.backend(tn.status.paused ? 'tournamentResume' : 'tournamentPause'); } catch (err) { tnError(errorText(err)); }
  btn.disabled = false;
};
$('#tn-stop').onclick = async () => {
  if (await confirmDialog('Stop the tournament? Games in progress are not counted.', 'Stop')) api.backend('tournamentStop');
};
$('#tn-report').onclick = async () => {
  const btn = $('#tn-report');
  btn.disabled = true;
  try {
    tn.report = await api.tournament.report(document.documentElement.dataset.theme);
    renderReportLine();
  } catch (err) {
    setStatus(`Could not make the report: ${errorText(err)}`);
  } finally {
    btn.disabled = !(tn.status.games > 0);
  }
};

function renderReportLine() {
  const line = $('#tn-report-line');
  line.hidden = !tn.report;
  if (!tn.report) return;
  const open = el('a', { href: '#', textContent: 'Open report' });
  open.onclick = (e) => { e.preventDefault(); api.tournament.openReport(tn.report).catch((err) => setStatus(errorText(err))); };
  const folder = el('a', { href: '#', textContent: 'Show in folder' });
  folder.onclick = (e) => { e.preventDefault(); api.tournament.showFile(tn.report); };
  const saveAs = el('a', { href: '#', textContent: 'Save as…' });
  saveAs.onclick = async (e) => {
    e.preventDefault();
    try {
      const out = await api.tournament.saveReport(tn.report);
      if (out) setStatus(`Report saved to ${out}`);
    } catch (err) {
      setStatus(`Could not save the report: ${errorText(err)}`);
    }
  };
  line.replaceChildren(document.createTextNode(`Report saved: ${tn.report.split(/[\\/]/).pop()} · `), open, ' · ', saveAs, ' · ', folder);
}

$('#tn-new').onclick = () => {
  tn.report = null;
  tn.status = { state: 'idle' };
  renderTournament();
};
$('#tn-watch').onchange = async (e) => {
  const on = e.target.checked;
  if (on && state?.active && !state.external) {
    if (!(await confirmDialog('Show the tournament on the board? The game you are playing here will be abandoned.', 'Show tournament'))) {
      e.target.checked = false;
      return;
    }
  }
  api.backend('tournamentWatch', { on }).catch((err) => setStatus(errorText(err)));
};

function tournamentStatus(s) {
  tn.status = s;
  renderTournament();
  if (typeof syncAnalysis === 'function') { syncAnalysis(); renderAnalysis(); }
}

const fmt = (x, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : '–');
const signed = (x, digits = 1) => (Number.isFinite(x) ? (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(digits) : '–');

function duration(seconds) {
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

// The UCI options each engine runs with: as the engine confirmed them when
// it was loaded, or as they are set to be sent before its first game.
function renderTournamentOptions(s) {
  const list = s.engineOptions ?? [];
  $('#tn-options-card').hidden = !list.length;
  if (!list.length) return;
  const waiting = list.some((e) => !e.confirmed);
  $('#tn-options-note').textContent = waiting ? 'Sent to each engine as it is loaded' : 'As each engine confirmed when it was loaded';
  $('#tn-options').replaceChildren(...list.map((e, i) => el('div', { className: 'tn-opt-row' }, [
    el('span', { className: 'tn-opt-name', title: e.name }, [s.format !== 'match' ? tnSwatch(i) : '', el('span', { textContent: e.name })].filter(Boolean)),
    el('span', { className: 'tn-opt-list' }, e.options.length
      ? e.options.map((o) => el('span', { className: 'lx-opt', title: e.confirmed ? 'Set when the engine was loaded' : 'To be set when the engine is loaded' }, [`${o.name} `, el('b', { textContent: o.value === '' ? '(empty)' : o.value })]))
      : [el('span', { className: 'hint', textContent: 'The engine’s defaults' })]),
  ])));
}

// What the engines' searches came to, per engine: average depth, selective
// depth, nodes and time a move, and speed; and the average game.
function renderTournamentSearch(s) {
  const rows = (s.search ?? []).filter((e) => e.moves > 0);
  $('#tn-search-card').hidden = !rows.length;
  if (!rows.length) return;
  const big = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
  const cell = (v, text, title = '') => el('td', { className: 'n', textContent: v > 0 ? text : '–', title: v > 0 ? title : 'The engine did not report it' });
  const cols = [['Engine', ''], ['Depth', 'Average depth of the search behind each move'], ['Sel. depth', 'Average selective depth: the deepest line looked at'],
    ['Nodes / move', 'Average positions searched for a move'], ['Speed', 'Average positions searched a second'], ['Time / move', 'Average time taken for a move'], ['Moves', 'Moves searched, book moves not counted']];
  const table = el('table', { className: 'tn-table tn-search' }, [
    el('thead', {}, [el('tr', {}, cols.map(([t, title], i) => el('th', { className: i ? 'n' : '', textContent: t, title })))]),
    el('tbody', {}, rows.map((e, i) => el('tr', {}, [
      el('td', { className: 'who' }, [typeof tnSwatch === 'function' && s.format !== 'match' ? tnSwatch(s.search.indexOf(e)) : '', el('span', { textContent: e.name, title: e.name })].filter(Boolean)),
      cell(e.depth, e.depth.toFixed(1)),
      cell(e.selDepth, e.selDepth.toFixed(1)),
      cell(e.nodes, big(e.nodes), `${Math.round(e.nodes).toLocaleString()} nodes`),
      cell(e.nps, `${big(e.nps)} n/s`, `${Math.round(e.nps).toLocaleString()} nodes a second`),
      cell(e.timeMs, e.timeMs >= 1000 ? `${(e.timeMs / 1000).toFixed(2)} s` : `${Math.round(e.timeMs)} ms`),
      el('td', { className: 'n', textContent: e.moves.toLocaleString() }),
    ]))),
  ]);
  $('#tn-search').replaceChildren(table);
  const moves = s.avgPlies ? `${Math.round(s.avgPlies / 2)} moves` : '';
  const secs = s.avgGameMs / 1000;
  const time = secs ? (secs >= 90 ? `${(secs / 60).toFixed(1)} min` : `${secs.toFixed(1)} s`) : '';
  $('#tn-search-note').textContent = moves ? `Average game: ${moves}${time ? `, ${time} of thinking` : ''}` : '';
}

function renderTournament() {
  const s = tn.status;
  const active = s.state !== 'idle';
  $('#tn-setup').hidden = active;
  $('#tn-run').hidden = !active;
  const running = tournamentRunning();
  $('#tournament-count').textContent = running ? String(s.games ?? 0) : '';
  $('#tab-tournament').classList.toggle('live', running);
  if (!active) return;

  const multi = Boolean(s.format) && s.format !== 'match';
  $('#tn-title').textContent = multi ? `${TN_FORMATS[s.format]} · ${s.players.length} engines` : `${s.names[0]} vs ${s.names[1]}`;
  $('#tn-title').title = $('#tn-title').textContent;
  // How it stands, in a word, then the conditions.
  // Paused: the games being played are finished first, then it waits.
  const pausing = s.paused && s.live.length > 0;
  const stateText = s.paused ? (pausing ? 'Pausing…' : 'Paused') : s.state === 'running' ? 'Running' : s.state === 'stopping' ? 'Stopping…'
    : s.verdict ? `${s.verdict} accepted` : s.message === 'Stopped' ? 'Stopped' : s.state === 'error' ? 'Failed' : 'Finished';
  $('#tn-state').textContent = stateText;
  $('#tn-state').className = 'tn-state' + (s.paused ? ' paused' : running ? ' live' : s.verdict ? ' ' + s.verdict.toLowerCase() : '');
  $('#tn-state').title = pausing ? `Finishing the ${s.live.length} game${s.live.length === 1 ? '' : 's'} being played` : s.paused ? 'No games are being played; Resume carries on' : '';
  const pause = $('#tn-pause');
  pause.hidden = s.state !== 'running';
  pause.textContent = s.paused ? 'Resume' : 'Pause';
  pause.classList.toggle('primary', Boolean(s.paused));
  pause.title = s.paused ? 'Carry on from where it was paused' : 'Finish the games being played, then wait: no new games start until you resume';
  $('#tn-subtitle').textContent = `${s.tc} · ${s.workers} game${s.workers === 1 ? '' : 's'} at once`;
  // A match has its Elo and SPRT; the other formats their table and charts.
  for (const id of ['tn-numbers-match', 'tn-penta-card']) $('#' + id).hidden = multi;
  for (const id of ['tn-numbers-multi', 'tn-multi']) $('#' + id).hidden = !multi;
  $('#tn-report').hidden = multi; // the report is a match's
  if (multi) {
    const done = s.state === 'finished';
    const first = s.players[0];
    $('#tn-m-games').textContent = s.total ? `${s.games} / ${Math.max(s.total, s.games)}` : String(s.games);
    $('#tn-m-round').textContent = s.rounds ? `${Math.max(1, s.round)} / ${s.rounds}` : '–';
    $('#tn-m-leader-k').textContent = done && s.games ? 'Winner' : 'Leader';
    $('#tn-m-leader').textContent = s.games && first ? first.name : '–';
    $('#tn-m-leader').title = s.games && first ? `${first.name}: ${tnPoints(first.points)} points` : '';
    $('#tn-m-draws').textContent = s.games ? `${fmt(s.drawRatio * 100)}%` : '–';
    renderTournamentTable(s);
  }
  $('#tn-stop').hidden = !running;
  $('#tn-stop').disabled = s.state === 'stopping';
  $('#tn-new').hidden = running;
  $('#tn-report').disabled = !(s.games > 0);
  $('#tn-report').textContent = running ? 'Report so far' : 'Report';
  $('#tn-watch').checked = s.watching;
  $('#tn-watch').disabled = !running;

  const verdict = $('#tn-verdict');
  // The outcome in words: an SPRT's verdict, or who won. (That it was
  // stopped is said beside the title.)
  // A match that simply ran its games out needs no banner: the score says it.
  const plain = s.message === 'Stopped' || (!multi && /^All \d+ games played$/.test(s.message ?? ''));
  const msg = (s.state === 'finished' || s.verdict) && !plain ? s.message : '';
  verdict.hidden = !msg;
  verdict.textContent = msg;
  verdict.className = 'tn-verdict' + (s.verdict ? ' ' + s.verdict.toLowerCase() : '');

  const st = s.stats;
  const games = s.games;
  $('#tn-games-v').textContent = s.total ? `${games} / ${s.total}` : String(games);
  let progress = s.total ? games / s.total : 0;
  if (s.sprt.enabled && s.upper > 0) {
    progress = Math.max(progress, Math.min(1, Math.abs(s.llr) / (s.llr >= 0 ? s.upper : -s.lower)));
  }
  $('#tn-progress-bar').style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
  if (!multi) {
    $('#tn-n1').textContent = s.names[0]; $('#tn-n1').title = s.names[0];
    $('#tn-n2').textContent = s.names[1]; $('#tn-n2').title = s.names[1];
    const p1 = st.Wins + st.Draws / 2;
    $('#tn-p1').textContent = tnPoints(p1);
    $('#tn-p2').textContent = tnPoints(games - p1);
    $('#tn-p1').classList.toggle('ahead', st.Wins > st.Losses);
    $('#tn-p2').classList.toggle('ahead', st.Losses > st.Wins);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const label = `${s.names[0]}: ${plural(st.Wins, 'win')}, ${plural(st.Draws, 'draw')}, ${plural(st.Losses, 'loss').replace('losss', 'losses')}`;
    $('#tn-wdl-bar').replaceChildren(tnBar([[st.Wins, 'win', plural(st.Wins, 'win')], [st.Draws, 'draw', plural(st.Draws, 'draw')], [st.Losses, 'loss', plural(st.Losses, 'loss').replace('losss', 'losses')]], label));
    $('#tn-wld').replaceChildren(
      el('span', { className: 'k win' }, [el('i'), plural(st.Wins, 'win')]),
      el('span', { className: 'k draw' }, [el('i'), plural(st.Draws, 'draw')]),
      el('span', { className: 'k loss' }, [el('i'), plural(st.Losses, 'loss').replace('losss', 'losses')]),
    );
  }
  $('#tn-score').textContent = games ? `${fmt(s.score * 100)}%` : '–';
  // A lopsided score has no sensible margin: the whole numbers are enough.
  const wide = Math.abs(s.elo) >= 1000 || s.eloMargin >= 1000;
  $('#tn-elo').textContent = games ? `${signed(s.elo, wide ? 0 : 1)} ± ${fmt(s.eloMargin, wide ? 0 : 1)}` : '–';
  $('#tn-elo').title = games ? `${signed(s.elo)} ± ${fmt(s.eloMargin)} (95%)` : '';
  $('#tn-los').textContent = games ? `${fmt(s.los * 100)}%` : '–';
  $('#tn-draws').textContent = games ? `${fmt(s.drawRatio * 100)}%` : '–';

  const box = $('#tn-llr-box');
  box.hidden = !s.sprt.enabled || multi;
  if (s.sprt.enabled) {
    $('#tn-llr-now').textContent = `LLR ${signed(s.llr, 2)}`;
    $('#tn-llr-text').textContent = `Is ${s.names[0]} stronger by ${s.sprt.elo1} Elo (H1) or only by ${s.sprt.elo0} (H0)?  α ${s.sprt.alpha} · β ${s.sprt.beta}`;
    $('#tn-llr-lo').textContent = `H0 at ${fmt(s.lower, 2).replace('-', '−')}`;
    $('#tn-llr-hi').textContent = `H1 at +${fmt(s.upper, 2)}`;
    const span = s.upper - s.lower;
    const pos = (Math.max(s.lower, Math.min(s.upper, s.llr)) - s.lower) / span;
    const zero = -s.lower / span;
    $('#tn-llr-mark').style.left = `${pos * 100}%`;
    const fill = $('#tn-llr-fill');
    fill.style.left = `${Math.min(pos, zero) * 100}%`;
    fill.style.width = `${Math.abs(pos - zero) * 100}%`;
    fill.className = 'tn-llr-fill' + (s.llr >= 0 ? ' up' : ' down');
    box.querySelector('.tn-llr-zero').style.left = `${zero * 100}%`;
  }
  // The pairs (the same opening with colours reversed), by the first
  // engine's points in them: a column each.
  const penta = st.Penta;
  const most = Math.max(1, ...penta);
  $('#tn-penta-note').textContent = `by ${s.names[0]}'s points of 2`;
  $('#tn-penta').replaceChildren(...['0', '½', '1', '1½', '2'].map((label, i) => {
    const bar = el('span', { className: 'bar' + (i < 2 ? ' loss' : i > 2 ? ' win' : ' draw') });
    bar.style.height = `${(penta[i] / most) * 100}%`;
    return el('div', { className: 'tn-pent', title: `${penta[i]} pair${penta[i] === 1 ? '' : 's'} in which ${s.names[0]} scored ${label} of 2` }, [
      el('span', { className: 'n', textContent: String(penta[i]) }), el('span', { className: 'col' }, [bar]), el('span', { className: 'tn-k', textContent: label }),
    ]);
  }));
  const rate = s.elapsed > 0 ? games / (s.elapsed / 60) : 0;
  const meta = [`${duration(s.elapsed)}`, rate ? `${fmt(rate, 1)} games/min` : ''];
  if (s.total && running && rate && !s.paused) meta.push(`about ${duration(((s.total - games) / rate) * 60)} left`);
  if (s.timeLosses[0] + s.timeLosses[1]) meta.push(`time losses ${s.timeLosses[0]} / ${s.timeLosses[1]}`);
  if (s.crashes[0] + s.crashes[1]) meta.push(`crashes ${s.crashes[0]} / ${s.crashes[1]}`);
  meta.push(`${s.openings.toLocaleString()} openings`);
  const metaBox = $('#tn-meta');
  metaBox.replaceChildren(document.createTextNode(meta.filter(Boolean).join(' · ')));
  if (s.pgnPath) {
    const open = el('a', { href: '#', textContent: 'Open games in Games list', title: s.pgnPath });
    open.onclick = (e) => { e.preventDefault(); openPgn({ name: s.pgnPath.split(/[\\/]/).pop(), path: s.pgnPath }); };
    metaBox.append(' · ', open);
  }
  if (s.message && !s.verdict && s.state === 'running') metaBox.append(el('span', { className: 'error', textContent: ' · ' + s.message }));

  renderTournamentSearch(s);
  renderTournamentOptions(s);

  // The games: who has white and black, and how it went.
  const side = (name, colour, won) => el('span', { className: `tn-pl ${colour}${won ? ' won' : ''}`, title: name }, [el('i'), el('span', { textContent: name })]);
  $('#tn-live-card').hidden = !running;
  $('#tn-live').replaceChildren(...(s.live.length ? s.live.map((g) => el('div', { className: 'tn-row' }, [
    el('span', { className: 'tn-num', textContent: String(g.number) }),
    side(g.white, 'white'), side(g.black, 'black'),
    el('span', { className: 'tn-plies', textContent: `move ${Math.floor(g.plies / 2) + 1}` }),
    (() => { const o = el('span', { className: 'tn-opening', textContent: g.opening ?? '' }); o.dataset.opening = g.opening ?? ''; return o; })(),
  ])) : [el('p', { className: 'hint', textContent: 'Starting…' })]));

  const badge = { '1-0': ['1–0', 'white'], '0-1': ['0–1', 'black'], '1/2-1/2': ['½–½', 'draw'] };
  $('#tn-recent').replaceChildren(...(s.recent.length ? s.recent.map((g) => {
    const [text, cls] = badge[g.result] ?? [g.result, 'open'];
    const row = el('button', { type: 'button', className: 'tn-row game', title: `${g.reason} — view on the board` }, [
      el('span', { className: 'tn-num', textContent: String(g.number), title: g.round ? `Round ${g.round}` : '' }),
      side(g.white, 'white', g.result === '1-0'), side(g.black, 'black', g.result === '0-1'),
      el('span', { className: `tn-res ${cls}`, textContent: text }),
      el('span', { className: 'tn-reason', textContent: g.reason }),
      el('span', { className: 'tn-plies', textContent: `${Math.ceil(g.plies / 2)} moves` }),
    ]);
    row.onclick = async () => {
      if (state?.active && !state.external && !(await confirmDialog('Show this game? The game you are playing here will be abandoned.', 'Show game'))) return;
      try {
        await api.backend('tournamentGame', { number: g.number });
      } catch (err) {
        setStatus(errorText(err));
      }
    };
    return row;
  }) : [el('p', { className: 'hint', textContent: 'None yet.' })]));
}

// A new tournament forgets the last report.
const tnStart = $('#tn-setup').onsubmit;
$('#tn-setup').onsubmit = (e) => { tn.report = null; renderReportLine(); return tnStart(e); };

async function initTournament() {
  $('#tn-cores').textContent = `${navigator.hardwareConcurrency ?? '?'} logical cores; one game uses two engines, one thinking at a time`;
  if (!localStorage.getItem('tournament')) $('#tn-concurrency').value = Math.max(1, Math.floor((navigator.hardwareConcurrency ?? 2) / 2));
  fillTournamentEngines();
  loadTournamentForm();
  renderEntrants();
  syncTournamentForm();
  tn.ready = true;
  try {
    tournamentStatus(await api.backend('tournamentStatus'));
  } catch { renderTournament(); }
}
