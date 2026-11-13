'use strict';
// Lichess: the engine plays on Lichess through a Bot account. The Go backend
// talks to Lichess; this file draws the Lichess tab and Settings → Lichess.
// Loaded after renderer.js, whose helpers ($, el, api, state, …) it uses.

const lx = {
  status: { state: 'off', incoming: [], outgoing: [], games: [], account: null, message: '' },
  settings: null,
  note: '',      // a message of our own, e.g. a failed request
  bots: [],
  watch: { active: false, state: 'idle', user: '', message: '' }, // spectating
};

const LX_STATE_TEXT = {
  off: 'Not connected', connecting: 'Connecting…', connected: 'Connected',
  reconnecting: 'Reconnecting…', notBot: 'Not a Bot account', error: 'Could not connect',
};
const lxOnline = () => lx.status.state === 'connected' || lx.status.state === 'reconnecting';
const lxLiveGames = () => (lx.status.games ?? []).filter((g) => !g.finished);
const lxPlayingGames = () => lxLiveGames().filter((g) => g.playing);

// Analysis pauses while the engine is playing on Lichess.
function lichessPlaying() {
  return lxPlayingGames().length > 0;
}

// The Lichess player in the game on the board.
function opponentName() {
  const side = ['white', 'black'].find((s) => state?.players?.[s]?.type === 'lichess');
  return side ? state.players[side].name : 'your opponent';
}

function lxSetNote(text) {
  lx.note = text;
  renderLichess();
}

async function lichessCommand(cmd, args) {
  try {
    const result = await api.backend(cmd, args);
    if (lx.note) lxSetNote('');
    return result ?? true;
  } catch (err) {
    lxSetNote(errorText(err));
    return null;
  }
}

function lichessStatus(next) {
  const prev = lx.status;
  lx.status = next;
  // A new challenge waiting for an answer.
  const before = new Set((prev.incoming ?? []).map((c) => c.id));
  if ((next.incoming ?? []).some((c) => !before.has(c.id))) sounds.play('challenge');
  renderLichess();
  renderLichessSettingsStatus();
  // Once the bot is connected, list the bots online without waiting for a click.
  if (next.state === 'connected' && prev.state !== 'connected' && !Array.isArray(ob.bots)) loadOnlineBots();
  if (typeof syncAnalysis === 'function') { syncAnalysis(); renderAnalysis(); }
}

// ---------------------------------------------------------------------------
// The Lichess tab
// ---------------------------------------------------------------------------
const lxLink = (url, text, title) => {
  const a = el('a', { href: '#', textContent: text, title: title ?? url });
  a.onclick = (e) => { e.preventDefault(); api.openExternal(url).catch((err) => lxSetNote(errorText(err))); };
  return a;
};
const lxButton = (text, onclick, className = 'small') => {
  const b = el('button', { type: 'button', className, textContent: text });
  b.onclick = onclick;
  return b;
};
const lxWho = (name, title, rating) => {
  const parts = [];
  if (title) parts.push(el('span', { className: 'lx-title', textContent: title }));
  parts.push(el('span', { className: 'lx-name', textContent: name || '?' }));
  if (rating) parts.push(el('span', { className: 'lx-rating', textContent: String(rating) }));
  return el('span', { className: 'lx-who' }, parts);
};

function challengeMeta(c) {
  const bits = [c.tc, c.rated ? 'rated' : 'casual'];
  if (c.speed) bits.push(c.speed);
  if (c.variant && c.variant !== 'Standard') bits.push(c.variant);
  if (c.color && c.color !== 'random') bits.push(`they play ${c.color}`);
  return bits.filter(Boolean).join(' · ');
}

function renderLichess() {
  const s = lx.status;
  const online = lxOnline();
  const dot = s.state === 'connected' ? 'on' : s.state === 'connecting' || s.state === 'reconnecting' ? 'wait' : s.state === 'off' ? 'off' : 'bad';
  $('#lx-dot').className = 'lx-dot ' + dot;
  $('#lx-account').textContent = s.account && online
    ? `${s.account.username}${s.state === 'reconnecting' ? ' · reconnecting…' : ''}`
    : LX_STATE_TEXT[s.state] ?? s.state;
  const connect = $('#lx-connect');
  connect.textContent = s.state === 'off' || s.state === 'error' ? 'Connect' : 'Disconnect';
  connect.disabled = s.state === 'connecting';
  const message = [lx.note, s.message].filter(Boolean).join(' · ');
  $('#lx-message').textContent = message;
  $('#lx-message').hidden = !message;
  $('#lx-message').classList.toggle('error', Boolean(lx.note) || s.state === 'error' || s.state === 'notBot');
  $('#lx-body').hidden = !online;
  $('#lx-off').hidden = online;

  renderMe(); // also counts the tab's badge
  if (ob.bots) renderOnlineBots(); // Challenge needs the bot connected
  if (!online) return;

  // Challenges to the bot.
  $('#lx-auto').checked = Boolean(s.autoAccept);
  $('#lx-auto-note').textContent = s.autoAccept ? 'Challenges that match the auto-accept rules are accepted automatically.' : '';
  renderLichessRules();
  $('#lx-incoming-count').textContent = s.incoming.length ? String(s.incoming.length) : '';
  $('#lx-incoming-empty').hidden = s.incoming.length > 0;
  $('#lx-incoming').replaceChildren(...s.incoming.map((c) => {
    const accept = lxButton('Accept', async () => {
      accept.disabled = true;
      await lichessCommand('lichessAccept', { id: c.id });
      accept.disabled = false;
    }, 'small primary');
    accept.disabled = !c.supported;
    if (!c.supported) accept.title = 'Your engine can only play standard chess with a clock';
    const decline = lxButton('Decline', () => lichessCommand('lichessDecline', { id: c.id, reason: c.supported ? 'generic' : 'standard' }));
    return el('div', { className: 'lx-row' }, [
      lxWho(c.user, c.title, c.rating),
      el('span', { className: 'lx-meta', textContent: challengeMeta(c) + (c.note && c.supported ? ` · outside your settings (${c.note})` : '') }),
      el('span', { className: 'lx-actions' }, [accept, decline]),
    ]);
  }));

  renderSeek();
  renderChallengeLocks();

  // Challenges the bot sent.
  $('#lx-outgoing').replaceChildren(...s.outgoing.map((c) => el('div', { className: 'lx-row waiting' }, [
    el('span', { className: 'lx-meta', textContent: 'Waiting for' }),
    lxWho(c.user, c.title, c.rating),
    el('span', { className: 'lx-meta', textContent: challengeMeta(c) }),
    el('span', { className: 'lx-actions' }, [lxButton('Cancel', () => lichessCommand('lichessCancel', { id: c.id }))]),
  ])));

  // Games, newest first.
  $('#lx-games-empty').hidden = s.games.length > 0;
  $('#lx-games').replaceChildren(...s.games.map((g) => {
    const watching = s.watching === g.id;
    const actions = [];
    if (watching && state?.external?.id === g.id) actions.push(el('span', { className: 'lx-onboard', textContent: 'On the board' }));
    else actions.push(lxButton('Watch', () => lxWatch(g.id)));
    if (!g.finished && !g.playing) {
      actions.push(lxButton('Play', () => lxPlay(g), 'small primary'));
    }
    if (!g.finished) {
      actions.push(lxButton('Resign', async () => {
        if (await confirmDialog(`Resign the game against ${g.opponent}?`, 'Resign')) lichessCommand('lichessResign', { id: g.id });
      }));
      if (g.moves < 2) actions.push(lxButton('Abort', () => lichessCommand('lichessAbort', { id: g.id })));
    }
    actions.push(lxLink(g.url, 'Lichess ↗', 'Open the game on Lichess'));
    let status;
    if (g.finished) status = g.result && g.result !== '*' ? `${g.result} · ${g.status}` : g.status;
    else if (!g.playing) status = g.myTurn ? 'Not played — your move' : 'Not played — opponent to move';
    else status = g.myTurn ? 'Your engine to move' : 'Opponent to move';
    const row = el('div', { className: 'lx-row game' + (g.finished ? ' finished' : g.playing ? ' live' : ' idle') + (watching ? ' watching' : '') }, [
      el('span', { className: 'lx-color ' + g.color, title: `Your engine plays ${g.color}` }),
      lxWho(g.opponent, g.opponentTitle, g.opponentRating),
      el('span', { className: 'lx-meta', textContent: [g.tc, g.rated ? 'rated' : 'casual', (n => `${n} move${n === 1 ? '' : 's'}`)(Math.ceil(g.moves / 2))].filter(Boolean).join(' · ') }),
      el('span', { className: 'lx-status', textContent: status }),
      el('span', { className: 'lx-actions' }, actions),
    ]);
    if (g.message) row.append(el('span', { className: 'lx-note', textContent: g.message }));
    return row;
  }));
}

// A game already going when connecting (or started elsewhere) waits until
// it is handed to the engine.
async function lxPlay(g) {
  const ok = await confirmDialog(`Let your engine play the game against ${g.opponent}? It moves at once if it is its turn.`, 'Play with engine');
  if (ok) lichessCommand('lichessPlay', { id: g.id });
}

// --- Auto-accept rules: which challenges are accepted automatically ---

const RULE_SPEEDS = [['ultraBullet', 'UltraBullet'], ['bullet', 'Bullet'], ['blitz', 'Blitz'], ['rapid', 'Rapid'], ['classical', 'Classical']];
const speedOn = (p, key) => p?.speeds?.[key] !== false;
const rangeText = (min, max, unit = '') => (min && max ? `${min}–${max}${unit}` : min ? `${min}${unit} or more` : max ? `up to ${max}${unit}` : '');

// The rules in a line, e.g. "Blitz, Rapid · rated · from people · 1 game at once".
function rulesSummary(p) {
  if (!p) return '';
  const speeds = RULE_SPEEDS.filter(([k]) => speedOn(p, k)).map(([, name]) => name);
  const parts = [
    speeds.length === RULE_SPEEDS.length ? 'any speed' : speeds.join(', ') || 'no speed',
    p.rated && p.casual ? 'rated and casual' : p.rated ? 'rated only' : p.casual ? 'casual only' : 'neither rated nor casual',
    p.humans && p.bots ? 'from people and bots' : p.humans ? 'from people only' : p.bots ? 'from bots only' : 'from nobody',
  ];
  const minutes = rangeText(p.minMinutes, p.maxMinutes, ' min');
  if (minutes) parts.push(minutes);
  const inc = rangeText(p.minIncrement, p.maxIncrement, ' s');
  if (inc) parts.push(`increment ${inc}`);
  const rating = rangeText(p.minRating, p.maxRating);
  if (rating) parts.push(`rated ${rating}`);
  if (p.noFromPosition) parts.push('usual start only');
  parts.push(`${p.maxGames} game${p.maxGames === 1 ? '' : 's'} at once`);
  return parts.join(' · ');
}

// Why nothing at all would be accepted, or ''.
function rulesProblem(p) {
  if (!RULE_SPEEDS.some(([k]) => speedOn(p, k))) return 'No speed is ticked, so every challenge would be declined.';
  if (!p.rated && !p.casual) return 'Neither rated nor casual is ticked, so every challenge would be declined.';
  if (!p.humans && !p.bots) return 'Neither people nor bots is ticked, so every challenge would be declined.';
  if (p.maxMinutes && p.minMinutes > p.maxMinutes) return 'The minutes run from more to less, so every challenge would be declined.';
  if (p.maxIncrement && p.minIncrement > p.maxIncrement) return 'The increment runs from more to less, so every challenge would be declined.';
  if (p.maxRating && p.minRating > p.maxRating) return 'The rating runs from more to less, so every challenge with a rating would be declined.';
  return '';
}

function renderLichessRules(error) {
  const p = lx.settings?.policy;
  if (!p) return;
  const form = $('#lx-rules-form');
  // Leave the form alone while it is being typed in.
  if (!form.contains(document.activeElement) || document.activeElement.type === 'checkbox') {
    for (const box of $('#lx-rules-speeds').querySelectorAll('input')) box.checked = speedOn(p, box.dataset.speed);
    $('#lr-rated').checked = p.rated;
    $('#lr-casual').checked = p.casual;
    $('#lr-humans').checked = p.humans;
    $('#lr-bots').checked = p.bots;
    $('#lr-position').checked = !p.noFromPosition;
    const num = (id, v) => { $(id).value = v || ''; };
    num('#lr-min', p.minMinutes); num('#lr-max', p.maxMinutes);
    num('#lr-inc-min', p.minIncrement); num('#lr-inc-max', p.maxIncrement);
    num('#lr-rating-min', p.minRating); num('#lr-rating-max', p.maxRating);
    $('#lr-games').value = p.maxGames;
  }
  $('#lx-rules-summary').textContent = rulesSummary(p);
  const problem = error || rulesProblem(p);
  $('#lx-rules-error').textContent = problem;
  $('#lx-rules-error').hidden = !problem;
  $('#lx-rules').classList.toggle('problem', Boolean(problem));
}

// Every change is saved and applies at once.
$('#lx-rules-form').onchange = async () => {
  const speeds = {};
  for (const box of $('#lx-rules-speeds').querySelectorAll('input')) speeds[box.dataset.speed] = box.checked;
  const policy = {
    speeds,
    rated: $('#lr-rated').checked, casual: $('#lr-casual').checked,
    humans: $('#lr-humans').checked, bots: $('#lr-bots').checked,
    noFromPosition: !$('#lr-position').checked,
    minMinutes: +$('#lr-min').value || 0, maxMinutes: +$('#lr-max').value || 0,
    minIncrement: +$('#lr-inc-min').value || 0, maxIncrement: +$('#lr-inc-max').value || 0,
    minRating: +$('#lr-rating-min').value || 0, maxRating: +$('#lr-rating-max').value || 0,
    maxGames: +$('#lr-games').value || 1,
  };
  let error = '';
  try {
    lx.settings = await api.lichess.save({ policy });
    if (lxOnline()) await api.lichess.configure();
  } catch (err) {
    error = errorText(err);
  }
  renderLichessRules(error);
};
$('#lx-rules-form').onsubmit = (e) => e.preventDefault();
try { $('#lx-rules').open = localStorage.getItem('lichessRulesOpen') === '1'; } catch { /* closed */ }
$('#lx-rules').ontoggle = () => { try { localStorage.setItem('lichessRulesOpen', $('#lx-rules').open ? '1' : '0'); } catch { /* ignore */ } };

$('#lx-auto').onchange = async (e) => {
  const on = e.target.checked;
  if (on) {
    const waiting = lx.status.incoming?.length ?? 0;
    const ok = await confirmDialog(
      `Accept challenges automatically? Your engine will play every challenge that matches the auto-accept rules (${rulesSummary(lx.settings?.policy)}); others are declined.`
      + (waiting ? ` This also answers the ${waiting === 1 ? 'challenge' : `${waiting} challenges`} waiting now.` : ''),
      'Accept automatically');
    if (!ok) { e.target.checked = false; return; }
  }
  if (!(await lichessCommand('lichessAutoAccept', { on }))) e.target.checked = !on;
};

async function lxWatch(id) {
  if (state?.active && !state.external) {
    const ok = await confirmDialog('Show the Lichess game on the board? The game you are playing here will be abandoned.', 'Show Lichess game');
    if (!ok) return;
  }
  await lichessCommand('lichessWatch', { id });
}

async function lxConnect() {
  lx.settings = await api.lichess.settings();
  if (!lx.settings.hasToken) {
    lxSetNote('');
    openSettings('lichess');
    return;
  }
  lxSetNote('');
  try {
    await api.lichess.connect();
  } catch (err) {
    lxSetNote(errorText(err));
  }
}

async function lxDisconnect() {
  const live = lxPlayingGames().length;
  if (live) {
    const ok = await confirmDialog(
      `Disconnect from Lichess? Your engine is playing ${live === 1 ? 'a game' : `${live} games`}; ${live === 1 ? 'it' : 'they'} will be resigned.`,
      'Resign and disconnect');
    if (!ok) return;
  }
  await lichessCommand('lichessDisconnect', { resign: live > 0 });
}

const lxToggleConnection = () => (lx.status.state === 'off' || lx.status.state === 'error' ? lxConnect() : lxDisconnect());
$('#lx-connect').onclick = lxToggleConnection;
$('#lx-settings').onclick = () => openSettings('lichess');

// The bots online now, offered in both username boxes.
async function lxLoadBots(btn, input) {
  btn.disabled = true;
  const baseUrl = lx.settings?.baseUrl ?? 'https://lichess.org';
  const bots = await lichessCommand('lichessBots', { baseUrl });
  btn.disabled = false;
  if (!Array.isArray(bots)) return;
  lx.bots = bots;
  const speed = lxSpeed();
  $('#lx-bots').replaceChildren(...bots.map((b) => {
    const r = b.perfs?.[speed]?.games ? b.perfs[speed].rating : null;
    return el('option', { value: b.username || b.name || b.id, label: r ? `${speed} ${r}` : '' });
  }));
  lxSetNote(bots.length ? `${bots.length} bots online — pick one in the username box.` : 'No bots are online right now.');
  input.focus();
  try { input.showPicker?.(); } catch { /* needs a click */ }
}
$('#lx-bots-refresh').onclick = () => lxLoadBots($('#lx-bots-refresh'), $('#lx-username'));
$('#lx-watch-bots').onclick = () => lxLoadBots($('#lx-watch-bots'), $('#lx-watch-user'));

// ---------------------------------------------------------------------------
// Watching another player: no engine plays.
// ---------------------------------------------------------------------------
$('#lx-watch-form').onsubmit = async (e) => {
  e.preventDefault();
  const username = $('#lx-watch-user').value.trim();
  if (!username) return;
  if (state?.active && !state.external) {
    const ok = await confirmDialog(`Watch ${username}'s games on the board? The game you are playing here will be abandoned.`, 'Watch');
    if (!ok) return;
  }
  lx.settings ??= await api.lichess.settings();
  const ok = await lichessCommand('lichessSpectate', { baseUrl: lx.settings.baseUrl, username });
  if (ok) {
    try { localStorage.setItem('lichessWatchUser', username); } catch { /* ignore */ }
  }
};
$('#lx-watch-stop').onclick = () => lichessCommand('lichessSpectateStop');

function lichessWatchStatus(st) {
  lx.watch = st;
  renderLichessWatch();
  if (Array.isArray(ob?.bots)) renderOnlineBots(); // the TV of the bot being watched lights up
}

function renderLichessWatch() {
  const w = lx.watch;
  $('#lx-watch-stop').hidden = !w.active;
  $('#lx-watch-go').textContent = w.active ? 'Watch another' : 'Watch';
  let text = 'Follow any player\'s games live on the board, one game after another. No engine plays; analysis can run while you watch. No token needed.';
  if (w.active) {
    if (w.state === 'live') text = `Watching ${w.user} live. The next game follows automatically.`;
    else text = w.message || `Watching ${w.user}…`;
  }
  const box = $('#lx-watch-state');
  box.replaceChildren(document.createTextNode(text + ' '));
  if (w.active && w.url) box.append(lxLink(w.url, 'Open on Lichess ↗'));
  $('#lx-watch').classList.toggle('on', w.active);
}

$('#lx-challenge').onsubmit = async (e) => {
  e.preventDefault();
  const username = $('#lx-username').value.trim();
  if (!username) return;
  const send = $('#lx-send');
  send.disabled = true;
  const ok = await lichessCommand('lichessChallenge', {
    username, rated: $('#lx-rated').checked, color: $('#lx-color').value,
    limit: +$('#lx-time').value, increment: +$('#lx-inc').value,
  });
  send.disabled = false;
  renderChallengeLocks();
  if (ok) saveChallengeForm(username);
};

// The challenge settings (time, increment, colour, rated) are kept whenever
// one changes: they are also used by Challenge in the online bots list and
// by Challenge random bot. The username is kept once a challenge to it went out.
function saveChallengeForm(username) {
  try {
    const before = JSON.parse(localStorage.getItem('lichessChallenge') ?? '{}') ?? {};
    localStorage.setItem('lichessChallenge', JSON.stringify({
      username: username ?? before.username ?? '',
      time: $('#lx-time').value, inc: $('#lx-inc').value, color: $('#lx-color').value, rated: $('#lx-rated').checked,
    }));
  } catch { /* ignore */ }
}
for (const id of ['#lx-time', '#lx-inc', '#lx-color', '#lx-rated']) $(id).addEventListener('change', () => saveChallengeForm());

// Lichess's speed for the chosen clock: by initial time + 40 × increment.
function lxSpeed() {
  const t = +$('#lx-time').value + 40 * +$('#lx-inc').value;
  return t < 30 ? 'ultraBullet' : t < 180 ? 'bullet' : t < 480 ? 'blitz' : t < 1500 ? 'rapid' : 'classical';
}
for (const id of ['#lx-time', '#lx-inc']) $(id).addEventListener('change', () => { $('#lx-seek-speed').textContent = lxSpeed(); });

function saveSeekForm() {
  try { localStorage.setItem('lichessSeek', JSON.stringify({ min: $('#lx-seek-min').value, max: $('#lx-seek-max').value })); } catch { /* ignore */ }
}

$('#lx-seek-go').onclick = async () => {
  const min = +$('#lx-seek-min').value || 0;
  const max = +$('#lx-seek-max').value || 0;
  if (min && max && min > max) { lxSetNote('The lowest rating is above the highest.'); return; }
  saveSeekForm();
  await lichessCommand('lichessSeek', {
    rated: $('#lx-rated').checked, color: $('#lx-color').value,
    limit: +$('#lx-time').value, increment: +$('#lx-inc').value, minRating: min, maxRating: max,
  });
};
$('#lx-seek-stop').onclick = () => lichessCommand('lichessSeekStop');

// One challenge at a time: why the engine (or you) cannot send another now.
function engineBusy() {
  const s = lx.status;
  const out = s.outgoing?.[0];
  if (out) return `Your engine's challenge to ${out.user} is waiting for an answer: cancel it to challenge someone else`;
  if (s.seek?.active) return 'Your engine is looking for a random bot: stop that to challenge someone yourself';
  if ((s.games ?? []).some((g) => !g.finished)) return 'Your engine is playing a game: challenge again when it is over';
  return '';
}
function meBusy() {
  const out = me.status.outgoing?.[0];
  return out ? `Your challenge to ${out.user} is waiting for an answer: cancel it to challenge someone else` : '';
}

// The challenge buttons follow engineBusy / meBusy.
function renderChallengeLocks() {
  const eb = engineBusy();
  $('#lx-send').disabled = Boolean(eb);
  $('#lx-send').title = eb;
  const seekBusy = eb && !lx.status.seek?.active ? eb : '';
  $('#lx-seek-go').disabled = Boolean(seekBusy);
  $('#lx-seek-go').title = seekBusy || 'Challenge a random bot in this rating range with the time control above, one a minute at most; if it declines or does not answer, try another until one accepts';
  const mb = meBusy();
  if ($('#lx-me-send')) { $('#lx-me-send').disabled = Boolean(mb); $('#lx-me-send').title = mb; }
}

function renderSeek() {
  const seek = lx.status.seek;
  const on = Boolean(seek?.active);
  $('#lx-seek-go').hidden = on;
  $('#lx-seek-stop').hidden = !on;
  for (const id of ['#lx-seek-min', '#lx-seek-max']) $(id).disabled = on;
  const box = $('#lx-seek-state');
  box.hidden = !on;
  if (on) {
    const range = seek.minRating || seek.maxRating
      ? `${seek.minRating || 'any'}–${seek.maxRating || 'any'} ${seek.speed}`
      : `any ${seek.speed} rating`;
    const text = () => {
      const left = seek.nextAt ? Math.max(0, Math.ceil((seek.nextAt - Date.now()) / 1000)) : 0;
      const next = left ? ` Next challenge in ${left} s.` : '';
      box.textContent = `Random bot (${range}) · ${seek.tried} asked · ${seek.message}${next}`;
    };
    text();
    clearInterval(lx.seekTimer);
    if (seek.nextAt) lx.seekTimer = setInterval(text, 1000);
  } else clearInterval(lx.seekTimer);
  $('#lx-seek').classList.toggle('on', on);
}

function loadChallengeForm() {
  try {
    const seek = JSON.parse(localStorage.getItem('lichessSeek') ?? '{}') ?? {};
    if (seek.min) $('#lx-seek-min').value = seek.min;
    if (seek.max) $('#lx-seek-max').value = seek.max;
  } catch { /* ignore */ }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lichessChallenge') ?? '{}') ?? {}; } catch { /* ignore */ }
  if (saved.username) $('#lx-username').value = saved.username;
  if (saved.time) $('#lx-time').value = saved.time;
  if (saved.inc) $('#lx-inc').value = saved.inc;
  if (saved.color) $('#lx-color').value = saved.color;
  $('#lx-rated').checked = Boolean(saved.rated);
  $('#lx-seek-speed').textContent = lxSpeed();
}

// ---------------------------------------------------------------------------
// Settings → Lichess
// ---------------------------------------------------------------------------
function renderLichessSettingsStatus() {
  if (!$('#ls-state')) return;
  const s = lx.status;
  const dot = s.state === 'connected' ? 'on' : s.state === 'connecting' || s.state === 'reconnecting' ? 'wait' : s.state === 'off' ? 'off' : 'bad';
  $('#ls-dot').className = 'lx-dot ' + dot;
  let text = LX_STATE_TEXT[s.state] ?? s.state;
  if (s.account && lxOnline()) text = `Connected as ${s.account.username} (Bot account)`;
  if (s.state === 'error' && s.message) text += ': ' + s.message;
  $('#ls-state').textContent = text;
  $('#ls-connect').textContent = s.state === 'off' || s.state === 'error' ? 'Connect' : 'Disconnect';
  $('#ls-connect').disabled = s.state === 'connecting';
  $('#ls-upgrade').hidden = s.state !== 'notBot';
  $('#ls-upgrade-name').textContent = s.account?.username ?? 'This';
}

function lxTokenNote() {
  const st = lx.settings;
  let text = '';
  if (st?.hasToken) text = st.encrypted ? 'A token is saved, encrypted with your system keychain. Type a new one to replace it.' : 'A token is saved. The system keychain is not available, so it is stored unencrypted in the app settings.';
  else text = 'No token saved.';
  $('#ls-token-note').textContent = text;
  $('#ls-token').placeholder = st?.hasToken ? '•••••••• saved' : 'lip_…';
  $('#ls-token-clear').hidden = !st?.hasToken;
}

async function fillLichessSettings() {
  lx.settings = await api.lichess.settings();
  const st = lx.settings;
  $('#ls-token').value = '';
  lxTokenNote();
  $('#ls-engine').replaceChildren(...engines.map((e) => el('option', { value: e.id, textContent: e.name })));
  $('#ls-engine').value = engines.some((e) => e.id === st.engineId) ? st.engineId : engines[0]?.id ?? '';
  $('#ls-autoconnect').checked = st.autoConnect;
  $('#ls-ponder').checked = st.ponder !== false;
  fillGreeting(st.greeting);
  fillDraw(st.draw);
  $('#ls-server').value = st.baseUrl;
  $('#ls-error').hidden = true;
  renderLichessSettingsStatus();
}


// Draws: when the engine offers one with its move, or accepts one.
function fillDraw(d) {
  d = { ...lx.settings?.drawDefaults, ...d };
  $('#ls-draw-on').checked = Boolean(d.enabled);
  $('#ls-draw-score').value = d.score ?? 0;
  $('#ls-draw-moves').value = d.moves ?? 10;
  $('#ls-draw-pieces').value = d.pieces ?? 10;
  $('#ls-draw-egtb').checked = Boolean(d.egtbZero);
  renderDraw();
}

function drawPatch() {
  return {
    enabled: $('#ls-draw-on').checked,
    score: $('#ls-draw-score').value,
    moves: $('#ls-draw-moves').value,
    pieces: $('#ls-draw-pieces').value,
    egtbZero: $('#ls-draw-egtb').checked,
  };
}

function renderDraw() {
  const d = drawPatch();
  for (const input of $('#ls-draw-rules').querySelectorAll('input')) input.disabled = !d.enabled;
  $('#ls-draw-rules').classList.toggle('off', !d.enabled);
  const n = (v, fallback) => (v === '' || !Number.isFinite(Number(v)) ? fallback : Math.round(Number(v)));
  const score = n(d.score, 0), moves = n(d.moves, 10), pieces = n(d.pieces, 10);
  let text = 'Your engine never offers a draw, and plays on when offered one.';
  if (d.enabled) {
    const close = score === 0 ? 'exactly 0.00' : `within ±${(score / 100).toFixed(2)}`;
    text = `A draw is offered or accepted once the score was ${close} for ${moves} ${moves === 1 ? 'move' : 'moves'} in a row with ${pieces} or fewer pieces left`
      + (d.egtbZero ? ', or at once in a tablebase draw.' : '.');
  }
  $('#ls-draw-summary').textContent = text;
}

$('#ls-draw').addEventListener('input', renderDraw);
$('#ls-draw-reset').onclick = () => fillDraw(lx.settings?.drawDefaults);

// Chat messages: what the engine says when its games start and end.
const greetingInputs = () => [...$('#ls-greeting').querySelectorAll('input[data-greeting]')];

function fillGreeting(g) {
  for (const input of greetingInputs()) input.value = g?.[input.dataset.greeting] ?? '';
  renderGreetingPreview();
}

// The message being written, with the names filled in.
function renderGreetingPreview() {
  const input = greetingInputs().find((i) => i === document.activeElement) ?? greetingInputs().find((i) => i.value.trim());
  const me = lx.status?.account?.username || 'YourBot';
  const text = (input?.value ?? '').replaceAll('{me}', me).replaceAll('{opponent}', 'Opponent').replace(/\s+/g, ' ').trim();
  $('#ls-greet-preview').textContent = text ? `For example: “${text}”` : 'Your engine will say nothing.';
}

$('#ls-greeting').addEventListener('input', renderGreetingPreview);
$('#ls-greeting').addEventListener('focusin', renderGreetingPreview);
$('#ls-greet-reset').onclick = () => fillGreeting(lx.settings?.greetingDefaults);
$('#ls-greet-clear').onclick = () => fillGreeting({});

function lichessPatch() {
  const patch = {
    engineId: $('#ls-engine').value,
    autoConnect: $('#ls-autoconnect').checked,
    ponder: $('#ls-ponder').checked,
    baseUrl: $('#ls-server').value,
    greeting: Object.fromEntries(greetingInputs().map((i) => [i.dataset.greeting, i.value])),
    draw: drawPatch(),
  };
  const token = $('#ls-token').value.trim();
  if (token) patch.token = token;
  return patch;
}

function lsError(err) {
  $('#ls-error').textContent = err ? errorText(err) : '';
  $('#ls-error').hidden = !err;
}

// Saves Settings → Lichess. The engine and challenge rules apply at once; a
// new token or server is used from the next connection.
async function saveLichessSettings() {
  if (!lx.settings) return true;
  const before = lx.settings;
  const patch = lichessPatch();
  try {
    lx.settings = await api.lichess.save(patch);
    $('#ls-token').value = '';
    lxTokenNote();
  } catch (err) {
    lsError(err);
    return false;
  }
  if (lxOnline()) {
    try { await api.lichess.configure(); } catch (err) { lxSetNote(errorText(err)); }
    if (patch.token || lx.settings.baseUrl !== before.baseUrl) lxSetNote('Disconnect and connect again to use the new token or server.');
  }
  renderLichess();
  return true;
}

$('#ls-connect').onclick = async () => {
  lsError(null);
  if (lx.status.state === 'off' || lx.status.state === 'error') {
    if (!(await saveLichessSettings())) return;
    if (!lx.settings.hasToken) {
      lsError('Paste your Lichess API token first.');
      $('#ls-token').focus();
      return;
    }
    try { await api.lichess.connect(); } catch (err) { lsError(err); }
  } else {
    await lxDisconnect();
  }
};

$('#ls-token-clear').onclick = async () => {
  if (lxOnline() && !(await confirmDialog('Forget the saved token? You stay connected until you disconnect.', 'Forget token'))) return;
  lx.settings = await api.lichess.save({ token: '' });
  lxTokenNote();
};

$('#ls-token-link').onclick = (e) => {
  e.preventDefault();
  const base = ($('#ls-server').value.trim() || 'https://lichess.org').replace(/\/+$/, '');
  const scopes = ['bot:play', 'challenge:read', 'challenge:write'].map((s) => `scopes[]=${encodeURIComponent(s)}`).join('&');
  api.openExternal(`${base}/account/oauth/token/create?${scopes}&description=Ponder`).catch(lsError);
};

$('#ls-upgrade-btn').onclick = async () => {
  const name = lx.status.account?.username ?? 'this account';
  const ok = await confirmDialog(
    `Upgrade ${name} to a Bot account? This is permanent: the account can then only play through the Bot API, never on the Lichess website again. It only works on an account that has not played any games.`,
    'Upgrade permanently');
  if (!ok) return;
  lsError(null);
  try {
    await api.backend('lichessUpgrade');
  } catch (err) {
    lsError(err);
  }
};

// ---------------------------------------------------------------------------
// Online bots: who is on Lichess now, their ratings and what they are doing,
// with Challenge (your engine, or you), Watch and a link to the profile.
// ---------------------------------------------------------------------------
const ob = {
  bots: null,        // the list, once loaded
  status: new Map(), // id → { online, playing, gameId, clock }
  shown: 50,         // rows drawn (Show more adds 50)
  open: new Set(),   // ids with details open
  sent: new Map(),   // id → note after a challenge
  loading: false,
  timer: null,
};
const OB_SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'];
const OB_SHORT = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical' };

function flagEmoji(code) {
  if (!/^[A-Z]{2}$/.test(code ?? '')) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
const obName = (b) => b.username || b.name || b.id;
const obPerf = (b, speed) => b.perfs?.[speed];
const obRating = (b, speed) => (obPerf(b, speed)?.games ? obPerf(b, speed).rating : null);

async function loadOnlineBots() {
  if (ob.loading) return;
  ob.loading = true;
  $('#lx-online-load').disabled = true;
  $('#lx-online-load').textContent = 'Loading…';
  lx.settings ??= await api.lichess.settings();
  const baseUrl = lx.settings?.baseUrl ?? 'https://lichess.org';
  let bots = null;
  try {
    bots = await api.backend('lichessBots', { baseUrl, max: 300 });
  } catch (err) {
    lxSetNote(errorText(err));
  }
  ob.loading = false;
  $('#lx-online-load').disabled = false;
  $('#lx-online-load').textContent = 'Refresh';
  if (!Array.isArray(bots)) return;
  ob.bots = bots;
  ob.shown = 50;
  // The username boxes offer the same bots.
  lx.bots = bots;
  $('#lx-bots').replaceChildren(...bots.map((b) => el('option', { value: obName(b) })));
  renderOnlineBots();
  refreshBotStatus();
  clearInterval(ob.timer);
  // Who is playing changes all the time: check again while the tab is open.
  ob.timer = setInterval(() => {
    if (!$('#pane-lichess').hidden && document.visibilityState === 'visible') refreshBotStatus();
  }, 20000);
}

async function refreshBotStatus() {
  if (!ob.bots?.length) return;
  const baseUrl = lx.settings?.baseUrl ?? 'https://lichess.org';
  try {
    const list = await api.backend('lichessUsersStatus', { baseUrl, ids: ob.bots.map((b) => b.id) });
    ob.status = new Map((list ?? []).map((st) => [st.id, st]));
    renderOnlineBots();
  } catch { /* the list still shows; status is a bonus */ }
}

function obFiltered() {
  const speed = $('#lx-online-speed').value;
  const q = $('#lx-online-q').value.trim().toLowerCase();
  const min = +$('#lx-online-min').value || 0;
  const max = +$('#lx-online-max').value || 0;
  const free = $('#lx-online-free').checked;
  const sort = $('#lx-online-sort').value;
  const list = ob.bots.filter((b) => {
    if (q) {
      const hay = [obName(b), b.profile?.bio, b.profile?.location, b.profile?.flag].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const r = obRating(b, speed);
    if ((min || max) && r == null) return false;
    if (min && r < min) return false;
    if (max && r > max) return false;
    if (free && ob.status.get(b.id)?.playing) return false;
    return true;
  });
  const rating = (b) => obRating(b, speed) ?? -1;
  const by = {
    rating: (a, b) => rating(b) - rating(a),
    'rating-asc': (a, b) => (rating(a) < 0) - (rating(b) < 0) || rating(a) - rating(b),
    games: (a, b) => (obPerf(b, speed)?.games ?? 0) - (obPerf(a, speed)?.games ?? 0),
    active: (a, b) => (b.playTime?.total ?? 0) - (a.playTime?.total ?? 0),
    name: (a, b) => obName(a).localeCompare(obName(b)),
    new: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  }[sort];
  return list.sort(by);
}

const obAgo = (ms) => {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const obHours = (secs) => (secs >= 3600 ? `${Math.round(secs / 3600).toLocaleString()} h` : `${Math.round(secs / 60)} min`);

// A television: watch this bot's games on the board.
const TV_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 1.5 8 4l2.5-2.5"/><rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M5 14.5h6"/></svg>';

function renderOnlineBots() {
  const loaded = Array.isArray(ob.bots);
  $('#lx-online-bar').hidden = !loaded;
  $('#lx-online-hint').hidden = loaded;
  $('#lx-online-load').textContent = ob.loading ? 'Loading…' : loaded ? 'Refresh' : 'Show online bots';
  if (!loaded) { $('#lx-online-list').replaceChildren(); $('#lx-online-foot').hidden = true; return; }
  const speed = $('#lx-online-speed').value;
  const list = obFiltered();
  const playing = ob.bots.filter((b) => ob.status.get(b.id)?.playing).length;
  $('#lx-online-count').textContent = `${ob.bots.length}${ob.status.size ? ` · ${playing} playing` : ''}`;
  const engineOn = lxOnline();
  const youOn = meOnline();
  const tcEngine = `${+$('#lx-time').value / 60}+${$('#lx-inc').value}`;
  const tcYou = `${+$('#lx-me-time').value / 60}+${$('#lx-me-inc').value}`;
  const eBusy = engineOn ? engineBusy() : '';
  const mBusy = youOn ? meBusy() : '';
  const rows = list.slice(0, ob.shown).map((b) => {
    const name = obName(b);
    const st = ob.status.get(b.id);
    const perf = obPerf(b, speed);
    const r = obRating(b, speed);
    const flag = flagEmoji(b.profile?.flag);
    const who = el('span', { className: 'who', title: 'Show details' }, [
      el('span', { className: 'state' + (st?.playing ? ' playing' : st && !st.online ? ' off' : ''), title: st?.playing ? 'Playing' : st && !st.online ? 'Offline' : 'Online' }),
      ...(flag ? [el('span', { className: 'flag', textContent: flag, title: b.profile.flag })] : []),
      el('span', { className: 'lx-title', textContent: b.title || 'BOT' }),
      el('span', { className: 'name', textContent: name }),
    ]);
    who.onclick = () => { if (ob.open.has(b.id)) ob.open.delete(b.id); else ob.open.add(b.id); renderOnlineBots(); };
    window.attachPlayerHover?.($('.name', who), name, () => $('#lx-online-speed').value);
    const rating = el('span', { className: 'rating' + (r == null ? ' none' : ''), title: r == null ? `No ${speed} games` : `${OB_SHORT[speed]} rating${perf.prov ? ' (provisional)' : ''}, ${perf.games.toLocaleString()} games` },
      r == null ? ['—'] : [String(r), ...(perf.prov ? [el('small', { textContent: '?' })] : [])]);
    const others = OB_SPEEDS.filter((sp) => sp !== speed && obRating(b, sp) != null).map((sp) => `${OB_SHORT[sp]} ${obRating(b, sp)}`).join(' · ');
    const games = perf?.games ? `${perf.games.toLocaleString()} ${speed} games` : '';
    let doing = st?.playing ? `Playing${st.clock ? ' ' + st.clock : ''}` : st ? (st.online ? 'Free' : 'Offline') : '';
    const sent = ob.sent.get(b.id);
    if (sent) doing = sent;
    const info = el('span', { className: 'info' }, [
      el('span', { className: 'speeds', textContent: [games, others].filter(Boolean).join(' · ') || 'No rated games yet' }),
      el('span', { className: 'doing' + (st?.playing && !sent ? ' playing' : ''), textContent: doing }),
    ]);
    const acts = [];
    const engineBtn = lxButton('Challenge', () => obChallenge(b, 'engine'), 'small primary');
    engineBtn.disabled = !engineOn || Boolean(eBusy);
    engineBtn.title = !engineOn ? 'Connect your engine’s Bot account (below) to challenge with it'
      : eBusy || `Challenge ${name} with your engine: ${tcEngine}, from “Challenge a player” below`;
    acts.push(engineBtn);
    if (youOn) {
      const youBtn = lxButton('Play', () => obChallenge(b, 'you'), 'small');
      youBtn.disabled = Boolean(mBusy);
      youBtn.title = mBusy || `Challenge ${name} to play you: ${tcYou}, from your Challenge a friend settings`;
      acts.push(youBtn);
    }
    const watching = lx.watch?.active && lx.watch.user?.toLowerCase() === name.toLowerCase();
    const tv = lxButton('', () => obWatch(name), 'small lx-tv' + (st?.playing ? ' live' : '') + (watching ? ' on' : ''));
    tv.innerHTML = TV_ICON;
    tv.title = watching ? `Watching ${name} on the board`
      : st?.playing ? `Watch ${name}'s game live on the board`
        : `Watch ${name}: shows the last game now, and the next one when it starts`;
    tv.setAttribute('aria-label', `Watch ${name}`);
    tv.setAttribute('aria-pressed', String(Boolean(watching)));
    acts.push(tv);
    acts.push(lxLink(`${(lx.settings?.baseUrl ?? 'https://lichess.org').replace(/\/+$/, '')}/@/${name}`, 'Profile ↗', `${name} on Lichess`));
    const row = el('div', { className: 'lx-bot' + (sent ? ' sent' : '') }, [who, rating, info, el('span', { className: 'acts' }, acts)]);
    if (ob.open.has(b.id)) {
      const item = (label, value) => (value ? el('span', {}, [el('b', { textContent: label }), value]) : null);
      const perfs = OB_SPEEDS.filter((sp) => obPerf(b, sp)?.games).map((sp) => {
        const p = obPerf(b, sp);
        const prog = p.prog ? el('span', { className: 'prog ' + (p.prog > 0 ? 'up' : 'down'), textContent: ` ${p.prog > 0 ? '▲' : '▼'}${Math.abs(p.prog)}` }) : '';
        return el('span', {}, [el('b', { textContent: OB_SHORT[sp] }), `${p.rating}${p.prov ? '?' : ''} · ${p.games.toLocaleString()} games`, prog]);
      });
      row.append(el('div', { className: 'details' }, [
        ...(b.profile?.bio ? [el('span', { className: 'bio', textContent: b.profile.bio })] : []),
        ...perfs,
        item('Joined', b.createdAt ? new Date(b.createdAt).toLocaleDateString() : ''),
        item('Last seen', obAgo(b.seenAt)),
        item('Time played', b.playTime?.total ? obHours(b.playTime.total) : ''),
        item('Location', [b.profile?.location, b.profile?.flag].filter(Boolean).join(' · ')),
        item('Now', st?.playing ? `Playing ${st.clock ?? ''} ${st.variant && st.variant !== 'standard' ? st.variant : ''}`.trim() : ''),
      ].filter(Boolean)));
    }
    return row;
  });
  if (!rows.length) rows.push(el('p', { className: 'hint lx-empty', textContent: ob.bots.length ? 'No bot matches.' : 'No bots are online right now.' }));
  $('#lx-online-list').replaceChildren(...rows);
  $('#lx-online-foot').hidden = list.length <= 0;
  $('#lx-online-shown').textContent = `Showing ${Math.min(ob.shown, list.length)} of ${list.length}${list.length !== ob.bots.length ? ` matching (${ob.bots.length} online)` : ''}`;
  $('#lx-online-more').hidden = list.length <= ob.shown;
}

async function obChallenge(b, who) {
  const name = obName(b);
  if (ob.sending) return;
  ob.sending = true;
  for (const btn of $('#lx-online-list').querySelectorAll('.acts button')) btn.disabled = true;
  let ok;
  if (who === 'engine') {
    ok = await lichessCommand('lichessChallenge', {
      username: name, rated: $('#lx-rated').checked, color: $('#lx-color').value,
      limit: +$('#lx-time').value, increment: +$('#lx-inc').value,
    });
  } else {
    ok = await meCommand('lichessAcctChallenge', {
      username: name, rated: $('#lx-me-rated').checked, color: $('#lx-me-color').value,
      limit: +$('#lx-me-time').value, increment: +$('#lx-me-inc').value,
    });
  }
  if (ok) {
    ob.sent.set(b.id, who === 'engine' ? 'Challenged by your engine' : 'Challenged by you');
    setTimeout(() => { ob.sent.delete(b.id); renderOnlineBots(); }, 15000);
  }
  ob.sending = false;
  renderOnlineBots();
}

async function obWatch(name) {
  $('#lx-watch-user').value = name;
  $('#lx-watch-form').requestSubmit();
}

$('#lx-online-load').onclick = loadOnlineBots;
$('#lx-online-more').onclick = () => { ob.shown += 50; renderOnlineBots(); };
for (const id of ['#lx-online-q', '#lx-online-min', '#lx-online-max']) {
  $(id).addEventListener('input', () => { ob.shown = 50; renderOnlineBots(); saveOnlineFilters(); });
}
for (const id of ['#lx-online-speed', '#lx-online-sort', '#lx-online-free']) {
  $(id).addEventListener('change', () => { ob.shown = 50; renderOnlineBots(); saveOnlineFilters(); });
}
// The tooltips name the time controls of the two challenge forms.
for (const id of ['#lx-time', '#lx-inc', '#lx-me-time', '#lx-me-inc']) $(id).addEventListener('change', () => ob.bots && renderOnlineBots());

function saveOnlineFilters() {
  try {
    localStorage.setItem('lichessOnline', JSON.stringify({
      speed: $('#lx-online-speed').value, sort: $('#lx-online-sort').value, free: $('#lx-online-free').checked,
      min: $('#lx-online-min').value, max: $('#lx-online-max').value,
    }));
  } catch { /* ignore */ }
}
function loadOnlineFilters() {
  let f = {};
  try { f = JSON.parse(localStorage.getItem('lichessOnline') ?? '{}') ?? {}; } catch { /* ignore */ }
  if (f.speed) $('#lx-online-speed').value = f.speed;
  else $('#lx-online-speed').value = lxSpeed() === 'ultraBullet' ? 'bullet' : lxSpeed();
  if (f.sort) $('#lx-online-sort').value = f.sort;
  $('#lx-online-free').checked = Boolean(f.free);
  if (f.min) $('#lx-online-min').value = f.min;
  if (f.max) $('#lx-online-max').value = f.max;
}

// ---------------------------------------------------------------------------
// Playing with your own account (Lichess's Board API)
// ---------------------------------------------------------------------------
const me = {
  status: { state: 'off', incoming: [], outgoing: [], games: [], account: null, message: '' },
  note: '',
  signingIn: false,
  seekTimer: null,
};

// Quick pairing: Lichess lets apps seek rapid and classical games only.
const ME_QUICK = [
  { limit: 600, inc: 0, name: 'Rapid' }, { limit: 600, inc: 5, name: 'Rapid' }, { limit: 900, inc: 10, name: 'Rapid' },
  { limit: 1800, inc: 0, name: 'Classical' }, { limit: 1800, inc: 20, name: 'Classical' },
];
const tcText = (limit, inc) => `${limit / 60}+${inc}`;
const meOnline = () => me.status.state === 'connected' || me.status.state === 'reconnecting';

// Your live Lichess game on the board, if any.
function playGameOnBoard() {
  if (!(state?.external?.kind === 'play' && state.external.live)) return null;
  return (me.status.games ?? []).find((g) => g.id === state.external.id) ?? null;
}

function meSetNote(text) {
  me.note = text;
  renderMe();
}

async function meCommand(cmd, args) {
  try {
    const result = await api.backend(cmd, args);
    if (me.note) meSetNote('');
    return result ?? true;
  } catch (err) {
    meSetNote(errorText(err));
    return null;
  }
}

function lichessAccountStatus(next) {
  const prev = me.status;
  me.status = next;
  const before = new Set((prev.incoming ?? []).map((c) => c.id));
  if ((next.incoming ?? []).some((c) => !before.has(c.id))) sounds.play('challenge');
  // An offer from the opponent in the game on the board.
  const offers = (st) => new Set((st.games ?? []).flatMap((g) => [g.draw === 'theirs' && g.id + 'd', g.takeback === 'theirs' && g.id + 't']).filter(Boolean));
  const had = offers(prev);
  if ([...offers(next)].some((o) => !had.has(o))) sounds.play('challenge');
  renderMe();
  if (ob.bots) renderOnlineBots(); // Play needs you signed in
  if (state?.external?.kind === 'play') renderPlayers(); // the bar's buttons follow the offers
  else renderPlayOffer();
}

function renderMe() {
  const s = me.status;
  const online = meOnline();
  $('#lx-signin').hidden = online || s.state === 'connecting';
  $('#lx-me-body').hidden = !online;
  $('#lx-signin-go').disabled = me.signingIn;
  $('#lx-signin-go').textContent = me.signingIn ? 'Waiting for Lichess in your browser…' : 'Sign in with Lichess';
  $('#lx-signin-cancel').hidden = !me.signingIn;
  const who = $('#lx-me-who');
  who.replaceChildren();
  if (s.account && s.state !== 'off') {
    who.append(el('span', { textContent: s.account.username + (s.state === 'reconnecting' ? ' · reconnecting…' : s.state === 'connecting' ? ' · connecting…' : '') }));
    const out = el('a', { href: '#', textContent: 'Sign out' });
    out.onclick = (e) => { e.preventDefault(); meSignOut(); };
    who.append(out);
  } else if (s.state === 'connecting') {
    who.append(el('span', { textContent: 'Connecting…' }));
  }
  const message = [me.note, s.message].filter(Boolean).join(' · ');
  $('#lx-me-message').textContent = message;
  $('#lx-me-message').hidden = !message;
  $('#lx-me-message').classList.toggle('error', Boolean(me.note) || s.state === 'error' || s.state === 'bot');

  // The Lichess tab's count: challenges to answer and games where it is your move.
  const myTurn = (s.games ?? []).filter((g) => g.myTurn).length;
  const botCount = (lx.status.incoming?.length ?? 0) + lxLiveGames().length;
  const count = botCount + (s.incoming?.length ?? 0) + myTurn;
  $('#lichess-count').textContent = count ? String(count) : '';
  $('#tab-lichess').classList.toggle('live', lxLiveGames().length > 0 || (s.games ?? []).some((g) => !g.finished));
  renderChallengeLocks();
  if (!online) return;

  // Quick pairing.
  const seek = s.seek;
  $('#lx-quick').replaceChildren(...ME_QUICK.map((q) => {
    const on = seek && seek.limit === q.limit && seek.increment === q.inc;
    const b = el('button', { type: 'button', className: on ? 'on' : '', title: `Look for a ${q.name.toLowerCase()} game, ${tcText(q.limit, q.inc)}` }, [
      el('b', { textContent: tcText(q.limit, q.inc) }), el('span', { textContent: q.name }),
    ]);
    b.onclick = () => (on ? meStopSeek() : meSeek(q.limit, q.inc));
    return b;
  }));
  $('#lx-me-seek').hidden = !seek;
  $('#lx-me-seek-note').textContent = seek ? '' : 'Pick a time to look for an opponent.';
  renderSeekTime();
  clearInterval(me.seekTimer);
  if (seek) me.seekTimer = setInterval(renderSeekTime, 1000);

  const row = (cls, parts) => el('div', { className: 'lx-row ' + cls }, parts);
  $('#lx-me-incoming').replaceChildren(...s.incoming.map((c) => {
    const accept = lxButton('Accept', async () => {
      accept.disabled = true;
      await meCommand('lichessAcctAccept', { id: c.id });
      accept.disabled = false;
    }, 'small primary');
    accept.disabled = !c.supported;
    if (!c.supported) accept.title = 'Only standard chess can be played here';
    return row('', [
      el('span', { className: 'lx-label', textContent: 'Challenge' }),
      lxWho(c.user, c.title, c.rating),
      el('span', { className: 'lx-meta', textContent: challengeMeta(c) }),
      el('span', { className: 'lx-actions' }, [accept, lxButton('Decline', () => meCommand('lichessAcctDecline', { id: c.id }))]),
    ]);
  }));
  $('#lx-me-outgoing').replaceChildren(...s.outgoing.map((c) => row('waiting', [
    el('span', { className: 'lx-meta', textContent: 'Waiting for' }),
    lxWho(c.user, c.title, c.rating),
    el('span', { className: 'lx-meta', textContent: challengeMeta(c) }),
    el('span', { className: 'lx-actions' }, [lxButton('Cancel', () => meCommand('lichessAcctCancel', { id: c.id }))]),
  ])));
  $('#lx-me-games').replaceChildren(...s.games.map((g) => {
    const onBoard = state?.external?.id === g.id;
    const actions = [];
    if (onBoard) actions.push(el('span', { className: 'lx-onboard', textContent: 'On the board' }));
    else actions.push(lxButton(g.finished ? 'Show' : 'Play', () => meShow(g), g.finished ? 'small' : 'small primary'));
    if (!g.finished) {
      actions.push(lxButton('Resign', async () => {
        if (await confirmDialog(`Resign the game against ${g.opponent}?`, 'Resign')) meCommand('lichessAcctResign', { id: g.id });
      }));
      if (g.moves < 2) actions.push(lxButton('Abort', () => meCommand('lichessAcctAbort', { id: g.id })));
    }
    actions.push(lxLink(g.url, 'Lichess ↗', 'Open the game on Lichess'));
    let status;
    if (g.finished) status = g.result && g.result !== '*' ? `${g.result.replace('1/2-1/2', '½-½')} · ${g.status}` : g.status;
    else status = g.myTurn ? 'Your move' : 'Their move';
    const r = row('game' + (g.finished ? ' finished' : ' live') + (g.myTurn ? ' myturn' : '') + (onBoard ? ' watching' : ''), [
      el('span', { className: 'lx-color ' + g.color, title: `You play ${g.color}` }),
      lxWho(g.opponent, g.opponentTitle, g.opponentRating),
      el('span', { className: 'lx-meta', textContent: [g.tc, g.rated ? 'rated' : 'casual'].filter(Boolean).join(' · ') }),
      el('span', { className: 'lx-status', textContent: status }),
      el('span', { className: 'lx-actions' }, actions),
    ]);
    if (g.message) r.append(el('span', { className: 'lx-note', textContent: g.message }));
    return r;
  }));
}

function renderSeekTime() {
  const seek = me.status.seek;
  if (!seek) return;
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(seek.since)) / 1000));
  const t = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  $('#lx-me-seek-text').textContent = `Looking for a ${seek.rated ? 'rated' : 'casual'} ${tcText(seek.limit, seek.increment)} opponent… ${t}`;
}

async function meSeek(limit, inc) {
  if (state?.active && !state.external) {
    const ok = await confirmDialog('Look for a Lichess game? When one starts, it replaces the game you are playing here.', 'Look for a game');
    if (!ok) return;
  }
  await meCommand('lichessAcctSeek', { rated: $('#lx-me-rated').checked, limit, increment: inc, color: 'random' });
}
const meStopSeek = () => meCommand('lichessAcctSeekStop');
$('#lx-me-seek-stop').onclick = meStopSeek;

async function meShow(g) {
  if (state?.active && !state.external) {
    const ok = await confirmDialog(`Show the game against ${g.opponent} on the board? The game you are playing here will be abandoned.`, 'Show');
    if (!ok) return;
  }
  await meCommand('lichessAcctShow', { id: g.id });
}

$('#lx-me-challenge').onsubmit = async (e) => {
  e.preventDefault();
  const username = $('#lx-me-user').value.trim();
  if (!username) return;
  const send = $('#lx-me-send');
  send.disabled = true;
  const args = { username, rated: $('#lx-me-rated').checked, color: $('#lx-me-color').value, limit: +$('#lx-me-time').value, increment: +$('#lx-me-inc').value };
  const ok = await meCommand('lichessAcctChallenge', args);
  send.disabled = false;
  renderChallengeLocks();
  if (ok) saveMeForm(username);
};

// Your own challenge settings, kept whenever one changes (Rated also goes
// for the games you look for, and Play in the online bots list uses them all).
function saveMeForm(username) {
  try {
    const before = JSON.parse(localStorage.getItem('lichessMeChallenge') ?? '{}') ?? {};
    localStorage.setItem('lichessMeChallenge', JSON.stringify({
      username: username ?? before.username ?? '',
      limit: $('#lx-me-time').value, increment: $('#lx-me-inc').value, color: $('#lx-me-color').value,
    }));
    localStorage.setItem('lichessMeRated', $('#lx-me-rated').checked ? '1' : '');
  } catch { /* ignore */ }
}
for (const id of ['#lx-me-time', '#lx-me-inc', '#lx-me-color', '#lx-me-rated']) $(id).addEventListener('change', () => saveMeForm());

async function meConnect() {
  try {
    await api.lichess.accountConnect();
  } catch (err) {
    meSetNote(errorText(err));
  }
}

$('#lx-signin-go').onclick = async () => {
  me.signingIn = true;
  meSetNote('');
  try {
    lx.settings = await api.lichess.signIn();
    me.signingIn = false;
    await meConnect();
  } catch (err) {
    me.signingIn = false;
    const text = errorText(err);
    meSetNote(/cancelled$/.test(text) && !/sign-in/.test(text) ? '' : text);
  }
  renderMe();
};
$('#lx-signin-cancel').onclick = () => api.lichess.signInCancel();

$('#lx-token-toggle').onclick = (e) => {
  e.preventDefault();
  $('#lx-token-form').hidden = !$('#lx-token-form').hidden;
  if (!$('#lx-token-form').hidden) $('#lx-acct-token').focus();
};
$('#lx-acct-token-link').onclick = (e) => {
  e.preventDefault();
  const base = (lx.settings?.baseUrl || 'https://lichess.org').replace(/\/+$/, '');
  const scopes = ['board:play', 'challenge:read', 'challenge:write'].map((sc) => `scopes[]=${encodeURIComponent(sc)}`).join('&');
  api.openExternal(`${base}/account/oauth/token/create?${scopes}&description=Ponder`).catch((err) => meSetNote(errorText(err)));
};
$('#lx-token-form').onsubmit = async (e) => {
  e.preventDefault();
  const token = $('#lx-acct-token').value.trim();
  if (!token) return;
  try {
    lx.settings = await api.lichess.save({ accountToken: token });
  } catch (err) {
    meSetNote(errorText(err));
    return;
  }
  $('#lx-acct-token').value = '';
  $('#lx-token-form').hidden = true;
  await meConnect();
};

async function meSignOut() {
  const live = (me.status.games ?? []).filter((g) => !g.finished).length;
  const ok = await confirmDialog(live
    ? `Sign out of Lichess? Your ${live === 1 ? 'game goes' : `${live} games go`} on there, and the clock keeps running.`
    : 'Sign out of Lichess? Ponder forgets your sign-in.', 'Sign out');
  if (!ok) return;
  try { lx.settings = await api.lichess.signOut(); } catch (err) { meSetNote(errorText(err)); }
}

// Offers in the game on the board: on your player bar.
function renderPlayOffer() {
  const g = playGameOnBoard();
  for (const box of document.querySelectorAll('.player')) {
    const offer = $('.offer', box);
    const ours = g && box.dataset.side === state.external.side;
    offer.hidden = !ours || (!g.draw && !g.takeback);
    if (offer.hidden) { offer.replaceChildren(); continue; }
    const parts = [];
    const answer = (kind, label) => {
      const yes = el('button', { type: 'button', className: 'act yes', textContent: `Accept ${label}` });
      yes.onclick = () => meCommand(kind === 'draw' ? 'lichessAcctDraw' : 'lichessAcctTakeback', { id: g.id, yes: true });
      const no = el('button', { type: 'button', className: 'act', textContent: 'Decline' });
      no.onclick = () => meCommand(kind === 'draw' ? 'lichessAcctDraw' : 'lichessAcctTakeback', { id: g.id, yes: false });
      parts.push(el('span', { className: 'offer-note', textContent: `${opponentName()} offers a ${label}` }), yes, no);
    };
    if (g.draw === 'theirs') answer('draw', 'draw');
    if (g.takeback === 'theirs') answer('takeback', 'takeback');
    if (g.draw === 'mine') parts.push(el('span', { className: 'offer-note', textContent: 'Draw offered' }));
    if (g.takeback === 'mine') parts.push(el('span', { className: 'offer-note', textContent: 'Takeback asked' }));
    offer.replaceChildren(...parts);
  }
}

function loadMeForm() {
  try { $('#lx-me-rated').checked = localStorage.getItem('lichessMeRated') === '1'; } catch { /* ignore */ }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lichessMeChallenge') ?? '{}') ?? {}; } catch { /* ignore */ }
  if (saved.username) $('#lx-me-user').value = saved.username;
  if (saved.limit) $('#lx-me-time').value = saved.limit;
  if (saved.increment) $('#lx-me-inc').value = saved.increment;
  if (saved.color) $('#lx-me-color').value = saved.color;
}

// ---------------------------------------------------------------------------
async function initLichess() {
  loadChallengeForm();
  try {
    lx.settings = await api.lichess.settings();
    lichessStatus(await api.backend('lichessStatus'));
    lichessWatchStatus(await api.backend('lichessSpectateStatus'));
    $('#lx-watch-user').value = localStorage.getItem('lichessWatchUser') ?? '';
    if (lx.settings.autoConnect && lx.settings.hasToken) lxConnect();
    loadMeForm();
    loadOnlineFilters();
    lichessAccountStatus(await api.backend('lichessAcctStatus'));
    if (lx.settings.hasAccount) meConnect(); // signed in before: sign in again
  } catch (err) {
    lxSetNote(errorText(err));
  }
}
