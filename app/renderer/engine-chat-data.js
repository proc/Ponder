'use strict';
// Engine chat's pure parts: when the engine has something to say about its
// opponent's moves, what the AI is asked (in character, from what the
// engine's own search makes of the position), and its answer made fit for
// a chat. No DOM here, so test/engine-chat.test.js can run it under Node.
(function (root) {
  const MAX = 140; // the longest message Lichess takes
  // The cap on the model's answer, in tokens: 140 characters are some 35
  // to 50 tokens in English, more in other languages; room to spare, and no
  // room for an essay.
  const MAX_TOKENS = 100;
  const EVERY = [1, 2, 3, 5, 8]; // as live commentary: every so many moves
  // Rate limits: one remark a game at most this often, and at most so many
  // in a minute over all the engine's games together. On Lichess each
  // remark is two posts (the players' room and the spectators'), so at
  // most 8 posts a minute.
  const GAP_MS = 15000;
  const PER_MINUTE = 4;

  // The moves as text: "1. e4 e5 2. Nf3", from a position with White or
  // Black to move first.
  function movesText(moves, { fullmove = 1, white = true } = {}) {
    const out = [];
    let n = fullmove;
    let w = white;
    moves.forEach((san, i) => {
      if (w) out.push(`${n}. ${san}`);
      else out.push(i === 0 ? `${n}... ${san}` : san);
      if (!w) n++;
      w = !w;
    });
    return out.join(' ');
  }

  // Who moves first, and the move number, from a FEN.
  function startOf(fen, plies) {
    const [, turn, , , , full] = String(fen ?? '').split(' ');
    // The FEN given is the position after the moves: count back.
    let white = turn !== 'b';
    let fullmove = +full || 1;
    for (let i = 0; i < plies; i++) {
      white = !white;
      if (!white) fullmove--; // stepping back over White's move ends a move number
    }
    return { white, fullmove: Math.max(1, fullmove) };
  }

  // The engine's evaluation in words, from its own side (the numbers come
  // from White's side).
  function evalText(m) {
    if (!m?.hasEval) return '';
    const mine = m.side === 'black' ? -1 : 1;
    if (m.isMate) {
      const mate = m.mate * mine;
      if (mate > 0) return `you have mate in ${mate}`;
      if (mate < 0) return `you are getting mated in ${-mate}`;
      return 'checkmate';
    }
    const pawns = (m.cp * mine) / 100;
    const sign = pawns > 0 ? '+' : pawns < 0 ? '−' : '';
    const said = `${sign}${Math.abs(pawns).toFixed(2)} pawns`;
    if (pawns >= 3) return `${said}: you are winning`;
    if (pawns >= 1) return `${said}: you are clearly better`;
    if (pawns >= 0.35) return `${said}: you are a little better`;
    if (pawns > -0.35) return `${said}: about equal`;
    if (pawns > -1) return `${said}: your opponent is a little better`;
    if (pawns > -3) return `${said}: your opponent is clearly better`;
    return `${said}: you are losing`;
  }

  // Who the engine is in the chat: the character set, else its own name.
  const personaOf = (m, persona) => String(persona ?? '').trim() || m.engine || m.me || 'the engine';

  // What the AI is asked. m: what the engine made of its move (the backend's
  // lichessBotMove event, or the same made here for a game on this
  // computer). Its expected line is given so that it speaks from what it
  // really thinks, with the instruction not to give it away.
  function messages(m, persona) {
    const who = personaOf(m, persona);
    const side = m.side === 'black' ? 'Black' : 'White';
    const opponent = m.opponent || 'your opponent';
    const system = [
      `You are ${who}, a chess engine playing ${side} against ${opponent}${m.lichess ? ' on Lichess' : ''}.`,
      'After your opponent moves you send them one short chat message, in character, speaking as yourself, the engine, in the first person:',
      'what you make of their last move and of the position, as your own search sees it.',
      `Stay in character as ${who}. Be witty and good-natured: never rude, mocking or discouraging, and no remarks about the person.`,
      'You may name the move you are playing. Never name the moves you expect after it, never give advice, and do not quote evaluation numbers exactly.',
      `Your message must be ${MAX} characters or fewer, counting spaces and punctuation: that is the longest a Lichess chat message can be. Aim for about 100 characters, one or two short sentences.`,
      'Write the message only, as plain text: no quotation marks around it, no hashtags, no move lists.',
    ].join(' ');
    const parts = [];
    const game = [m.rated ? 'Rated' : 'Casual', m.speed, 'game'].filter(Boolean).join(' ');
    parts.push(`${game}${m.lichess ? ' on Lichess' : ''}. You are ${who}, playing ${side}. Your opponent: ${opponent}${m.opponentTitle ? ` (${m.opponentTitle})` : ''}${m.opponentRating ? `, rated ${m.opponentRating}` : ''}.`);
    const start = startOf(m.fen, m.moves?.length ?? 0);
    if (m.moves?.length) parts.push(`The moves so far: ${movesText(m.moves, start)}`);
    if (m.last) {
      const at = startOf(m.fen, 1);
      parts.push(`Their last move: ${at.white ? `${at.fullmove}.` : `${at.fullmove}...`} ${m.last}`);
    } else parts.push('You move first: they have made no move yet. Greet the game instead.');
    parts.push(`The position now (FEN): ${m.fen}`);
    const ev = evalText(m);
    if (ev) parts.push(`Your evaluation, from your side: ${ev}${m.depth ? ` (searched to depth ${m.depth})` : ''}.`);
    if (m.move) parts.push(`The move you are playing now: ${m.move}`);
    const line = (m.pv ?? []).slice(1, 6);
    if (line.length) parts.push(`The line you expect after it (for you only: do not reveal it): ${line.join(' ')}`);
    parts.push(`Write your chat message now, in ${MAX} characters or fewer.`);
    return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n') }];
  }

  // The answer as a chat message: one line, without quotation marks around it.
  function cleanText(text) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
  }
  const length = (t) => [...t].length;
  const fits = (t) => length(t) <= MAX;

  // Asking again, once, for an answer that was too long: the model sees
  // its answer and is told by how much it went over.
  function shorter(messages, answer) {
    const n = length(answer);
    return [...messages,
      { role: 'assistant', content: answer },
      { role: 'user', content: `That is ${n} characters, ${Math.max(0, n - MAX)} over the limit. Say it again in ${MAX} characters or fewer, counting spaces: shorter and simpler, the same character. The message only.` }];
  }

  // The last resort, for an answer still too long: cut at the end of a
  // sentence that fits, else at the last word that fits (with an ellipsis).
  // Never in the middle of a word.
  function fit(text) {
    const t = cleanText(text);
    if (fits(t)) return t;
    const head = [...t].slice(0, MAX).join('');
    const ends = [...head.matchAll(/[.!?…](?=\s|$)/g)].map((m) => m.index + 1);
    const sentence = ends.filter((i) => i >= MAX * 0.35).at(-1);
    if (sentence) return head.slice(0, sentence).trim();
    const words = [...t].slice(0, MAX - 1).join('');
    const cut = words.lastIndexOf(' ');
    if (cut > 0) return `${words.slice(0, cut).replace(/[\s,;:\-–—]+$/, '')}…`;
    return `${words}…`; // one long word: nothing better to do
  }

  // Asks for the message (ask(messages) is the model): within the limit as
  // it comes, else asked again once with a reminder of the limit, else cut
  // to fit as a last resort. An answer the token cap cut off counts as too
  // long. Gives { text, asked, cut }.
  async function compose(ask, messages) {
    const first = await ask(messages);
    const text = cleanText(first?.text);
    if (fits(text) && !first?.truncated) return { text, asked: 1, cut: false };
    const again = await ask(shorter(messages, text));
    const second = cleanText(again?.text);
    if (second && fits(second) && !again?.truncated) return { text: second, asked: 2, cut: false };
    return { text: fit(second || text), asked: 2, cut: true };
  }

  // Is a remark due, now that the engine has answered one more of its
  // opponent's moves? g: the game's own record ({ count, at, busy }); recent:
  // when the remarks of all games were made. A remark held back by the
  // limits is made at the next move instead; the caller starts the count
  // again once one is made.
  function due(g, every, now, recent = []) {
    g.count = (g.count ?? 0) + 1;
    if (g.count < every) return false;
    if (g.busy) return false;
    if (g.at && now - g.at < GAP_MS) return false;
    if (recent.filter((t) => now - t < 60000).length >= PER_MINUTE) return false;
    return true;
  }

  const api = { MAX, MAX_TOKENS, EVERY, GAP_MS, PER_MINUTE, movesText, startOf, evalText, personaOf, messages, cleanText, shorter, fit, compose, due };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.engineChatData = api;
}(typeof window !== 'undefined' ? window : globalThis));
