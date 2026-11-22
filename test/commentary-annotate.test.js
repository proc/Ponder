'use strict';
// Live commentary saved as annotations (app/renderer/commentary.js): each
// comment goes on the move it is about as soon as it is complete, the
// summary before the first move, without replacing what is there, and is
// saved at once where the game has a file. The page is stood in for: no
// window, and no AI is asked (its answers are made up here).
//   node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../app/renderer/commentary.js'), 'utf8');

// Whatever the page is asked for: an element that takes anything.
const anything = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k in t ? t[k] : (t[k] = anything())),
  apply: () => anything(),
  set: (t, k, v) => { t[k] = v; return true; },
});

// The game on the board: 1. e4 e5 2. Nf3 Nc6.
function load({ savable = false, chat } = {}) {
  const calls = { renders: [], saves: 0 };
  const moves = [
    ['e2e4', 'e4', 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'],
    ['e7e5', 'e5', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'],
    ['g1f3', 'Nf3', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'],
    ['b8c6', 'Nc6', 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'],
  ].map(([uci, san, fen]) => ({ uci, san, fen }));
  const ctx = {
    console, setTimeout, clearTimeout, performance, Promise, JSON, Math,
    localStorage: { getItem: () => null, setItem() {} },
    document: anything(), speechSynthesis: undefined, navigator: { language: 'en' },
    $: () => anything(), $$: () => [], el: () => anything(),
    api: { ai: { chat }, tts: undefined },
    state: { game: 7, moves, result: '*', active: true, players: {}, startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
    notes: { before: null, moves: new Map(), dirty: false },
    annBlank: () => ({ nag: 0, pos: 0, other: [], comment: '', cmds: '' }),
    annSavable: () => savable,
    anSave: { none: null },
    saveAnnotations: () => { calls.saves++; },
    renderMoves: (o) => { calls.renders.push(o); },
    plyNumber: (p) => ({ n: Math.ceil(p / 2), white: p % 2 === 1 }),
    errorText: (e) => String(e?.message ?? e),
    gamePgn: async () => '[Event "?"]\n\n1. e4 e5 2. Nf3 Nc6 *',
    notify() {}, setStatus() {}, showAiView() {}, setAiPanel() {}, aicSync() {}, aicSoftText: (t) => t,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${SRC}\n;globalThis.__cm = { cm, annotateFromComment, askCommentary };`, ctx);
  const { cm } = ctx.__cm;
  cm.game = ctx.state.game;
  return { ctx, calls, ...ctx.__cm };
}

test('a comment goes on the move it is about at once, marked as the AI\'s', () => {
  const { ctx, calls, annotateFromComment } = load();
  const used = annotateFromComment({ ply: 3, uci: 'g1f3', kind: 'comment', text: 'The knight develops with tempo.' });
  assert.equal(used, true);
  const a = ctx.notes.moves.get(3);
  assert.equal(a.comment, 'The knight develops with tempo.');
  assert.equal(a.ai, true);
  assert.equal(ctx.notes.dirty, true);
  // Shown in the moves list without it jumping.
  assert.equal(calls.renders.at(-1)?.steady, true);
});

test('a comment already on the move stays, with its [%eval] and [%clk]', () => {
  const { ctx, annotateFromComment } = load();
  ctx.notes.moves.set(2, { nag: 0, pos: 0, other: [], comment: 'Mine.', cmds: '[%eval 0.20] [%clk 0:02:58]' });
  assert.equal(annotateFromComment({ ply: 2, uci: 'e7e5', kind: 'comment', text: 'Symmetry.' }), false);
  assert.equal(ctx.notes.moves.get(2).comment, 'Mine.');
  // A move with only an evaluation and a clock gets the comment, and keeps them.
  ctx.notes.moves.set(4, { nag: 1, pos: 0, other: [], comment: '', cmds: '[%eval 0.30] [%clk 0:02:50]', autoNag: true });
  assert.equal(annotateFromComment({ ply: 4, uci: 'b8c6', kind: 'comment', text: 'Defends e5.' }), true);
  assert.deepEqual(ctx.notes.moves.get(4), { nag: 1, pos: 0, other: [], comment: 'Defends e5.', cmds: '[%eval 0.30] [%clk 0:02:50]', autoNag: true, ai: true });
});

test('the summary goes before the first move, unless there is a comment there', () => {
  const { ctx, annotateFromComment } = load();
  assert.equal(annotateFromComment({ ply: 4, kind: 'summary', text: 'A quiet Open Game.' }), true);
  assert.equal(ctx.notes.before.comment, 'A quiet Open Game.');
  assert.equal(ctx.notes.before.ai, true);
  ctx.notes.before = { comment: 'From the file.' };
  assert.equal(annotateFromComment({ ply: 4, kind: 'summary', text: 'Again.' }), false);
  assert.equal(ctx.notes.before.comment, 'From the file.');
});

test('not on a move taken back, nor on another played in its place', () => {
  const { ctx, annotateFromComment } = load();
  ctx.state.moves = ctx.state.moves.slice(0, 2);
  assert.equal(annotateFromComment({ ply: 3, uci: 'g1f3', kind: 'comment', text: 'x' }), false);
  ctx.state.moves.push({ uci: 'f1c4', san: 'Bc4' });
  assert.equal(annotateFromComment({ ply: 3, uci: 'g1f3', kind: 'comment', text: 'x' }), false);
  assert.equal(ctx.notes.moves.size, 0);
});

test('not on another game, nor a comment that failed or is still coming', () => {
  const { ctx, annotateFromComment } = load();
  assert.equal(annotateFromComment({ ply: 1, uci: 'e2e4', kind: 'comment', text: 'No API key', error: true }), false);
  assert.equal(annotateFromComment({ ply: 1, uci: 'e2e4', kind: 'comment', text: 'Half a', live: true }), false);
  ctx.state.game = 8;
  assert.equal(annotateFromComment({ ply: 1, uci: 'e2e4', kind: 'comment', text: 'e4!' }), false);
  assert.equal(ctx.notes.moves.size, 0);
});

test('saved at once where the game has a file; waits where it has none', () => {
  const inFile = load({ savable: true });
  inFile.annotateFromComment({ ply: 1, uci: 'e2e4', kind: 'comment', text: 'Best by test.' });
  assert.equal(inFile.calls.saves, 1);
  // Being played: in no file yet; written when it is added to the database.
  const live = load({ savable: false });
  live.annotateFromComment({ ply: 1, uci: 'e2e4', kind: 'comment', text: 'Best by test.' });
  assert.equal(live.calls.saves, 0);
  assert.equal(live.ctx.notes.dirty, true);
  // Known to have no file: not tried again at every comment.
  const none = load({ savable: true });
  none.ctx.anSave.none = 7;
  none.annotateFromComment({ ply: 1, uci: 'e2e4', kind: 'comment', text: 'Best by test.' });
  assert.equal(none.calls.saves, 0);
});

test('a comment from the AI (made up here) lands on its move when it arrives', async () => {
  const { ctx, cm, askCommentary } = load({ chat: async () => ({ text: '  Black mirrors   White.  ', model: 'fake-model' }) });
  cm.lastPly = 0;
  await askCommentary('comment');
  const a = ctx.notes.moves.get(4);
  assert.equal(a.comment, 'Black mirrors White.');
  assert.equal(a.ai, true);
  assert.equal(ctx.notes.aiModel, 'fake-model');
});
