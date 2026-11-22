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
// - A game on this computer between you and an engine: the message shows in
//   the game's chat card beside the board. Nothing is posted anywhere.
//
// Nothing here holds up the engine: a message is asked for only once its
// move has been played. The model is asked to keep within the 140
// characters Lichess takes; messages are rate-limited.
// Off unless turned on, in the AI panel's Commentary view.

const ECD = window.engineChatData;
const ec = {
  on: false,
  every: 2,
  persona: '',
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
  ec.persona = String(saved.persona ?? '').slice(0, 200);
} catch { /* as new */ }
const saveEngineChat = () => { try { localStorage.setItem('engineChat', JSON.stringify({ on: ec.on, every: ec.every, persona: ec.persona })); } catch { /* not kept */ } };

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
    // Asked to keep within Lichess's 140 characters, with a small cap on
    // the answer; asked again once if it does not, cut to fit at a
    // sentence or word as a last resort.
    const ask = (messages) => api.ai.chat(`ec:${id}:${m.ply}`, messages, `engine-chat:${id}`, { maxTokens: ECD.MAX_TOKENS });
    const { text } = await ECD.compose(ask, ECD.messages(m, ec.persona));
    if (text) {
      // Posting it may fail (Lichess limits how often one may post): said,
      // and the engine goes on talking at its next message.
      try {
        await say(text);
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
  engineRemark(`bot:${m.gameId}`, { ...m, lichess: true }, (text) => api.backend('lichessBotRemark', { id: m.gameId, text }));
};

// --- A game on this computer ------------------------------------------------
// You against an engine, being played: the engine is the one side that is
// an engine.
function localEngineGame() {
  if (!state?.active || state.external || puzzleView) return null;
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
  const local = localEngineGame();
  if (!local || !ec.on) {
    // Its chat stays while the game is on the board, and goes with it.
    if (ec.local && ec.local.game !== state?.game) { ec.local = null; window.syncChat?.(); }
    return;
  }
  if (ec.local?.game !== state.game) {
    ec.local = { game: state.game, lines: [], me: '', handled: state.moves.length };
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
  const game = state.game;
  engineRemark(`local:${game}`, m, (text) => {
    if (ec.local?.game !== game) return;
    ec.local.lines.push({ room: 'player', user: ECD.personaOf(m, ec.persona), text, at: Date.now(), engine: true });
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
  for (const id of ['#ec-every', '#ec-persona']) $(id).disabled = !ec.on;
  const persona = $('#ec-persona');
  if (document.activeElement !== persona && persona.value !== ec.persona) persona.value = ec.persona;
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
$('#ec-persona').oninput = (e) => { ec.persona = e.target.value.slice(0, 200); saveEngineChat(); };
// Typing stays in the box: letters are not shortcuts here.
$('#ec-persona').addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); e.stopPropagation(); });

window.syncEngineChat = syncEngineChat;
renderEngineChat();
if (state) syncEngineChat();
