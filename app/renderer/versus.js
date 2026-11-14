'use strict';
// The versus screen: when a game you are watching starts (someone's on
// Lichess, or your engine's), the two players' cards come in from either
// side of the board to face each other across a "VS", hold a moment, and
// go off again. Each card has the player's colour, name, title and rating,
// and what Lichess knows of them once it has answered (record, games, flag)
// with their score against each other. A click or Esc sends it away at once;
// Settings → General turns it off.

const vs = { game: null, timers: [], on: (() => { try { return localStorage.getItem('versus') !== 'off'; } catch { return true; } })() };
const VS_HOLD = 3200; // ms the cards face each other
const VS_OUT = 520;   // ms they take to leave

function setVersus(on) {
  vs.on = Boolean(on);
  try { localStorage.setItem('versus', vs.on ? 'on' : 'off'); } catch { /* not kept */ }
  if (!vs.on) hideVersus(true);
}

// One player's card.
function versusCard(side) {
  const p = state.players?.[side] ?? {};
  const user = state.external?.users?.[side] ?? '';
  const info = user && typeof plInfo === 'function' ? plInfo(pl.data, user) : null;
  const prof = info ? plJSON(info.profile) : null;
  const speed = state.external?.speed || 'blitz';
  const perf = prof?.perfs?.[speed];
  const rating = p.rating || (perf?.games ? `${perf.rating}${perf.prov ? '?' : ''}` : '');
  const title = prof?.title || (p.type === 'engine' ? 'BOT' : '');
  const flag = typeof flagEmoji === 'function' ? flagEmoji(prof?.profile?.flag) : '';
  const king = pieceImage('k', side === 'white');
  king.className = 'vs-piece';
  king.alt = '';
  const facts = [];
  const c = prof?.count;
  if (perf?.games) facts.push(`${Number(perf.games).toLocaleString()} ${speed} games`);
  if (c && c.win + c.draw + c.loss) facts.push(`${Number(c.win).toLocaleString()} won · ${Number(c.draw).toLocaleString()} drawn · ${Number(c.loss).toLocaleString()} lost`);
  if (perf?.prog) facts.push(`${perf.prog > 0 ? '▲' : '▼'}${Math.abs(perf.prog)} lately`);
  const mine = state.external?.kind === 'bot' && p.type === 'engine';
  return el('div', { className: `vs-card ${side}` }, [
    el('div', { className: 'vs-colour' }, [king, el('span', { textContent: side === 'white' ? 'White' : 'Black' }), ...(mine ? [el('span', { className: 'vs-mine', textContent: 'your engine' })] : [])]),
    el('div', { className: 'vs-name' }, [
      ...(title ? [el('span', { className: 'lx-title', textContent: title })] : []),
      el('span', { className: 'vs-name-text', textContent: p.name || (side === 'white' ? 'White' : 'Black'), title: p.name ?? '' }),
      ...(flag ? [el('span', { className: 'vs-flag', textContent: flag })] : []),
    ]),
    el('div', { className: 'vs-rating', textContent: rating || '—' }),
    el('div', { className: 'vs-facts' }, facts.length ? facts.map((f) => el('span', { textContent: f })) : [el('span', { className: 'vs-wait', textContent: user && !pl.data && !pl.error ? 'Looking them up…' : '' })]),
  ]);
}

function renderVersus() {
  const box = $('#versus');
  if (box.hidden || !state?.players || state.game !== vs.game) return;
  const ext = state.external ?? {};
  $('#vs-white').replaceChildren(versusCard('white'));
  $('#vs-black').replaceChildren(versusCard('black'));
  // What is being played, and how they have done against each other.
  const label = (ext.label ?? '').replace(/^Lichess · /, '').replace(/^Watching \S+ · /, '');
  $('#vs-event').textContent = label;
  let h2h = '';
  const x = typeof plJSON === 'function' ? plJSON(pl.data?.crosstable) : null;
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
  if (box.hidden) return;
  if (now) { box.hidden = true; box.className = ''; return; }
  // They go off the way they came.
  box.classList.remove('in');
  box.classList.add('out');
  vs.timers.push(setTimeout(() => { box.hidden = true; box.className = ''; }, VS_OUT));
}

function showVersus() {
  const box = $('#versus');
  vs.timers.forEach(clearTimeout);
  vs.timers = [];
  vs.game = state.game;
  box.className = '';
  box.hidden = false;
  renderVersus();
  // The classes that set the cards moving go on once it has been drawn.
  void box.offsetWidth;
  box.classList.add('in');
  vs.timers.push(setTimeout(() => hideVersus(), VS_HOLD));
}

// Called when a new game comes onto the board.
function maybeVersus() {
  const ext = state?.external;
  // A game you watch, as it starts: not one joined half way, not the quick
  // succession of a tournament's games, not your own.
  const watching = ext?.live && (ext.kind === 'spectate' || ext.kind === 'bot');
  if (!vs.on || !watching || state.moves.length > 2 || puzzleView) { hideVersus(true); return; }
  showVersus();
}
window.maybeVersus = maybeVersus;

$('#versus').addEventListener('click', () => hideVersus());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#versus').hidden) hideVersus(); });
