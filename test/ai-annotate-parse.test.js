'use strict';
// Reading the model's annotation of a game: the JSON asked for, and the
// near misses some models answer with.
const test = require('node:test');
const assert = require('node:assert');
const { parseReply } = require('../app/ai.js');

test('the JSON asked for: the summary and the comments, in ply order', () => {
  const r = parseReply('Here you go:\n```json\n{"summary": "A sharp game.", "comments": [{"ply": 12, "mark": "?", "comment": "Too slow."}, {"ply": 3, "mark": "!", "comment": "Good."}]}\n```', 40);
  assert.equal(r.summary, 'A sharp game.');
  assert.deepEqual(r.comments.map((c) => [c.ply, c.mark, c.comment]), [[3, '!', 'Good.'], [12, '?', 'Too slow.']]);
  assert.ok(!r.loose);
});

test('comments without their braces, and an answer cut off: read field by field', () => {
  const text = '{"summary": "White built a typical Catalan with early e4 and d5 breaks.", "comments": ["ply": 9, "mark": "!", "comment": "Catalan setup with c4 and g3.", "ply": 17, "mark": "!", "comment": "e4 opens the \\"centre\\".", "ply": 50, "mark": "?", "comment": "Nxd5 allows Bxd5.", "ply": 59, "mark": "!!", "comment": "Nxh6+ sacrifices.", "ply":';
  const r = parseReply(text, 80);
  assert.equal(r.summary, 'White built a typical Catalan with early e4 and d5 breaks.');
  assert.deepEqual(r.comments.map((c) => [c.ply, c.mark, c.comment]), [
    [9, '!', 'Catalan setup with c4 and g3.'],
    [17, '!', 'e4 opens the "centre".'],
    [50, '?', 'Nxd5 allows Bxd5.'],
    [59, '!!', 'Nxh6+ sacrifices.'],
  ]);
  assert.ok(!r.loose, 'not shown as raw text');
});

test('a comma missing between comments: still read', () => {
  const r = parseReply('{"summary": "Even.", "comments": [{"ply": 4, "mark": "?!", "comment": "Odd."} {"ply": 6, "mark": "", "comment": "Fine."}]}', 20);
  assert.deepEqual(r.comments.map((c) => c.ply), [4, 6]);
});

test('no JSON at all: the text is the summary', () => {
  const r = parseReply('White won a nice game.', 20);
  assert.equal(r.summary, 'White won a nice game.');
  assert.equal(r.comments.length, 0);
  assert.ok(r.loose);
});
