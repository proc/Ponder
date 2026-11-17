// Classical music in the background: a live classical radio station (one
// of ours, or any internet radio station you add by its stream address),
// or the music files in a folder of your own (shuffled). It plays on its own
// <audio> element, apart from the game sounds, with its own volume, and
// keeps playing whatever happens on the board. Settings → General → Music.
'use strict';

const MUSIC_STATIONS = [
  { id: 'rsc', name: 'Radio Swiss Classic', place: 'Switzerland', note: 'Classical all day, little talk', url: 'https://stream.srg-ssr.ch/srgssr/rsc_de/mp3/128' },
  { id: 'vcr', name: 'Venice Classic Radio', place: 'Italy', note: 'Baroque to Romantic, no talk', url: 'https://uk2.streamingpulse.com/ssl/vcr1' },
  { id: 'brk', name: 'BR-Klassik', place: 'Germany', note: 'Bavarian Radio’s classical station', url: 'https://dispatcher.rndfnk.com/br/brklassik/live/mp3/high' },
  { id: 'klassik', name: 'Klassik Radio', place: 'Germany', note: 'Classical favourites and film music', url: 'https://stream.klassikradio.de/live/mp3-192/stream.klassikradio.de/' },
  { id: 'rclassique', name: 'Radio Classique', place: 'France', note: 'Classical music from Paris', url: 'https://radioclassique.ice.infomaniak.ch/radioclassique-high.mp3' },
  { id: 'npo4', name: 'NPO Radio 4', place: 'Netherlands', note: 'Concerts and classical music', url: 'https://icecast.omroep.nl/radio4-bb-mp3' },
  { id: 'wqxr', name: 'WQXR', place: 'New York', note: 'New York’s classical station', url: 'https://stream.wqxr.org/wqxr' },
  { id: 'kusc', name: 'Classical KUSC', place: 'Los Angeles', note: 'Classical from Los Angeles', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KUSCMP128.mp3' },
];

const music = (() => {
  const audio = new Audio();
  audio.preload = 'none';
  const settings = { on: false, station: 'rsc', folder: '', volume: 0.35, shuffle: true, custom: [] };
  let tracks = [];      // the folder's files, in play order
  let track = -1;
  let state = 'off';    // off | connecting | playing | error
  let error = '';
  let retry = null;
  const listeners = new Set();

  try {
    const saved = JSON.parse(localStorage.getItem('music') ?? 'null');
    if (saved && typeof saved === 'object') Object.assign(settings, saved);
  } catch { /* storage unavailable */ }
  settings.volume = Math.min(1, Math.max(0, Number(settings.volume) || 0));
  // Your own stations: { id, name, url }.
  settings.custom = (Array.isArray(settings.custom) ? settings.custom : [])
    .filter((c) => c && typeof c.id === 'string' && typeof c.url === 'string' && /^https?:\/\//i.test(c.url))
    .map((c) => ({ id: c.id, name: String(c.name || c.url), url: c.url }));
  const allStations = () => [...MUSIC_STATIONS, ...settings.custom];
  if (settings.station !== 'folder' && !allStations().some((s) => s.id === settings.station)) settings.station = 'rsc';
  audio.volume = settings.volume;

  const save = () => { try { localStorage.setItem('music', JSON.stringify(settings)); } catch { /* ignore */ } };
  const changed = () => { for (const f of listeners) { try { f(); } catch { /* ignore */ } } };
  const set = (s, e = '') => { state = s; error = e; changed(); };
  const station = () => allStations().find((s) => s.id === settings.station) ?? null;
  // A stream over plain http goes through the app (ponder-radio://): the
  // page would upgrade it to https, which most such streams do not have.
  const streamUrl = (st) => (/^http:/i.test(st.url) && window.board?.music ? `ponder-radio://stream/?u=${encodeURIComponent(st.url)}` : st.url);
  const ipcError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async function loadFolder() {
    tracks = [];
    track = -1;
    if (!settings.folder) return;
    try {
      const list = await window.board?.music?.list(settings.folder) ?? [];
      tracks = settings.shuffle ? shuffle(list) : list.sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }));
    } catch { tracks = []; }
  }

  function playUrl(url) {
    clearTimeout(retry);
    set('connecting');
    audio.src = url;
    audio.play().catch((err) => {
      // A new source replaced this one before it started: not an error.
      if (err?.name === 'AbortError') return;
      failed(err?.message || 'could not play');
    });
  }

  async function start() {
    clearTimeout(retry);
    if (!settings.on) return;
    if (settings.station === 'folder') {
      if (!settings.folder) { set('error', 'Choose a folder of music'); return; }
      if (!tracks.length) await loadFolder();
      if (!settings.on) return;
      if (!tracks.length) { set('error', 'No music files in that folder'); return; }
      next();
    } else {
      playUrl(streamUrl(station()));
    }
  }

  function next() {
    if (!tracks.length) return;
    track = (track + 1) % tracks.length;
    if (track === 0 && settings.shuffle && tracks.length > 2) tracks = shuffle(tracks);
    playUrl(tracks[track].url);
  }

  function stop() {
    clearTimeout(retry);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    set('off');
  }

  // A station that drops out is tried again after a pause; a file that
  // cannot be played is skipped.
  let fails = 0;
  function failed(message) {
    if (!settings.on) return;
    if (settings.station === 'folder') {
      if (++fails >= Math.min(tracks.length, 10)) { set('error', 'The music files could not be played'); return; }
      next();
      return;
    }
    set('error', `Could not reach ${station()?.name ?? 'the station'}: trying again`);
    clearTimeout(retry);
    retry = setTimeout(() => { if (settings.on) playUrl(streamUrl(station())); }, 8000);
  }

  audio.addEventListener('playing', () => { fails = 0; set('playing'); });
  audio.addEventListener('waiting', () => { if (settings.on && state === 'playing') set('connecting'); });
  audio.addEventListener('ended', () => { if (settings.on) (settings.station === 'folder' ? next() : failed('ended')); });
  audio.addEventListener('error', () => { if (settings.on && audio.getAttribute('src')) failed(audio.error?.message || 'error'); });
  audio.addEventListener('stalled', () => {
    // A stream that stops sending for long is restarted.
    if (!settings.on || settings.station === 'folder') return;
    clearTimeout(retry);
    retry = setTimeout(() => { if (settings.on && audio.readyState < 3) playUrl(streamUrl(station())); }, 15000);
  });

  return {
    stations: MUSIC_STATIONS,
    get settings() { return { ...settings }; },
    get state() { return state; },
    get error() { return error; },
    get on() { return settings.on; },
    // What is playing, for the title of the button and the settings.
    get title() {
      if (settings.station === 'folder') return tracks[track]?.name ?? 'Your music';
      return station()?.name ?? '';
    },
    onChange(f) { listeners.add(f); },
    setOn(on) {
      settings.on = Boolean(on);
      save();
      if (settings.on) start(); else stop();
    },
    toggle() { this.setOn(!settings.on); },
    setVolume(v) {
      settings.volume = Math.min(1, Math.max(0, Number(v) || 0));
      audio.volume = settings.volume;
      save();
    },
    async setStation(id) {
      if (id !== 'folder' && !allStations().some((s) => s.id === id)) return;
      settings.station = id;
      save();
      if (id === 'folder') await loadFolder();
      if (settings.on) start(); else changed();
    },
    async setFolder(folder) {
      settings.folder = folder || '';
      settings.station = 'folder';
      save();
      await loadFolder();
      if (settings.on) start(); else changed();
      return tracks.length;
    },
    async setShuffle(on) {
      settings.shuffle = Boolean(on);
      save();
      if (settings.station === 'folder' && settings.folder) {
        await loadFolder();
        if (settings.on) start();
      }
    },
    skip() { if (settings.on && settings.station === 'folder') next(); },
    get trackCount() { return tracks.length; },
    get custom() { return settings.custom.map((c) => ({ ...c })); },
    get station() { return station(); },
    // Adds a station of your own by its stream (or playlist) address and
    // plays it. Returns '' or what went wrong.
    async addStation(name, url) {
      let address = String(url ?? '').trim();
      if (!/^https?:\/\/\S+$/i.test(address)) return 'Give the stream’s web address, starting with http:// or https://';
      try {
        if (window.board?.music?.resolve) address = (await window.board.music.resolve(address)).url;
      } catch (err) {
        return `That station could not be used: ${ipcError(err)}`;
      }
      let label = String(name ?? '').trim();
      if (!label) { try { label = new URL(address).hostname.replace(/^www\./, ''); } catch { label = 'My station'; } }
      const id = 'my-' + Date.now().toString(36);
      settings.custom.push({ id, name: label.slice(0, 60), url: address });
      settings.station = id;
      settings.on = true;
      save();
      start();
      return '';
    },
    removeStation(id) {
      const i = settings.custom.findIndex((c) => c.id === id);
      if (i < 0) return;
      settings.custom.splice(i, 1);
      if (settings.station === id) {
        settings.station = 'rsc';
        if (settings.on) start();
      }
      save();
      changed();
    },
    // Begin playing at startup when it was on when the app was closed.
    resume() { if (settings.on) start(); else changed(); },
  };
})();

// The controls: the note button beside the board's tools, the U key, and
// the Music card in Settings → General.
window.addEventListener('DOMContentLoaded', () => {
  const q = (s) => document.querySelector(s);
  const btn = q('#btn-music');
  const sel = q('#music-station');

  // The choices: our stations, then yours, then a folder, and a way to
  // add a station. Built again when your stations change.
  let built = '';
  function fillStations() {
    const custom = music.custom;
    const key = JSON.stringify(custom.map((c) => [c.id, c.name]));
    if (key === built) return;
    built = key;
    const radio = document.createElement('optgroup');
    radio.label = 'Classical radio';
    for (const s of MUSIC_STATIONS) radio.append(new Option(`${s.name} · ${s.place}`, s.id));
    const yours = document.createElement('optgroup');
    yours.label = 'Your stations';
    for (const c of custom) yours.append(new Option(c.name, c.id));
    yours.append(new Option('Add a station…', 'add'));
    const own = document.createElement('optgroup');
    own.label = 'Your music';
    own.append(new Option('Music in a folder…', 'folder'));
    sel.replaceChildren(radio, yours, own);
  }
  const addRow = q('#music-add-row');
  const addName = q('#music-add-name');
  const addUrl = q('#music-add-url');
  const addNote = q('#music-add-note');
  function showAdd(on) {
    if (!addRow) return;
    addRow.hidden = !on;
    if (addNote) addNote.hidden = true;
    if (on) { addName.value = ''; addUrl.value = ''; addUrl.focus(); }
  }
  q('#music-add-cancel')?.addEventListener('click', () => { showAdd(false); render(); });
  q('#music-add-go')?.addEventListener('click', async () => {
    const go = q('#music-add-go');
    go.disabled = true;
    go.textContent = 'Checking…';
    const err = await music.addStation(addName.value, addUrl.value);
    go.disabled = false;
    go.textContent = 'Add';
    if (err) { addNote.textContent = err; addNote.hidden = false; return; }
    showAdd(false);
  });
  for (const input of [addName, addUrl]) {
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); q('#music-add-go').click(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); q('#music-add-cancel').click(); }
    });
  }
  q('#music-remove')?.addEventListener('click', () => {
    const st = music.station;
    if (st && st.id.startsWith('my-')) music.removeStation(st.id);
  });

  if (sel) {
    fillStations();
    sel.onchange = async () => {
      if (sel.value === 'add') { showAdd(true); return; }
      showAdd(false);
      if (sel.value === 'folder' && !music.settings.folder) {
        const folder = await window.board?.music?.chooseFolder();
        if (!folder) { render(); return; }
        await music.setFolder(folder);
        if (!music.on) music.setOn(true);
        return;
      }
      await music.setStation(sel.value);
    };
  }
  q('#music-on')?.addEventListener('change', (e) => music.setOn(e.target.checked));
  q('#music-volume')?.addEventListener('input', (e) => music.setVolume(e.target.value / 100));
  q('#music-shuffle')?.addEventListener('change', (e) => music.setShuffle(e.target.checked));
  q('#music-skip')?.addEventListener('click', () => music.skip());
  q('#music-choose')?.addEventListener('click', async () => {
    const folder = await window.board?.music?.chooseFolder();
    if (folder) await music.setFolder(folder);
  });
  if (btn) btn.onclick = () => music.toggle();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'u' && e.key !== 'U') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    if (document.querySelector('dialog[open]')) return;
    music.toggle();
  });

  function render() {
    const s = music.settings;
    const st = music.state;
    if (btn) {
      btn.setAttribute('aria-pressed', String(s.on));
      btn.classList.toggle('loading', st === 'connecting');
      btn.title = !s.on ? 'Music: click to play in the background (U)'
        : st === 'error' ? `${music.error}. Click to stop (U)`
          : `${st === 'connecting' ? 'Connecting to' : 'Playing'} ${music.title}: click to stop (U)`;
    }
    if (q('#music-on')) q('#music-on').checked = s.on;
    if (sel) { fillStations(); if (sel.value !== 'add' || addRow?.hidden) sel.value = s.station; }
    const mine = s.station.startsWith('my-');
    const remove = q('#music-remove');
    if (remove) remove.hidden = !mine;
    const addr = q('#music-address');
    if (addr) {
      addr.hidden = !mine;
      const st = music.station;
      addr.textContent = mine && st ? st.url : '';
      addr.title = addr.textContent;
    }
    if (q('#music-volume')) q('#music-volume').value = Math.round(s.volume * 100);
    const folder = s.station === 'folder';
    for (const id of ['#music-folder-row', '#music-shuffle-row']) { const n = q(id); if (n) n.hidden = !folder; }
    if (q('#music-folder')) {
      q('#music-folder').textContent = s.folder ? s.folder.split(/[\\/]/).filter(Boolean).pop() : 'None chosen';
      q('#music-folder').title = s.folder;
    }
    if (q('#music-shuffle')) q('#music-shuffle').checked = s.shuffle;
    if (q('#music-skip')) q('#music-skip').disabled = !(folder && s.on && music.trackCount > 1);
    const now = q('#music-now');
    if (now) {
      const station = music.station;
      now.textContent = !s.on ? (folder ? `${music.trackCount ? `${music.trackCount} pieces` : 'Off'}` : station?.note ?? (mine ? 'Your station' : ''))
        : st === 'connecting' ? `Connecting to ${music.title}…`
          : st === 'error' ? music.error
            : `Now playing: ${music.title}`;
      now.classList.toggle('bad', s.on && st === 'error');
    }
  }
  music.onChange(render);
  render();
  music.resume();
});
