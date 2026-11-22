'use strict';
// Commands from the application menu (built in main.js): each does what its
// button or key in the window does. Nothing happens while a dialog is open,
// as with the keys.

const MENU_COMMANDS = {
  newGame: () => $('#btn-new').click(),
  open: () => openPgn(),
  database: () => openDatabase(),
  positions: () => openPositions(),
  binpack: () => openBinpack(),
  save: () => exportPgn(),
  copyPgn: () => $('#btn-pgn').click(),
  copyFen: async () => {
    await api.copyText(shownFen());
    setStatus('Copied the position as FEN.');
  },
  paste: async () => {
    const err = await loadPastedText(await api.readClipboard());
    if (err) setStatus(err);
  },
  takeback: () => takeback(),
  voice: () => window.voice?.toggle(),
  first: () => showPly(0),
  prev: () => stepBack(),
  next: () => stepForward(),
  last: () => showPly(livePly()),
  flip: () => $('#btn-flip').click(),
  annotate: () => {
    showTab('moves');
    if (!$('#btn-annotate').disabled) $('#btn-annotate').click();
  },
  analysis: () => $('#btn-analysis').click(),
  pause: () => toggleAnalysisHold(),
  ai: () => $('#btn-ai').click(),
  tab: (name) => $(`#tab-${name}`)?.click(),
  lichess: (view) => {
    $('#tab-lichess').click();
    lxShowView(view);
  },
  settings: (pane) => openSettings(pane),
  zen: () => toggleZen(),
  sounds: () => toggleSounds(),
  music: () => music.toggle(),
  keys: () => $('#dlg-keys').showModal(),
};

api.onMenu?.((cmd, arg) => {
  if (document.querySelector('dialog:modal') || !state) return;
  const run = MENU_COMMANDS[cmd];
  if (!run) return;
  Promise.resolve().then(() => run(arg)).catch((err) => setStatus(errorText(err)));
});
