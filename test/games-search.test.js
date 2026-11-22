'use strict';
// Tests for the Games list's search (app/renderer/games-search-data.js).
// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../app/renderer/games-search-data.js');

test('splitList reads several names in one field', () => {
  assert.deepEqual(s.splitList('Devilfishbot, EsperEngine'), ['Devilfishbot', 'EsperEngine']);
  assert.deepEqual(s.splitList('Devilfishbot or EsperEngine; Stockfish | Lc0'), ['Devilfishbot', 'EsperEngine', 'Stockfish', 'Lc0']);
  assert.deepEqual(s.splitList(' a ,, , b , A '), ['a', 'b'], 'empty entries and repeats are dropped');
  assert.deepEqual(s.splitList('"Carlsen, Magnus", Nakamura'), ['Carlsen, Magnus', 'Nakamura'], 'quotes keep a comma');
  assert.deepEqual(s.splitList('“Carlsen, Magnus”'), ['Carlsen, Magnus']);
  assert.deepEqual(s.splitList('Orlov'), ['Orlov'], '"or" inside a name is not a separator');
  assert.deepEqual(s.splitList(''), []);
  assert.deepEqual(s.splitList(undefined), []);
});

test('two names and "won" ask for any game either of them won', () => {
  const v = { players: 'Devilfishbot, EsperEngine', outcome: 'won' };
  assert.deepEqual(s.buildQuery(v), { players: ['Devilfishbot', 'EsperEngine'], outcome: 'won' });
  assert.deepEqual(s.describe(v), [{ fields: ['players', 'outcome', 'side'], text: 'Won by Devilfishbot or EsperEngine' }]);
});

test('the player\'s result and colour', () => {
  const d = (v) => s.describe(v).map((x) => x.text);
  assert.deepEqual(d({ players: 'A, B, C', outcome: 'lost', side: 'black' }), ['Lost by A, B or C with Black']);
  assert.deepEqual(d({ players: 'A', outcome: 'drew' }), ['Drawn by A']);
  assert.deepEqual(d({ players: 'A', side: 'white' }), ['A had White']);
  assert.deepEqual(d({ players: 'A' }), ['Played by A']);
  // Without a name, the player's result and colour say nothing; the game's
  // result is the field for "White won".
  assert.deepEqual(s.buildQuery({ outcome: 'won', side: 'white' }), {});
  assert.deepEqual(s.problems({ outcome: 'won' }), ['Name a player above for the player’s result and colour to be used.']);
  assert.deepEqual(d({ result: '1-0' }), ['White won']);
  assert.deepEqual(d({ result: '1/2-1/2' }), ['Drawn']);
});

test('every field together, ANDed', () => {
  const v = {
    players: 'Devilfishbot', outcome: 'won', side: 'white', white: 'x or y', black: 'z', result: 'decisive', opening: 'B90-B99, Najdorf',
    speed: 'blitz', timeControl: ' 180+2 ', rated: 'rated', event: ' Arena ', dateFrom: '2024', dateTo: '2025.06.30', minMoves: '20', maxMoves: '60.4',
  };
  assert.deepEqual(s.buildQuery(v), {
    players: ['Devilfishbot'], outcome: 'won', side: 'white', whites: ['x', 'y'], blacks: ['z'], result: 'decisive',
    openings: ['B90-B99', 'Najdorf'], speed: 'blitz', timeControl: '180+2', rated: 'rated', event: 'Arena',
    dateFrom: '2024', dateTo: '2025.06.30', minMoves: 20, maxMoves: 60,
  });
  assert.deepEqual(s.describe(v).map((x) => x.text), [
    'Won by Devilfishbot with White', 'White was x or y', 'Black was z', 'Won by either side', 'Opening: B90-B99 or Najdorf',
    'Blitz', 'Time control 180+2', 'Rated games', 'Event contains “Arena”', 'Played from 2024 to 2025.06.30', '20 to 60 moves',
  ]);
  assert.deepEqual(s.problems(v), []);
});

test('nothing filled in asks for nothing', () => {
  assert.deepEqual(s.buildQuery({}), {});
  assert.deepEqual(s.describe(s.empty()), []);
  assert.deepEqual(s.buildQuery({ players: ' , ', minMoves: '0', maxMoves: '-3', event: '  ' }), {});
});

test('dates and lengths it cannot use are left out and explained', () => {
  const v = { dateFrom: '2024.13', dateTo: 'soon', minMoves: '50', maxMoves: '10' };
  assert.deepEqual(s.buildQuery(v), { minMoves: 50, maxMoves: 10 });
  assert.equal(s.problems(v).length, 3);
  assert.deepEqual(s.describe({ dateTo: '2023-05' }).map((x) => x.text), ['Played on or before 2023-05']);
  assert.deepEqual(s.describe({ minMoves: '30' }).map((x) => x.text), ['At least 30 moves']);
  assert.ok(s.dateOk('2024') && s.dateOk('2024.05') && s.dateOk('2024/05/31') && !s.dateOk('24.05'));
});

test('normalize keeps only what the panel offers', () => {
  const v = s.normalize({ players: 'A', outcome: 'maybe', speed: 'blitz', rated: 'sometimes', minMoves: 'x', bogus: 1, result: '0-1' });
  assert.equal(v.players, 'A');
  assert.equal(v.outcome, '');
  assert.equal(v.speed, 'blitz');
  assert.equal(v.rated, '');
  assert.equal(v.minMoves, '');
  assert.equal(v.result, '0-1');
  assert.equal('bogus' in v, false);
  assert.deepEqual(Object.keys(v), s.FIELDS);
  assert.deepEqual(s.normalize(null), s.empty());
  assert.deepEqual(s.normalize('junk'), s.empty());
});

test('without clears one filter and leaves the rest', () => {
  const v = { players: 'A', outcome: 'won', speed: 'rapid' };
  const left = s.without(v, s.describe(v)[0].fields);
  assert.deepEqual(s.describe(left).map((x) => x.text), ['Rapid']);
});
