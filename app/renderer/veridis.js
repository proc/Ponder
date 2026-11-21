'use strict';
// Another easter egg: type "veridis" anywhere outside a text box and Ponder
// plays Veridis Quo (Daft Punk) from a MIDI file in media/, on a little Web
// Audio synth of its own, while the board's squares light up with the
// melody. Type it again, press Escape, or press the music button (or U) to
// stop it. It is heard only when Sounds are on and stops when they go off;
// with reduced motion the squares stay still.

const VQ_WORD = 'veridis';
const VQ_FILE = 'media/veridis-quo.mid';
let vqTyped = '';
let vqSong = null; // the parsed file, once read
let vq = null;     // what is playing: { ctx, out, timer, ... }

// ---------------------------------------------------------------------------
// The MIDI file: a standard (SMF) file, read into notes with times in seconds.
// ---------------------------------------------------------------------------
function vqParse(buf) {
  const b = new DataView(buf);
  const str = (p, n) => String.fromCharCode(...new Uint8Array(buf, p, n));
  if (str(0, 4) !== 'MThd') throw new Error('not a MIDI file');
  const division = b.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE timing is not supported');
  const tempos = [];    // [tick, microseconds per beat]
  const raw = [];       // { tick, endTick, ch, note, vel }
  const programs = new Array(16).fill(0);
  const progAt = [];    // [tick, ch, program]
  let p = 8 + b.getUint32(4);
  while (p + 8 <= buf.byteLength) {
    const len = b.getUint32(p + 4);
    const isTrack = str(p, 4) === 'MTrk';
    let q = p + 8;
    const end = Math.min(buf.byteLength, q + len);
    p = q + len;
    if (!isTrack) continue;
    let tick = 0;
    let status = 0;
    // ch*128+note -> the notes struck on that key and not yet released,
    // oldest first: a release ends the oldest. (This file strikes a key
    // again while it is held and sends the releases later.)
    const open = new Map();
    const vl = () => { let v = 0, c; do { c = b.getUint8(q++); v = (v << 7) | (c & 127); } while (c & 128 && q < end); return v; };
    while (q < end) {
      tick += vl();
      let s = b.getUint8(q);
      if (s & 0x80) q++; else s = status;
      if (s === 0xff) {
        const type = b.getUint8(q++);
        const l = vl();
        if (type === 0x51 && l === 3) tempos.push([tick, (b.getUint8(q) << 16) | (b.getUint8(q + 1) << 8) | b.getUint8(q + 2)]);
        if (type === 0x2f) { q = end; break; }
        q += l;
      } else if (s === 0xf0 || s === 0xf7) {
        q += vl();
      } else {
        status = s;
        const hi = s >> 4, ch = s & 15;
        const d1 = b.getUint8(q);
        const d2 = hi === 0xc || hi === 0xd ? 0 : b.getUint8(q + 1);
        q += hi === 0xc || hi === 0xd ? 1 : 2;
        const key = ch * 128 + d1;
        if (hi === 0x9 && d2 > 0) {
          const n = { tick, endTick: null, ch, note: d1, vel: d2 };
          raw.push(n);
          if (open.has(key)) open.get(key).push(n); else open.set(key, [n]);
        } else if (hi === 0x8 || hi === 0x9) {
          const n = open.get(key)?.shift();
          if (n) n.endTick = tick;
        } else if (hi === 0xc) {
          progAt.push([tick, ch, d1]);
        }
      }
    }
    for (const list of open.values()) for (const n of list) n.endTick = tick;
  }
  // Ticks to seconds through the tempo map (120 bpm until the first tempo).
  tempos.sort((x, y) => x[0] - y[0]);
  const map = [[0, 0, 500000]]; // [tick, seconds, us per beat]
  for (const [t, us] of tempos) {
    const [lt, ls, lus] = map[map.length - 1];
    if (t === lt) { map[map.length - 1][2] = us; continue; }
    map.push([t, ls + (t - lt) * lus / division / 1e6, us]);
  }
  const secs = (tick) => {
    let i = map.length - 1;
    while (i > 0 && map[i][0] > tick) i--;
    const [t, s, us] = map[i];
    return s + (tick - t) * us / division / 1e6;
  };
  progAt.sort((x, y) => x[0] - y[0]);
  for (const [, ch, prog] of progAt) if (!programs[ch]) programs[ch] = prog;
  // Striking a key that is still sounding cuts the note before, as a General
  // MIDI player does; the same key struck twice at once is played once.
  raw.sort((x, y) => x.ch - y.ch || x.note - y.note || x.tick - y.tick);
  const kept = [];
  for (const n of raw) {
    const prev = kept[kept.length - 1];
    if (prev && prev.ch === n.ch && prev.note === n.note) {
      if (prev.tick === n.tick) { prev.endTick = Math.max(prev.endTick ?? 0, n.endTick ?? 0); prev.vel = Math.max(prev.vel, n.vel); continue; }
      if ((prev.endTick ?? prev.tick) > n.tick) prev.endTick = n.tick;
    }
    kept.push(n);
  }
  const notes = kept.map((n) => {
    const t = secs(n.tick);
    return { t, dur: Math.max(0.03, secs(n.endTick ?? n.tick) - t), ch: n.ch, note: n.note, vel: n.vel / 127 };
  }).sort((x, y) => x.t - y.t);
  const length = notes.reduce((m, n) => Math.max(m, n.t + n.dur), 0);
  return { notes, programs, length };
}

function vqLoad() {
  if (vqSong) return Promise.resolve(vqSong);
  // XHR rather than fetch: the page is a file:// page (and in an asar when
  // packaged), which fetch will not read.
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', VQ_FILE);
    x.responseType = 'arraybuffer';
    x.onload = () => {
      if (!x.response || (x.status && x.status !== 200)) { reject(new Error(`could not read ${VQ_FILE}`)); return; }
      try { vqSong = vqParse(x.response); resolve(vqSong); } catch (err) { reject(err); }
    };
    x.onerror = () => reject(new Error(`could not read ${VQ_FILE}`));
    x.send();
  });
}

// ---------------------------------------------------------------------------
// The synth: one small voice per kind of General MIDI instrument, and drums.
// ---------------------------------------------------------------------------
const vqFreq = (n) => 440 * 2 ** ((n - 69) / 12);

function vqNoise(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// The output: a master level, an echo that the voices send into (a dotted
// eighth at the song's tempo, darker with each repeat), and a compressor so
// that the loud moments do not clip.
function vqBus(ctx, level) {
  const out = ctx.createGain();
  out.gain.value = level;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 4;
  out.connect(comp).connect(ctx.destination);
  const fx = ctx.createGain();
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.405;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.32;
  const dark = ctx.createBiquadFilter();
  dark.type = 'lowpass';
  dark.frequency.value = 2400;
  const wet = ctx.createGain();
  wet.gain.value = 0.55;
  fx.connect(delay).connect(dark).connect(feedback).connect(delay);
  dark.connect(wet).connect(out);
  return { out, fx };
}

// A voice: oscillators through a low-pass filter (with its own envelope) and
// an amplitude envelope, some of it sent to the echo.
function vqTone(s, n, t, { waves, detune = 0, cutoff = 3000, filterEnv = 0, q = 0.7, attack = 0.005, decay = 0.2, sustain = 0.6, release = 0.12, gain = 0.2, send = 0 }) {
  const { ctx, out } = s;
  const f = vqFreq(n.note);
  const end = Math.max(t + attack, t + n.dur);
  const env = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = q;
  lp.frequency.setValueAtTime(Math.min(16000, cutoff + filterEnv), t);
  if (filterEnv) lp.frequency.setTargetAtTime(cutoff, t, decay / 2.5);
  const peak = gain * (0.5 + 0.5 * n.vel);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + attack);
  env.gain.setTargetAtTime(peak * sustain, t + attack, decay / 3);
  env.gain.setTargetAtTime(0, end, release / 3);
  lp.connect(env).connect(out);
  s.nodes += 2;
  if (send && s.fx) {
    const g = ctx.createGain();
    g.gain.value = send;
    env.connect(g).connect(s.fx);
    s.nodes++;
  }
  const stopAt = end + release * 2;
  waves.forEach((type, i) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (waves.length > 1) o.detune.value = (i - (waves.length - 1) / 2) * detune;
    o.connect(lp);
    o.start(t);
    o.stop(stopAt);
    s.nodes++;
  });
}

// A flute: a nearly pure tone (the fundamental and a little of the next two
// harmonics) with a short breathy swell at the start of each note, held at
// full level for as long as the note lasts, and let go quickly and softly.
// Longer notes get a gentle vibrato after a moment, as a player adds it.
function vqFlute(s, n, t, { gain = 0.2, send = 0 }) {
  const { ctx, out } = s;
  const f = vqFreq(n.note);
  const attack = Math.min(0.04, Math.max(0.012, n.dur * 0.3));
  const end = Math.max(t + attack, t + n.dur);
  const release = 0.07;
  const peak = gain * (0.6 + 0.4 * n.vel);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + attack);
  env.gain.setValueAtTime(peak, end);
  env.gain.setTargetAtTime(0, end, release / 3);
  env.connect(out);
  s.nodes++;
  if (send && s.fx) {
    const g = ctx.createGain();
    g.gain.value = send;
    env.connect(g).connect(s.fx);
    s.nodes++;
  }
  s.fluteWave ??= ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.22, 0.07]));
  const o = ctx.createOscillator();
  o.setPeriodicWave(s.fluteWave);
  o.frequency.value = f;
  o.connect(env);
  const stopAt = end + release * 3;
  if (n.dur > 0.35) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 5.2;
    depth.gain.setValueAtTime(0, t);
    depth.gain.setValueAtTime(0, t + 0.18);
    depth.gain.linearRampToValueAtTime(f * 0.005, t + 0.5);
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t);
    lfo.stop(stopAt);
    s.nodes += 2;
  }
  o.start(t);
  o.stop(stopAt);
  s.nodes++;
  // The breath: a puff of noise around the note at its start, and a trace
  // of it under the tone.
  const src = ctx.createBufferSource();
  src.buffer = s.noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(9000, f * 2);
  bp.Q.value = 1.5;
  const air = ctx.createGain();
  air.gain.setValueAtTime(0, t);
  air.gain.linearRampToValueAtTime(peak * 0.9, t + attack * 0.6);
  air.gain.setTargetAtTime(peak * 0.12, t + attack * 0.6, 0.03);
  air.gain.setValueAtTime(peak * 0.12, end);
  air.gain.setTargetAtTime(0, end, release / 3);
  src.connect(bp).connect(air).connect(env);
  src.start(t, Math.random() * 0.5);
  src.stop(stopAt);
  s.nodes += 3;
}

// General MIDI program to a voice. The file names its instruments loosely
// (the lead is a "flute", and plays as one), so the others aim at the
// record: warm chords under the flute, a round bass, and a plucked low line
// when it comes in. Gains were set by measuring each
// part's loudness in a render.
function vqVoice(s, n, t) {
  const prog = s.song.programs[n.ch];
  if (n.ch === 9) return vqDrum(s, n, t);
  // The lead: the melody, and later its chords.
  if (prog >= 72 && prog <= 79) return vqFlute(s, n, t, { gain: 0.15, send: 0.2 });
  // The chords: a soft keyboard, a sawtooth and a slow pad on the same notes.
  if (prog <= 7) return vqTone(s, n, t, { waves: ['triangle', 'sawtooth'], detune: 5, cutoff: 900, filterEnv: 1600, decay: 0.9, sustain: 0.45, release: 0.4, gain: 0.09, send: 0.2 });
  if (prog === 81) return vqTone(s, n, t, { waves: ['sawtooth', 'sawtooth'], detune: 10, cutoff: 1300, attack: 0.03, decay: 0.4, sustain: 0.8, release: 0.3, gain: 0.06, send: 0.25 });
  if (prog >= 88 && prog <= 95) return vqTone(s, n, t, { waves: ['sawtooth', 'sawtooth', 'triangle'], detune: 16, cutoff: 1000, attack: 0.25, decay: 0.8, sustain: 0.85, release: 0.8, gain: 0.056, send: 0.3 });
  // The bass: long, round notes.
  if (prog >= 32 && prog <= 39) return vqTone(s, n, t, { waves: ['sawtooth', 'sine'], cutoff: 240, filterEnv: 500, q: 1.2, attack: 0.01, decay: 0.35, sustain: 0.8, release: 0.12, gain: 0.1 });
  // The low plucked line.
  if (prog >= 80 && prog <= 87) return vqTone(s, n, t, { waves: ['sawtooth', 'square'], detune: 6, cutoff: 260, filterEnv: 2400, q: 4, attack: 0.002, decay: 0.12, sustain: 0.12, release: 0.08, gain: 0.18, send: 0.12 });
  return vqTone(s, n, t, { waves: ['square'], cutoff: 2000, decay: 0.2, sustain: 0.4, gain: 0.08 });
}

function vqDrum(s, n, t) {
  const { ctx, out } = s;
  const v = 1.25 * (0.4 + 0.6 * n.vel);
  const hit = (dur, gain) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    g.connect(out);
    s.nodes++;
    return g;
  };
  const noise = (dur, gain, type, freq, qv = 0.8) => {
    const src = ctx.createBufferSource();
    src.buffer = s.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = qv;
    src.connect(f).connect(hit(dur, gain));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
    s.nodes += 2;
  };
  const thump = (from, to, dur, gain) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
    o.connect(hit(dur, gain));
    o.start(t);
    o.stop(t + dur + 0.02);
    s.nodes++;
  };
  const k = n.note;
  if (k === 35 || k === 36) { thump(150, 45, 0.35, 0.9); s.onKick?.(t); }
  else if (k === 38 || k === 40) { noise(0.18, 0.45, 'highpass', 1500); thump(220, 160, 0.1, 0.35); }
  else if (k === 37 || k === 39) noise(0.15, 0.5, 'bandpass', 1200, 1.2);
  else if (k === 42 || k === 44) noise(0.05, 0.22, 'highpass', 8000);
  else if (k === 46) noise(0.3, 0.2, 'highpass', 7000);
  else if (k === 49 || k === 52 || k === 55 || k === 57) noise(1.2, 0.18, 'highpass', 5000);
  else if (k === 51 || k === 53 || k === 59) noise(0.5, 0.1, 'bandpass', 6000, 2);
  else if (k >= 41 && k <= 50) thump(vqFreq(k + 12), vqFreq(k), 0.3, 0.5);
  else noise(0.08, 0.15, 'bandpass', 3000);
}

// ---------------------------------------------------------------------------
// Playing: notes are scheduled a little ahead, so the timer can be lazy.
// ---------------------------------------------------------------------------
// Well ahead, so that a busy moment on the main thread drops no notes.
const VQ_AHEAD = 1.2;

function vqLevel() { return 0.75 * sounds.volume; }

function vqPill(text) {
  const pill = el('div', { className: 'vq-pill', role: 'status' });
  pill.append(el('span', { className: 'vq-dot', ariaHidden: 'true' }), el('span', { textContent: text }));
  document.body.append(pill);
  requestAnimationFrame(() => pill.classList.add('shown'));
  return pill;
}
function vqDropPill(pill) {
  if (!pill) return;
  pill.classList.remove('shown');
  setTimeout(() => pill.remove(), 400);
}

// The lead lights a square of the board: the note picks the file, and the
// rank climbs with each note, so it ripples across the board.
function vqGlow(s, n, t) {
  if (s.still) return;
  s.step = (s.step + 1) % 8;
  const sq = document.querySelector(`#board .square[data-sq="${'abcdefgh'[n.note % 8]}${s.step + 1}"]`);
  if (!sq) return;
  const wait = Math.max(0, (t - s.ctx.currentTime) * 1000);
  setTimeout(() => {
    if (vq !== s) return;
    sq.animate([
      { boxShadow: 'inset 0 0 0 100vmax color-mix(in srgb, var(--accent) 55%, transparent)' },
      { boxShadow: 'inset 0 0 0 100vmax transparent' },
    ], { duration: 650, easing: 'ease-out' });
  }, wait);
}

function vqTick() {
  const s = vq;
  if (!s) return;
  // The sounds were turned off (M, the speaker, Settings): stop.
  if (!sounds.enabled || sounds.volume === 0) { vqStop(); return; }
  s.out.gain.setTargetAtTime(vqLevel(), s.ctx.currentTime, 0.05);
  const now = s.ctx.currentTime - s.t0;
  const notes = s.song.notes;
  while (s.next < notes.length && notes[s.next].t < now + VQ_AHEAD) {
    const n = notes[s.next++];
    const at = s.t0 + n.t;
    if (at < s.ctx.currentTime - 0.05) continue; // fell behind (the window was asleep): skip it
    try { vqVoice(s, n, Math.max(at, s.ctx.currentTime)); s.scheduled++; } catch { /* a bad note */ }
    if (n.ch === s.lead) vqGlow(s, n, at);
  }
  if (s.next >= notes.length && now > s.song.length + 0.8) vqStop();
}

async function vqStart() {
  if (vq) return;
  if (!sounds.enabled || sounds.volume === 0) {
    const pill = vqPill('Veridis Quo · turn Sounds on (M) to hear it');
    setTimeout(() => vqDropPill(pill), 2600);
    return;
  }
  let song;
  try { song = await vqLoad(); } catch (err) { console.warn('veridis:', err); return; }
  if (vq) return;
  let ctx;
  try { ctx = new AudioContext(); } catch { return; }
  const { out, fx } = vqBus(ctx, vqLevel());
  // The busiest channel is the lead, which lights the board.
  const counts = new Map();
  for (const n of song.notes) if (n.ch !== 9) counts.set(n.ch, (counts.get(n.ch) ?? 0) + 1);
  const lead = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const s = {
    ctx, out, fx, song, lead, noise: vqNoise(ctx), next: 0, step: -1, scheduled: 0, nodes: 0,
    t0: ctx.currentTime + 0.15,
    still: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    pill: vqPill('Veridis Quo · Daft Punk — Esc to stop'),
  };
  const dot = s.pill.querySelector('.vq-dot');
  s.onKick = (t) => {
    if (s.still) return;
    setTimeout(() => { if (vq === s) dot.animate([{ transform: 'scale(1.8)', opacity: 1 }, { transform: 'scale(1)', opacity: 0.7 }], { duration: 300, easing: 'ease-out' }); }, Math.max(0, (t - ctx.currentTime) * 1000));
  };
  vq = s;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  vqTick();
  s.timer = setInterval(vqTick, 100);
}

function vqStop() {
  const s = vq;
  if (!s) return;
  vq = null;
  clearInterval(s.timer);
  try {
    s.out.gain.cancelScheduledValues(s.ctx.currentTime);
    s.out.gain.setTargetAtTime(0, s.ctx.currentTime, 0.04);
  } catch { /* closed already */ }
  setTimeout(() => s.ctx.close().catch(() => {}), 300);
  vqDropPill(s.pill);
}

window.veridis = {
  start: vqStart,
  stop: vqStop,
  toggle: () => (vq ? vqStop() : vqStart()),
  // For tests and debugging.
  seek(sec) {
    if (!vq) return;
    vq.t0 = vq.ctx.currentTime - sec;
    vq.next = vq.song.notes.findIndex((n) => n.t >= sec);
    if (vq.next < 0) vq.next = vq.song.notes.length;
  },
  get state() {
    return vq
      ? { playing: true, audio: vq.ctx.state, at: vq.ctx.currentTime - vq.t0, length: vq.song.length, scheduled: vq.scheduled, nodes: vq.nodes, notes: vq.song.notes.length }
      : { playing: false };
  },
};

// The trigger, and the ways to stop it.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (vq && e.key === 'Escape' && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    vqStop();
    return;
  }
  // U is the music key: while this plays, it stops this instead.
  if (vq && (e.key === 'u' || e.key === 'U') && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    vqStop();
    return;
  }
  if (e.key.length !== 1) return;
  vqTyped = (vqTyped + e.key.toLowerCase()).slice(-VQ_WORD.length);
  if (vqTyped === VQ_WORD) { vqTyped = ''; window.veridis.toggle(); }
}, true);

// The music button, likewise.
window.addEventListener('click', (e) => {
  if (!vq || !(e.target instanceof Element) || !e.target.closest('#btn-music')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  vqStop();
}, true);
