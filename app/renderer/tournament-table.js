'use strict';
// Tournaments of more than two engines: the table, a chart of the points as
// the games went by, the matches and the head-to-head records.
// Loaded after tournament.js, whose helpers (fmt, signed, …) it uses.

const TN_FORMATS = {
  match: 'Match', roundrobin: 'Round robin', gauntlet: 'Gauntlet', knockout: 'Knockout', swiss: 'Swiss',
};
const TN_SERIES = 8; // engines with a colour of their own; the rest share grey

// An engine's colour follows the engine (its place in the list given), not
// its rank, so it keeps it as the table changes.
const tnSeries = (index) => (index < TN_SERIES ? `s${index + 1}` : 'other');

// 3 → "3", 2.5 → "2½", 0.5 → "½"
function tnPoints(p) {
  const whole = Math.floor(p + 1e-9);
  return p - whole >= 0.5 ? (whole ? `${whole}½` : '½') : String(whole);
}

function tnSvg(tag, attrs = {}, kids = []) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
}

const tnSwatch = (index) => el('i', { className: `tn-swatch ${tnSeries(index)}` });

// A bar of parts side by side, each [share, class, title]; empty parts are
// left out.
function tnBar(parts, label) {
  const total = parts.reduce((a, [n]) => a + n, 0);
  const bar = el('span', { className: 'tn-bar', role: 'img', ariaLabel: label, title: label });
  for (const [n, cls, title] of parts) {
    if (!(n > 0)) continue;
    const seg = el('span', { className: `seg ${cls}`, title: title ?? label });
    seg.style.flexGrow = String(n);
    bar.append(seg);
  }
  if (!total) bar.classList.add('empty');
  return bar;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------
function tnStandings(s) {
  const sb = s.format !== 'knockout';
  const head = ['', 'Engine', 'Games', 'Won · drawn · lost', 'Points', 'Score', ...(sb ? ['S-B'] : []), 'Elo'];
  const titles = {
    'S-B': 'Sonneborn–Berger: the points scored against each engine, times that engine\'s points. Splits ties on points.',
    Elo: 'The rating difference its score stands for, against the engines it met',
  };
  const table = el('table', { className: 'tn-table' }, [
    el('thead', {}, [el('tr', {}, head.map((h) => el('th', { textContent: h, title: titles[h] ?? '', className: ['Games', 'Points', 'Score', 'S-B', 'Elo'].includes(h) ? 'n' : '' })))]),
  ]);
  const body = el('tbody');
  for (const p of s.players) {
    const wdl = `${p.wins} won, ${p.draws} drawn, ${p.losses} lost`;
    const name = el('td', { className: 'tn-name' }, [tnSwatch(p.index), el('span', { textContent: p.name, title: p.name })]);
    if (p.out) name.append(el('span', { className: 'tn-tag', textContent: 'out' }));
    if (p.bye) name.append(el('span', { className: 'tn-tag', textContent: `bye +${tnPoints(p.bye)}`, title: 'Points for rounds it sat out' }));
    const flaws = [p.timeLosses ? `${p.timeLosses} lost on time` : '', p.crashes ? `${p.crashes} crashed` : ''].filter(Boolean).join(', ');
    if (flaws) name.append(el('span', { className: 'tn-tag bad', textContent: flaws }));
    const row = el('tr', { className: p.out ? 'out' : '' }, [
      el('td', { className: 'n rank', textContent: String(p.rank) }),
      name,
      el('td', { className: 'n', textContent: String(p.games) }),
      el('td', { className: 'tn-wdl' }, [
        tnBar([[p.wins, 'win', `${p.wins} won`], [p.draws, 'draw', `${p.draws} drawn`], [p.losses, 'loss', `${p.losses} lost`]], `${p.name}: ${wdl}`),
        el('span', { className: 'tn-wdl-n', textContent: `${p.wins} · ${p.draws} · ${p.losses}` }),
      ]),
      el('td', { className: 'n pts', textContent: tnPoints(p.points) }),
      el('td', { className: 'n', textContent: p.games ? `${fmt(p.score * 100, 0)}%` : '–' }),
      ...(sb ? [el('td', { className: 'n', textContent: p.games ? fmt(p.sb, 2).replace(/\.?0+$/, '') : '–' })] : []),
      el('td', { className: 'n', textContent: p.games ? signed(p.elo, 0) : '–' }),
    ]);
    body.append(row);
  }
  table.append(body);
  return table;
}

// ---------------------------------------------------------------------------
// Points as the games went by: a line for each engine
// ---------------------------------------------------------------------------
function tnProgressChart(s) {
  const wrap = el('div', { className: 'tn-chart' });
  const games = s.progress?.games ?? [];
  if (!games.length) {
    wrap.append(el('p', { className: 'hint', textContent: 'The chart starts with the first finished game.' }));
    return wrap;
  }
  const names = [];
  for (const p of s.players) names[p.index] = p.name;
  const series = s.progress.points.map((pts, index) => ({ index, name: names[index] ?? `Engine ${index + 1}`, pts }));
  // The legend: every engine, in the order given (as the colours are).
  wrap.append(el('div', { className: 'tn-legend' }, series.map((e) => el('span', { className: 'key' }, [tnSwatch(e.index), e.name]))));

  const W = 640, H = 230, L = 34, R = series.length <= 4 ? 110 : 14, T = 10, B = 26;
  const xMax = Math.max(1, games.at(-1));
  const yMax = Math.max(1, ...series.map((e) => e.pts.at(-1) ?? 0));
  const x = (g) => L + (g / xMax) * (W - L - R);
  const y = (p) => T + (1 - p / yMax) * (H - T - B);
  const svg = tnSvg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tn-svg', role: 'img', 'aria-label': `Points of ${series.map((e) => e.name).join(', ')} after each game` });
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((k) => yMax / k <= 5) ?? 2000;
  for (let p = 0; p <= yMax + 1e-9; p += step) {
    svg.append(tnSvg('line', { x1: L, x2: W - R, y1: y(p), y2: y(p), class: p ? 'grid' : 'axis' }));
    const t = tnSvg('text', { x: L - 6, y: y(p) + 3.5, class: 'tick', 'text-anchor': 'end' }); t.textContent = p; svg.append(t);
  }
  for (let i = 0; i <= 4; i++) {
    const g = Math.round((xMax * i) / 4);
    const t = tnSvg('text', { x: x(g), y: H - 8, class: 'tick', 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' });
    t.textContent = i === 4 ? `${g} games` : g;
    svg.append(t);
  }
  // Grey lines first, so the coloured ones lie over them.
  const ordered = [...series].sort((a, b) => (a.index < TN_SERIES) - (b.index < TN_SERIES) || b.index - a.index);
  for (const e of ordered) {
    const d = `M${x(0).toFixed(1)},${y(0).toFixed(1)}` + e.pts.map((p, k) => `L${x(games[k]).toFixed(1)},${y(p).toFixed(1)}`).join('');
    svg.append(tnSvg('path', { d, class: `series ${tnSeries(e.index)}` }));
  }
  for (const e of ordered) svg.append(tnSvg('circle', { cx: x(xMax), cy: y(e.pts.at(-1)), r: 4, class: `end ${tnSeries(e.index)}` }));
  // A few engines: each line named at its end, kept apart from the others.
  if (series.length <= 4) {
    const ends = series.map((e) => ({ e, at: y(e.pts.at(-1)) })).sort((a, b) => a.at - b.at);
    for (let i = 1; i < ends.length; i++) ends[i].at = Math.max(ends[i].at, ends[i - 1].at + 13);
    const over = ends.length ? ends.at(-1).at - (H - B) : 0;
    if (over > 0) for (const end of ends) end.at -= over;
    for (const { e, at } of ends) {
      const t = tnSvg('text', { x: x(xMax) + 9, y: at + 3.5, class: 'label' });
      t.textContent = e.name.length > 16 ? e.name.slice(0, 15) + '…' : e.name;
      svg.append(t);
    }
  }
  // Hover: a line at the game pointed at, a dot on each engine's line, and
  // the points there, most first.
  const cross = tnSvg('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
  const dots = series.map((e) => tnSvg('circle', { r: 4, class: `end ${tnSeries(e.index)}`, visibility: 'hidden' }));
  const hit = tnSvg('rect', { x: L, y: T, width: W - L - R, height: H - T - B, class: 'hit' });
  svg.append(cross, ...dots, hit);
  const tip = el('div', { className: 'pl-tip tn-tip', hidden: true });
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const g = (((ev.clientX - box.left) / box.width) * W - L) / (W - L - R) * xMax;
    let k = 0;
    for (let i = 1; i < games.length; i++) if (Math.abs(games[i] - g) < Math.abs(games[k] - g)) k = i;
    cross.setAttribute('x1', x(games[k])); cross.setAttribute('x2', x(games[k])); cross.setAttribute('visibility', 'visible');
    series.forEach((e, i) => { dots[i].setAttribute('cx', x(games[k])); dots[i].setAttribute('cy', y(e.pts[k])); dots[i].setAttribute('visibility', 'visible'); });
    const rows = [...series].sort((a, b) => b.pts[k] - a.pts[k]).map((e) => el('div', { className: 'row' }, [tnSwatch(e.index), `${e.name} `, el('b', { textContent: tnPoints(e.pts[k]) })]));
    tip.replaceChildren(el('div', { className: 'date', textContent: `After ${games[k]} game${games[k] === 1 ? '' : 's'}` }), ...rows);
    tip.hidden = false;
    const left = ev.clientX - box.left;
    tip.style.left = `${left + 14 + tip.offsetWidth > box.width ? Math.max(0, left - 14 - tip.offsetWidth) : left + 14}px`;
    tip.style.top = `${Math.max(0, Math.min(ev.clientY - box.top - 10, box.height - tip.offsetHeight))}px`;
  });
  hit.addEventListener('pointerleave', () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
  });
  wrap.append(el('div', { className: 'pl-svg-wrap' }, [svg, tip]));
  return wrap;
}

// ---------------------------------------------------------------------------
// The matches: who met whom, and how it went
// ---------------------------------------------------------------------------
function tnRoundName(s, round, ties) {
  if (s.format !== 'knockout') return `Round ${round}`;
  return ties === 1 ? 'Final' : ties === 2 ? 'Semi-finals' : ties === 4 ? 'Quarter-finals' : `Round of ${ties * 2}`;
}

// One meeting of two engines: the names, the score, and a bar of how the
// points (or the games) were shared.
function tnMatchRow(a, b, scoreA, scoreB, bar, opts = {}) {
  const side = (e, won, right) => el('span', { className: `tn-side${right ? ' right' : ''}${won ? ' won' : ''}`, title: e.name }, right
    ? [el('span', { className: 'nm', textContent: e.name }), tnSwatch(e.index)]
    : [tnSwatch(e.index), el('span', { className: 'nm', textContent: e.name })]);
  return el('div', { className: `tn-match${opts.live ? ' live' : ''}` }, [
    side(a, opts.winner === a.index, true),
    el('span', { className: 'tn-score', textContent: scoreA }),
    bar,
    el('span', { className: 'tn-score', textContent: scoreB }),
    side(b, opts.winner === b.index, false),
    el('span', { className: 'tn-note', textContent: opts.note ?? '' }),
  ]);
}

function tnMatches(s) {
  const box = el('div', { className: 'tn-matches' });
  const byIndex = [];
  for (const p of s.players) byIndex[p.index] = p;
  if (s.format === 'knockout' || s.format === 'swiss') {
    s.bracket.forEach((ties, r) => {
      box.append(el('h5', { textContent: tnRoundName(s, r + 1, ties.length) }));
      for (const tie of ties) {
        const a = byIndex[tie.a], b = byIndex[tie.b];
        if (!a || !b) {
          const only = a ?? b;
          if (only) box.append(el('div', { className: 'tn-match bye' }, [el('span', { className: 'tn-side right won' }, [el('span', { className: 'nm', textContent: only.name }), tnSwatch(only.index)]), el('span', { className: 'tn-note', textContent: s.format === 'swiss' ? 'sits the round out' : 'goes through without playing' })]));
          continue;
        }
        const label = `${a.name} ${tnPoints(tie.pointsA)}, ${b.name} ${tnPoints(tie.pointsB)}`;
        const bar = tnBar([[tie.pointsA, tnSeries(a.index), `${a.name}: ${tnPoints(tie.pointsA)}`], [tie.pointsB, tnSeries(b.index), `${b.name}: ${tnPoints(tie.pointsB)}`]], label);
        box.append(tnMatchRow(a, b, tnPoints(tie.pointsA), tnPoints(tie.pointsB), bar, {
          winner: tie.done ? tie.winner : -1, live: !tie.done,
          note: tie.note || (tie.done ? (tie.winner < 0 ? 'level' : '') : tie.games ? 'playing' : 'to play'),
        }));
      }
    });
    return box;
  }
  // Round robin, gauntlet: every pair that has met, in the order given.
  const n = s.cross.length;
  let any = false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = s.cross[i][j];
      const played = c.wins + c.draws + c.losses;
      if (!played || !byIndex[i] || !byIndex[j]) continue;
      any = true;
      const a = byIndex[i], b = byIndex[j];
      const pa = c.wins + c.draws / 2, pb = c.losses + c.draws / 2;
      const label = `${a.name} won ${c.wins}, ${c.draws} drawn, ${b.name} won ${c.losses}`;
      const bar = tnBar([[c.wins, tnSeries(i), `${a.name} won ${c.wins}`], [c.draws, 'draw', `${c.draws} drawn`], [c.losses, tnSeries(j), `${b.name} won ${c.losses}`]], label);
      box.append(tnMatchRow(a, b, tnPoints(pa), tnPoints(pb), bar, { winner: pa > pb ? i : pb > pa ? j : -1, note: `${played} game${played === 1 ? '' : 's'}` }));
    }
  }
  if (!any) box.append(el('p', { className: 'hint', textContent: 'No match has a finished game yet.' }));
  return box;
}

// ---------------------------------------------------------------------------
// Head to head: each engine's points against each other
// ---------------------------------------------------------------------------
function tnCross(s) {
  const order = s.players;
  const table = el('table', { className: 'tn-cross' });
  table.append(el('thead', {}, [el('tr', {}, [el('th'), ...order.map((p) => el('th', { className: 'n', title: p.name }, [tnSwatch(p.index), String(p.rank)]))])]));
  const body = el('tbody');
  for (const p of order) {
    const row = el('tr', {}, [el('th', { className: 'tn-name', title: p.name }, [el('span', { className: 'rank', textContent: String(p.rank) }), tnSwatch(p.index), el('span', { textContent: p.name })])]);
    for (const q of order) {
      if (p.index === q.index) { row.append(el('td', { className: 'self' })); continue; }
      const c = s.cross[p.index][q.index];
      const played = c.wins + c.draws + c.losses;
      const cell = el('td', { className: 'n' });
      if (played) {
        const pts = c.wins + c.draws / 2;
        const lead = pts / played - 0.5; // −½ … +½
        cell.textContent = tnPoints(pts);
        cell.append(el('small', { textContent: `/${played}` }));
        cell.classList.add(lead > 0 ? 'ahead' : lead < 0 ? 'behind' : 'level');
        cell.style.setProperty('--lead', String(Math.round(Math.abs(lead) * 2 * 100)));
        cell.title = `${p.name} against ${q.name}: won ${c.wins}, drew ${c.draws}, lost ${c.losses}`;
      } else {
        cell.textContent = '·';
        cell.classList.add('none');
        cell.title = `${p.name} and ${q.name} have not met`;
      }
      row.append(cell);
    }
    body.append(row);
  }
  table.append(body);
  return el('div', { className: 'tn-cross-wrap' }, [table]);
}

// Draws the results of a tournament of several engines. The charts are
// only rebuilt when a game has finished, so pointing at them is not undone
// by the status arriving a few times a second.
function renderTournamentTable(s) {
  const key = `${s.format}|${s.games}|${s.state}|${s.round}|${JSON.stringify(s.bracket?.map((r) => r.map((t) => [t.done, t.games])))}|${document.documentElement.dataset.theme}`;
  if (renderTournamentTable.key === key) return;
  renderTournamentTable.key = key;
  $('#tn-standings').replaceChildren(tnStandings(s));
  $('#tn-progress-chart').replaceChildren(tnProgressChart(s));
  $('#tn-matches').replaceChildren(tnMatches(s));
  $('#tn-cross').replaceChildren(tnCross(s));
  $('#tn-matches-title').textContent = s.format === 'knockout' ? 'Bracket' : s.format === 'swiss' ? 'Rounds' : 'Matches';
}
