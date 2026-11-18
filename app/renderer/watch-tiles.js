'use strict';
// Tiles: every game of the player being watched (or of your own engine,
// when it plays several at once) at the same time, each on a board of its
// own with both players, their clocks and how it stands, kept up to date
// move by move. Turned on with Tiles in the row of small boards; it stays
// on (and comes back when several games are going again) until turned off.
// A click on a tile puts that game on the main board and leaves the tiles.

const wt = {
  on: (() => { try { return localStorage.getItem('watchTiles') === 'on'; } catch { return false; } })(),
  games: [],
  timer: null,
};
const saveTiles = () => { try { localStorage.setItem('watchTiles', wt.on ? 'on' : 'off'); } catch { /* not kept */ } };

// The games the row of small boards shows: a watched player's, or else
// your engine's.
// Your engine's finished games keep their tile, with the result, until a
// new game starts (as a watched player's do).
const tileLive = new Set(), tileKept = new Set();
function tileGames() {
  if (lx.watch?.active) return lx.watch.games ?? [];
  const all = lx.status.games ?? [];
  if (all.some((g) => !g.finished && g.fen && !tileLive.has(g.id)) && tileLive.size) tileKept.clear(); // a new game
  for (const g of all) {
    if (!g.fen) continue;
    if (!g.finished) tileLive.add(g.id);
    else if (tileLive.delete(g.id)) tileKept.add(g.id);
  }
  return botStripGames(tileKept);
}

function setWatchTiles(on) {
  wt.on = Boolean(on);
  saveTiles();
  renderWatchTiles();
  renderWatchStrip();
}
window.setWatchTiles = setWatchTiles;

// The clock of one side, counting down while it runs.
function tileClockMs(g, side) {
  const ms = g[side + 'Ms'];
  if (!ms && !g.clockAt) return null;
  const toMove = g.fen?.split(' ')[1] === 'b' ? 'black' : 'white';
  const run = g.running && g.live && toMove === side;
  return Math.max(0, ms - (run ? Date.now() - g.clockAt : 0));
}

function tileBar(g, side) {
  const name = g[side] || (side === 'white' ? 'White' : 'Black');
  const title = g[side + 'Title'];
  const rating = g[side + 'Rating'];
  const clock = el('span', { className: 'wt-clock' });
  clock.dataset.side = side;
  const toMove = g.fen?.split(' ')[1] === 'b' ? 'black' : 'white';
  const winner = g.result === '1-0' ? 'white' : g.result === '0-1' ? 'black' : null;
  return el('div', { className: `wt-bar ${side}` + (g.live && toMove === side ? ' to-move' : '') }, [
    el('span', { className: `dot ${side}` }),
    ...[flagSpan(name)].filter(Boolean),
    ...(title && title !== 'BOT' ? [el('span', { className: 'wt-title', textContent: title })] : []),
    el('span', { className: 'wt-name', textContent: name, title: name }),
    ...(rating ? [el('span', { className: 'wt-rating', textContent: String(rating) })] : []),
    ...(!g.live && g.result && g.result !== '*' ? [el('span', { className: 'wt-pt', textContent: g.result === '1/2-1/2' ? '½' : winner === side ? '1' : '0' })] : []),
    clock,
  ]);
}

function tileFor(g) {
  const flip = g.side === 'black';
  const top = flip ? 'white' : 'black';
  const bottom = flip ? 'black' : 'white';
  const result = { '1-0': '1–0', '0-1': '0–1', '1/2-1/2': '½–½' }[g.result];
  const toMove = g.fen?.split(' ')[1] === 'b' ? 'Black' : 'White';
  const state = g.live
    ? (g.moves ? `Move ${Math.floor((g.moves + 1) / 2)} · ${g.note || toMove + ' to move'}` : 'Starting')
    : [result ?? 'Ended', g.reason?.replace(/^(White|Black) wins /, '').replace(/^Draw\s*/, '')].filter(Boolean).join(' · ');
  const board = el('div', { className: 'wt-board' }, [watchMiniBoard(g)]);
  if (!g.live) board.append(el('span', { className: 'wt-result', textContent: result ?? 'Ended' }));
  const tile = el('button', { type: 'button', className: 'wt-tile' + (g.shown ? ' on' : '') + (g.live ? ' live' : ' over') }, [
    tileBar(g, top),
    board,
    tileBar(g, bottom),
    el('div', { className: 'wt-foot' }, [
      el('span', { className: 'wt-state' + (g.live ? ' live' : ''), textContent: state }),
      el('span', { className: 'wt-kind', textContent: g.shown ? 'On the board' : g.label ?? '' }),
    ]),
  ]);
  tile.dataset.id = g.id;
  tile.title = `${g.white} – ${g.black}` + (g.label ? ` · ${g.label}` : '') + ': click to put it on the main board';
  tile.onclick = () => {
    setWatchTiles(false);
    if (!g.shown) watchPick(g.id, g.bot);
  };
  return tile;
}

// The size of the boards: as large as lets every tile fit in the view.
function layoutTiles() {
  const grid = $('#wt-grid');
  const n = wt.games.length;
  if (!n) return;
  const w = grid.clientWidth, h = grid.clientHeight;
  const gap = 12;
  const extra = 92; // the two name bars and the line under the board
  let best = 0, bestCols = 1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const side = Math.min((w - gap * (cols - 1)) / cols - 20, (h - gap * (rows - 1)) / rows - extra);
    if (side > best) { best = side; bestCols = cols; }
  }
  grid.style.setProperty('--wt-cols', bestCols);
  grid.style.setProperty('--wt-board', `${Math.max(140, Math.floor(best))}px`);
}

function tickTileClocks() {
  for (const tile of document.querySelectorAll('#wt-grid .wt-tile')) {
    const g = wt.games.find((x) => x.id === tile.dataset.id);
    if (!g) continue;
    const toMove = g.fen?.split(' ')[1] === 'b' ? 'black' : 'white';
    for (const clock of tile.querySelectorAll('.wt-clock')) {
      const ms = tileClockMs(g, clock.dataset.side);
      clock.textContent = ms == null ? '' : formatClock(ms);
      const running = g.live && g.running && toMove === clock.dataset.side;
      clock.classList.toggle('running', running);
      clock.classList.toggle('low', running && ms != null && ms < 20000);
    }
  }
}

function renderWatchTiles() {
  const games = tileGames();
  const box = $('#watch-tiles');
  const show = wt.on && games.length >= 2;
  box.hidden = !show;
  document.body.classList.toggle('watch-tiles-on', show);
  clearInterval(wt.timer);
  wt.timer = null;
  if (!show) { wt.games = []; $('#wt-grid').replaceChildren(); return; }
  wt.games = games;
  const live = games.filter((g) => g.live).length;
  const who = lx.watch?.active ? lx.watch.user : (lx.status.account?.username || 'Your engine');
  $('#wt-head').replaceChildren(...withFlag(`${who} · ${games.length} games` + (live !== games.length ? `, ${live} going` : ''), lx.watch?.active ? who : ''));
  $('#wt-grid').replaceChildren(...games.map(tileFor));
  layoutTiles();
  tickTileClocks();
  if (games.some((g) => g.live && g.running)) wt.timer = setInterval(tickTileClocks, 200);
}
window.renderWatchTiles = renderWatchTiles;
window.tilesShown = () => !$('#watch-tiles').hidden;

$('#wt-close').onclick = () => setWatchTiles(false);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#watch-tiles').hidden && !document.querySelector('dialog[open]')) setWatchTiles(false);
});
new ResizeObserver(() => { if (!$('#watch-tiles').hidden) layoutTiles(); }).observe($('#watch-tiles'));
