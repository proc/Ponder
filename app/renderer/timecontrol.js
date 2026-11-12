// Time-control editor used in the New game dialog.
// A time control is the object the Go backend expects:
//   { kind: 'clock', stages: [{ moves, baseMs, incMs }, ...] }
//   { kind: 'movetime', moveTimeMs }   { kind: 'depth', depth }   { kind: 'none' }
'use strict';

const MIN = 60000;
const stage = (moves, minutes, incSeconds) => ({ moves, baseMs: minutes * MIN, incMs: incSeconds * 1000 });

const TC_PRESETS = [
  ['Bullet 1+0', [stage(0, 1, 0)]],
  ['Bullet 2+1', [stage(0, 2, 1)]],
  ['Blitz 3+0', [stage(0, 3, 0)]],
  ['Blitz 3+2', [stage(0, 3, 2)]],
  ['Blitz 5+0', [stage(0, 5, 0)]],
  ['Blitz 5+3', [stage(0, 5, 3)]],
  ['Rapid 10+0', [stage(0, 10, 0)]],
  ['Rapid 10+5', [stage(0, 10, 5)]],
  ['Rapid 15+10', [stage(0, 15, 10)]],
  ['Classical 30+0', [stage(0, 30, 0)]],
  ['Classical 30+20', [stage(0, 30, 20)]],
  ['Tournament 40/90 then 30, +30s', [stage(40, 90, 30), stage(0, 30, 30)]],
  ['Tournament 40/120, 20/60, then 15 +30s', [stage(40, 120, 0), stage(20, 60, 0), stage(0, 15, 30)]],
];

const TC_KINDS = {
  clock: 'Clock',
  movetime: 'Fixed time per move',
  depth: 'Fixed search depth',
  none: 'No clock',
};

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function createTimeControlEditor(root) {
  const kind = el('select');
  const preset = el('select');
  for (const [i, [name]] of TC_PRESETS.entries()) preset.append(el('option', { value: i, textContent: name }));
  preset.append(el('option', { value: 'custom', textContent: 'Custom' }));
  const stagesBox = el('div', { className: 'stages' });
  const addStage = el('button', { type: 'button', textContent: 'Add stage', className: 'small' });
  const moveTime = el('input', { type: 'number', min: 0.1, step: 0.1, value: 5 });
  const depth = el('input', { type: 'number', min: 1, max: 99, step: 1, value: 12 });

  const clockBox = el('div', { className: 'tc-clock' }, [
    el('label', { className: 'row' }, ['Preset ', preset]),
    stagesBox,
    addStage,
  ]);
  const moveTimeBox = el('label', { className: 'row' }, ['Seconds per move ', moveTime]);
  const depthBox = el('label', { className: 'row' }, ['Depth (plies) ', depth]);
  root.replaceChildren(el('label', { className: 'row' }, ['Type ', kind]), clockBox, moveTimeBox, depthBox);

  function stageRow(s) {
    const moves = el('input', { type: 'number', min: 1, step: 1, placeholder: 'all', title: 'Number of moves in this stage; leave empty for the rest of the game' });
    const minutes = el('input', { type: 'number', min: 0, step: 'any' });
    const inc = el('input', { type: 'number', min: 0, step: 'any' });
    moves.value = s.moves || '';
    minutes.value = +(s.baseMs / MIN).toFixed(3);
    inc.value = +(s.incMs / 1000).toFixed(3);
    const remove = el('button', { type: 'button', textContent: '✕', className: 'small', title: 'Remove stage' });
    const row = el('div', { className: 'stage' }, [moves, 'moves in', minutes, 'min +', inc, 's/move', remove]);
    row.read = () => ({
      moves: Math.max(0, Math.floor(+moves.value || 0)),
      baseMs: Math.round((+minutes.value || 0) * MIN),
      incMs: Math.round((+inc.value || 0) * 1000),
    });
    remove.onclick = () => {
      if (stagesBox.children.length > 1) row.remove();
      markCustom();
    };
    row.oninput = markCustom;
    return row;
  }

  function setStages(stages) {
    stagesBox.replaceChildren(...stages.map(stageRow));
    syncRemoveButtons();
  }
  function syncRemoveButtons() {
    const rows = stagesBox.children;
    for (const row of rows) row.querySelector('button').hidden = rows.length === 1;
  }
  function readStages() {
    return [...stagesBox.children].map((row) => row.read());
  }
  function markCustom() {
    preset.value = 'custom';
    syncRemoveButtons();
  }
  function matchPreset(stages) {
    const i = TC_PRESETS.findIndex(([, s]) => JSON.stringify(s) === JSON.stringify(stages));
    preset.value = i < 0 ? 'custom' : i;
  }
  function show() {
    clockBox.hidden = kind.value !== 'clock';
    moveTimeBox.hidden = kind.value !== 'movetime';
    depthBox.hidden = kind.value !== 'depth';
  }

  preset.onchange = () => {
    if (preset.value !== 'custom') setStages(TC_PRESETS[preset.value][1]);
  };
  addStage.onclick = () => {
    // A new last stage needs the previous one to have a move count.
    const rows = stagesBox.children;
    const last = rows[rows.length - 1];
    const lastMoves = last.querySelector('input');
    if (!lastMoves.value) lastMoves.value = 40;
    stagesBox.append(stageRow(stage(0, 15, 0)));
    markCustom();
  };
  kind.onchange = show;

  const editor = {
    // Limit the kinds on offer, e.g. no "No clock" for an engine.
    setKinds(kinds) {
      const current = kind.value;
      kind.replaceChildren(...kinds.map((k) => el('option', { value: k, textContent: TC_KINDS[k] })));
      kind.value = kinds.includes(current) ? current : kinds[0];
      show();
    },
    set(tc) {
      if (!tc) return;
      if ([...kind.options].some((o) => o.value === tc.kind)) kind.value = tc.kind;
      if (tc.stages?.length) { setStages(tc.stages); matchPreset(tc.stages); }
      if (tc.moveTimeMs) moveTime.value = tc.moveTimeMs / 1000;
      if (tc.depth) depth.value = tc.depth;
      show();
    },
    get() {
      switch (kind.value) {
        case 'clock': return { kind: 'clock', stages: readStages() };
        case 'movetime': return { kind: 'movetime', moveTimeMs: Math.round((+moveTime.value || 0) * 1000) };
        case 'depth': return { kind: 'depth', depth: Math.floor(+depth.value || 0) };
        default: return { kind: 'none' };
      }
    },
    // Everything, including the settings of kinds not currently selected.
    snapshot() {
      return { kind: kind.value, stages: readStages(), moveTimeMs: Math.round((+moveTime.value || 0) * 1000), depth: Math.floor(+depth.value || 0) };
    },
  };

  editor.setKinds(Object.keys(TC_KINDS));
  setStages(TC_PRESETS[7][1]);
  preset.value = 7;
  return editor;
}
