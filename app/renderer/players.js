'use strict';
// Players: for a Lichess game on the board (watched, your own, your
// engine's), hovering a player's name on their bar shows their ratings at
// every speed, their record overall and at the game's speed, best and worst
// ratings, streaks, how long they have played, their rating history, and
// the score against their opponent. It is read when the game comes up, so
// the card is there at once.

const pl = {
  key: '',          // users + speed of what is shown
  data: null,       // { players: { name: info }, crosstable }
  loading: false,
  error: '',
  chartSpeed: '',   // the speed the chart shows ('' = the game's)
  range: 365,       // days of history in the chart
};
const PL_SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'];
const PL_LABEL = { ultraBullet: 'UltraBullet', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', correspondence: 'Correspondence' };

function plUsers() {
  const u = state?.external?.users;
  if (!u || (!u.white && !u.black)) return null;
  return u;
}

// Your engine's live Lichess game: the side panels turn to the engine, the
// game, the chat and the opponent, and the moves keep a slim column.
const opp = { key: '', on: false };
const botWatching = () => Boolean(state?.external?.kind === 'bot' && state.external.live);

function renderOpponent() {
  const box = $('#opponent');
  const users = plUsers();
  const on = botWatching();
  if (on !== opp.on) {
    opp.on = on;
    workspace.classList.toggle('botwatch', on);
    if (on) showTab('moves'); // the slim column is the moves'
    placeInfo();
  }
  const side = state?.external?.side === 'black' ? 'white' : 'black';
  const name = on ? users?.[side] : '';
  if (box.hidden !== !name) box.hidden = !name;
  if (!name) { opp.key = ''; return; }
  const speed = state.external.speed || 'blitz';
  const key = JSON.stringify([pl.key, name, Boolean(pl.data), pl.loading, pl.error, pl.chartSpeed, pl.range, document.documentElement.dataset.theme]);
  if (key === opp.key) return;
  opp.key = key;
  const body = $('#opponent-body');
  if (!pl.data && pl.error) body.replaceChildren(el('p', { className: 'error', textContent: pl.error }));
  else if (!pl.data) body.replaceChildren(el('p', { className: 'hint', textContent: `Looking ${name} up on Lichess…` }));
  else body.replaceChildren(playerCard(side, name, speed), historyChart(users, speed));
}

// Called whenever the state changes: loads the players of a new game.
function syncPlayersInfo() {
  const users = plUsers();
  markPlayerNames();
  renderOpponent();
  if (!users) { pl.key = ''; hidePlayerPop(); return; }
  const speed = state.external.speed || 'blitz';
  const key = `${users.white}|${users.black}|${speed}`;
  if (key === pl.key) return;
  pl.key = key;
  pl.data = null;
  pl.error = '';
  pl.chartSpeed = '';
  loadPlayersInfo(users, speed, key);
}

async function loadPlayersInfo(users, speed, key) {
  pl.loading = true;
  renderPlayersInfo();
  try {
    const data = await api.lichess.players([users.white, users.black].filter(Boolean), speed);
    if (key !== pl.key) return;
    pl.data = data;
  } catch (err) {
    if (key !== pl.key) return;
    pl.error = errorText(err);
  }
  pl.loading = false;
  renderPlayersInfo();
}

function plJSON(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// A player's entry, whatever the case of the name.
function plInfo(data, name) {
  const players = data?.players ?? {};
  if (players[name]) return players[name];
  const k = Object.keys(players).find((u) => u.toLowerCase() === name.toLowerCase());
  return k ? players[k] : null;
}

const plNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
const plDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const plHours = (s) => (s >= 3600 ? `${Math.round(s / 3600).toLocaleString()} h` : `${Math.round((s ?? 0) / 60)} min`);

// The names on the player bars that have a card to show.
function markPlayerNames() {
  const users = plUsers();
  for (const bar of document.querySelectorAll('.player')) {
    const name = $('.name', bar);
    const has = Boolean(users?.[bar.dataset.side]);
    name.classList.toggle('has-info', has);
    if (has) { name.tabIndex = 0; name.title = ''; } else name.removeAttribute('tabindex');
  }
}

// Redraws the open card (data arrived, a setting changed).
function renderPlayersInfo() {
  markPlayerNames();
  window.renderLichessAbout?.(); // the bot's own card in the Lichess tab
  window.updateVersus?.(); // the versus screen's cards fill in
  renderOpponent();
  if ($('#dlg-challenges').open) window.renderChallengePop?.(); // a challenger's profile arrived
  if ($('#player-pop').hidden) return;
  if (pop.bot) fillBotPop();
  else if (pop.side) fillPlayerPop(pop.side);
}

// The same card for any Lichess player outside a game (the online bots
// list): looked up on first hover and kept, per name and speed.
const plCache = new Map(); // `${name}|${speed}` -> { data, error, loading }

function botLookup(name, speed) {
  const key = `${name.toLowerCase()}|${speed}`;
  let entry = plCache.get(key);
  if (entry && !(entry.error && Date.now() - entry.at > 30000)) return entry;
  entry = { data: null, error: '', loading: true, at: Date.now() };
  plCache.set(key, entry);
  api.lichess.players([name], speed).then((data) => { entry.data = data; }, (err) => { entry.error = errorText(err); })
    .finally(() => {
      entry.loading = false;
      entry.at = Date.now();
      renderPlayersInfo();
    });
  return entry;
}

function fillBotPop() {
  const box = $('#player-pop');
  const { name, speed } = pop.bot;
  const entry = botLookup(name, speed);
  if (entry.loading) { box.replaceChildren(el('p', { className: 'hint pl-loading', textContent: `Looking ${name} up on Lichess…` })); return; }
  if (entry.error) { box.replaceChildren(el('p', { className: 'error pl-loading', textContent: entry.error })); return; }
  box.replaceChildren(
    playerCard('', name, speed, entry.data),
    historyChart({ white: name }, speed, entry.data),
  );
}

// Shows the card for `name` beside nameEl, at speed() (read when shown).
function attachPlayerHover(nameEl, name, speed) {
  nameEl.classList.add('has-info');
  nameEl.title = ''; // the card, not the row's tooltip
  const show = () => {
    clearTimeout(pop.hideTimer);
    if (pop.bot?.name !== name) pl.chartSpeed = ''; // a new card starts at the list's speed
    pop.side = null;
    pop.bot = { name, speed: speed() };
    pop.anchor = nameEl;
    fillBotPop();
    revealPlayerPop();
    placePlayerPop(nameEl);
  };
  nameEl.addEventListener('pointerenter', () => {
    clearTimeout(pop.hideTimer);
    clearTimeout(pop.showTimer);
    pop.showTimer = setTimeout(show, $('#player-pop').hidden ? 300 : 0);
  });
  nameEl.addEventListener('pointerleave', () => {
    clearTimeout(pop.showTimer);
    pop.hideTimer = setTimeout(hidePlayerPop, 250);
  });
}
window.attachPlayerHover = attachPlayerHover;

// The card for one side's player.
function fillPlayerPop(side) {
  const box = $('#player-pop');
  const users = plUsers();
  if (!users?.[side]) { hidePlayerPop(); return; }
  const speed = state.external.speed || 'blitz';
  if (pl.loading && !pl.data) { box.replaceChildren(el('p', { className: 'hint pl-loading', textContent: `Looking ${users[side]} up on Lichess…` })); return; }
  if (pl.error) { box.replaceChildren(el('p', { className: 'error pl-loading', textContent: pl.error })); return; }
  if (!pl.data) { box.replaceChildren(); return; }
  const parts = [playerCard(side, users[side], speed)];
  // Head to head.
  const ct = plJSON(pl.data.crosstable);
  if (ct?.nbGames && users.white && users.black) {
    const score = (name) => {
      const k = Object.keys(ct.users ?? {}).find((u) => u.toLowerCase() === name.toLowerCase());
      return k ? ct.users[k] : 0;
    };
    const fmt = (v) => String(v).replace(/\.5$/, '½').replace(/^0½$/, '½');
    const other = side === 'white' ? 'black' : 'white';
    parts.push(el('div', { className: 'pl-h2h', title: 'Their games against each other on Lichess' }, [
      el('span', { className: 'pl-h2h-label', textContent: 'Against this opponent' }),
      el('span', {}, [el('b', { textContent: users[side] }), ` ${fmt(score(users[side]))} – ${fmt(score(users[other]))} `, users[other]]),
      el('span', { className: 'muted', textContent: `${plNum(ct.nbGames)} games` }),
    ]));
  }
  parts.push(historyChart({ [side]: users[side] }, speed));
  box.replaceChildren(...parts);
}

// Showing and hiding: after a short hover on the name (or focus), staying
// open while the pointer is over the card, so its chart can be used.
const pop = { side: null, bot: null, anchor: null, showTimer: 0, hideTimer: 0 };

function placePlayerPop(nameEl) {
  const box = $('#player-pop');
  const r = nameEl.getBoundingClientRect();
  const h = box.offsetHeight;
  const w = box.offsetWidth;
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  // Below the name, or above it when there is no room below (the bottom bar).
  const below = r.bottom + 6 + h <= innerHeight - 8 || r.top - 6 - h < 8;
  const top = below ? Math.min(r.bottom + 6, innerHeight - h - 8) : r.top - 6 - h;
  box.style.left = `${left}px`;
  box.style.top = `${Math.max(8, top)}px`;
}

function showPlayerPop(nameEl) {
  const side = nameEl.closest('.player')?.dataset.side;
  if (!side || !plUsers()?.[side]) return;
  clearTimeout(pop.hideTimer);
  pop.side = side;
  pop.bot = null;
  pop.anchor = nameEl;
  fillPlayerPop(side);
  revealPlayerPop();
  placePlayerPop(nameEl);
}

// The card fades in when it comes and out when it goes. While it fades out
// it still counts as shown; shown again meanwhile, it comes straight back.
const PL_FADE = 170; // ms, as in the stylesheet
function revealPlayerPop() {
  const box = $('#player-pop');
  clearTimeout(pop.fadeTimer);
  box.classList.remove('leaving');
  box.hidden = false;
}

function hidePlayerPop() {
  clearTimeout(pop.showTimer);
  clearTimeout(pop.hideTimer);
  pop.side = null;
  pop.bot = null;
  pop.anchor = null;
  const box = $('#player-pop');
  if (!box || box.hidden || box.classList.contains('leaving')) return;
  // It fades out, then goes.
  box.classList.add('leaving');
  clearTimeout(pop.fadeTimer);
  pop.fadeTimer = setTimeout(() => { box.hidden = true; box.classList.remove('leaving'); }, PL_FADE);
}

for (const bar of document.querySelectorAll('.player')) {
  const name = $('.name', bar);
  name.addEventListener('pointerenter', () => {
    if (!name.classList.contains('has-info')) return;
    clearTimeout(pop.hideTimer);
    clearTimeout(pop.showTimer);
    pop.showTimer = setTimeout(() => showPlayerPop(name), $('#player-pop').hidden ? 250 : 0);
  });
  name.addEventListener('pointerleave', () => {
    clearTimeout(pop.showTimer);
    pop.hideTimer = setTimeout(hidePlayerPop, 250);
  });
  name.addEventListener('focus', () => { if (name.classList.contains('has-info')) showPlayerPop(name); });
  name.addEventListener('blur', () => { pop.hideTimer = setTimeout(hidePlayerPop, 250); });
}
$('#player-pop').addEventListener('pointerenter', () => clearTimeout(pop.hideTimer));
// Leaving the card closes it, unless one of its menus is in use; a click
// elsewhere closes it then.
$('#player-pop').addEventListener('pointerleave', () => {
  pop.hideTimer = setTimeout(() => { if (!$('#player-pop').matches(':focus-within')) hidePlayerPop(); }, 250);
});
document.addEventListener('pointerdown', (e) => {
  if (!$('#player-pop').hidden && !e.target.closest('#player-pop, .player .name, .lx-bot .name')) hidePlayerPop();
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePlayerPop(); });

function playerCard(side, name, speed, data = pl.data) {
  const sideName = side === 'white' ? 'White' : 'Black';
  if (!name) {
    const p = state.players?.[side];
    return el('div', { className: `pl-card ${side}` }, [
      el('div', { className: 'pl-head' }, [el('span', { className: `pl-dot ${side}` }), el('b', { textContent: p?.name || sideName })]),
      el('p', { className: 'hint', textContent: 'The Lichess computer: no statistics.' }),
    ]);
  }
  const info = plInfo(data, name) ?? {};
  const prof = plJSON(info.profile);
  const perf = plJSON(info.perf);
  const base = (lx.settings?.baseUrl || 'https://lichess.org').replace(/\/+$/, '');
  const flag = typeof flagEmoji === 'function' ? flagEmoji(prof?.profile?.flag) : '';
  const head = el('div', { className: 'pl-head' }, [
    ...(side ? [el('span', { className: `pl-dot ${side}`, title: `${sideName} in this game` })] : []),
    ...(prof?.title ? [el('span', { className: 'lx-title', textContent: prof.title })] : []),
    lxLink(`${base}/@/${name}`, prof?.username ?? name, `${name} on Lichess`),
    ...(flag ? [el('span', { className: 'pl-flag', textContent: flag, title: prof.profile.flag })] : []),
    ...(prof?.patron ? [el('span', { className: 'pl-patron', textContent: '◆', title: 'Lichess patron' })] : []),
  ]);
  if (!prof) {
    return el('div', { className: `pl-card ${side}` }, [head, el('p', { className: 'error', textContent: info.error || 'Not found on Lichess.' })]);
  }
  const p = prof.perfs?.[speed];
  const g = perf?.perf?.glicko;
  const rating = g?.rating != null ? Math.round(g.rating) : p?.rating;
  const prov = g?.provisional ?? p?.prov;
  const prog = perf?.perf?.progress ?? p?.prog;
  const big = el('div', { className: 'pl-rating' }, [
    el('span', { className: 'pl-speed', textContent: PL_LABEL[speed] ?? speed }),
    el('b', { textContent: rating != null ? `${rating}${prov ? '?' : ''}` : '—' }),
    ...(prog ? [el('span', { className: 'pl-prog ' + (prog > 0 ? 'up' : 'down'), title: 'Change over the last 12 games', textContent: `${prog > 0 ? '▲' : '▼'}${Math.abs(prog)}` })] : []),
    ...(perf?.percentile != null ? [el('span', { className: 'pl-pct', textContent: `better than ${perf.percentile}% of ${PL_LABEL[speed] ?? speed} players` })] : []),
    ...(perf?.rank ? [el('span', { className: 'pl-pct', textContent: `rank #${perf.rank}` })] : []),
  ]);
  const rows = [];
  const stat = perf?.stat;
  const record = (c, label) => {
    if (!c || !(c.win + c.loss + c.draw)) return null;
    const total = c.win + c.draw + c.loss;
    const pct = (n) => `${Math.round((n / total) * 100)}%`;
    return el('div', { className: 'pl-record' }, [
      el('div', { className: 'pl-record-label' }, [el('span', { textContent: label }), el('span', { className: 'muted', textContent: `${plNum(total)} games` })]),
      el('div', { className: 'pl-bar', role: 'img', ariaLabel: `${c.win} wins, ${c.draw} draws, ${c.loss} losses` }, [
        el('span', { className: 'w', style: `flex: ${c.win}`, title: `${plNum(c.win)} won (${pct(c.win)})` }),
        el('span', { className: 'd', style: `flex: ${c.draw}`, title: `${plNum(c.draw)} drawn (${pct(c.draw)})` }),
        el('span', { className: 'l', style: `flex: ${c.loss}`, title: `${plNum(c.loss)} lost (${pct(c.loss)})` }),
      ]),
      el('div', { className: 'pl-record-nums' }, [
        el('span', { className: 'w', textContent: `${plNum(c.win)} won` }),
        el('span', { className: 'd', textContent: `${plNum(c.draw)} drawn` }),
        el('span', { className: 'l', textContent: `${plNum(c.loss)} lost` }),
      ]),
    ]);
  };
  const facts = [];
  const fact = (label, value, title = '') => { if (value != null && value !== '') facts.push(el('div', { className: 'pl-fact', title }, [el('span', { textContent: label }), el('b', { textContent: value })])); };
  if (stat) {
    fact('Peak', stat.highest?.int, stat.highest?.at ? `on ${plDate(stat.highest.at)}` : '');
    fact('Lowest', stat.lowest?.int, stat.lowest?.at ? `on ${plDate(stat.lowest.at)}` : '');
    fact('Win streak', stat.resultStreak?.win ? `${stat.resultStreak.win.cur?.v ?? 0} now · best ${stat.resultStreak.win.max?.v ?? 0}` : '');
    fact('Opponents', stat.count?.opAvg ? `${Math.round(stat.count.opAvg)} avg` : '', 'Average rating of their opponents at this speed');
    fact('Time played', stat.count?.seconds ? plHours(stat.count.seconds) : '', `At ${PL_LABEL[speed] ?? speed}`);
  }
  const speedRecord = record(stat?.count, `${PL_LABEL[speed] ?? speed} record`);
  const allRecord = record(prof.count, 'All games');
  const others = PL_SPEEDS.filter((s) => s !== speed && prof.perfs?.[s]?.games).map((s) =>
    el('span', { className: 'pl-other', title: `${plNum(prof.perfs[s].games)} games` }, [`${PL_LABEL[s]} `, el('b', { textContent: `${prof.perfs[s].rating}${prof.perfs[s].prov ? '?' : ''}` })]));
  const account = [
    prof.createdAt ? `Joined ${plDate(prof.createdAt)}` : '',
    prof.playTime?.total ? `${plHours(prof.playTime.total)} played` : '',
    prof.seenAt ? `seen ${typeof obAgo === 'function' ? obAgo(prof.seenAt) : plDate(prof.seenAt)}` : '',
    prof.profile?.location ?? '',
  ].filter(Boolean).join(' · ');
  return el('div', { className: `pl-card ${side}` }, [
    head,
    big,
    ...(others.length ? [el('div', { className: 'pl-others' }, others)] : []),
    ...(speedRecord ? [speedRecord] : []),
    ...(facts.length ? [el('div', { className: 'pl-facts' }, facts)] : []),
    ...(allRecord ? [allRecord] : []),
    ...(account ? [el('div', { className: 'pl-account', textContent: account })] : []),
    ...(prof.profile?.bio ? [el('div', { className: 'pl-bio', textContent: prof.profile.bio })] : []),
    ...(info.error ? [el('p', { className: 'hint', textContent: `Some of it could not be read: ${info.error}` })] : []),
  ]);
}

// Both players' rating at one speed over the chosen time, one line each
// (White blue, Black orange), with a crosshair and the values on hover.
function historyChart(users, gameSpeed, data = pl.data) {
  const speed = pl.chartSpeed || gameSpeed;
  const series = [];
  for (const side of ['white', 'black']) {
    const name = users[side];
    if (!name) continue; // only the sides asked for
    const hist = plJSON(plInfo(data, name)?.history);
    const entry = (hist ?? []).find((h) => h.name?.toLowerCase() === (PL_LABEL[speed] ?? speed).toLowerCase());
    // The window runs from `since` to today. Lichess lists a day only when
    // the rating changed, so the line starts at the rating held when the
    // window opens and runs on flat to today.
    const now = Date.now();
    const all = (entry?.points ?? []).map(([y, m, d, r]) => [Date.UTC(y, m, d), r]).sort((a, b) => a[0] - b[0]);
    const since = pl.range ? now - pl.range * 86400000 : (all[0]?.[0] ?? now);
    const before = all.filter(([t]) => t < since).at(-1);
    const pts = all.filter(([t]) => t >= since && t <= now);
    if (before) pts.unshift([since, before[1]]);
    if (pts.length) pts.push([now, pts.at(-1)[1]]);
    series.push({ side, name, pts, since });
  }
  // Buttons, not menus: a menu's list opens outside the card, which made the
  // pointer leave it and the card close before the choice took.
  const choice = (options, current, pick, label) => el('span', { className: 'pl-seg', role: 'group', ariaLabel: label }, options.map(([value, text]) => {
    const b = el('button', { type: 'button', textContent: text, className: value === current ? 'on' : '' });
    b.setAttribute('aria-pressed', String(value === current));
    b.onclick = (e) => { e.stopPropagation(); pick(value); renderPlayersInfo(); };
    return b;
  }));
  const head = el('div', { className: 'pl-chart-head' }, [
    el('span', { className: 'pl-chart-title', textContent: 'Rating history' }),
    el('span', { className: 'pl-legend' }, series.map((s) => el('span', { className: `key ${s.side}` }, [el('i'), s.name]))),
    el('div', { className: 'pl-chart-opts' }, [
      choice(PL_SPEEDS.map((sp) => [sp, PL_LABEL[sp]]), speed, (v) => { pl.chartSpeed = v; }, 'Speed'),
      choice([[90, '3M'], [365, '1Y'], [1095, '3Y'], [0, 'All']], pl.range, (v) => { pl.range = v; }, 'Time'),
    ]),
  ]);
  const wrap = el('div', { className: 'pl-chart' }, [head]);
  const all = series.flatMap((s) => s.pts);
  if (!all.length) {
    wrap.append(el('p', { className: 'hint', textContent: `No ${PL_LABEL[speed] ?? speed} rating history for this time.` }));
    return wrap;
  }
  const W = 560, H = 190, L = 44, R = 10, T = 10, B = 24;
  // The time axis is the chosen window (all time: from the first rating).
  const t1 = Date.now();
  const t0 = Math.min(...series.map((s) => s.since));
  let r0 = Math.min(...all.map((p) => p[1])), r1 = Math.max(...all.map((p) => p[1]));
  const pad = Math.max(20, (r1 - r0) * 0.08);
  r0 = Math.floor((r0 - pad) / 50) * 50; r1 = Math.ceil((r1 + pad) / 50) * 50;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (r) => T + (1 - (r - r0) / Math.max(1, r1 - r0)) * (H - T - B);
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, kids = []) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const k of kids) n.append(k);
    return n;
  };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pl-svg', role: 'img', 'aria-label': `${PL_LABEL[speed]} rating history of ${series.map((s) => s.name).join(' and ')}` });
  // Grid and axes: a few round ratings, and dates along the bottom.
  const step = [25, 50, 100, 200, 250, 500].find((s) => (r1 - r0) / s <= 5) ?? 500;
  for (let r = Math.ceil(r0 / step) * step; r <= r1; r += step) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(r), y2: y(r), class: 'grid' }));
    const tl = svgEl('text', { x: L - 6, y: y(r) + 4, class: 'tick', 'text-anchor': 'end' }); tl.textContent = r; svg.append(tl);
  }
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    const tx = svgEl('text', { x: x(t), y: H - 6, class: 'tick', 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' });
    tx.textContent = i === ticks ? 'today' : new Date(t).toLocaleDateString(undefined, t1 - t0 <= 120 * 86400000 ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' });
    svg.append(tx);
  }
  for (const s of series) {
    if (!s.pts.length) continue;
    const d = s.pts.map(([t, r], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(r).toFixed(1)}`).join('');
    svg.append(svgEl('path', { d, class: `series ${s.side}` }));
    const [lt, lr] = s.pts.at(-1);
    svg.append(svgEl('circle', { cx: x(lt), cy: y(lr), r: 3.5, class: `end ${s.side}` }));
  }
  // Hover: a vertical line, a dot on each line, and the values.
  const cross = svgEl('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
  const dots = series.map((s) => svgEl('circle', { r: 4, class: `hover ${s.side}`, visibility: 'hidden' }));
  svg.append(cross, ...dots);
  const tip = el('div', { className: 'pl-tip', hidden: true });
  const hit = svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B, class: 'hit' });
  svg.append(hit);
  const nearest = (pts, t) => pts.reduce((best, p) => (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best), null);
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const t = t0 + ((e.clientX - box.left) / box.width * W - L) / (W - L - R) * (t1 - t0);
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t)); cross.setAttribute('visibility', 'visible');
    const rows = [el('div', { className: 'date', textContent: plDate(t) })];
    series.forEach((s, i) => {
      const p = nearest(s.pts, t);
      if (!p) return;
      dots[i].setAttribute('cx', x(p[0])); dots[i].setAttribute('cy', y(p[1])); dots[i].setAttribute('visibility', 'visible');
      rows.push(el('div', { className: `row ${s.side}` }, [el('i'), `${s.name} `, el('b', { textContent: p[1] })]));
    });
    tip.replaceChildren(...rows);
    tip.hidden = false;
    const left = e.clientX - box.left;
    tip.style.left = `${Math.min(left + 12, box.width - 150)}px`;
    tip.style.top = `${e.clientY - box.top - 10}px`;
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  });
  wrap.append(el('div', { className: 'pl-svg-wrap' }, [svg, tip]));
  return wrap;
}

