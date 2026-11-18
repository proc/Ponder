'use strict';
// Convert PGN to binpack: a PGN file's finished games as NNUE training
// positions (Stockfish's .binpack), scored from the games' evaluations or
// by an engine. The Go backend does the work and reports "binpack" events;
// it carries on with the dialog closed, and the status line says when it ends.

const dlgBinpack = $('#dlg-binpack');
const bp = { from: '', run: null };

function bpSettings() {
  try { return JSON.parse(localStorage.getItem('binpack') ?? '{}') ?? {}; } catch { return {}; }
}

function bpSave() {
  const s = {
    scores: dlgBinpack.querySelector('input[name="bp-scores"]:checked')?.value ?? 'pgn',
    missing: $('#bp-missing').value,
    engine: $('#bp-engine').value,
    limit: $('#bp-limit').value,
    limitValue: Number($('#bp-limit-value').value) || 0,
    conc: Number($('#bp-conc').value) || 1,
    pawn: Number($('#bp-pawn').value) || 208,
    skip: Number($('#bp-skip').value) || 0,
    noisy: $('#bp-noisy').checked,
  };
  try { localStorage.setItem('binpack', JSON.stringify(s)); } catch { /* ignore */ }
}

function bpLoad() {
  const s = bpSettings();
  const scores = s.scores === 'engine' ? 'engine' : 'pgn';
  dlgBinpack.querySelector(`input[name="bp-scores"][value="${scores}"]`).checked = true;
  if (s.missing) $('#bp-missing').value = s.missing;
  if (s.limit) $('#bp-limit').value = s.limit;
  $('#bp-limit-value').value = s.limitValue || (s.limit === 'nodes' ? 10000 : 8);
  $('#bp-conc').value = s.conc || 1;
  $('#bp-pawn').value = s.pawn || 208;
  $('#bp-skip').value = s.skip ?? 0;
  $('#bp-noisy').checked = Boolean(s.noisy);
  const sel = $('#bp-engine');
  const current = sel.value || s.engine || analysisSettings().engineId;
  sel.replaceChildren(...engines.map((e) => el('option', { value: e.id, textContent: e.name })));
  if (engines.some((e) => e.id === current)) sel.value = current;
}

function bpRenderOptions() {
  const engine = dlgBinpack.querySelector('input[name="bp-scores"]:checked')?.value === 'engine';
  const running = Boolean(bp.run);
  $('#bp-pgn-opts').classList.toggle('off', engine);
  $('#bp-engine-opts').classList.toggle('off', !engine);
  for (const c of dlgBinpack.querySelectorAll('fieldset input, fieldset select, .bp-more input, #bp-choose')) {
    c.disabled = running || Boolean(c.closest('.off'));
  }
  $('#bp-from').value = bp.from.split(/[\\/]/).pop();
  $('#bp-from').title = bp.from;
  $('#bp-convert').hidden = running;
  $('#bp-stop').hidden = !running;
  $('#bp-convert').disabled = !bp.from;
}

const bpNum = (n) => Number(n || 0).toLocaleString();

function bpSize(bytes) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// What the counts say, for the dialog and the status line.
function bpSummary(ev) {
  let s = `${bpNum(ev.positions)} position${ev.positions === 1 ? '' : 's'} from ${bpNum(ev.games)} game${ev.games === 1 ? '' : 's'}`;
  const left = [];
  if (ev.unscored) left.push(`${bpNum(ev.unscored)} without a score`);
  if (ev.unfinished) left.push(`${bpNum(ev.unfinished)} unfinished game${ev.unfinished === 1 ? '' : 's'}`);
  if (left.length) s += ` (left out: ${left.join(', ')})`;
  if (ev.broken) s += `; ${bpNum(ev.broken)} game${ev.broken === 1 ? '' : 's'} stopped at an illegal move`;
  return s;
}

function bpRenderProgress(ev) {
  $('#bp-progress').hidden = false;
  const pct = ev.size > 0 ? Math.min(100, (ev.read / ev.size) * 100) : 0;
  $('#bp-progress-fill').style.width = `${ev.state === 'done' ? 100 : pct}%`;
  let text = bpSummary(ev);
  if (ev.state === 'running') {
    text = `${Math.floor(pct)}% · ${text}`;
    if (bp.run?.started && pct > 1) {
      const secs = ((Date.now() - bp.run.started) / 1000) * (100 - pct) / pct;
      if (secs > 5) text += ` · about ${secs >= 90 ? `${Math.round(secs / 60)} min` : `${Math.round(secs)} s`} left`;
    }
  } else if (ev.state === 'done') {
    text = `Done: ${text}. ${ev.name}, ${bpSize(ev.bytes)}.`;
  } else if (ev.state === 'stopped') {
    text = `Stopped: ${text} written to ${ev.name}.`;
  } else if (ev.state === 'error') {
    text = `${text} written to ${ev.name} before the error.`;
  }
  $('#bp-progress-text').textContent = text;
}

function openBinpack(from) {
  if (!bp.run) {
    bp.from = from || bp.from || collection?.path || '';
    bpLoad();
    $('#bp-error').hidden = true;
    if (!bp.last) $('#bp-progress').hidden = true;
  }
  bpRenderOptions();
  if (!dlgBinpack.open) dlgBinpack.showModal();
}

$('#games-binpack').onclick = () => openBinpack(collection?.path);

$('#bp-choose').onclick = async () => {
  let file;
  try { file = await api.openPgn(); } catch (err) { setStatus(errorText(err)); return; }
  if (!file) return;
  bp.from = file.path;
  bp.last = null;
  $('#bp-progress').hidden = true;
  bpRenderOptions();
};

for (const c of dlgBinpack.querySelectorAll('input, select')) {
  c.addEventListener('change', () => { bpSave(); bpRenderOptions(); });
}
$('#bp-limit').addEventListener('change', () => {
  $('#bp-limit-value').value = $('#bp-limit').value === 'nodes' ? 10000 : 8;
  bpSave();
});

$('#bp-close').onclick = () => dlgBinpack.close();
$('#bp-stop').onclick = () => api.backend('binpackStop');

$('#bp-convert').onclick = async () => {
  if (!bp.from || bp.run) return;
  const err = (msg) => { $('#bp-error').textContent = msg; $('#bp-error').hidden = !msg; };
  const scores = dlgBinpack.querySelector('input[name="bp-scores"]:checked')?.value ?? 'pgn';
  const engine = engines.find((e) => e.id === $('#bp-engine').value);
  if (scores === 'engine' && !engine) { err('Add an engine first (Engines in Settings).'); return; }
  const limit = Math.max(1, Math.round(Number($('#bp-limit-value').value) || 0));
  let to;
  try { to = await api.binpackPath(bp.from); } catch (e) { err(errorText(e)); return; }
  if (!to) return;
  err('');
  const key = `b${Date.now()}`;
  const req = {
    key, from: bp.from, to, scores,
    missing: $('#bp-missing').value,
    pawnValue: Math.round(Number($('#bp-pawn').value)) || 208,
    skipPlies: Math.max(0, Math.round(Number($('#bp-skip').value) || 0)),
    skipNoisy: $('#bp-noisy').checked,
  };
  if (scores === 'engine') {
    req.engine = { name: engine.name, path: engine.path, args: engine.args ?? [], options: engine.options ?? {} };
    if ($('#bp-limit').value === 'nodes') req.nodes = limit; else req.depth = limit;
    req.concurrency = Math.min(64, Math.max(1, Math.round(Number($('#bp-conc').value) || 1)));
  }
  bp.run = { key, started: Date.now() };
  bp.last = null;
  bpRenderOptions();
  bpRenderProgress({ state: 'running', read: 0, size: 0, games: 0, positions: 0 });
  try {
    await api.backend('binpackStart', req);
  } catch (e) {
    bp.run = null;
    $('#bp-progress').hidden = true;
    err(errorText(e));
    bpRenderOptions();
  }
};

function binpackEvent(ev) {
  if (!bp.run || ev.key !== bp.run.key) return;
  bpRenderProgress(ev);
  if (ev.state === 'running') return;
  bp.run = null;
  bp.last = ev;
  bpRenderOptions();
  if (ev.state === 'error') {
    $('#bp-error').textContent = ev.error;
    $('#bp-error').hidden = false;
  }
  if (!dlgBinpack.open) {
    if (ev.state === 'done') setStatus(`Binpack written: ${bpSummary(ev)}, to ${ev.name}.`);
    else if (ev.state === 'error') setStatus(`The binpack stopped: ${ev.error}`);
  }
}
