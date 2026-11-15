'use strict';
// The versus screen: when a game you are watching starts (someone's on
// Lichess, or your engine's), the two players' cards come in from either
// side of the board to face each other across a "VS", hold a moment, and
// go off again. Each card has the player's colour, name, title and rating,
// and what Lichess knows of them once it has answered (record, games, flag)
// with their score against each other. A click or Esc sends it away at once;
// Settings → General turns it off.

const vs = { game: null, bg: null, queued: null, timers: [], on: (() => { try { return localStorage.getItem('versus') !== 'off'; } catch { return true; } })() };
const VS_HOLD = 5500; // ms the cards face each other
const VS_OUT = 520;   // ms they take to leave

function setVersus(on) {
  vs.on = Boolean(on);
  try { localStorage.setItem('versus', vs.on ? 'on' : 'off'); } catch { /* not kept */ }
  if (!vs.on) { vs.queued = null; hideVersus(true); }
}

// The game the screen is for: the board's, or one that started off it
// (another game of the player you are watching).
const vsState = () => vs.bg ?? (state && state.game === vs.game ? state : null);

// One player's card.
function versusCard(st, side) {
  const p = st.players?.[side] ?? {};
  const user = st.external?.users?.[side] ?? '';
  // What Lichess said of the players is looked up for the board's game.
  const info = user && !vs.bg && typeof plInfo === 'function' ? plInfo(pl.data, user) : null;
  const prof = info ? plJSON(info.profile) : null;
  const speed = st.external?.speed || 'blitz';
  const perf = prof?.perfs?.[speed];
  const rating = p.rating || (perf?.games ? `${perf.rating}${perf.prov ? '?' : ''}` : '');
  const title = prof?.title || p.title || (p.type === 'engine' ? 'BOT' : '');
  const code = prof?.profile?.flag || flagFor(user) || '';
  const flag = flagEmoji(code);
  const king = pieceImage('k', side === 'white');
  king.className = 'vs-piece';
  king.alt = '';
  const facts = [];
  const c = prof?.count;
  if (perf?.games) facts.push(`${Number(perf.games).toLocaleString()} ${speed} games`);
  if (c && c.win + c.draw + c.loss) facts.push(`${Number(c.win).toLocaleString()} won · ${Number(c.draw).toLocaleString()} drawn · ${Number(c.loss).toLocaleString()} lost`);
  if (perf?.prog) facts.push(`${perf.prog > 0 ? '▲' : '▼'}${Math.abs(perf.prog)} lately`);
  const mine = st.external?.kind === 'bot' && p.type === 'engine';
  return el('div', { className: `vs-card ${side}` }, [
    el('div', { className: 'vs-colour' }, [king, el('span', { textContent: side === 'white' ? 'White' : 'Black' }), ...(mine ? [el('span', { className: 'vs-mine', textContent: 'your engine' })] : [])]),
    el('div', { className: 'vs-name' }, [
      ...(title ? [el('span', { className: 'lx-title', textContent: title })] : []),
      el('span', { className: 'vs-name-text', textContent: p.name || (side === 'white' ? 'White' : 'Black'), title: p.name ?? '' }),
      ...(flag ? [el('span', { className: 'vs-flag', textContent: flag, title: flagName(code) })] : []),
    ]),
    el('div', { className: 'vs-rating', textContent: rating || '—' }),
    el('div', { className: 'vs-facts' }, facts.length ? facts.map((f) => el('span', { textContent: f })) : [el('span', { className: 'vs-wait', textContent: user && !vs.bg && !pl.data && !pl.error ? 'Looking them up…' : '' })]),
  ]);
}

function renderVersus() {
  const box = $('#versus');
  const st = vsState();
  if (box.hidden || !st?.players) return;
  const ext = st.external ?? {};
  $('#vs-white').replaceChildren(versusCard(st, 'white'));
  $('#vs-black').replaceChildren(versusCard(st, 'black'));
  // What is being played, and how they have done against each other.
  const label = (ext.label ?? '').replace(/^Lichess · /, '').replace(/^Watching \S+ · /, '');
  $('#vs-event').textContent = vs.bg ? ['Another game', label].filter(Boolean).join(' · ') : label;
  let h2h = '';
  const x = vs.bg ? null : typeof plJSON === 'function' ? plJSON(pl.data?.crosstable) : null;
  const users = ext.users;
  if (x?.nbGames && users?.white && users?.black) {
    const score = (u) => { const k = Object.keys(x.users ?? {}).find((n) => n.toLowerCase() === u.toLowerCase()); return k ? x.users[k] : null; };
    const w = score(users.white);
    const b = score(users.black);
    if (w != null && b != null) h2h = `Head to head: ${String(w).replace('.5', '½')} – ${String(b).replace('.5', '½')} over ${x.nbGames} game${x.nbGames === 1 ? '' : 's'}`;
  }
  $('#vs-h2h').textContent = h2h;
  $('#vs-h2h').hidden = !h2h;
}
// The players' details arrive a moment after the game: the cards fill in.
window.updateVersus = renderVersus;

function hideVersus(now = false) {
  const box = $('#versus');
  vs.timers.forEach(clearTimeout);
  vs.timers = [];
  if (box.hidden) { vs.bg = null; return; }
  if (now) { box.hidden = true; box.className = ''; vs.bg = null; return; }
  // They go off the way they came.
  box.classList.remove('in');
  box.classList.add('out');
  vs.timers.push(setTimeout(() => { box.hidden = true; box.className = ''; vs.bg = null; }, VS_OUT));
}

// bg: a game that started off the board, shown in place of the board's.
// While a result screen is up, the new game's cards wait for it to go.
function showVersus(bg = null) {
  const box = $('#versus');
  if (!$('#ko').hidden) {
    const game = state?.game;
    vs.queued = () => { if (bg || state?.game === game) showVersus(bg); };
    return;
  }
  vs.queued = null;
  vs.timers.forEach(clearTimeout);
  vs.timers = [];
  vs.game = bg ? bg.game : state.game;
  vs.bg = bg;
  box.className = '';
  box.hidden = false;
  renderVersus();
  // The classes that set the cards moving go on once it has been drawn.
  void box.offsetWidth;
  box.classList.add('in');
  sounds.play('versus');
  vs.timers.push(setTimeout(() => hideVersus(), VS_HOLD));
}

// Whether a game with this state gets the versus screen.
// prev is the state it replaces.
function versusWanted(st, prev) {
  const watched = (s) => s?.external?.kind === 'spectate' || s?.external?.kind === 'bot';
  // A game you watch, as it starts: not one joined half way, not the quick
  // succession of a tournament's games, not your own.
  if (!vs.on || puzzleView || !watched(st) || !st.external.live) return false;
  // One of several games of the same player, picked by hand: it is under
  // way, not starting.
  if (window.watchPicked && window.watchPicked === st.external.id) return false;
  // The next match of someone you were already watching is found a little
  // after it starts (Lichess is asked every so often), a few moves in: it
  // gets the screen all the same.
  const next = watched(prev) && prev.external.id !== st.external.id;
  return next || st.moves.length <= 2;
}
window.versusWanted = versusWanted;

// Called when a new game comes onto the board.
function maybeVersus(prev) {
  if (!versusWanted(state, prev)) {
    if (!vs.bg) { vs.queued = null; hideVersus(true); }
    return;
  }
  showVersus();
}
window.maybeVersus = maybeVersus;

// A watched player's game as the list of their games has it, in the shape
// of the board's state: for the screens of a game that is not on the board.
function watchGameState(g) {
  const player = (side) => ({
    type: 'lichess', name: g[side] || (side === 'white' ? 'White' : 'Black'),
    rating: g[side + 'Rating'] ? String(g[side + 'Rating']) : '', title: g[side + 'Title'] ?? '',
  });
  return {
    game: 'watch:' + g.id, result: g.live ? '*' : g.result, reason: g.reason ?? '', moves: { length: g.moves ?? 0 },
    players: { white: player('white'), black: player('black') },
    external: { kind: 'spectate', id: g.id, live: g.live, speed: g.speed, label: g.label, users: { white: g.white, black: g.black } },
  };
}

// Another game of the player you are watching started (they play several
// at once): its cards, over the game on the board.
function showWatchVersus(g) {
  if (!vs.on || puzzleView) return;
  if (!$('#versus').hidden && !vs.bg) return; // not over the board's own
  showVersus(watchGameState(g));
}
window.showWatchVersus = showWatchVersus;

$('#versus').addEventListener('click', () => hideVersus());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#versus').hidden) hideVersus(); });

// ---------------------------------------------------------------------------
// The result screen: when a game ends, its result fills the window the way a
// 1990s fighting game ends a round. A word slams in ("K.O.", "TIME OVER",
// "DRAW GAME"), then who won, then the two players with the score between
// them: the winner's card lit, the loser's knocked askew. It holds a few
// seconds and goes; a click or Esc sends it away at once. The result card
// is underneath when it leaves. Settings → General turns it off.
// ---------------------------------------------------------------------------
// bg: a game of your engine's that ended off the board (it plays several at
// once), shown in place of the board's game.
const ko = { game: null, bg: null, timers: [], on: (() => { try { return localStorage.getItem('koScreen') !== 'off'; } catch { return true; } })() };
const KO_HOLD = 5200;
const KO_OUT = 450;

function setKo(on) {
  ko.on = Boolean(on);
  try { localStorage.setItem('koScreen', ko.on ? 'on' : 'off'); } catch { /* not kept */ }
  if (!ko.on) hideKo(true);
}
window.setKo = setKo;

// The words for a result: the big one, and the line under it.
function koWords(st) {
  const reason = (st.reason ?? '').toLowerCase();
  const winner = st.result === '1-0' ? 'white' : st.result === '0-1' ? 'black' : null;
  const name = (s) => st.players?.[s]?.name || (s === 'white' ? 'White' : 'Black');
  if (st.result === '1/2-1/2') {
    // Why it was drawn: "Threefold repetition", "Stalemate", "On time".
    const why = (st.reason ?? '').replace(/^Draw\b\s*(by\s+)?(the\s+)?/i, '').trim();
    const how = !why ? '' : /^agreement$/i.test(why) ? 'By agreement' : why[0].toUpperCase() + why.slice(1);
    return { kind: 'draw', word: 'DRAW GAME', sub: how, winner };
  }
  if (!winner) return { kind: 'draw', word: 'GAME OVER', sub: '', winner };
  const word = /time|flag|clock/.test(reason) ? 'TIME OVER' : /mate/.test(reason) ? 'CHECKMATE' : 'K.O.';
  const mine = resultSide(st);
  if (mine) {
    const engine = st.external && st.external.kind !== 'play';
    const won = mine === winner;
    return { kind: won ? 'win' : 'loss', word, sub: engine ? (won ? 'Your engine wins' : 'Your engine loses') : (won ? 'You win' : 'You lose'), winner };
  }
  return { kind: 'win', word, sub: `${name(winner)} wins`, winner };
}

function koCard(st, side, winner) {
  const p = st.players?.[side] ?? {};
  const diff = st.external?.ratingDiff?.[side];
  const king = pieceImage('k', side === 'white');
  king.className = 'vs-piece';
  king.alt = '';
  const state_ = winner == null ? 'even' : winner === side ? 'won' : 'lost';
  const rating = [];
  if (p.rating) {
    rating.push(el('span', { textContent: p.rating }));
    if (diff != null) rating.push(el('span', { className: 'ko-diff ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : ''), textContent: ratingDelta(diff) }));
  }
  return el('div', { className: `ko-card ${side} ${state_}` }, [
    el('div', { className: 'ko-tag', textContent: state_ === 'won' ? 'Winner' : state_ === 'lost' ? 'Defeated' : 'Draw' }),
    el('div', { className: 'vs-colour' }, [king, el('span', { textContent: side === 'white' ? 'White' : 'Black' })]),
    el('div', { className: 'ko-name', title: p.name ?? '' }, [
      ...[flagSpan(st.external?.users?.[side], 'ko-flag')].filter(Boolean), p.name || (side === 'white' ? 'White' : 'Black')]),
    el('div', { className: 'ko-rating' }, rating),
  ]);
}

// The game the screen is for: the board's, or one that ended off it.
const koState = () => ko.bg ?? (state && state.game === ko.game ? state : null);

function renderKo() {
  const box = $('#ko');
  const st = koState();
  if (box.hidden || !st || st.result === '*') return;
  const w = koWords(st);
  box.dataset.kind = w.kind;
  $('#ko-word').textContent = w.word;
  $('#ko-word').classList.toggle('long', w.word.length > 5);
  $('#ko-sub').textContent = w.sub;
  $('#ko-white').replaceChildren(koCard(st, 'white', w.winner));
  $('#ko-black').replaceChildren(koCard(st, 'black', w.winner));
  const pts = st.result === '1-0' ? ['1', '0'] : st.result === '0-1' ? ['0', '1'] : st.result === '1/2-1/2' ? ['½', '½'] : ['–', '–'];
  $('#ko-score').replaceChildren(el('b', { textContent: pts[0] }), el('span', { textContent: '–' }), el('b', { textContent: pts[1] }));
  const moves = Math.ceil(st.moves.length / 2);
  // A draw's reason is the line under the word already.
  const reason = st.result === '1/2-1/2' ? '' : (st.reason ?? '').replace(/^(White|Black) wins /, '');
  $('#ko-reason').textContent = [ko.bg ? 'Another game' : '', reason && reason[0].toUpperCase() + reason.slice(1),
    moves ? `${moves} move${moves === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
}
// The rating changes come a moment after the result.
window.updateKo = renderKo;

function hideKo(now = false) {
  const box = $('#ko');
  ko.timers.forEach(clearTimeout);
  ko.timers = [];
  const gone = () => {
    box.hidden = true;
    box.className = '';
    ko.bg = null;
    const next = vs.queued;
    vs.queued = null;
    next?.();
  };
  if (box.hidden) { ko.bg = null; return; }
  if (now) { gone(); return; }
  box.classList.remove('in');
  box.classList.add('out');
  ko.timers.push(setTimeout(gone, KO_OUT));
}
window.hideKo = hideKo;

// Called once a game's result is in (not for a tournament's games).
function showKo(st, bg = null) {
  if (!ko.on || !st || st.result === '*' || puzzleView) return;
  if (ko.game === st.game && !$('#ko').hidden) { renderKo(); return; }
  // Once a game: a finished game is reported again (its rating changes).
  if (ko.shown === st.game) return;
  ko.shown = st.game;
  // A game starting meanwhile shows its cards once the result has gone.
  if (!$('#versus').hidden) {
    const bg_ = vs.bg;
    const game = vs.game;
    vs.queued = bg_ ? () => showVersus(bg_) : () => { if (state?.game === game) showVersus(); };
  }
  vs.timers.forEach(clearTimeout);
  vs.timers = [];
  $('#versus').hidden = true;
  $('#versus').className = '';
  vs.bg = null;
  const box = $('#ko');
  ko.timers.forEach(clearTimeout);
  ko.timers = [];
  ko.game = st.game;
  ko.bg = bg;
  box.className = '';
  box.hidden = false;
  // Analyze with AI goes over the board's game: not for one off the board.
  $('#ko-ai').hidden = Boolean(bg) || !window.canAnalyseWithAi?.();
  renderKo();
  void box.offsetWidth;
  box.classList.add('in');
  ko.timers.push(setTimeout(() => hideKo(), KO_HOLD));
}
window.showKo = showKo;

// Your engine plays several games at once: one that ends off the board gets
// the screen too, with its sound. Its state is made from the game list.
const KO_STATUS = {
  mate: (w) => `${w} wins by checkmate`, resign: (w) => `${w} wins by resignation`,
  outoftime: (w) => (w ? `${w} wins on time` : 'Draw on time'), timeout: (w) => (w ? `${w} wins on time` : 'Draw on time'),
  stalemate: () => 'Draw by stalemate',
};
function showBackgroundKo(g, me) {
  const white = g.color === 'white';
  const engine = { type: 'engine', name: me };
  const opp = { type: 'lichess', name: g.opponent, rating: g.opponentRating ? String(g.opponentRating) : '' };
  const winner = g.result === '1-0' ? 'White' : g.result === '0-1' ? 'Black' : '';
  // A draw Lichess gives no reason for: the fifty-move counter can say.
  const fifty = Number((g.fen ?? '').split(' ')[4]) >= 100;
  const reason = KO_STATUS[g.status]?.(winner) ?? (g.result === '1/2-1/2' ? (fifty ? 'Draw by the fifty-move rule' : '') : `${winner} wins`);
  const st = {
    game: 'bot:' + g.id, result: g.result, reason, moves: { length: g.moves ?? 0 },
    players: { white: white ? engine : opp, black: white ? opp : engine },
    external: { kind: 'bot', id: g.id, live: false, users: { white: white ? me : g.opponent, black: white ? g.opponent : me } },
  };
  if (!ko.on || !$('#ko').hidden) return; // not over the board's own result
  const end = endSound(st);
  if (end) sounds.play(end);
  showKo(st, st);
}
window.showBackgroundKo = showBackgroundKo;

// A game of the player you are watching that ends off the board.
function showWatchKo(g) {
  if (!ko.on || !$('#ko').hidden || puzzleView) return;
  if (!['1-0', '0-1', '1/2-1/2'].includes(g.result)) return;
  const st = watchGameState(g);
  const end = endSound(st);
  if (end) sounds.play(end);
  showKo(st, st);
}
window.showWatchKo = showWatchKo;

// The board's game ended and another took the board: its result screen
// stays up, as a game off the board now.
function keepKoFor(prev) {
  if ($('#ko').hidden || ko.bg || !prev || ko.game !== prev.game || prev.result === '*') return false;
  ko.bg = prev;
  ko.shown = null;
  return true;
}
window.keepKoFor = keepKoFor;

// Analyze with AI: the screen and the result card go, the AI panel opens.
$('#ko-ai').addEventListener('click', (e) => {
  e.stopPropagation();
  hideKo(true);
  if (typeof hideGameOver === 'function') hideGameOver();
  window.analyseGameWithAi?.();
});
$('#ko').addEventListener('click', () => hideKo());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#ko').hidden) hideKo(); }, true);
