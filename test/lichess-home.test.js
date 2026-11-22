'use strict';
// Tests for the Lichess home's pure parts (app/renderer/lichess-home-data.js).
// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../app/renderer/lichess-home-data.js');

const perfs = { blitz: { rating: 1588, games: 1204, prog: 23 }, rapid: { rating: 1650, games: 312 }, classical: { rating: 1500, games: 3, prov: true },
  correspondence: { rating: 1720, games: 41 }, chess960: { rating: 1400, games: 12 }, atomic: { rating: 1500, games: 0 }, storm: { runs: 4, score: 30 } };

test('perfList shows the usual speeds, then variants played', () => {
  const list = h.perfList(perfs);
  assert.deepEqual(list.map((p) => p.key), ['bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'puzzle', 'chess960']);
  assert.equal(list[0].rating, null);
  assert.equal(list[0].prov, true);
  assert.equal(list[1].prog, 23);
  assert.equal(list[1].prov, false);
  assert.equal(list[3].prov, true);
  assert.equal(h.perfList(undefined).length, 6);
});

test('ratingRange', () => {
  assert.equal(h.ratingRange(perfs, 'rapid', 200), '1450-1850');
  assert.equal(h.ratingRange(perfs, 'rapid', ''), '');
  assert.equal(h.ratingRange(perfs, 'bullet', 200), '');
  assert.equal(h.ratingRange({ rapid: { rating: 700 } }, 'rapid', 300), '600-1000');
});

test('seekArgs: real time', () => {
  assert.deepEqual(h.seekArgs({ kind: 'clock', minutes: '10', increment: '5', color: 'white', rated: true, range: '100' }, perfs).args,
    { rated: true, color: 'white', limit: 600, increment: 5, ratingRange: '1550-1750' });
  assert.deepEqual(h.seekArgs({ kind: 'clock', minutes: '30', increment: '0', color: 'bogus', range: '' }, perfs).args,
    { rated: false, color: 'random', limit: 1800, increment: 0, ratingRange: '' });
  assert.match(h.seekArgs({ kind: 'clock', minutes: '3', increment: '2' }, perfs).error, /blitz.*rapid or slower/);
  assert.match(h.seekArgs({ kind: 'clock', minutes: '0', increment: '2' }, perfs).error, /Minutes/);
  assert.match(h.seekArgs({ kind: 'clock', minutes: '10', increment: '-1' }, perfs).error, /increment/);
  // 5+10 is rapid (5 + 40 × 10 s ≥ 8 min).
  assert.equal(h.seekArgs({ kind: 'clock', minutes: '5', increment: '10' }, perfs).args.limit, 300);
});

test('seekArgs: correspondence', () => {
  assert.deepEqual(h.seekArgs({ kind: 'days', days: '3', rated: true, range: '200' }, perfs).args,
    { rated: true, color: 'random', days: 3, ratingRange: '1520-1920' });
  assert.match(h.seekArgs({ kind: 'days', days: '4' }, perfs).error, /days a move/);
});

test('durationText and playingStatus', () => {
  assert.equal(h.durationText(45), '45 s');
  assert.equal(h.durationText(600), '10 min');
  assert.equal(h.durationText(3600 * 3 + 1200), '3 h 20 min');
  assert.equal(h.durationText(86400 * 3 + 5), '3 days');
  assert.deepEqual(h.playingStatus({ isMyTurn: false, secondsLeft: 99 }), { text: 'Their move', mine: false });
  assert.deepEqual(h.playingStatus({ isMyTurn: true, secondsLeft: 172800, speed: 'correspondence' }), { text: 'Your move · 2 days to move', mine: true });
  assert.deepEqual(h.playingStatus({ isMyTurn: true, secondsLeft: 540, speed: 'rapid' }), { text: 'Your move · 9 min left', mine: true });
  assert.equal(h.playingMeta({ perf: 'correspondence', rated: true, variant: { key: 'standard' } }), 'Correspondence · rated');
  assert.equal(h.playingMeta({ speed: 'blitz', rated: false, variant: { key: 'chess960' } }), 'Blitz · casual · Chess960');
});

test('friendStatus and friendRating', () => {
  const now = Date.UTC(2026, 0, 10);
  assert.equal(h.friendStatus({ playing: true, clock: '3+2' }, now), 'Playing 3+2');
  assert.equal(h.friendStatus({ online: true }, now), 'Online');
  assert.equal(h.friendStatus({ seenAt: now - 5 * 60000 }, now), 'Seen 5 min ago');
  assert.equal(h.friendStatus({ seenAt: now - 5 * 3600000 }, now), 'Seen 5 h ago');
  assert.equal(h.friendStatus({ seenAt: now - 9 * 86400000 }, now), 'Seen 9 days ago');
  assert.equal(h.friendStatus({}, now), 'Offline');
  assert.deepEqual(h.friendRating({ perfs: { blitz: { rating: 1500, games: 0 }, rapid: { rating: 1700, games: 9 } } }), { speed: 'rapid', rating: 1700, prov: false });
  assert.equal(h.friendRating({ perfs: {} }), null);
});

test('lobbyMeta and record', () => {
  assert.equal(h.lobbyMeta({ days: 1, rated: true, variant: 'standard' }), '1 day a move · rated');
  assert.equal(h.lobbyMeta({ days: 7, rated: false, variant: 'chess960', color: 'white' }), '7 days a move · casual · Chess960 · plays white');
  assert.deepEqual(h.record({ all: 1770, win: 850, loss: 780, draw: 140 }), { games: 1770, win: 850, draw: 140, loss: 780, winPct: 48, drawPct: 8, lossPct: 44 });
  assert.equal(h.record({ all: 0, win: 0, loss: 0, draw: 0 }), null);
  assert.equal(h.gameKey({ gameId: 'abc', id: 'abcdefgh' }), 'abc');
});
