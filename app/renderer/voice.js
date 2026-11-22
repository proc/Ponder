'use strict';
/* global voiceParse, Vosk */
// Voice commands: with the microphone button on (or T), say a move
// ("knight f3", "e2 e4", "castle kingside") or a command ("undo", "flip
// board", "new game", "resign", "offer draw", "stop listening").
//
// Speech is recognised on this computer by Vosk (vendor/vosk), limited to
// the words of chess, so no audio leaves it. The model (about 40 MB) is
// downloaded once, after asking, into Ponder's data folder (main.js).
// What was heard goes through voiceParse (voice-parse.js) to a legal move.

const voice = (() => {
  const btn = $('#btn-voice');
  const SAMPLE_RATE = 16000;
  let on = false;
  let starting = false;
  let rec = null; // { stop() }
  let model = null; // the Vosk model, kept once loaded

  function sync() {
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('listening', on && !starting);
    btn.classList.toggle('loading', starting);
    btn.title = starting ? 'Voice commands: starting the microphone…'
      : on ? 'Listening: say a move, such as “knight f3”. Click to stop (T)'
        : 'Voice commands are off: click to say your moves (T)';
  }

  const show = (title, text, kind = 'voice') => {
    notify(text, { title, kind, ms: kind === 'voice' ? 3500 : 6000 });
    setStatus(title ? `${title}: ${text}` : text);
  };

  // The legal moves of the position on the board.
  async function legalMoves(fen) {
    if (state?.humanToMove && isLive() && !puzzleView) return state.legalMoves ?? [];
    try { return (await api.backend('positionInfo', { fen })).legal ?? []; } catch { return []; }
  }

  // A visible game-action button (Resign, Draw, Takeback) on a player bar.
  const actionButton = (cls) => {
    const shown = [...document.querySelectorAll(`.player .${cls}`)].filter((b) => !b.hidden);
    return shown.find((b) => b.dataset.side && b.dataset.side === humanSide()) ?? shown.find((b) => b.dataset.side === state?.turn) ?? shown[0];
  };

  const COMMANDS = {
    stop: () => { setOn(false); return 'Stopped listening.'; },
    undo: () => {
      const b = actionButton('takeback');
      if (!b && !state?.canTakeback) return { fail: 'There is no move to take back.' };
      if (b) b.click(); else takeback();
      return 'Took back the last move.';
    },
    flip: () => { $('#btn-flip').click(); return 'Flipped the board.'; },
    newGame: () => { $('#btn-new').click(); return 'Opened New game.'; },
    resign: () => {
      const b = actionButton('resign');
      if (!b) return { fail: 'There is no game to resign.' };
      b.click();
      return 'Asked to confirm resigning.';
    },
    draw: () => {
      const b = actionButton('draw');
      if (!b) return { fail: 'A draw cannot be offered in this game.' };
      b.click();
      return 'Asked to confirm the draw.';
    },
  };

  // What to do with the words heard. Returns what happened, for tests.
  async function hear(text) {
    text = String(text ?? '').trim();
    if (!text || !state) return null;
    const heard = `Heard “${text}”`;
    if (document.querySelector('dialog:modal')) {
      // Only "stop listening" works while a dialog is open.
      if (voiceParse.parse(text, '8/8/8/8/8/8/8/8 w - - 0 1', []).name === 'stop') COMMANDS.stop();
      return null;
    }
    const fen = shownFen();
    const r = voiceParse.parse(text, fen, await legalMoves(fen));
    if (r.kind === 'command') {
      const out = COMMANDS[r.name]();
      if (out?.fail) { show(heard, out.fail, 'warn'); return { ...r, ok: false, message: out.fail }; }
      show(heard, out);
      return { ...r, ok: true, message: out };
    }
    if (r.kind === 'none') { show(heard, r.message, 'warn'); return { ...r, ok: false }; }
    if (!canMove()) {
      const message = premoveMode() ? 'It is not your turn yet.' : 'You cannot move on the board right now.';
      show(heard, message, 'warn');
      return { ...r, ok: false, message };
    }
    const message = `Played ${voiceParse.describe(r.uci, fen)}.`;
    selected = null;
    await playMove(r.uci);
    show(heard, message);
    return { ...r, ok: true, message };
  }

  // -------------------------------------------------------------------------
  // Recognition
  // -------------------------------------------------------------------------
  // Vosk itself (5.8 MB) is read only when voice commands are first used.
  const loadVosk = () => (loadVosk.p ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/vosk/vosk.js';
    s.onload = resolve;
    s.onerror = () => { loadVosk.p = null; reject(new Error('The speech recogniser could not be loaded.')); };
    document.head.append(s);
  }));

  async function loadModel() {
    if (model) return model;
    let st = await api.voice.status();
    if (!st.installed) {
      const ok = await confirmDialog(
        `Voice commands need a speech model, recognised on this computer so that no audio leaves it. Download it now? It is about ${st.downloadMB} MB, from alphacephei.com (Vosk), and is kept in Ponder's data folder.`,
        'Download');
      if (!ok) return null;
      setStatus('Downloading the speech model…');
      const off = api.voice.onProgress((p) => setStatus(`Downloading the speech model… ${Math.round(p * 100)}%`));
      try { st = await api.voice.install(); } finally { off(); }
      setStatus('The speech model is installed.');
    }
    await loadVosk();
    setStatus('Loading the speech model…');
    const bytes = await api.voice.model();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
    try {
      model = await Vosk.createModel(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    return model;
  }

  // Only phrases of chess are listened for (voice-parse.js).
  const GRAMMAR = JSON.stringify(voiceParse.grammar());

  // The words in a recording (mono samples), as from the microphone: for
  // checking the recogniser without one.
  async function transcribe(samples, sampleRate) {
    const m = await loadModel();
    if (!m) return null;
    const r = new m.KaldiRecognizer(sampleRate, GRAMMAR);
    return new Promise((resolve) => {
      const texts = [];
      let done = false;
      let timer = null;
      r.on('result', (msg) => {
        if (msg.result?.text) texts.push(msg.result.text);
        if (done) { clearTimeout(timer); timer = setTimeout(() => { r.remove(); resolve(texts.join(' ')); }, 300); }
      });
      for (let i = 0; i < samples.length; i += 4096) r.acceptWaveformFloat(samples.subarray(i, i + 4096), sampleRate);
      done = true;
      r.retrieveFinalResult();
    });
  }

  async function startRecognition() {
    if (!(await api.voice.micAccess())) {
      throw new Error('Ponder may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.');
    }
    const m = await loadModel();
    if (!m) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      throw new Error(err?.name === 'NotFoundError' ? 'No microphone was found.' : 'The microphone could not be opened.');
    }
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const recogniser = new m.KaldiRecognizer(ctx.sampleRate, GRAMMAR);
    recogniser.on('result', (msg) => {
      const text = msg.result?.text?.trim();
      // The app's own voice (the announcer, the commentary) is not you.
      if (!text || window.speechSynthesis?.speaking) return;
      hear(text).catch((err) => show('Voice commands', errorText(err), 'error'));
    });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => { try { recogniser.acceptWaveform(e.inputBuffer); } catch { /* stopped */ } };
    src.connect(proc);
    proc.connect(ctx.destination);
    return {
      stop() {
        proc.onaudioprocess = null;
        try { src.disconnect(); proc.disconnect(); } catch { /* already */ }
        for (const t of stream.getTracks()) t.stop();
        ctx.close().catch(() => {});
        try { recogniser.remove(); } catch { /* already */ }
      },
    };
  }

  async function setOn(want) {
    if (want === on || starting) return;
    if (!want) {
      on = false;
      rec?.stop();
      rec = null;
      sync();
      setStatus('Voice commands are off.');
      return;
    }
    on = true;
    starting = true;
    sync();
    try {
      rec = await startRecognition();
      if (!rec) { on = false; return; }
      if (!on) { rec.stop(); rec = null; return; } // turned off while starting
      setStatus('Listening: say a move, such as “knight f3”, or “stop listening”.');
    } catch (err) {
      on = false;
      rec = null;
      show('Voice commands', errorText(err), 'error');
    } finally {
      starting = false;
      sync();
    }
  }

  btn.onclick = () => setOn(!on);
  sync();
  return { toggle: () => setOn(!on), setOn, hear, transcribe, get on() { return on; } };
})();
window.voice = voice;
