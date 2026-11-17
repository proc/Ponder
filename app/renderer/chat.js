// Chat in a Lichess game on the board: the players' room and the
// spectators' room, where the people watching talk. Lichess gives the chat
// only to the accounts in the game, so it works for your own games and your
// engine's; a game you only watch has its chat on Lichess itself.

const CHAT_MAX = 140;

const chat = {
  gameId: null,
  kind: null, // bot, play, spectate
  view: null, // what the backend knows of the chat, or null
  loading: false,
  room: 'spectator',
  lines: [],
  unread: { player: 0, spectator: 0 },
  sending: false,
  error: '',
  drawn: '', // what the message list shows
};

const chatKinds = new Set(['bot', 'play', 'spectate']);

// In your engine's games and your own the chat floats over the app, in its
// own window at the top right (a game you only watch has no chat to show:
// its note stays in the side column).
const chatFloat = floatWindow($('#chat'), {
  key: 'chatFloat', name: 'chat', head: $('#chat .chat-head'),
  size: { w: 340, h: 360 },
  start: (w) => ({ x: window.innerWidth - w - 16, y: 64 }),
  pill: () => {
    const unread = chat.unread.player + chat.unread.spectator;
    return [el('span', { className: 'pill-name', textContent: 'Chat' }),
      ...(unread ? [el('span', { className: 'chat-unread', textContent: String(unread) })] : [])];
  },
});
const chatFloats = () => chat.kind === 'bot' || chat.kind === 'play';

// Called whenever the game on the board changes.
function syncChat() {
  const ext = state?.external;
  const id = ext && chatKinds.has(ext.kind) ? ext.id : null;
  if (id !== chat.gameId || (ext && ext.kind !== chat.kind)) {
    Object.assign(chat, {
      gameId: id, kind: ext?.kind ?? null, view: null, lines: [], error: '', sending: false,
      unread: { player: 0, spectator: 0 },
      // Watching your engine, you talk with the others watching; in your own
      // game, with your opponent.
      room: ext?.kind === 'play' ? 'player' : 'spectator',
    });
    $('#chat-text').value = '';
    chat.drawn = '';
    if (id) loadChat(id);
    // A new game brings the window back, open.
    if (id && chatFloats()) chatFloat.reopen();
  }
  renderChat();
}

async function loadChat(id) {
  chat.loading = true;
  let view = null;
  try {
    view = await api.backend('lichessChat', { id });
  } catch { /* shown as unavailable */ }
  if (chat.gameId !== id) return;
  chat.loading = false;
  chat.view = view;
  if (view) chat.lines = view.lines ?? [];
  renderChat();
}

function lichessChatEvent(ev) {
  if (ev.gameId !== chat.gameId) return;
  if (!chat.view) { loadChat(ev.gameId); return; } // the game was not known yet
  if (ev.lines) {
    chat.lines = ev.lines;
  } else if (ev.line) {
    chat.lines.push(ev.line);
    if (ev.line.room !== chat.room && !ev.line.mine && !ev.line.system) chat.unread[ev.line.room]++;
  }
  renderChat();
}

function chatLineNode(line) {
  const node = el('div', { className: 'chat-line' });
  if (line.mine) node.classList.add('mine');
  if (line.system) node.classList.add('system');
  if (!line.at) node.classList.add('earlier');
  else node.title = new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!line.system) {
    const flag = flagSpan(line.user);
    if (flag) node.append(flag);
    node.append(el('span', { className: 'chat-user', textContent: line.user }));
  }
  node.append(document.createTextNode(line.text));
  return node;
}

function chatEmpty(text, link) {
  const p = el('p', { className: 'hint chat-empty', textContent: text });
  if (link) p.append(' ', lxLink(link, 'Open the game on Lichess ↗'));
  return p;
}

function renderChat() {
  const card = $('#chat');
  if (!chat.gameId) {
    if (!card.hidden) card.hidden = true;
    chatFloat.set(false);
    return;
  }
  if (card.hidden) card.hidden = false;
  chatFloat.set(chatFloats());
  const ext = state?.external;
  const usable = Boolean(chat.view);
  const box = $('#chat-lines');
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 24;

  // With only a note to show, the card is as tall as the note.
  if (card.classList.contains('collapsed') === usable) card.classList.toggle('collapsed', !usable);
  $('#chat-rooms').hidden = !usable;
  for (const b of $('#chat-rooms').querySelectorAll('button')) {
    const on = b.dataset.room === chat.room;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.querySelector('.chat-unread').textContent = chat.unread[b.dataset.room] || '';
  }

  // The messages are only drawn again when they changed, so that text
  // selected in them stays selected while the game goes on.
  const drawn = [chat.room, usable, chat.loading, chat.lines.length, chat.lines.at(-1)?.at, ext?.url].join('|');
  if (drawn === chat.drawn) {
    // nothing to draw
  } else if (!usable) {
    let text = 'Loading the chat…';
    if (chat.loading) {
      // wait for the answer
    } else if (chat.kind === 'spectate') {
      text = 'Lichess lets apps chat only in games your own account or your engine is playing, so this game\'s chat cannot be shown or written to here.';
    } else if (!chat.loading) {
      text = 'The chat of this game is not available: Ponder is no longer connected to it.';
    }
    box.replaceChildren(chatEmpty(text, chat.loading ? null : ext?.url));
  } else {
    const lines = chat.lines.filter((l) => l.room === chat.room);
    if (lines.length === 0) {
      box.replaceChildren(chatEmpty(chat.room === 'spectator'
        ? 'Nobody watching has said anything yet.'
        : 'Nothing said between the players yet.'));
    } else {
      box.replaceChildren(...lines.map(chatLineNode));
    }
    if (atEnd) box.scrollTop = box.scrollHeight;
  }
  chat.drawn = drawn;

  $('#chat-form').hidden = !usable;
  if (usable) {
    const input = $('#chat-text');
    const me = chat.view.me || 'you';
    const to = chat.room === 'spectator' ? 'the spectators' : 'the players';
    input.placeholder = ext?.live === false
      ? `Message ${to} as ${me} (the game is over: answers no longer show here)`
      : `Message ${to} as ${me}`;
    renderChatLeft();
  }
  const err = $('#chat-error');
  err.hidden = !chat.error;
  err.textContent = chat.error;
}

function renderChatLeft() {
  const text = $('#chat-text').value;
  const left = CHAT_MAX - [...text].length;
  const node = $('#chat-left');
  node.textContent = text ? String(left) : '';
  node.classList.toggle('low', left <= 15);
  $('#chat-send').disabled = chat.sending || !text.trim() || left < 0;
}

$('#chat-rooms').onclick = (e) => {
  const room = e.target.closest('button')?.dataset.room;
  if (!room || room === chat.room) return;
  chat.room = room;
  chat.unread[room] = 0;
  chat.error = '';
  renderChat();
  const box = $('#chat-lines');
  box.scrollTop = box.scrollHeight;
};

$('#chat-text').oninput = () => {
  if (chat.error) { chat.error = ''; renderChat(); } else renderChatLeft();
};
// Arrow keys move in the text here, not through the game's moves.
$('#chat-text').addEventListener('keydown', (e) => e.stopPropagation());

$('#chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#chat-text');
  const text = input.value.trim();
  if (!text || chat.sending || !chat.view) return;
  const id = chat.gameId;
  chat.sending = true;
  chat.error = '';
  renderChatLeft();
  try {
    await api.backend('lichessChatSend', { id, room: chat.room, text });
    if (chat.gameId === id) input.value = '';
  } catch (err) {
    if (chat.gameId === id) chat.error = errorText(err);
  }
  if (chat.gameId !== id) return;
  chat.sending = false;
  renderChat();
  const box = $('#chat-lines');
  box.scrollTop = box.scrollHeight;
  input.focus();
};

window.syncChat = syncChat;
if (state) syncChat();
window.lichessChatEvent = lichessChatEvent;
