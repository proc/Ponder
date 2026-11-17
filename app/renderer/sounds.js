// Game sounds, synthesised with the Web Audio API: no audio files needed.
// Three voices follow the theme: "wood" (soft clicks and chimes, for the
// minimalist theme), "synth" (short electronic blips, for cyberpunk) and
// "arcade" (a 1990s 16-bit arcade fighting game: FM brass, punches, for dusk).
'use strict';

const sounds = (() => {
  let ctx = null;
  let master = null;
  let fxRoute = null; // while a capture effect's sound is set up: the main output, master being its own level
  let enabled = true;
  let volume = 0.7;
  let voice = 'wood';
  const log = []; // the last few sounds played, newest last (for tests and debugging)
  // Output level per voice, so both sound about as loud at the same volume.
  const level = { wood: 2.4, synth: 5, arcade: 1.8 };

  // Master gain, then a compressor so that loud moments do not clip.
  function connectOutput(c) {
    const gain = c.createGain();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 6;
    comp.ratio.value = 8;
    gain.connect(comp).connect(c.destination);
    return gain;
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem('sound') ?? 'null');
      if (saved) {
        enabled = saved.enabled !== false;
        if (typeof saved.volume === 'number') volume = Math.min(1, Math.max(0, saved.volume));
      }
    } catch { /* storage unavailable */ }
  }
  function save() {
    try { localStorage.setItem('sound', JSON.stringify({ enabled, volume })); } catch { /* ignore */ }
  }

  function audio() {
    if (!ctx) {
      ctx = new AudioContext();
      master = connectOutput(ctx);
    }
    if (ctx instanceof AudioContext && ctx.state === 'suspended') ctx.resume();
    if (!fxRoute) master.gain.value = volume * level[voice];
    return ctx;
  }

  // A pitched note with a quick attack and exponential decay.
  function tone(freq, start, dur, { type = 'sine', gain = 0.3, slideTo = null } = {}) {
    const c = audio();
    const t = c.currentTime + start;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // A filtered noise burst: the "tock" of a piece on a board.
  let noiseBuffer = null;
  function knock(start, { freq = 1700, q = 1.2, gain = 0.5, dur = 0.07, body = 170 } = {}) {
    const c = audio();
    if (!noiseBuffer) {
      noiseBuffer = c.createBuffer(1, c.sampleRate * 0.2, c.sampleRate);
      const d = noiseBuffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = c.currentTime + start;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = dur > 0.18; // the buffer is short: longer bursts go round it
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = q;
    const env = c.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(band).connect(env).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
    if (body) tone(body, start, dur * 1.4, { gain: gain * 0.5 });
  }

  // The versus screen: a 1990s arcade fighting game's "here they come". A
  // thud and a whoosh as the cards fly in, three square-wave power chords
  // stepping upward, and on the last a cymbal crash, a bright arpeggio and a
  // held chord with a slow shimmer. k scales it to the voice's output level.
  function versus(k) {
    const chord = (root, at, dur, gain) => {
      for (const [mul, type] of [[0.5, 'square'], [1, 'square'], [1.498, 'square'], [2.007, 'sawtooth']]) {
        tone(root * mul, at, dur, { type, gain: gain * k });
      }
    };
    tone(150, 0, 0.45, { gain: 0.5 * k, slideTo: 36 });
    knock(0, { freq: 900, q: 0.4, gain: 0.3 * k, dur: 0.3, body: 0 });
    tone(90, 0, 0.3, { type: 'sawtooth', gain: 0.05 * k, slideTo: 700 });
    chord(164.81, 0.02, 0.24, 0.085);  // E
    chord(174.61, 0.28, 0.24, 0.085);  // F
    chord(196.0, 0.54, 1.25, 0.1);     // G, held
    tone(120, 0.54, 0.5, { gain: 0.45 * k, slideTo: 40 });
    knock(0.54, { freq: 6500, q: 0.3, gain: 0.3 * k, dur: 0.75, body: 0 });
    [783.99, 987.77, 1174.66, 1567.98, 2349.32].forEach((f, i) => {
      tone(f, 0.56 + i * 0.055, 0.16, { type: 'square', gain: 0.05 * k });
    });
    tone(1567.98, 0.86, 0.9, { type: 'square', gain: 0.035 * k, slideTo: 1580 });
    tone(1574, 0.86, 0.9, { type: 'square', gain: 0.03 * k });
  }

  // The arcade voice's instruments: what a 16-bit arcade board of the early
  // 1990s had. FM synthesis (a sine bent by another sine, brightest at the
  // attack) for the brass, bass and bells, and noise for punches and swings.
  function fm(freq, start, dur, { ratio = 1, index = 2, gain = 0.1, slideTo = null, hold = 0.55, bright = 0.3 } = {}) {
    const c = audio();
    const t = c.currentTime + start;
    const car = c.createOscillator();
    const mod = c.createOscillator();
    const depth = c.createGain();
    const env = c.createGain();
    car.frequency.setValueAtTime(freq, t);
    mod.frequency.setValueAtTime(freq * ratio, t);
    if (slideTo) {
      car.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      mod.frequency.exponentialRampToValueAtTime(slideTo * ratio, t + dur);
    }
    const peak = index * freq * ratio;
    depth.gain.setValueAtTime(peak, t);
    depth.gain.exponentialRampToValueAtTime(Math.max(1, peak * bright), t + dur);
    mod.connect(depth).connect(car.frequency);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * hold), t + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    car.connect(env).connect(master);
    for (const o of [car, mod]) { o.start(t); o.stop(t + dur + 0.02); }
  }
  let longNoise = null;
  function noiseThrough(start, dur, type, from, to, q, shape) {
    const c = audio();
    if (!longNoise) {
      longNoise = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = longNoise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = c.currentTime + start;
    const src = c.createBufferSource();
    src.buffer = longNoise;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    const env = c.createGain();
    shape(env.gain, t);
    src.connect(filter).connect(env).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
  // A swing through the air: band-passed noise sweeping up or down.
  const whoosh = (start, dur, from, to, gain) => noiseThrough(start, dur, 'bandpass', from, to, 1.4, (g, t) => {
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(gain, t + dur * 0.45);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  });
  // A blow landing: a burst of noise closing down fast, over a falling thump.
  function impact(start, { gain = 0.5, dur = 0.18, from = 5200, to = 380, low = 170 } = {}) {
    noiseThrough(start, dur, 'lowpass', from, to, 0.7, (g, t) => {
      g.setValueAtTime(gain, t);
      g.exponentialRampToValueAtTime(0.0001, t + dur);
    });
    if (low) tone(low, start, dur * 1.3, { gain: gain * 0.9, slideTo: low * 0.28 });
  }
  // A crash cymbal.
  const crash = (start, dur, gain) => noiseThrough(start, dur, 'highpass', 5200, 3800, 0.5, (g, t) => {
    g.setValueAtTime(gain, t);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  });
  // The knockout: the heaviest blow, a flash of cymbal, and a falling cry
  // that echoes three times, each fainter and lower.
  function ko() {
    impact(0, { gain: 0.75, dur: 0.42, from: 7000, to: 260, low: 140 });
    crash(0, 0.5, 0.16);
    fm(70, 0, 0.3, { ratio: 1.41, index: 8, gain: 0.12, bright: 0.08 });
    [[0.04, 1, 0.11], [0.3, 0.9, 0.06], [0.54, 0.8, 0.032]].forEach(([at, pitch, gain]) => {
      fm(560 * pitch, at, 0.26, { ratio: 2, index: 2.4, gain, slideTo: 300 * pitch, bright: 0.5 });
      fm(840 * pitch, at, 0.26, { ratio: 1, index: 1.2, gain: gain * 0.5, slideTo: 430 * pitch });
      impact(at, { gain: gain * 2.2, dur: 0.1, from: 3000, to: 500, low: 0 });
    });
  }
  // FM brass (each note doubled, slightly apart), bass and bell.
  const brass = (notes, at, dur, gain = 0.07) => notes.forEach((f) => {
    fm(f, at, dur, { index: 2.6, gain, bright: 0.4 });
    fm(f * 1.007, at, dur, { index: 2.1, gain: gain * 0.6, bright: 0.4 });
  });
  const fbass = (f, at, dur, gain = 0.15) => fm(f, at, dur, { index: 3.4, gain, bright: 0.12 });
  const bell = (f, at, dur, gain = 0.07) => fm(f, at, dur, { ratio: 3.5, index: 1.5, gain, bright: 0.04, hold: 0.22 });

  // The 3D board's capture effects (board3d.js): what travels with the piece
  // taking (trail, for dur seconds) and the burst where it lands. They
  // sound the same in every voice.
  // A held note: a soft attack, held, and let go.
  function pad(freq, start, dur, { type = 'sine', gain = 0.1, slideTo = null, attack = 0.05 } = {}) {
    const c = audio();
    const t = c.currentTime + start;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(attack, dur * 0.5));
    env.gain.setValueAtTime(gain, t + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  // Noise swelling and fading through a filter (a roar, a hiss, wind).
  const swell = (start, dur, type, from, to, gain, q = 0.7) => noiseThrough(start, dur, type, from, to, q, (g, t) => {
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(gain, t + Math.min(0.08, dur * 0.3));
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  });
  const rnd = (a, b) => a + Math.random() * (b - a);
  // Little ticks scattered over a span: crackling fire, ice, electricity.
  const crackle = (start, dur, n, freq, gain) => {
    for (let i = 0; i < n; i++) knock(start + Math.random() * dur, { freq: freq * rnd(0.7, 1.4), q: 3, gain: gain * rnd(0.4, 1), dur: rnd(0.008, 0.025), body: 0 });
  };
  // Tiny high notes: glass, ice, sparkles.
  const tinkle = (start, dur, n, lo, hi, gain) => {
    for (let i = 0; i < n; i++) tone(rnd(lo, hi), start + Math.random() * dur, rnd(0.05, 0.18), { gain: gain * rnd(0.4, 1) });
  };
  const FX_SOUNDS = {
    fire: {
      trail: (d) => { swell(0, d + 0.15, 'lowpass', 400, 1600, 0.6); crackle(0, d, 14, 2600, 0.35); },
      burst: () => {
        impact(0, { gain: 0.55, dur: 0.35, from: 2400, to: 160, low: 80 });  // the whoomp of it catching
        swell(0.02, 1.3, 'lowpass', 1800, 220, 0.4);                        // the roar
        crackle(0.05, 1.1, 26, 2400, 0.3);
      },
    },
    plasma: {
      trail: (d) => { pad(520, 0, d + 0.1, { gain: 0.05, slideTo: 1040 }); pad(523 * 1.5, 0, d + 0.1, { gain: 0.03, slideTo: 1560 }); tinkle(0, d, 8, 1800, 3600, 0.05); },
      burst: () => {
        [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568].forEach((f, i) => bell(f, i * 0.045, 0.9, 0.035));
        pad(1200, 0, 0.7, { type: 'triangle', gain: 0.05, slideTo: 300 });     // a falling "wahh"
        tone(90, 0, 0.4, { gain: 0.3, slideTo: 45 });
        swell(0, 0.9, 'bandpass', 3000, 7000, 0.08, 3);                         // shimmer
      },
    },
    shadows: {
      // A whoosh for each afterimage left behind.
      trail: (d) => { const n = Math.max(3, Math.round(d / 0.08)); for (let i = 0; i < n; i++) whoosh(i * d / n, 0.16, 300, 1100, 0.4); },
      burst: () => {
        fm(55, 0, 1.1, { ratio: 1.5, index: 5, gain: 0.09, bright: 0.2 });       // a dark swell
        [440, 415.3, 349.2, 311.1].forEach((f, i) => fm(f, 0.05 + i * 0.12, 0.5, { ratio: 1.01, index: 1.4, gain: 0.04, slideTo: f * 0.94 }));
        whoosh(0, 0.5, 2000, 250, 0.3);
        impact(0, { gain: 0.35, dur: 0.25, from: 1500, to: 120, low: 60 });
      },
    },
    sparks: {
      trail: (d) => { pad(110, 0, d + 0.08, { type: 'sawtooth', gain: 0.035 }); pad(113, 0, d + 0.08, { type: 'square', gain: 0.02 }); crackle(0, d, 18, 5000, 0.22); },
      burst: () => {
        pad(2600, 0, 0.22, { type: 'sawtooth', gain: 0.07, slideTo: 70, attack: 0.005 });  // the zap
        impact(0, { gain: 0.45, dur: 0.2, from: 9000, to: 600, low: 0 });
        crackle(0.02, 0.6, 30, 6000, 0.3);
        tone(70, 0, 0.3, { gain: 0.3, slideTo: 40 });
      },
    },
    frost: {
      trail: (d) => { swell(0, d + 0.3, 'highpass', 5000, 7000, 0.12); tinkle(0, d, 6, 3000, 5200, 0.04); },
      burst: () => {
        swell(0, 1.4, 'bandpass', 1200, 400, 0.18, 1.2);                       // a cold wind
        [1975.5, 2349.3, 2637, 3136, 3951].forEach((f, i) => bell(f, 0.02 + i * 0.07, 1, 0.035));
        tinkle(0.05, 0.8, 12, 3500, 7000, 0.035);
      },
    },
    ice: {
      // Ice forming along the way: creaks and a rising whistle.
      trail: (d) => { crackle(0, d, 14, 1400, 0.3); pad(1800, 0, d + 0.1, { gain: 0.025, slideTo: 3600 }); },
      burst: () => {
        crackle(0, 0.28, 10, 1100, 0.35);                                        // it freezes over, creaking
        impact(0.3, { gain: 0.6, dur: 0.16, from: 9000, to: 1200, low: 0 });     // and cracks
        knock(0.3, { freq: 3200, q: 0.8, gain: 0.4, dur: 0.12, body: 0 });
        tinkle(0.31, 0.7, 28, 2500, 8000, 0.05);                                // shards everywhere
        crackle(0.32, 0.6, 16, 4500, 0.2);
      },
    },
  };

  // Each sound in every voice. Times are in seconds from now.
  const voices = {
    wood: {
      move: () => knock(0),
      capture: () => { knock(0, { freq: 1300, gain: 0.7, body: 130 }); knock(0.045, { freq: 2200, gain: 0.35, body: 0 }); },
      castle: () => { knock(0); knock(0.11, { freq: 1500 }); },
      promote: () => { knock(0); [523, 659, 784].forEach((f, i) => tone(f, 0.06 + i * 0.07, 0.25, { gain: 0.16 })); },
      check: () => { knock(0, { gain: 0.45 }); tone(988, 0.04, 0.18, { gain: 0.22 }); tone(1319, 0.12, 0.26, { gain: 0.2 }); },
      start: () => { tone(523, 0, 0.3, { gain: 0.18 }); tone(784, 0.1, 0.45, { gain: 0.18 }); },
      win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.6, { gain: 0.18 })),
      loss: () => [440, 349, 294].forEach((f, i) => tone(f, i * 0.16, 0.7, { gain: 0.2 })),
      draw: () => { tone(587, 0, 0.5, { gain: 0.18 }); tone(587, 0.18, 0.6, { gain: 0.14 }); },
      end: () => [392, 523, 659].forEach((f) => tone(f, 0, 1.0, { gain: 0.12 })),
      lowtime: () => { tone(1568, 0, 0.07, { gain: 0.16 }); tone(1568, 0.16, 0.07, { gain: 0.16 }); },
      illegal: () => tone(196, 0, 0.12, { type: 'triangle', gain: 0.22, slideTo: 160 }),
      challenge: () => { tone(784, 0, 0.18, { gain: 0.16 }); tone(1175, 0.12, 0.3, { gain: 0.16 }); },
      // A ponder hit: a bright two-note rise, just after the move's own sound.
      ponderhit: () => { tone(1319, 0.1, 0.12, { gain: 0.15 }); tone(1976, 0.19, 0.3, { gain: 0.17 }); },
      versus: () => versus(0.75),
    },
    synth: {
      move: () => tone(660, 0, 0.07, { type: 'square', gain: 0.09, slideTo: 880 }),
      capture: () => { tone(330, 0, 0.12, { type: 'sawtooth', gain: 0.12, slideTo: 110 }); knock(0, { freq: 3000, gain: 0.25, body: 0, dur: 0.05 }); },
      castle: () => { tone(660, 0, 0.06, { type: 'square', gain: 0.09 }); tone(990, 0.09, 0.07, { type: 'square', gain: 0.09 }); },
      promote: () => [440, 660, 880, 1320].forEach((f, i) => tone(f, i * 0.05, 0.12, { type: 'square', gain: 0.08 })),
      check: () => { tone(1200, 0, 0.09, { type: 'square', gain: 0.1 }); tone(1200, 0.13, 0.09, { type: 'square', gain: 0.1 }); },
      start: () => { tone(220, 0, 0.35, { type: 'sawtooth', gain: 0.22, slideTo: 880 }); tone(1760, 0.3, 0.12, { type: 'square', gain: 0.07 }); },
      win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.07, 0.2, { type: 'square', gain: 0.08 })),
      loss: () => tone(440, 0, 0.8, { type: 'sawtooth', gain: 0.12, slideTo: 110 }),
      draw: () => { tone(660, 0, 0.15, { type: 'square', gain: 0.08 }); tone(660, 0.2, 0.15, { type: 'square', gain: 0.08 }); },
      end: () => tone(880, 0, 0.6, { type: 'triangle', gain: 0.14, slideTo: 440 }),
      lowtime: () => { tone(2000, 0, 0.04, { type: 'square', gain: 0.07 }); tone(2000, 0.12, 0.04, { type: 'square', gain: 0.07 }); },
      illegal: () => tone(110, 0, 0.12, { type: 'sawtooth', gain: 0.12 }),
      challenge: () => { tone(988, 0, 0.08, { type: 'square', gain: 0.08 }); tone(1480, 0.1, 0.12, { type: 'square', gain: 0.08 }); },
      ponderhit: () => { tone(880, 0.1, 0.06, { type: 'square', gain: 0.07, slideTo: 1760 }); tone(2637, 0.18, 0.14, { type: 'square', gain: 0.06 }); },
      versus: () => versus(0.38),
    },
    // A 1990s arcade fighting game: FM brass stabs over an FM bass, punches
    // and swings made of noise, bells for the small things.
    arcade: {
      // A light jab.
      move: () => { whoosh(0, 0.07, 1400, 3600, 0.12); impact(0.03, { gain: 0.2, dur: 0.06, from: 3800, to: 900, low: 210 }); },
      // A hard kick landing: the swing, a sharp crack, and the body of the
      // blow dropping away under it.
      capture: () => {
        whoosh(0, 0.07, 500, 3200, 0.2);
        crash(0.055, 0.05, 0.3);
        impact(0.055, { gain: 0.5, dur: 0.2, from: 2600, to: 220, low: 130 });
        fm(310, 0.055, 0.14, { index: 1.6, gain: 0.09, slideTo: 85, bright: 0.2 });
      },
      // A one-two: a light blow, then a solid one.
      castle: () => {
        whoosh(0, 0.06, 900, 2600, 0.13);
        impact(0.04, { gain: 0.24, dur: 0.07, from: 3400, to: 800, low: 200 });
        whoosh(0.13, 0.06, 700, 2200, 0.15);
        impact(0.18, { gain: 0.3, dur: 0.16, from: 3000, to: 300, low: 125 });
      },
      // Charging up a special move.
      promote: () => {
        fm(196, 0, 0.5, { index: 4, gain: 0.1, slideTo: 1568, bright: 0.6 });
        whoosh(0, 0.5, 500, 5000, 0.16);
        brass([784, 988, 1175], 0.5, 0.5, 0.05);
        [1568, 1976, 2349].forEach((f, i) => bell(f, 0.5 + i * 0.06, 0.4, 0.05));
        crash(0.5, 0.5, 0.12);
      },
      // Danger: two hard stabs a tritone apart.
      check: () => { brass([440, 622], 0, 0.11, 0.08); brass([440, 622], 0.14, 0.2, 0.08); fbass(110, 0, 0.3, 0.12); },
      // "Round one — fight!"
      start: () => {
        impact(0, { gain: 0.4, dur: 0.2 });
        brass([294, 349, 440], 0, 0.12); fbass(73.4, 0, 0.13);
        brass([294, 349, 440], 0.15, 0.12); fbass(73.4, 0.15, 0.13);
        impact(0.3, { gain: 0.5, dur: 0.3 }); crash(0.3, 0.7, 0.14);
        brass([392, 466, 587, 784], 0.3, 0.75); fbass(98, 0.3, 0.75);
      },
      // The end of a round, as a fighting game of the time has it: the
      // knockout blow with the cry echoing away (ko), then a short tune of
      // our own for who it went to.
      // "You win": a march of brass stabs up to a held chord.
      win: () => {
        ko();
        const steps = [[[233, 294, 349], 58.3, 0.8, 0.1], [[233, 294, 349], 58.3, 0.93, 0.1], [[311, 392, 466], 77.8, 1.06, 0.2],
          [[349, 440, 523], 87.3, 1.3, 0.2], [[466, 587, 698, 932], 116.5, 1.54, 1.0]];
        for (const [notes, root, at, dur] of steps) { brass(notes, at, dur); fbass(root, at, dur); impact(at, { gain: 0.22, dur: 0.12, low: 90 }); }
        crash(1.54, 0.9, 0.14);
        [932, 1175, 1397, 1865].forEach((f, i) => bell(f, 1.6 + i * 0.07, 0.5, 0.04));
      },
      // "You lose": the brass sinking, slow.
      loss: () => {
        ko();
        brass([294, 349, 440], 0.8, 0.32); fbass(73.4, 0.8, 0.32);
        brass([277, 330, 415], 1.14, 0.32); fbass(69.3, 1.14, 0.32);
        brass([220, 262, 349], 1.48, 1.1); fbass(55, 1.48, 1.1);
        fm(440, 1.48, 1.1, { index: 2, gain: 0.05, slideTo: 110 });
      },
      // "Draw game": the bell, then two level stabs.
      draw: () => {
        bell(988, 0, 0.5, 0.1); bell(988, 0.22, 0.7, 0.1); impact(0, { gain: 0.3, dur: 0.15, low: 110 });
        brass([392, 523, 587], 0.6, 0.14); brass([392, 523, 587], 0.8, 0.6); fbass(98, 0.6, 0.8, 0.12);
      },
      // A game you watched: the knockout, and a short flourish for the winner.
      end: () => {
        ko();
        brass([294, 440, 587], 0.8, 0.12); fbass(73.4, 0.8, 0.13); impact(0.8, { gain: 0.22, dur: 0.12, low: 90 });
        brass([392, 587, 784], 0.96, 0.8); fbass(98, 0.96, 0.8); impact(0.96, { gain: 0.3, dur: 0.2, low: 90 }); crash(0.96, 0.7, 0.12);
      },
      // The timer running down.
      lowtime: () => { bell(1568, 0, 0.12, 0.09); bell(1568, 0.14, 0.12, 0.09); bell(1568, 0.28, 0.2, 0.09); },
      // Blocked.
      illegal: () => { fm(110, 0, 0.17, { ratio: 0.5, index: 6, gain: 0.14, bright: 0.5 }); impact(0, { gain: 0.2, dur: 0.06, from: 2500, to: 500, low: 0 }); },
      // "Here comes a new challenger!"
      challenge: () => {
        whoosh(0, 0.22, 400, 4200, 0.2);
        impact(0.2, { gain: 0.45, dur: 0.22 });
        brass([330, 494, 659], 0.2, 0.14); fbass(82.4, 0.2, 0.15);
        brass([440, 659, 880], 0.38, 0.5); fbass(110, 0.38, 0.5); crash(0.38, 0.5, 0.1);
      },
      // A special move connecting.
      ponderhit: () => { whoosh(0.08, 0.12, 1500, 6000, 0.12); bell(1319, 0.12, 0.12, 0.08); bell(1976, 0.2, 0.45, 0.08); },
      // The versus screen: thud, whoosh, three brass power chords climbing,
      // then the crash and a held chord with bells over it.
      versus: () => {
        impact(0, { gain: 0.6, dur: 0.4, low: 150 }); whoosh(0, 0.3, 300, 3500, 0.2);
        for (const [root, at, dur] of [[164.81, 0.02, 0.22], [174.61, 0.28, 0.22], [196, 0.54, 1.3]]) {
          brass([root, root * 1.498, root * 2, root * 2.997], at, dur, 0.06); fbass(root / 2, at, dur);
        }
        whoosh(0.3, 0.24, 500, 5000, 0.14);
        impact(0.54, { gain: 0.6, dur: 0.45, low: 120 }); crash(0.54, 1.1, 0.18);
        [784, 988, 1175, 1568, 2349].forEach((f, i) => bell(f, 0.58 + i * 0.06, 0.5, 0.045));
      },
    },
  };

  load();
  // Opening the sound output takes a moment (about a fifth of a second on a
  // Mac), which held up the board at the first move that made a sound: done
  // instead while the app is idle after it starts.
  if (enabled) {
    (window.requestIdleCallback ?? ((f) => setTimeout(f, 1500)))(() => {
      try { if (!ctx) { ctx = new AudioContext(); master = connectOutput(ctx); } } catch { /* made at the first sound */ }
    }, { timeout: 4000 });
  }
  return {
    names: Object.keys(voices.wood),
    log,
    get enabled() { return enabled; },
    get volume() { return volume; },
    setEnabled(on) { enabled = !!on; save(); },
    setVolume(v) { volume = Math.min(1, Math.max(0, +v)); save(); },
    setVoice(v) { voice = voices[v] ? v : 'wood'; },
    // Render sounds one after another into an offline context, e.g. to check
    // them or save a preview. Returns the AudioBuffer.
    async render(names, voiceName = voice, gap = 0.9) {
      const sampleRate = 44100;
      const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * gap * names.length + sampleRate), sampleRate);
      const saved = [ctx, master, voice];
      ctx = offline;
      master = connectOutput(offline);
      voice = voiceName;
      try {
        for (const [i, name] of names.entries()) {
          // Schedule each sound at its slot by shifting "now" for the helpers.
          const at = i * gap;
          const real = offline.currentTime;
          Object.defineProperty(offline, 'currentTime', { value: real + at, configurable: true });
          // "fx-fire-trail", "fx-ice-burst": a capture effect's sound.
          const fx = name.match(/^fx-(\w+)-(trail|burst)$/);
          if (fx) FX_SOUNDS[fx[1]][fx[2]](0.4);
          else voices[voiceName][name]();
          delete offline.currentTime;
        }
      } finally {
        [ctx, master, voice] = saved;
      }
      return offline.startRendering();
    },
    // A capture effect's sound on the 3D board: its trail (for dur seconds)
    // or its burst.
    captureFx(name, part, dur = 0) {
      log.push(`fx-${name}-${part}`);
      if (log.length > 50) log.shift();
      if (!enabled || volume === 0) return;
      try {
        const c = audio();
        // The same loudness in every voice: its own level into the output.
        const node = c.createGain();
        node.gain.value = 0.75 * level.wood / level[voice];
        node.connect(master);
        fxRoute = master;
        master = node;
        try { FX_SOUNDS[name]?.[part]?.(dur); } finally { master = fxRoute; fxRoute = null; }
        setTimeout(() => node.disconnect(), (dur + 3) * 1000);
      } catch { /* no audio device: stay silent */ }
    },
    play(name) {
      log.push(name);
      if (log.length > 50) log.shift();
      if (!enabled || volume === 0) return;
      try {
        (voices[voice][name] ?? voices.wood[name])?.();
      } catch { /* no audio device: stay silent */ }
    },
  };
})();
