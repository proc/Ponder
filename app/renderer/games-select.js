'use strict';
// Choosing several games in the Games list and acting on them all at once:
// ⌘/Ctrl-click adds or takes away a game, Shift-click takes in the games
// between, ⌘/Ctrl-A takes every game listed, Esc lets go. A bar above the
// list then offers Computer analysis, Export… and Delete for them. A plain
// click still just shows the game. Loaded after renderer.js and review.js.

const gsel = {
  set: new Set(),  // indices in the file
  anchor: null,    // where a Shift-click range starts
  of: null,        // the collection and its size they belong to
  total: -1,
  batch: null,     // computer analysis of the games chosen, when running
  panel: false,    // the Computer analysis bar is open with no games chosen
  scope: 'board',  // what it analyses then: board, listed or unanalysed
};

const listedIndices = () => (collection?.list?.games ?? []).map((g) => g.index);

// The choice holds for the file as it is: another file, or games added or
// taken away (which moves them), clears it; games no longer listed (the
// filter changed) leave it.
function pruneSelection() {
  if (gsel.of !== collection || gsel.total !== collection?.total) {
    gsel.set.clear();
    gsel.anchor = null;
    gsel.of = collection;
    gsel.total = collection?.total ?? -1;
  }
  const listed = new Set(listedIndices());
  for (const i of gsel.set) if (!listed.has(i)) gsel.set.delete(i);
}

window.gamesSelected = (index) => gsel.set.has(index);

// A click on a row: true when it was about choosing, not showing.
window.gamesRowClick = (e, index) => {
  if (gsel.batch) return false;
  pruneSelection();
  const toggle = e.metaKey || e.ctrlKey;
  if (!toggle && !e.shiftKey) {
    gsel.set.clear();
    gsel.anchor = index;
    return false; // shown, as ever
  }
  // The game on the board counts as chosen when the choosing starts.
  const current = currentIndex();
  if (!gsel.set.size && current >= 0 && current !== index) gsel.set.add(current);
  if (e.shiftKey) {
    const order = listedIndices();
    const from = order.indexOf(gsel.anchor ?? (current >= 0 ? current : index));
    const to = order.indexOf(index);
    if (from < 0 || to < 0) gsel.set.add(index);
    else for (let i = Math.min(from, to); i <= Math.max(from, to); i++) gsel.set.add(order[i]);
  } else {
    if (gsel.set.has(index)) gsel.set.delete(index); else gsel.set.add(index);
    gsel.anchor = index;
  }
  e.preventDefault();
  renderGames();
  return true;
};

function clearGameSelection() {
  gsel.set.clear();
  renderGames();
}

$('#games-list').addEventListener('keydown', (e) => {
  if (gsel.batch) return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    e.stopPropagation();
    pruneSelection();
    for (const i of listedIndices()) gsel.set.add(i);
    renderGames();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && gsel.set.size && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
    e.preventDefault();
    e.stopPropagation(); // not the one game the key is on
    deleteChosen();
  } else if (e.key === 'Escape' && gsel.set.size) {
    e.stopPropagation();
    clearGameSelection();
  } else if (e.key === 'Escape' && gsel.panel) {
    e.stopPropagation();
    closePanel();
  }
}, true);

const chosen = () => [...gsel.set].sort((a, b) => a - b);
const gamesWord = (n) => `${n.toLocaleString()} game${n === 1 ? '' : 's'}`;

window.renderGamesSelection = () => {
  pruneSelection();
  const bar = $('#games-sel');
  const b = gsel.batch;
  $('#games-analyse').disabled = !collection || Boolean(b);
  $('#games-analyse').setAttribute('aria-pressed', String(Boolean(gsel.panel && !gsel.set.size)));
  if (b) {
    const stop = el('button', { type: 'button', className: 'small', textContent: b.stop ? 'Stopping…' : 'Stop', disabled: b.stop });
    stop.onclick = stopBatch;
    const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;
    bar.replaceChildren(
      el('span', { className: 'games-sel-text', textContent: `Computer analysis: game ${Math.min(b.done + 1, b.total)} of ${b.total}${b.now ? ` · ${b.now}` : ''}` }),
      el('div', { className: 'review-bar' }, [el('div', { style: `width:${pct}%` })]),
      stop,
      // The settings it runs with (they are read for each game as it starts).
      el('div', { className: 'games-sel-settings hint', textContent: reviewSettingsText() }),
    );
    bar.hidden = false;
    return;
  }
  const n = gsel.set.size;
  const button = (text, title, onclick, cls = 'small') => {
    const x = el('button', { type: 'button', className: cls, textContent: text, title });
    x.onclick = onclick;
    return x;
  };
  if (!n && gsel.panel && collection) {
    // Nothing chosen: which games, then Start.
    const scopes = analysisScopes();
    if (!scopes.some(([k]) => k === gsel.scope)) gsel.scope = scopes[0]?.[0] ?? 'listed';
    const pick = el('select', { className: 'games-scope', title: 'Which games to analyse. ⌘/Ctrl-click games in the list to choose others.' },
      scopes.map(([k, text]) => el('option', { value: k, textContent: text })));
    pick.value = gsel.scope;
    pick.onchange = () => { gsel.scope = pick.value; renderGamesSelection(); };
    const start = button('Start', 'Analyse them in turn on the board, each saved into the file as it is done', () => analyseChosen(scopeIndices()), 'small primary');
    start.disabled = !scopeIndices().length;
    bar.replaceChildren(
      el('span', { className: 'games-sel-text', textContent: 'Computer analysis of' }), pick, start,
      el('span', { className: 'games-tools-gap' }),
      button('✕', 'Close (Esc)', closePanel, 'small icon-only'),
      el('div', { className: 'games-sel-settings' }, [el('span', { className: 'hint', textContent: 'Analysis:' }), ...reviewSettingsControls('games')]),
    );
    bar.hidden = false;
    return;
  }
  bar.hidden = n === 0;
  if (!n) { bar.replaceChildren(); return; }
  bar.replaceChildren(
    el('span', { className: 'games-sel-text', textContent: `${gamesWord(n)} chosen` }),
    button('Computer analysis', 'Analyse each of them in turn on the board, with the settings of Computer analysis in the Moves tab (time a move, swarm, comments). Each is saved into the file as it is done; positions analysed before are not searched again.', () => analyseChosen(), 'small primary'),
    button('Export…', 'Write them to a new PGN file', () => exportChosen()),
    el('span', { className: 'games-tools-gap' }),
    button('Delete', 'Delete them from the file', () => deleteChosen(), 'small danger'),
    button('✕', 'Let go of them (Esc)', clearGameSelection, 'small icon-only'),
    // What Computer analysis will do: the same settings as in the Moves tab.
    el('div', { className: 'games-sel-settings' }, [el('span', { className: 'hint', textContent: 'Analysis:' }), ...reviewSettingsControls('games')]),
  );
};

async function deleteChosen() {
  const indices = chosen();
  if (!indices.length || !collection) return;
  const source = collection.source;
  const before = collection.total;
  const shownGone = indices.includes(currentIndex());
  const ok = await confirmDialog(`Delete ${gamesWord(indices.length)} from ${source}? They are removed from the file and cannot be brought back.`, `Delete ${gamesWord(indices.length)}`);
  if (!ok || !collection || collection.source !== source || collection.total !== before) return;
  try {
    const r = await api.backend('pgnDelete', { indices });
    gsel.set.clear();
    await gamesChanged(r.total);
    setStatus(`${gamesWord(r.deleted)} deleted from ${source}.${shownGone ? ' The one on the board stays there until you show another.' : ''}`);
  } catch (err) {
    setStatus(errorText(err));
  }
}

async function exportChosen() {
  const indices = chosen();
  if (!indices.length || !collection) return;
  let file;
  try {
    file = await api.exportPgnPath(`${collection.source.replace(/\.pgn$/i, '')} ${indices.length} games`);
  } catch (err) { setStatus(errorText(err)); return; }
  if (!file) return;
  try {
    const r = await api.backend('pgnExport', { path: file, indices });
    setStatus(`${gamesWord(r.exported)} exported to ${r.name}.`);
  } catch (err) {
    setStatus(errorText(err));
  }
}

// ---------------------------------------------------------------------------
// Computer analysis of the games chosen: each is shown on the board in turn,
// analysed as Computer analysis in the Moves tab does it, and saved into the
// file before the next, so its own annotations are kept and the analysis
// is added to them.
// ---------------------------------------------------------------------------
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) return false;
    await pause(60);
  }
  return true;
}

function stopBatch() {
  if (!gsel.batch) return;
  gsel.batch.stop = true;
  api.backend('reviewStop').catch(() => {});
  renderGamesSelection();
}

// What the Computer analysis bar can analyse when no games are chosen.
function analysisScopes() {
  const listed = listedIndices();
  const more = (collection?.list?.matched ?? 0) > listed.length ? ` (the first ${listed.length.toLocaleString()})` : '';
  const todo = listed.filter((i) => !collection?.analysed?.has(i)).length;
  const out = [];
  if (currentIndex() >= 0) out.push(['board', `the game on the board (${gameTitle(currentIndex()).replace(/^game \S+ \((.*)\)$/, '$1')})`]);
  out.push(['unanalysed', `the games listed not analysed yet: ${gamesWord(todo)}${more}`]);
  out.push(['listed', `every game listed: ${gamesWord(listed.length)}${more}`]);
  return out;
}
function scopeIndices() {
  if (gsel.scope === 'board') return currentIndex() >= 0 ? [currentIndex()] : [];
  const listed = listedIndices();
  return gsel.scope === 'unanalysed' ? listed.filter((i) => !collection?.analysed?.has(i)) : listed;
}
function closePanel() {
  gsel.panel = false;
  renderGamesSelection();
}

// The toolbar's Computer analysis…: the games chosen, if any; else the bar
// opens (or closes) to pick which games, with the settings.
$('#games-analyse').onclick = () => {
  if (gsel.batch) return;
  if (gsel.set.size) { analyseChosen(); return; }
  gsel.panel = !gsel.panel;
  renderGamesSelection();
};

async function analyseChosen(given = null) {
  if (gsel.batch || !collection) return;
  const indices = given ?? chosen();
  if (!indices.length) return;
  if (!engines.length) { setStatus('Choose an analysis engine in Settings → Analysis first.'); return; }
  const source = collection.source;
  const b = gsel.batch = { total: indices.length, done: 0, stop: false, now: '', analysed: 0, partly: 0, skipped: 0, failed: '' };
  gsel.set.clear();
  renderGames();
  const lost = () => !collection || collection.source !== source;
  for (const index of indices) {
    if (b.stop || lost()) break;
    b.now = gameTitle(index).replace(/^game \S+ \((.*)\)$/, '$1');
    renderGamesSelection();
    await selectGame(index);
    // On the board, with what the file has for it read in.
    const shown = await until(() => currentIndex() === index && state?.loaded && an.ready === state.game, 15000);
    if (b.stop || lost()) break;
    if (!shown || !reviewable()) { b.skipped++; b.done++; continue; }
    const key = reviewKey();
    const ended = reviewEnded(key);
    await startReview();
    if (!rv.running && !rv.cache.get(key) && !(rv.error && rv.errorKey === key)) { b.failed = 'the analysis did not start'; break; }
    if (rv.error && rv.errorKey === key) { b.failed = rv.error; break; } // e.g. no engine
    const how = await ended;
    if (how === 'error') { b.failed = rv.error || 'the analysis failed'; break; }
    // Into the file before the next game takes the board.
    await until(() => {
      if (!notes.dirty && !anSave.busy) return true;
      if (!anSave.busy && currentIndex() === index) saveAnnotations();
      return currentIndex() !== index;
    }, 30000);
    if (how === 'done') b.analysed++; else b.partly++; // stopped: what it got through is saved
    b.done++;
    renderGamesSelection();
    // Somebody showed another game meanwhile: the rest wait.
    if (currentIndex() !== index) break;
  }
  gsel.batch = null;
  const parts = [`Computer analysis: ${gamesWord(b.analysed)} analysed${b.partly ? `, ${b.partly} in part` : ''}, and saved into ${source}`];
  if (b.skipped) parts.push(`${b.skipped} skipped (no moves, or could not be read)`);
  if (b.failed) parts.push(`stopped: ${b.failed}`);
  else if (b.done < b.total || b.partly) parts.push(`stopped; ${b.total - b.analysed} not analysed to the end`);
  setStatus(parts.join('; ') + '.');
  renderGames();
  window.refreshGamesAnalysed?.();
}
