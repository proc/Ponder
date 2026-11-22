'use strict';
// Voice commands: from the words heard to a legal move in the position, or
// to one of a few commands. It knows nothing of the window, so it can be
// tested on its own (test/voice-parse.test.js).
//
//   voiceParse.parse(text, fen, legalMoves)
//     → { kind: 'move', uci, words }      one legal move fits
//     → { kind: 'command', name, words }  undo, flip, newGame, resign, draw, stop
//     → { kind: 'none', message, words }  nothing fits, or several do
//
// legalMoves are the position's legal moves in UCI (e2e4, e7e8q).

(function (root) {
  const FILES = 'abcdefgh';
  const PIECE_NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

  // What a word may be heard as. Words that are also ordinary English
  // ("be", "see", "to", "for", "ate") count as a letter or a number only
  // where one is expected: see the square-joining below.
  const PIECE_WORDS = {
    king: 'k', kings: 'k',
    queen: 'q', queens: 'q', green: 'q',
    rook: 'r', rooks: 'r', rock: 'r', rocks: 'r', brook: 'r', ruck: 'r',
    q: 'q', r: 'r', n: 'n', k: 'k',
    bishop: 'b', bishops: 'b',
    knight: 'n', knights: 'n', night: 'n', nights: 'n', nite: 'n', kn: 'n',
    pawn: 'p', pawns: 'p', porn: 'p', pond: 'p', paun: 'p', prawn: 'p', upon: 'p',
  };
  const FILE_WORDS = {
    a: 'a', ay: 'a', eh: 'a', hey: 'a', alpha: 'a',
    b: 'b', be: 'b', bee: 'b', bea: 'b', bravo: 'b',
    c: 'c', see: 'c', sea: 'c', si: 'c', cee: 'c', charlie: 'c',
    d: 'd', dee: 'd', de: 'd', the: 'd', delta: 'd',
    e: 'e', ee: 'e', echo: 'e',
    f: 'f', ef: 'f', eff: 'f', foxtrot: 'f',
    g: 'g', gee: 'g', ji: 'g', jee: 'g', golf: 'g',
    h: 'h', aitch: 'h', age: 'h', each: 'h', hotel: 'h',
  };
  const RANK_WORDS = {
    1: '1', one: '1', won: '1', first: '1',
    2: '2', two: '2', to: '2', too: '2', second: '2',
    3: '3', three: '3', tree: '3', free: '3', third: '3',
    4: '4', four: '4', for: '4', fore: '4', fourth: '4',
    5: '5', five: '5', fifth: '5',
    6: '6', six: '6', sex: '6', sixth: '6',
    7: '7', seven: '7', seventh: '7',
    8: '8', eight: '8', ate: '8', eighth: '8',
  };
  // Heard as one word, said as a letter and a number.
  const GLUED = {
    before: 'b4', beefour: 'b4', seafour: 'c4', defour: 'd4', eighty: 'a8',
    eat: 'e8', heat: 'e8', eforce: 'e4', efore: 'e4',
  };
  // Letters said as words that are ordinary English as well: a letter only
  // when a number follows, or a square ("rook a d1", "knight be d2").
  const WEAK_FILES = new Set(['a', 'ay', 'eh', 'hey', 'be', 'see', 'sea', 'the', 'de', 'age', 'each', 'ee']);
  // Numbers said as words that are ordinary English as well: a number only
  // right after a letter.
  const WEAK_RANKS = new Set(['to', 'too', 'for', 'fore', 'won', 'ate', 'tree', 'free', 'sex', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth']);
  const TAKE_WORDS = new Set(['takes', 'take', 'took', 'captures', 'capture', 'captured', 'x', 'by', 'times', 'tex', 'tax', 'takes.']);
  const PROMO_WORDS = new Set(['promote', 'promotes', 'promotion', 'promoting', 'promoted', 'equals', 'becomes', 'equal']);
  const FILLER = new Set(['check', 'checkmate', 'mate', 'please', 'move', 'play', 'go', 'goes', 'and', 'um', 'uh', 'er', 'on', 'square', 'from', 'with', 'my', 'piece', 'okay', 'ok', 'now', 'then', 'is', 'of', 'in', 'at', 'it', 'unk', 'side', 'castles', 'castling']);

  // Commands, tried before moves. Each is a list of word patterns.
  const COMMANDS = [
    ['stop', /\b(stop|quit|end) (listening|voice)\b|\bvoice off\b|\bstop it\b/],
    ['undo', /\b(undo|take ?back|takeback|go back|un do)\b/],
    ['flip', /\bflip\b|\b(turn|rotate) the board\b/],
    ['newGame', /\bnew game\b/],
    ['resign', /\b(resign|resigns|i give up)\b/],
    ['draw', /\b(offer (a )?draw|draw offer|agree (a )?draw|propose (a )?draw|draw please|i offer a draw)\b|^draw$/],
  ];

  function normalise(text) {
    return String(text ?? '').toLowerCase()
      .replace(/o-o-o|0-0-0/g, ' castle queenside ')
      .replace(/o-o|0-0/g, ' castle kingside ')
      .replace(/king[\s-]?side/g, 'kingside').replace(/queen[\s-]?side/g, 'queenside')
      .replace(/[=]/g, ' equals ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Words → tokens: piece, file, rank, square, take, promote, castle, side.
  function tokens(words) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      let m;
      if (GLUED[w]) { out.push({ t: 'square', sq: GLUED[w], w }); continue; }
      if ((m = /^([a-h])([1-8])$/.exec(w))) { out.push({ t: 'square', sq: m[1] + m[2], w }); continue; }
      if ((m = /^([a-h])([1-8])([a-h])([1-8])([qrbn]?)$/.exec(w))) {
        out.push({ t: 'square', sq: m[1] + m[2], w }, { t: 'square', sq: m[3] + m[4], w });
        if (m[5]) out.push({ t: 'piece', p: m[5], w });
        continue;
      }
      if ((m = /^([a-h][1-8])([qrbn])$/.exec(w))) { out.push({ t: 'square', sq: m[1], w }, { t: 'piece', p: m[2], w }); continue; }
      if ((m = /^([kqrbn])x?([a-h][1-8])$/.exec(w))) { out.push({ t: 'piece', p: m[1], w }, { t: 'square', sq: m[2], w }); continue; }
      if ((m = /^([a-h])x([a-h][1-8])$/.exec(w))) { out.push({ t: 'file', f: m[1], w }, { t: 'take', w }, { t: 'square', sq: m[2], w }); continue; }
      if (w === 'castle' || w === 'castles' || w === 'castling') { out.push({ t: 'castle', w }); continue; }
      if (w === 'kingside' || w === 'short') { out.push({ t: 'side', side: 'k', w }); continue; }
      if (w === 'queenside' || w === 'long') { out.push({ t: 'side', side: 'q', w }); continue; }
      if (PROMO_WORDS.has(w)) { out.push({ t: 'promote', w }); continue; }
      if (TAKE_WORDS.has(w)) { out.push({ t: 'take', w }); continue; }
      if (PIECE_WORDS[w]) { out.push({ t: 'piece', p: PIECE_WORDS[w], w }); continue; }
      if (FILE_WORDS[w] !== undefined) { out.push({ t: 'file', f: FILE_WORDS[w], w, weak: WEAK_FILES.has(w) }); continue; }
      if (RANK_WORDS[w] !== undefined) { out.push({ t: 'rank', r: RANK_WORDS[w], w, weak: WEAK_RANKS.has(w) }); continue; }
      if (/^[1-8]+$/.test(w) && w.length > 1) { for (const d of w) out.push({ t: 'rank', r: d, w }); continue; }
      // "f3." or "e4," are handled by normalise; anything else is not ours.
      out.push({ t: 'other', w });
    }
    // A letter followed by a number is a square: "e four", "be to".
    const joined = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[i + 1];
      if (a.t === 'file' && b?.t === 'rank') { joined.push({ t: 'square', sq: a.f + b.r, w: a.w + ' ' + b.w }); i++; continue; }
      joined.push(a);
    }
    // What is left of the ordinary-English words is just English: "to" in
    // "knight to f3", "a" in "a knight", "for" in "for the win".
    return joined.filter((tk, i) => {
      if (tk.t === 'rank' && tk.weak) return false;
      if (tk.t === 'file' && tk.weak) return tk.w !== 'the' && joined[i + 1]?.t === 'square';
      if (tk.t === 'other' && FILLER.has(tk.w)) return false;
      return true;
    });
  }

  function parseBoard(fen) {
    const squares = {};
    String(fen).split(' ')[0].split('/').forEach((row, i) => {
      let file = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') { file += +ch; continue; }
        squares[FILES[file] + (8 - i)] = ch;
        file++;
      }
    });
    return squares;
  }

  // The move in words, for the message: "the knight from g1 to f3".
  function describe(uci, fen) {
    const board = parseBoard(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const piece = board[from]?.toLowerCase();
    if (piece === 'k' && Math.abs(from.charCodeAt(0) - to.charCodeAt(0)) === 2) return to[0] === 'g' ? 'castling kingside' : 'castling queenside';
    const taken = board[to]?.toLowerCase() ?? (piece === 'p' && from[0] !== to[0] ? 'p' : null);
    let s = `the ${PIECE_NAMES[piece] ?? 'piece'} from ${from} to ${to}`;
    if (taken) s += `, taking a ${PIECE_NAMES[taken]}`;
    if (uci[4]) s += `, promoting to a ${PIECE_NAMES[uci[4]]}`;
    return s;
  }

  function parse(text, fen, legalMoves) {
    const words = normalise(text);
    if (!words) return { kind: 'none', message: 'Nothing was heard.', words };
    for (const [name, re] of COMMANDS) if (re.test(words)) return { kind: 'command', name, words };

    const toks = tokens(words.split(' '));
    const board = parseBoard(fen);
    const legal = (legalMoves ?? []).map((m) => ({
      uci: m, from: m.slice(0, 2), to: m.slice(2, 4), promo: m[4] || '',
      piece: board[m.slice(0, 2)]?.toLowerCase(),
      capture: Boolean(board[m.slice(2, 4)]) || (board[m.slice(0, 2)]?.toLowerCase() === 'p' && m[0] !== m[2]),
    }));
    const none = (message) => ({ kind: 'none', message, words });
    if (!legal.length) return none('There are no moves to play in this position.');

    // Castling.
    const castle = toks.find((tk) => tk.t === 'castle');
    if (castle || (toks.some((tk) => tk.t === 'side') && !toks.some((tk) => tk.t === 'square'))) {
      const side = toks.find((tk) => tk.t === 'side')?.side;
      const castles = legal.filter((m) => m.piece === 'k' && Math.abs(m.from.charCodeAt(0) - m.to.charCodeAt(0)) === 2);
      const fit = side ? castles.filter((m) => (side === 'k') === (m.to[0] === 'g')) : castles;
      if (fit.length === 1) return { kind: 'move', uci: fit[0].uci, words };
      if (!castles.length) return none('Castling is not possible here.');
      if (!side) return none('Say which way to castle: kingside (short) or queenside (long).');
      return none(`Castling ${side === 'k' ? 'kingside' : 'queenside'} is not possible here.`);
    }

    // The rest: [piece] [from file | rank | square] [takes] square [promote [to] piece].
    const squares = toks.filter((tk) => tk.t === 'square');
    // "promote to queen", with no square: the one pawn that can.
    const promoOnly = toks.findIndex((tk) => tk.t === 'promote');
    if (!squares.length && promoOnly >= 0) {
      const p = toks.slice(promoOnly).find((tk) => tk.t === 'piece')?.p;
      if (!p) return none('Say which piece to promote to, for example “promote to queen”.');
      const fit = legal.filter((m) => m.promo === p);
      if (fit.length === 1) return { kind: 'move', uci: fit[0].uci, words };
      if (!fit.length) return none('No pawn can promote here.');
      return none('More than one pawn can promote: say the square too, for example “e8 queen”.');
    }
    if (!squares.length) {
      const other = toks.find((tk) => tk.t === 'other');
      return none(other ? 'That is not a move or a command I know.' : 'Say the square to move to, for example “knight f3” or “e4”.');
    }
    const target = squares[squares.length - 1];
    const ti = toks.indexOf(target);
    const before = toks.slice(0, ti);
    const after = toks.slice(ti + 1);

    let piece = null;
    let promo = null;
    let fromSq = squares.length > 1 ? squares[squares.length - 2].sq : null;
    let fromFile = null;
    let fromRank = null;
    const capture = toks.some((tk) => tk.t === 'take');
    // A piece named after the target, or after "promote", is the promotion.
    const promoAt = toks.findIndex((tk) => tk.t === 'promote');
    for (const [i, tk] of toks.entries()) {
      if (tk.t !== 'piece') continue;
      if (i > ti || (promoAt >= 0 && i > promoAt)) promo = tk.p;
      else if (!piece) piece = tk.p;
    }
    if (promoAt >= 0 && !promo) return none('Say which piece to promote to, for example “e8 queen”.');
    for (const tk of before) {
      if (tk.t === 'file') fromFile = tk.f;
      else if (tk.t === 'rank') fromRank = tk.r;
    }
    // "e takes d5": a pawn from the e-file.
    if (fromFile && !piece && !fromSq) piece = 'p';
    if (after.some((tk) => tk.t === 'square' || tk.t === 'file')) return none('That is not a move or a command I know.');

    let fit = legal.filter((m) => m.to === target.sq);
    if (fromSq) fit = fit.filter((m) => m.from === fromSq);
    if (fromFile) fit = fit.filter((m) => m.from[0] === fromFile);
    if (fromRank) fit = fit.filter((m) => m.from[1] === fromRank);
    if (capture) fit = fit.filter((m) => m.capture);
    if (promo) fit = fit.filter((m) => m.promo === promo);
    if (piece) fit = fit.filter((m) => m.piece === piece);
    else if (!fromSq) {
      // "e4" is a pawn move; with no pawn able to go there, any one piece that can.
      const pawns = fit.filter((m) => m.piece === 'p');
      if (pawns.length) fit = pawns;
    }
    // A promotion with no piece named.
    if (!promo && fit.length > 1 && fit.every((m) => m.promo) && new Set(fit.map((m) => m.from)).size === 1) {
      return none('Say which piece to promote to, for example “e8 queen”.');
    }
    if (fit.length === 1) return { kind: 'move', uci: fit[0].uci, words };

    const name = piece ? PIECE_NAMES[piece] : null;
    const what = `${name ? `${name} ` : ''}${capture ? 'takes ' : ''}${fromSq ? `${fromSq} ` : ''}${target.sq}`;
    if (!fit.length) {
      const anyTo = legal.some((m) => m.to === target.sq);
      if (name || anyTo) return none(`No ${name ?? 'piece'} ${fromSq ? `on ${fromSq} ` : ''}${capture ? 'can take on' : 'can go to'} ${target.sq}.`);
      return none(`Nothing can move to ${target.sq}.`);
    }
    const froms = [...new Set(fit.map((m) => m.from))];
    if (froms.length > 1) return none(`More than one piece fits “${what}”: from ${froms.join(' or ')}. Add where it comes from, for example “${name ?? 'rook'} ${froms[0][0]} ${target.sq}”.`);
    return none(`“${what}” fits more than one move.`);
  }

  const api = { parse, describe, normalise };
  // What the recogniser listens for: phrases of chess, so that it learns
  // which word may follow which (a number after a letter, a square after a
  // piece) and hears "e four" rather than "four". Only these words can be
  // heard; anything else comes back as [unk]. Vosk's small English model
  // has no "kingside": it hears "king side".
  api.grammar = () => {
    const files = [...FILES];
    const ranks = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    const pieces = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
    const out = [];
    files.forEach((f, fi) => ranks.forEach((r, ri) => {
      const sq = `${f} ${r}`;
      out.push(sq, `takes ${sq}`, `${sq} check`);
      for (const p of pieces) out.push(`${p} ${sq}`, `${p} takes ${sq}`);
      // From a file or square: "e takes d five", "e two e four", "rook a d one".
      out.push(`${files[(fi + 1) % 8]} takes ${sq}`, `${files[(fi + ri + 3) % 8]} ${ranks[(ri + 2) % 8]} ${sq}`);
      out.push(`rook ${files[(fi + ri + 5) % 8]} ${sq}`, `knight ${files[(fi + 2) % 8]} ${sq}`);
    }));
    for (const f of files) {
      for (const p of ['queen', 'rook', 'bishop', 'knight']) out.push(`${f} eight ${p}`, `${f} one ${p}`, `${f} eight promote to ${p}`);
    }
    out.push('promote to queen', 'promote to knight', 'promote to rook', 'promote to bishop',
      'castle king side', 'castle queen side', 'castles king side', 'castles queen side',
      'short castle', 'long castle', 'castle short', 'castle long', 'castle',
      'undo', 'take back', 'flip board', 'flip the board', 'new game', 'resign', 'offer draw', 'offer a draw', 'draw', 'stop listening',
      '[unk]');
    return out;
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voiceParse = api;
}(typeof window !== 'undefined' ? window : globalThis));
