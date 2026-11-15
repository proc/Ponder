'use strict';
// Match history: while your engine plays on Lichess, a floating window lists
// its finished games, newest first: a small picture of the final position,
// the opponent, won / lost / drawn and how, the length and the clock. The
// tally of wins, draws and losses heads it. Games are kept on this computer
// (the last MH_MAX) so the history outlasts a restart. A click puts the game
// on the board while Ponder still has it, otherwise opens it on Lichess.

const MH_MAX = 60;
const mh = {
  games: (() => { try { return JSON.parse(localStorage.getItem('matchHistory')) || []; } catch { return []; } })(),
};
const MH_HOW = {
  mate: 'Checkmate', resign: 'Resignation', outoftime: 'On time', timeout: 'Opponent left', stalemate: 'Stalemate',
  draw: 'Draw', variantEnd: 'Game ended', cheat: 'Cheat detected', noStart: 'No start',
};

function mhSave() {
  try { localStorage.setItem('matchHistory', JSON.stringify(mh.games)); } catch { /* not kept */ }
}

// From your engine's side: 'win', 'loss' or 'draw'.
function mhOutcome(g) {
  if (g.result === '1/2-1/2') return 'draw';
  return (g.result === '1-0') === (g.color === 'white') ? 'win' : 'loss';
}

// Each status of your engine's connection: games newly finished are added.
function trackMatchHistory(next) {
  let added = false;
  for (const g of next.games ?? []) {
    if (!g.finished || !g.playing || !g.fen || !['1-0', '0-1', '1/2-1/2'].includes(g.result)) continue;
    if (mh.games.some((h) => h.id === g.id)) continue;
    mh.games.unshift({
      id: g.id, url: g.url, opponent: g.opponent, title: g.opponentTitle, rating: g.opponentRating, color: g.color,
      result: g.result, status: g.status, fen: g.fen, lastMove: g.lastMove, moves: g.moves,
      rated: g.rated, speed: g.speed, tc: g.tc, at: Date.now(),
    });
    added = true;
  }
  if (added) {
    mh.games.length = Math.min(mh.games.length, MH_MAX);
    mhSave();
  }
  syncMatchHistory();
}
window.trackMatchHistory = trackMatchHistory;

const mhFloat = floatWindow($('#match-history'), {
  key: 'matchHistoryFloat', name: 'match history', head: $('#mh-head'),
  size: { w: 330, h: 380 },
  // Beside the chat, which opens at the top right; not over the board.
  start: (w) => {
    const board = document.querySelector('.board-wrap')?.getBoundingClientRect();
    return { x: Math.max(board ? board.right + 12 : 0, window.innerWidth - w - 340 - 28), y: 64 };
  },
  pill: () => el('span', { className: 'pill-name', textContent: 'Match history' }),
});

// Shown while your engine plays: one of its games on the board, or one in
// progress.
function matchHistoryWanted() {
  const s = typeof lx !== 'undefined' ? lx.status : null;
  if (!s || (s.state !== 'connected' && s.state !== 'reconnecting')) return false;
  return state?.external?.kind === 'bot' || (s.games ?? []).some((g) => g.playing && !g.finished);
}

let mhWas = false;
function syncMatchHistory() {
  const box = $('#match-history');
  const on = matchHistoryWanted();
  box.hidden = !on;
  mhFloat.set(on);
  // Each time your engine starts playing again it comes back, open.
  if (on && !mhWas) mhFloat.reopen();
  mhWas = on;
  if (on) renderMatchHistory();
}
window.syncMatchHistory = syncMatchHistory;

function mhAgo(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

function renderMatchHistory() {
  const games = mh.games;
  const n = { win: 0, draw: 0, loss: 0 };
  for (const g of games) n[mhOutcome(g)]++;
  $('#mh-tally').replaceChildren(...(games.length ? [
    el('span', { className: 'mh-t win', textContent: `${n.win} W`, title: `${n.win} won` }),
    el('span', { className: 'mh-t draw', textContent: `${n.draw} D`, title: `${n.draw} drawn` }),
    el('span', { className: 'mh-t loss', textContent: `${n.loss} L`, title: `${n.loss} lost` }),
  ] : []));
  const list = $('#mh-list');
  if (!games.length) {
    list.replaceChildren(el('p', { className: 'hint mh-empty', textContent: 'Your engine\'s finished games show here, newest first.' }));
    $('#mh-clear').hidden = true;
    return;
  }
  $('#mh-clear').hidden = false;
  const kept = new Set((lx.status.games ?? []).map((g) => g.id));
  const onBoard = state?.external?.id;
  list.replaceChildren(...games.map((g) => {
    const out = mhOutcome(g);
    const how = MH_HOW[g.status] ?? '';
    const row = el('button', { type: 'button', className: 'mh-row ' + out + (g.id === onBoard ? ' on' : '') }, [
      watchMiniBoard({ fen: g.fen, side: g.color, lastMove: g.lastMove }),
      el('span', { className: 'mh-text' }, [
        el('span', { className: 'mh-line' }, [
          el('span', { className: 'mh-badge ' + out, textContent: { win: 'Won', loss: 'Lost', draw: 'Draw' }[out] }),
          el('span', { className: 'mh-opp' }, ['vs ', ...[flagSpan(g.opponent)].filter(Boolean),
            [g.title === 'BOT' ? '' : g.title, g.opponent].filter(Boolean).join(' ') + (g.rating ? ` (${g.rating})` : '')]),
        ]),
        el('span', { className: 'mh-meta', textContent: [how, g.moves ? `${Math.ceil(g.moves / 2)} moves` : '', g.color === 'white' ? 'as White' : 'as Black'].filter(Boolean).join(' · ') }),
        el('span', { className: 'mh-meta', textContent: [[g.rated ? 'Rated' : 'Casual', g.speed, g.tc].filter(Boolean).join(' '), mhAgo(g.at)].join(' · ') }),
      ]),
    ]);
    row.title = kept.has(g.id) ? 'Show this game on the board' : 'Open this game on Lichess';
    row.onclick = () => {
      if (kept.has(g.id)) lxWatch(g.id);
      else api.openExternal(g.url).catch(() => {});
    };
    return row;
  }));
}

$('#mh-clear').onclick = async () => {
  const ok = await confirmDialog(`Clear the match history (${mh.games.length} game${mh.games.length === 1 ? '' : 's'})? The games themselves stay on Lichess and in your game database.`, 'Clear');
  if (!ok) return;
  mh.games = [];
  mhSave();
  renderMatchHistory();
};
// "5 min ago" moves on.
setInterval(() => { if (!$('#match-history').hidden) renderMatchHistory(); }, 60000);
