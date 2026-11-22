'use strict';
// Engine chat: in the games an engine plays, it answers its opponent's moves
// in the game chat, every few moves, in character. The AI model (the one set
// in Settings → AI, as for live commentary) writes each message from what
// the engine itself made of the position: its evaluation, its move and the
// line it expects.
//
// - Your engine's games on Lichess (the bot): the message is posted in both
//   rooms of the game's chat, the players' (for its opponent) and the
//   spectators' (for those watching). Every game the engine plays counts,
//   on the board or not.
//   When its opponent writes to it in either room, it answers there, in
//   character (at most ECD.MAX_REPLIES answers a game).
// - A game on this computer between you and an engine: the message shows in
//   the game's chat card beside the board. Nothing is posted anywhere.
//
// Nothing here holds up the engine: a message is asked for only once its
// move has been played. A message may be up to 400 characters: Lichess takes
// 140 a message, so a longer one goes in parts, split between sentences.
// Messages are rate-limited.
// Off unless turned on, in the AI panel's Commentary view.

const ECD = window.engineChatData;
const ec = {
  on: false,
  every: 2,
  persona: { name: '', style: 'friendly', custom: '' }, // who it is in the chat, and how it talks
  games: new Map(), // game id -> { count, at, busy }
  recent: [],       // when the last messages were made, all games together
  note: '',
  // The chat of the game on this computer: { game, lines, me }.
  local: null,
};
try {
  const saved = JSON.parse(localStorage.getItem('engineChat') ?? '{}') ?? {};
  ec.on = Boolean(saved.on);
  if (ECD.EVERY.includes(+saved.every)) ec.every = +saved.every;
  // An old setting kept one string (persona): a name or a few words on its character.
  ec.persona = ECD.characterOf('style' in saved ? { name: saved.name, style: saved.style, custom: saved.custom } : saved.persona);
} catch { /* as new */ }
const saveEngineChat = () => { try { localStorage.setItem('engineChat', JSON.stringify({ on: ec.on, every: ec.every, ...ec.persona })); } catch { /* not kept */ } };

// The game's own record of what was said.
function ecGame(id) {
  let g = ec.games.get(id);
  if (!g) {
    g = { count: 0, at: 0, busy: false, stopped: false };
    ec.games.set(id, g);
    // Only the last few games are remembered.
    if (ec.games.size > 40) ec.games.delete(ec.games.keys().next().value);
  }
  return g;
}

// A message in the posts it goes in (Lichess takes 140 characters a
// message), one after another, a moment apart so that they arrive in order
// and are not taken for flooding. Each post after the first counts as a
// message more under the minute's limit.
const EC_PART_GAP_MS = 1200;
async function postParts(text, post) {
  const parts = ECD.split(text);
  for (const [i, part] of parts.entries()) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, EC_PART_GAP_MS));
      ec.recent.push(Date.now());
    }
    await post(part);
  }
}

// The engine has played its move: a message, if one is due. m is what the
// engine made of it; say(text) posts the message where it belongs.
async function engineRemark(id, m, say) {
  if (!ec.on || !api.ai?.chat || !m?.last) return; // the first move answers nothing
  const g = ecGame(id);
  if (g.stopped) return;
  const now = Date.now();
  if (!ECD.due(g, ec.every, now, ec.recent)) return;
  g.count = 0;
  g.at = now;
  g.busy = true;
  ec.recent = [...ec.recent.filter((t) => now - t < 60000), now];
  try {
    // A channel of its own for each game: one game's message does not cut
    // off another's, nor the live commentary or the chat.
    // Asked to keep within 400 characters (posted in parts of at most 140),
    // with a cap on the answer; asked again once if it does not, cut to fit
    // at a sentence or word as a last resort.
    const ask = (messages) => api.ai.chat(`ec:${id}:${m.ply}`, messages, `engine-chat:${id}`, { maxTokens: ECD.MAX_TOKENS });
    const { text } = await ECD.compose(ask, ECD.messages(m, ec.persona));
    if (text) {
      // Posting it may fail (Lichess limits how often one may post): said,
      // and the engine goes on talking at its next message.
      try {
        await postParts(text, say);
      } catch (err) {
        // "not posted in the players' chat: …", or "not posted: …" (neither room).
        ec.note = `The engine’s last message was ${errorText(err)}`;
        renderEngineChat();
        return;
      }
    }
    if (ec.note) { ec.note = ''; renderEngineChat(); }
  } catch (err) {
    const msg = errorText(err);
    if (msg !== 'Stopped') {
      // Not asked again in this game: an endpoint that fails would fail at
      // every move. The next game tries again.
      g.stopped = true;
      ec.note = `The engine’s chat stopped in this game: ${msg}`;
      renderEngineChat();
    }
  } finally {
    g.busy = false;
  }
}

// --- Your engine on Lichess -------------------------------------------------
// After each of its moves the backend says what the engine made of it.
window.engineChatBotMove = (m) => {
  if (!m?.gameId) return;
  ecGame(`bot:${m.gameId}`).last = { ...m, lichess: true }; // for answers to its opponent's chat
  engineRemark(`bot:${m.gameId}`, { ...m, lichess: true }, (text) => api.backend('lichessBotRemark', { id: m.gameId, text }));
};

// Its opponent wrote in the game's chat (players' or spectators' room): the
// engine answers there, in character. ev is the backend's lichessChat event.
window.engineChatHeard = (ev) => {
  const line = ev?.line;
  if (!ec.on || !api.ai?.chat || !line || line.mine || line.system || !line.text) return;
  const game = (lx.status.games ?? []).find((x) => x.id === ev.gameId && x.playing && !x.finished);
  if (!game || String(line.user ?? '').toLowerCase() !== String(game.opponent ?? '').toLowerCase()) return;
  const g = ecGame(`bot:${game.id}`);
  if (g.stopped) return;
  // Said again before the answer went out: the answer is to the latest.
  g.heard = { text: line.text, room: line.room === 'spectator' ? 'spectator' : 'player' };
  engineReply(game.id, g);
};

async function engineReply(id, g) {
  clearTimeout(g.replyTimer);
  const now = Date.now();
  const due = ECD.replyDue(g, now, ec.recent);
  if (due === false || !g.heard) return;
  if (due !== true) { g.replyTimer = setTimeout(() => engineReply(id, g), due); return; }
  const game = (lx.status.games ?? []).find((x) => x.id === id && x.playing && !x.finished);
  if (!game || !ec.on) return;
  const heard = g.heard;
  g.heard = null;
  g.at = now;
  g.busy = true;
  g.replies = (g.replies ?? 0) + 1;
  ec.recent = [...ec.recent.filter((t) => now - t < 60000), now];
  // What the engine last made of the game; before its first move, what the
  // game list says.
  const m = g.last ?? {
    gameId: id, lichess: true, me: lx.status.account?.username ?? '', engine: '', opponent: game.opponent,
    opponentRating: game.opponentRating, opponentTitle: game.opponentTitle, side: game.color, rated: game.rated, speed: game.speed,
    fen: game.fen ?? '', moves: [],
  };
  try {
    // The chat before it, for the conversation (the line itself is the last).
    const view = await api.backend('lichessChat', { id }).catch(() => null);
    const lines = (view?.lines ?? []).filter((l) => !l.system);
    if (lines.length && lines.at(-1).text === heard.text) lines.pop();
    const ask = (messages) => api.ai.chat(`ecr:${id}:${g.replies}`, messages, `engine-reply:${id}`, { maxTokens: ECD.MAX_TOKENS });
    const { text } = await ECD.compose(ask, ECD.replyMessages(m, ec.persona, heard, lines));
    if (text) {
      try {
        await postParts(text, (part) => api.backend('lichessChatSend', { id, room: heard.room, text: part }));
      } catch (err) {
        ec.note = `The engine’s last answer was not posted: ${errorText(err)}`;
        renderEngineChat();
        return;
      }
    }
    if (ec.note) { ec.note = ''; renderEngineChat(); }
  } catch (err) {
    const msg = errorText(err);
    if (msg !== 'Stopped') {
      g.stopped = true;
      ec.note = `The engine’s chat stopped in this game: ${msg}`;
      renderEngineChat();
    }
  } finally {
    g.busy = false;
    // Something more was said meanwhile: answered in turn, within the limits.
    if (g.heard) engineReply(id, g);
  }
}

// The game is over: one last message, on how it ended and how it went.
// Asked for once the limits allow (it waits for them rather than being
// dropped), and not held back by the count of answers.
async function engineGameEnd(key, e, say) {
  if (!ec.on || !api.ai?.chat) return;
  const g = ecGame(key);
  if (g.stopped || g.ended) return;
  clearTimeout(g.endTimer);
  const now = Date.now();
  const due = ECD.replyDue({ ...g, replies: 0 }, now, ec.recent);
  if (due !== true) { g.endTimer = setTimeout(() => engineGameEnd(key, e, say), due); return; }
  g.ended = true;
  g.at = now;
  g.busy = true;
  ec.recent = [...ec.recent.filter((t) => now - t < 60000), now];
  try {
    const ask = (messages) => api.ai.chat(`ece:${key}`, messages, `engine-end:${key}`, { maxTokens: ECD.MAX_TOKENS });
    const { text } = await ECD.compose(ask, ECD.endMessages(e, ec.persona));
    if (text) {
      try {
        await postParts(text, say);
      } catch (err) {
        ec.note = `The engine’s last message was ${errorText(err)}`;
        renderEngineChat();
        return;
      }
    }
    if (ec.note) { ec.note = ''; renderEngineChat(); }
  } catch (err) {
    const msg = errorText(err);
    if (msg !== 'Stopped') {
      ec.note = `The engine’s last message in this game was not written: ${msg}`;
      renderEngineChat();
    }
  } finally {
    g.busy = false;
  }
}

// Your engine's game on Lichess is over (not aborted): to its opponent and
// the spectators, as its other messages.
window.engineChatGameEnd = (e) => {
  if (!e?.gameId) return;
  engineGameEnd(`bot:${e.gameId}`, { ...e, lichess: true }, (text) => api.backend('lichessBotRemark', { id: e.gameId, text }));
};

// --- A game on this computer ------------------------------------------------
// You against an engine, being played: the engine is the one side that is
// an engine.
function localEngineGame(over = false) {
  if ((!over && !state?.active) || !state || state.external || puzzleView) return null;
  const w = state.players?.white;
  const b = state.players?.black;
  const we = w?.type === 'engine';
  const be = b?.type === 'engine';
  if (we === be) return null;
  return { side: we ? 'white' : 'black', engine: we ? w : b, opponent: we ? b : w };
}

// Called whenever the game changes: the engine's move just played, if it
// answered one of yours.
function syncEngineChat() {
  // Just over: the engine's last message (the game it was chatting in).
  const ended = localEngineGame(true);
  if (ended && ec.on && ec.local?.game === state.game && !state.active && state.result && state.result !== '*') {
    localGameEnd(ended);
    return;
  }
  const local = localEngineGame();
  if (!local || !ec.on) {
    // Its chat stays while the game is on the board, and goes with it.
    if (ec.local && ec.local.game !== state?.game) { ec.local = null; window.syncChat?.(); }
    return;
  }
  if (ec.local?.game !== state.game) {
    ec.local = { game: state.game, lines: [], me: '', handled: state.moves.length, evals: [], ended: false };
    window.syncChat?.();
  }
  const n = state.moves.length;
  if (n <= ec.local.handled) { ec.local.handled = n; return; } // a takeback
  ec.local.handled = n;
  // The move just played is the engine's: White's when n is odd from the
  // usual start, else as the position says.
  const after = state.moves[n - 1];
  const moverWhite = (after.fen ?? '').split(' ')[1] === 'b';
  if ((local.side === 'white') !== moverWhite || n < 2) return;
  const before = state.moves[n - 2];
  // What the engine made of it: its last line in that position.
  const info = engineInfo[local.side];
  const fresh = info && info.ply === n - 1;
  const name = local.engine.name || 'Engine';
  const m = {
    gameId: String(state.game), engine: name, me: name, opponent: local.opponent.name || 'You',
    side: local.side, rated: false, ply: n - 1, fen: before.fen,
    moves: state.moves.slice(0, n - 1).map((x) => x.san), last: before.san, move: after.san,
    hasEval: Boolean(fresh && info.hasEval), cp: fresh ? info.cp : 0, isMate: Boolean(fresh && info.isMate), mate: fresh ? info.mate : 0,
    depth: fresh ? info.depth : 0, pv: fresh ? info.pv ?? [] : [],
  };
  if (m.pv.length && m.pv[0] !== m.move) m.pv = [m.move]; // a line for another move says nothing of this one
  // For the recap at the end: what the engine thought at each of its moves.
  if (m.hasEval) ec.local.evals.push({ ply: n - 1, move: after.san, cp: m.cp, isMate: m.isMate, mate: m.mate });
  const game = state.game;
  engineRemark(`local:${game}`, m, (text) => {
    if (ec.local?.game !== game) return;
    ec.local.lines.push({ room: 'player', user: ECD.personaOf(m, ec.persona), text, at: Date.now(), engine: true });
    window.engineChatLocalLine?.();
  });
}

// The game on this computer is over (decided, not abandoned): the engine's
// last message, in the game's chat card.
function localGameEnd(local) {
  const result = state?.result;
  if (!ec.local || ec.local.ended || !result || result === '*' || state.active) return;
  ec.local.ended = true;
  const n = state.moves.length;
  if (n < 2) return;
  const won = result === '1-0' ? 'white' : result === '0-1' ? 'black' : '';
  const name = local.engine.name || 'Engine';
  const last = state.moves[n - 1];
  const e = {
    gameId: String(state.game), engine: name, me: name, opponent: local.opponent.name || 'You', side: local.side, rated: false,
    result, reason: state.reason ?? '', outcome: !won ? 'drawn' : won === local.side ? 'won' : 'lost',
    moves: state.moves.map((x) => x.san), fen: last.fen, opening: last.opening ?? '', evals: ec.local.evals,
  };
  const game = state.game;
  engineGameEnd(`local:${game}`, e, (text) => {
    if (ec.local?.game !== game) return;
    ec.local.lines.push({ room: 'player', user: ECD.personaOf(e, ec.persona), text, at: Date.now(), engine: true });
    window.engineChatLocalLine?.();
  });
}

// The chat card asks for the game on this computer's chat: null when it
// has none (engine chat off, or not a game against an engine).
window.engineChatLocal = () => (ec.on && ec.local && ec.local.game === state?.game ? ec.local : null);

// --- Settings (the AI panel's Commentary view) ------------------------------
function renderEngineChat() {
  $('#ec-on').checked = ec.on;
  $('#ec-every').value = String(ec.every);
  for (const id of ['#ec-every', '#ec-name', '#ec-style', '#ec-custom']) $(id).disabled = !ec.on;
  const name = $('#ec-name');
  if (document.activeElement !== name && name.value !== ec.persona.name) name.value = ec.persona.name;
  $('#ec-style').value = ec.persona.style;
  const custom = $('#ec-custom');
  custom.closest('.cm-row').hidden = ec.persona.style !== 'custom';
  if (document.activeElement !== custom && custom.value !== ec.persona.custom) custom.value = ec.persona.custom;
  const note = $('#ec-note');
  note.hidden = !ec.note;
  note.textContent = ec.note;
}

$('#ec-on').onchange = (e) => {
  ec.on = e.target.checked;
  ec.note = '';
  // From here on: the first message comes after the next few moves.
  for (const g of ec.games.values()) { g.count = 0; g.stopped = false; }
  saveEngineChat();
  renderEngineChat();
  syncEngineChat();
  window.syncChat?.();
};
$('#ec-every').onchange = (e) => { ec.every = +e.target.value || 2; saveEngineChat(); };
// The personalities to choose from, then the user's own.
for (const [key, s] of [...Object.entries(ECD.STYLES), ['custom', { label: 'Your own…' }]]) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = s.label;
  $('#ec-style').append(o);
}
$('#ec-name').oninput = (e) => { ec.persona.name = e.target.value.slice(0, ECD.NAME_MAX); saveEngineChat(); };
$('#ec-style').onchange = (e) => {
  ec.persona.style = e.target.value;
  saveEngineChat();
  renderEngineChat();
  if (ec.persona.style === 'custom' && !ec.persona.custom) $('#ec-custom').focus();
};
$('#ec-custom').oninput = (e) => { ec.persona.custom = e.target.value.slice(0, ECD.CUSTOM_MAX); saveEngineChat(); };
// Typing stays in the boxes: letters are not shortcuts here.
for (const id of ['#ec-name', '#ec-custom']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); e.stopPropagation(); });
}

window.syncEngineChat = syncEngineChat;
renderEngineChat();
if (state) syncEngineChat();
