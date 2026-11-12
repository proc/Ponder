// Game sounds, synthesised with the Web Audio API: no audio files needed.
// Two voices follow the theme: "wood" (soft clicks and chimes, for the
// minimalist theme) and "synth" (short electronic blips, for cyberpunk).
'use strict';

const sounds = (() => {
  let ctx = null;
  let master = null;
  let enabled = true;
  let volume = 0.7;
  let voice = 'wood';
  const log = []; // the last few sounds played, newest last (for tests and debugging)
  // Output level per voice, so both sound about as loud at the same volume.
  const level = { wood: 2.4, synth: 5 };

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
    master.gain.value = volume * level[voice];
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

  // Each sound in both voices. Times are in seconds from now.
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
    },
  };

  load();
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
          voices[voiceName][name]();
          delete offline.currentTime;
        }
      } finally {
        [ctx, master, voice] = saved;
      }
      return offline.startRendering();
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
