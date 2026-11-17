'use strict';
// Country flags beside Lichess players' names. Lichess keeps each player's
// flag in their profile ("US", "GB-SCT", "_rainbow"…); Ponder asks for the
// names it shows, many at a time, and keeps the answers for the session.
// flagSpan(username) is the flag to put beside a name, or null when the
// player has none. While it is being looked up it is an empty placeholder,
// filled in when the answer comes (the views are also drawn again).

const flags = { known: new Map(), want: new Set(), timer: null };

const FLAG_SPECIAL = {
  _rainbow: ['🏳️‍🌈', 'Rainbow flag'], _pirate: ['🏴‍☠️', 'Pirate flag'], _transgender: ['🏳️‍⚧️', 'Transgender flag'],
  _earth: ['🌍', 'Earth'], '_united-nations': ['🇺🇳', 'United Nations'],
};
const FLAG_UK = { 'GB-ENG': 'England', 'GB-SCT': 'Scotland', 'GB-WLS': 'Wales' };
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();

// The emoji for a Lichess flag code: a country's two letters, England,
// Scotland and Wales, a few special flags; a region elsewhere has its
// country's flag. '' for none.
function flagEmoji(code) {
  if (!code) return '';
  if (FLAG_SPECIAL[code]) return FLAG_SPECIAL[code][0];
  if (FLAG_UK[code]) {
    const tag = code.replace('-', '').toLowerCase();
    return '\u{1F3F4}' + [...tag].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') + '\u{E007F}';
  }
  const cc = code.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(cc) || (code.length > 2 && code[2] !== '-')) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function flagName(code) {
  if (FLAG_SPECIAL[code]) return FLAG_SPECIAL[code][1];
  if (FLAG_UK[code]) return FLAG_UK[code];
  try { return regionNames?.of(code.slice(0, 2)) ?? code; } catch { return code; }
}

// A player's flag code: '' for none, null while it is being looked up.
function flagFor(user) {
  const id = String(user ?? '').trim().toLowerCase();
  if (!id || /[\s,]/.test(id)) return '';
  if (flags.known.has(id)) return flags.known.get(id);
  flags.want.add(id);
  flags.timer ??= setTimeout(fetchFlags, 60); // the names shown at once go together
  return null;
}

// A flag already known from a profile Ponder has read.
function noteFlag(user, code) {
  const id = String(user ?? '').trim().toLowerCase();
  if (id) flags.known.set(id, code ?? '');
}

async function fetchFlags() {
  flags.timer = null;
  const ids = [...flags.want].filter((id) => !flags.known.has(id));
  flags.want.clear();
  if (!ids.length) return;
  for (const id of ids) flags.known.set(id, ''); // asked once a session
  const baseUrl = (typeof lx !== 'undefined' && (lx.status?.baseUrl || lx.settings?.baseUrl)) || 'https://lichess.org';
  let got = null;
  try { got = await api.backend('lichessFlags', { baseUrl, ids }); } catch { /* no flags then */ }
  if (!got) return;
  let any = false;
  for (const id of ids) if (got[id]) { flags.known.set(id, got[id]); any = true; }
  fillFlagPlaceholders();
  if (any) redrawFlags();
}

// The placeholders put in while flags were looked up, filled in (or taken
// away for players without one).
function fillFlagPlaceholders() {
  for (const node of document.querySelectorAll('[data-flag-user]')) {
    const code = flags.known.get(node.dataset.flagUser);
    if (code == null) continue;
    const emoji = flagEmoji(code);
    delete node.dataset.flagUser;
    if (!emoji) { node.remove(); continue; }
    node.textContent = emoji;
    node.title = node.ariaLabel = flagName(code);
    node.hidden = false;
  }
}

// A line of text with a player's flag put before their name in it.
function withFlag(text, name) {
  const at = name ? text.indexOf(name) : -1;
  const flag = at < 0 ? null : flagSpan(name);
  if (!flag) return [text];
  return [text.slice(0, at), flag, text.slice(at)];
}

// The views that show names, drawn again with the flags in.
function redrawFlags() {
  const calls = [
    () => renderPlayers(), () => renderGameInfo(), () => window.renderWatchStrip?.(), () => window.renderLichess?.(),
    () => window.renderMe?.(), () => window.updateVersus?.(), () => window.updateKo?.(),
    () => { if (!$('#match-history').hidden) window.renderMatchHistory?.(); },
    () => { if (!$('#ch-float').hidden) window.renderChallengeFloat?.(); },
    () => window.renderChat?.(), () => window.renderLichessTV?.(), () => window.renderLichessWatch?.(),
  ];
  for (const f of calls) { try { f(); } catch { /* that view is not there */ } }
}

function flagSpan(user, className = 'cflag') {
  const code = flagFor(user);
  if (code === null) {
    const span = el('span', { className, hidden: true });
    span.dataset.flagUser = String(user).trim().toLowerCase();
    return span;
  }
  const emoji = flagEmoji(code);
  if (!emoji) return null;
  return el('span', { className, textContent: emoji, title: flagName(code), ariaLabel: flagName(code) });
}
