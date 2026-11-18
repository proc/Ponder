'use strict';
// The announcer: a quick voice for the game being played, with no AI. It
// says the moves (all of them, or only captures, checks, castling and
// promotions), the score when it swings (from the playing engines' own
// evaluations, or the analysis when it is on), a mate when one is found,
// the opening, a player low on time, and how the game started and ended.
// Each can be turned on or off in Settings → General → Announcer. It speaks
// with the commentary's voice or one of its own (a voice of this computer,
// or the speech server of Settings → AI), taking turns with the AI's
// comments, and can also show what it says over the board.

const ANNOUNCER_DEFAULTS = {
  on: false,
  personality: 'classic', // a key of ANN_PERSONALITIES, or 'surprise' (one for each game)
  moves: 'all',     // 'all' | 'key' (captures, checks, castling, promotions) | 'none'
  who: false,       // say who moved: "Magnus: knight f3"
  names: true,      // the players' names in place of White and Black
  swing: 1.5,       // a score swing of so many pawns is said (0: never)
  mates: true,      // a mate found
  opening: true,
  lowtime: true,
  start: true,
  end: true,
  captions: true,   // what is said, over the board
  voice: 'same',    // 'same' (the commentary's) | a computer voice | 'server:'
  rate: 1.1,
};
const ann = { ...ANNOUNCER_DEFAULTS };
try { Object.assign(ann, JSON.parse(localStorage.getItem('announcer') ?? '{}') ?? {}); } catch { /* as new */ }
const saveAnnouncer = () => { try { localStorage.setItem('announcer', JSON.stringify(Object.fromEntries(Object.keys(ANNOUNCER_DEFAULTS).map((k) => [k, ann[k]])))); } catch { /* not kept */ } };

// --- Personalities ---------------------------------------------------------------
// How the announcer puts things. Each line is picked at random from its list
// (not the same one twice running), with {white} {black} {side} {move} {n}
// {pawns} {opening} {reason} filled in. `flair` is how often a capture, a
// check, castling or a promotion gets more than the move itself; a mate
// always does. `rate` and `pitch` shade the voice (pitch: computer voices).
const ANN_PERSONALITIES = {
  classic: {
    label: 'Classic', blurb: 'calm and clear, like a broadcast',
    start: ['{white} against {black}. The game begins.'],
    opening: ['{opening}.'],
    level: ['The game is level.'],
    slight: ['{side} is slightly better.'],
    clear: ['{side} has a clear advantage.'],
    winning: ['{side} is winning.'],
    mate: ['{side} has mate in {n}!'],
    blunder: ['A blunder!'],
    lowtime: ['{side} is low on time.'],
    win: ['{reason}.'],
    draw: ['{reason}.'],
  },
  hype: {
    label: 'Hype', blurb: 'a sportscaster on the edge of the seat', rate: 1.12, pitch: 1.1, flair: 0.45,
    start: ['Ladies and gentlemen, {white} versus {black}! Let’s go!', 'It’s {white} against {black}, and we are live!', 'Here we go! {white}, {black}, the board is set!'],
    opening: ['We’ve got the {opening} on our hands!', '{opening}! Classic stuff!', 'Oh, the {opening}! I love it!'],
    level: ['And we’re all square again!', 'Dead even! Anybody’s game!', 'Balance is restored!'],
    slight: ['{side} edging ahead!', '{side} with the upper hand!', 'Little advantage {side}!'],
    clear: ['{side} is pulling away!', 'Big edge for {side}!', '{side} is in the driver’s seat!'],
    winning: ['{side} is cruising to victory!', 'This is all {side} now!', 'Can anyone stop {side}?'],
    mate: ['Mate in {n} for {side}! Can they find it?', 'There’s a forced mate in {n}! {side} for the win!', 'Mate on the board! {side}, mate in {n}!'],
    blunder: ['Oh no! A blunder!', 'What was that?!', 'Disaster!', 'Oh, that’s a big mistake!'],
    lowtime: ['{side} is running out of time! The clock is ticking!', 'Time trouble for {side}!', '{side} has seconds left!'],
    win: ['{reason}! What a game!', 'And that’s it! {reason}!', '{reason}! Unbelievable!'],
    draw: ['{reason}! What a battle!', '{reason}. Nobody blinks!'],
    capture: ['{move}! Off the board!', '{move}! Gone!', '{move}! Snatched it!'],
    check: ['{move}! The king is in danger!', '{move}! Pressure!'],
    castle: ['{move}! King to safety!'],
    promo: ['{move}! A new piece is born!'],
    checkmate: ['{move} It’s over!', '{move} Game, set and match!'],
  },
  zen: {
    label: 'Zen', blurb: 'soft, slow and kind', rate: 0.88, pitch: 0.95, flair: 0.25,
    start: ['{white} and {black} sit down together. Breathe. The game begins.', 'A quiet board. {white}, {black}. Let us begin.'],
    opening: ['The {opening}. A path well walked.', 'The {opening} unfolds.'],
    level: ['Balance returns.', 'All is in harmony.'],
    slight: ['{side} finds a little more space.', 'The flow favours {side}, gently.'],
    clear: ['{side} moves with clarity.', 'The board leans towards {side}.'],
    winning: ['{side}’s path is clear now.', 'The way is open for {side}.'],
    mate: ['There is a mate in {n} for {side}. Let it come.', '{side} can finish it, in {n}.'],
    blunder: ['A misstep. It happens to us all.', 'Ah. A moment of haste.'],
    lowtime: ['{side}, the sands run low. Stay calm.', 'Little time remains for {side}. Breathe.'],
    win: ['{reason}. Thank you both.', '{reason}. A game well played.'],
    draw: ['{reason}. Peace.', '{reason}. Neither more nor less.'],
    capture: ['{move}. Let it go.'],
    castle: ['{move}. Home and safe.'],
    checkmate: ['{move} And so it ends.'],
  },
  butler: {
    label: 'Butler', blurb: 'impeccably polite', rate: 0.97, pitch: 0.92, flair: 0.3,
    start: ['Presenting {white}, and {black}. Do begin.', 'Good evening. {white} versus {black}, if you please.'],
    opening: ['The {opening}, I believe.', 'Ah, the {opening}. Most traditional.'],
    level: ['Matters are once again even.', 'Quite balanced, if I may say.'],
    slight: ['{side} is somewhat better, I should think.', 'A modest edge to {side}.'],
    clear: ['{side} is doing rather well.', 'If I may, {side} is clearly better.'],
    winning: ['{side} appears to be winning, I’m afraid.', 'I do believe {side} is winning.'],
    mate: ['Forgive me, but {side} has mate in {n}.', 'There is a mate in {n} for {side}, should they care to find it.'],
    blunder: ['Oh dear.', 'Most unfortunate.', 'I say!'],
    lowtime: ['{side} may wish to hurry along.', 'Pardon me, {side}, the clock.'],
    win: ['{reason}. Splendid.', '{reason}. Shall I fetch the tea?'],
    draw: ['{reason}. Most civilised.'],
    capture: ['{move}. Do excuse them.', '{move}, if you please.'],
    check: ['{move}. Mind the king.'],
    checkmate: ['{move} That will be all.'],
  },
  robot: {
    label: 'Robot', blurb: 'numbers and no feelings', rate: 1.02, pitch: 0.6, flair: 0.3,
    start: ['Initialising. {white} versus {black}. Game start.', 'Players detected: {white}, {black}. Commencing.'],
    opening: ['Opening identified: {opening}.'],
    level: ['Evaluation: zero point zero. Equal.', 'Position equal. No advantage detected.'],
    slight: ['Evaluation: {side} plus {pawns}.'],
    clear: ['Evaluation: {side} plus {pawns}. Significant.'],
    winning: ['Evaluation: {side} plus {pawns}. Win probability high.'],
    mate: ['Forced mate detected. {side}, mate in {n}.'],
    blunder: ['Error detected.', 'Suboptimal move detected.'],
    lowtime: ['Warning. {side}, time critical.'],
    win: ['{reason}. Game over.', '{reason}. Shutting down.'],
    draw: ['{reason}. Result: one half each.'],
    capture: ['{move}. Unit eliminated.'],
    checkmate: ['{move} Termination complete.'],
  },
  pirate: {
    label: 'Pirate', blurb: 'a salty sea dog, arr', rate: 1.02, pitch: 0.85, flair: 0.4,
    start: ['Ahoy! {white} against {black}! Hoist the colours!', 'Arr, {white} and {black} be crossin’ swords!'],
    opening: ['The {opening}, says the old charts!', 'Arr, ’tis the {opening}!'],
    level: ['Calm seas, me hearties. All even.', 'Neither ship ahead!'],
    slight: ['{side} catches the wind!', 'Fair winds for {side}!'],
    clear: ['{side} be gainin’ fast!', '{side} has the weather gauge!'],
    winning: ['{side} be boardin’ the enemy ship!', 'Treasure in sight for {side}!'],
    mate: ['Mate in {n}! {side} smells the treasure!', 'Walk the plank in {n}, says {side}!'],
    blunder: ['Shiver me timbers!', 'Blow me down!', 'Arr, a terrible blunder!'],
    lowtime: ['The sand runs low for {side}!', 'Hurry, {side}, ye scallywag!'],
    win: ['{reason}! The treasure be theirs!', '{reason}! Yo ho ho!'],
    draw: ['{reason}. Both ships limp home.'],
    capture: ['{move}! Plundered!', '{move}! Into the briny deep!'],
    check: ['{move}! Fire the cannons!'],
    checkmate: ['{move} Down to Davy Jones!'],
  },
  snark: {
    label: 'Snarky', blurb: 'unimpressed by everyone', rate: 1.05, pitch: 1, flair: 0.3,
    start: ['{white} against {black}. Try to keep it interesting.', 'Oh good, {white} and {black}. This should be… something.'],
    opening: ['The {opening}. How original.', 'The {opening} again. Never seen that before.'],
    level: ['Level again. Riveting.', 'Back to even. Of course.'],
    slight: ['{side} is slightly better. Don’t get excited.', 'A little edge for {side}. Whatever.'],
    clear: ['{side} is clearly better. Even I can see it.', '{side} is ahead. Shocking.'],
    winning: ['{side} is winning. Finally, a plot.', 'It’s {side}’s game. Wake me at the end.'],
    mate: ['Mate in {n} for {side}. Try not to miss it.', '{side} has mate in {n}. Let’s see them blow it.'],
    blunder: ['Wow. Bold choice.', 'Well, that was a blunder.', 'Interesting. And by interesting I mean bad.'],
    lowtime: ['{side} is low on time. Who could have predicted that?', 'Tick tock, {side}.'],
    win: ['{reason}. Took long enough.', '{reason}. Clap, I suppose.'],
    draw: ['{reason}. All that for nothing.'],
    capture: ['{move}. Sure, why not.', '{move}. Didn’t need that piece anyway.'],
    check: ['{move}. Oh no, a check.'],
    checkmate: ['{move} Mercifully, it’s over.'],
  },
};
// 'surprise': a different one for each game.
const annPersonalityKeys = Object.keys(ANN_PERSONALITIES);
let annSurprise = annPersonalityKeys[Math.floor(Math.random() * annPersonalityKeys.length)];
const annP = () => ANN_PERSONALITIES[ann.personality === 'surprise' ? annSurprise : ann.personality] ?? ANN_PERSONALITIES.classic;
function annNewSurprise() {
  const others = annPersonalityKeys.filter((k) => k !== annSurprise);
  annSurprise = others[Math.floor(Math.random() * others.length)];
}
// A line of this kind, at random, not the one said last time.
const annLast = {};
function annLine(kind, vars = {}) {
  const p = annP();
  const lines = p[kind] ?? ANN_PERSONALITIES.classic[kind];
  if (!lines?.length) return '';
  let i = Math.floor(Math.random() * lines.length);
  if (lines.length > 1 && annLast[kind] === lines[i]) i = (i + 1) % lines.length;
  annLast[kind] = lines[i];
  return lines[i].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

// What the announcer knows of the game it is following.
const annGame = { game: null, score: null, band: null, mate: null, opening: '', timer: 0 };

// --- Saying it -----------------------------------------------------------------
function annVoice() {
  const p = annP();
  const base = ann.voice === 'same' ? { voice: cm.voice, rate: cm.rate } : { voice: ann.voice, rate: ann.rate };
  return { voice: base.voice, rate: base.rate * (p.rate ?? 1), pitch: p.pitch ?? 1 };
}
function annSay(text) {
  if (!ann.on || !text) return;
  if (ann.captions) annCaption(text);
  window.cmAnnounce?.(text, annVoice());
}
// A caption over the board for a moment.
const annCap = el('div', { id: 'ann-caption', ariaLive: 'polite' });
$('.board-wrap').append(annCap);
let annCapTimer = 0;
function annCaption(text) {
  annCap.textContent = text;
  annCap.classList.add('on');
  clearTimeout(annCapTimer);
  annCapTimer = setTimeout(() => annCap.classList.remove('on'), Math.max(1800, text.length * 70));
}

// --- The words -----------------------------------------------------------------
const ANN_PIECES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
// "Nxf7+" → "knight takes f7, check"; "exd5" → "e takes d5"; "O-O" → "castles".
function annMove(san) {
  san = String(san ?? '');
  const end = san.includes('#') ? ', checkmate!' : san.includes('+') ? ', check' : '';
  if (san.startsWith('O-O-O')) return `castles queenside${end}`;
  if (san.startsWith('O-O')) return `castles kingside${end}`;
  const m = san.match(/^([KQRBN])?([a-h]?[1-8]?)(x)?([a-h][1-8])(?:=([QRBN]))?/);
  if (!m) return san;
  const [, piece, from, takes, to, promo] = m;
  // Which of two pieces moved, when the move says ("Nbd2": knight b d2).
  let words = piece ? `${ANN_PIECES[piece]}${from ? ` ${from}` : ''}${takes ? ' takes' : ''} ${to}` : takes ? `${from} takes ${to}` : to;
  if (promo) words += `, promotes to a ${ANN_PIECES[promo]}`;
  return words + end;
}
const annKeyMove = (san) => /[x+#=]|O-O/.test(san);
// A side's name, as said.
function annName(side, st = state) {
  const n = ann.names ? String(st?.players?.[side]?.name ?? '').trim() : '';
  return n && !/^(white|black)$/i.test(n) ? n : side === 'white' ? 'White' : 'Black';
}
// A capital for a word ("Knight f3"), not a square ("e4").
const annCap1 = (t) => (/^[a-h](\d|\s)/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1));

// The score, White's way: the playing engines' own (after the last move or
// the one before), or the analysis of the position now. null when nothing
// is known well enough (an analysis just started is not trusted yet).
function annScore() {
  const n = state.moves.length;
  for (let p = n; p >= Math.max(1, n - 1); p--) {
    const e = typeof engineScores !== 'undefined' ? engineScores[p] : null;
    if (e && (e.isMate || Number.isFinite(e.cp))) return { cp: e.isMate ? null : e.cp, mate: e.isMate ? e.mate : null, ply: p };
  }
  const data = typeof analysis !== 'undefined' ? analysis.data : null;
  const fen = n ? state.moves[n - 1].fen : state.startFen;
  const l = data?.state === 'running' && data.fen === fen ? data.lines?.[0] : null;
  if (l && (l.depth ?? 0) >= 12) return { cp: l.isMate ? null : l.cp, mate: l.isMate ? l.mate : null, ply: n };
  return null;
}
// How the game stands: 0 level, 1 slightly better, 2 clearly better,
// 3 winning, 4 a mate; signed for the side (+ White).
function annBand(s) {
  if (s.mate != null) return Math.sign(s.mate || 1) * 4;
  const v = Math.abs(s.cp) / 100;
  return Math.sign(s.cp) * (v < 0.6 ? 0 : v < 1.5 ? 1 : v < 3 ? 2 : 3);
}
function annStanding(band, s) {
  const vars = { side: annName(band > 0 ? 'white' : 'black'), n: Math.abs(s.mate ?? 0), pawns: s.cp != null ? (Math.abs(s.cp) / 100).toFixed(1) : '' };
  return annLine(['level', 'slight', 'clear', 'winning', 'mate'][Math.min(4, Math.abs(band))], vars);
}
// A move, as this personality says it: the move, and now and then (a mate
// always) something about it.
function annMoveLine(san) {
  const words = annMove(san);
  const p = annP();
  const kind = san.includes('#') ? 'checkmate' : san.includes('=') ? 'promo' : san.includes('+') ? 'check' : san.startsWith('O-O') ? 'castle' : san.includes('x') ? 'capture' : '';
  let pick = kind;
  if (pick && !p[pick]?.length && san.includes('x') && pick !== 'checkmate') pick = 'capture'; // a capture that checks
  if (!pick || !p[pick]?.length || (pick !== 'checkmate' && Math.random() >= (p.flair ?? 0))) return words;
  return annLine(pick, { move: words });
}

// --- Following the game --------------------------------------------------------
const annFollowing = (st) => Boolean(st && (st.active || st.external?.live) && st.external?.kind !== 'tournament');

// Called with each new state of the game (renderer.js, with the sounds).
function annOnState(prev, next, newGame) {
  if (!ann.on || !prev || !next) return;
  if (newGame) {
    annGame.game = next.game;
    annGame.score = annGame.band = annGame.mate = null;
    annGame.opening = '';
    if (ann.personality === 'surprise') annNewSurprise();
    if (ann.start && annFollowing(next) && next.moves.length === 0) annSay(annLine('start', { white: annName('white', next), black: annName('black', next) }));
    return;
  }
  if (!annFollowing(prev) && !annFollowing(next)) return;
  if (next.moves.length === prev.moves.length + 1 && ann.moves !== 'none') {
    const mv = next.moves.at(-1);
    if (ann.moves === 'all' || annKeyMove(mv.san)) {
      const white = mv.fen?.split(' ')[1] === 'b'; // White moved: Black is to move
      const words = annMoveLine(mv.san);
      annSay(ann.who ? `${annName(white ? 'white' : 'black', next)}: ${words}` : annCap1(words));
    }
  }
  const ended = (prev.active && !next.active) || (prev.external?.live && next.external && !next.external.live && next.result !== '*')
    || (prev.external && next.external && !next.external.live && prev.result === '*' && next.result !== '*');
  if (ended && ann.end && next.result !== '*') {
    let reason = String(next.reason || (next.result === '1/2-1/2' ? 'Draw' : next.result === '1-0' ? 'White wins' : 'Black wins'));
    if (ann.names) reason = reason.replace(/\bWhite\b/, annName('white', next)).replace(/\bBlack\b/, annName('black', next));
    const line = annLine(next.result === '1/2-1/2' ? 'draw' : 'win', { reason: reason.replace(/[.!]$/, '') });
    setTimeout(() => annSay(line), 400);
  }
}

// The score and the opening come a little after the move: looked at a few
// times a second while a game is followed.
function annTick() {
  if (!ann.on || !state || !annFollowing(state)) return;
  if (state.game !== annGame.game) { annGame.game = state.game; annGame.score = annGame.band = annGame.mate = null; annGame.opening = ''; }
  // The opening as it gets its name, early in the game: its family ("Sicilian
  // Defense"), said again only when the game turns into another one.
  let named = '';
  for (const m of state.moves) if (m.opening) named = m.opening;
  const family = String(named || state.opening || '').replace(/^[A-E]\d\d\s+/, '').split(':')[0].trim();
  if (family && family !== annGame.opening) {
    annGame.opening = family;
    if (ann.opening && state.moves.length <= 24) annSay(annCap1(annLine('opening', { opening: family })));
  }
  const s = annScore();
  if (!s) return;
  const band = annBand(s);
  const v = s.mate != null ? Math.sign(s.mate) * 100 : s.cp / 100;
  if (annGame.score == null) { annGame.score = v; annGame.band = band; annGame.mate = s.mate; return; }
  // A mate found (or one side's mate turned to the other's).
  if (s.mate != null && (annGame.mate == null || Math.sign(annGame.mate) !== Math.sign(s.mate))) {
    if (ann.mates) annSay(annStanding(band, s));
    annGame.score = v; annGame.band = band; annGame.mate = s.mate;
    return;
  }
  annGame.mate = s.mate;
  if (!ann.swing || band === annGame.band || Math.abs(v - annGame.score) < ann.swing || s.mate != null) return;
  // Against the side that just moved, by a lot: its move was the mistake.
  const moverWhite = state.moves.at(-1)?.fen?.split(' ')[1] === 'b';
  const against = (v - annGame.score) * (moverWhite ? 1 : -1) < 0;
  const blunder = against && Math.abs(v - annGame.score) >= Math.max(2, ann.swing);
  annSay(`${blunder ? `${annLine('blunder')} ` : ''}${annStanding(band, s)}`);
  annGame.score = v;
  annGame.band = band;
}
annGame.timer = setInterval(annTick, 700);

// A player's clock running low (renderer.js, with the low-time sound).
function annOnLowTime(side) {
  if (ann.on && ann.lowtime) annSay(annLine('lowtime', { side: annName(side) }));
}

window.announcer = { onState: annOnState, onLowTime: annOnLowTime, say: annSay, settings: ann, move: annMove, personalities: ANN_PERSONALITIES, line: annLine, moveLine: annMoveLine };

// --- Settings → General → Announcer ----------------------------------------------
function fillAnnouncerVoices() {
  const sel = $('#ann-voice');
  const voices = typeof cmVoices === 'function' ? cmVoices() : [];
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const sorted = [...voices].sort((a, b) => (b.lang.toLowerCase().startsWith(lang) - a.lang.toLowerCase().startsWith(lang)) || a.name.localeCompare(b.name));
  sel.replaceChildren(
    el('option', { value: 'same', textContent: 'The commentary’s voice' }),
    ...(cmCanSpeak ? [el('option', { value: '', textContent: 'The computer’s voice' })] : []),
    ...(window.ttsIsOn?.() ? [el('option', { value: CM_SERVER, textContent: 'Speech server (Settings → AI)' })] : []),
    ...sorted.map((v) => el('option', { value: v.name, textContent: `${v.name} (${v.lang})` })),
  );
  sel.value = [...sel.options].some((o) => o.value === ann.voice) ? ann.voice : 'same';
}
function showAnnouncerSettings() {
  $('#ann-on').checked = ann.on;
  $('#ann-moves').value = ann.moves;
  $('#ann-personality').value = ann.personality in ANN_PERSONALITIES || ann.personality === 'surprise' ? ann.personality : 'classic';
  $('#ann-personality-sub').textContent = ann.personality === 'surprise' ? 'a different one each game' : annP().blurb;
  $('#ann-swing').value = String(ann.swing);
  for (const k of ['who', 'names', 'mates', 'opening', 'lowtime', 'start', 'end', 'captions']) $(`#ann-${k}`).checked = Boolean(ann[k]);
  $('#ann-rate').value = String(ann.rate);
  $('#ann-rate').disabled = ann.voice === 'same';
  $('#ann-rate').title = ann.voice === 'same' ? 'The commentary’s speed, set with its voice' : 'How fast it speaks';
  $('#ann-card').classList.toggle('off', !ann.on);
}
// Settings opened: the voices may have come since.
window.refreshAnnouncerSettings = () => { fillAnnouncerVoices(); showAnnouncerSettings(); };
const annSet = (k, v) => { ann[k] = v; saveAnnouncer(); showAnnouncerSettings(); };
$('#ann-on').onchange = (e) => { annSet('on', e.target.checked); if (ann.on) annGame.score = null; };
$('#ann-moves').onchange = (e) => annSet('moves', e.target.value);
$('#ann-personality').replaceChildren(
  ...Object.entries(ANN_PERSONALITIES).map(([k, p]) => el('option', { value: k, textContent: p.label })),
  el('option', { value: 'surprise', textContent: 'Surprise me' }),
);
$('#ann-personality').onchange = (e) => { if (e.target.value === 'surprise') annNewSurprise(); annSet('personality', e.target.value); $('#ann-test').click(); };
$('#ann-swing').onchange = (e) => annSet('swing', +e.target.value || 0);
for (const k of ['who', 'names', 'mates', 'opening', 'lowtime', 'start', 'end', 'captions']) $(`#ann-${k}`).onchange = (e) => annSet(k, e.target.checked);
$('#ann-voice').onchange = (e) => annSet('voice', e.target.value);
$('#ann-rate').onchange = (e) => annSet('rate', +e.target.value || 1);
$('#ann-test').onclick = () => {
  const was = ann.on;
  ann.on = true;
  const p = annP();
  const flair = p.flair;
  p.flair = 1; // the test shows the personality off
  const move = annCap1(annMoveLine('Nxf7+'));
  p.flair = flair;
  annSay(`${move}${/[.!?]$/.test(move) ? '' : '.'} ${annLine('blunder')} ${annLine('winning', { side: annName('white'), pawns: '3.4' })}`);
  ann.on = was;
};
fillAnnouncerVoices();
showAnnouncerSettings();
if (cmCanSpeak) window.speechSynthesis.addEventListener?.('voiceschanged', fillAnnouncerVoices);
