'use strict';
// Annotating a game: marks on a move (! ? !! ?? !? ?!), an evaluation of
// the position (= ⩲ ± +− …), and a comment, for the move shown — in the
// game or in a variation. Variations are made by playing moves on the
// board. Save writes it all into the game's PGN file; a game that is not in
// a file is saved as a new one. Annotations in a file come back when the
// game is opened.

const an = { open: false, loadedFor: null };
try { an.open = localStorage.getItem('annotate') === '1'; } catch { /* ignore */ }

const annBlank = () => ({ nag: 0, pos: 0, other: [], comment: '', cmds: '' });
const annEmpty = (a) => !a || !(a.nag || a.pos || a.other?.length || a.comment || a.cmds);

// What is being annotated: the variation move shown, the game's move
// shown, or the start (a comment before the first move).
function annTarget() {
  if (!state || puzzleView) return null;
  if (varNode) {
    const { n, white } = plyNumber(varNode.ply);
    return { get: () => varNode.ann, set: (a) => { varNode.ann = a; }, node: varNode, label: `${n}${white ? '.' : '…'} ${varNode.san} · variation`, move: true };
  }
  const ply = shownPly();
  if (ply === 0) return { get: () => notes.before, set: (a) => { notes.before = a; }, label: 'Before the first move', move: false };
  const { n, white } = plyNumber(ply);
  return {
    get: () => notes.moves.get(ply),
    set: (a) => { if (a) notes.moves.set(ply, a); else notes.moves.delete(ply); },
    label: `${n}${white ? '.' : '…'} ${state.moves[ply - 1].san}`, move: true,
  };
}

function annChange(f) {
  const t = annTarget();
  if (!t) return;
  const a = t.get() ?? annBlank();
  f(a);
  t.set(annEmpty(a) ? undefined : a);
  if (!t.move && annEmpty(a)) notes.before = null;
  // A comment or mark on a move of a variation makes the line the game's
  // to keep, up to that move: it is saved with it.
  for (let n = t.node; n; n = n.parent) n.keep = true;
  notes.dirty = true;
  renderMoves();
}

// Where Save goes: the open file the game came from, else a new file.
const annInFile = () => Boolean(state?.loaded && state.index >= 0 && state.source);

function renderAnnotate() {
  const box = $('#annotate');
  const t = an.open ? annTarget() : null;
  $('#btn-annotate').setAttribute('aria-pressed', String(an.open));
  $('#btn-annotate').disabled = !state?.players || Boolean(puzzleView);
  box.hidden = !t;
  if (!t) return;
  const a = t.get();
  $('#an-target').textContent = t.label;
  const group = (id, table, field) => {
    $(id).replaceChildren(...Object.entries(table).map(([nag, text]) => {
      const on = a?.[field] === +nag;
      const b = el('button', { type: 'button', className: 'small' + (on ? ' on' : ''), title: NAG_TITLE[nag] },
        [el('span', { className: `glyph ${field === 'nag' ? NAG_KIND[nag] : 'pos'}`, textContent: text })]);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', NAG_TITLE[nag]);
      b.disabled = !t.move;
      b.onclick = () => annChange((x) => { x[field] = x[field] === +nag ? 0 : +nag; if (field === 'nag') { x.autoNag = false; x.aiNag = false; } });
      return b;
    }));
  };
  group('#an-glyphs', NAG_MOVE, 'nag');
  group('#an-pos', NAG_POS, 'pos');
  const box2 = $('#an-comment');
  if (box2.value !== (a?.comment ?? '')) box2.value = a?.comment ?? '';
  box2.placeholder = t.move ? 'Comment on this move' : 'Comment before the first move';
  const save = $('#an-save');
  // Saved by itself where the game has a file; Save as… where it has none.
  const nowhere = anSave.none === state.game || (!annInFile() && !(anSave.game === state.game && anSave.file));
  const file = annInFile() ? state.source : anSave.game === state.game ? anSave.file : '';
  // Lines only tried on the board are not saved by themselves: Save keeps them.
  const loose = Boolean(notes.loose);
  // Short labels: the file's name is in the tooltip.
  save.textContent = anSave.busy ? 'Saving…' : nowhere ? 'Save as…' : notes.dirty || loose ? 'Save' : 'Saved';
  save.disabled = anSave.busy || (!nowhere && !notes.dirty && !loose);
  save.classList.toggle('primary', notes.dirty && nowhere);
  save.title = nowhere ? 'This game is in no open PGN file: choose a file to save it with its annotations'
    : anSave.error ? `The last save did not work: ${anSave.error}`
      : loose ? `The lines you have tried on the board are not saved by themselves: save them into ${file} with the game`
        : notes.dirty ? `Save the annotations into ${file} now (they are saved by themselves a moment after they change)`
          : `Everything is saved in ${file}. Comments and marks are saved by themselves, a moment after they change`;
  renderAiButton();
  $('#an-note').textContent = exploring()
    ? 'Play a move on the board to add a variation.'
    : 'Variations can be added once the game is over.';
}
window.renderAnnotate = renderAnnotate;

$('#btn-annotate').onclick = () => {
  an.open = !an.open;
  try { localStorage.setItem('annotate', an.open ? '1' : ''); } catch { /* ignore */ }
  renderAnnotate();
  if (an.open) $('#an-comment').focus();
};

$('#an-comment').addEventListener('input', (e) => {
  const text = e.target.value.replace(/[{}]/g, '');
  annChange((a) => { a.comment = text.trim() ? text : ''; a.auto = false; a.ai = false; }); // yours now, not the computer's
});
// Typing stays in the box: arrows and letters are not shortcuts here.
$('#an-comment').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.blur(); return; }
  e.stopPropagation();
});

// Saving: annotations are written into the game's PGN by themselves, a
// moment after they change. "The game's PGN" is the file it was opened
// from, or, for a game played or watched here, its entry in the open file
// (the game database it was added to when it ended). A game that is in no
// open file has nowhere to be saved to until you choose one (Save as…).
const anSave = { timer: null, busy: false, again: false, none: null, file: '', at: 0, error: '' };
const AN_SAVE_DELAY = 1200; // ms after the last change

// Could it be in a file at all right now: not while it is being played.
const annSavable = () => Boolean(state?.players && !state.active && !state.external?.live && state.moves?.length && !puzzleView);

async function saveAnnotations({ quiet = true } = {}) {
  if (anSave.busy) { anSave.again = true; return false; }
  clearTimeout(anSave.timer);
  anSave.timer = null;
  if (!annSavable()) return false;
  const game = state.game;
  anSave.busy = true;
  renderAnnotate();
  let ok = false;
  try {
    // By itself, only what is the game's to keep; by hand, every line there is.
    const r = await api.backend('pgnAnnotate', { annotations: pgnAnnotations({ kept: quiet }) ?? {} });
    if (state?.game === game) {
      notes.dirty = false;
      if (!quiet) {
        // Saved by hand: the lines on the board are the game's now.
        const keepAll = (n) => { n.keep = true; n.children.forEach(keepAll); };
        for (const lines of tree.branches.values()) lines.forEach(keepAll);
        notes.loose = false;
      }
      Object.assign(anSave, { none: null, file: r?.file ?? state.source ?? '', at: Date.now(), error: '', game });
      if (!quiet) setStatus(`Saved the annotations to ${anSave.file}`);
    }
    ok = true;
  } catch (err) {
    const msg = errorText(err);
    if (/not in the open PGN file|no PGN file is open/i.test(msg)) {
      // Nowhere to save it: not asked again for this game until a file changes.
      anSave.none = game;
      anSave.error = '';
      if (!quiet) { await exportPgn(); notes.dirty = false; }
    } else {
      anSave.error = msg;
      if (!quiet) setStatus('Could not save the annotations: ' + msg);
      else if (typeof notify === 'function') notify(msg, { title: 'The annotations could not be saved' });
    }
  }
  anSave.busy = false;
  renderAnnotate();
  if (anSave.again) { anSave.again = false; autosaveAnnotations(); }
  return ok;
}

// Called whenever the moves are drawn (every change of an annotation
// draws them): a change waiting to be saved is saved shortly after.
// retry: a file has changed, so a game with nowhere to go may have one now.
function autosaveAnnotations(retry = false) {
  if (!state) return;
  if (retry && anSave.none === state.game) anSave.none = null;
  if (!notes.dirty || anSave.none === state.game || !annSavable()) return;
  if (anSave.busy) { anSave.again = true; return; }
  clearTimeout(anSave.timer);
  anSave.timer = setTimeout(() => saveAnnotations(), AN_SAVE_DELAY);
}
window.autosaveAnnotations = autosaveAnnotations;
// Nothing is left unsaved when the window goes.
window.addEventListener('beforeunload', () => { if (notes?.dirty && anSave.timer) saveAnnotations(); });

$('#an-save').onclick = () => saveAnnotations({ quiet: false });

window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog:modal') || !state || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select')) return;
  if ((e.key === 'a' || e.key === 'A') && !$('#btn-annotate').disabled && !$('#pane-moves').hidden) $('#btn-annotate').click();
});

// A note from the file: glyphs sorted into the move's mark, the position's
// evaluation and the rest; [%eval …] and the like kept apart from the text.
function annFromFile(nags = [], comment = '') {
  const a = annBlank();
  for (const n of nags) {
    if (NAG_MOVE[n] && !a.nag) a.nag = n;
    else if (NAG_POS[n] && !a.pos) a.pos = n;
    else a.other.push(n);
  }
  // "[%ai]" says the comment was the AI model's: it is known as such again.
  const cmds = comment.match(/\[%[^\]]*\]/g) ?? [];
  a.cmds = cmds.filter((c) => c !== '[%ai]').join(' ');
  a.comment = comment.replace(/\[%[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cmds.includes('[%ai]') && a.comment) a.ai = true;
  return annEmpty(a) ? undefined : a;
}

// Reads the annotations of a game opened from a file.
async function loadAnnotations() {
  if (!state?.loaded || state.index < 0 || an.loadedFor === state.game) return;
  const game = an.loadedFor = state.game;
  let got;
  try { got = await api.backend('pgnAnnotations', { index: state.index }); } catch { return; }
  if (!got || state.game !== game) return;
  if (got.before) notes.before = annFromFile([], got.before) ?? null;
  for (const [ply, note] of Object.entries(got.moves ?? {})) {
    const a = annFromFile(note.nags, note.comment);
    if (a && +ply <= state.moves.length) notes.moves.set(+ply, a);
  }
  const build = (v, parent, base, ply) => {
    const node = { uci: v.uci, san: v.san, fen: v.fen, opening: '', parent, base, ply, children: [], keep: true, ann: annFromFile(v.nags, v.comment) };
    node.children = (v.children ?? []).map((c) => build(c, node, base, ply + 1));
    return node;
  };
  for (const [base, lines] of Object.entries(got.variations ?? {})) {
    if (+base > state.moves.length) continue;
    const have = tree.branches.get(+base) ?? [];
    for (const v of lines) if (!have.some((n) => n.uci === v.uci)) have.push(build(v, null, +base, +base + 1));
    tree.branches.set(+base, have);
  }
  notes.dirty = false;
  renderMoves();
}
window.loadAnnotations = loadAnnotations;

// ---------------------------------------------------------------------------
// AI annotate: the game goes, as PGN and as a numbered list of moves, to an
// OpenAI-compatible endpoint (Settings → AI; a local server by
// default) that is asked for commentary. What comes back becomes
// annotations: a summary before the first move, and a comment and a mark on
// the moves it picked. An annotation already on the game is never replaced,
// whoever made it: the AI only fills in what is not there.
// ---------------------------------------------------------------------------
const aiRun = { busy: false, game: null, since: 0, timer: null, note: '', error: false };
const AI_NAG = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 };
const hasAiNotes = () => Boolean(notes.before?.ai) || [...notes.moves.values()].some((a) => a.ai || a.aiNag);

function removeAiNotes() {
  if (notes.before?.ai) notes.before = null;
  for (const [ply, a] of [...notes.moves]) {
    if (a.ai) { a.comment = ''; a.ai = false; }
    if (a.aiNag) { a.nag = 0; a.aiNag = false; }
    if (annEmpty(a)) notes.moves.delete(ply);
  }
}

// Fills in only what is not there: a move that already has a comment keeps
// it, and one that already has a mark keeps that, wherever they came from
// (you, the file, the computer analysis, an earlier AI run). Nothing is
// taken off first; "Remove the AI's annotations" does that when asked.
function applyAiNotes(reply) {
  let n = 0;
  if (reply.summary && !notes.before?.comment) {
    notes.before = { ...annBlank(), comment: reply.summary, ai: true };
    n++;
  }
  for (const c of reply.comments ?? []) {
    if (c.ply < 1 || c.ply > state.moves.length) continue;
    const a = notes.moves.get(c.ply) ?? annBlank();
    let used = false;
    if (c.comment && !a.comment) { a.comment = c.comment; a.ai = true; used = true; }
    if (AI_NAG[c.mark] && !a.nag) { a.nag = AI_NAG[c.mark]; a.aiNag = true; used = true; }
    if (used) { notes.moves.set(c.ply, a); n++; }
  }
  notes.aiModel = reply.model ?? '';
  if (n) notes.dirty = true;
  return n; // the summary and the moves that took something from the AI
}

function renderAiButton() {
  const btn = $('#an-ai');
  const here = aiRun.busy && aiRun.game === state?.game;
  btn.textContent = here ? 'Stop' : 'AI annotate';
  btn.disabled = !state?.moves?.length || (aiRun.busy && !here);
  btn.classList.toggle('working', here);
  const box = $('#an-ai-state');
  const parts = [];
  if (here) {
    const secs = Math.round((Date.now() - aiRun.since) / 1000);
    const waited = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    parts.push(`Asking the model for commentary… ${waited}. It waits until the model answers or you press Stop.`);
  }
  else if (aiRun.note && aiRun.game === state?.game) parts.push(aiRun.note);
  box.replaceChildren(...parts.map((t) => document.createTextNode(t)));
  if (!here && hasAiNotes()) {
    const clear = el('button', { type: 'button', className: 'link', textContent: 'Remove the AI’s annotations' });
    clear.onclick = () => { removeAiNotes(); notes.dirty = true; aiRun.note = ''; renderMoves(); };
    if (parts.length) box.append(' · ');
    box.append(clear);
  }
  box.hidden = !box.childNodes.length;
  box.classList.toggle('error', aiRun.error && !here);
}

$('#an-ai').onclick = async () => {
  if (aiRun.busy) { api.ai.cancel(); return; }
  if (!state?.moves?.length) return;
  const game = state.game;
  Object.assign(aiRun, { busy: true, game, since: Date.now(), note: '', error: false });
  aiRun.timer = setInterval(renderAiButton, 1000);
  renderAiButton();
  try {
    const pgn = await gamePgn();
    const moves = state.moves.map((m, i) => { const { n, white } = plyNumber(i + 1); return { ply: i + 1, number: n, white, san: m.san }; });
    const reply = await api.ai.annotate({
      pgn, moves, white: state.players?.white?.name ?? '', black: state.players?.black?.name ?? '', result: state.result ?? '*',
      whiteElo: state.players?.white?.rating ?? '', blackElo: state.players?.black?.rating ?? '',
    });
    if (state?.game !== game) return; // another game meanwhile: not its commentary
    const hadSummary = Boolean(notes.before?.comment);
    const n = applyAiNotes(reply);
    const summed = !hadSummary && Boolean(notes.before?.ai);
    const moved = n - (summed ? 1 : 0);
    // What it offered that was not taken, because something was there already.
    const offered = (reply.comments?.length ?? 0) + (reply.summary ? 1 : 0);
    const kept = Math.max(0, offered - n);
    aiRun.error = !n && !kept;
    const left = kept ? ` ${kept} annotation${kept === 1 ? '' : 's'} already there ${kept === 1 ? 'was' : 'were'} left as ${kept === 1 ? 'it is' : 'they are'}.` : '';
    aiRun.note = n ? `${reply.model} annotated ${moved} move${moved === 1 ? '' : 's'}${summed ? ' and summed the game up' : ''}.${left}`
      : reply.loose && !hadSummary ? `${reply.model} did not answer in the form asked for.`
        : kept ? `Nothing was changed: every move ${reply.model} commented on already has an annotation.` : `${reply.model} had nothing to add.`;
    renderMoves();
    if (n && typeof notify === 'function') notify(aiRun.note, { title: 'AI annotations added', kind: 'info' });
  } catch (err) {
    const text = errorText(err);
    aiRun.error = text !== 'Stopped';
    aiRun.note = text === 'Stopped' ? 'Stopped.' : text;
    if (aiRun.error && typeof notify === 'function') notify(text, { title: 'AI annotate did not work' });
  } finally {
    clearInterval(aiRun.timer);
    aiRun.busy = false;
    renderAiButton();
  }
};

// Settings → AI: the provider, and its model and key.
const AI_NOTE = 'Nothing is sent until you press AI annotate, send a message in the AI panel or turn on live commentary: then the game on the board goes to the provider chosen here, as PGN, with the position shown. It waits for the answer as long as the model takes; Stop cancels it.';
const AI_WHERE = {
  local: 'A server on this computer or your network keeps the games on it.',
  openai: 'The games go to OpenAI. Get a key at platform.openai.com.',
  anthropic: 'The games go to Anthropic. Get a key in the Claude Console (platform.claude.com).',
  google: 'The games go to Google. Get a key in Google AI Studio (aistudio.google.com).',
};
// A drop-down of names: an empty choice first (what happens with none
// chosen), then the names given; the one chosen stays in it even when it
// is not among them (a model not loaded now, say).
function fillChoices(sel, names, current, emptyLabel) {
  const list = [...new Set(names)];
  if (current && !list.includes(current)) list.unshift(current);
  const opts = list.map((n) => el('option', { value: n, textContent: n }));
  if (emptyLabel) opts.unshift(el('option', { value: '', textContent: emptyLabel }));
  sel.replaceChildren(...opts);
  sel.value = current && list.includes(current) ? current : (emptyLabel ? '' : list[0] ?? '');
}
const aiModelList = new Map(); // provider → the models it listed last
let aiModelEmpty = '';
function showAiSettings(s) {
  const sel = $('#ai-provider');
  if (sel.options.length !== (s.providers ?? []).length) {
    sel.replaceChildren(...(s.providers ?? []).map((p) => el('option', { value: p.id, textContent: p.name })));
  }
  sel.value = s.provider ?? 'local';
  const p = (s.providers ?? []).find((x) => x.id === s.provider) ?? {};
  const local = s.provider === 'local' || !s.provider;
  $('#ai-url-row').hidden = !local;
  $('#ai-url').value = s.baseUrl ?? '';
  $('#ai-url').placeholder = s.defaultUrl ?? '';
  aiModelEmpty = local ? 'The endpoint’s first model' : p.defaultModel ? `${p.defaultModel} (the default)` : 'Choose a model';
  fillChoices($('#ai-model'), aiModelList.get(s.provider) ?? [], s.model ?? '', aiModelEmpty);
  $('#ai-check').title = local ? 'Ask the endpoint again which models it has' : `Ask ${p.name ?? 'the provider'} again which models your key can use`;
  $('#ai-key').value = '';
  $('#ai-key').placeholder = s.hasKey ? 'A key is saved (type a new one to replace it)' : local ? 'Not needed for most local servers' : `Your ${p.name ?? ''} API key`;
  $('#ai-ctx-size').value = s.contextWindow ?? '';
  aiSay(`${AI_WHERE[s.provider] ?? AI_WHERE.local} ${AI_NOTE}`);
}
async function fillAiSettings() {
  let s;
  window.fillTtsSettings?.(); // the commentary voice, in the same pane
  try { s = await api.ai.settings(); } catch { return; }
  showAiSettings(s);
  // The list of models, asked for each time the settings open.
  refreshAiModels({ quiet: true });
}
window.fillAiSettings = fillAiSettings;
const aiSay = (text, bad = false) => { $('#ai-note').textContent = text; $('#ai-note').classList.toggle('error', bad); };
async function saveAiSetting(patch) {
  try {
    const s = await api.ai.save(patch);
    if ('provider' in patch) showAiSettings(s);
    if ('baseUrl' in patch) $('#ai-url').value = s.baseUrl;
    if ('key' in patch) { $('#ai-key').value = ''; $('#ai-key').placeholder = s.hasKey ? 'A key is saved (type a new one to replace it)' : 'Not needed for most local servers'; }
    return true;
  } catch (err) { aiSay(errorText(err), true); return false; }
}
$('#ai-provider').addEventListener('change', async (e) => { if (await saveAiSetting({ provider: e.target.value })) refreshAiModels({ quiet: true }); });
$('#ai-ctx-size').addEventListener('change', async (e) => {
  await saveAiSetting({ contextWindow: e.target.value });
  // The meter takes the new size at once.
  for (const holder of [aic.chat, typeof cm !== 'undefined' ? cm : null]) {
    if (!holder?.usage) continue;
    const n = await api.ai.contextWindow?.(holder.usage.model).catch(() => null);
    holder.usage.window = Number(n) > 0 ? Number(n) : null;
  }
  window.renderAiContext?.();
});
$('#ai-url').addEventListener('change', async (e) => { aiModelList.delete('local'); if (await saveAiSetting({ baseUrl: e.target.value })) refreshAiModels({ quiet: true }); });
$('#ai-model').addEventListener('change', (e) => saveAiSetting({ model: e.target.value }));
$('#ai-key').addEventListener('change', async (e) => { if (e.target.value && await saveAiSetting({ key: e.target.value })) refreshAiModels({ quiet: true }); });
// The models the endpoint or provider has, into the Model list. Quietly
// when the settings open (a provider with no key yet says nothing); with
// what it found when Refresh is pressed.
async function refreshAiModels({ quiet = false } = {}) {
  const btn = $('#ai-check');
  const provider = $('#ai-provider').value;
  btn.disabled = true;
  if (!quiet) aiSay(`Asking ${$('#ai-provider').selectedOptions[0]?.textContent ?? 'the endpoint'}…`);
  if (await saveAiSetting($('#ai-url-row').hidden ? {} : { baseUrl: $('#ai-url').value })) {
    try {
      const models = await api.ai.models();
      aiModelList.set(provider, models);
      if ($('#ai-provider').value === provider) fillChoices($('#ai-model'), models, $('#ai-model').value, aiModelEmpty);
      if (!quiet || !models.length) aiSay(models.length ? `Connected: ${models.length} model${models.length === 1 ? '' : 's'}. Choose one in the Model list.` : 'Connected, but no models are listed.', !models.length);
    } catch (err) { if (!quiet) aiSay(errorText(err), true); }
  }
  btn.disabled = false;
}
$('#ai-check').onclick = () => refreshAiModels();
