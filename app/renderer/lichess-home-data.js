'use strict';
// The Lichess home's pure parts: turning what the backend reads (profile,
// ongoing games, players followed, lobby) into what the home shows, and the
// "Create a seek" form into the backend's arguments. No DOM here, so
// test/lichess-home.test.js can run it under Node.
(function (root) {
  // The ratings shown, in Lichess's order; other variants follow when played.
  const PERF_ORDER = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'puzzle'];
  const PERF_NAMES = {
    ultraBullet: 'UltraBullet', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical',
    correspondence: 'Correspondence', puzzle: 'Puzzles', chess960: 'Chess960', kingOfTheHill: 'King of the Hill',
    threeCheck: 'Three-check', antichess: 'Antichess', atomic: 'Atomic', horde: 'Horde', racingKings: 'Racing Kings',
    crazyhouse: 'Crazyhouse', storm: 'Puzzle Storm', racer: 'Puzzle Racer', streak: 'Puzzle Streak',
  };
  const CORR_DAYS = [1, 2, 3, 5, 7, 10, 14];

  const perfName = (key) => PERF_NAMES[key] ?? key;

  // The ratings to show: the usual speeds always, others once played.
  // Puzzle Storm and friends give a score, not a rating, and are left out.
  function perfList(perfs) {
    perfs = perfs ?? {};
    const out = [];
    for (const key of PERF_ORDER) {
      const p = perfs[key];
      out.push({ key, name: perfName(key), rating: p?.rating ?? null, games: p?.games ?? 0, prog: p?.prog ?? 0, prov: Boolean(p?.prov) || !p?.games });
    }
    for (const [key, p] of Object.entries(perfs)) {
      if (PERF_ORDER.includes(key) || ['storm', 'racer', 'streak'].includes(key) || !p?.games) continue;
      out.push({ key, name: perfName(key), rating: p.rating ?? null, games: p.games, prog: p.prog ?? 0, prov: Boolean(p.prov) });
    }
    return out;
  }

  // Lichess's speed of a clock (estimated length: initial + 40 × increment).
  function speedOf(limit, inc) {
    const t = limit + 40 * inc;
    return t < 30 ? 'ultraBullet' : t < 180 ? 'bullet' : t < 480 ? 'blitz' : t < 1500 ? 'rapid' : 'classical';
  }

  // "1450-1650": players within spread of the rating at that speed; '' for
  // any rating, or when the person has no rating there yet.
  function ratingRange(perfs, speed, spread) {
    spread = Number(spread) || 0;
    const r = perfs?.[speed]?.rating;
    if (!spread || !r) return '';
    return `${Math.max(600, r - spread)}-${Math.min(3400, r + spread)}`;
  }

  // The "Create a seek" form's values as the backend's LobbySeek, or an
  // error to show.
  function seekArgs(form, perfs) {
    const rated = Boolean(form.rated);
    const color = ['white', 'black'].includes(form.color) ? form.color : 'random';
    if (form.kind === 'days') {
      const days = Math.round(Number(form.days));
      if (!CORR_DAYS.includes(days)) return { error: `Choose ${CORR_DAYS.join(', ')} days a move.` };
      return { args: { rated, color, days, ratingRange: ratingRange(perfs, 'correspondence', form.range) } };
    }
    const minutes = Number(form.minutes);
    const inc = Math.round(Number(form.increment));
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 180) return { error: 'Minutes must be from 1 to 180.' };
    if (!Number.isFinite(inc) || inc < 0 || inc > 180) return { error: 'The increment must be from 0 to 180 seconds.' };
    const limit = Math.round(minutes * 60);
    const speed = speedOf(limit, inc);
    if (['ultraBullet', 'bullet', 'blitz'].includes(speed)) {
      return { error: `${minutes}+${inc} is ${perfName(speed).toLowerCase()}: Lichess lets apps seek rapid or slower games only (minutes + 40 × increment ≥ 8 minutes). Challenge someone to play it.` };
    }
    return { args: { rated, color, limit, increment: inc, ratingRange: ratingRange(perfs, speed, form.range) } };
  }

  // "3 h 20 min", "2 days", "45 s": a clock or the time left for a move.
  function durationText(secs) {
    secs = Math.max(0, Math.round(secs));
    if (secs >= 2 * 86400) return `${Math.floor(secs / 86400)} days`;
    if (secs >= 3600) {
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
      return m ? `${h} h ${m} min` : `${h} h`;
    }
    if (secs >= 60) return `${Math.floor(secs / 60)} min`;
    return `${secs} s`;
  }

  // An ongoing game's line: whose move it is, and the time left.
  function playingStatus(g) {
    const corr = g.speed === 'correspondence' || g.perf === 'correspondence';
    if (!g.isMyTurn) return { text: 'Their move', mine: false };
    const left = g.secondsLeft > 0 ? ` · ${durationText(g.secondsLeft)} ${corr ? 'to move' : 'left'}` : '';
    return { text: 'Your move' + left, mine: true };
  }

  // "Correspondence · rated" or "Rapid · casual".
  function playingMeta(g) {
    const speed = g.perf || g.speed;
    return [speed ? perfName(speed) : '', g.rated ? 'rated' : 'casual', g.variant?.key && !['standard', 'fromPosition'].includes(g.variant.key) ? perfName(g.variant.key) : '']
      .filter(Boolean).join(' · ');
  }

  // A player followed: "Playing 3+2", "Online", "Seen 3 days ago".
  function friendStatus(f, now = Date.now()) {
    if (f.playing) return f.clock ? `Playing ${f.clock}` : 'Playing';
    if (f.online) return 'Online';
    if (!f.seenAt) return 'Offline';
    const mins = Math.max(0, Math.round((now - f.seenAt) / 60000));
    if (mins < 60) return `Seen ${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `Seen ${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 60) return `Seen ${days} days ago`;
    return `Seen ${Math.round(days / 30)} months ago`;
  }

  // The best known rating of a player followed (blitz first, as on Lichess).
  function friendRating(f) {
    for (const k of ['blitz', 'rapid', 'bullet', 'classical', 'correspondence']) {
      const p = f.perfs?.[k];
      if (p?.games) return { speed: k, rating: p.rating, prov: Boolean(p.prov) };
    }
    return null;
  }

  // "3 days a move · rated · plays white".
  function lobbyMeta(s) {
    const parts = [];
    if (s.days) parts.push(`${s.days} ${s.days === 1 ? 'day' : 'days'} a move`);
    parts.push(s.rated ? 'rated' : 'casual');
    if (s.variant && s.variant !== 'standard') parts.push(perfName(s.variant));
    if (s.color === 'white' || s.color === 'black') parts.push(`plays ${s.color}`);
    return parts.join(' · ');
  }

  // Win / draw / loss shares of the games counted.
  function record(count) {
    if (!count) return null;
    const n = (count.win ?? 0) + (count.draw ?? 0) + (count.loss ?? 0);
    if (!n) return null;
    const pct = (x) => Math.round((100 * x) / n);
    return { games: count.all ?? n, win: count.win ?? 0, draw: count.draw ?? 0, loss: count.loss ?? 0, winPct: pct(count.win ?? 0), drawPct: pct(count.draw ?? 0), lossPct: pct(count.loss ?? 0) };
  }

  const gameKey = (g) => g.gameId || g.id;

  const api = { PERF_ORDER, CORR_DAYS, perfName, perfList, speedOf, ratingRange, seekArgs, durationText, playingStatus, playingMeta, friendStatus, friendRating, lobbyMeta, record, gameKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.lichessHomeData = api;
}(typeof window !== 'undefined' ? window : globalThis));
