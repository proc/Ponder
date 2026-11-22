'use strict';
// Tests for the voice command parser (app/renderer/voice-parse.js).
// The legal moves of each position come from the Go backend, so build it
// first (npm run build:backend), then: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const voice = require('../app/renderer/voice-parse.js');

const bin = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'backend.exe' : 'backend');

const POS = {
  start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  // Both rooks can reach d1.
  rooks: '4k3/8/8/8/8/8/8/R4RK1 w - - 0 1',
  // Both sides can castle either way; white to move.
  castle: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
  // The pawn on e7 can promote on e8 or by taking on d8.
  promo: '3r4/4P3/8/8/8/8/k7/4K3 w - - 0 1',
  // After 1 e4 e5 2 Nf3 Nc6: the knight can take on e5.
  italian: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  // The queen can take on d7 with check.
  queen: 'rnbqkbnr/pppppppp/8/8/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1',
  // After 1 e4 d5: e takes d5.
  scandi: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2',
  // Knights on b1 and f1 can both reach d2.
  knights: '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1',
};

let legal = {};
test.before(async () => {
  if (!fs.existsSync(bin)) throw new Error('Build the backend first: npm run build:backend');
  const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  lines.on('line', (line) => {
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg.data); pending.delete(msg.id); }
  });
  let id = 0;
  const ask = (fen) => new Promise((resolve) => {
    pending.set(++id, resolve);
    proc.stdin.write(JSON.stringify({ id, cmd: 'positionInfo', args: { fen } }) + '\n');
  });
  for (const [name, fen] of Object.entries(POS)) legal[name] = (await ask(fen)).legal;
  proc.stdin.end();
});

const parse = (pos, text) => voice.parse(text, POS[pos], legal[pos]);
const move = (pos, text, uci) => test(`${pos}: “${text}” → ${uci}`, () => {
  const r = parse(pos, text);
  assert.equal(r.kind, 'move', `got ${JSON.stringify(r)}`);
  assert.equal(r.uci, uci);
});
const none = (pos, text, re) => test(`${pos}: “${text}” is not played`, () => {
  const r = parse(pos, text);
  assert.equal(r.kind, 'none', `got ${JSON.stringify(r)}`);
  if (re) assert.match(r.message, re);
});
const cmd = (text, name) => test(`“${text}” → ${name}`, () => {
  const r = parse('start', text);
  assert.equal(r.kind, 'command', `got ${JSON.stringify(r)}`);
  assert.equal(r.name, name);
});

// Pawn moves.
move('start', 'e4', 'e2e4');
move('start', 'E4.', 'e2e4');
move('start', 'e four', 'e2e4');
move('start', 'pawn e4', 'e2e4');
move('start', 'pawn to e4', 'e2e4');
move('start', 'e for', 'e2e4');
move('start', 'd4', 'd2d4');
move('start', 'dee four', 'd2d4');
move('start', 'see four', 'c2c4');
move('start', 'c 4', 'c2c4');
move('start', 'before', 'b2b4');
move('start', 'be four', 'b2b4');
move('start', 'bee 3', 'b2b3');
move('start', 'h3', 'h2h3');
move('start', 'aitch three', 'h2h3');
move('start', 'a three', 'a2a3');
move('start', 'gee three', 'g2g3');

// Square to square.
move('start', 'e2 e4', 'e2e4');
move('start', 'e2e4', 'e2e4');
move('start', 'e two e four', 'e2e4');
move('start', 'e to e four', 'e2e4');
move('start', 'e2 to e4', 'e2e4');
move('start', 'g1 f3', 'g1f3');
move('start', 'from g1 to f3', 'g1f3');

// Pieces, and how they are misheard.
move('start', 'knight f3', 'g1f3');
move('start', 'Knight F3', 'g1f3');
move('start', 'night f3', 'g1f3');
move('start', 'knight to f3', 'g1f3');
move('start', 'Nf3', 'g1f3');
move('start', 'knight c3', 'b1c3');
move('start', 'knight see three', 'b1c3');
move('start', 'knight a3', 'b1a3');
move('start', 'a knight to f3', 'g1f3');
move('start', 'knight b1 c3', 'b1c3');

// Captures and checks.
move('italian', 'knight takes e5', 'f3e5');
move('italian', 'knight captures e5', 'f3e5');
move('italian', 'knight x e5', 'f3e5');
move('italian', 'Nxe5', 'f3e5');
move('italian', 'knight e5', 'f3e5');
move('queen', 'queen takes d7 check', 'd1d7');
move('queen', 'queen takes d7', 'd1d7');
move('queen', 'Qxd7+', 'd1d7');
move('queen', 'queen d7', 'd1d7');
move('scandi', 'e takes d5', 'e4d5');
move('scandi', 'pawn takes d5', 'e4d5');
move('scandi', 'takes d5', 'e4d5');
move('scandi', 'exd5', 'e4d5');
move('scandi', 'e4 takes d5', 'e4d5');

// Disambiguation.
none('rooks', 'rook d1', /a1 or f1/);
move('rooks', 'rook a d1', 'a1d1');
move('rooks', 'rook f d1', 'f1d1');
move('rooks', 'rook a1 d1', 'a1d1');
move('rooks', 'rook eh d1', 'a1d1');
move('rooks', 'rook a5', 'a1a5');
move('rooks', 'rook f5', 'f1f5');
none('knights', 'knight d2', /b1 or f1/);
move('knights', 'knight b d2', 'b1d2');
move('knights', 'knight be d2', 'b1d2');
move('knights', 'knight f d2', 'f1d2');

// Castling.
move('castle', 'castle kingside', 'e1g1');
move('castle', 'castles king side', 'e1g1');
move('castle', 'short castle', 'e1g1');
move('castle', 'castle short', 'e1g1');
move('castle', 'O-O', 'e1g1');
move('castle', 'castle queenside', 'e1c1');
move('castle', 'long castle', 'e1c1');
move('castle', 'castle queen side', 'e1c1');
move('castle', 'O-O-O', 'e1c1');
move('castle', 'king g1', 'e1g1');
none('castle', 'castle', /kingside.*queenside/);
none('start', 'castle kingside', /not possible/);

// Promotion.
move('promo', 'e8 queen', 'e7e8q');
move('promo', 'e8 knight', 'e7e8n');
move('promo', 'e8 equals queen', 'e7e8q');
move('promo', 'e8=Q', 'e7e8q');
move('promo', 'e8q', 'e7e8q');
move('promo', 'e ate queen', 'e7e8q');
move('promo', 'e8 promote to queen', 'e7e8q');
move('promo', 'pawn e8 queen', 'e7e8q');
move('promo', 'takes d8 queen', 'e7d8q');
move('promo', 'e takes d8 rook', 'e7d8r');
none('promo', 'e8', /promote to/);
none('promo', 'promote to queen', /more than one pawn/i);
none('promo', 'promote', /which piece/);

// Nothing fits.
none('start', 'knight e5', /no knight/i);
none('start', 'e5', /no pawn|nothing/i);
none('start', 'queen h5', /no queen/i);
none('start', 'hello there', /not a move/);
none('start', 'move the e4 pawn', null);
move('start', 'move the pawn to e4', 'e2e4');
none('start', '', /Nothing was heard/);
none('start', 'knight', /square/);

// Commands.
cmd('undo', 'undo');
cmd('take back', 'undo');
cmd('takeback', 'undo');
cmd('Take back.', 'undo');
cmd('flip board', 'flip');
cmd('flip the board', 'flip');
cmd('new game', 'newGame');
cmd('resign', 'resign');
cmd('I resign', 'resign');
cmd('offer draw', 'draw');
cmd('offer a draw', 'draw');
cmd('draw', 'draw');
cmd('stop listening', 'stop');

test('describe', () => {
  assert.equal(voice.describe('g1f3', POS.start), 'the knight from g1 to f3');
  assert.equal(voice.describe('f3e5', POS.italian), 'the knight from f3 to e5, taking a pawn');
  assert.equal(voice.describe('e1g1', POS.castle), 'castling kingside');
  assert.equal(voice.describe('e7e8q', POS.promo), 'the pawn from e7 to e8, promoting to a queen');
  assert.equal(voice.describe('e7d8n', POS.promo), 'the pawn from e7 to d8, taking a rook, promoting to a knight');
  assert.equal(voice.describe('e4d5', POS.scandi), 'the pawn from e4 to d5, taking a pawn');
});
