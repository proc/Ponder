'use strict';
// Tournament: many games between two engines, with Elo and an SPRT. The Go
// backend plays them; this file draws the Tournament tab.
// Loaded after renderer.js, whose helpers ($, el, api, state, …) it uses.

const tn = {
  status: { state: 'idle' },
  pgnPath: '', // chosen by the user; '' for a new file per tournament
  openingsPath: '',
};

function tournamentRunning() {
  return tn.status.state === 'running' || tn.status.state === 'stopping';
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const TN_FIELDS = ['tn-tckind', 'tn-base', 'tn-inc', 'tn-movetime', 'tn-nodes', 'tn-games', 'tn-concurrency', 'tn-openings',
  'tn-random', 'tn-plies', 'tn-sprt', 'tn-elo0', 'tn-elo1', 'tn-alpha', 'tn-beta', 'tn-adj-draw', 'tn-draw-from', 'tn-draw-moves',
  'tn-draw-score', 'tn-adj-resign', 'tn-resign-moves', 'tn-resign-score', 'tn-maxmoves', 'tn-save', 'tn-e1', 'tn-e2'];

function saveTournamentForm() {
  const saved = { pgnPath: tn.pgnPath, openingsPath: tn.openingsPath };
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

function syncTournamentForm() {
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
  $('#tn-pgn').textContent = !$('#tn-save').checked ? 'not saved' : tn.pgnPath || 'a new file in Documents/Board/Tournaments';
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
  const a = spec('#tn-e1');
  const b = spec('#tn-e2');
  if (!a || !b) return tnError('Choose both engines (add engines in Settings → Engines).');
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
  if ($('#tn-save').checked) pgnPath = tn.pgnPath || await api.tournament.defaultPgn(a.name, b.name);
  const cfg = {
    engines: [a, b], timeControl, games,
    concurrency: Math.max(1, Math.round(num('tn-concurrency'))),
    openings: { source, path: tn.openingsPath, order: $('#tn-random').checked ? 'random' : 'sequential', plies: num('tn-plies') },
    sprt: { enabled: $('#tn-sprt').checked, elo0: num('tn-elo0'), elo1: num('tn-elo1'), alpha: num('tn-alpha'), beta: num('tn-beta') },
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

function renderTournament() {
  const s = tn.status;
  const active = s.state !== 'idle';
  $('#tn-setup').hidden = active;
  $('#tn-run').hidden = !active;
  const running = tournamentRunning();
  $('#tournament-count').textContent = running ? String(s.games ?? 0) : '';
  $('#tab-tournament').classList.toggle('live', running);
  if (!active) return;

  $('#tn-title').textContent = `${s.names[0]} vs ${s.names[1]} · ${s.tc} · ${s.workers} at once`;
  $('#tn-stop').hidden = !running;
  $('#tn-stop').disabled = s.state === 'stopping';
  $('#tn-new').hidden = running;
  $('#tn-report').disabled = !(s.games > 0);
  $('#tn-report').textContent = running ? 'Report so far' : 'Report';
  $('#tn-watch').checked = s.watching;
  $('#tn-watch').disabled = !running;

  const verdict = $('#tn-verdict');
  const msg = s.state === 'stopping' && !s.verdict ? 'Stopping…' : s.state === 'finished' || s.verdict ? s.message : '';
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
  $('#tn-progress-bar').style.width = `${Math.round(progress * 100)}%`;
  $('#tn-wld').textContent = `${st.Wins} – ${st.Losses} – ${st.Draws}`;
  $('#tn-score').textContent = games ? `${fmt(s.score * 100)}%` : '–';
  $('#tn-elo').textContent = games ? `${signed(s.elo)} ± ${fmt(s.eloMargin)}` : '–';
  $('#tn-los').textContent = games ? `${fmt(s.los * 100)}%` : '–';
  $('#tn-draws').textContent = games ? `${fmt(s.drawRatio * 100)}%` : '–';

  const box = $('#tn-llr-box');
  box.hidden = !s.sprt.enabled;
  if (s.sprt.enabled) {
    $('#tn-llr-text').textContent = `LLR ${signed(s.llr, 2)}  (${fmt(s.lower, 2)}, ${fmt(s.upper, 2)})  ·  [${s.sprt.elo0}, ${s.sprt.elo1}]  α ${s.sprt.alpha} β ${s.sprt.beta}`;
    const pos = (Math.max(s.lower, Math.min(s.upper, s.llr)) - s.lower) / (s.upper - s.lower);
    $('#tn-llr-mark').style.left = `${pos * 100}%`;
    $('#tn-llr-mark').className = 'tn-llr-mark' + (s.llr >= 0 ? ' up' : ' down');
    box.querySelector('.tn-llr-zero').style.left = `${(-s.lower / (s.upper - s.lower)) * 100}%`;
  }
  const penta = st.Penta;
  $('#tn-penta').replaceChildren(
    el('span', { className: 'tn-k', textContent: 'Pairs', title: `Pairs of games from the same opening, by ${s.names[0]}'s points: 0, ½, 1, 1½, 2` }),
    ...['0', '½', '1', '1½', '2'].map((label, i) => el('span', { className: 'tn-pent', title: `${s.names[0]} scored ${label} of 2` }, [
      el('span', { className: 'tn-k', textContent: label }), el('span', { className: 'tn-v', textContent: String(penta[i]) }),
    ])),
  );
  const rate = s.elapsed > 0 ? games / (s.elapsed / 60) : 0;
  const meta = [`${duration(s.elapsed)}`, rate ? `${fmt(rate, 1)} games/min` : ''];
  if (s.total && running && rate) meta.push(`about ${duration(((s.total - games) / rate) * 60)} left`);
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

  $('#tn-live').replaceChildren(...(s.live.length ? s.live.map((g) => el('div', { className: 'tn-row' }, [
    el('span', { className: 'tn-num', textContent: `#${g.number}` }),
    el('span', { className: 'tn-players', textContent: `${g.white} – ${g.black}` }),
    el('span', { className: 'tn-plies', textContent: `move ${Math.floor(g.plies / 2) + 1}` }),
    el('span', { className: 'tn-opening', textContent: g.opening ?? '', title: g.opening ?? '' }),
  ])) : [el('p', { className: 'hint', textContent: running ? 'Starting…' : 'None' })]));

  $('#tn-recent').replaceChildren(...s.recent.map((g) => {
    const row = el('button', { type: 'button', className: 'tn-row game', title: `${g.reason} — view on the board` }, [
      el('span', { className: 'tn-num', textContent: `#${g.number}` }),
      el('span', { className: 'tn-players', textContent: `${g.white} – ${g.black}` }),
      el('span', { className: 'tn-result', textContent: g.result }),
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
  }));
}

// A new tournament forgets the last report.
const tnStart = $('#tn-setup').onsubmit;
$('#tn-setup').onsubmit = (e) => { tn.report = null; renderReportLine(); return tnStart(e); };

async function initTournament() {
  $('#tn-cores').textContent = `${navigator.hardwareConcurrency ?? '?'} logical cores; one game uses two engines, one thinking at a time`;
  if (!localStorage.getItem('tournament')) $('#tn-concurrency').value = Math.max(1, Math.floor((navigator.hardwareConcurrency ?? 2) / 2));
  fillTournamentEngines();
  loadTournamentForm();
  syncTournamentForm();
  try {
    tournamentStatus(await api.backend('tournamentStatus'));
  } catch { renderTournament(); }
}
