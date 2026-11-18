'use strict';
// The challenge window: challenges sent to other players (by your engine,
// or by you) show in a small window floating over the app, each with how it
// stands: waiting for an answer (and how long before it is withdrawn),
// accepted, declined (and why), or withdrawn. An answered challenge stays a
// few seconds, then goes; with none left the window closes. Drag it by its
// header; the arrow folds it down to the header. It opens at the bottom
// right of the app's window each time. While your engine is challenging random bots,
// a declined challenge stays until the next one goes out, and the window
// counts down to it. ✕ hides it, until the button it leaves in the tray at
// the bottom right is pressed; whether it is hidden is kept.

const chf = {
  items: new Map(), // key -> { who, c, state, text, endedAt, timer }
  pos: (() => { try { return JSON.parse(localStorage.getItem('challengeFloat')) || {}; } catch { return {}; } })(),
};
const CHF_KEEP = { accepted: 6000, declined: 14000, expired: 12000, gone: 8000, failed: 20000 };
const CHF_LABEL = {
  waiting: 'Waiting for an answer', accepted: 'Accepted', declined: 'Declined',
  expired: 'No answer', gone: 'Withdrawn', failed: 'Not sent',
};

// A challenge Lichess would not send (refused, rate limited, no such
// player…): a row with the error, kept like a declined one.
const chfClock = (limit, inc) => {
  const m = limit / 60;
  return `${{ 0.25: '¼', 0.5: '½', 0.75: '¾' }[m] ?? String(+m.toFixed(1))}+${inc}`;
};
let chfFails = 0;
function chfFailed(who, f) {
  const key = `${who}:failed:${++chfFails}`;
  // It takes the place of those not accepted before it, as a new challenge does.
  for (const [k, old] of chf.items) if (old.who === who && old.held) { clearTimeout(old.timer); chf.items.delete(k); }
  const c = { id: key, user: f.user, title: f.title ?? '', rating: f.rating ?? 0, tc: f.limit != null ? chfClock(f.limit, f.increment ?? 0) : '',
    rated: Boolean(f.rated), speed: f.speed ?? '', color: f.color ?? 'random' };
  chf.items.set(key, { who, c, state: 'waiting', text: '' });
  chfEnd(key, 'failed', String(f.error ?? '').replace(/^Error:\s*/, ''));
  renderChallengeFloat();
}
window.challengeNotSent = chfFailed;

function chfSave() {
  try { localStorage.setItem('challengeFloat', JSON.stringify({ folded: Boolean(chf.pos.folded), hidden: Boolean(chf.pos.hidden) })); } catch { /* not kept */ }
}

// At the bottom right of the app's window, or where it was dragged to since
// it opened; always inside the window. Anchored to the corner, it grows
// upward as challenges are added.
function chfPlace() {
  const win = $('#ch-float');
  if (win.hidden) return;
  const r = win.getBoundingClientRect();
  const m = 8;
  const fit = (v, size, room, first) => Math.round(Math.max(m, Math.min(room - size - m, v ?? first)));
  // The AI panel, when open, takes the right-hand side: the corner is to its left.
  const ai = $('#ai-panel');
  // (offsetLeft: where it comes to rest, not where its slide has got to)
  const right = ai && !ai.classList.contains('collapsed') ? ai.offsetLeft : window.innerWidth;
  win.style.left = fit(chf.pos.x, r.width, window.innerWidth, right - r.width - 2 * m) + 'px';
  win.style.top = fit(chf.pos.y, r.height, window.innerHeight, window.innerHeight - r.height - 2 * m) + 'px';
}

function chfEnd(key, state, text) {
  const it = chf.items.get(key);
  if (!it) return;
  it.state = state;
  it.text = text ?? '';
  it.endedAt = Date.now();
  clearTimeout(it.timer);
  // Challenging random bots: one not accepted stays until the next goes out.
  it.held = it.who === 'engine' && state !== 'accepted' && Boolean(lx.status.seek?.active);
  if (!it.held) chfExpire(key, it);
}

function chfExpire(key, it) {
  it.held = false;
  clearTimeout(it.timer);
  it.timer = setTimeout(() => { chf.items.delete(key); renderChallengeFloat(); }, CHF_KEEP[it.state] ?? 8000);
}

// When your engine's next challenge to a random bot goes out, if it is
// waiting to send one: { at } (Unix ms), or { text } while it looks for a bot.
function chfNext() {
  const seek = lx.status.seek;
  if (!seek?.active || seek.playing) return null;
  if ([...chf.items.values()].some((it) => it.who === 'engine' && it.state === 'waiting')) return null;
  if (seek.nextAt > Date.now()) return { at: seek.nextAt };
  return [...chf.items.values()].some((it) => it.held) ? { text: 'Looking for the next bot to challenge…' } : null;
}

function chfNextText(n) {
  const left = Math.max(0, Math.ceil((+n.dataset.at - Date.now()) / 1000));
  const span = left >= 60 ? `${Math.floor(left / 60)} min ${left % 60} s` : `${left} s`;
  n.textContent = left ? `Next challenge in ${span}` : 'Sending the next challenge…';
}
setInterval(() => {
  const n = $('#ch-float-next');
  if (!$('#ch-float').hidden && n.dataset.at) chfNextText(n);
}, 500);

// Called with each status of your engine's connection ('engine') or of
// your own account ('you'): prev and next are the statuses.
function trackChallenges(who, prev, next) {
  const out = next.outgoing ?? [];
  const ids = new Set(out.map((c) => c.id));
  for (const c of out) {
    const key = who + ':' + c.id;
    const it = chf.items.get(key);
    if (!it) {
      // The new challenge takes the place of those not accepted before it.
      for (const [k, old] of chf.items) if (old.who === who && old.held) { clearTimeout(old.timer); chf.items.delete(k); }
      chf.items.set(key, { who, c, state: 'waiting', text: '' });
    }
    else if (it.state === 'waiting') it.c = c; // its time to wait may have been set since
  }
  const games = new Set((next.games ?? []).map((g) => g.id));
  for (const [key, it] of chf.items) {
    if (it.who !== who || it.state !== 'waiting' || ids.has(it.c.id)) continue;
    // Answered: its game has started, or else it is no longer out.
    chfEnd(key, games.has(it.c.id) ? 'accepted' : 'gone');
  }
  // What became of it, when the status says: declined (and why), or no answer.
  const news = [[prev.message, next.message], [prev.seek?.message, next.seek?.message]]
    .filter(([was, now]) => now && now !== was).map(([, now]) => now);
  for (const msg of news) {
    const kind = /did not answer/i.test(msg) ? 'expired' : /declined/i.test(msg) ? 'declined' : '';
    if (!kind) continue;
    const recent = [...chf.items].filter(([, it]) => it.who === who && (it.state === 'gone' || it.state === 'waiting')
      && (it.state === 'waiting' || Date.now() - it.endedAt < 6000)
      && msg.toLowerCase().includes(String(it.c.user ?? '').toLowerCase())).at(-1);
    if (!recent) continue;
    // Only the reason, where one is given: the row says who and what.
    const why = kind === 'declined' ? (msg.split(/declined(?: (?:the|your) challenge)?[:,.]?\s*/i)[1] ?? '').replace(/\.$/, '') : '';
    chfEnd(recent[0], kind, why);
  }
  // The random-bot challenger could not send one.
  const failed = next.seek?.failed;
  if (who === 'engine' && failed && failed.at !== prev.seek?.failed?.at) chfFailed('engine', failed);
  // No longer challenging random bots: those kept for the next one go.
  if (who === 'engine' && (!next.seek?.active || next.seek.playing)) {
    for (const [key, it] of chf.items) if (it.held) chfExpire(key, it);
  }
  renderChallengeFloat();
}
window.trackChallenges = trackChallenges;
window.renderChallengeFloat = renderChallengeFloat;
$('#ch-float-auto-on').onchange = (e) => switchAutoChallenge(e.target.checked);
$('#ch-float-auto-stop').onclick = () => lichessCommand('lichessSeekStop');

function renderChallengeFloat() {
  const win = $('#ch-float');
  const items = [...chf.items];
  const upcoming = chfNext();
  const was = win.hidden;
  // Auto challenge (or a run of random-bot challenges) can be stopped here.
  const seeking = Boolean(lx.status.seek?.active);
  const auto = typeof autoChallenge !== 'undefined' && autoChallenge;
  const wanted = !(items.length === 0 && !upcoming?.at && !(auto && seeking));
  win.hidden = !wanted || Boolean(chf.pos.hidden);
  // Hidden with ✕: a button in the tray says how it stands, and brings it back.
  const pill = chfPill();
  pill.hidden = !(wanted && chf.pos.hidden);
  if (!pill.hidden) {
    const waitingNow = items.filter(([, it]) => it.state === 'waiting').length;
    pill.textContent = 'Challenges' + (waitingNow ? ` · ${waitingNow} waiting` : upcoming?.at ? ' · next soon' : '');
  }
  if (win.hidden) return;
  const row = $('#ch-float-auto');
  row.hidden = !auto && !seeking;
  $('#ch-float-auto-on').hidden = !auto;
  $('#ch-float-auto-on').checked = auto;
  $('#ch-float-auto-stop').hidden = auto;
  $('#ch-float-auto-label').firstElementChild.textContent = auto ? 'Auto challenge' : 'Random bots';
  const { games = 0, played = 0 } = lx.status.seek ?? {};
  $('#ch-float-auto-sub').textContent = auto || games <= 0 ? 'without end' : `game ${Math.min(games, played + 1)} of ${games}`;
  // Each time it opens: at the bottom right.
  if (was) { delete chf.pos.x; delete chf.pos.y; }
  const next = $('#ch-float-next');
  next.hidden = !upcoming;
  if (upcoming?.at) { next.dataset.at = upcoming.at; chfNextText(next); }
  else { delete next.dataset.at; next.textContent = upcoming?.text ?? ''; }
  const waiting = items.filter(([, it]) => it.state === 'waiting').length;
  $('#ch-float-count').textContent = waiting ? `${waiting} waiting` : '';
  const folded = Boolean(chf.pos.folded);
  win.classList.toggle('folded', folded);
  const toggle = $('#ch-float-fold');
  toggle.textContent = folded ? '▸' : '▾';
  toggle.title = folded ? 'Show the challenges' : 'Fold the window down to this bar';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.setAttribute('aria-expanded', String(!folded));
  $('#ch-float-list').replaceChildren(...items.map(([key, it]) => {
    const { c, who, state } = it;
    const status = el('span', { className: 'chf-state ' + state, textContent: CHF_LABEL[state] });
    const action = state === 'waiting'
      ? lxButton('Cancel', () => (who === 'engine' ? lichessCommand('lichessCancel', { id: c.id }) : meCommand('lichessAcctCancel', { id: c.id })))
      : lxButton('✕', () => { clearTimeout(it.timer); chf.items.delete(key); renderChallengeFloat(); }, 'small chf-x');
    if (state !== 'waiting') { action.title = 'Dismiss'; action.setAttribute('aria-label', 'Dismiss'); }
    const detail = state === 'waiting' ? expiryNote(c)
      : el('span', { className: 'lx-meta chf-detail', textContent: state === 'accepted' ? 'The game is starting' : it.text, title: it.text });
    return el('div', { className: 'chf-row ' + state }, [
      el('div', { className: 'chf-line' }, [
        el('span', { className: 'lx-meta', textContent: who === 'engine' ? 'Your engine →' : 'You →' }),
        lxWho(c.user, c.title, c.rating),
        el('span', { className: 'chf-actions' }, [action]),
      ]),
      el('div', { className: 'chf-line' }, [status, detail]),
      el('div', { className: 'lx-meta chf-meta', textContent: challengeMeta(c) }),
    ]);
  }));
  chfPlace();
}

// The tray button standing in for the window while it is hidden.
let chfPillEl = null;
function chfPill() {
  if (!chfPillEl) {
    chfPillEl = el('button', { type: 'button', className: 'fw-pill', hidden: true, title: 'Show the challenges window' });
    chfPillEl.onclick = () => { chf.pos.hidden = false; chfSave(); renderChallengeFloat(); };
    $('#float-tray').append(chfPillEl);
  }
  return chfPillEl;
}

(() => {
  const win = $('#ch-float');
  const close = $('#ch-float-close');
  close.onclick = () => { chf.pos.hidden = true; chfSave(); renderChallengeFloat(); };
  close.addEventListener('pointerdown', (e) => e.stopPropagation());
  const head = $('#ch-float-head');
  const toggle = $('#ch-float-fold');
  const fold = () => { chf.pos.folded = !chf.pos.folded; chfSave(); renderChallengeFloat(); };
  toggle.onclick = fold;
  toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
  head.addEventListener('dblclick', (e) => { if (e.target !== toggle && e.target !== close) fold(); });
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    try { head.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    win.classList.add('dragging');
    const move = (ev) => { chf.pos.x = ev.clientX - dx; chf.pos.y = ev.clientY - dy; chfPlace(); };
    const up = () => {
      try { head.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      win.classList.remove('dragging');
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      chf.pos.x = parseFloat(win.style.left);
      chf.pos.y = parseFloat(win.style.top);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  window.addEventListener('resize', chfPlace);
  // The AI panel opening or closing moves the corner.
  const ai = $('#ai-panel');
  if (ai) new MutationObserver(chfPlace).observe(ai, { attributes: true, attributeFilter: ['class'] });
})();
