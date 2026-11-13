'use strict';
// The opening explorer, as on Lichess: for the position on the board, the
// moves played from it in the Masters or Lichess databases (through the
// Lichess API) or in Ponder's own opening book (offline), with results.
// Clicking a move plays it on the board. Loaded after renderer.js.

const ex = {
  db: localStorage.getItem('explorerDb') || 'masters',
  speeds: JSON.parse(localStorage.getItem('explorerSpeeds') || '["blitz","rapid","classical"]'),
  ratings: JSON.parse(localStorage.getItem('explorerRatings') || '[1800,2000,2200,2500]'),
  shownFor: '',
  request: 0,
  timer: null,
};
const EX_SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
const EX_RATINGS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

const explorerVisible = () => !$('#pane-explorer').hidden;

// Follows the board while the tab is open (called by renderBoard).
function explorerFollow() {
  if (!explorerVisible() || !state) return;
  const key = `${ex.db}|${shownFen()}|${ex.speeds}|${ex.ratings}`;
  if (key === ex.shownFor) return;
  clearTimeout(ex.timer);
  ex.timer = setTimeout(renderExplorer, 120);
}

function setExplorerDb(db) {
  ex.db = db;
  localStorage.setItem('explorerDb', db);
  ex.shownFor = '';
  renderExplorer();
}
for (const b of document.querySelectorAll('#ex-db button')) b.onclick = () => setExplorerDb(b.dataset.db);

function renderExplorerFilters() {
  const toggle = (list, value, key) => {
    const i = list.indexOf(value);
    if (i >= 0) { if (list.length > 1) list.splice(i, 1); } else list.push(value);
    localStorage.setItem(key, JSON.stringify(list));
    ex.shownFor = '';
    renderExplorer();
  };
  $('#ex-speeds').replaceChildren(...EX_SPEEDS.map((sp) => {
    const b = el('button', { type: 'button', className: 'chip' + (ex.speeds.includes(sp) ? ' on' : ''), textContent: sp.replace('ultraBullet', 'ultra') });
    b.onclick = () => toggle(ex.speeds, sp, 'explorerSpeeds');
    return b;
  }));
  $('#ex-ratings').replaceChildren(...EX_RATINGS.map((r) => {
    const b = el('button', { type: 'button', className: 'chip' + (ex.ratings.includes(r) ? ' on' : ''), textContent: r === 0 ? '<1000' : String(r) });
    b.onclick = () => toggle(ex.ratings, r, 'explorerRatings');
    return b;
  }));
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

function exMessage(text, actions = []) {
  const box = $('#ex-msg');
  box.hidden = !text;
  box.replaceChildren(text ?? '', ...actions);
}

// Plays a move from the explorer: in the game if it is your turn, or as a
// variation when exploring.
function playUci(uci) {
  if (!state || puzzleView) return;
  if (exploring()) { explore(uci); return; }
  if (state.humanToMove && isLive()) {
    api.backend('move', { uci }).catch((err) => setStatus(errorText(err)));
  } else {
    setStatus('You can play explorer moves on your turn, or after the game.');
  }
}

async function renderExplorer() {
  if (!state || !explorerVisible()) return;
  for (const b of document.querySelectorAll('#ex-db button')) b.classList.toggle('on', b.dataset.db === ex.db);
  $('#ex-filters').hidden = ex.db !== 'lichess';
  if (ex.db === 'lichess') renderExplorerFilters();
  // No outside help in your own Lichess game.
  const locked = state.external?.kind === 'play' && state.external.live;
  $('#ex-locked').hidden = !locked;
  for (const id of ['#ex-moves', '#ex-games', '#ex-opening']) $(id).hidden = locked;
  if (locked) { ex.shownFor = ''; return; }
  const fen = shownFen();
  const key = `${ex.db}|${fen}|${ex.speeds}|${ex.ratings}`;
  ex.shownFor = key;
  const req = ++ex.request;
  $('#ex-body').classList.add('loading');
  let data;
  try {
    if (ex.db === 'book') {
      const moves = await api.backend('bookMoves', { fen });
      data = { book: true, moves };
    } else {
      data = await api.lichess.explorer(ex.db, fen, { speeds: ex.speeds, ratings: ex.ratings });
    }
  } catch (err) {
    if (req !== ex.request) return;
    $('#ex-body').classList.remove('loading');
    $('#ex-moves').replaceChildren();
    $('#ex-games').replaceChildren();
    $('#ex-opening').textContent = '';
    const useBook = el('button', { type: 'button', className: 'link', textContent: 'Use the built-in book' });
    useBook.onclick = () => setExplorerDb('book');
    const settings = el('button', { type: 'button', className: 'link', textContent: 'Settings → Lichess' });
    settings.onclick = () => openSettings('lichess');
    exMessage(`${errorText(err)} `, [useBook, ' · ', settings]);
    return;
  }
  if (req !== ex.request) return;
  $('#ex-body').classList.remove('loading');
  if (data.book) renderBookMoves(data.moves);
  else renderDbMoves(data);
}

function moveRow(cells, uci, title) {
  const tr = el('tr', { className: 'ex-row', title: title ?? '' }, cells);
  tr.onclick = () => playUci(uci);
  // Hovering a move shows it as an arrow on the board.
  tr.onmouseenter = () => { exHover = uci; renderExplorerArrow(); };
  tr.onmouseleave = () => { exHover = null; renderExplorerArrow(); };
  return tr;
}

let exHover = null;
function renderExplorerArrow() {
  const arrow = $('#explorer-arrow');
  if (!arrow) return;
  if (!exHover) { arrow.setAttribute('visibility', 'hidden'); return; }
  const [x1, y1] = squareCenter(exHover.slice(0, 2));
  const [x2, y2] = squareCenter(exHover.slice(2, 4));
  const len = Math.hypot(x2 - x1, y2 - y1);
  const k = (len - 0.3) / len;
  arrow.setAttribute('x1', x1); arrow.setAttribute('y1', y1);
  arrow.setAttribute('x2', x1 + (x2 - x1) * k); arrow.setAttribute('y2', y1 + (y2 - y1) * k);
  arrow.setAttribute('visibility', 'visible');
}

function resultBar(w, d, b) {
  const total = w + d + b || 1;
  const seg = (cls, n) => {
    const pct = (n / total) * 100;
    return el('span', { className: `ex-seg ${cls}`, style: `width:${pct}%`, textContent: pct >= 12 ? `${Math.round(pct)}%` : '' });
  };
  return el('div', { className: 'ex-bar', title: `White wins ${Math.round((w / total) * 100)}% · draws ${Math.round((d / total) * 100)}% · Black wins ${Math.round((b / total) * 100)}%` },
    [seg('w', w), seg('d', d), seg('b', b)]);
}

function renderDbMoves(data) {
  $('#ex-opening').textContent = data.opening ? `${data.opening.eco} ${data.opening.name}` : '';
  $('#ex-opening').dataset.opening = $('#ex-opening').textContent;
  const total = data.white + data.draws + data.black;
  if (!data.moves?.length) {
    $('#ex-moves').replaceChildren();
    exMessage(total ? '' : 'No games from this position in this database.');
  } else {
    exMessage('');
    const rows = data.moves.map((m) => {
      const n = m.white + m.draws + m.black;
      return moveRow([
        el('td', { className: 'ex-san', textContent: m.san }),
        el('td', { className: 'ex-n', textContent: `${Math.round((n / (total || 1)) * 100)}%` }),
        el('td', { className: 'ex-n', textContent: compact(n) }),
        el('td', { className: 'ex-res' }, [resultBar(m.white, m.draws, m.black)]),
      ], m.uci, `${m.san}: ${n.toLocaleString()} games, average rating ${m.averageRating ?? '–'}${m.opening ? ' · ' + m.opening.eco + ' ' + m.opening.name : ''}`);
    });
    const sum = el('tr', { className: 'ex-total' }, [
      el('td', { textContent: 'Σ' }), el('td', { className: 'ex-n', textContent: '100%' }),
      el('td', { className: 'ex-n', textContent: compact(total) }), el('td', { className: 'ex-res' }, [resultBar(data.white, data.draws, data.black)]),
    ]);
    $('#ex-moves').replaceChildren(el('thead', {}, [el('tr', {}, ['Move', '', 'Games', 'White / Draw / Black'].map((t) => el('th', { textContent: t })))]),
      el('tbody', {}, [...rows, sum]));
  }
  const games = [...(data.topGames ?? []).map((g) => ({ ...g, kind: 'Top games' })), ...(data.recentGames ?? []).map((g) => ({ ...g, kind: 'Recent games' }))];
  const groups = [];
  for (const kind of ['Top games', 'Recent games']) {
    const list = games.filter((g) => g.kind === kind);
    if (!list.length) continue;
    groups.push(el('h4', { textContent: kind }));
    for (const g of list) {
      const res = g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½';
      const row = el('button', { type: 'button', className: 'ex-game', title: 'Open this game on the board' }, [
        el('span', { className: 'ex-rating', textContent: `${g.white.rating ?? ''}\n${g.black.rating ?? ''}` }),
        el('span', { className: 'ex-names', textContent: `${g.white.name}\n${g.black.name}` }),
        el('span', { className: `ex-result ${g.winner ?? 'draw'}`, textContent: res }),
        el('span', { className: 'ex-year', textContent: g.year ?? g.month ?? '' }),
      ]);
      row.onclick = () => openExplorerGame(ex.db, g);
      groups.push(row);
    }
  }
  $('#ex-games').replaceChildren(...groups);
}

function renderBookMoves(moves) {
  $('#ex-opening').textContent = $('#opening .name').textContent ? `${$('#opening .eco').textContent} ${$('#opening .name').textContent}` : '';
  $('#ex-opening').dataset.opening = $('#ex-opening').textContent.trim();
  $('#ex-games').replaceChildren();
  if (!moves.length) {
    $('#ex-moves').replaceChildren();
    exMessage('The built-in book has no moves from this position.');
    return;
  }
  exMessage('');
  const total = moves.reduce((a, m) => a + m.lines, 0);
  $('#ex-moves').replaceChildren(
    el('thead', {}, [el('tr', {}, ['Move', 'Book lines', 'Opening'].map((t) => el('th', { textContent: t })))]),
    el('tbody', {}, moves.map((m) => moveRow([
      el('td', { className: 'ex-san', textContent: m.san }),
      el('td', { className: 'ex-n', textContent: `${m.lines} (${Math.round((m.lines / total) * 100)}%)` }),
      el('td', { className: 'ex-name', textContent: m.name || (m.leads ? `→ ${m.leads}` : '') }),
    ], m.uci, m.name || m.leads))),
  );
}

async function openExplorerGame(db, g) {
  if (state?.active && !(await confirmDialog('Open this game? The game in progress will be abandoned.', 'Open game'))) return;
  setStatus(`Loading ${g.white.name} – ${g.black.name}…`);
  try {
    const pgn = await api.lichess.gamePgn(db, g.id);
    await api.backend('loadPgnText', { pgn, source: db === 'masters' ? 'Masters database' : 'Lichess' });
    showTab('moves');
  } catch (err) {
    setStatus(`Could not open the game: ${errorText(err)}`);
  }
}
