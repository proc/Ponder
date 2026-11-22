'use strict';
// The Lichess home, in the Play part of the Lichess tab once you are signed
// in: your profile and ratings, your ongoing games (resume any on the
// board), a custom or correspondence seek, the correspondence lobby, the
// players you follow (who is online, watch or challenge them), and ways to
// Lichess TV and puzzles. The backend reads it all (lichessAcctHome); the
// pure parts are in lichess-home-data.js. Loaded after lichess.js.

const LH = window.lichessHomeData;
const lh = {
  home: null,    // the last home read
  loading: false,
  error: '',     // why it could not be read
  gamesKey: null, // the games the account has, to read again when they change (null: not read yet)
  timer: 0,
};

const lhPrefs = (() => { try { return JSON.parse(localStorage.getItem('lichessHome') ?? '{}') ?? {}; } catch { return {}; } })();
const lhSave = (patch) => {
  Object.assign(lhPrefs, patch);
  try { localStorage.setItem('lichessHome', JSON.stringify(lhPrefs)); } catch { /* not kept */ }
};

const lhBase = () => (me.status.baseUrl || lx.settings?.baseUrl || 'https://lichess.org').replace(/\/+$/, '');
const lhPlayVisible = () => !document.hidden && !$('#pane-lichess').hidden && !document.querySelector('#pane-lichess .lx-view[data-view="play"]').hidden;

async function loadLichessHome(force = false) {
  if (!meOnline() || lh.loading) return;
  if (!force && lh.home && Date.now() - lh.home.at < 15000) return;
  lh.loading = true;
  renderLichessHomeParts();
  try {
    lh.home = await api.backend('lichessAcctHome');
    lh.error = '';
  } catch (err) {
    lh.error = errorText(err);
  }
  lh.loading = false;
  renderLichessHomeParts();
  // Who Lichess TV has on, for the line beside the links.
  lxTVNow().then(renderFeatured).catch(() => {});
}

// Your games: the home lists those Lichess says are going on; the list of
// games below keeps the finished ones and any not read yet.
window.homeListsGame = (g) => Boolean(!g.finished && lh.home?.playing?.some((p) => LH.gameKey(p) === g.id));

// Called at the end of each renderMe (the account's status changed).
window.renderLichessHome = () => {
  if (!meOnline()) {
    lh.home = null;
    lh.gamesKey = null;
    return;
  }
  // A game started or ended: read the home again (once things settle).
  const key = (me.status.games ?? []).map((g) => `${g.id}:${g.finished ? 1 : 0}`).sort().join(',');
  if (lh.gamesKey === null || key !== lh.gamesKey) {
    const first = lh.gamesKey === null;
    lh.gamesKey = key;
    clearTimeout(lh.timer);
    lh.timer = setTimeout(() => loadLichessHome(true), first ? 0 : 1500);
  }
  renderLichessHomeParts();
};

function renderLichessHomeParts() {
  if (!meOnline()) return;
  renderProfile();
  renderOngoing();
  renderLobby();
  renderFriends();
  renderHomeSeekForm();
  renderFeatured();
  $('#lx-home-refresh').disabled = lh.loading;
  $('#lx-home-refresh').classList.toggle('spinning', lh.loading);
}

// --- profile -----------------------------------------------------------------
function renderProfile() {
  const box = $('#lx-profile');
  const h = lh.home;
  const p = h?.profile;
  if (!p) {
    const text = lh.error || h?.profileError || (lh.loading ? 'Reading your Lichess home…' : '');
    box.replaceChildren(el('div', { className: 'lx-card-row lx-card-sub' + (lh.error || h?.profileError ? ' error' : ''), textContent: text }));
    box.hidden = !text;
    return;
  }
  box.hidden = false;
  const head = el('div', { className: 'lx-card-row lx-profile-head' }, [
    lxWho(p.username, p.title, null),
    p.patron ? el('span', { className: 'lx-patron', title: 'Lichess Patron', textContent: '♥' }) : '',
    el('span', { className: 'lx-meta', textContent: profileSince(p) }),
    el('span', { className: 'lx-actions' }, [lxLink(p.url || `${lhBase()}/@/${p.username}`, 'Profile ↗', 'Your profile on Lichess')]),
  ]);
  const tiles = LH.perfList(p.perfs).map((r) => {
    const prog = r.prog ? el('span', { className: 'lx-prog ' + (r.prog > 0 ? 'up' : 'down'), textContent: (r.prog > 0 ? '▲' : '▼') + Math.abs(r.prog) }) : '';
    return el('div', { className: 'lx-perf' + (r.games ? '' : ' none'), title: r.games ? `${r.name}: ${r.rating}${r.prov ? ' (provisional)' : ''}, ${r.games.toLocaleString()} ${r.key === 'puzzle' ? 'puzzles' : 'games'}` : `No ${r.name.toLowerCase()} games yet` }, [
      el('span', { className: 'lx-perf-name', textContent: r.name }),
      el('b', { textContent: r.rating ? `${r.rating}${r.prov ? '?' : ''}` : '–' }),
      el('span', { className: 'lx-perf-sub' }, [el('span', { textContent: r.games ? r.games.toLocaleString() : '' }), prog]),
    ]);
  });
  const rec = LH.record(p.count);
  const parts = [head, el('div', { className: 'lx-card-row lx-perfs' }, tiles)];
  if (rec) {
    parts.push(el('div', { className: 'lx-card-row lx-record' }, [
      el('span', { className: 'lx-meta', textContent: `${rec.games.toLocaleString()} games` }),
      el('span', { className: 'lx-wdl', title: `${rec.win} won, ${rec.draw} drawn, ${rec.loss} lost` }, [
        el('i', { className: 'w', style: `flex:${rec.win}` }), el('i', { className: 'd', style: `flex:${rec.draw}` }), el('i', { className: 'l', style: `flex:${rec.loss}` }),
      ]),
      el('span', { className: 'lx-meta', textContent: `${rec.winPct}% won · ${rec.drawPct}% drawn · ${rec.lossPct}% lost` }),
    ]));
  }
  box.replaceChildren(...parts);
}

function profileSince(p) {
  const bits = [];
  if (p.createdAt) bits.push(`Since ${new Date(p.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}`);
  if (p.playTime?.total) bits.push(`${Math.round(p.playTime.total / 3600).toLocaleString()} h played`);
  return bits.join(' · ');
}

// --- ongoing games -------------------------------------------------------------
function renderOngoing() {
  const games = lh.home?.playing ?? [];
  const err = lh.home?.playingError;
  $('#lx-ongoing-h').hidden = !games.length && !err;
  $('#lx-ongoing-count').textContent = games.length ? String(games.length) : '';
  const rows = games.map((g) => {
    const id = LH.gameKey(g);
    const followed = (me.status.games ?? []).find((x) => x.id === id);
    const onBoard = state?.external?.id === id;
    const st = LH.playingStatus({ ...g, isMyTurn: followed ? followed.myTurn : g.isMyTurn });
    const opp = g.opponent ?? {};
    const name = opp.username || (opp.ai ? `Stockfish level ${opp.ai}` : 'Anonymous');
    const actions = [];
    if (onBoard) actions.push(el('span', { className: 'lx-onboard', textContent: 'On the board' }));
    else {
      const b = lxButton('Resume', async () => {
        b.disabled = true;
        await lhResume(g, name);
        b.disabled = false;
      }, st.mine ? 'small primary' : 'small');
      actions.push(b);
    }
    actions.push(lxLink(`${lhBase()}/${g.fullId || id}`, 'Lichess ↗', 'Open the game on Lichess'));
    const thumb = el('div', { className: 'lx-thumb' }, [watchMiniBoard({ fen: followed?.fen || g.fen, side: g.color, lastMove: followed?.lastMove || g.lastMove })]);
    return el('div', { className: 'lx-row game live lx-ongoing-row' + (st.mine ? ' myturn' : '') + (onBoard ? ' watching' : '') }, [
      thumb,
      el('div', { className: 'lx-ongoing-main' }, [
        el('div', { className: 'lx-ongoing-line' }, [el('span', { className: 'lx-color ' + g.color, title: `You play ${g.color}` }), lxWho(name, null, opp.rating)]),
        el('span', { className: 'lx-meta', textContent: LH.playingMeta(g) }),
        el('span', { className: 'lx-status', textContent: st.text }),
      ]),
      el('span', { className: 'lx-actions' }, actions),
    ]);
  });
  if (err) rows.push(el('p', { className: 'lx-foot error', textContent: `Your games could not be read: ${err}` }));
  $('#lx-ongoing').replaceChildren(...rows);
}

async function lhResume(g, name) {
  if (state?.active && !state.external) {
    const ok = await confirmDialog(`Resume the game against ${name} on the board? The game you are playing here will be abandoned.`, 'Resume');
    if (!ok) return;
  }
  await meCommand('lichessAcctResume', { id: LH.gameKey(g) });
}

// --- create a seek -------------------------------------------------------------
const CS = { kind: '#lx-cs-kind', minutes: '#lx-cs-time', increment: '#lx-cs-inc', days: '#lx-cs-days', color: '#lx-cs-color', range: '#lx-cs-range', rated: '#lx-cs-rated' };
function seekFormValues() {
  const v = {};
  for (const [k, sel] of Object.entries(CS)) v[k] = k === 'rated' ? $(sel).checked : $(sel).value;
  return v;
}
function renderHomeSeekForm() {
  const v = seekFormValues();
  const days = v.kind === 'days';
  for (const n of document.querySelectorAll('#lx-cs .lx-cs-clock')) n.hidden = days;
  for (const n of document.querySelectorAll('#lx-cs .lx-cs-days')) n.hidden = !days;
  const { args, error } = LH.seekArgs(v, lh.home?.profile?.perfs);
  const note = $('#lx-cs-note');
  const busy = Boolean(me.status.seek) && !days;
  $('#lx-cs-go').disabled = Boolean(error) || busy;
  if (error) note.textContent = error;
  else if (busy) note.textContent = 'A seek is on already: cancel it under Quick pairing first.';
  else if (days) note.textContent = `Stays in the lobby until someone accepts it${args.ratingRange ? `, for players rated ${args.ratingRange}` : ''}. Lichess has no way for apps to take it back.`;
  else note.textContent = `${LH.perfName(LH.speedOf(args.limit, args.increment))}${args.ratingRange ? `, players rated ${args.ratingRange}` : ''}. Pairs you with a matching seek in the lobby, or waits for one.`;
  note.classList.toggle('error', Boolean(error));
}
function loadSeekFormPrefs() {
  const f = lhPrefs.seek ?? {};
  for (const [k, sel] of Object.entries(CS)) {
    if (f[k] === undefined) continue;
    if (k === 'rated') $(sel).checked = Boolean(f[k]);
    else $(sel).value = f[k];
  }
}
for (const sel of Object.values(CS)) {
  $(sel).addEventListener('input', () => { lhSave({ seek: seekFormValues() }); renderHomeSeekForm(); });
  $(sel).addEventListener('change', () => { lhSave({ seek: seekFormValues() }); renderHomeSeekForm(); });
}
$('#lx-cs').onsubmit = async (e) => {
  e.preventDefault();
  const { args, error } = LH.seekArgs(seekFormValues(), lh.home?.profile?.perfs);
  if (error) return;
  if (!args.days && state?.active && !state.external) {
    const ok = await confirmDialog('Look for a Lichess game? When one starts, it replaces the game you are playing here.', 'Look for a game');
    if (!ok) return;
  }
  $('#lx-cs-go').disabled = true;
  await meCommand('lichessAcctSeek', args);
  renderHomeSeekForm();
};

// --- lobby -------------------------------------------------------------------------
function renderLobby() {
  const h = lh.home;
  const list = h?.lobby ?? [];
  const mine = (me.status.account?.username ?? '').toLowerCase();
  $('#lx-lobby-count').textContent = list.length ? String(list.length) : '';
  $('#lx-lobby').replaceChildren(...list.slice(0, 30).map((s) => el('div', { className: 'lx-row lx-lobby-row' + (s.username?.toLowerCase() === mine ? ' watching' : '') }, [
    lxWho(s.username || 'Anonymous', null, s.rating ? `${s.rating}${s.provisional ? '?' : ''}` : null),
    el('span', { className: 'lx-meta', textContent: LH.lobbyMeta(s) }),
    el('span', { className: 'lx-actions' }, [
      s.username?.toLowerCase() === mine ? el('span', { className: 'lx-onboard', textContent: 'Yours' }) : lxLink(`${lhBase()}/`, 'Join on Lichess ↗', 'Open the Lichess lobby to accept this seek'),
    ]),
  ])));
  const note = $('#lx-lobby-note');
  if (!h) note.textContent = '';
  else if (h.lobbyError) note.textContent = h.lobbyError;
  else if (!list.length) note.textContent = 'No correspondence seeks in the lobby right now. Post one with Create a seek.';
  else note.textContent = 'Lichess lets apps post seeks but not accept other people’s, so join these on Lichess (the game then shows here). Real-time seeks are only on Lichess’s own page: Quick pairing and Create a seek pair you with a matching one.';
  note.classList.toggle('error', Boolean(h?.lobbyError));
}

// --- players followed ----------------------------------------------------------------
$('#lx-friends-online').checked = lhPrefs.onlineOnly !== false;
$('#lx-friends-online').onchange = () => { lhSave({ onlineOnly: $('#lx-friends-online').checked }); renderFriends(); };

function renderFriends() {
  const h = lh.home;
  const all = h?.following ?? [];
  const onlineOnly = $('#lx-friends-online').checked;
  const online = all.filter((f) => f.online || f.playing);
  const shown = onlineOnly ? online : all;
  $('#lx-friends-count').textContent = all.length ? `${online.length} online of ${all.length}` : '';
  $('#lx-friends').replaceChildren(...shown.slice(0, 100).map((f) => {
    const r = LH.friendRating(f);
    const actions = [];
    if (f.playing) actions.push(lxButton('Watch', () => lhWatch(f.name)));
    actions.push(lxButton('Challenge', () => lhChallenge(f.name)));
    actions.push(lxLink(`${lhBase()}/@/${f.name}`, 'Profile ↗', `${f.name} on Lichess`));
    return el('div', { className: 'lx-row lx-friend' + (f.playing ? ' playing' : f.online ? ' online' : ' offline') }, [
      el('span', { className: 'lx-dot' + (f.playing ? ' wait' : f.online ? ' on' : ''), title: f.playing ? 'Playing' : f.online ? 'Online' : 'Offline' }),
      lxWho(f.name, f.title, r ? `${r.rating}${r.prov ? '?' : ''}` : null),
      el('span', { className: 'lx-meta', textContent: LH.friendStatus(f) }),
      el('span', { className: 'lx-actions' }, actions),
    ]);
  }));
  const note = $('#lx-friends-note');
  note.replaceChildren();
  if (h?.followingError) {
    note.append(el('span', { textContent: h.followingError + ' ' }));
    if (h.needsScope) note.append(lxButton('Sign in again', () => $('#lx-signin-go').onclick()));
  } else if (h && !all.length) note.textContent = 'You follow nobody yet. Follow players on Lichess to see here when they are online.';
  else if (h && onlineOnly && !online.length) note.textContent = 'Nobody you follow is online right now.';
  note.hidden = !note.childNodes.length;
  note.classList.toggle('error', Boolean(h?.followingError) && !h?.needsScope);
}

async function lhWatch(name) {
  if (state?.active && !state.external) {
    const ok = await confirmDialog(`Watch ${name}'s games on the board? The game you are playing here will be abandoned.`, 'Watch');
    if (!ok) return;
  }
  const ok = await lichessCommand('lichessSpectate', { baseUrl: lx.settings?.baseUrl, username: name });
  if (ok) lxShowView('watch');
}

function lhChallenge(name) {
  $('#lx-me-user').value = name;
  $('#lx-me-challenge').scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#lx-me-time').focus();
}

// --- TV and puzzles ----------------------------------------------------------------------
function renderFeatured() {
  const best = lxTV.now.get('best');
  const box = $('#lx-home-featured');
  if (!best?.player) { box.replaceChildren(); return; }
  const watch = el('a', { href: '#', textContent: 'Watch', title: 'Watch Lichess TV’s top rated game on the board' });
  watch.onclick = (e) => { e.preventDefault(); lxWatchTV('best').then(() => lxShowView('watch')); };
  box.replaceChildren(el('span', { className: 'lx-meta', textContent: `On TV: ${best.title ? best.title + ' ' : ''}${best.player}${best.rating ? ` (${best.rating})` : ''}` }), ' ', watch);
}
$('#lx-home-tv').onclick = () => lxShowView('watch');
$('#lx-home-puzzles').onclick = () => { window.setPuzzleSource?.('lichess'); showTab('puzzles'); };
$('#lx-home-daily').onclick = () => {
  window.setPuzzleSource?.('lichess');
  showTab('puzzles');
  $('#pz-daily').click();
};
$('#lx-home-refresh').onclick = () => loadLichessHome(true);

// Read again every minute while Play is open; and when it is opened.
setInterval(() => { if (lhPlayVisible()) loadLichessHome(); }, 60000);
$('#lx-seg').addEventListener('change', (e) => { if (e.target.value === 'play') loadLichessHome(); });
$('#tab-lichess').addEventListener('click', () => { if (lhPlayVisible()) loadLichessHome(); });

loadSeekFormPrefs();
