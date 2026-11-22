'use strict';
// The Games list's search, its pure parts: the Search panel's values turned
// into the backend's query (backend/pgn/search.go does the matching, so a
// file of millions of games is searched where it is kept), the filters in
// force described in words, and the values kept between sessions checked.
// No DOM here, so test/games-search.test.js can run it under Node.
(function (root) {
  // Every value the panel holds, and what it is when nothing is asked.
  const FIELDS = [
    'players', 'outcome', 'side', 'white', 'black', 'result', 'opening',
    'speed', 'timeControl', 'rated', 'event', 'dateFrom', 'dateTo', 'minMoves', 'maxMoves',
  ];
  const CHOICES = {
    outcome: { won: 'won', lost: 'lost', drew: 'drew' },
    side: { white: 'White', black: 'Black' },
    result: { '1-0': 'White won', '0-1': 'Black won', '1/2-1/2': 'Drawn', decisive: 'Won by either side', '*': 'Unfinished' },
    speed: {
      ultrabullet: 'UltraBullet', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', correspondence: 'Correspondence',
    },
    rated: { rated: 'Rated games', casual: 'Casual games' },
  };
  const MAX_TEXT = 500;

  const empty = () => Object.fromEntries(FIELDS.map((f) => [f, '']));

  // Several names (or openings) in one field: separated by commas,
  // semicolons, "|" or the word "or". A name in quotes keeps its commas
  // ("Carlsen, Magnus"). Repeats are dropped, ignoring case.
  function splitList(text) {
    const out = [];
    const seen = new Set();
    const add = (s) => {
      s = s.trim().replace(/\s+/g, ' ');
      if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    };
    const src = String(text ?? '');
    const re = /"([^"]*)"?|“([^”]*)”?|([^,;|"“]+)/g;
    for (let m; (m = re.exec(src));) {
      if (m[1] != null || m[2] != null) add(m[1] ?? m[2]);
      else for (const part of m[3].split(/\s+or\s+/i)) add(part);
    }
    return out;
  }

  // A date as the backend reads it: YYYY, YYYY.MM or YYYY.MM.DD, with "-"
  // or "/" also allowed between the parts.
  const DATE = /^\d{4}([./-](0[1-9]|1[0-2])([./-](0[1-9]|[12]\d|3[01]))?)?$/;
  const dateOk = (s) => DATE.test(s);
  const moves = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  // The values kept from last time, or typed in: only the known fields, as
  // trimmed text, choices only among those offered.
  function normalize(values) {
    const out = empty();
    if (!values || typeof values !== 'object') return out;
    for (const f of FIELDS) {
      let v = values[f];
      if (v == null) continue;
      v = String(v).slice(0, MAX_TEXT);
      if (CHOICES[f] && !Object.hasOwn(CHOICES[f], v)) continue;
      if (f === 'minMoves' || f === 'maxMoves') v = moves(v) ? String(moves(v)) : '';
      out[f] = v;
    }
    return out;
  }

  // The query for the backend's listGames. Fields left empty, dates it
  // could not read and a colour or result with no player named are left
  // out, so that what is sent is what describe() says.
  function buildQuery(values) {
    const v = normalize(values);
    const q = {};
    const players = splitList(v.players);
    if (players.length) {
      q.players = players;
      if (v.outcome) q.outcome = v.outcome;
      if (v.side) q.side = v.side;
    }
    const whites = splitList(v.white);
    const blacks = splitList(v.black);
    const openings = splitList(v.opening);
    if (whites.length) q.whites = whites;
    if (blacks.length) q.blacks = blacks;
    if (v.result) q.result = v.result;
    if (openings.length) q.openings = openings;
    if (v.speed) q.speed = v.speed;
    if (v.timeControl.trim()) q.timeControl = v.timeControl.trim();
    if (v.rated) q.rated = v.rated;
    if (v.event.trim()) q.event = v.event.trim();
    if (dateOk(v.dateFrom.trim())) q.dateFrom = v.dateFrom.trim();
    if (dateOk(v.dateTo.trim())) q.dateTo = v.dateTo.trim();
    if (moves(v.minMoves)) q.minMoves = moves(v.minMoves);
    if (moves(v.maxMoves)) q.maxMoves = moves(v.maxMoves);
    return q;
  }

  // "A", "A or B", "A, B or C".
  function either(list) {
    if (list.length <= 1) return list.join('');
    return `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`;
  }

  // The filters in force, each as { fields, text }: the fields it comes
  // from (cleared together) and a short phrase saying what it asks.
  function describe(values) {
    const q = buildQuery(values);
    const out = [];
    const add = (fields, text) => out.push({ fields, text });
    if (q.players) {
      const who = either(q.players);
      const colour = q.side ? ` with ${CHOICES.side[q.side]}` : '';
      const text = q.outcome === 'won' ? `Won by ${who}${colour}`
        : q.outcome === 'lost' ? `Lost by ${who}${colour}`
        : q.outcome === 'drew' ? `Drawn by ${who}${colour}`
        : q.side ? `${who} had ${CHOICES.side[q.side]}`
        : `Played by ${who}`;
      add(['players', 'outcome', 'side'], text);
    }
    if (q.whites) add(['white'], `White was ${either(q.whites)}`);
    if (q.blacks) add(['black'], `Black was ${either(q.blacks)}`);
    if (q.result) add(['result'], CHOICES.result[q.result]);
    if (q.openings) add(['opening'], `Opening: ${either(q.openings)}`);
    if (q.speed) add(['speed'], CHOICES.speed[q.speed]);
    if (q.timeControl) add(['timeControl'], `Time control ${q.timeControl}`);
    if (q.rated) add(['rated'], CHOICES.rated[q.rated]);
    if (q.event) add(['event'], `Event contains “${q.event}”`);
    if (q.dateFrom || q.dateTo) {
      add(['dateFrom', 'dateTo'], q.dateFrom && q.dateTo ? `Played from ${q.dateFrom} to ${q.dateTo}`
        : q.dateFrom ? `Played on or after ${q.dateFrom}` : `Played on or before ${q.dateTo}`);
    }
    if (q.minMoves || q.maxMoves) {
      add(['minMoves', 'maxMoves'], q.minMoves && q.maxMoves ? `${q.minMoves} to ${q.maxMoves} moves`
        : q.minMoves ? `At least ${q.minMoves} moves` : `At most ${q.maxMoves} moves`);
    }
    return out;
  }

  // What was filled in but cannot be used, said plainly, for the panel.
  function problems(values) {
    const v = normalize(values);
    const out = [];
    for (const [f, name] of [['dateFrom', 'first date'], ['dateTo', 'last date']]) {
      const s = v[f].trim();
      if (s && !dateOk(s)) out.push(`The ${name} is not used, because it is not written as YYYY, YYYY.MM or YYYY.MM.DD.`);
    }
    if ((v.outcome || v.side) && !splitList(v.players).length) {
      out.push('Name a player above for the player’s result and colour to be used.');
    }
    const lo = moves(v.minMoves);
    const hi = moves(v.maxMoves);
    if (lo && hi && lo > hi) out.push('The fewest moves is more than the most moves, so no game can match.');
    return out;
  }

  // The values with the fields of one filter cleared.
  function without(values, fields) {
    const v = normalize(values);
    for (const f of fields) if (Object.hasOwn(v, f)) v[f] = '';
    return v;
  }

  const api = { FIELDS, CHOICES, empty, splitList, normalize, buildQuery, describe, problems, without, dateOk };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.gamesSearchData = api;
}(typeof window !== 'undefined' ? window : globalThis));
