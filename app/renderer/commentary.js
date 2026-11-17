'use strict';
// Live commentary: while a game is being played (yours, an engine's, a
// Lichess game, a tournament game on the board), every few moves the AI
// model is sent the game as PGN (players, ratings, every move) and the position, and asked to
// comment as a chess commentator would; when the game ends it is asked for
// a summary. The comments show in a card beside the board and, in full, in
// the AI panel's Commentary view. The model is the one set in Settings → AI.

const cm = {
  on: false,
  every: 2,        // a comment every so many moves (a move: White's and Black's)
  feed: [],        // { ply, label, text, kind: 'comment' | 'summary', live, error }
  game: null,      // the game the feed is about
  lastPly: 0,      // the ply of the last comment asked for
  wasLive: false,  // the game was in progress when last looked at
  summed: false,
  busy: false,
  seq: 0,
  id: '',
  note: '',
  // Reading aloud: on or off, the voice by name ('' the computer's own
  // choice), and how fast.
  speak: false,
  voice: '',
  rate: 1,
  // Annotating: each comment goes on its move as an annotation of the game.
  annotate: false,
};
try {
  const saved = JSON.parse(localStorage.getItem('commentary') ?? '{}') ?? {};
  cm.on = Boolean(saved.on);
  if ([1, 2, 3, 5, 8].includes(+saved.every)) cm.every = +saved.every;
  cm.annotate = Boolean(saved.annotate);
  cm.speak = Boolean(saved.speak);
  cm.voice = String(saved.voice ?? '');
  if (+saved.rate >= 0.5 && +saved.rate <= 2) cm.rate = +saved.rate;
} catch { /* as new */ }
const saveCommentary = () => { try { localStorage.setItem('commentary', JSON.stringify({ on: cm.on, every: cm.every, speak: cm.speak, voice: cm.voice, rate: cm.rate, annotate: cm.annotate })); } catch { /* not kept */ } };

// --- Annotating the game ----------------------------------------------------
// A comment becomes the annotation of the move it followed; the summary,
// the comment before the first move. They are the AI's annotations: yours
// are never replaced, "Remove the AI's annotations" (under Annotate) takes
// them off, and Save writes them into the PGN.
function annotateFromComment(entry, { draw = true } = {}) {
  if (!cm.annotate || !entry || entry.error || entry.live || !entry.text || state?.game !== cm.game) return false;
  if (typeof annBlank !== 'function') return false;
  let used = false;
  if (entry.kind === 'summary') {
    // Only where there is none: an annotation already there is never replaced.
    if (!notes.before?.comment) { notes.before = { ...annBlank(), comment: entry.text, ai: true }; used = true; }
  } else if (entry.ply >= 1 && entry.ply <= state.moves.length) {
    const a = notes.moves.get(entry.ply) ?? annBlank();
    if (!a.comment) {
      a.comment = entry.text;
      a.ai = true;
      notes.moves.set(entry.ply, a);
      used = true;
    }
  }
  if (used) {
    notes.dirty = true;
    if (cm.model) notes.aiModel = cm.model;
    if (draw) renderMoves();
  }
  return used;
}
function setAnnotate(on) {
  cm.annotate = Boolean(on);
  saveCommentary();
  // Turned on with comments already made: they go on the game now.
  if (cm.annotate) {
    let any = false;
    for (const entry of cm.feed) any = annotateFromComment(entry, { draw: false }) || any;
    if (any) renderMoves();
  }
  renderCommentary();
}

// --- Reading aloud ----------------------------------------------------------
// The computer's own speech (its installed voices): nothing is sent anywhere.
// Or a speech server: an OpenAI-compatible text-to-speech endpoint set in
// Settings → AI, chosen as the voice "Speech server"; each comment's words
// go to it and the sound it answers with is played.
const cmCanSpeak = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
const cmVoices = () => (cmCanSpeak ? window.speechSynthesis.getVoices() : []);
const CM_SERVER = 'server:'; // the voice that is the speech server
const cmUsesServer = () => cm.voice === CM_SERVER;
const cmCanRead = () => cmCanSpeak || cmUsesServer() || Boolean(window.board?.tts);

// Chess notation as it is said: "Nf3" is "knight f3", "O-O" castles.
function cmSpoken(text) {
  const piece = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
  return String(text)
    .replace(/\bO-O-O\b/g, 'castles queenside').replace(/\bO-O\b/g, 'castles kingside')
    .replace(/\b(\d+)\.{3}\s*/g, '').replace(/\b(\d+)\.\s*(?=[KQRBNa-hO])/g, '')
    .replace(/\b([KQRBN])([a-h]?[1-8]?)(x?)([a-h][1-8])(=[QRBN])?([+#]?)/g, (_m, p, from, x, to, promo, end) =>
      `${piece[p]} ${from ? from + ' ' : ''}${x ? 'takes ' : ''}${to}${end === '#' ? ', checkmate' : end === '+' ? ', check' : ''}`)
    .replace(/\b([a-h])x([a-h][1-8])(=[QRBN])?([+#]?)/g, (_m, f, to, promo, end) =>
      `${f} takes ${to}${promo ? `, promoting to a ${piece[promo[1]]}` : ''}${end === '#' ? ', checkmate' : end === '+' ? ', check' : ''}`)
    .replace(/\b([a-h][1-8])=([QRBN])/g, (_m, sq, p) => `${sq}, promoting to a ${piece[p]}`)
    .replace(/\b([a-h][1-8])\+/g, '$1, check').replace(/\b([a-h][1-8])#/g, '$1, checkmate')
    .replace(/½-½|1\/2-1\/2/g, 'a draw').replace(/\b1-0\b/g, 'White wins').replace(/\b0-1\b/g, 'Black wins');
}

// Says a comment. A comment is never cut off by the next: the next waits
// for it to finish (one at most waits; a newer one takes its place), and no
// further comment is asked for while one is waiting, so the commentary does
// not fall behind the game. A comment played from its ▶ button, or the
// voice test, is said at once.
// The announcer (announcer.js) speaks with the same voice: its short lines
// and the comments take turns, its own first (they are about what has just
// happened), and a line that has waited too long is dropped.
function speakCommentary(text, { force = false } = {}) {
  if (!cmCanRead() || (!cm.speak && !force) || !String(text ?? '').trim()) return;
  if (force) { cm.pendingSpeech = ''; stopSpeaking(); }
  else if (cm.speaking) { cm.pendingSpeech = text; renderCommentary(); return; }
  cmSay(text, { voice: cm.voice, rate: cm.rate, comment: true });
}
// Says it now, with this voice (a computer voice by name, '' the
// computer's own, or the speech server) at this speed.
function cmSay(text, { voice = '', rate = 1, pitch = 1, comment = false } = {}) {
  if (voice === CM_SERVER) { speakFromServer(text, { rate, comment }); return; }
  if (!cmCanSpeak) return;
  const synth = window.speechSynthesis;
  const u = new SpeechSynthesisUtterance(cmSpoken(text));
  const v = cmVoices().find((x) => x.name === voice);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = rate;
  u.pitch = pitch;
  cm.speaking = true;
  cm.spokenText = comment ? text : '';
  cm.utterance = u; // kept, or it can be collected before it ends and say nothing of it
  u.onstart = () => renderCommentary();
  u.onend = u.onerror = () => cmSpeechDone(u);
  synth.speak(u);
}
// Something has been said (or could not be): an announcement waiting is
// next, then the comment waiting.
const cmAnnouncements = []; // { text, opts, at }
const CM_ANNOUNCE_STALE = 6000;
function cmSpeechDone(job) {
  if (cm.utterance !== job) return; // cancelled for another
  cm.utterance = null;
  cm.speaking = false;
  cm.spokenText = '';
  while (cmAnnouncements.length && performance.now() - cmAnnouncements[0].at > CM_ANNOUNCE_STALE) cmAnnouncements.shift();
  const ann = cmAnnouncements.shift();
  if (ann) cmSay(ann.text, ann.opts);
  else {
    const next = cm.pendingSpeech;
    cm.pendingSpeech = '';
    if (next) speakCommentary(next);
  }
  renderCommentary();
  // The comment that was waiting is being said: the next may be asked for.
  if (state) syncCommentary();
}
// An announcement: said now, or as soon as what is being said ends. Only
// the latest few wait: in a quick game the older ones are past.
function cmAnnounce(text, opts) {
  if (!String(text ?? '').trim()) return;
  if (!cm.speaking) { cmSay(text, opts); return; }
  cmAnnouncements.push({ text, opts, at: performance.now() });
  while (cmAnnouncements.length > 2) cmAnnouncements.shift();
}
window.cmAnnounce = cmAnnounce;
// The speech server: the sound is asked for, then played. It counts as
// being said from the moment it is asked for, so the next waits.
async function speakFromServer(text, { rate = 1, comment = false } = {}) {
  const job = { server: true };
  cm.utterance = job;
  cm.speaking = true;
  cm.spokenText = comment ? text : '';
  renderCommentary();
  try {
    const { type, data } = await api.tts.speak(cmSpoken(text), { speed: rate });
    if (cm.utterance !== job) return;
    const url = URL.createObjectURL(new Blob([data], { type }));
    const audio = new Audio(url);
    job.audio = audio;
    audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); cmSpeechDone(job); };
    await audio.play();
    if (cm.note.startsWith('Speech server:')) { cm.note = ''; renderCommentary(); }
  } catch (err) {
    if (cm.utterance !== job) return;
    cm.note = `Speech server: ${errorText(err)}`;
    cmSpeechDone(job);
  }
}
function stopSpeaking() {
  const job = cm.utterance;
  cm.utterance = null;
  cm.pendingSpeech = '';
  cmAnnouncements.length = 0;
  if (job?.audio) { job.audio.pause(); job.audio.src = ''; }
  if (cmCanSpeak) window.speechSynthesis.cancel();
  cm.speaking = false;
  cm.spokenText = '';
}
function setSpeak(on) {
  cm.speak = Boolean(on) && cmCanRead();
  saveCommentary();
  if (!cm.speak) stopSpeaking();
  else {
    // Turned on mid-game: the latest comment is read at once.
    const last = cm.feed.at(-1);
    if (last && !last.live && !last.error) speakCommentary(last.text);
  }
  renderCommentary();
}
// The voices arrive a little after the page: the list is filled when they do.
// The speech server is offered first after the computer's own choice.
function fillCommentaryVoices() {
  const sel = $('#cm-voice');
  const voices = cmVoices();
  // The voices of the app's language first, then the rest.
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const sorted = [...voices].sort((a, b) => (b.lang.toLowerCase().startsWith(lang) - a.lang.toLowerCase().startsWith(lang)) || a.name.localeCompare(b.name));
  const opts = [];
  if (cmCanSpeak) opts.push(el('option', { value: '', textContent: 'The computer’s voice' }));
  opts.push(el('option', { value: CM_SERVER, textContent: 'Speech server (Settings → AI)', title: 'An OpenAI-compatible text-to-speech endpoint, set in Settings → AI: each comment is sent to it' }));
  opts.push(...sorted.map((v) => el('option', { value: v.name, textContent: `${v.name} (${v.lang})` })));
  sel.replaceChildren(...opts);
  sel.value = cm.voice === CM_SERVER || sorted.some((v) => v.name === cm.voice) ? cm.voice : (cmCanSpeak ? '' : CM_SERVER);
}

// Settings → AI: the speech server.
const ttsSay = (text, bad = false) => { $('#tts-note').innerHTML = text; $('#tts-note').classList.toggle('error', bad); };
const TTS_NOTE = 'To use it, choose <b>Speech server</b> as the voice in the AI panel’s Commentary view, with <b>Read aloud</b> on. Each comment’s words are then sent to this endpoint and the sound it answers with is played.';
// The lists of the speech endpoint's models and voices, as last asked for.
const tts = { models: [], voices: [], openai: false };
const TTS_OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
function showTtsSettings(t) {
  $('#tts-url').value = t.baseUrl ?? '';
  tts.openai = /api\.openai\.com/i.test(t.baseUrl ?? '');
  fillChoices($('#tts-model'), tts.models, t.model ?? '', tts.openai ? 'gpt-4o-mini-tts (the default)' : 'The endpoint’s first speech model');
  // A server that does not list its voices: OpenAI's names, which servers
  // copying its API take.
  fillChoices($('#tts-voice'), tts.voices.length ? tts.voices : TTS_OPENAI_VOICES, t.voice ?? '', tts.openai ? 'alloy (the default)' : 'The model’s own voice');
  $('#tts-style').value = t.instructions ?? '';
  $('#tts-key').value = '';
  $('#tts-key').placeholder = t.hasKey ? 'A key is saved (type a new one to replace it)' : t.usesAiKey ? 'Using the OpenAI key above' : 'Not needed for most local servers';
}
async function fillTtsSettings() {
  try { showTtsSettings(await api.tts.settings()); ttsSay(TTS_NOTE); } catch { return; }
  refreshTtsModels({ quiet: true });
}
window.fillTtsSettings = fillTtsSettings;
async function saveTts(patch) {
  try { showTtsSettings(await api.tts.save(patch)); return true; } catch (err) { ttsSay(ttsEscape(errorText(err)), true); return false; }
}
const ttsEscape = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// The endpoint's models (its speech ones, when it says which) and the
// chosen model's voices, into the lists: quietly when the settings open,
// saying what was found when Refresh is pressed.
async function refreshTtsModels({ quiet = false } = {}) {
  const btn = $('#tts-check');
  btn.disabled = true;
  if (!quiet) ttsSay('Asking the speech endpoint for its models…');
  try {
    const { models, voices } = await api.tts.models();
    tts.models = models;
    tts.voices = voices;
    showTtsSettings(await api.tts.settings());
    // The model chosen may have voices of its own (oMLX lists them by model).
    if ($('#tts-model').value) await refreshTtsVoices();
    const list = (xs) => `${xs.slice(0, 4).map(ttsEscape).join(', ')}${xs.length > 4 ? ', …' : ''}`;
    if (!quiet || !models.length) {
      ttsSay(models.length
        ? `Connected: ${models.length} speech model${models.length === 1 ? '' : 's'} (${list(models)})${tts.voices.length ? ` and ${tts.voices.length} voice${tts.voices.length === 1 ? '' : 's'}` : ''}. Choose from the lists. ${TTS_NOTE}`
        : 'Connected, but the endpoint lists no models.', !models.length);
    }
  } catch (err) { if (!quiet) ttsSay(ttsEscape(errorText(err)), true); }
  btn.disabled = false;
}
async function refreshTtsVoices() {
  try {
    tts.voices = await api.tts.voices($('#tts-model').value);
    showTtsSettings(await api.tts.settings());
  } catch { /* the list stays as it was */ }
}
if (window.board?.tts) {
  $('#tts-url').addEventListener('change', async (e) => { tts.models = []; tts.voices = []; if (await saveTts({ baseUrl: e.target.value })) refreshTtsModels({ quiet: true }); });
  // Another model: its voices.
  $('#tts-model').addEventListener('change', async (e) => { if (await saveTts({ model: e.target.value })) refreshTtsVoices(); });
  $('#tts-voice').addEventListener('change', (e) => saveTts({ voice: e.target.value }));
  $('#tts-style').addEventListener('change', (e) => saveTts({ instructions: e.target.value }));
  $('#tts-key').addEventListener('change', async (e) => { if (e.target.value && await saveTts({ key: e.target.value })) refreshTtsModels({ quiet: true }); });
  $('#tts-check').onclick = async () => { if (await saveTts({ baseUrl: $('#tts-url').value })) refreshTtsModels(); };
  $('#tts-test').onclick = async () => {
    const btn = $('#tts-test');
    btn.disabled = true;
    ttsSay('Asking the speech endpoint…');
    const ok = await saveTts({ baseUrl: $('#tts-url').value, model: $('#tts-model').value, voice: $('#tts-voice').value, instructions: $('#tts-style').value });
    if (ok) {
      try {
        const { type, data } = await api.tts.speak('White plays knight f3, and Black answers with a solid move. The centre is still contested.', { speed: cm.rate });
        const url = URL.createObjectURL(new Blob([data], { type }));
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
        ttsSay(`Connected: playing ${Math.round(data.length / 1024)} KB of ${ttsEscape(type)}. ${TTS_NOTE}`);
      } catch (err) { ttsSay(ttsEscape(errorText(err)), true); }
    }
    btn.disabled = false;
  };
} else {
  for (const id of ['#tts-url', '#tts-model', '#tts-voice', '#tts-style', '#tts-key', '#tts-test', '#tts-check']) $(id).disabled = true;
}

const CM_SYSTEM = `You are a chess commentator calling a game live for viewers, the way a grandmaster does on a broadcast: knowledgeable, lively, clear.
You are given the players, every move played so far, the moves played since your last comment, the position now, and your earlier comments.
Make one point about what has just happened: the idea behind a move, a threat, a mistake, a fine move, or what to watch for next. The single most telling thing, not everything.
ONE sentence, at most 25 words, in the present tense, in plain text: no Markdown, no lists, no move-by-move recital, no greeting, no preamble. Answer at once, without thinking it over at length.
Do not repeat your earlier comments. Only speak of moves that have been played or are legal now. Where an engine evaluation is given, let it guide who stands better (positive favours White), without quoting numbers at length.`;

const CM_SUMMARY = `You are a chess commentator wrapping up a game that has just ended, for viewers who watched it.
You are given the players, every move, the final position, the result and how it ended, and the comments you made during the game.
Sum the game up in two or three sentences, at most 60 words, in plain text (no Markdown, no lists): how the game was shaped, the turning point, and how it was decided. Answer at once, without thinking it over at length.
Only speak of moves that were played. Where engine evaluations are given, let them guide your judgment.`;

const cmLive = () => Boolean(state?.players && (state.active || state.external?.live));

// The moves as text: "1. e4 e5 2. Nf3 …", from a ply (0: all of them).
function cmMoves(from = 0) {
  const out = [];
  for (let i = from; i < state.moves.length; i++) {
    const { n, white } = plyNumber(i + 1);
    if (white) out.push(`${n}.`);
    else if (i === from) out.push(`${n}...`);
    out.push(state.moves[i].san);
  }
  return out.join(' ');
}

// What the engines think, when something is known: the playing engine's
// own score after its last move, or the analysis of the position.
function cmEval() {
  const n = state.moves.length;
  for (let p = n; p >= Math.max(1, n - 1); p--) {
    const e = typeof engineScores !== 'undefined' ? engineScores[p] : null;
    if (e) return `${e.isMate ? `mate in ${Math.abs(e.mate)} for ${e.mate > 0 ? 'White' : 'Black'}` : `${(e.cp / 100).toFixed(2)} pawns`} (${e.name || 'engine'}, depth ${e.depth}, from White's side)`;
  }
  const data = typeof analysis !== 'undefined' ? analysis.data : null;
  if (data?.state === 'running' && data.fen === state.fen && data.lines?.[0]) {
    const l = data.lines[0];
    return `${formatScore(l)} (analysis, depth ${l.depth}, from White's side); best line ${(l.san ?? []).slice(0, 6).join(' ')}`;
  }
  return '';
}

function cmMessages(kind, from, pgn = '') {
  const white = state.players.white?.name || 'White';
  const black = state.players.black?.name || 'Black';
  const n = state.moves.length;
  const fen = n ? state.moves[n - 1].fen : state.startFen;
  const turn = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  const rated = (side) => { const r = state.players[side]?.rating; return r ? ` (${r})` : ''; };
  const parts = [`White: ${white}${rated('white')}\nBlack: ${black}${rated('black')}`];
  if (state.external?.label) parts.push(`Event: ${state.external.label}`);
  if (state.opening) parts.push(`Opening: ${state.opening}`);
  if (state.startFen && !/^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w KQkq/.test(state.startFen)) parts.push(`The game started from this position (FEN): ${state.startFen}`);
  // The whole game as PGN: its tags (the players' names and ratings, the
  // event, the time control, the opening) and its moves with any
  // annotations and engine evaluations. The plain move list when there is
  // no PGN to be had.
  if (pgn.trim()) parts.push(`The game as PGN:\n${pgn.trim()}`);
  else parts.push(`All the moves so far:\n${cmMoves(0) || '(none yet)'}`);
  if (kind === 'comment' && from > 0 && from < n) parts.push(`Played since your last comment:\n${cmMoves(from)}`);
  parts.push(`${kind === 'summary' ? 'The final position' : 'The position now'} (FEN): ${fen}`);
  if (kind === 'summary') parts.push(`Result: ${state.result}${state.reason ? ` (${state.reason})` : ''}.`);
  else parts.push(`${turn} is to move.`);
  const ev = cmEval();
  if (ev) parts.push(`Engine evaluation: ${ev}`);
  // A few of its own comments, so as not to repeat them: the fewer, the
  // less there is to read before it answers.
  const said = cm.feed.filter((c) => c.kind === 'comment' && c.text && !c.error).slice(kind === 'summary' ? -8 : -2);
  if (said.length) parts.push(`Your earlier comments:\n${said.map((c) => `- (${c.label}) ${c.text}`).join('\n')}`);
  parts.push(kind === 'summary' ? 'Now sum the game up, in two or three sentences.' : 'Now give your one-sentence comment on the latest moves.');
  return [{ role: 'system', content: kind === 'summary' ? CM_SUMMARY : CM_SYSTEM }, { role: 'user', content: parts.join('\n\n') }];
}

async function askCommentary(kind) {
  if (!api.ai?.chat) return;
  const n = state.moves.length;
  const from = cm.lastPly;
  const { n: num, white } = n ? plyNumber(n) : { n: 1, white: true };
  // The moves played since the last comment: the last of them is the move
  // this comment is about.
  const moves = [];
  for (let p = Math.max(0, Math.min(from, n)) + 1; p <= n; p++) {
    const at = plyNumber(p);
    moves.push({ ply: p, san: state.moves[p - 1].san, n: at.n, white: at.white });
  }
  const entry = {
    ply: n, from, kind, text: '', live: true, moves,
    label: kind === 'summary' ? `Summary · ${state.result.replace('1/2-1/2', '½-½')}` : n ? `After ${num}${white ? '.' : '…'} ${state.moves[n - 1].san}` : 'Before the first move',
  };
  cm.feed.push(entry);
  cm.lastPly = n;
  const id = cm.id = `c${++cm.seq}`;
  const game = state.game;
  cm.busy = true;
  cm.entry = entry;
  cm.note = '';
  renderCommentary();
  try {
    let pgn = '';
    try { pgn = await gamePgn(); } catch { /* no game to write: the moves go as a list */ }
    if (cm.id !== id) {
      // Overtaken while the PGN was being written (a new game, turned off).
      const at = cm.feed.indexOf(entry);
      if (at >= 0 && !entry.text) cm.feed.splice(at, 1);
      return;
    }
    const reply = await api.ai.chat(id, cmMessages(kind, from, pgn), 'commentary');
    entry.text = String(reply.text ?? '').replace(/\s+/g, ' ').trim();
    cm.model = reply.model ?? cm.model;
    window.aiNoteUsage?.(cm, reply); // the context meter
    entry.live = false;
    annotateFromComment(entry); // on its move, when annotating is on
    speakCommentary(entry.text); // read aloud, when that is on
  } catch (err) {
    const msg = errorText(err);
    if (msg === 'Stopped') {
      // Overtaken (the game ended, a new game, turned off): what there is stays.
      if (!entry.text) cm.feed.splice(cm.feed.indexOf(entry), 1);
    } else {
      entry.text = msg;
      entry.error = true;
      // An endpoint that does not answer is not asked again move after move.
      cm.on = false;
      saveCommentary();
      cm.note = 'Commentary was turned off: the AI endpoint did not answer. Retry asks again and turns it back on; Settings → AI has the endpoint.';
      if (typeof notify === 'function') notify(msg, { title: 'Live commentary stopped' });
    }
  } finally {
    entry.live = false;
    if (cm.id === id) { cm.busy = false; cm.entry = null; }
    renderCommentary();
    // Moves played while it was speaking may already call for the next one.
    if (cm.id === id && state?.game === game) syncCommentary();
  }
}

// Asks again for a comment the endpoint failed to give: the failed one goes,
// commentary is turned back on, and the new comment covers the moves the
// failed one would have, and any played since.
function retryCommentary(entry) {
  if (cm.busy || !entry?.error || state?.game !== cm.game) return;
  const at = cm.feed.indexOf(entry);
  if (at >= 0) cm.feed.splice(at, 1);
  cm.on = true;
  cm.note = '';
  saveCommentary();
  cm.lastPly = Math.max(0, Math.min(entry.from ?? cm.lastPly, state.moves.length));
  const over = !cmLive() && state.result && state.result !== '*';
  if (entry.kind === 'summary' || over) {
    // The game is over: what is owed is its summary.
    cm.summed = true;
    cm.wasLive = false;
    askCommentary('summary');
  } else {
    cm.wasLive = cmLive();
    askCommentary('comment');
  }
}

// A piece of a comment as it is written.
window.onAiCommentary = ({ id, delta }) => {
  if (id !== cm.id || !cm.entry || !delta) return;
  cm.entry.text += delta;
  renderCommentary();
};

// Called whenever the game changes: asks for a comment when it is due.
function syncCommentary() {
  if (!state) return;
  const live = cmLive();
  const n = state.moves?.length ?? 0;
  if (state.game !== cm.game) {
    // Another game: its own commentary, starting from where it stands.
    if (cm.busy) api.ai.chatCancel?.('commentary');
    // The last game's comment being said is finished; one waiting is not.
    cm.pendingSpeech = '';
    Object.assign(cm, { game: state.game, feed: [], lastPly: n, wasLive: live, summed: false, note: '', usage: null });
    renderCommentary();
  }
  if (n < cm.lastPly) cm.lastPly = n; // a takeback
  if (!cm.on) { cm.wasLive = live; renderCommentary(); return; }
  if (live) {
    cm.wasLive = true;
    // Not while a comment is waiting to be read aloud: the next one then
    // covers all the moves since, when it is its turn.
    if (!cm.busy && !cm.pendingSpeech && n - cm.lastPly >= cm.every * 2) askCommentary('comment');
  } else if (cm.wasLive && !cm.summed && n > 0 && state.result && state.result !== '*') {
    // The game has just ended: the summary takes over from any comment in the air.
    cm.summed = true;
    cm.wasLive = false;
    askCommentary('summary');
  } else cm.wasLive = false;
  renderCommentary();
}
window.syncCommentary = syncCommentary;

function setCommentary(on) {
  cm.on = Boolean(on);
  cm.note = '';
  saveCommentary();
  if (!cm.on && cm.busy) api.ai.chatCancel?.('commentary');
  if (!cm.on) stopSpeaking();
  if (cm.on && state) {
    // From here on: the first comment comes after the next few moves.
    cm.wasLive = cmLive();
    if (!cm.feed.length) cm.lastPly = Math.max(0, (state.moves?.length ?? 0) - Math.max(0, cm.every * 2 - 2));
    syncCommentary();
  }
  renderCommentary();
}

// A comment's row in the list, made once.
const cmRows = new WeakMap();
function cmRow(c) {
  let r = cmRows.get(c);
  if (r) return r;
  const label = el('span');
  const say = el('button', { type: 'button', className: 'cm-say', textContent: '▶', title: 'Read this comment aloud', hidden: true });
  say.setAttribute('aria-label', 'Read this comment aloud');
  say.onclick = () => speakCommentary(c.text, { force: true });
  const body = el('div', { className: 'cm-body' });
  const again = el('button', { type: 'button', className: 'small cm-retry', textContent: 'Retry', hidden: true });
  again.title = 'Ask the AI endpoint again for this comment, and turn commentary back on';
  again.onclick = () => retryCommentary(c);
  const row = el('div', { className: 'cm-item' }, [
    el('div', { className: 'cm-label' }, [label, say]),
    ...(c.moves?.length ? [cmMoveStrip(c)] : []),
    body, again,
  ]);
  r = { row, label, say, body, again };
  cmRows.set(c, r);
  return r;
}
function updateCmRow(c) {
  const r = cmRow(c);
  const cls = `cm-item ${c.kind}${c.error ? ' error' : ''}${c.live ? ' live' : ''}`;
  if (r.row.className !== cls) r.row.className = cls;
  if (r.label.textContent !== c.label) r.label.textContent = c.label;
  aicSoftText(r.body, c.text); // the newest words fade in; the rest stay put
  r.say.hidden = !(cmCanRead() && c.text && !c.live && !c.error);
  r.again.hidden = !c.error;
  r.again.disabled = cm.busy;
}

// The moves a comment covers, in a row: those played since the comment
// before it, the last one (the move the comment is for) picked out. A
// click goes to that move on the board.
function cmMoveStrip(c) {
  const chips = c.moves.map((m, i) => {
    const last = i === c.moves.length - 1 && c.kind === 'comment';
    const num = m.white ? `${m.n}. ` : i === 0 ? `${m.n}… ` : '';
    const chip = el('button', { type: 'button', className: 'cm-move' + (last ? ' for' : '') }, [
      ...(num ? [el('span', { className: 'cm-num', textContent: num })] : []), m.san,
    ]);
    chip.title = last ? `The move this comment is about: ${m.n}${m.white ? '.' : '…'} ${m.san}. Click to show it on the board`
      : `Played before the comment: ${m.n}${m.white ? '.' : '…'} ${m.san}. Click to show it on the board`;
    chip.onclick = () => { if (state?.game === cm.game) showPly(m.ply); };
    return chip;
  });
  return el('div', { className: 'cm-moves' }, [
    el('span', { className: 'cm-moves-k', textContent: c.kind === 'summary' ? 'Last moves' : c.moves.length > 1 ? 'Moves' : 'Move' }),
    ...chips,
  ]);
}

function renderCommentary() {
  // The card beside the board: the latest comment.
  const card = $('#commentary');
  // While the next comment is being thought of, the one before stays.
  let last = cm.feed.at(-1);
  const thinking = Boolean(last?.live && !last.text);
  if (thinking && cm.feed.length > 1) last = cm.feed.at(-2);
  const show = Boolean(state?.players) && (cm.on || cm.feed.length > 0);
  if (card.hidden !== !show) card.hidden = !show;
  if (show) {
    $('#cm-at').textContent = last?.label ?? '';
    const text = $('#cm-text');
    const body = last ? last.text : cmLive() ? `Commentary is on: the first comment comes after ${cm.every === 1 ? 'the next move' : `the next ${cm.every} moves`}.` : 'Commentary is on: it starts with the next game played.';
    // The same comment growing: its new words fade in. Another comment, or
    // the hint: set plainly.
    const of = last ? `${cm.game}:${cm.feed.indexOf(last)}` : '';
    if (text.dataset.of !== of) { text.dataset.of = of; text.dataset.text = ''; text.textContent = ''; }
    if (last) aicSoftText(text, body); else if (text.textContent !== body) { text.textContent = body; text.dataset.text = body; }
    text.classList.toggle('live', Boolean(last?.live) || thinking);
    text.classList.toggle('waiting', Boolean(last?.live && !last.text));
    text.classList.toggle('error', Boolean(last?.error));
    text.classList.toggle('hint', !last);
    card.classList.toggle('summary', last?.kind === 'summary');
    // A comment that failed can be asked for again from the card too.
    const again = $('#cm-retry');
    again.hidden = !last?.error;
    again.disabled = cm.busy;
    again.onclick = () => retryCommentary(last);
  }
  // Reading aloud: the card's speaker, and the panel's controls.
  const spk = $('#cm-speak-btn');
  spk.setAttribute('aria-pressed', String(cm.speak));
  spk.classList.toggle('on', cm.speak);
  spk.classList.toggle('speaking', Boolean(cm.speaking));
  spk.disabled = !cmCanRead();
  spk.title = !cmCanRead() ? 'This computer has no speech to read with' : cm.speak ? 'Reading the commentary aloud: click to stop' : 'Read the commentary aloud';
  $('#cm-annotate').checked = cm.annotate;
  $('#cm-speak').checked = cm.speak;
  $('#cm-speak').disabled = !cmCanRead();
  for (const id of ['#cm-voice', '#cm-rate', '#cm-test']) $(id).disabled = !cmCanRead();
  $('#cm-rate').value = String(cm.rate);
  // The AI panel's Commentary view: all of it, and the controls.
  $('#cm-on').checked = cm.on;
  $('#cm-every').value = String(cm.every);
  $('#ai-views').classList.toggle('cm-live', cm.on && cmLive());
  const feed = $('#cm-feed');
  const atEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  // Each comment keeps its row: it is made once and then only what has
  // changed in it is touched, so that the words being written fade in and
  // nothing else in the list moves.
  const rows = cm.feed.map((c) => { updateCmRow(c); return cmRow(c).row; });
  if (!rows.length) {
    const empty = cm.on
      ? (cmLive() ? 'Listening to the game: the first comment comes after the next few moves.' : 'Commentary starts with the next game that is played: yours, an engine’s, a Lichess game or a tournament game on the board.')
      : 'Turn live commentary on and the AI model comments on the game every few moves as it is played, and sums it up when it ends.';
    const hint = feed.querySelector('.cm-empty') ?? el('p', { className: 'hint cm-empty' });
    if (hint.textContent !== empty) hint.textContent = empty;
    rows.push(hint);
  }
  const grew = rows.length !== feed.children.length;
  aicSync(feed, rows);
  if (atEnd && (grew || cm.busy)) feed.scrollTop = feed.scrollHeight;
  $('#cm-note').textContent = cm.note || 'Each comment sends the model the game so far as PGN (the players, their ratings and every move) and the position now (Settings → AI sets the model).';
  $('#cm-note').classList.toggle('error', Boolean(cm.note));
  window.renderCommentator?.(); // Pip, when on, says it instead of the card
}

// The panel's two views.
function showAiView(view) {
  $('#pane-ai').dataset.view = view;
  for (const b of $('#ai-views').querySelectorAll('button')) {
    const on = b.dataset.view === view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  try { localStorage.setItem('aiView', view); } catch { /* not kept */ }
  window.renderAiContext?.();
  if (view === 'commentary') { renderCommentary(); $('#cm-feed').scrollTop = $('#cm-feed').scrollHeight; } else window.openAiChat?.(false);
}
for (const b of $('#ai-views').querySelectorAll('button')) b.onclick = () => showAiView(b.dataset.view);
$('#cm-on').onchange = (e) => setCommentary(e.target.checked);
$('#cm-every').onchange = (e) => { cm.every = +e.target.value || 2; saveCommentary(); syncCommentary(); };
// The card opens the full commentary in the panel.
$('#cm-open').onclick = () => { showAiView('commentary'); setAiPanel(true, { focus: false }); };
$('#cm-off').onclick = () => setCommentary(false);
$('#cm-annotate').onchange = (e) => setAnnotate(e.target.checked);
$('#cm-speak').onchange = (e) => setSpeak(e.target.checked);
$('#cm-speak-btn').onclick = () => setSpeak(!cm.speak);
$('#cm-voice').onchange = (e) => { stopSpeaking(); cm.voice = e.target.value; saveCommentary(); renderCommentary(); };
$('#cm-rate').onchange = (e) => { cm.rate = +e.target.value || 1; saveCommentary(); };
$('#cm-test').onclick = () => speakCommentary('White plays Nf3, and Black answers with a solid move. The centre is still contested.', { force: true });
fillCommentaryVoices();
if (cmCanSpeak) {
  window.speechSynthesis.addEventListener?.('voiceschanged', fillCommentaryVoices);
  // Nothing is left talking when the window goes.
  window.addEventListener('beforeunload', () => stopSpeaking());
}

showAiView(localStorage.getItem('aiView') === 'commentary' ? 'commentary' : 'chat');
if (state) syncCommentary(); else renderCommentary();
