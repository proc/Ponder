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

// A challenge that could not be sent, or was turned down, is also shown as
// a notification: the Lichess tab may not be the one open.
function challengeFailed(err, args, who) {
  const to = args?.username ? ` to ${args.username}` : '';
  // In the challenges window too, with the error.
  if (args?.username) window.challengeNotSent?.(who, { user: args.username, limit: args.limit, increment: args.increment, rated: args.rated, color: args.color, error: errorText(err) });
  notify(errorText(err), { title: `${who === 'you' ? 'Your challenge' : 'Your engine’s challenge'}${to} was not sent` });
}
const challengeNews = (msg) => /declined the challenge|did not answer|could not (accept|challenge)/i.test(msg ?? '');

async function lichessCommand(cmd, args) {
  try {
    const result = await api.backend(cmd, args);
    if (lx.note) lxSetNote('');
    return result ?? true;
  } catch (err) {
    lxSetNote(errorText(err));
    if (cmd === 'lichessChallenge') challengeFailed(err, args, 'engine');
    else if (cmd === 'lichessSeek') notify(errorText(err), { title: 'The random-bot challenge did not start' });
    return null;
  }
}

// Your engine starts another game while one of its games is on the board:
// the new game takes the board (and gets the versus screen), unless that is
// turned off in Settings → General. The row of small boards has the others.
let botAutoSwitch = (() => { try { return localStorage.getItem('botAutoSwitch') !== 'off'; } catch { return true; } })();
function setBotAutoSwitch(on) {
  botAutoSwitch = Boolean(on);
  try { localStorage.setItem('botAutoSwitch', botAutoSwitch ? 'on' : 'off'); } catch { /* not kept */ }
}
window.setBotAutoSwitch = setBotAutoSwitch;
window.botAutoSwitchOn = () => botAutoSwitch;

function switchToNewBotGame(prev, next) {
  if (!botAutoSwitch || prev.state !== 'connected' || !next.watching) return;
  if (!(state?.external?.kind === 'bot' && state.external.live)) return;
  const had = new Set((prev.games ?? []).map((g) => g.id));
  const fresh = (next.games ?? []).find((g) => !had.has(g.id) && !g.finished && g.playing && g.id !== next.watching);
  if (fresh) lichessCommand('lichessWatch', { id: fresh.id });
}

// The game of your engine's on the board ends while it has others going:
// after a moment (the result shows first), the newest of them takes the
// board, unless a game was picked by hand meanwhile.
let lxPicks = 0; // games put on the board by hand, counted
const SWITCH_HOLD = 3000;
const RATING_WAIT = 12000; // at most, for a rated game's rating changes
function switchFromEndedBotGame(prev, next) {
  const id = next.watching;
  if (!id || !(state?.external?.kind === 'bot' && state.external.id === id)) return;
  const before = (prev.games ?? []).find((g) => g.id === id);
  const now = (next.games ?? []).find((g) => g.id === id);
  if (!before || before.finished || !now?.finished) return;
  const picks = lxPicks;
  const still = () => lxPicks === picks && lx.status.watching === id && state?.external?.id === id;
  // A rated game's rating changes come from Lichess a moment after it
  // ends: the board stays on it until they do (at most RATING_WAIT), and
  // then for the hold again, so they can be read on the result card.
  const endedAt = Date.now();
  let ratedAt = null;
  const tick = () => {
    if (!still()) return;
    const now = Date.now();
    if (ratedAt == null && state.external?.ratingDiff) ratedAt = now;
    const waiting = awaitingRating(state) && now < endedAt + RATING_WAIT;
    if (waiting || now < endedAt + SWITCH_HOLD || (ratedAt != null && now < ratedAt + SWITCH_HOLD)) { setTimeout(tick, 250); return; }
    const live = (lx.status.games ?? []).filter((g) => !g.finished && g.id !== id).reverse(); // newest first
    const pick = live.find((g) => g.playing) ?? live[0];
    if (pick) lichessCommand('lichessWatch', { id: pick.id });
  };
  tick();
}

// A game of your engine's that ends while another is on the board.
function koForBackgroundGames(prev, next) {
  if (window.tilesShown?.()) return; // the tiles show it ended
  if (next.state !== 'connected' && next.state !== 'reconnecting') return;
  const was = new Map((prev.games ?? []).map((g) => [g.id, g]));
  for (const g of next.games ?? []) {
    const before = was.get(g.id);
    if (!g.finished || !g.playing || !before || before.finished || g.id === state?.external?.id) continue;
    if (!['1-0', '0-1', '1/2-1/2'].includes(g.result)) continue;
    window.showBackgroundKo?.(g, next.account?.username || 'Your engine');
  }
}

function lichessStatus(next) {
  const prev = lx.status;
  lx.status = next;
  switchToNewBotGame(prev, next);
  switchFromEndedBotGame(prev, next);
  koForBackgroundGames(prev, next);
  window.trackMatchHistory?.(next);
  // A new challenge waiting for an answer.
  const before = new Set((prev.incoming ?? []).map((c) => c.id));
  if ((next.incoming ?? []).some((c) => !before.has(c.id))) sounds.play('challenge');
  // The answer to a challenge sent: declined (with the reason), or none.
  if (next.message && next.message !== prev.message && challengeNews(next.message)) notify(next.message, { title: 'Challenge', kind: 'warn' });
  window.trackChallenges?.('engine', prev, next);
  renderLichess();
  renderWatchStrip();
  renderChallengePop();
  renderDrawPop();
  renderLichessSettingsStatus();
  // Auto challenge takes up again when the engine connects.
  if (next.state === 'connected' && prev.state !== 'connected') runAutoChallenge();
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
  const flag = flagSpan(name);
  if (flag) parts.push(flag);
  parts.push(el('span', { className: 'lx-name', textContent: name || '?' }));
  if (rating) parts.push(el('span', { className: 'lx-rating', textContent: String(rating) }));
  return el('span', { className: 'lx-who' }, parts);
};

// How long a challenge sent still waits before it is withdrawn, counting
// down by itself ('' when it waits for ever).
function expiryNote(c) {
  const note = el('span', { className: 'lx-meta lx-expiry' });
  if (c.expiresAt) {
    note.dataset.at = c.expiresAt;
    note.title = 'Withdrawn then if there is no answer (Settings → Lichess)';
    expiryText(note);
    expiryTimer ??= setInterval(tickExpiry, 500);
  }
  return note;
}
let expiryTimer = null;
function expiryText(n) {
  const left = Math.max(0, Math.ceil((+n.dataset.at - Date.now()) / 1000));
  n.textContent = left ? `withdrawn in ${left} s` : 'withdrawing…';
}
function tickExpiry() {
  const notes = [...document.querySelectorAll('.lx-expiry[data-at]')];
  notes.forEach(expiryText);
  if (!notes.length) { clearInterval(expiryTimer); expiryTimer = null; }
}

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
  $('#lx-seg-engine').className = 'lx-seg-dot ' + (dot === 'off' ? '' : dot);
  const acct = $('#lx-account');
  acct.textContent = s.account && online
    ? `${s.account.username}${s.state === 'reconnecting' ? ' · reconnecting…' : ''}`
    : LX_STATE_TEXT[s.state] ?? s.state;
  if (s.account && online) { const f = flagSpan(s.account.username); if (f) acct.prepend(f, ' '); }
  const connect = $('#lx-connect');
  connect.textContent = s.state === 'off' || s.state === 'error' ? 'Connect' : 'Disconnect';
  connect.disabled = s.state === 'connecting';
  const message = [lx.note, s.message].filter(Boolean).join(' · ');
  $('#lx-message').textContent = message;
  $('#lx-message').hidden = !message;
  $('#lx-message').classList.toggle('error', Boolean(lx.note) || s.state === 'error' || s.state === 'notBot');
  $('#lx-body').hidden = !online;
  $('#lx-off').hidden = online;
  fillLichessEngine();
  if (!lxLiveGames().length) $('#lx-engine-note').hidden = true;

  renderMe(); // also counts the tab's badge
  if (ob.bots) renderOnlineBots(); // Challenge needs the bot connected
  if (!online) return;
  renderLichessAbout();

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
    expiryNote(c),
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
      // A game your engine plays has no Resign: the engine plays it out. One
      // it does not play (started elsewhere) can still be resigned.
      if (!g.playing) {
        actions.push(lxButton('Resign', async () => {
          if (await confirmDialog(`Resign the game against ${g.opponent}?`, 'Resign')) lichessCommand('lichessResign', { id: g.id });
        }));
      }
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
  }
  if (document.activeElement !== $('#lx-games')) $('#lx-games').value = p.maxGames || 1;
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
// Games at once: how many games your engine plays at the same time, kept by
// Accept automatically and by the random-bot challenger (a challenge
// accepted or sent by hand is not held back). Kept with the rules; applies
// at once.
$('#lx-games').onchange = async (e) => {
  const n = Math.min(8, Math.max(1, Math.round(+e.target.value || 1)));
  e.target.value = n;
  try {
    lx.settings = await api.lichess.save({ policy: { maxGames: n } });
    if (lxOnline()) await api.lichess.configure();
  } catch (err) {
    lxSetNote(errorText(err));
  }
  renderLichessRules();
};
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
  lxPicks++;
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

// The pane shows one part at a time (Play, Watch, Bot), chosen
// with the control at its top; the last one chosen is kept. The bots online
// are asked for the first time Bot is opened.
function lxShowView(view, keep = true) {
  if (view === 'bots') view = 'engine'; // once a part of its own
  const views = [...document.querySelectorAll('#pane-lichess .lx-view')];
  if (!views.some((v) => v.dataset.view === view)) view = 'play';
  for (const v of views) v.hidden = v.dataset.view !== view;
  $(`#lx-seg input[value="${view}"]`).checked = true;
  if (keep) try { localStorage.setItem('lichessView', view); } catch { /* not kept */ }
  if (view === 'engine' && !Array.isArray(ob.bots) && !ob.loading) loadOnlineBots();
  if (view === 'watch') lxTVNow();
}
$('#lx-seg').addEventListener('change', (e) => lxShowView(e.target.value));

// Lichess TV: a channel's games on the board, one after another. Each
// channel is a tile saying who it has on now; clicking one watches it. Who
// is on is asked for when Watch is opened, and every 30 seconds while it is
// open (Lichess changes games every few minutes).
const LX_TV = [
  { key: 'best', name: 'Top rated', icon: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/>' },
  { key: 'bullet', name: 'Bullet', icon: '<path d="M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6z" fill="currentColor"/>' },
  { key: 'blitz', name: 'Blitz', icon: '<path d="M12 2.5c.6 3.2 5.5 5.6 5.5 10.7a5.5 5.5 0 0 1-11 0c0-2.6 1.4-4.2 2.6-5.3.1 1.9.9 3.1 2.2 3.4-.4-3 .1-6.2.7-8.8z" fill="currentColor"/>' },
  { key: 'rapid', name: 'Rapid', icon: '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  { key: 'classical', name: 'Classical', icon: '<path d="M7 3h10M7 21h10M8 3v2.5c0 2.5 4 4.5 4 6.5s-4 4-4 6.5V21M16 3v2.5c0 2.5-4 4.5-4 6.5s4 4 4 6.5V21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' },
  { key: 'ultraBullet', name: 'UltraBullet', icon: '<path d="M3.5 5.5L11 12l-7.5 6.5zM12 5.5l7.5 6.5-7.5 6.5z" fill="currentColor"/>' },
  { key: 'bot', name: 'Bot', icon: '<rect x="4.5" y="8" width="15" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 4.5V8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="3.6" r="1.3" fill="currentColor"/><circle cx="9.3" cy="13.3" r="1.4" fill="currentColor"/><circle cx="14.7" cy="13.3" r="1.4" fill="currentColor"/>' },
  { key: 'computer', name: 'Computer', icon: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' },
];
const lxTV = { now: new Map(), asked: 0 };

function renderLichessTV() {
  const w = lx.watch ?? {};
  const on = w.active && w.tv ? w.tv : '';
  $('#lx-tv-grid').replaceChildren(...LX_TV.map((ch) => {
    const now = lxTV.now.get(ch.key);
    const watching = ch.key === on;
    const who = now?.player
      ? el('span', { className: 'lx-tv-who' }, [
        now.title && now.title !== 'BOT' ? el('b', { className: 'lx-tv-title', textContent: now.title + ' ' }) : '',
        ...[flagSpan(now.player)].filter(Boolean),
        now.player,
      ])
      : el('span', { className: 'lx-tv-who none', textContent: lxTV.asked ? 'Nothing on' : '…' });
    const tile = el('button', { type: 'button', className: 'lx-tv-tile' + (watching ? ' on' : '') }, [
      el('span', { className: `lx-tv-icon ${ch.key}`, innerHTML: `<svg viewBox="0 0 24 24" aria-hidden="true">${ch.icon}</svg>` }),
      el('span', { className: 'lx-tv-text' }, [
        el('span', { className: 'lx-tv-name' }, [ch.name, watching ? el('span', { className: 'lx-tv-live', textContent: 'Live' }) : '']),
        who,
        now?.rating ? el('span', { className: 'lx-tv-rating', textContent: String(now.rating) }) : '',
      ]),
    ]);
    tile.setAttribute('aria-pressed', String(watching));
    tile.title = watching ? `Watching ${ch.name} on the board` : `Watch the ${ch.name} channel on the board`;
    tile.onclick = () => lxWatchTV(ch.key);
    return tile;
  }));
}

async function lxTVNow(force) {
  if (!force && Date.now() - lxTV.asked < 20000) return;
  lxTV.asked = Date.now();
  lx.settings ??= await api.lichess.settings();
  try {
    const list = await api.backend('lichessTVNow', { baseUrl: lx.settings.baseUrl });
    lxTV.now = new Map((list ?? []).map((c) => [c.key, c]));
  } catch { lxTV.asked = 0; /* the tiles keep what they had */ }
  renderLichessTV();
}
setInterval(() => {
  if (!document.hidden && !$('#pane-lichess').hidden && !document.querySelector('#pane-lichess .lx-view[data-view="watch"]').hidden) lxTVNow(true);
}, 30000);

async function lxWatchTV(channel) {
  if (lx.watch?.active && lx.watch.tv === channel) return; // on already
  if (state?.active && !state.external) {
    const ok = await confirmDialog('Watch Lichess TV on the board? The game you are playing here will be abandoned.', 'Watch TV');
    if (!ok) return;
  }
  lx.settings ??= await api.lichess.settings();
  await lichessCommand('lichessTV', { baseUrl: lx.settings.baseUrl, channel });
}
renderLichessTV();

// The screens for games of the watched player that are not on the board:
// the versus screen for one that starts, the result screen for one that ends.
function screensForWatchedGames(prev, next) {
  if (window.tilesShown?.()) return; // the tiles show every game's start and end
  if (!prev?.active || !next.active || prev.user !== next.user) return;
  const was = new Map((prev.games ?? []).map((g) => [g.id, g]));
  // Before the first game is known, every game found is one joined.
  if (!was.size) return;
  for (const g of next.games ?? []) {
    const before = was.get(g.id);
    if (g.shown) continue;
    // A game found a few moves in (Lichess is asked every so often) is
    // still starting; not one long under way, found on joining.
    if (!before && g.live && (g.moves ?? 0) <= 12) window.showWatchVersus?.(g);
    else if (before?.live && !g.live) window.showWatchKo?.(g);
  }
}

function lichessWatchStatus(st) {
  const prev = lx.watch;
  lx.watch = st;
  screensForWatchedGames(prev, st);
  renderLichessWatch();
  renderWatchStrip();
  if (Array.isArray(ob?.bots)) renderOnlineBots(); // the TV of the bot being watched lights up
}

function renderLichessWatch() {
  const w = lx.watch;
  $('#lx-watch-stop').hidden = !w.active;
  $('#lx-watch-go').textContent = w.active ? 'Watch another' : 'Watch';
  let text = 'Not watching anything.';
  $('#lx-seg-watch').className = 'lx-seg-dot' + (w.active ? ' on' : '');
  renderLichessTV();
  if (w.active && w.tv) {
    text = w.state === 'live' ? `Watching ${w.user} live. The channel's next game comes on when this one ends.` : w.message || `Watching ${w.user}…`;
  } else if (w.active) {
    const live = (w.games ?? []).filter((g) => g.live).length;
    if (w.state === 'live' && live > 1) text = `Watching ${w.user} live in ${live} games at once: click one of the small boards above the moves to put it on the board.`;
    else if (w.state === 'live') text = `Watching ${w.user} live. The next game follows automatically.`;
    else text = w.message || `Watching ${w.user}…`;
  }
  const box = $('#lx-watch-state');
  box.replaceChildren(...(w.active && !w.tv ? withFlag(text, w.user) : [text]), ' ');
  if (w.active && w.url) box.append(lxLink(w.url, 'Open on Lichess ↗'));
  $('#lx-watch').classList.toggle('on', w.active);
}

// Several games at once (the player you are watching, or your own engine,
// is in more than one): a small board for each, as it stands now. The one
// on the board is marked; a click puts another there.
function watchMiniBoard(g) {
  const pieces = parseBoard(g.fen);
  const flip = g.side === 'black';
  const squares = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flip ? 7 - col : col;
      const rank = flip ? row + 1 : 8 - row;
      const sq = FILES[file] + rank;
      const piece = pieces[sq];
      const node = el('div', { className: 'square ' + ((file + rank) % 2 ? 'dark' : 'light') });
      if (g.lastMove && (sq === g.lastMove.slice(0, 2) || sq === g.lastMove.slice(2, 4))) node.classList.add('last');
      if (piece) node.append(pieceImage(piece.toLowerCase(), piece === piece.toUpperCase()));
      squares.push(node);
    }
  }
  return el('div', { className: 'ws-board', ariaHidden: 'true' }, squares);
}

function watchPick(id, bot) {
  // Chosen by hand: no versus screen for it.
  window.watchPicked = id;
  if (bot) lxWatch(id);
  else lichessCommand('lichessSpectateShow', { id });
}

// Your engine's games in progress (and the one on the board, if it is
// over), in the shape of a watched player's games: the oldest first.
function botStripGames(keep = null) {
  const s = lx.status;
  if (s.state !== 'connected' && s.state !== 'reconnecting') return [];
  const onBoard = state?.external?.kind === 'bot' ? state.external.id : '';
  const me = s.account?.username ?? 'Your engine';
  return (s.games ?? []).filter((g) => g.fen && (!g.finished || (g.id === onBoard && g.id === s.watching) || keep?.has(g.id))).reverse().map((g) => {
    const white = g.color === 'white';
    return {
      id: g.id, bot: true, side: g.color, fen: g.fen, lastMove: g.lastMove ?? '', moves: g.moves, live: !g.finished, result: g.result,
      white: white ? me : g.opponent, black: white ? g.opponent : me,
      whiteRating: white ? 0 : g.opponentRating, blackRating: white ? g.opponentRating : 0,
      whiteTitle: white ? '' : g.opponentTitle, blackTitle: white ? g.opponentTitle : '',
      whiteMs: g.whiteMs, blackMs: g.blackMs, clockAt: g.clockAt, running: g.running,
      label: [g.rated ? 'Rated' : 'Casual', g.speed, g.tc].filter(Boolean).join(' '),
      shown: g.id === onBoard && g.id === s.watching,
      note: !g.finished && g.myTurn ? 'your engine to move' : '',
    };
  });
}

function renderWatchStrip() {
  const w = lx.watch;
  // A player being watched comes first; else your engine's own games.
  const games = w?.active ? w.games ?? [] : botStripGames();
  const strip = $('#watch-strip');
  strip.hidden = games.length < 2;
  window.renderWatchTiles?.();
  if (strip.hidden) { strip.replaceChildren(); return; }
  const left = strip.scrollLeft;
  // Tiles: all the games at once, each on a board of its own.
  const tiles = el('button', { type: 'button', className: 'ws-tiles', title: 'Watch all the games at once, each on a board of its own' });
  tiles.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></g></svg><span>Tiles</span>';
  tiles.onclick = () => window.setWatchTiles?.(true);
  strip.replaceChildren(tiles, ...games.map((g) => {
    const other = g.side === 'black' ? 'white' : 'black';
    const rating = g[other + 'Rating'];
    const result = { '1-0': '1–0', '0-1': '0–1', '1/2-1/2': '½–½' }[g.result] ?? 'Ended';
    const toMove = g.fen.split(' ')[1] === 'b' ? 'Black' : 'White';
    const state = g.live
      ? el('span', { className: 'ws-state live', textContent: g.moves ? `Move ${Math.floor((g.moves + 1) / 2)} · ${g.note || toMove + ' to move'}` : 'Starting' })
      : el('span', { className: 'ws-state', textContent: result });
    const card = el('button', { type: 'button', className: 'ws-game' + (g.shown ? ' on' : '') + (g.live ? ' live' : ' over') }, [
      watchMiniBoard(g),
      el('span', { className: 'ws-text' }, [
        el('span', { className: 'ws-name' }, ['vs ', ...[flagSpan(g[other])].filter(Boolean), g[other]]),
        el('span', { className: 'ws-kind', textContent: [rating || null, g.label].filter(Boolean).join(' · ') }),
        state,
        g.shown ? el('span', { className: 'ws-tag', textContent: 'On the board' }) : null,
      ].filter(Boolean)),
    ]);
    card.title = `${g.white} – ${g.black} · ${g.label}` + (g.shown ? ' (on the board)' : ': click to put it on the board');
    if (g.shown) card.setAttribute('aria-current', 'true');
    if (!g.shown) card.onclick = () => watchPick(g.id, g.bot);
    return card;
  }));
  strip.scrollLeft = left;
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

// The random-bot challenger has settings of its own (the Random bot card):
// its clock, side and rated, which bots to ask, and how many games. They are
// kept between runs.
const SEEK_FIELDS = { time: '#lx-seek-time', inc: '#lx-seek-inc', color: '#lx-seek-color', rated: '#lx-seek-rated',
  mode: '#lx-seek-mode', min: '#lx-seek-min', max: '#lx-seek-max', around: '#lx-seek-around',
  noProv: '#lx-seek-noprov', minGames: '#lx-seek-mingames', exclude: '#lx-seek-exclude', games: '#lx-seek-games',
  randClock: '#lx-seek-randclock' };
const speedOf = (limit, inc) => {
  const t = limit + 40 * inc;
  return t < 30 ? 'ultraBullet' : t < 180 ? 'bullet' : t < 480 ? 'blitz' : t < 1500 ? 'rapid' : 'classical';
};
// Random challenge types, as lichess-bot's matchmaking does them: with the
// random clock on, each challenge draws its initial time and increment from
// the chips that are on (every pairing of them); Rated can be random too.
const SEEK_CHIPS = { times: '#lx-seek-times', incs: '#lx-seek-incs' };
const SEEK_CHIP_DEFAULTS = { times: [60, 180], incs: [1, 2] }; // lichess-bot's own defaults
const seekChips = (key) => [...$(SEEK_CHIPS[key]).querySelectorAll('.chip.on')].map((b) => +b.dataset.v);
function setSeekChips(key, values) {
  for (const b of $(SEEK_CHIPS[key]).querySelectorAll('.chip')) {
    const on = values.includes(+b.dataset.v);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
const randomClock = () => $('#lx-seek-randclock').checked;
// The time controls the challenger plays: the one picked, or every pairing.
function seekClocks() {
  if (!randomClock()) return [[+$('#lx-seek-time').value, +$('#lx-seek-inc').value]];
  return seekChips('times').flatMap((t) => seekChips('incs').map((i) => [t, i]));
}
const SPEED_ORDER = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical'];
const seekSpeed = () => {
  const speeds = new Set(seekClocks().map(([t, i]) => speedOf(t, i)));
  return SPEED_ORDER.filter((s) => speeds.has(s)).join('/') || 'none';
};
function saveSeekForm() {
  const out = {};
  for (const [k, id] of Object.entries(SEEK_FIELDS)) out[k] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  for (const k of Object.keys(SEEK_CHIPS)) out[k] = seekChips(k);
  try { localStorage.setItem('lichessSeek', JSON.stringify(out)); } catch { /* ignore */ }
}
function loadSeekForm() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lichessSeek') ?? '{}') ?? {}; } catch { /* ignore */ }
  if (typeof saved.rated === 'boolean') saved.rated = saved.rated ? 'rated' : 'casual'; // was a switch
  for (const k of Object.keys(SEEK_CHIPS)) {
    setSeekChips(k, Array.isArray(saved[k]) && saved[k].length ? saved[k].map(Number) : SEEK_CHIP_DEFAULTS[k]);
  }
  for (const [k, id] of Object.entries(SEEK_FIELDS)) {
    const v = saved[k];
    if (v == null || v === '') continue;
    if ($(id).type === 'checkbox') $(id).checked = Boolean(v);
    else if ($(id).tagName !== 'SELECT' || [...$(id).options].some((o) => o.value === String(v))) $(id).value = v;
  }
  renderSeekForm();
}
function renderSeekForm() {
  const around = $('#lx-seek-mode').value === 'around';
  $('#lx-seek-range').hidden = around;
  $('#lx-seek-around-box').hidden = !around;
  const random = randomClock();
  $('#lx-seek').classList.toggle('randclock', random);
  $('#lx-seek-pick').hidden = !random;
  $('#lx-seek-speed').textContent = random ? `random: ${seekSpeed()}` : seekSpeed();
  $('#lx-seek-rated-sub').textContent = $('#lx-seek-rated').value === 'random' ? 'each challenge at random' : '';
  renderSeekGames();
}
for (const box of Object.values(SEEK_CHIPS)) {
  $(box).addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    renderSeekForm();
    saveSeekForm();
    updateRunningSeek();
  });
}
for (const id of Object.values(SEEK_FIELDS)) {
  $(id).addEventListener(id === '#lx-seek-exclude' || $(id).type === 'number' ? 'input' : 'change', () => {
    renderSeekForm();
    saveSeekForm();
    if (id !== SEEK_FIELDS.games) updateRunningSeek();
  });
}
// How many games the random-bot search plays: 0 in the box is no limit.
const seekGames = () => { const n = Math.round(+$('#lx-seek-games').value); return Number.isFinite(n) && n >= 0 ? n : 1; };
function renderSeekGames() {
  $('#lx-seek-games-unit').textContent = seekGames() === 0 ? 'no limit' : 'one after another';
}

// Starts the random-bot challenger for so many games (0: no limit).
// The form's settings for the challenger, or { error } when they do not hold.
function seekParams() {
  const around = $('#lx-seek-mode').value === 'around' ? Math.max(0, Math.round(+$('#lx-seek-around').value || 0)) : 0;
  const min = around ? 0 : +$('#lx-seek-min').value || 0;
  const max = around ? 0 : +$('#lx-seek-max').value || 0;
  if (min && max && min > max) return { error: 'The lowest rating is above the highest.' };
  if ($('#lx-seek-mode').value === 'around' && !around) return { error: 'Give how many points either side of your bot\'s rating.' };
  const random = randomClock();
  if (random && !seekChips('times').length) return { error: 'Pick at least one initial time for the random clock.' };
  if (random && !seekChips('incs').length) return { error: 'Pick at least one increment for the random clock.' };
  const ratedMode = $('#lx-seek-rated').value;
  return {
    rated: ratedMode === 'rated', ratedMode, color: $('#lx-seek-color').value,
    limit: +$('#lx-seek-time').value, increment: +$('#lx-seek-inc').value, minRating: min, maxRating: max, around,
    times: random ? seekChips('times') : [], increments: random ? seekChips('incs') : [],
    noProvisional: $('#lx-seek-noprov').checked, minGames: Math.max(0, Math.round(+$('#lx-seek-mingames').value || 0)),
    exclude: $('#lx-seek-exclude').value.split(/[,\s]+/).map((n) => n.trim()).filter(Boolean),
  };
}
async function startSeek(games) {
  const p = seekParams();
  if (p.error) { lxSetNote(p.error); return null; }
  saveSeekForm();
  return lichessCommand('lichessSeek', { ...p, games: games === 0 ? -1 : games }); // the backend's "no limit" is below zero
}
// The form changed while the challenger runs (Auto challenge, say): it
// takes the new settings from its next look at the bots online. A moment
// after the last change, so typing a number sends it once.
let seekUpdateTimer = null;
function updateRunningSeek() {
  if (!lx.status.seek?.active) return;
  clearTimeout(seekUpdateTimer);
  seekUpdateTimer = setTimeout(() => {
    const p = seekParams();
    if (p.error) { lxSetNote(p.error); return; }
    lichessCommand('lichessSeekUpdate', p);
  }, 700);
}
$('#lx-seek-go').onclick = () => startSeek(seekGames());
// Stop also turns Auto challenge off: it would only start again.
$('#lx-seek-stop').onclick = () => { setAutoChallenge(false); lichessCommand('lichessSeekStop'); };

// Auto challenge: while it is on, your engine challenges random bots by
// itself, without end, with the clock and rating range of the form. It
// starts when the box is ticked and each time the engine connects, and
// stops when the box is cleared (or Stop is pressed).
let autoChallenge = (() => { try { return localStorage.getItem('lichessAutoChallenge') === 'on'; } catch { return false; } })();
function setAutoChallenge(on) {
  autoChallenge = Boolean(on);
  try { localStorage.setItem('lichessAutoChallenge', autoChallenge ? 'on' : 'off'); } catch { /* not kept */ }
  renderAutoChallenge();
}
function renderAutoChallenge() {
  $('#lx-seek-auto').checked = autoChallenge;
  // No number of games to it: it goes on until turned off.
  $('#lx-seek').classList.toggle('auto', autoChallenge);
  window.renderChallengeFloat?.();
}
async function runAutoChallenge() {
  if (!autoChallenge || lx.status.state !== 'connected') return;
  const seek = lx.status.seek;
  if (seek?.active && !seek.games) return; // already going, without end
  if (!(await startSeek(0))) setAutoChallenge(false); // could not start: say so, not pretend
}
// Turned on or off here, or from the challenge window.
function switchAutoChallenge(on) {
  setAutoChallenge(on);
  if (autoChallenge) runAutoChallenge();
  else if (lx.status.seek?.active) lichessCommand('lichessSeekStop');
}
$('#lx-seek-auto').onchange = (e) => switchAutoChallenge(e.target.checked);
renderAutoChallenge();

// One challenge at a time: why the engine (or you) cannot send another now.
function engineBusy() {
  const s = lx.status;
  const out = s.outgoing?.[0];
  if (out) return `Your engine's challenge to ${out.user} is waiting for an answer: cancel it to challenge someone else`;
  if (s.seek?.active) return 'Your engine is challenging random bots: stop that to challenge someone yourself';
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
  // The random-bot challenger may start while your engine is playing: it
  // challenges whenever there is room for another game at once.
  const out = lx.status.outgoing?.[0];
  const seekBusy = out && !lx.status.seek?.active ? `Your engine's challenge to ${out.user} is waiting for an answer: cancel it first` : '';
  $('#lx-seek-go').disabled = Boolean(seekBusy);
  $('#lx-seek-go').title = seekBusy || 'Challenge a random bot online that fits these settings, one a minute at most; if it declines or does not answer, try another until one accepts. With several games asked for it keeps challenging while your engine has room for another game at once';
  const mb = meBusy();
  if ($('#lx-me-send')) { $('#lx-me-send').disabled = Boolean(mb); $('#lx-me-send').title = mb; }
}

function renderSeek() {
  const seek = lx.status.seek;
  const on = Boolean(seek?.active);
  $('#lx-seek-go').hidden = on;
  $('#lx-seek-stop').hidden = !on;
  // The settings can be changed as it runs (they apply from its next look
  // at the bots online); not how many games it plays.
  $('#lx-seek-games').disabled = on;
  if (typeof autoChallenge !== 'undefined' && autoChallenge) $('#lx-seek-games').disabled = true;
  const box = $('#lx-seek-state');
  box.hidden = !on;
  if (on) {
    const range = seek.minRating || seek.maxRating
      ? `${seek.minRating || 'any'}–${seek.maxRating || 'any'} ${seek.speed}`
      : `any ${seek.speed} rating`;
    const text = () => {
      const left = seek.nextAt ? Math.max(0, Math.ceil((seek.nextAt - Date.now()) / 1000)) : 0;
      // Seconds, or minutes and hours for a long wait (a rate limit).
      const inText = left < 90 ? `${left} s` : left < 3600 ? `${Math.round(left / 60)} min`
        : `${Math.floor(left / 3600)} h${Math.round((left % 3600) / 60) ? ` ${Math.round((left % 3600) / 60)} min` : ''}`;
      const next = left ? ` Next challenge in ${inText}.` : '';
      // Which game it is on, when more than one was asked for.
      const many = seek.games !== 1;
      const game = !many ? '' : seek.playing ? ` · game ${seek.played}${seek.games ? ` of ${seek.games}` : ''}`
        : ` · ${seek.played}${seek.games ? ` of ${seek.games}` : ''} game${seek.games === 1 || (!seek.games && seek.played === 1) ? '' : 's'} played`;
      box.replaceChildren(...withFlag(`Random bot (${range})${game} · ${seek.tried} asked · ${seek.message}${next}`, seek.current));
    };
    text();
    clearInterval(lx.seekTimer);
    if (seek.nextAt) lx.seekTimer = setInterval(text, 1000);
  } else clearInterval(lx.seekTimer);
  $('#lx-seek').classList.toggle('on', on);
}

function loadChallengeForm() {
  try {
    loadSeekForm();
  } catch { /* ignore */ }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lichessChallenge') ?? '{}') ?? {}; } catch { /* ignore */ }
  if (saved.username) $('#lx-username').value = saved.username;
  if (saved.time) $('#lx-time').value = saved.time;
  if (saved.inc) $('#lx-inc').value = saved.inc;
  if (saved.color) $('#lx-color').value = saved.color;
  $('#lx-rated').checked = Boolean(saved.rated);
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
  $('#ls-challenge-timeout').value = st.challengeTimeout ?? 30;
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
    challengeTimeout: +$('#ls-challenge-timeout').value || 0,
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
  if (lxOnline() || meOnline()) { // the time a sent challenge waits is your own account's too
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
// Challenges window: comes up when a challenge arrives (to your engine's bot
// or to you), lists every challenge waiting, each with Accept and Decline.
// Later leaves them in the Lichess tab; the next new challenge opens it again.
// ---------------------------------------------------------------------------
const chPop = { seen: new Set(), busy: new Set(), error: '', reasons: new Map(), open: new Set() };
// The messages Lichess lets a decline carry: the challenger sees the text.
const DECLINE_REASONS = [
  ['generic', 'No message', 'I’m not accepting challenges at the moment.'],
  ['later', 'Not now', 'This is not the right time for me, please ask again later.'],
  ['tooFast', 'Too fast', 'This time control is too fast for me, please challenge again with a slower game.'],
  ['tooSlow', 'Too slow', 'This time control is too slow for me, please challenge again with a faster game.'],
  ['timeControl', 'Other time control', 'I’m not accepting challenges with this time control.'],
  ['rated', 'Rated only', 'Please send me a rated challenge instead.'],
  ['casual', 'Casual only', 'Please send me a casual challenge instead.'],
  ['standard', 'Standard chess only', 'I’m not accepting variant challenges right now.'],
  ['variant', 'Not this variant', 'I’m not willing to play this variant right now.'],
  ['noBot', 'No bots', 'I’m not accepting challenges from bots.'],
  ['onlyBot', 'Bots only', 'I’m only accepting challenges from bots.'],
];
const chReason = (c) => chPop.reasons.get(c.id) ?? (c.supported ? 'generic' : 'standard');

// What is known of the challenger: ratings at every speed, record, account.
function challengerProfile(c) {
  const speed = PL_SPEEDS.includes(c.speed) ? c.speed : 'blitz';
  const entry = botLookup(c.user, speed);
  if (entry.loading) return el('div', { className: 'ch-profile hint', textContent: `Looking ${c.user} up on Lichess…` });
  const prof = plJSON(plInfo(entry.data, c.user)?.profile);
  if (entry.error || !prof) return el('div', { className: 'ch-profile hint', textContent: entry.error || 'No profile found on Lichess.' });
  const ratings = PL_SPEEDS.filter((s) => prof.perfs?.[s]?.games).map((s) => {
    const p = prof.perfs[s];
    return el('span', { className: 'ch-perf' + (s === c.speed ? ' on' : ''), title: `${plNum(p.games)} ${PL_LABEL[s]} games${p.prov ? ', provisional' : ''}` }, [
      el('span', { textContent: PL_LABEL[s] }),
      el('b', { textContent: `${p.rating}${p.prov ? '?' : ''}` }),
      ...(p.prog ? [el('span', { className: 'pl-prog ' + (p.prog > 0 ? 'up' : 'down'), title: 'Change over the last 12 games', textContent: `${p.prog > 0 ? '▲' : '▼'}${Math.abs(p.prog)}` })] : []),
    ]);
  });
  const n = prof.count;
  const flag = flagEmoji(prof.profile?.flag);
  const facts = [
    n?.all ? `${plNum(n.all)} games` : '',
    n && (n.win + n.draw + n.loss) ? `${plNum(n.win)} won · ${plNum(n.draw)} drawn · ${plNum(n.loss)} lost` : '',
    prof.createdAt ? `joined ${plDate(prof.createdAt)}` : '',
    prof.playTime?.total ? `${plHours(prof.playTime.total)} played` : '',
    [flag, prof.profile?.location].filter(Boolean).join(' '),
  ].filter(Boolean).join(' · ');
  const base = (lx.settings?.baseUrl || 'https://lichess.org').replace(/\/+$/, '');
  const open = chPop.open.has(c.id);
  const more = lxButton(open ? 'Less' : 'More…', () => { if (open) chPop.open.delete(c.id); else chPop.open.add(c.id); renderChallengePop(true); }, 'small');
  return el('div', { className: 'ch-profile' }, [
    ...(ratings.length ? [el('div', { className: 'ch-perfs' }, ratings)] : [el('div', { className: 'hint', textContent: 'No rated games yet.' })]),
    ...(facts ? [el('div', { className: 'ch-facts', textContent: facts })] : []),
    ...(prof.profile?.bio ? [el('div', { className: 'ch-bio' + (open ? ' open' : ''), textContent: prof.profile.bio })] : []),
    el('div', { className: 'ch-links' }, [more, lxLink(`${base}/@/${c.user}`, 'Profile ↗', `${c.user} on Lichess`)]),
    ...(open ? [playerCard('', c.user, speed, entry.data), historyChart({ white: c.user }, speed, entry.data)] : []),
  ]);
}

function waitingChallenges() {
  const bot = lxOnline() ? (lx.status.incoming ?? []).map((c) => ({ c, who: 'engine' })) : [];
  const mine = meOnline() ? (me.status.incoming ?? []).map((c) => ({ c, who: 'you' })) : [];
  return [...bot, ...mine];
}

async function answerChallenge({ c, who }, accept) {
  chPop.busy.add(c.id);
  chPop.error = '';
  renderChallengePop();
  const cmd = who === 'engine' ? (accept ? 'lichessAccept' : 'lichessDecline') : (accept ? 'lichessAcctAccept' : 'lichessAcctDecline');
  const args = { id: c.id };
  if (!accept) args.reason = chReason(c);
  try {
    await api.backend(cmd, args);
  } catch (err) {
    chPop.error = errorText(err);
  }
  chPop.busy.delete(c.id);
  renderChallengePop();
}

function renderChallengePop(redraw = false) {
  const dlg = $('#dlg-challenges');
  const list = waitingChallenges();
  const ids = new Set(list.map(({ c }) => c.id));
  for (const id of [...chPop.seen]) if (!ids.has(id)) chPop.seen.delete(id);
  const pill = $('#challenges-pill');
  if (!list.length) { chPop.error = ''; pill.hidden = true; if (dlg.open) dlg.close(); return; }
  pill.textContent = list.length === 1 ? `1 challenge · ${list[0].c.user}` : `${list.length} challenges`;
  // Only a challenge not shown before brings the window up.
  const fresh = list.some(({ c }) => !chPop.seen.has(c.id));
  if (!dlg.open && !fresh && !redraw) { pill.hidden = false; return; }
  pill.hidden = true;
  for (const id of ids) chPop.seen.add(id);
  // Drawn again only when something shown changed: a menu stays open.
  const key = JSON.stringify([list.map(({ c, who }) => [c.id, who, chPop.busy.has(c.id), chReason(c), chPop.open.has(c.id), botLookup(c.user, PL_SPEEDS.includes(c.speed) ? c.speed : 'blitz').at]),
    chPop.error, pl.chartSpeed, pl.range]);
  if (key === chPop.key && dlg.open && !redraw) return;
  chPop.key = key;
  const both = lxOnline() && meOnline();
  $('#challenges-title').textContent = list.length === 1 ? 'Challenge' : `${list.length} challenges`;
  $('#challenges-list').replaceChildren(...list.map((item) => {
    const { c, who } = item;
    const busy = chPop.busy.has(c.id);
    const accept = lxButton('Accept', () => answerChallenge(item, true), 'primary');
    accept.disabled = busy || !c.supported;
    if (!c.supported) accept.title = who === 'engine' ? 'Your engine can only play standard chess with a clock' : 'Only standard chess can be played here';
    const decline = lxButton('Decline', () => answerChallenge(item, false), '');
    decline.disabled = busy;
    const reason = el('select', { className: 'ch-reason', ariaLabel: 'Message sent with a decline' },
      DECLINE_REASONS.map(([value, label]) => el('option', { value, textContent: label })));
    reason.value = chReason(c);
    const said = el('span', { className: 'ch-said' });
    const say = () => { said.textContent = `“${DECLINE_REASONS.find(([v]) => v === reason.value)?.[2] ?? ''}”`; };
    reason.onchange = () => { chPop.reasons.set(c.id, reason.value); say(); chPop.key = ''; };
    reason.disabled = busy;
    say();
    const note = c.note && c.supported && who === 'engine' ? ` · outside your auto-accept rules (${c.note})` : '';
    return el('div', { className: 'ch-row' }, [
      el('div', { className: 'ch-who' }, [
        lxWho(c.user, c.title, c.rating),
        ...(both ? [el('span', { className: 'ch-to', textContent: who === 'engine' ? 'to your engine' : 'to you' })] : []),
      ]),
      el('div', { className: 'ch-meta', textContent: challengeMeta(c) + note }),
      el('div', { className: 'ch-actions' }, [accept, decline]),
      challengerProfile(c),
      el('label', { className: 'ch-decline' }, [el('span', { textContent: 'Decline with' }), reason, said]),
    ]);
  }));
  $('#challenges-error').textContent = chPop.error;
  $('#challenges-error').hidden = !chPop.error;
  $('#challenges-decline-all').hidden = list.length < 2;
  $('#challenges-decline-all').disabled = chPop.busy.size > 0;
  // Not modal: it floats in the corner and the board stays usable.
  if (!dlg.open) dlg.show();
}

// Hidden: a button in the same corner brings the window back.
$('#dlg-challenges').addEventListener('close', () => { chPop.key = ''; renderChallengePop(); });
$('#challenges-pill').onclick = () => renderChallengePop(true);
$('#challenges-decline-all').onclick = () => { for (const item of waitingChallenges()) answerChallenge(item, false); };

// ---------------------------------------------------------------------------
// Draw offers to your engine: when the opponent offers a draw and the
// engine's own draw rules have not accepted it, a window asks. The offer
// stands until the engine moves (a move without accepting declines it).
// ---------------------------------------------------------------------------
const drawPop = { seen: new Set(), busy: new Set(), error: '', key: '' };
const drawOffers = () => (lxOnline() ? (lx.status.games ?? []).filter((g) => g.drawOffer === 'theirs' && !g.finished) : []);
// One offer is one game at one move: a new offer later asks again.
const drawKey = (g) => `${g.id}:${g.moves}`;

async function answerDraw(g, yes) {
  drawPop.busy.add(g.id);
  drawPop.error = '';
  renderDrawPop();
  try {
    await api.backend('lichessDraw', { id: g.id, yes });
    if (!yes) drawPop.seen.add(drawKey(g) + ':no');
  } catch (err) {
    drawPop.error = errorText(err);
  }
  drawPop.busy.delete(g.id);
  renderDrawPop();
}

function renderDrawPop() {
  const dlg = $('#dlg-draw');
  const list = drawOffers().filter((g) => !drawPop.seen.has(drawKey(g) + ':no'));
  if (!list.length) { drawPop.error = ''; drawPop.key = ''; if (dlg.open) dlg.close(); return; }
  const fresh = list.some((g) => !drawPop.seen.has(drawKey(g)));
  if (!dlg.open && !fresh) return; // hidden: it stays hidden for these offers
  if (fresh) sounds.play('challenge');
  for (const g of list) drawPop.seen.add(drawKey(g));
  const own = typeof botScore === 'function' ? botScore() : null;
  const key = JSON.stringify([list.map((g) => [drawKey(g), drawPop.busy.has(g.id)]), drawPop.error, own && formatScore(own)]);
  if (key === drawPop.key && dlg.open) return;
  drawPop.key = key;
  $('#draw-title').textContent = list.length === 1 ? 'Draw offer' : `${list.length} draw offers`;
  $('#draw-list').replaceChildren(...list.map((g) => {
    const busy = drawPop.busy.has(g.id);
    const accept = lxButton('Accept draw', () => answerDraw(g, true), 'primary');
    const decline = lxButton('Decline', () => answerDraw(g, false), '');
    accept.disabled = decline.disabled = busy;
    const onBoard = state?.external?.id === g.id;
    const meta = ['Offers a draw', g.tc, g.rated ? 'rated' : 'casual', g.speed, `move ${Math.floor(g.moves / 2) + 1}`,
      onBoard && own ? `your engine sees ${formatScore(own)} (White’s view)` : ''].filter(Boolean).join(' · ');
    return el('div', { className: 'ch-row' }, [
      el('div', { className: 'ch-who' }, [lxWho(g.opponent, g.opponentTitle, g.opponentRating)]),
      el('div', { className: 'ch-meta', textContent: meta }),
      el('div', { className: 'ch-actions' }, [accept, decline]),
    ]);
  }));
  $('#draw-note').textContent = 'Your engine’s draw rules did not accept it. The offer lapses when your engine makes its move.';
  $('#draw-error').textContent = drawPop.error;
  $('#draw-error').hidden = !drawPop.error;
  if (!dlg.open) dlg.show();
}

// ---------------------------------------------------------------------------
// Engine and bot account: what is playing (the engine, how it is started and
// its UCI options) and as whom (the bot's ratings, their change, its record
// and rating history). Shown while connected.
// ---------------------------------------------------------------------------
const lxa = {
  key: '',            // what is drawn, so a status update does not redraw it
  probes: new Map(),  // engine id + arguments → { info, error, loading }
  finished: -1,       // finished games seen, to read the ratings again
  stamp: 0,           // bumps when the bot's numbers are read again
};

const lxEngine = () => engines.find((e) => e.id === lx.settings?.engineId) ?? engines[0];
const lxaSpeed = () => pl.chartSpeed || (PL_SPEEDS.includes(lxSpeed()) ? lxSpeed() : 'blitz');

// What the engine says about itself (name, author, options): asked once.
function lxaProbe(engine) {
  const key = `${engine.id}|${JSON.stringify(engine.args ?? [])}`;
  let p = lxa.probes.get(key);
  if (!p) {
    p = { info: null, error: '', loading: true };
    lxa.probes.set(key, p);
    api.engines.probe(engine.id).then((info) => { p.info = info; }, (err) => { p.error = errorText(err); })
      .finally(() => { p.loading = false; renderLichessAbout(); });
  }
  return p;
}

// Reads the bot's ratings again (after a game, or on Refresh).
function lxaRefresh() {
  const name = lx.status.account?.username?.toLowerCase();
  if (!name) return;
  for (const k of [...plCache.keys()]) if (k.startsWith(name + '|')) plCache.delete(k);
  lxa.stamp++;
  renderLichessAbout();
}

function lxaEngineCard(engine) {
  const probe = lxaProbe(engine);
  const info = probe.info;
  const set = engine.options ?? {};
  const opts = (info?.options ?? []).filter((o) => o.type !== 'button');
  const show = (v) => (v === '' || v === '<empty>' ? '(empty)' : String(v));
  const edit = lxButton('Options…', () => openOptions(engine));
  edit.title = 'Change this engine’s UCI options';
  const said = [info?.name, info?.author && `by ${info.author}`].filter(Boolean).join(' ');
  const fact = (label, value, title = '') => el('div', { className: 'pl-fact', title }, [el('span', { textContent: label }), el('b', { textContent: value })]);
  const facts = [
    fact('Program', (engine.path ?? '').split(/[\\/]/).pop() || '—', engine.path ?? ''),
    ...(engine.args?.length ? [fact('Command line', engine.args.join(' '), 'Passed to the engine when it starts')] : []),
    fact('Thinks on their time', lx.settings?.ponder !== false ? 'On' : 'Off', 'Pondering: set in Settings → Lichess'),
    ...(info ? [fact('UCI options', `${opts.length}${Object.keys(set).length ? ` · ${Object.keys(set).length} changed` : ''}`)] : []),
  ];
  const kids = [
    el('div', { className: 'lx-about-head' }, [el('span', { className: 'lx-about-kind', textContent: 'Engine' }), edit]),
    el('div', { className: 'lx-about-name', textContent: engine.name }),
    ...(said && said !== engine.name ? [el('div', { className: 'lx-about-sub', textContent: said })] : []),
    el('div', { className: 'pl-facts' }, facts),
  ];
  if (probe.loading) kids.push(el('p', { className: 'hint', textContent: 'Asking the engine for its options…' }));
  else if (probe.error) kids.push(el('p', { className: 'error', textContent: `The engine did not answer: ${probe.error}` }));
  // Options you set, whether or not the engine listed them.
  const changed = Object.entries(set);
  if (changed.length) {
    kids.push(el('div', { className: 'lx-opts' }, changed.map(([name, value]) => {
      const def = opts.find((o) => o.name === name)?.default;
      return el('span', { className: 'lx-opt set', title: def != null ? `The engine’s default is ${show(def)}` : '' }, [`${name} `, el('b', { textContent: show(value) })]);
    })));
  } else if (info) {
    kids.push(el('p', { className: 'hint', textContent: opts.length ? 'Every option is at the engine’s default.' : 'This engine has no options.' }));
  }
  if (opts.length) {
    const all = el('details', { className: 'lx-opts-all' }, [
      el('summary', { textContent: `All ${opts.length} options` }),
      el('div', { className: 'lx-opt-table' }, opts.flatMap((o) => {
        const isSet = o.name in set;
        return [
          el('span', { className: 'k' + (isSet ? ' set' : ''), textContent: o.name }),
          el('span', { className: 'v' + (isSet ? ' set' : ''), textContent: show(set[o.name] ?? o.default), title: isSet ? `Default ${show(o.default)}` : 'Default' }),
        ];
      })),
    ]);
    all.open = lxa.allOpen === true;
    all.ontoggle = () => { lxa.allOpen = all.open; };
    kids.push(all);
  }
  return kids;
}

function lxaBotCard(name) {
  const speed = lxaSpeed();
  const entry = botLookup(name, speed);
  const refresh = lxButton('Refresh', lxaRefresh);
  refresh.title = 'Read the ratings again; they are also read after each game';
  refresh.disabled = entry.loading;
  const head = el('div', { className: 'lx-about-head' }, [el('span', { className: 'lx-about-kind', textContent: 'Bot account' }), refresh]);
  if (entry.loading) return [head, el('p', { className: 'hint', textContent: `Looking ${name} up on Lichess…` })];
  if (entry.error) return [head, el('p', { className: 'error', textContent: entry.error })];
  return [head, playerCard('', name, speed, entry.data), historyChart({ white: name }, speed, entry.data)];
}

function renderLichessAbout() {
  const box = $('#lx-about');
  if (!box || !lxOnline()) return;
  const engine = lxEngine();
  const name = lx.status.account?.username ?? '';
  $('#lx-about-summary').textContent = [engine?.name, name].filter(Boolean).join(' · ');
  if (!box.open) { lxa.key = ''; return; }
  // A finished game changes the ratings: read them again shortly after.
  const finished = (lx.status.games ?? []).filter((g) => g.finished).length;
  if (lxa.finished >= 0 && finished > lxa.finished) setTimeout(lxaRefresh, 4000);
  lxa.finished = finished;
  const probe = engine ? lxaProbe(engine) : null;
  const entry = name ? botLookup(name, lxaSpeed()) : null;
  const key = JSON.stringify([engine, probe?.loading, probe?.error, lx.settings?.ponder, name, lxaSpeed(), pl.range,
    entry?.loading, entry?.error, entry?.at, lxa.stamp, document.documentElement.dataset.theme]);
  if (key === lxa.key) return;
  lxa.key = key;
  $('#lx-about-engine').replaceChildren(...(engine ? lxaEngineCard(engine) : [el('p', { className: 'hint', textContent: 'No engine is chosen.' })]));
  $('#lx-about-bot').replaceChildren(...(name ? lxaBotCard(name) : [el('p', { className: 'hint', textContent: 'No account yet.' })]));
}
window.renderLichessAbout = renderLichessAbout;

$('#lx-about').open = localStorage.getItem('lichessAbout') !== 'closed';
$('#lx-about').addEventListener('toggle', () => {
  try { localStorage.setItem('lichessAbout', $('#lx-about').open ? 'open' : 'closed'); } catch { /* ignore */ }
  renderLichessAbout();
});

// An engine's options were saved: the Lichess engine takes them up.
window.lichessEngineChanged = async (id) => {
  if (lxEngine()?.id !== id) return;
  if (lxOnline()) { try { await api.lichess.configure(); } catch (err) { lxSetNote(errorText(err)); } }
  renderLichessAbout();
};

// The engine the bot plays with, chosen and configured on the pane itself
// (also in Settings → Lichess). A change applies from the bot's next game.
let lxEngineKey = '';
async function fillLichessEngine() {
  lx.settings ??= await api.lichess.settings().catch(() => null);
  const select = $('#lx-engine');
  const key = JSON.stringify(engines.map((e) => [e.id, e.name]));
  if (key !== lxEngineKey) {
    lxEngineKey = key;
    select.replaceChildren(...engines.map((e) => el('option', { value: e.id, textContent: e.name })));
  }
  if (document.activeElement !== select) select.value = lxEngine()?.id ?? '';
  select.disabled = !engines.length || !lx.settings;
  $('#lx-engine-options').disabled = !lxEngine();
}
window.fillLichessEngine = fillLichessEngine;

$('#lx-engine').onchange = async (e) => {
  const select = e.target;
  const before = lxEngine()?.id;
  try {
    lx.settings = await api.lichess.save({ engineId: select.value });
  } catch (err) {
    select.value = before ?? '';
    lxSetNote(errorText(err));
    return;
  }
  if ($('#ls-engine')) $('#ls-engine').value = select.value;
  const playing = lxLiveGames().length;
  if (lxOnline()) { try { await api.lichess.configure(); } catch (err) { lxSetNote(errorText(err)); } }
  const note = $('#lx-engine-note');
  note.textContent = playing ? `${lxEngine()?.name} plays from the next game; the game${playing === 1 ? '' : 's'} in progress keep${playing === 1 ? 's' : ''} ${engines.find((x) => x.id === before)?.name ?? 'the engine it started with'}.` : '';
  note.hidden = !playing;
  renderLichessAbout();
};
$('#lx-engine-options').onclick = () => {
  const engine = lxEngine();
  const said = 'Could not read the engine’s options: ';
  if (engine) openOptions(engine, (err) => { if (err) lxSetNote(said + errorText(err)); else if (lx.note?.startsWith(said)) lxSetNote(''); });
};
fillLichessEngine();

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
  mark: { engine: null, you: null }, // the bot just challenged, until the status names it
  loading: false,
  timer: null,
};
const OB_SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'];
const OB_SHORT = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical' };

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
  const eOut = engineOn ? obChallenged('engine') : null;
  const yOut = youOn ? obChallenged('you') : null;
  const rows = list.slice(0, ob.shown).map((b) => {
    const name = obName(b);
    const st = ob.status.get(b.id);
    const perf = obPerf(b, speed);
    const r = obRating(b, speed);
    const flag = flagEmoji(b.profile?.flag);
    const who = el('span', { className: 'who', title: 'Show details' }, [
      el('span', { className: 'state' + (st?.playing ? ' playing' : st && !st.online ? ' off' : ''), title: st?.playing ? 'Playing' : st && !st.online ? 'Offline' : 'Online' }),
      ...(flag ? [el('span', { className: 'flag', textContent: flag, title: b.profile.flag })] : []),
      // Every one of them is a bot: no BOT before each name.
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
    // The bot a challenge went to shows it; every other button waits.
    const key = name.toLowerCase();
    const eMine = eOut && eOut.name === key;
    const engineBtn = lxButton(eMine ? (eOut.sending ? 'Challenging…' : 'Challenged') : 'Challenge', () => obChallenge(b, 'engine'), 'small primary' + (eMine ? ' challenged' : ''));
    engineBtn.disabled = !engineOn || Boolean(eBusy) || Boolean(eOut) || ob.sending;
    engineBtn.title = !engineOn ? 'Connect your engine’s Bot account (below) to challenge with it'
      : eMine ? `Your engine challenged ${name}: waiting for an answer. Cancel it under “Challenge a player” below`
        : eOut ? `Your engine's challenge to ${eOut.shown} is waiting for an answer: cancel it to challenge someone else`
          : eBusy || `Challenge ${name} with your engine: ${tcEngine}, from “Challenge a player” below`;
    if (eMine) engineBtn.setAttribute('aria-pressed', 'true');
    acts.push(engineBtn);
    if (youOn) {
      const yMine = yOut && yOut.name === key;
      const youBtn = lxButton(yMine ? (yOut.sending ? 'Challenging…' : 'Challenged') : 'Play', () => obChallenge(b, 'you'), 'small' + (yMine ? ' challenged' : ''));
      youBtn.disabled = Boolean(mBusy) || Boolean(yOut) || ob.sending;
      youBtn.title = yMine ? `You challenged ${name}: waiting for an answer. Cancel it under your challenges`
        : yOut ? `Your challenge to ${yOut.shown} is waiting for an answer: cancel it to challenge someone else`
          : mBusy || `Challenge ${name} to play you: ${tcYou}, from your Challenge a friend settings`;
      if (yMine) youBtn.setAttribute('aria-pressed', 'true');
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

// Who a challenge from the list is out to: { name (lower case), shown, sending }.
// The status names it once Lichess has it; until then the click is remembered.
function obChallenged(who) {
  const out = (who === 'engine' ? lx.status : me.status).outgoing?.[0];
  const m = ob.mark[who];
  if (out) {
    if (m) m.seen = true;
    return { name: String(out.user ?? '').toLowerCase(), shown: out.user, sending: false };
  }
  if (m && !m.seen && (m.sending || Date.now() - m.at < 5000)) return { name: m.name.toLowerCase(), shown: m.name, sending: m.sending };
  ob.mark[who] = null;
  return null;
}

async function obChallenge(b, who) {
  const name = obName(b);
  if (ob.sending) return;
  ob.sending = true;
  ob.mark[who] = { name, sending: true, seen: false, at: Date.now() };
  renderOnlineBots();
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
    // Sent: the button stays "Challenged" until the status takes over.
    if (ob.mark[who]) { ob.mark[who].sending = false; ob.mark[who].at = Date.now(); }
    setTimeout(() => ob.bots && renderOnlineBots(), 5100);
  } else {
    ob.mark[who] = null;
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
    if (cmd === 'lichessAcctChallenge') challengeFailed(err, args, 'you');
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
  if (next.message && next.message !== prev.message && challengeNews(next.message)) notify(next.message, { title: 'Challenge', kind: 'warn' });
  window.trackChallenges?.('you', prev, next);
  renderMe();
  renderChallengePop();
  if (ob.bots) renderOnlineBots(); // Play needs you signed in
  if (state?.external?.kind === 'play') renderPlayers(); // the bar's buttons follow the offers
  else renderPlayOffer();
}

function renderMe() {
  const s = me.status;
  const online = meOnline();
  $('#lx-seg-play').className = 'lx-seg-dot' + (online ? ' on' : '');
  $('#lx-signin').hidden = online || s.state === 'connecting';
  $('#lx-me-body').hidden = !online;
  $('#lx-signin-go').disabled = me.signingIn;
  $('#lx-signin-go').textContent = me.signingIn ? 'Waiting for Lichess in your browser…' : 'Sign in with Lichess';
  $('#lx-signin-cancel').hidden = !me.signingIn;
  const who = $('#lx-me-who');
  who.replaceChildren();
  if (s.account && s.state !== 'off') {
    const flag = flagSpan(s.account.username);
    if (flag) who.append(flag);
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
    expiryNote(c),
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
    lxShowView((() => { try { return localStorage.getItem('lichessView'); } catch { return null; } })() ?? 'play', false);
    if (lx.settings.autoConnect && lx.settings.hasToken) lxConnect();
    loadMeForm();
    loadOnlineFilters();
    lichessAccountStatus(await api.backend('lichessAcctStatus'));
    if (lx.settings.hasAccount) meConnect(); // signed in before: sign in again
  } catch (err) {
    lxSetNote(errorText(err));
  }
}
