'use strict';
// The AI panel: a conversation with the model set in Settings → AI, about the
// game on the board. Each message goes with the game as it stands (its PGN,
// the position shown, what the analysis says of it), so "this move" and
// "here" mean what is on the board. Answers are streamed as they come.

// Conversations are tabs: each its own exchange, kept while the app is open.
// One answer is written at a time, in the chat it was asked in (answering).
const aicNewChat = () => ({ key: `c${++aicNewChat.n}`, title: '', messages: [], draft: '' });
aicNewChat.n = 0;
const aic = {
  chats: [],
  chat: null,       // the one shown
  answering: null,  // the chat being answered
  answer: null,     // and its answer being written
  // The shown chat's messages: { role: 'user' | 'assistant', content, … }.
  get messages() { return this.chat.messages; },
  busy: false,
  id: 0,          // the answer being streamed
  model: '',
  since: 0,
  timer: null,
};

aic.chat = aicNewChat();
aic.chats.push(aic.chat);

// The panel floats over the right of the window and collapses to a handle
// on the edge. Open or not, and its width, are remembered.
const aiPanel = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('aiPanel') ?? '{}') ?? {}; } catch { /* as new */ }
  return { open: Boolean(saved.open), width: +saved.width || 0, pinned: Boolean(saved.pinned), unread: false };
})();
const saveAiPanel = () => { try { localStorage.setItem('aiPanel', JSON.stringify({ open: aiPanel.open, width: aiPanel.width, pinned: aiPanel.pinned })); } catch { /* not kept */ } };
// Pinned, the panel stays open when you click elsewhere in the window.
function renderAiPin() {
  const pin = $('#ai-pin');
  pin.setAttribute('aria-pressed', String(aiPanel.pinned));
  pin.classList.toggle('on', aiPanel.pinned);
  pin.title = aiPanel.pinned ? 'Pinned: the panel stays open when you click elsewhere. Click to unpin' : 'Pin the panel: keep it open when you click elsewhere';
}

function renderAiHandle() {
  const handle = $('#ai-handle');
  handle.classList.toggle('busy', aic.busy);
  handle.classList.toggle('new', aiPanel.unread && !aic.busy);
  handle.title = aic.busy ? 'The model is answering: open the AI chat' : aiPanel.unread ? 'The model has answered: open the AI chat' : 'Open the AI chat';
  $('#btn-ai').classList.toggle('busy', aic.busy && !aiPanel.open);
}

function setAiPanel(open, { focus = true } = {}) {
  const panel = $('#ai-panel');
  aiPanel.open = Boolean(open);
  if (aiPanel.open) aiPanel.unread = false;
  panel.classList.toggle('collapsed', !aiPanel.open);
  panel.inert = !aiPanel.open; // nothing in a collapsed panel takes the keyboard
  if (aiPanel.width) panel.style.setProperty('--ai-w', `${aiPanel.width}px`);
  else panel.style.removeProperty('--ai-w');
  $('#ai-handle').setAttribute('aria-expanded', String(aiPanel.open));
  $('#btn-ai').setAttribute('aria-pressed', String(aiPanel.open));
  $('#btn-ai').classList.toggle('active', aiPanel.open);
  saveAiPanel();
  if (aiPanel.open) {
    aic.justSent = true; // to the end of the conversation
    window.openAiChat?.(focus);
  } else if (panel.contains(document.activeElement)) document.activeElement.blur();
  renderAiHandle();
}

const AIC_SYSTEM = `You are a chess assistant built into a chess program called Ponder. The user is looking at a game on the board and asks about it.
Answer briefly and concretely, in plain text (no Markdown tables or headings): plans, threats, mistakes, better moves in standard algebraic notation.
The game and the position on the board are given below; "this move", "here" and "now" mean the position shown.
Only name moves that are legal in the position you are talking about. If you are not sure of a tactic or a line, say so rather than guess. Engine evaluations in the notes, where there are any, are more reliable than your own calculation: go by them.`;

// What the model is told about the board, new with every message.
async function aiChatContext() {
  if (!state?.players) return 'There is no game on the board.';
  const parts = [];
  const white = state.players.white?.name || 'White';
  const black = state.players.black?.name || 'Black';
  const result = state.result && state.result !== '*' ? state.result : state.active || state.external?.live ? 'in progress' : 'unfinished';
  parts.push(`Game: ${white} (White) against ${black} (Black). Result: ${result}${state.reason ? ` (${state.reason})` : ''}.`);
  if (state.opening) parts.push(`Opening: ${state.opening}.`);
  let pgn = '';
  try { pgn = await gamePgn(); } catch { /* no game to write */ }
  if (pgn) parts.push(`The game as PGN, with any annotations and engine evaluations:\n${pgn.trim()}`);
  // Where the board is.
  const fen = shownFen();
  const turn = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  let where;
  if (varNode) {
    const { n, white: w } = plyNumber(varNode.ply);
    where = `a side variation, after ${n}${w ? '.' : '...'} ${varNode.san} (not a move of the game)`;
  } else if (shownPly() === 0) where = 'the starting position, before the first move';
  else {
    const { n, white: w } = plyNumber(shownPly());
    where = `the position after ${n}${w ? '.' : '...'} ${state.moves[shownPly() - 1].san}${shownPly() === state.moves.length ? ' (the last move so far)' : ` (move ${shownPly()} of ${state.moves.length} half-moves)`}`;
  }
  parts.push(`The board shows ${where}. ${turn} is to move. FEN: ${fen}`);
  // What the engine says of this position, when the analysis is on it.
  const data = typeof analysis !== 'undefined' ? analysis.data : null;
  if (data?.state === 'running' && data.fen === fen && data.lines?.length) {
    const lines = data.lines.slice(0, 3).map((l) => `${formatScore(l)} (depth ${l.depth}): ${(l.san ?? []).slice(0, 8).join(' ')}`);
    parts.push(`Engine analysis of this position (${data.engine ?? 'engine'}, score from White's side):\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

function aiChatSuggestions() {
  const game = Boolean(state?.moves?.length);
  return game
    ? ['Summarise this game', 'What is the plan for both sides here?', 'Where did the game turn?', 'Was the last move shown a good one?']
    : ['What are the main ideas of the Sicilian Defence?', 'How should I study endgames?'];
}

// --- Drawing ---------------------------------------------------------------
// Rows are kept and updated in place, so an answer growing word by word
// does not restart the animations around it.
const aicRows = new WeakMap(); // message -> its elements

const AIC_ICON = {
  // An eight-pointed spark: it turns while the model works.
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v18"/><path d="M3 12h18"/><path d="M5.6 5.6l12.8 12.8"/><path d="M18.4 5.6L5.6 18.4"/></g></svg>',
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.2H4.6A1.6 1.6 0 0 0 3 4.8v5.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  send: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4" fill="currentColor"/></svg>',
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.9 2.6l2.5 2.5L6 12.5l-3.2.7.7-3.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  retry: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.8 8a4.8 4.8 0 1 1-1.5-3.5M12.9 2.6v2.7h-2.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const aicIcon = (name, cls = '') => { const s = el('span', { className: `aic-icon ${cls}`.trim() }); s.innerHTML = AIC_ICON[name]; return s; };

// The little formatting models use: **bold**, *italic*, `code`, lists,
// headings and paragraphs. Built as elements, never as HTML from the text.
function aicInline(text) {
  const out = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(el('strong', { textContent: t.slice(2, -2) }));
    else if (t.startsWith('`')) out.push(el('code', { textContent: t.slice(1, -1) }));
    else out.push(el('em', { textContent: t.slice(1, -1) }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function aicFormat(text) {
  const blocks = [];
  let para = [];
  let list = null;
  const endPara = () => { if (para.length) { blocks.push(el('p', {}, para.flatMap((l, i) => (i ? [el('br'), ...aicInline(l)] : aicInline(l))))); para = []; } };
  const endList = () => { if (list) { blocks.push(list); list = null; } };
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const number = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const head = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (!line.trim()) { endPara(); endList(); continue; }
    if (head) { endPara(); endList(); blocks.push(el('p', { className: 'aic-h' }, aicInline(head[1]))); continue; }
    // "1. e4" at the start of a line is a move, not a list: a list item's
    // number is followed by words, not by a move.
    const isMove = number && /^(O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8])/.test(number[2]);
    if (bullet || (number && !isMove)) {
      endPara();
      const ordered = !bullet;
      if (!list || (list.tagName === 'OL') !== ordered) { endList(); list = el(ordered ? 'ol' : 'ul'); }
      list.append(el('li', {}, aicInline(bullet ? bullet[1] : number[2])));
      continue;
    }
    endList();
    para.push(line.trim());
  }
  endPara();
  endList();
  return blocks;
}

const aicTime = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };

// Makes parent's children be rows, in order, moving as little as possible:
// what is gone is taken out, what is new is put in, and what is already in
// its place is left alone, so nothing that is staying is animated again.
function aicSync(parent, rows) {
  const keep = new Set(rows);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  rows.forEach((row, i) => { if (parent.children[i] !== row) parent.insertBefore(row, parent.children[i] ?? null); });
}

// Plain text that grows as it is written: only what is new is added, in a
// piece that fades in; what was there before stays as it is. Text that
// changes in any other way (tidied up at the end, replaced) is set plainly.
function aicSoftText(node, text) {
  text = String(text ?? '');
  const had = node.dataset.text ?? '';
  if (text === had && (node.textContent === text)) return;
  if (text.startsWith(had) && text.length > had.length && node.textContent === had && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.append(el('span', { className: 'aic-in', textContent: text.slice(had.length) }));
  } else node.textContent = text;
  node.dataset.text = text;
}

// --- The answer streaming in --------------------------------------------------
// The model's words arrive in bursts; they are let onto the page at an even
// pace instead, catching up faster the further behind they are, and each
// newly shown run of text fades in. The runs are kept by their place in the
// text as drawn, with when they appeared, so that drawing the answer again
// (it is formatted afresh as it grows) carries each fade on from where it
// was rather than starting it over.
const AIC_FADE = 420; // ms a run of text takes to fade in
const aicFlowing = new Set(); // answers still coming onto the page
let aicFlowTimer = null;
const aicCalm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function aicFlow(m) {
  if (aicCalm()) { m.flow = null; m.fades = []; return; } // all at once, no fade
  m.flow ??= 0;
  m.fades ??= [];
  m.drawnLen ??= 0;
  aicFlowing.add(m);
  aicFlowTimer ??= setInterval(aicFlowTick, 32);
}

function aicFlowTick() {
  const log = $('#aic-log');
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const now = performance.now();
  for (const m of [...aicFlowing]) {
    const behind = m.content.length - m.flow;
    // A few characters a frame, more when there is a lot waiting.
    if (behind > 0) m.flow += Math.max(2, Math.ceil(behind / 14));
    else if (behind < 0) m.flow = m.content.length;
    m.fades = m.fades.filter((f) => now - f.at < AIC_FADE);
    const done = m.flow >= m.content.length && m !== aic.answer;
    if (aic.chat.messages.includes(m)) updateAiRow(m);
    if (done && !m.fades.length) {
      aicFlowing.delete(m);
      m.flow = null; // all of it is on the page: drawn plainly from now on
      const row = aicRows.get(m);
      if (row) row.shown = ''; // once more, without the fading wrappers
      if (aic.chat.messages.includes(m)) updateAiRow(m);
    }
  }
  if (atEnd) log.scrollTop = log.scrollHeight;
  if (!aicFlowing.size) { clearInterval(aicFlowTimer); aicFlowTimer = null; }
}

// Wraps the runs of text that are still fading in, by their place in the
// drawn text, each carrying on from how far its fade had got.
function aicFadeIn(m, body) {
  const now = performance.now();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, total]); total += n.data.length; }
  // What is new since it was last drawn is a run of its own.
  if (total > m.drawnLen) m.fades.push({ from: m.drawnLen, to: total, at: now });
  m.drawnLen = total;
  const live = m.fades.filter((f) => now - f.at < AIC_FADE && f.from < total);
  if (!live.length) return;
  // From the last text node back, so that splitting one does not move the others.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const [node, start] = nodes[i];
    const end = start + node.data.length;
    for (let k = live.length - 1; k >= 0; k--) {
      const f = live[k];
      const a = Math.max(f.from, start);
      const b = Math.min(f.to, end);
      if (a >= b) continue;
      // The part of this node in the run: split off and wrapped.
      const tail = node.splitText(a - start);
      tail.splitText(b - a);
      const span = el('span', { className: 'aic-in' });
      span.style.animationDelay = `${-(now - f.at)}ms`;
      tail.replaceWith(span);
      span.append(tail);
    }
  }
}

// A small button under a message: copy it, go back to it, ask again.
function aicAct(icon, title, onclick) {
  const b = el('button', { type: 'button', className: 'aic-copy', title }, [aicIcon(icon)]);
  b.setAttribute('aria-label', title);
  b.onclick = () => onclick(b);
  return b;
}
const aicCopied = async (b, text) => { await api.copyText(text); b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1200); };

// Back to one of your messages: it and everything after it leave the
// conversation, and its words go into the box to be changed and sent again.
function rewindAiChat(m) {
  if (aic.busy) return;
  const chat = aic.chat;
  const at = chat.messages.indexOf(m);
  if (at < 0) return;
  chat.messages.splice(at);
  if (!chat.messages.length) chat.title = '';
  const box = $('#aic-text');
  box.value = m.content;
  aicGrow();
  renderAiChat();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

// Ask again: the answer (and what followed it) goes, and the question it
// answered is sent anew.
function retryAiChat(m) {
  if (aic.busy) return;
  const chat = aic.chat;
  const at = chat.messages.indexOf(m);
  const asked = at > 0 ? chat.messages[at - 1] : null;
  if (asked?.role !== 'user') return;
  chat.messages.splice(at - 1);
  sendAiChat(asked.content);
}

function aicRow(m) {
  let r = aicRows.get(m);
  if (r) return r;
  if (m.role === 'user') {
    const bubble = el('div', { className: 'aic-bubble' });
    const acts = el('div', { className: 'aic-foot aic-acts' }, [
      aicAct('copy', 'Copy this message', (b) => aicCopied(b, m.content)),
      aicAct('edit', 'Go back to this message: edit it and send it again (what came after it is removed)', () => rewindAiChat(m)),
    ]);
    r = { row: el('div', { className: 'aic-msg me' }, [bubble, acts]), bubble, acts };
  } else {
    const label = el('span', { className: 'aic-think-label' });
    const head = el('button', { type: 'button', className: 'aic-think-head' }, [aicIcon('spark', 'aic-spark'), label, aicIcon('chevron', 'aic-chevron')]);
    const thought = el('div', { className: 'aic-think-body', hidden: true });
    head.onclick = () => { if (!m.thinking) return; m.thoughtOpen = !m.thoughtOpen; updateAiRow(m); };
    const think = el('div', { className: 'aic-think' }, [head, thought]);
    const body = el('div', { className: 'aic-body' });
    const meta = el('span', { className: 'aic-meta' });
    const copy = aicAct('copy', 'Copy the answer', (b) => aicCopied(b, m.content));
    const retry = aicAct('retry', 'Ask again: replace this answer (and what came after it) with a new one', () => retryAiChat(m));
    const foot = el('div', { className: 'aic-foot' }, [meta, copy, retry]);
    r = { row: el('div', { className: 'aic-msg ai' }, [think, body, foot]), think, head, label, thought, body, meta, foot };
  }
  aicRows.set(m, r);
  return r;
}

function updateAiRow(m) {
  const r = aicRow(m);
  if (m.role === 'user') {
    r.bubble.textContent = m.content;
    // Going back is for a conversation at rest.
    for (const b of r.acts.querySelectorAll('button')) b.disabled = aic.busy && b.title.startsWith('Go back');
    return;
  }
  const live = aic.busy && m === aic.answer;
  const waiting = live && !m.content; // nothing of the answer yet: thinking
  // The thinking line: turning while it works, then how long it took.
  r.think.hidden = !(waiting || m.thinking);
  r.think.classList.toggle('working', waiting);
  r.think.classList.toggle('open', Boolean(m.thoughtOpen && m.thinking));
  r.think.classList.toggle('has-thought', Boolean(m.thinking));
  r.label.textContent = waiting ? 'Thinking…' : `Thought for ${aicTime(m.thinkMs ?? 0)}`;
  r.head.title = m.thinking ? (m.thoughtOpen ? 'Hide its thinking' : 'Show its thinking') : '';
  r.head.setAttribute('aria-expanded', String(Boolean(m.thoughtOpen)));
  // While it thinks, the last lines of its thinking show underneath.
  const showThought = Boolean(m.thinking) && (m.thoughtOpen || waiting);
  r.thought.hidden = !showThought;
  r.thought.classList.toggle('tail', waiting && !m.thoughtOpen);
  if (showThought && r.thought.textContent !== m.thinking) {
    r.thought.textContent = m.thinking;
    if (waiting) r.thought.scrollTop = r.thought.scrollHeight;
  }
  // The answer, formatted; an error as it is.
  r.row.classList.toggle('error', Boolean(m.error));
  r.body.hidden = !m.content;
  // The answer comes in softly: as much of it as has been let out so far
  // (aicFlow lets it out a little at a time), the newest words fading in.
  const upTo = m.error || m.flow == null ? m.content.length : Math.min(m.flow, m.content.length);
  const drawn = `${upTo}:${m.content.length}:${m.error ? 1 : 0}`;
  if (r.shown !== drawn || (m.fades?.length ?? 0) > 0) {
    r.body.replaceChildren(...(m.error ? [el('p', { textContent: m.content })] : aicFormat(m.content.slice(0, upTo))));
    r.shown = drawn;
    if (!m.error && m.flow != null) aicFadeIn(m, r.body);
  }
  r.body.classList.toggle('live', (live || upTo < m.content.length) && Boolean(m.content));
  // No name on a message: the model is named once, in the tab's header.
  r.meta.textContent = m.stopped ? 'Stopped' : '';
  // An answer that failed can still be asked for again.
  r.foot.hidden = live || !m.content;
  r.foot.classList.toggle('failed', Boolean(m.error));
  for (const b of r.foot.querySelectorAll('button')) {
    if (b.title.startsWith('Ask again')) b.disabled = aic.busy;
    else b.hidden = Boolean(m.error); // nothing worth copying in an error
  }
}

// The chats as tabs: the first words asked name a chat; ✕ closes it.
function renderAiTabs() {
  const box = $('#aic-tabs');
  const key = JSON.stringify([aic.chats.map((c) => [c.key, c.title, c === aic.answering && aic.busy]), aic.chat.key]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...aic.chats.map((c) => {
    const on = c === aic.chat;
    const title = c.title || 'New chat';
    const tab = el('button', { type: 'button', className: 'aic-tab' + (on ? ' on' : '') + (c === aic.answering && aic.busy ? ' busy' : ''), title });
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(on));
    const close = el('span', { className: 'aic-tab-close', textContent: '✕', title: 'Close this chat' });
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', `Close ${title}`);
    close.onclick = (e) => { e.stopPropagation(); closeAiChat(c); };
    tab.append(el('span', { className: 'aic-tab-dot' }), el('span', { className: 'aic-tab-title', textContent: title }), close);
    tab.onclick = () => showAiChat(c);
    // The middle button closes a tab, as in a browser.
    tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeAiChat(c); } };
    return tab;
  }));
  box.querySelector('.aic-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function showAiChat(chat) {
  if (chat === aic.chat) return;
  // What was being typed stays with its chat.
  aic.chat.draft = $('#aic-text').value;
  aic.chat = chat;
  $('#aic-text').value = chat.draft ?? '';
  aicGrow();
  aic.justSent = true; // to the end of this chat
  renderAiChat();
  $('#aic-text').focus();
}

function newAiChat() {
  // An empty chat is not doubled: New chat goes to it.
  const empty = aic.chats.find((c) => !c.messages.length);
  if (empty) { showAiChat(empty); $('#aic-text').focus(); return; }
  const chat = aicNewChat();
  aic.chats.push(chat);
  showAiChat(chat);
}

function closeAiChat(chat) {
  if (aic.busy && aic.answering === chat) api.ai.chatCancel();
  const at = aic.chats.indexOf(chat);
  if (at < 0) return;
  aic.chats.splice(at, 1);
  if (!aic.chats.length) aic.chats.push(aicNewChat());
  if (aic.chat === chat) {
    aic.chat = aic.chats[Math.min(at, aic.chats.length - 1)];
    $('#aic-text').value = aic.chat.draft ?? '';
    aicGrow();
    aic.justSent = true;
  }
  renderAiChat();
}

function renderAiChat() {
  const log = $('#aic-log');
  if (!log) return;
  renderAiHandle();
  renderAiTabs();
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const rows = aic.messages.map((m) => { updateAiRow(m); return aicRow(m).row; });
  if (!rows.length) {
    rows.push(el('div', { className: 'aic-empty' }, [
      aicIcon('spark', 'aic-hero'),
      el('h3', { textContent: 'Ask about this game' }),
      el('p', { className: 'hint', textContent: 'The model is sent the game, the position shown and, when Analysis is on, the engine’s lines.' }),
      el('div', { className: 'aic-chips' }, aiChatSuggestions().map((text) => {
        const chip = el('button', { type: 'button', textContent: text });
        chip.onclick = () => sendAiChat(text);
        return chip;
      })),
    ]));
  }
  // Only what changed is put in: rows already there stay where they are,
  // untouched (putting an element in again would play its entrance again).
  aicSync(log, rows);
  if (atEnd || aic.justSent) log.scrollTop = log.scrollHeight;
  aic.justSent = false;
  const send = $('#aic-send');
  // Stop belongs to the chat being answered; another chat waits its turn.
  const here = aic.busy && aic.answering === aic.chat;
  const elsewhere = aic.busy && !here;
  send.classList.toggle('stop', here);
  send.title = here ? 'Stop the answer where it is' : elsewhere ? 'Another chat is being answered: wait for it, or stop it there' : 'Send (Enter)';
  send.setAttribute('aria-label', here ? 'Stop' : 'Send');
  if (send.dataset.icon !== (here ? 'stop' : 'send')) {
    send.dataset.icon = here ? 'stop' : 'send';
    send.replaceChildren(aicIcon(send.dataset.icon));
  }
  send.disabled = elsewhere || (!here && !$('#aic-text').value.trim());
  const model = aic.model ? `${aic.model} · ` : '';
  $('#aic-note').textContent = here
    ? `Waiting for the model… ${aicTime(Date.now() - aic.since)}. It waits until it answers or you stop it.`
    : `${model}Sent with the game on the board and the position shown. A model can be wrong about tactics.`;
  $('#aic-note').title = aic.model ? `Answered by ${aic.model} (Settings → AI)` : '';
}

async function sendAiChat(text) {
  text = String(text ?? '').trim();
  if (!text || aic.busy) return;
  if (!api.ai?.chat) { notify?.('This build has no AI chat.', { title: 'AI' }); return; }
  const chat = aic.chat; // the answer belongs here, whichever tab is shown later
  if (!chat.title) chat.title = text.replace(/\s+/g, ' ').slice(0, 40) + (text.length > 40 ? '…' : '');
  chat.messages.push({ role: 'user', content: text });
  const answer = { role: 'assistant', content: '', thinking: '', started: Date.now() };
  chat.messages.push(answer);
  const id = ++aic.id;
  Object.assign(aic, { busy: true, since: Date.now(), justSent: true, answering: chat, answer });
  clearInterval(aic.timer);
  aic.timer = setInterval(renderAiChat, 1000);
  renderAiChat();
  try {
    // The conversation so far, with the board as it is now up front.
    const context = await aiChatContext();
    const history = chat.messages.slice(0, -1).filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
    const reply = await api.ai.chat(id, [{ role: 'system', content: `${AIC_SYSTEM}\n\n${context}` }, ...history]);
    // What had not been streamed (an answer that came whole) flows in too.
    if (reply.text && reply.text !== answer.content) { answer.content = reply.text; aicFlow(answer); } else answer.content = reply.text;
    if (reply.thinking) answer.thinking = reply.thinking;
    answer.thinkMs ??= Date.now() - answer.started; // answered in one piece
    answer.model = reply.model;
    answer.stopped = Boolean(reply.stopped);
    aic.model = reply.model ?? aic.model;
  } catch (err) {
    const msg = errorText(err);
    answer.thinkMs ??= Date.now() - answer.started;
    if (msg === 'Stopped' && answer.content) answer.stopped = true;
    else if (msg === 'Stopped') { const i = chat.messages.indexOf(answer); if (i >= 0) chat.messages.splice(i, 1); }
    else { answer.content = msg; answer.error = true; }
  } finally {
    clearInterval(aic.timer);
    Object.assign(aic, { busy: false, answering: null, answer: null });
    // Answered while the panel was tucked away: its handle says so.
    if (!aiPanel.open && answer.content) aiPanel.unread = true;
    renderAiChat();
  }
}

// A piece of the answer as it is written.
window.onAiChat = ({ id, delta, thinking }) => {
  if (id !== aic.id || !aic.busy) return;
  const answer = aic.answer;
  if (!answer) return;
  if (thinking) answer.thinking += thinking;
  if (delta) {
    // The first words of the answer: the thinking is over.
    if (!answer.content) answer.thinkMs = Date.now() - answer.started;
    answer.content += delta;
    aicFlow(answer); // onto the page at an even pace, fading in
  }
  renderAiChat();
};

$('#aic-form').onsubmit = (e) => {
  e.preventDefault();
  if (aic.busy) { if (aic.answering === aic.chat) api.ai.chatCancel(); return; }
  const box = $('#aic-text');
  const text = box.value;
  if (!text.trim()) return;
  box.value = '';
  aicGrow();
  sendAiChat(text);
};
// The box grows with what is typed, up to a few lines.
function aicGrow() {
  const box = $('#aic-text');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 150)}px`;
  if (!aic.busy) $('#aic-send').disabled = !box.value.trim();
  aic.chat.draft = box.value;
}
$('#aic-text').addEventListener('input', aicGrow);
// Enter sends; Shift+Enter makes a new line. Keys typed here are not shortcuts.
$('#aic-text').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') { setAiPanel(false); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#aic-form').requestSubmit(); }
});
$('#aic-new').onclick = newAiChat;
$('#aic-settings').onclick = () => openSettings('ai');

window.openAiChat = async (focus = true) => {
  if (!aic.model) {
    try { const s = await api.ai.settings(); aic.model = s.model || ''; } catch { /* no AI in this build */ }
  }
  renderAiChat();
  if (focus) $('#aic-text').focus();
};

$('#btn-ai').onclick = () => setAiPanel(!aiPanel.open);
$('#ai-handle').onclick = () => setAiPanel(true);
$('#ai-collapse').onclick = () => setAiPanel(false);
$('#ai-pin').onclick = () => { aiPanel.pinned = !aiPanel.pinned; saveAiPanel(); renderAiPin(); };
renderAiPin();
// A click anywhere else in the window tucks it away too. Not the things that
// work the panel themselves (its toolbar button, its handle, the commentary
// card's "All…"), nor a dialog or a notification over it.
document.addEventListener('pointerdown', (e) => {
  if (!aiPanel.open || aiPanel.pinned || e.button !== 0) return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t || t.closest('#ai-panel, #ai-handle, #btn-ai, #cm-open, dialog, #toasts')) return;
  setAiPanel(false);
}, true);
// Esc anywhere in the panel tucks it away.
$('#ai-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); setAiPanel(false); } });
// Its left edge drags to set the width; a double click puts it back.
(() => {
  const grip = $('#ai-resize');
  const panel = $('#ai-panel');
  let from = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    from = { x: e.clientX, w: panel.getBoundingClientRect().width };
    grip.setPointerCapture(e.pointerId);
    panel.classList.add('resizing');
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!from) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    aiPanel.width = Math.round(Math.max(20 * rem, Math.min(window.innerWidth * 0.75, from.w + (from.x - e.clientX))));
    panel.style.setProperty('--ai-w', `${aiPanel.width}px`);
  });
  const end = () => { if (!from) return; from = null; panel.classList.remove('resizing'); saveAiPanel(); };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => { aiPanel.width = 0; panel.style.removeProperty('--ai-w'); saveAiPanel(); });
})();
setAiPanel(aiPanel.open, { focus: false });
renderAiChat();

// The chat's typeface and text size (Settings → AI), kept on this computer.
const AIC_FONTS = {
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, "Times New Roman", serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const aicLook = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('aiChatFont') ?? '{}') ?? {}; } catch { /* as new */ }
  return { font: saved.font in AIC_FONTS || saved.font === 'custom' ? saved.font : 'system', name: String(saved.name ?? ''), size: Math.min(150, Math.max(80, +saved.size || 100)) };
})();
function aicFontFamily() {
  if (aicLook.font !== 'custom') return AIC_FONTS[aicLook.font];
  // A name as typed: quoted, with the system font behind it should it not exist.
  const name = aicLook.name.replace(/["\;{}<>]/g, '').trim();
  return name ? `"${name}", ${AIC_FONTS.system}` : AIC_FONTS.system;
}
function applyAiChatFont() {
  for (const node of [$('#pane-ai'), $('#aic-font-sample')]) {
    node.style.setProperty('--aic-font', aicFontFamily());
    node.style.setProperty('--aic-scale', String(aicLook.size / 100));
  }
  $('#aic-font').value = aicLook.font;
  $('#aic-font-name').hidden = aicLook.font !== 'custom';
  if ($('#aic-font-name').value !== aicLook.name) $('#aic-font-name').value = aicLook.name;
  $('#aic-font-size').value = aicLook.size;
  $('#aic-font-size-value').textContent = `${aicLook.size}%`;
  aicGrow();
}
function saveAiChatFont() {
  try { localStorage.setItem('aiChatFont', JSON.stringify(aicLook)); } catch { /* not kept */ }
  applyAiChatFont();
}
$('#aic-font').onchange = (e) => { aicLook.font = e.target.value; saveAiChatFont(); if (aicLook.font === 'custom') $('#aic-font-name').focus(); };
$('#aic-font-name').oninput = (e) => { aicLook.name = e.target.value; saveAiChatFont(); };
$('#aic-font-size').oninput = (e) => { aicLook.size = +e.target.value; saveAiChatFont(); };
applyAiChatFont();
