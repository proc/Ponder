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
// Only games engines play on Lichess: a game you play yourself against an
// engine on this computer has no engine chat.
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
  if (g.stopped || g.ended) return;
  if (!ECD.due(g, ec.every)) return;
  // Due: made now, or as soon as the limits allow. Held back, it is about
  // the latest move when it goes out: a move played meanwhile takes its place.
  g.pending = { m, say };
  flushRemark(id, g);
}

// The remark waiting in a game, made if the limits allow it now; else it
// waits for them (and, while one is being written, for that one).
async function flushRemark(id, g) {
  clearTimeout(g.remarkTimer);
  if (!g.pending || !ec.on || g.stopped || g.ended) { g.pending = null; return; }
  const now = Date.now();
  const wait = ECD.replyDue({ ...g, replies: 0 }, now, ec.recent);
  if (wait !== true) { g.remarkTimer = setTimeout(() => flushRemark(id, g), wait); return; }
  const { m, say } = g.pending;
  g.pending = null;
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
    const { text } = await ECD.compose(ask, ECD.messages({ ...m, h2h: ecOpening(g) }, ec.persona));
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
    if (g.pending) flushRemark(id, g); // a move played while it was written
  }
}

// --- Your engine on Lichess -------------------------------------------------
// Its record against the opponent, as the player card shows it (Lichess's
// crosstable): read once a game, at its start, so that the engine greets
// the bots and people it has played before as such. Not known (not read yet, or Lichess did
// not answer), the messages just say nothing of it.
// The record goes with one message only, at the start of the game (the
// first or second message, as it may not be read yet for the first): said
// once, it is not brought up again.
function ecOpening(g) {
  g.messages = (g.messages ?? 0) + 1;
  if (g.h2hUsed || g.messages > 2 || !g.h2h) return null;
  g.h2hUsed = true;
  return g.h2h;
}
function ecRecord(g, opponent, me) {
  if (!ec.on || g.h2h !== undefined || !opponent) return;
  g.h2h = null;
  Promise.resolve(api.backend('lichessBotCrosstable', { opponent }))
    .then((ct) => { g.h2h = ECD.crosstableOf(ct, me || (typeof lx !== 'undefined' ? lx.status?.account?.username : '')); }, () => {});
}

// After each of its moves the backend says what the engine made of it.
window.engineChatBotMove = (m) => {
  if (!m?.gameId) return;
  ecRecord(ecGame(`bot:${m.gameId}`), m.opponent, m.me);
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
  ecRecord(g, game.opponent, lx.status.account?.username);
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
    const { text } = await ECD.compose(ask, ECD.replyMessages({ ...m, h2h: ecOpening(g) }, ec.persona, heard, lines));
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
  // A remark on a move still waiting: the last message takes its place.
  clearTimeout(g.remarkTimer);
  g.pending = null;
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
};
$('#ec-every').onchange = (e) => { ec.every = +e.target.value || 2; saveEngineChat(); };
// The personalities to choose from, then a random one each message, then the user's own.
for (const [key, s] of [...Object.entries(ECD.STYLES), ['random', { label: 'Random, a new one each message' }], ['custom', { label: 'Your own…' }]]) {
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

renderEngineChat();
