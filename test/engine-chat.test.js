'use strict';
// Engine chat (app/renderer/engine-chat-data.js and engine-chat.js): the
// engine answers its opponent's moves in the game chat, in character, with
// the AI writing from what the engine's search made of the position. No AI
// is asked here (its answers are made up) and nothing reaches Lichess (the
// chat it would post to is recorded).
//   node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const d = require('../app/renderer/engine-chat-data.js');

// What the backend says after the engine (White, on Lichess) played 3. Bc4
// in answer to 2... Nc6.
const MOVE = {
  gameId: 'abcd1234', me: 'PonderBot', engine: 'Stockfish 17', opponent: 'Alice', opponentRating: 1650,
  side: 'white', rated: true, speed: 'blitz', ply: 4,
  fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  moves: ['e4', 'e5', 'Nf3', 'Nc6'], last: 'Nc6', move: 'Bc4',
  hasEval: true, cp: 45, isMate: false, mate: 0, depth: 18, pv: ['Bc4', 'Nf6', 'd3', 'Bc5'],
};

test('the prompt: in character, the opponent\'s move, the position, the engine\'s own view', () => {
  const [system, user] = d.messages({ ...MOVE, lichess: true }, '');
  assert.equal(system.role, 'system');
  // No character set: the engine, by its own name.
  assert.match(system.content, /You are Stockfish 17, a chess engine playing White against Alice on Lichess/);
  assert.match(system.content, /first person/);
  assert.match(system.content, /Never name the moves you expect after it/);
  // The limit is the model's to keep: said in the instructions and the request.
  assert.match(system.content, /Your message must be 140 characters or fewer, counting spaces and punctuation/);
  assert.match(user.content, /Write your chat message now, in 140 characters or fewer\./);
  assert.match(user.content, /Rated blitz game on Lichess/);
  assert.match(user.content, /The moves so far: 1\. e4 e5 2\. Nf3 Nc6/);
  assert.match(user.content, /Their last move: 2\.\.\. Nc6/);
  assert.ok(user.content.includes(`The position now (FEN): ${MOVE.fen}`));
  assert.match(user.content, /Your evaluation, from your side: \+0\.45 pawns: you are a little better \(searched to depth 18\)/);
  assert.match(user.content, /The move you are playing now: Bc4/);
  assert.match(user.content, /The line you expect after it \(for you only: do not reveal it\): Nf6 d3 Bc5/);
  // A character of your own.
  const [sys2] = d.messages(MOVE, 'Captain Gambit, a pirate who loves sacrifices');
  assert.match(sys2.content, /You are Captain Gambit, a pirate who loves sacrifices, a chess engine/);
});

test('the evaluation is the engine\'s own side\'s', () => {
  assert.equal(d.evalText({ hasEval: true, side: 'black', cp: 45 }), '−0.45 pawns: your opponent is a little better');
  assert.equal(d.evalText({ hasEval: true, side: 'black', cp: -320 }), '+3.20 pawns: you are winning');
  assert.equal(d.evalText({ hasEval: true, side: 'white', isMate: true, mate: 3 }), 'you have mate in 3');
  assert.equal(d.evalText({ hasEval: true, side: 'black', isMate: true, mate: 3 }), 'you are getting mated in 3');
  assert.equal(d.evalText({ hasEval: false, side: 'white', cp: 99 }), '');
});

test('move numbers from the position, Black first too', () => {
  assert.deepEqual(d.startOf(MOVE.fen, 4), { white: true, fullmove: 1 });
  assert.deepEqual(d.startOf(MOVE.fen, 1), { white: false, fullmove: 2 });
  assert.equal(d.movesText(['Nc6', 'Bc4', 'Nf6'], { fullmove: 2, white: false }), '2... Nc6 3. Bc4 Nf6');
});

test('a chat message: one line, no quotes around it', () => {
  assert.equal(d.cleanText('  "Bold knight!\n I see it."  '), 'Bold knight! I see it.');
  assert.equal(d.cleanText(''), '');
});

test('the last resort for a message too long: cut at a sentence, else a word, never mid-word', () => {
  const sentences = 'Arr, a bold knight! I did not see that coming, matey. My bishop sails to c4 to meet it, with the wind behind her and the crew all singing loudly.';
  assert.equal(d.fit(sentences), 'Arr, a bold knight! I did not see that coming, matey.');
  const words = 'A long rambling thought about pawns and squares and plans '.repeat(4).trim();
  const cut = d.fit(words);
  assert.ok([...cut].length <= d.MAX, cut);
  assert.ok(cut.endsWith('…'));
  const kept = cut.slice(0, -1);
  assert.ok(words.startsWith(kept) && words[kept.length] === ' ', `cut mid-word: ${cut}`);
  // Within the limit: as it is.
  assert.equal(d.fit('Nice move.'), 'Nice move.');
});

test('every so many moves, and rate-limited per game and over all games', () => {
  const g = {};
  assert.equal(d.due(g, 2, 100000), false); // the first of two
  assert.equal(d.due(g, 2, 101000), true);
  // Made: the caller starts again.
  Object.assign(g, { count: 0, at: 101000 });
  d.due(g, 2, 102000);
  assert.equal(d.due(g, 2, 103000), false, 'too soon after the last');
  assert.equal(d.due(g, 2, 101000 + d.GAP_MS), true, 'held back, then made at the next move');
  // Busy with one already: not another.
  assert.equal(d.due({ count: 5, busy: true }, 1, 1e6), false);
  // Over all games: at most PER_MINUTE a minute.
  const recent = Array.from({ length: d.PER_MINUTE }, (_, i) => 1e6 - i * 1000);
  assert.equal(d.due({}, 1, 1e6 + 1, recent), false);
  assert.equal(d.due({}, 1, 1e6 + 61000, recent), true);
});

// --- engine-chat.js, with the page stood in for ---------------------------
const SRC = fs.readFileSync(path.join(__dirname, '../app/renderer/engine-chat.js'), 'utf8');
const anything = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k in t ? t[k] : (t[k] = anything())),
  apply: () => anything(),
  set: (t, k, v) => { t[k] = v; return true; },
});
// reply: the AI's answer, or a list of them in turn (an Error is thrown).
function load({ on = true, every = 1, persona = '', reply = 'A bold knight, Alice. My bishop says hello.', postError = null } = {}) {
  const replies = Array.isArray(reply) ? [...reply] : null;
  const asked = [];
  const posted = [];
  const store = { engineChat: JSON.stringify({ on, every, persona }) };
  const ctx = {
    console, Date, Promise, JSON, Math, Map,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    document: anything(), $: () => anything(), el: () => anything(),
    errorText: (e) => String(e?.message ?? e),
    state: null, puzzleView: null, engineInfo: {},
    api: {
      ai: {
        chat: async (id, messages, channel, options) => {
          asked.push({ id, messages, channel, options });
          const r = replies ? replies.shift() : reply;
          if (r instanceof Error) throw r;
          return typeof r === 'string' ? { text: r } : r;
        },
      },
      backend: async (cmd, args) => { posted.push({ cmd, args }); if (postError) throw postError; },
    },
  };
  ctx.window = ctx;
  ctx.engineChatData = d;
  vm.createContext(ctx);
  vm.runInContext(`${SRC}\n;globalThis.ec = ec;`, ctx);
  return { ctx, asked, posted };
}
const settle = () => new Promise((r) => setImmediate(r));

test('off by default: the AI is not asked, nothing is posted', async () => {
  const asked = [];
  const ctx = { console, Date, Promise, JSON, Math, Map, localStorage: { getItem: () => null, setItem() {} }, document: anything(), $: () => anything(), el: () => anything(), errorText: String, state: null, api: { ai: { chat: async () => { asked.push(1); return { text: 'x' }; } }, backend: async () => {} } };
  ctx.window = ctx;
  ctx.engineChatData = d;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.engineChatBotMove(MOVE);
  await settle();
  assert.equal(asked.length, 0);
});

test('Lichess: a reply within the limit goes to the players\' chat as it is, asked once with a small cap', async () => {
  const { ctx, asked, posted } = load({ reply: '"A bold knight, Alice. My bishop says hello."' });
  ctx.engineChatBotMove(MOVE);
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].channel, 'engine-chat:bot:abcd1234');
  assert.equal(asked[0].options.maxTokens, d.MAX_TOKENS);
  assert.match(asked[0].messages[1].content, /Their last move: 2\.\.\. Nc6/);
  assert.equal(posted.length, 1);
  // To the opponent and the spectators both (the backend posts in the two rooms).
  assert.equal(posted[0].cmd, 'lichessBotRemark');
  assert.equal(posted[0].args.id, 'abcd1234');
  assert.equal(posted[0].args.room, undefined);
  assert.equal(posted[0].args.text, 'A bold knight, Alice. My bishop says hello.');
});

const TOO_LONG = 'Ahoy, Alice! That knight leaps out like a flying fish over the waves, but my trusty bishop has spotted it from the crow’s nest and sails to c4 at once.';

test('a reply over the limit: asked again once, with a reminder of the limit, and the shorter one is posted', async () => {
  const { ctx, asked, posted } = load({ reply: [TOO_LONG, 'Ahoy, Alice! A flying knight, but my bishop saw it coming.'] });
  ctx.engineChatBotMove(MOVE);
  await settle();
  assert.equal(asked.length, 2);
  const again = asked[1].messages;
  assert.equal(again.length, 4);
  assert.equal(again[2].role, 'assistant');
  assert.equal(again[2].content, TOO_LONG);
  assert.match(again[3].content, new RegExp(`^That is ${[...TOO_LONG].length} characters, ${[...TOO_LONG].length - 140} over the limit\\. Say it again in 140 characters or fewer`));
  assert.equal(asked[1].options.maxTokens, d.MAX_TOKENS);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].args.text, 'Ahoy, Alice! A flying knight, but my bishop saw it coming.');
});

test('still over the limit when asked again: cut to fit as a last resort, never mid-word, not asked a third time', async () => {
  const { ctx, asked, posted } = load({ reply: [TOO_LONG, TOO_LONG] });
  ctx.engineChatBotMove(MOVE);
  await settle();
  assert.equal(asked.length, 2);
  // Its one sentence that fits is too short to stand for it: cut at a word.
  const text = posted[0].args.text;
  assert.ok([...text].length <= 140, text);
  assert.ok(text.endsWith('…'));
  const kept = text.slice(0, -1);
  assert.ok(TOO_LONG.startsWith(kept) && TOO_LONG[kept.length] === ' ', `cut mid-word: ${text}`);
});

test('a message Lichess would not take in a room: said, and the engine still talks at its next move', async () => {
  const { ctx, asked, posted } = load({ postError: new Error("not posted in the spectators' chat: Lichess answered 429") });
  ctx.engineChatBotMove(MOVE);
  await settle();
  assert.equal(posted.length, 1);
  assert.equal(ctx.ec.note, "The engine’s last message was not posted in the spectators' chat: Lichess answered 429");
  ctx.ec.games.get('bot:abcd1234').at = 0; // past the 15 s between messages
  ctx.engineChatBotMove({ ...MOVE, ply: 8 });
  await settle();
  assert.equal(asked.length, 2, 'not stopped by a post that failed');
});

test('a reply the token cap cut off counts as too long, however short', async () => {
  const { ctx, asked, posted } = load({ reply: [{ text: 'Ahoy, Alice! That knight leaps out like', truncated: true }, 'Ahoy! A leaping knight.'] });
  ctx.engineChatBotMove(MOVE);
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(posted[0].args.text, 'Ahoy! A leaping knight.');
});

test('Lichess: not for the engine\'s first move, and every 2 moves when so set', async () => {
  const { ctx, asked } = load({ every: 2 });
  ctx.engineChatBotMove({ ...MOVE, ply: 0, last: '', moves: [] });
  await settle();
  assert.equal(asked.length, 0, 'the first move answers nothing');
  ctx.engineChatBotMove({ ...MOVE, ply: 2 });
  await settle();
  assert.equal(asked.length, 0);
  ctx.engineChatBotMove({ ...MOVE, ply: 4 });
  await settle();
  assert.equal(asked.length, 1);
});

test('the character set is who speaks', async () => {
  const { ctx, asked } = load({ persona: 'Sir Blunderalot' });
  ctx.engineChatBotMove(MOVE);
  await settle();
  assert.match(asked[0].messages[0].content, /^You are Sir Blunderalot, a chess engine/);
});

test('an AI that fails: not asked again in that game, and nothing posted', async () => {
  const { ctx, asked, posted } = load({ reply: new Error('No API key for OpenAI') });
  ctx.engineChatBotMove(MOVE);
  await settle();
  ctx.engineChatBotMove({ ...MOVE, ply: 6 });
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(posted.length, 0);
  // Another game tries again.
  ctx.engineChatBotMove({ ...MOVE, gameId: 'other123' });
  await settle();
  assert.equal(asked.length, 2);
});

test('a game on this computer: the engine\'s message shows in the game\'s chat, its own view of its move', async () => {
  const { ctx, asked, posted } = load();
  const fens = [
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  ];
  ctx.state = { game: 3, active: true, players: { white: { type: 'human', name: 'You' }, black: { type: 'engine', name: 'Basic' } }, moves: [] };
  ctx.syncEngineChat();
  ctx.state = { ...ctx.state, moves: [{ uci: 'e2e4', san: 'e4', fen: fens[0] }] };
  ctx.syncEngineChat();
  ctx.engineInfo.black = { side: 'black', ply: 1, hasEval: true, cp: 20, depth: 9, pv: ['e5', 'Nf3'] };
  ctx.state = { ...ctx.state, moves: [...ctx.state.moves, { uci: 'e7e5', san: 'e5', fen: fens[1] }] };
  ctx.syncEngineChat();
  await settle();
  assert.equal(asked.length, 1);
  const user = asked[0].messages[1].content;
  assert.match(user, /Their last move: 1\. e4/);
  assert.match(user, /Your evaluation, from your side: −0\.20 pawns/);
  assert.match(user, /The move you are playing now: e5/);
  assert.match(asked[0].messages[0].content, /You are Basic, a chess engine playing Black against You\./);
  assert.equal(posted.length, 0, 'nothing is sent anywhere');
  const local = ctx.engineChatLocal();
  assert.equal(local.lines.length, 1);
  assert.equal(local.lines[0].user, 'Basic');
  assert.equal(local.lines[0].text, 'A bold knight, Alice. My bishop says hello.');
  // Your own move does not call for a message.
  ctx.state = { ...ctx.state, moves: [...ctx.state.moves, { uci: 'g1f3', san: 'Nf3', fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' }] };
  ctx.syncEngineChat();
  await settle();
  assert.equal(asked.length, 1);
});
