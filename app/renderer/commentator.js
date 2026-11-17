'use strict';
// The commentator: a little pixel-art chess piece (Esper, a pawn in a
// headset, unless another is chosen in Settings → AI) floats over the window
// and says the live commentary in a comic-book speech bubble. Its mouth
// moves while a comment is being written or read aloud; it blinks and bobs
// while waiting, hops when there is something new to say and beams at the
// end of a game. Drag it anywhere (the place is kept); a click on it shows
// the last comment again or puts it away. While it is on (as it is unless
// turned off), it takes the place of the commentary card beside the board.

const pip = {
  on: (() => { try { return localStorage.getItem('commentator') !== 'off'; } catch { return true; } })(),
  pos: (() => { try { return JSON.parse(localStorage.getItem('commentatorPos') ?? 'null'); } catch { return null; } })(),
  open: true,      // the bubble is out
  said: null,      // the comment the bubble shows
  doneAt: 0,       // when it was complete
  holdT: null,     // the timer that lets the next comment take its place
  eyes: 'open',    // open, shut, happy
  mouth: 'shut',   // shut, open, smile
  talk: null,      // the timer that moves the mouth
  away: null,      // the timer that puts the bubble away
  blinkT: null,
  who: (() => { try { return localStorage.getItem('commentatorWho') || 'esper'; } catch { return 'esper'; } })(),
};

// --- The cast ----------------------------------------------------------------
// Each character is the left half of each row of its sprite (the right is
// the mirror image), its colours and what goes on after (headset, shine,
// marks). O outline, W body, B collar, F shoes; Y gold, A hair, Q pearl,
// R jewel. The faces go in the same place on all of them.
const PIP_W = 24;
const PIP_H = 28;
// From the collar down, the same for all.
const PIP_BODY = [
  '...OBBBBBBBB',
  '....OBBBBBBB',
  '.....OOWWWWW',
  '.....OWWWWWW',
  '.....OWWWWWW',
  '....OWWWWWWW',
  '...OWWWWWWWW',
  '..OWWWWWWWWW',
  '..OOOOOOOOOO',
  '....OFFFFO..',
  '....OOOOOO..',
];
const PAWN_HEAD = [
  '............', '........OOOO', '......OOWWWW', '.....OWWWWWW', '....OWWWWWWW', '...OWWWWWWWW',
  '...OWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW',
  '...OWWWWWWWW', '...OWWWWWWWW', '....OWWWWWWW', '.....OOWWWWW', '....OOOOOOOO',
];
const PIP_FACE = { E: '#2a1d1f', P: '#f5a3a6', M: '#8a3340', T: '#e9727a', H: '#ffffff', O: '#3a2a2c', K: '#3f4660', k: '#7380a6', R: '#e2574c' };

// A headset over the head, cups over the ears, the mic by the mouth.
function pipHeadset(g, at, set) {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < PIP_W; x++) {
      if (at(x, y) === '.' && [[1, 0], [-1, 0], [0, 1]].some(([dx, dy]) => at(x + dx, y + dy) === 'O')) set(x, y, 'K');
    }
  }
  for (const x0 of [0, 21]) {
    for (let y = 7; y <= 11; y++) for (let x = x0; x < x0 + 3; x++) set(x, y, 'K');
    set(x0 + 1, 8, 'k');
    set(x0 + 1, 9, 'k');
  }
  [[21, 12], [20, 13], [19, 14], [18, 14], [17, 14], [16, 14]].forEach(([x, y]) => set(x, y, 'K'));
  set(15, 14, 'R'); set(14, 14, 'R'); set(14, 13, 'O'); set(15, 13, 'O');
}
// The bow at the front of the collar.
function pipBow(set) {
  [[9, 16], [9, 17], [9, 18], [10, 17], [14, 16], [14, 17], [14, 18], [13, 17]].forEach(([x, y]) => set(x, y, 'B'));
  [[11, 17], [12, 17], [11, 18], [12, 18]].forEach(([x, y]) => set(x, y, 'b'));
  [[10, 16], [13, 16], [10, 18], [13, 18]].forEach(([x, y]) => set(x, y, 'O'));
}
const pipMarks = (set, at, list, c) => list.forEach(([x, y]) => { if ('WSD'.includes(at(x, y))) set(x, y, c); });

const PIP_CAST = {
  esper: {
    name: 'Esper', piece: 'pawn', blurb: 'The announcer: a white pawn in a headset, calling every move.',
    rows: [...PAWN_HEAD, ...PIP_BODY],
    colours: { W: '#fbf4e6', S: '#ead9bd', D: '#cdb593', B: '#4f86d9', b: '#2f5fae', L: '#8fb6f0', F: '#6b4a3a' },
    extra(g, at, set) {
      [[6, 4], [7, 4], [5, 5], [6, 5], [5, 6]].forEach(([x, y]) => set(x, y, 'H'));
      pipBow(set);
      pipHeadset(g, at, set);
    },
  },
  onyx: {
    name: 'Onyx', piece: 'pawn', blurb: 'A black pawn with a gold scarf and a dry wit.',
    rows: [...PAWN_HEAD, ...PIP_BODY],
    colours: { O: '#120f16', W: '#4b4459', S: '#3b3548', D: '#2c2837', H: '#8a82a0', E: '#fff6dc', P: '#d77a9a', M: '#1c1520', T: '#e06a86', B: '#f2b33d', b: '#c98a1c', L: '#ffe08a', F: '#2a2230', K: '#c7cad8', k: '#ffffff', R: '#f2b33d' },
    extra(g, at, set) {
      [[6, 4], [7, 4], [5, 5], [6, 5], [5, 6]].forEach(([x, y]) => set(x, y, 'H'));
      pipBow(set);
      pipHeadset(g, at, set);
    },
  },
  bastion: {
    name: 'Bastion', piece: 'rook', blurb: 'A sturdy rook who loves an open file.',
    rows: [
      '............', '...OOOO.OOOO', '...OWWO.OWWW', '...OWWOOOWWW', '...OWWWWWWWW', '...OWWWWWWWW',
      '...OWWWWWWWW', '...OWWWWWWWW', '...OWWWWWWWW', '...OWWWWWWWW', '...OWWWWWWWW', '...OWWWWWWWW',
      '...OWWWWWWWW', '...OWWWWWWWW', '...OWWWWWWWW', '...OOOOOOOOO', '....OOOOOOOO',
      ...PIP_BODY,
    ],
    colours: { W: '#d7dbe6', S: '#b6bccb', D: '#9097ab', H: '#f2f4f9', B: '#d9534f', b: '#a83a36', L: '#f29490', F: '#4b5263', O: '#2c2f3a' },
    extra(g, at, set) {
      [[4, 4], [5, 4], [4, 5]].forEach(([x, y]) => set(x, y, 'H'));
      pipMarks(set, at, [[6, 6], [7, 6], [8, 6], [14, 5], [15, 5], [16, 5], [9, 14], [10, 14], [11, 14], [16, 15 - 1]], 'S');
      pipBow(set);
    },
  },
  mitzi: {
    name: 'Mitzi', piece: 'bishop', blurb: 'A bishop with a sharp eye for long diagonals.',
    rows: [
      '..........OO', '.........OWW', '........OOWW', '.......OWWWW', '......OWWWWW', '.....OWWWWWW',
      '....OWWWWWWW', '...OWWWWWWWW', '...OWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW',
      '..OWWWWWWWWW', '...OWWWWWWWW', '....OWWWWWWW', '.....OOWWWWW', '....OOOOOOOO',
      ...PIP_BODY,
    ],
    colours: { W: '#f8f2ff', S: '#e3d7f6', D: '#c4b1e4', B: '#8a63d2', b: '#6544a8', L: '#bba0f2', F: '#5a4a7a', O: '#33263f' },
    extra(g, at, set) {
      [[8, 4], [7, 5], [8, 5], [6, 6], [6, 7]].forEach(([x, y]) => set(x, y, 'H'));
      // The slit in the mitre.
      [[13, 3], [14, 4], [15, 5], [16, 6], [17, 7]].forEach(([x, y]) => set(x, y, 'O'));
      pipBow(set);
    },
  },
  rex: {
    name: 'Rex', piece: 'king', blurb: 'The king: grand, a little pompous, never in a hurry.',
    rows: [
      '...........O', '..........OY', '...O.....OYY', '...OYO....OY', '...OYYO..OYY', '...OYYYOOYYY',
      '...ORYYRYYRY', '...OOOOOOOOO', '..OWWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW', '..OWWWWWWWWW',
      '..OWWWWWWWWW', '...OWWWWWWWW', '....OWWWWWWW', '.....OOWWWWW', '....OOOOOOOO',
      ...PIP_BODY,
    ],
    colours: { W: '#fbf1dc', S: '#ecdcbc', D: '#d0b98f', Y: '#f6c443', y: '#d79a22', R: '#e2574c', B: '#c0392b', b: '#8e2a20', L: '#f6e7e4', F: '#5a3d2b' },
    extra(g, at, set) {
      [[5, 9], [6, 8], [7, 8]].forEach(([x, y]) => set(x, y, 'H'));
      pipBow(set);
    },
  },
  regina: {
    name: 'Regina', piece: 'queen', blurb: 'The queen: quick, bold, and fond of a sacrifice.',
    rows: [
      '....OO..OO.O', '...OQQOOQQOQ', '...OYYYYYYYY', '...OYYRYYYYR', '..OAAAAAAAAA', '.OAAAAAAWWWW',
      '.OAAAAWWWWWW', '.OAAAWWWWWWW', '.OAAWWWWWWWW', '.OAAWWWWWWWW', '.OAAWWWWWWWW', '.OAAWWWWWWWW',
      '.OAAWWWWWWWW', '.OAAAWWWWWWW', '.OAAAOWWWWWW', '..OAAAOOWWWW', '..OOOOOOOOOO',
      ...PIP_BODY,
    ],
    colours: { W: '#fdf2ee', S: '#f1dcd4', D: '#dcbcb0', Y: '#f6c443', y: '#d79a22', Q: '#ffffff', R: '#d6457a', A: '#a0527a', a: '#7e3a5e', B: '#d6457a', b: '#a3325c', L: '#f59bbd', F: '#5b2b45', O: '#3a2230' },
    extra(g, at, set) {
      [[6, 5], [7, 5], [5, 6]].forEach(([x, y]) => set(x, y, 'H'));
      pipBow(set);
    },
  },
};
const pipChar = () => PIP_CAST[pip.who] ?? PIP_CAST.esper;

const pipBases = new Map();
function pipBase(id) {
  if (pipBases.has(id)) return pipBases.get(id);
  const ch = PIP_CAST[id];
  const g = ch.rows.map((h) => [...h, ...[...h].reverse()]);
  const at = (x, y) => (g[y]?.[x] ?? '.');
  const set = (x, y, c) => { if (g[y] && x >= 0 && x < PIP_W) g[y][x] = c; };
  // Light from the top left: the right and the bottom of each part darker.
  const shade = { W: ['S', 'D'], Y: ['y', 'y'], A: ['a', 'a'] };
  const src = g.map((r) => [...r]);
  const sat = (x, y) => (src[y]?.[x] ?? '.');
  for (let y = 0; y < PIP_H; y++) {
    for (let x = 0; x < PIP_W; x++) {
      const c = sat(x, y);
      if (!shade[c]) continue;
      const edgeR = sat(x + 1, y) === 'O';
      const nearR = sat(x + 2, y) === 'O';
      const edgeB = sat(x, y + 1) === 'O';
      if (y < 16 && (edgeR || (edgeB && x > 10))) set(x, y, shade[c][1]);
      else if (c === 'W' && (nearR || edgeB || (y < 16 && sat(x + 3, y) === 'O' && y > 9))) set(x, y, shade[c][0]);
    }
  }
  // The collar: its lower edge darker, a light thread along the top.
  for (let x = 0; x < PIP_W; x++) {
    if (at(x, 18) === 'B') set(x, 18, 'b');
    if (at(x, 17) === 'B' && x % 3 === 0) set(x, 17, 'L');
  }
  // Little arms at the sides.
  [[4, 19], [3, 20], [3, 21], [19, 19], [20, 20], [20, 21]].forEach(([x, y]) => set(x, y, 'O'));
  set(4, 20, 'W'); set(4, 21, 'S');
  set(19, 20, 'S'); set(19, 21, 'D');
  ch.extra?.(g, at, set);
  pipBases.set(id, g);
  return g;
}

// A face on the base: eyes open, shut or happy; the mouth shut, open or smiling.
const pipFrames = new Map();
function pipFrame(id, eyes, mouth) {
  const key = `${id}:${eyes}:${mouth}`;
  if (pipFrames.has(key)) return pipFrames.get(key);
  const ch = PIP_CAST[id];
  const colours = { ...PIP_FACE, ...ch.colours };
  const g = pipBase(id).map((r) => [...r]);
  const set = (x, y, c) => { g[y][x] = c; };
  for (const x of [7, 15]) {
    if (eyes === 'open') {
      set(x, 9, 'H'); set(x + 1, 9, 'E');
      set(x, 10, 'E'); set(x + 1, 10, 'E');
      set(x, 11, 'E'); set(x + 1, 11, 'E');
    } else if (eyes === 'shut') {
      set(x, 11, 'E'); set(x + 1, 11, 'E');
    } else { // happy: ^ ^
      set(x - 1, 11, 'E'); set(x, 10, 'E'); set(x + 1, 10, 'E'); set(x + 2, 11, 'E');
    }
  }
  for (const x of [5, 6, 17, 18]) set(x, 12, 'P');
  if (mouth === 'shut') { set(11, 12, 'M'); set(12, 12, 'M'); }
  else if (mouth === 'smile') { set(10, 12, 'M'); set(11, 13, 'M'); set(12, 13, 'M'); set(13, 12, 'M'); }
  else { set(10, 12, 'M'); set(11, 12, 'M'); set(12, 12, 'M'); set(13, 12, 'M'); set(11, 13, 'T'); set(12, 13, 'T'); set(10, 13, 'M'); set(13, 13, 'M'); }
  // One rect per run of a colour along a row.
  const rects = [];
  for (let y = 0; y < PIP_H; y++) {
    for (let x = 0; x < PIP_W;) {
      const c = g[y][x];
      let n = 1;
      while (x + n < PIP_W && g[y][x + n] === c) n++;
      if (c !== '.') rects.push(`<rect x="${x}" y="${y}" width="${n}" height="1" fill="${colours[c]}"/>`);
      x += n;
    }
  }
  const svg = `<svg viewBox="0 0 ${PIP_W} ${PIP_H}" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
  pipFrames.set(key, svg);
  return svg;
}

// --- On the page -------------------------------------------------------------
const pipBox = el('div', { className: 'pip', hidden: true });
const pipSprite = el('button', { type: 'button', className: 'pip-sprite' });
const pipBody = el('span', { className: 'pip-body' });
pipSprite.append(pipBody, el('span', { className: 'pip-shadow' }));
const pipTag = el('span', { className: 'pip-tag' });
const pipText = el('p', { className: 'pip-text' });
const pipSay = el('button', { type: 'button', className: 'pip-btn pip-speak', textContent: '🔈', title: 'Read the commentary aloud' });
const pipAll = el('button', { type: 'button', className: 'pip-btn', textContent: 'All', title: 'Show all of the commentary in the AI panel' });
const pipRetry = el('button', { type: 'button', className: 'pip-btn pip-retry', textContent: 'Retry', title: 'Ask the AI endpoint again for this comment, and turn commentary back on', hidden: true });
const pipHide = el('button', { type: 'button', className: 'pip-btn pip-x', textContent: '✕' });
const pipThink = el('span', { className: 'pip-think' }, [el('i'), el('i'), el('i')]);
const pipBubble = el('div', { className: 'pip-bubble', role: 'status', ariaLive: 'polite' }, [
  el('div', { className: 'pip-head' }, [pipTag, pipHide]),
  pipText,
  el('div', { className: 'pip-foot' }, [pipRetry, pipSay, pipAll]),
]);
pipBox.append(pipBubble, pipThink, pipSprite);
document.body.append(pipBox);

const pipCalm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function pipDraw() {
  if (!PIP_CAST[pip.who]) pip.who = 'esper';
  const key = `${pip.who}:${pip.eyes}:${pip.mouth}`;
  if (pipBody.dataset.frame !== key) { pipBody.dataset.frame = key; pipBody.innerHTML = pipFrame(pip.who, pip.eyes, pip.mouth); }
}

// The character's name where it is said.
function pipNames() {
  const name = pipChar().name;
  pipSprite.title = `${name}, the commentator: click to show or put away the last comment; drag to move`;
  pipSprite.setAttribute('aria-label', `${name}, the commentator`);
  pipHide.title = `Put the bubble away (click ${name} to bring it back)`;
  pipThink.title = `${name} is thinking of the next comment`;
}

// Where Esper stands: kept between runs; at first, at the bottom right corner
// of the board.
function pipPlace() {
  const w = pipSprite.offsetWidth || 120;
  const h = pipSprite.offsetHeight || 140;
  let { x, y } = pip.pos ?? {};
  if (x == null) {
    const b = $('#board')?.getBoundingClientRect();
    x = b && b.width ? b.right - w * 0.55 : window.innerWidth - w - 24;
    y = b && b.height ? b.bottom - h * 0.85 : window.innerHeight - h - 24;
  }
  x = Math.max(4, Math.min(window.innerWidth - w - 4, x));
  y = Math.max(40, Math.min(window.innerHeight - h - 4, y));
  pipBox.style.left = `${x}px`;
  pipBox.style.top = `${y}px`;
  // The bubble goes where there is room: to the side with more of the
  // window, above unless Esper is near the top.
  pipBox.classList.toggle('to-right', x + w / 2 < window.innerWidth / 2);
  pipBox.classList.toggle('below', y < 270);
}

// Esper blinks every few seconds.
function pipBlink() {
  clearTimeout(pip.blinkT);
  pip.blinkT = setTimeout(() => {
    if (pip.eyes === 'open' && !pipBox.hidden) {
      pip.eyes = 'shut';
      pipDraw();
      setTimeout(() => { if (pip.eyes === 'shut') { pip.eyes = 'open'; pipDraw(); } }, 140);
    }
    pipBlink();
  }, 2400 + Math.random() * 3200);
}

function pipTalking(on) {
  if (on && !pip.talk) {
    pip.talk = setInterval(() => { pip.mouth = pip.mouth === 'open' ? 'shut' : 'open'; pipDraw(); }, 130);
  } else if (!on && pip.talk) {
    clearInterval(pip.talk);
    pip.talk = null;
  }
  pipBox.classList.toggle('talking', on);
}

function pipHop() {
  if (pipCalm()) return;
  pipSprite.classList.remove('hop');
  void pipSprite.offsetWidth;
  pipSprite.classList.add('hop');
}

// The bubble goes away a while after the comment is complete, longer for
// more words; not while it is being read aloud or the pointer is over it.
function pipAwayLater(text) {
  clearTimeout(pip.away);
  const words = String(text ?? '').split(/\s+/).length;
  pip.away = setTimeout(() => {
    if (cm.speaking || pipBox.matches(':hover')) { pipAwayLater(text); return; }
    pip.open = false;
    renderCommentator();
  }, 9000 + words * 350);
}

// How long a comment stays before the next may take its place: time enough
// to read it.
const pipReadMs = (text) => Math.min(15000, 2500 + String(text ?? '').trim().split(/\s+/).length * 300);

// The comment the bubble shows. It stays until it has been read: until it
// has been said, when reading aloud, else for a time by its length. The
// next comment, being thought of meanwhile, waits; one said aloud is shown
// as it is said.
function pipPick() {
  const feed = cm.feed;
  const shown = feed.includes(pip.said) ? pip.said : null;
  const spoken = cm.speaking && cm.spokenText ? feed.find((c) => c.text === cm.spokenText) : null;
  const target = spoken ?? [...feed].reverse().find((c) => c.text || c.error) ?? null;
  clearTimeout(pip.holdT);
  if (!target || target === shown) return shown ?? (feed.length === 1 ? feed[0] : null);
  if (!shown || shown.error || spoken) return target;
  if (shown.live) return shown; // still being written
  if (cm.speaking) return shown; // being said
  const left = pipReadMs(shown.text) - (Date.now() - (pip.doneAt || 0));
  if (left <= 0) return target;
  pip.holdT = setTimeout(renderCommentator, left + 20);
  return shown;
}

function renderCommentator() {
  $('#cm-pip').checked = pip.on;
  $('#cmt-on').checked = pip.on;
  const card = $('#commentary');
  // Only while live commentary is on: turned off, the commentator goes, and
  // comes back when it is turned on again.
  const show = pip.on && cm.on && Boolean(state?.players) && !puzzleView;
  // Esper takes the card's place.
  if (pip.on && !card.hidden) card.hidden = true;
  if (pipBox.hidden !== !show) {
    pipBox.hidden = !show;
    if (show) { pipPlace(); pipBlink(); } else { pipTalking(false); clearTimeout(pip.blinkT); }
  }
  if (!show) return;
  const newest = cm.feed.at(-1);
  const last = pipPick();
  // Something new to say: the bubble comes out, and Esper hops.
  if (last !== pip.said) {
    pip.said = last;
    pip.doneAt = 0;
    pip.open = true;
    clearTimeout(pip.away);
    pip.away = null;
    pipText.dataset.text = '';
    pipText.textContent = '';
    if (last) pipHop();
    pipBubble.classList.remove('pop');
    void pipBubble.offsetWidth;
    pipBubble.classList.add('pop');
  }
  if (last && !last.live && !pip.doneAt) pip.doneAt = Date.now();
  const writing = Boolean(last?.live);
  const talking = (writing && Boolean(last?.text)) || Boolean(cm.speaking);
  pipTalking(talking && !pipCalm());
  if (!pip.talk) pip.mouth = last?.kind === 'summary' && !last.error ? 'smile' : last?.error ? 'shut' : 'shut';
  if (pip.eyes !== 'shut') pip.eyes = last?.kind === 'summary' && !last.live && !last.error ? 'happy' : 'open';
  pipDraw();
  // The next comment on its way: "Hmm…" in the bubble when there is nothing
  // to show yet, else a thought bubble beside Esper, the comment staying.
  pipBox.classList.toggle('thinking', writing && !last?.text);
  pipBox.classList.toggle('pondering', Boolean(last && newest && newest !== last && (newest.live || newest.text)));
  pipBox.classList.toggle('summary', last?.kind === 'summary');
  pipBox.classList.toggle('error', Boolean(last?.error));
  pipBubble.hidden = !pip.open;
  // What Esper says.
  pipTag.textContent = !last ? pipChar().name : last.kind === 'summary' ? 'Final word' : last.label;
  if (last) aicSoftText(pipText, last.text);
  else {
    const hint = cmLive() ? `Commentary is on! I'll say something after ${cm.every === 1 ? 'the next move' : `the next ${cm.every} moves`}.` : 'Commentary is on! I start talking with the next game played.';
    if (pipText.textContent !== hint) { pipText.textContent = hint; pipText.dataset.text = hint; }
  }
  pipRetry.hidden = !last?.error;
  pipRetry.disabled = cm.busy;
  pipSay.textContent = cm.speak ? '🔊' : '🔈';
  pipSay.disabled = !cmCanSpeak;
  pipSay.classList.toggle('on', cm.speak);
  pipSay.title = !cmCanSpeak ? 'This computer has no speech to read with' : cm.speak ? 'Reading the commentary aloud: click to stop' : 'Read the commentary aloud';
  if (last && !last.live && pip.open) { if (!pip.away) pipAwayLater(last.text); } else if (writing) { clearTimeout(pip.away); pip.away = null; }
}
window.renderCommentator = renderCommentator;

// Settings → AI: the cast, one card each, the chosen one marked.
function renderCast() {
  const box = $('#cmt-cast');
  box.replaceChildren(...Object.entries(PIP_CAST).map(([id, ch]) => {
    const card = el('button', { type: 'button', className: 'cmt-card' + (id === pip.who ? ' on' : ''), role: 'radio' }, [
      el('span', { className: 'cmt-art', innerHTML: pipFrame(id, 'open', 'smile') }),
      el('span', { className: 'cmt-name', textContent: ch.name }),
      el('span', { className: 'cmt-piece', textContent: ch.piece }),
      el('span', { className: 'cmt-blurb', textContent: ch.blurb }),
    ]);
    card.setAttribute('aria-checked', String(id === pip.who));
    card.title = `${ch.name} says the commentary`;
    card.onclick = () => setCommentatorWho(id);
    return card;
  }));
  box.classList.toggle('off', !pip.on);
}

function setCommentatorWho(id) {
  if (!PIP_CAST[id]) return;
  pip.who = id;
  try { localStorage.setItem('commentatorWho', id); } catch { /* not kept */ }
  pipNames();
  pipDraw();
  renderCast();
  // Chosen with commentator off: it comes on.
  if (!pip.on) setCommentator(true);
  else if (!pipBox.hidden) pipHop();
}

function setCommentator(on) {
  pip.on = Boolean(on);
  try { localStorage.setItem('commentator', pip.on ? 'on' : 'off'); } catch { /* not kept */ }
  if (!pip.on) { pipBox.hidden = true; pipTalking(false); }
  renderCast();
  renderCommentary(); // the card comes back, or Esper takes its place
}

// Dragging Esper; a click without moving shows or puts away the bubble.
pipSprite.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const start = { x: e.clientX, y: e.clientY, left: pipBox.offsetLeft, top: pipBox.offsetTop };
  let moved = false;
  pipSprite.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    pipBox.classList.add('dragging');
    pip.pos = { x: start.left + dx, y: start.top + dy };
    pipPlace();
  };
  const up = () => {
    pipSprite.removeEventListener('pointermove', move);
    pipSprite.removeEventListener('pointerup', up);
    pipSprite.removeEventListener('pointercancel', up);
    pipBox.classList.remove('dragging');
    if (moved) {
      pip.pos = { x: pipBox.offsetLeft, y: pipBox.offsetTop };
      try { localStorage.setItem('commentatorPos', JSON.stringify(pip.pos)); } catch { /* not kept */ }
    } else {
      pip.open = !pip.open;
      clearTimeout(pip.away);
      pip.away = null;
      if (pip.open) pipHop();
      renderCommentator();
    }
  };
  pipSprite.addEventListener('pointermove', move);
  pipSprite.addEventListener('pointerup', up);
  pipSprite.addEventListener('pointercancel', up);
});
pipSprite.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  pip.open = !pip.open;
  renderCommentator();
});
pipHide.onclick = () => { pip.open = false; clearTimeout(pip.away); pip.away = null; renderCommentator(); };
pipSay.onclick = () => setSpeak(!cm.speak);
pipAll.onclick = () => { showAiView('commentary'); setAiPanel(true, { focus: false }); };
pipRetry.onclick = () => retryCommentary(cm.feed.at(-1));
$('#cm-pip').onchange = (e) => setCommentator(e.target.checked);
$('#cmt-on').onchange = (e) => setCommentator(e.target.checked);
window.addEventListener('resize', () => { if (!pipBox.hidden) pipPlace(); });

pipNames();
pipDraw();
renderCast();
renderCommentator();
