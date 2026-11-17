// The 3D board (Settings → Appearance → Board → 3D board): the board and the
// pieces drawn with three.js, seen from the player's side at an angle.
//
// The 2D board stays the model. It is drawn as always, under the 3D view
// and invisible, and after each drawing the 3D view copies it: the pieces
// (sliding the ones that moved), the last move, the selection, the legal
// moves, check, and the arrows. A click or drag on the 3D board is handed to
// the 2D square under it, so moving, premoves and the rest work unchanged.
//
// It draws only when something changes, or while a piece slides or is
// dragged: nothing runs while the board is still.
import * as THREE from './vendor/three/three.module.js';

const wrap = document.querySelector('.board-wrap');
const canvas = document.createElement('canvas');
canvas.id = 'board3d';
canvas.setAttribute('aria-hidden', 'true');
canvas.title = 'Drag a piece to move it · drag elsewhere to turn the board · scroll to zoom · double-click to face it again';
wrap.prepend(canvas);

let renderer = null;
let scene, camera, boardGroup, pieceGroup, markGroup, arrowMesh, labelMesh;
const meshes = new Map(); // square → mesh, as the board is now
let shown = {};           // square → piece letter, as the 3D board shows it
let shownFlipped = null;
const tweens = new Set();
let frameAsked = false;
let shadowsDirty = true;
let warmed = false;
let active = false;

// ---------------------------------------------------------------------------
// Colours from the theme (CSS custom properties), as three.js colours.
// ---------------------------------------------------------------------------
const probe = document.createElement('canvas').getContext('2d');
function cssColor(name, fallback) {
  const raw = getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  probe.fillStyle = '#000';
  probe.fillStyle = raw;
  const v = probe.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
  if (v.startsWith('#')) return { color: new THREE.Color(v), alpha: 1 };
  const [r, g, b, a = 1] = v.match(/[\d.]+/g).map(Number);
  return { color: new THREE.Color(r / 255, g / 255, b / 255), alpha: a };
}

// ---------------------------------------------------------------------------
// The pieces, modelled here: turned profiles (radius, height) on a common
// base, a carved head for the knight. One square is one unit.
// ---------------------------------------------------------------------------
const BASE = [[0, 0], [0.36, 0], [0.37, 0.03], [0.36, 0.06], [0.31, 0.09], [0.32, 0.11], [0.27, 0.14]];
const PROFILES = {
  p: [...BASE, [0.17, 0.19], [0.12, 0.34], [0.2, 0.37], [0.2, 0.39], [0.1, 0.41], [0, 0.42]],
  r: [...BASE, [0.26, 0.17], [0.21, 0.23], [0.19, 0.5], [0.27, 0.55], [0.27, 0.66], [0.17, 0.66], [0.17, 0.62], [0, 0.62]],
  b: [...BASE, [0.25, 0.17], [0.14, 0.24], [0.1, 0.56], [0.19, 0.59], [0.19, 0.62], [0.09, 0.64], [0.13, 0.68], [0.17, 0.75],
    [0.17, 0.82], [0.13, 0.9], [0.06, 0.97], [0, 0.99]],
  q: [...BASE, [0.27, 0.17], [0.15, 0.26], [0.1, 0.62], [0.21, 0.67], [0.21, 0.7], [0.12, 0.72], [0.17, 0.8], [0.21, 0.87],
    [0.12, 0.86], [0, 0.85]],
  k: [...BASE, [0.28, 0.17], [0.16, 0.26], [0.11, 0.66], [0.22, 0.71], [0.22, 0.74], [0.13, 0.76], [0.18, 0.86], [0.2, 0.92],
    [0.1, 0.93], [0, 0.93]],
  n: [...BASE, [0.28, 0.17], [0.27, 0.2], [0, 0.2]],
};
const geometries = {};
function lathe(points) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 48);
}
function knightHead() {
  // The horse's head in profile, facing +x, extruded across.
  const s = new THREE.Shape();
  const pts = [[-0.24, 0.18], [0.22, 0.18], [0.2, 0.26], [0.12, 0.34], [0.07, 0.42], [0.14, 0.45], [0.27, 0.48],
    [0.35, 0.52], [0.37, 0.58], [0.33, 0.63], [0.24, 0.66], [0.15, 0.7], [0.1, 0.77], [0.07, 0.84], [0.02, 0.89],
    [-0.02, 0.83], [-0.07, 0.88], [-0.12, 0.82], [-0.14, 0.76], [-0.22, 0.68], [-0.28, 0.56], [-0.3, 0.42], [-0.28, 0.3]];
  s.moveTo(...pts[0]);
  for (const p of pts.slice(1)) s.lineTo(...p);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.035, bevelSegments: 4, curveSegments: 8 });
  g.translate(0, 0, -0.08);
  g.computeVertexNormals();
  return g;
}
function pieceGeometries(type) {
  if (geometries[type]) return geometries[type];
  const parts = [lathe(PROFILES[type])];
  const at = (g, x, y, z) => { g.translate(x, y, z); return g; };
  if (type === 'p') parts.push(at(new THREE.SphereGeometry(0.14, 32, 20), 0, 0.53, 0));
  if (type === 'r') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const m = new THREE.BoxGeometry(0.1, 0.08, 0.09);
      m.rotateY(-a);
      parts.push(at(m, Math.cos(a) * 0.22, 0.7, Math.sin(a) * 0.22));
    }
  }
  if (type === 'b') parts.push(at(new THREE.SphereGeometry(0.045, 16, 12), 0, 1.02, 0));
  if (type === 'q') {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push(at(new THREE.SphereGeometry(0.035, 12, 10), Math.cos(a) * 0.19, 0.89, Math.sin(a) * 0.19));
    }
    parts.push(at(new THREE.SphereGeometry(0.06, 20, 14), 0, 0.92, 0));
  }
  if (type === 'k') {
    parts.push(at(new THREE.BoxGeometry(0.06, 0.22, 0.06), 0, 1.03, 0));
    parts.push(at(new THREE.BoxGeometry(0.17, 0.06, 0.06), 0, 1.06, 0));
  }
  if (type === 'n') parts.push(knightHead());
  // One shape per piece: one drawing call for it instead of up to ten.
  geometries[type] = [mergeGeometries(parts)];
  return geometries[type];
}
// Shapes joined into one (positions and normals; the pieces need no more).
function mergeGeometries(list) {
  const total = list.reduce((n, g) => n + g.attributes.position.count, 0);
  const indexCount = list.reduce((n, g) => n + (g.index ? g.index.count : g.attributes.position.count), 0);
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const idx = new Uint32Array(indexCount);
  let v = 0, k = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, n * 3), v * 3);
    nor.set(g.attributes.normal.array.subarray(0, n * 3), v * 3);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[k++] = g.index.array[i] + v;
    else for (let i = 0; i < n; i++) idx[k++] = i + v;
    v += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// The pieces in the theme's colours (--piece3d-white, --piece3d-black, as
// its flat piece set), with its finish (--piece3d-finish: matte, satin or
// gloss) and, for a set drawn in glowing outlines, a glowing rim
// (--piece3d-white-rim, --piece3d-black-rim). Clear glass in those colours
// with Glassify board.
const materials = {};
const FINISHES = {
  matte: { roughness: 0.62, clearcoat: 0, sheen: 0.25 },
  satin: { roughness: 0.4, clearcoat: 0.45, clearcoatRoughness: 0.3, sheen: 0.15 },
  gloss: { roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08, sheen: 0 },
};
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}
function pieceStyle(white) {
  const side = white ? 'white' : 'black';
  const color = cssColor(`--piece3d-${side}`, cssVar(`--mark-${side}`) || (white ? '#eee6d6' : '#26262b')).color;
  const rim = cssVar(`--piece3d-${side}-rim`) ? cssColor(`--piece3d-${side}-rim`, '#fff').color : null;
  const finish = FINISHES[cssVar('--piece3d-finish')] ?? FINISHES.satin;
  return { color, rim, finish };
}
// A glow on the edges the camera sees side-on: the outline of the piece.
function addRim(mat, color, strength) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: color };
    shader.uniforms.rimStrength = { value: strength };
    shader.fragmentShader = 'uniform vec3 rimColor;\nuniform float rimStrength;\n' + shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float facing = abs(dot(normalize(normal), normalize(vViewPosition)));
        totalEmissiveRadiance += rimColor * rimStrength * pow(1.0 - facing, 4.0);
      }`);
  };
  mat.customProgramCacheKey = () => 'rim';
}
function pieceMaterial(white) {
  const glass = document.body.classList.contains('glass-board');
  const key = `${white ? 'w' : 'b'}${glass ? 'g' : ''}`;
  if (materials[key]) return materials[key];
  const { color, rim, finish } = pieceStyle(white);
  const mat = glass
    ? new THREE.MeshPhysicalMaterial({
      color, roughness: 0.04, metalness: 0, ior: 1.5, clearcoat: 1,
      clearcoatRoughness: 0.03, transparent: true, opacity: 0.8, specularIntensity: 1, depthWrite: true,
      // Dark glass mirrors the room less, or it looks white.
      envMapIntensity: color.getHSL({}).l < 0.3 ? 0.7 : 1.5,
    })
    : new THREE.MeshPhysicalMaterial({ color, ...finish });
  if (rim) addRim(mat, rim, glass ? 1.6 : 2.2);
  materials[key] = mat;
  return mat;
}

function makePiece(letter) {
  const white = letter === letter.toUpperCase();
  const type = letter.toLowerCase();
  const group = new THREE.Group();
  const mat = pieceMaterial(white);
  for (const g of pieceGeometries(type)) {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  group.userData = { letter };
  return group;
}

// ---------------------------------------------------------------------------
// The board: 64 tiles on a frame, the files and ranks on the frame.
// ---------------------------------------------------------------------------
const cellX = (col) => col - 3.5;
const cellZ = (row) => row - 3.5;
// A square's place as shown: column 0 on the left, row 0 at the far side.
function display(sq) {
  const file = sq.charCodeAt(0) - 97;
  const rank = +sq[1];
  return flipped ? [7 - file, rank - 1] : [file, 8 - rank];
}
function squareName(col, row) {
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row + 1 : 8 - row;
  return 'abcdefgh'[file] + rank;
}

let colours = '';
function buildBoard() {
  const light = cssColor('--light-sq', '#f0d9b5');
  const dark = cssColor('--dark-sq', '#b58863');
  const frame = cssColor('--panel', '#fff');
  const key = [light.color.getHexString(), dark.color.getHexString(), frame.color.getHexString(), flipped, document.body.classList.contains('glass-board')].join();
  if (key === colours) return;
  colours = key;
  boardGroup.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
  boardGroup.clear();
  shadowsDirty = true;
  const glass = document.body.classList.contains('glass-board');
  const tileGeo = new THREE.BoxGeometry(1, 0.1, 1);
  // A dark board reflects less of the room, or its squares look washed out.
  const darkBoard = (light.color.r + light.color.g + light.color.b) / 3 < 0.35;
  // The lights make a square brighter than its colour: a dark board's
  // squares are darkened to match the flat board.
  const tileMat = (c) => new THREE.MeshPhysicalMaterial({
    color: darkBoard ? c.color.clone().multiplyScalar(0.62) : c.color, roughness: glass ? 0.08 : 0.45, clearcoat: glass ? 1 : 0.35, clearcoatRoughness: 0.2,
    envMapIntensity: darkBoard ? 0.35 : 1,
    ...(glass ? { transparent: true, opacity: 0.62, envMapIntensity: 1.4 } : {}),
  });
  // The light squares as one shape and the dark ones as another: two
  // drawing calls, not 64.
  const sets = { light: [], dark: [] };
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row + 1 : 8 - row;
      sets[(file + rank) % 2 ? 'dark' : 'light'].push(tileGeo.clone().translate(cellX(col), -0.05, cellZ(row)));
    }
  }
  tileGeo.dispose();
  for (const [name, c] of [['light', light], ['dark', dark]]) {
    const m = new THREE.Mesh(mergeGeometries(sets[name]), tileMat(c));
    m.receiveShadow = true;
    boardGroup.add(m);
  }
  // A theme drawn in neon has a glowing line round the squares.
  if (cssVar('--board3d-edge')) {
    const edge = new THREE.MeshBasicMaterial({ color: cssColor('--board3d-edge', '#fff').color, toneMapped: false });
    for (const [w, d, x, z] of [[8.08, 0.04, 0, -4.02], [8.08, 0.04, 0, 4.02], [0.04, 8.08, -4.02, 0], [0.04, 8.08, 4.02, 0]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), edge);
      m.position.set(x, 0.001, z);
      boardGroup.add(m);
    }
  }
  const frameMat = new THREE.MeshPhysicalMaterial({ color: frame.color.clone().multiplyScalar(0.92), roughness: 0.35, clearcoat: 0.5 });
  const f = new THREE.Mesh(new THREE.BoxGeometry(9, 0.2, 9), frameMat);
  f.position.y = -0.12;
  f.receiveShadow = true;
  boardGroup.add(f);
  // Files and ranks on the frame.
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const unit = 1024 / 9;
  g.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted').trim() || '#888';
  g.font = `600 ${unit * 0.26}px system-ui, -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 8; i++) {
    g.fillText(squareName(i, 7)[0], unit * (i + 1), unit * 8.75);
    g.fillText(squareName(0, i)[1], unit * 0.25, unit * (i + 1));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  labelMesh.rotation.x = -Math.PI / 2;
  labelMesh.position.y = -0.019;
  boardGroup.add(labelMesh);
}

// ---------------------------------------------------------------------------
// Marks on the squares, read from the 2D board: last move, selection,
// premove, legal moves (dots, rings on captures), check.
// ---------------------------------------------------------------------------
const markGeo = { square: new THREE.PlaneGeometry(1, 1), dot: new THREE.CircleGeometry(0.15, 32), ring: new THREE.RingGeometry(0.4, 0.48, 48) };
let checkTexture = null;
function syncMarks() {
  for (const m of markGroup.children) m.material.dispose();
  markGroup.clear();
  const last = cssColor('--last-move', 'rgba(255,204,0,.4)');
  const sel = cssColor('--selected', 'rgba(255,190,0,.6)');
  const hint = cssColor('--hint', 'rgba(0,0,0,.25)');
  const flat = (geo, c, col, row, y = 0.002, extra = {}) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c.color, transparent: true, opacity: c.alpha, depthWrite: false, ...extra }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(cellX(col), y, cellZ(row));
    markGroup.add(m);
  };
  const squares = boardEl.querySelectorAll('.squares > .square');
  squares.forEach((node, i) => {
    const col = i % 8;
    const row = Math.floor(i / 8);
    const cl = node.classList;
    if (cl.contains('last')) flat(markGeo.square, last, col, row);
    if (cl.contains('selected') || cl.contains('premove')) flat(markGeo.square, sel, col, row, 0.003);
    if (cl.contains('target')) flat(markGeo.dot, hint, col, row, 0.004);
    if (cl.contains('capture')) flat(markGeo.ring, hint, col, row, 0.004);
    if (cl.contains('check')) {
      if (!checkTexture) {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, 'rgba(226,60,40,.95)');
        grad.addColorStop(0.45, 'rgba(226,60,40,.55)');
        grad.addColorStop(1, 'rgba(226,60,40,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        checkTexture = new THREE.CanvasTexture(c);
      }
      flat(markGeo.square, { color: new THREE.Color(0xffffff), alpha: 1 }, col, row, 0.005, { map: checkTexture });
    }
  });
}

// ---------------------------------------------------------------------------
// The arrows (the engine's lines, the explorer's, your own): the SVG over
// the 2D board, with its colours as drawn, laid on the 3D board.
// ---------------------------------------------------------------------------
const arrowCanvas = document.createElement('canvas');
arrowCanvas.width = arrowCanvas.height = 1024;
let arrowTexture = null;
let arrowJob = 0;
const STYLE_PROPS = ['stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-dasharray', 'fill', 'fill-opacity', 'opacity', 'visibility', 'display'];
async function syncArrows() {
  const svg = document.getElementById('arrows');
  if (!svg) return;
  const job = ++arrowJob;
  syncOverlay();
  const copy = svg.cloneNode(true);
  // Computed styles written onto the copy, which has no stylesheet.
  const src = svg.querySelectorAll('*');
  const dst = copy.querySelectorAll('*');
  src.forEach((n, i) => {
    const cs = getComputedStyle(n);
    for (const p of STYLE_PROPS) dst[i].setAttribute(p, cs.getPropertyValue(p));
  });
  // The depth tags and the ponder bubble stand up over the 3D board
  // instead (syncOverlay): not flat on it.
  for (const n of copy.querySelectorAll(OVERLAY_MARKS)) n.remove();
  copy.setAttribute('width', '1024');
  copy.setAttribute('height', '1024');
  copy.removeAttribute('style');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); return; }
  URL.revokeObjectURL(url);
  if (job !== arrowJob || !renderer) return;
  const g = arrowCanvas.getContext('2d');
  g.clearRect(0, 0, 1024, 1024);
  g.drawImage(img, 0, 0, 1024, 1024);
  if (!arrowTexture) {
    arrowTexture = new THREE.CanvasTexture(arrowCanvas);
    arrowTexture.colorSpace = THREE.SRGBColorSpace;
    arrowTexture.anisotropy = 8;
    arrowMesh.material.map = arrowTexture;
    arrowMesh.material.needsUpdate = true;
  }
  arrowTexture.needsUpdate = true;
  requestRender();
}

// ---------------------------------------------------------------------------
// The depth on an engine's arrow and the bubble of the move it expects:
// copies of the 2D board's marks (with their own styles and pulsing dots)
// in a layer over the 3D view, upright, sized as a square is where they
// stand, and placed again whenever the camera moves.
// ---------------------------------------------------------------------------
const OVERLAY_MARKS = '.arrow-label, .ponder-mark';
const PIECE_TOPS = { p: 0.62, n: 0.92, b: 1.08, r: 0.8, q: 0.98, k: 1.12 }; // each piece's height
const overlay = document.createElement('div');
overlay.id = 'board3d-marks';
overlay.setAttribute('aria-hidden', 'true');
wrap.append(overlay);
let overlayMarks = []; // { el, at: Vector3, dx, dy } (dx, dy: offset in squares, on screen)
function syncOverlay() {
  const svg = document.getElementById('arrows');
  const NS = 'http://www.w3.org/2000/svg';
  overlayMarks = [...svg.querySelectorAll(OVERLAY_MARKS)].map((mark) => {
    const [x, y] = (mark.getAttribute('transform')?.match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/) ?? [0, 0, 0]).slice(1).map(Number);
    const ponder = mark.classList.contains('ponder-mark');
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', '-0.5 -0.5 1 1');
    el.setAttribute('class', 'mark3d');
    const copy = mark.cloneNode(true);
    copy.removeAttribute('transform');
    el.append(copy);
    // The tag sits on the middle of its arrow; the bubble on top of the
    // piece expected to move (its square is 0.3 down and left of it).
    // Just over the top of that piece, however tall it is.
    const col = Math.floor(x - 0.3), row = Math.floor(y + 0.3);
    const piece = col >= 0 && col < 8 && row >= 0 && row < 8 ? shown[squareName(col, row)] : null;
    const top = PIECE_TOPS[piece?.toLowerCase()] ?? 0.62;
    return ponder
      ? { el, at: new THREE.Vector3(x - 0.3 - 4, top, y + 0.3 - 4), dx: 0.3, dy: -0.15 }
      : { el, at: new THREE.Vector3(x - 4, 0.1, y - 4), dx: 0, dy: 0 };
  });
  overlay.replaceChildren(...overlayMarks.map((m) => m.el));
  placeOverlay();
}
const camRight = new THREE.Vector3();
function placeOverlay() {
  if (!overlayMarks.length || !camera) return;
  const r = canvas.getBoundingClientRect();
  camRight.setFromMatrixColumn(camera.matrixWorld, 0);
  for (const m of overlayMarks) {
    const p = m.at.clone().project(camera);
    const q = m.at.clone().add(camRight).project(camera);
    const unit = Math.hypot((q.x - p.x) * r.width / 2, (q.y - p.y) * r.height / 2); // one square, in pixels
    const sx = (p.x + 1) / 2 * r.width + m.dx * unit;
    const sy = (1 - p.y) / 2 * r.height + m.dy * unit;
    m.el.style.width = m.el.style.height = `${unit}px`;
    m.el.style.transform = `translate(${sx - unit / 2}px, ${sy - unit / 2}px)`;
    m.el.style.visibility = p.z < 1 ? '' : 'hidden';
  }
}

// ---------------------------------------------------------------------------
// The pieces: put where the 2D board has them, sliding the ones that moved.
// ---------------------------------------------------------------------------
function faceKnight(mesh, letter) {
  if (letter.toLowerCase() !== 'n') return;
  // Each side's knights look toward the other side, turned to show their
  // profile to the player: the near side's to the left, the far side's to
  // the right, as in a diagram.
  const white = letter === letter.toUpperCase();
  const near = white !== flipped;
  mesh.rotation.y = near ? Math.PI - 0.55 : -0.55;
}
function place(mesh, sq) {
  const [col, row] = display(sq);
  mesh.position.set(cellX(col), 0, cellZ(row));
  shadowsDirty = true;
}
function slide(mesh, fromSq, toSq, ms, lift = 0) {
  const [fc, fr] = display(fromSq);
  const [tc, tr] = display(toSq);
  const from = new THREE.Vector3(cellX(fc), 0, cellZ(fr));
  const to = new THREE.Vector3(cellX(tc), 0, cellZ(tr));
  const hop = mesh.userData.letter.toLowerCase() === 'n' ? 0.45 : lift;
  tweens.add({ start: performance.now(), ms, step: (t) => {
    const e = 1 - Math.pow(1 - t, 3);
    mesh.position.lerpVectors(from, to, e);
    mesh.position.y = hop * Math.sin(Math.PI * t);
    shadowsDirty = true;
  } });
}
// A piece taken shrinks away as it rises. (Not faded: a see-through copy
// of its material is a new program for the graphics card to build, which
// held up the board at each capture.)
function fadeOut(mesh, ms, delay = 0) {
  tweens.add({ start: performance.now() + delay, ms, step: (t) => {
    t = Math.max(0, t);
    const e = t * t;
    mesh.scale.setScalar(Math.max(0.001, 1 - e));
    mesh.position.y = 0.35 * t;
    shadowsDirty = true;
    if (t >= 1) pieceGroup.remove(mesh);
  } });
}

function syncPieces() {
  const now = parseBoard(shownFen());
  const ms = ANIM_SPEEDS[animSpeed] || 0;
  const reflip = shownFlipped !== flipped;
  shownFlipped = flipped;
  const change = !reflip && ms ? placementChanges(shown, now) : null;
  if (change) {
    const moved = new Map();
    for (const { from, to } of change.moves) {
      const mesh = meshes.get(from);
      if (!mesh) continue;
      meshes.delete(from);
      moved.set(to, { mesh, from });
    }
    // A capture with its effect: the piece taking goes a little slower,
    // trailing the effect behind it, and the burst goes off as it lands.
    const [taker] = moved.size === 1 && change.captured.length && captureFx && fxGroup ? [...moved] : [];
    const dropped = taker && dropped3d && dropped3d.from === taker[1].from && dropped3d.to === taker[0];
    const takeMs = taker && !dropped ? Math.max(ms * 1.8, 380) : ms;
    if (taker) capturePlan = { fx: pickEffect(), delay: dropped ? 0 : takeMs * 0.85 };
    for (const sq of change.captured) {
      const mesh = meshes.get(sq);
      if (mesh) { meshes.delete(sq); fadeOut(mesh, ms * 1.4, taker ? Math.max(0, takeMs * 0.85 - ms * 0.4) : 0); }
    }
    for (const [to, { mesh, from }] of moved) {
      const ms2 = taker ? takeMs : ms;
      // A pawn that promoted becomes its new piece where it lands.
      if (mesh.userData.letter !== now[to]) {
        pieceGroup.remove(mesh);
        const fresh = makePiece(now[to]);
        faceKnight(fresh, now[to]);
        pieceGroup.add(fresh);
        slide(fresh, from, to, ms2);
        meshes.set(to, fresh);
      } else {
        // Dropped there by hand: no slide from where it was.
        if (dropped3d && dropped3d.from === from && dropped3d.to === to) place(mesh, to);
        else slide(mesh, from, to, ms2);
        meshes.set(to, mesh);
      }
    }
    if (capturePlan && !dropped) captureTrail(meshes.get(taker[0]), takeMs, capturePlan.fx);
  }
  // Anything else: put right without moving.
  for (const [sq, mesh] of [...meshes]) {
    if (now[sq] !== mesh.userData.letter) { pieceGroup.remove(mesh); meshes.delete(sq); }
  }
  for (const [sq, letter] of Object.entries(now)) {
    let mesh = meshes.get(sq);
    if (!mesh) {
      mesh = makePiece(letter);
      pieceGroup.add(mesh);
      meshes.set(sq, mesh);
      place(mesh, sq);
    } else if (reflip || !change) {
      place(mesh, sq);
    }
    faceKnight(mesh, letter);
  }
  // Auto camera: the move just made (not a jump to another position).
  if (!reflip) {
    const moved = placementChanges(shown, now);
    if (moved?.moves.length === 1 || moved?.moves.length === 2) {
      // Castling moves two pieces: the king's move is the one to watch.
      const main = moved.moves.find((m) => /k/i.test(now[m.to])) && moved.moves.length === 2
        ? moved.moves.find((m) => /k/i.test(now[m.to])) : moved.moves[0];
      const check = boardEl.querySelector('.square.check')?.dataset.sq ?? null;
      followMove(main, moved.captured.length > 0, check);
      for (const sq of moved.captured) {
        if (!capturePlan) { captureEffect(sq, shown[sq]); continue; }
        const { fx, delay } = capturePlan;
        const letter = shown[sq];
        setTimeout(() => { if (active) captureEffect(sq, letter, fx); }, delay);
      }
    }
  }
  shown = { ...now };
  dropped3d = null;
  capturePlan = null;
}
let capturePlan = null; // { fx, delay }: the effect of the capture being drawn

// ---------------------------------------------------------------------------
// Capture effects: a burst where a piece is taken, a different one picked at
// random each time (fire and smoke, plasma, shadow clones, sparks, frost,
// ice), each with its own sound.
// ---------------------------------------------------------------------------
let captureFx = (() => { try { return localStorage.getItem('board3dFx') !== 'off'; } catch { return true; } })();
let fxGroup = null;
const fxScale = { value: 1 }; // pixels per unit at one unit away, shared
let dotTexture = null;
function softDot() {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}
// Kept, not made for each effect: a new material would be a new program
// for the graphics card to build, and that held up the board.
const particleMaterials = {};
function particleMaterial(additive) {
  const blending = additive && !lightBoard() ? THREE.AdditiveBlending : THREE.NormalBlending;
  return (particleMaterials[blending] ??= new THREE.ShaderMaterial({
    uniforms: { map: { value: softDot() }, scale: fxScale },
    vertexShader: `
      attribute float size;
      attribute vec4 tint;
      uniform float scale;
      varying vec4 vTint;
      void main() {
        vTint = tint;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * scale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map;
      varying vec4 vTint;
      void main() {
        float a = texture2D(map, gl_PointCoord).a * vTint.a;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vTint.rgb, a);
      }`,
    transparent: true,
    depthWrite: false,
    // Glow adds light, which vanishes on a light board: a glow is drawn
    // over a light board as plain colour, over a dark one as light.
    blending,
  }));
}
let iceTemplate = null;
function iceMaterial() {
  iceTemplate ??= new THREE.MeshStandardMaterial({
    color: 0x9edcff, emissive: 0x2a7fd0, emissiveIntensity: 0.45, roughness: 0.08, metalness: 0.1,
    transparent: true, opacity: 0.75, depthWrite: false,
  });
  return iceTemplate.clone(); // the same program as the one kept
}
const iceGeo = {};
let ghostTemplate = null;
function ghostMaterial() {
  ghostTemplate ??= new THREE.MeshStandardMaterial({
    color: 0x140a22, emissive: 0x5a1fa0, emissiveIntensity: 0.6, roughness: 0.6, transparent: true, opacity: 0.75, depthWrite: false,
  });
  return ghostTemplate.clone(); // the same program as the one kept
}
// The effects' programs built ahead, while nothing is happening, so the
// first capture does not wait for them.
function warmUp() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  g.setAttribute('tint', new THREE.BufferAttribute(new Float32Array(4), 4));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(1), 1));
  const box = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  const ghost = ghostMaterial();
  ghostMaterial(); // and the template itself, kept
  const ice = iceMaterial();
  const tmp = new THREE.Group();
  tmp.add(new THREE.Points(g, particleMaterial(false)), new THREE.Points(g, particleMaterial(true)), new THREE.Mesh(box, ghost),
    new THREE.Mesh(box, ghostTemplate), new THREE.Mesh(box, ice), new THREE.Mesh(box, iceTemplate));
  scene.add(tmp);
  renderer.compileAsync(scene, camera).catch(() => {}).finally(() => { scene.remove(tmp); g.dispose(); box.dispose(); ghost.dispose(); ice.dispose(); });
}
function lightBoard() {
  const { color } = cssColor('--light-sq', '#f0d9b5');
  const { color: dark } = cssColor('--dark-sq', '#b58863');
  return (color.r + color.g + color.b + dark.r + dark.g + dark.b) / 6 > 0.45;
}

const rand = (a, b) => a + Math.random() * (b - a);
const col = (hex) => new THREE.Color(hex);
// A cloud of particles. spawn(i) gives each one: when it starts (delay) and
// how long it lives, where it starts (p) and goes (v), with drag, gravity,
// sizes and colours from birth to death; or its own move(q, age, dt).
function emit(count, additive, spawn, order = 20) {
  const parts = Array.from({ length: count }, (_, i) => ({
    delay: 0, drag: 0, grav: 0, a: 1, s1: null, c1: null, bounce: 0, ...spawn(i),
  }));
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const tint = new Float32Array(count * 4);
  const size = new Float32Array(count);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('tint', new THREE.BufferAttribute(tint, 4));
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const mat = particleMaterial(additive);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = order;
  fxGroup.add(points);
  const start = performance.now();
  let last = start;
  const ms = 1000 * Math.max(...parts.map((q) => q.delay + q.life));
  const c = new THREE.Color();
  tweens.add({ start, ms, step: (t) => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = (now - start) / 1000;
    for (let i = 0; i < count; i++) {
      const q = parts[i];
      const k = (age - q.delay) / q.life;
      if (k < 0 || k > 1) { tint[i * 4 + 3] = 0; size[i] = 0; continue; }
      if (!q.started) { q.started = true; q.born?.(q); }
      if (q.move) q.move(q, age - q.delay, dt);
      else {
        q.v.y += q.grav * dt;
        if (q.drag) q.v.multiplyScalar(Math.exp(-q.drag * dt));
        q.p.addScaledVector(q.v, dt);
        if (q.bounce && q.p.y < 0.02 && q.v.y < 0) { q.p.y = 0.02; q.v.y *= -q.bounce; q.v.x *= 0.6; q.v.z *= 0.6; }
      }
      pos.set([q.p.x, q.p.y, q.p.z], i * 3);
      c.copy(q.c0);
      if (q.c1) c.lerp(q.c1, k);
      tint.set([c.r, c.g, c.b, q.a * Math.min(1, k / 0.12) * (1 - k)], i * 4);
      size[i] = q.s1 === null ? q.s0 : q.s0 + (q.s1 - q.s0) * k;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.tint.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    if (t >= 1) { fxGroup.remove(points); geo.dispose(); }
  } });
}
// Something that grows and fades: a flash, a ring on the board.
function flare(mesh, ms, from, to, opacity = 1) {
  fxGroup.add(mesh);
  tweens.add({ start: performance.now(), ms, step: (t) => {
    const e = 1 - Math.pow(1 - t, 3);
    mesh.scale.setScalar(from + (to - from) * e);
    mesh.material.opacity = opacity * (1 - t);
    if (t >= 1) { fxGroup.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  } });
}
function ring(at, hex, ms = 650, to = 2.4) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 64), new THREE.MeshBasicMaterial({
    color: hex, transparent: true, depthWrite: false,
    blending: lightBoard() ? THREE.NormalBlending : THREE.AdditiveBlending,
  }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(at.x, 0.03, at.z);
  m.renderOrder = 21;
  flare(m, ms, 0.3, to);
}
const onDisc = (at, r, y = 0.05) => {
  const a = Math.random() * Math.PI * 2;
  const d = r * Math.sqrt(Math.random());
  return new THREE.Vector3(at.x + Math.cos(a) * d, y, at.z + Math.sin(a) * d);
};
const outward = (speed, up) => {
  const a = Math.random() * Math.PI * 2;
  return new THREE.Vector3(Math.cos(a) * speed, up, Math.sin(a) * speed);
};

const CAPTURE_EFFECTS = {
  fire(at) {
    emit(40, false, () => ({ // smoke, under the flames
      delay: rand(0.25, 0.9), life: rand(1.6, 2.4), p: onDisc(at, 0.25, 0.45), v: outward(rand(0.05, 0.25), rand(0.5, 0.9)),
      drag: 0.6, s0: 0.35, s1: 1.3, c0: col(0x4a4644), c1: col(0xb0aca8), a: 0.42,
    }), 19);
    emit(130, true, () => ({ // flames
      delay: rand(0, 0.7), life: rand(0.5, 0.95), p: onDisc(at, 0.32), v: outward(rand(0, 0.25), rand(1.6, 2.8)),
      drag: 1.2, s0: rand(0.26, 0.38), s1: 0.05, c0: col(0xffb21a), c1: col(0xd81e00), a: 0.75,
    }));
    emit(30, true, () => ({ // embers
      delay: rand(0, 0.5), life: rand(0.9, 1.5), p: onDisc(at, 0.2, 0.2), v: outward(rand(0.4, 1.3), rand(1.8, 3.2)),
      grav: -3.2, drag: 0.4, s0: 0.07, c0: col(0xffa020), c1: col(0xe02000), a: 1,
    }));
    ring(at, 0xff5a10, 500, 1.8);
  },
  plasma(at) {
    const hues = [col(0x12c8f0), col(0x8a2cff), col(0xf02cc0)];
    emit(140, true, (i) => {
      const th0 = Math.random() * Math.PI * 2;
      const turn = rand(5, 9) * (i % 2 ? 1 : -1);
      const r0 = rand(0.15, 0.5);
      const rise = rand(0.6, 1.4);
      return {
        delay: rand(0, 0.35), life: rand(0.8, 1.3), p: new THREE.Vector3(), s0: rand(0.1, 0.17), s1: 0.03,
        c0: hues[i % 3], c1: hues[(i + 1) % 3], a: 0.85,
        move: (q, age) => {
          const th = th0 + turn * age;
          const r = r0 + 0.55 * age;
          q.p.set(at.x + Math.cos(th) * r, 0.1 + rise * age + 0.15 * Math.sin(th * 2), at.z + Math.sin(th) * r);
        },
      };
    });
    emit(1, true, () => ({ life: 0.45, p: new THREE.Vector3(at.x, 0.45, at.z), v: new THREE.Vector3(), s0: 0.8, s1: 1.8, c0: col(0xa070ff), a: 0.45 }));
    ring(at, 0x7a3cff, 700, 2.6);
    setTimeout(() => { if (active) ring(at, 0x12c8f0, 600, 2); requestRender(); }, 140);
  },
  shadows(at, letter) {
    // Dark copies of the piece taken scatter from it and fade.
    const n = 6;
    for (let i = 0; i < n; i++) {
      const ghost = makePiece(letter || 'p');
      const mat = ghostMaterial();
      ghost.traverse((m) => { if (m.isMesh) { m.material = mat; m.castShadow = false; } });
      ghost.position.set(at.x, 0, at.z);
      ghost.rotation.y = Math.random() * Math.PI * 2;
      fxGroup.add(ghost);
      const a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
      const dist = rand(0.9, 1.5);
      const spin = rand(-2, 2);
      const r0 = ghost.rotation.y;
      tweens.add({ start: performance.now() + i * 40, ms: 950, step: (t) => {
        t = Math.max(0, t);
        const e = 1 - Math.pow(1 - t, 2);
        ghost.position.set(at.x + Math.cos(a) * dist * e, 0.25 * Math.sin(Math.PI * t), at.z + Math.sin(a) * dist * e);
        ghost.rotation.y = r0 + spin * e;
        ghost.scale.setScalar(1 + 0.15 * t);
        mat.opacity = 0.75 * (1 - t);
        if (t >= 1) { fxGroup.remove(ghost); mat.dispose(); }
      } });
    }
    emit(60, false, () => ({
      delay: rand(0, 0.4), life: rand(1, 1.6), p: onDisc(at, 0.35, 0.1), v: outward(rand(0.3, 0.9), rand(0.2, 0.6)),
      drag: 1.2, s0: 0.3, s1: 0.9, c0: col(0x2b1240), c1: col(0x050208), a: 0.55,
    }), 19);
    emit(24, true, () => ({
      delay: rand(0, 0.3), life: rand(0.6, 1), p: onDisc(at, 0.3, 0.3), v: outward(rand(0.2, 0.6), rand(0.3, 0.9)),
      s0: 0.1, c0: col(0xb070ff), c1: col(0x400080), a: 0.9,
    }));
  },
  sparks(at) {
    emit(110, true, () => {
      const v = new THREE.Vector3(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(1.8, 4.2));
      return {
        delay: rand(0, 0.12), life: rand(0.5, 1.1), p: new THREE.Vector3(at.x, 0.4, at.z), v,
        grav: -7, drag: 1.1, bounce: 0.45, s0: rand(0.06, 0.09), s1: 0.02, c0: col(0x7fd0ff), c1: col(0x1450ff), a: 1,
      };
    });
    emit(1, true, () => ({ life: 0.3, p: new THREE.Vector3(at.x, 0.4, at.z), v: new THREE.Vector3(), s0: 0.9, s1: 1.8, c0: col(0x70b8ff), a: 0.5 }));
    ring(at, 0x2a80ff, 450, 2.2);
  },
  ice(at, letter) {
    // The piece taken freezes in a block of ice, which cracks and shatters.
    const top = PIECE_TOPS[(letter || 'p').toLowerCase()] ?? 0.62;
    const mat = iceMaterial();
    const block = new THREE.Mesh(iceGeo.block ??= new THREE.BoxGeometry(0.78, 1, 0.78), mat);
    block.position.set(at.x, 0, at.z);
    fxGroup.add(block);
    const h = top + 0.12;
    tweens.add({ start: performance.now(), ms: 320, step: (t) => {
      const e = 1 - Math.pow(1 - Math.min(1, t * 2.2), 3);
      block.scale.set(0.6 + 0.4 * e, h * e, 0.6 + 0.4 * e);
      block.position.y = (h * e) / 2;
      block.rotation.y = 0.04 * Math.sin(t * 40) * t; // straining as it is about to go
      if (t >= 1) { fxGroup.remove(block); mat.dispose(); }
    } });
    // Shards thrown out when it cracks.
    setTimeout(() => {
      if (!active) return;
      const shardMat = iceMaterial();
      shardMat.opacity = 0.85;
      const shards = [];
      for (let i = 0; i < 34; i++) {
        const m = new THREE.Mesh(iceGeo.shard ??= new THREE.TetrahedronGeometry(0.12), shardMat);
        m.position.set(at.x + rand(-0.3, 0.3), rand(0.05, h), at.z + rand(-0.3, 0.3));
        m.scale.setScalar(rand(0.5, 1.5));
        m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
        const v = new THREE.Vector3(m.position.x - at.x, 0, m.position.z - at.z).normalize().multiplyScalar(rand(1.2, 3));
        v.y = rand(1.2, 3.2);
        shards.push({ m, v, spin: new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)) });
        fxGroup.add(m);
      }
      let last = performance.now();
      tweens.add({ start: last, ms: 1300, step: (t) => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        for (const s of shards) {
          s.v.y -= 9 * dt;
          s.m.position.addScaledVector(s.v, dt);
          if (s.m.position.y < 0.04 && s.v.y < 0) { s.m.position.y = 0.04; s.v.y *= -0.3; s.v.x *= 0.5; s.v.z *= 0.5; s.spin.multiplyScalar(0.5); }
          s.m.rotation.x += s.spin.x * dt;
          s.m.rotation.y += s.spin.y * dt;
        }
        shardMat.opacity = 0.85 * (1 - Math.max(0, t - 0.55) / 0.45);
        if (t >= 1) { for (const s of shards) fxGroup.remove(s.m); shardMat.dispose(); }
      } });
      emit(40, true, () => ({ // glittering ice dust
        life: rand(0.5, 1), p: onDisc(at, 0.3, rand(0.1, h)), v: outward(rand(0.5, 1.5), rand(0.3, 1.4)),
        grav: -2, drag: 1.5, s0: rand(0.05, 0.09), s1: 0.02, c0: col(0xe8faff), c1: col(0x5fc4f0), a: 1,
      }));
      ring(at, 0x58c8f5, 600, 2.2);
      requestRender();
    }, 300);
  },
  frost(at) {
    emit(70, true, () => ({ // shards thrown up, falling back
      delay: rand(0, 0.1), life: rand(1, 1.6), p: onDisc(at, 0.2, 0.3), v: outward(rand(0.6, 1.6), rand(1.5, 3)),
      grav: -6, drag: 0.5, bounce: 0.3, s0: rand(0.07, 0.12), s1: 0.04, c0: col(0x9fe8ff), c1: col(0x2a9be0), a: 1,
    }));
    emit(45, false, () => ({ // cold mist along the board
      delay: rand(0, 0.5), life: rand(1.4, 2), p: onDisc(at, 0.3, 0.08), v: outward(rand(0.3, 0.8), rand(0.02, 0.12)),
      drag: 1, s0: 0.4, s1: 1.2, c0: col(0xc8ecff), c1: col(0x8cc8e8), a: 0.45,
    }), 19);
    ring(at, 0x40b8f0, 800, 2.1);
  },
};
// Trails: what the piece taking leaves behind it on its way, in the style
// of the burst to come.
const TRAILS = {
  fire(mesh, ms) {
    const span = ms / 1000, top = pieceTop(mesh);
    emit(36, false, () => ({ // smoke
      delay: along(span) + 0.05, life: rand(0.9, 1.4), p: new THREE.Vector3(), born: from(mesh, 0.12, top * 0.4, top),
      v: outward(rand(0, 0.1), rand(0.35, 0.6)), drag: 0.8, s0: 0.22, s1: 0.75, c0: col(0x4a4644), c1: col(0xb0aca8), a: 0.3,
    }), 19);
    emit(150, true, () => ({ // flames licking up from the path
      delay: along(span), life: rand(0.4, 0.75), p: new THREE.Vector3(), born: from(mesh, 0.16, 0.05, top * 0.8),
      v: outward(rand(0, 0.15), rand(0.7, 1.4)), drag: 1.4, s0: rand(0.22, 0.34), s1: 0.05, c0: col(0xffb21a), c1: col(0xd81e00), a: 0.8,
    }));
  },
  plasma(mesh, ms) {
    const span = ms / 1000, top = pieceTop(mesh);
    const hues = [col(0x12c8f0), col(0x8a2cff), col(0xf02cc0)];
    emit(160, true, (i) => {
      // Sparkles that spiral round the line the piece flew along.
      let o = null;
      const th0 = Math.random() * Math.PI * 2, turn = rand(4, 7) * (i % 2 ? 1 : -1), r = rand(0.15, 0.32), y = rand(0.1, top);
      return {
        delay: along(span), life: rand(0.6, 1), p: new THREE.Vector3(), s0: rand(0.11, 0.18), s1: 0.03,
        c0: hues[i % 3], c1: hues[(i + 1) % 3], a: 0.85,
        born: () => { o = mesh.position.clone(); },
        move: (q, age) => {
          const th = th0 + turn * age;
          q.p.set(o.x + Math.cos(th) * r * (1 + age), o.y + y + 0.25 * age, o.z + Math.sin(th) * r * (1 + age));
        },
      };
    });
  },
  shadows(mesh, ms) {
    // Afterimages of the piece left along its path, fading behind it.
    const n = Math.max(4, Math.round(ms / 55));
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        if (!active || !mesh.parent) return;
        const ghost = makePiece(mesh.userData.letter);
        const mat = ghostMaterial();
        ghost.traverse((m) => { if (m.isMesh) { m.material = mat; m.castShadow = false; } });
        ghost.position.copy(mesh.position);
        ghost.rotation.copy(mesh.rotation);
        fxGroup.add(ghost);
        tweens.add({ start: performance.now(), ms: 520, step: (t) => {
          mat.opacity = 0.6 * (1 - t) * (1 - t);
          ghost.scale.setScalar(1 + 0.08 * t);
          if (t >= 1) { fxGroup.remove(ghost); mat.dispose(); }
        } });
        requestRender();
      }, along(ms * 0.95, i / n));
    }
  },
  sparks(mesh, ms) {
    const span = ms / 1000, top = pieceTop(mesh);
    emit(120, true, () => ({
      delay: along(span), life: rand(0.4, 0.8), p: new THREE.Vector3(), born: from(mesh, 0.1, 0.1, top * 0.9),
      v: new THREE.Vector3(rand(-1, 1), rand(0, 1), rand(-1, 1)).normalize().multiplyScalar(rand(0.8, 2)),
      grav: -6, drag: 1, bounce: 0.4, s0: rand(0.07, 0.11), s1: 0.02, c0: col(0x7fd0ff), c1: col(0x1450ff), a: 1,
    }));
  },
  ice(mesh, ms) {
    // Icicles spring up from the board behind the piece, then sink away.
    const n = Math.max(5, Math.round(ms / 40));
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        if (!active || !mesh.parent) return;
        for (let j = 0; j < 2; j++) {
          const mat = iceMaterial();
          const spike = new THREE.Mesh(iceGeo.spike ??= new THREE.ConeGeometry(0.09, 1, 6).translate(0, 0.5, 0), mat);
          const a = Math.random() * Math.PI * 2, d = rand(0.05, 0.28);
          spike.position.set(mesh.position.x + Math.cos(a) * d, 0, mesh.position.z + Math.sin(a) * d);
          spike.rotation.set(rand(-0.25, 0.25), 0, rand(-0.25, 0.25));
          const tall = rand(0.25, 0.6);
          fxGroup.add(spike);
          tweens.add({ start: performance.now(), ms: 1100, step: (t) => {
            const grow = Math.min(1, t / 0.12);
            const sink = Math.max(0, (t - 0.55) / 0.45);
            spike.scale.set(1 - 0.5 * sink, tall * (1 - Math.pow(1 - grow, 3)) * (1 - sink), 1 - 0.5 * sink);
            if (t >= 1) { fxGroup.remove(spike); mat.dispose(); }
          } });
        }
        requestRender();
      }, along(ms * 0.95, i / n));
    }
    emit(30, true, () => ({
      delay: along(ms / 1000), life: rand(0.5, 0.9), p: new THREE.Vector3(), born: from(mesh, 0.15, 0.05, 0.4),
      v: outward(rand(0.05, 0.3), rand(0.1, 0.5)), drag: 1, s0: rand(0.05, 0.08), s1: 0.02, c0: col(0xe8faff), c1: col(0x5fc4f0), a: 1,
    }));
  },
  frost(mesh, ms) {
    const span = ms / 1000, top = pieceTop(mesh);
    emit(80, true, () => ({ // ice crystals shed on the way
      delay: along(span), life: rand(0.6, 1.1), p: new THREE.Vector3(), born: from(mesh, 0.15, 0.1, top * 0.8),
      v: outward(rand(0.1, 0.4), rand(0, 0.5)), grav: -3, drag: 0.6, bounce: 0.3,
      s0: rand(0.06, 0.1), s1: 0.03, c0: col(0x9fe8ff), c1: col(0x2a9be0), a: 1,
    }));
    emit(22, false, () => ({ // cold mist left lying on the board
      delay: along(span), life: rand(1, 1.5), p: new THREE.Vector3(), born: from(mesh, 0.15, 0.04, 0.12),
      v: outward(rand(0.05, 0.25), 0.02), drag: 1, s0: 0.3, s1: 0.8, c0: col(0xc8ecff), c1: col(0x8cc8e8), a: 0.35,
    }), 19);
  },
};
// When the piece is a given way along its path (a share u of it, at random
// if not given): it slows as it lands (see slide), so evenly along the path
// is not evenly in time.
const along = (span, u = Math.random()) => span * (1 - Math.cbrt(1 - u));
const pieceTop = (mesh) => PIECE_TOPS[mesh.userData.letter?.toLowerCase()] ?? 0.62;
// A particle born where the piece is at that moment: around it, at a height.
const from = (mesh, r, y0, y1) => (q) => {
  const a = Math.random() * Math.PI * 2, d = r * Math.sqrt(Math.random());
  q.p.set(mesh.position.x + Math.cos(a) * d, mesh.position.y + rand(y0, y1), mesh.position.z + Math.sin(a) * d);
};
// Each effect's own sound (sounds.js), with the game's sounds.
function fxSound(fx, part, dur) {
  try { if (typeof sounds !== 'undefined') sounds.captureFx(fx, part, dur); } catch { /* silent */ }
}
function captureTrail(mesh, ms, fx) {
  if (!mesh || !TRAILS[fx]) return;
  fxSound(fx, 'trail', ms / 1000);
  try { TRAILS[fx](mesh, ms); } catch (err) { console.error('3D capture trail:', err); }
  requestRender();
}
const FX_NAMES = Object.keys(CAPTURE_EFFECTS);
let lastFx = '';
// A different effect from the last one.
let forcedFx = ''; // for tests: the next capture's effect
function pickEffect() {
  if (CAPTURE_EFFECTS[forcedFx]) { lastFx = forcedFx; forcedFx = ''; return lastFx; }
  const pick = FX_NAMES.filter((n) => n !== lastFx);
  lastFx = pick[Math.floor(Math.random() * pick.length)];
  return lastFx;
}
function captureEffect(sq, letter, name) {
  if (!captureFx || !fxGroup) return;
  const [c, r] = display(sq);
  const at = new THREE.Vector3(cellX(c), 0, cellZ(r));
  const fx = CAPTURE_EFFECTS[name] ? name : pickEffect();
  fxSound(fx, 'burst');
  try { CAPTURE_EFFECTS[fx](at, letter); } catch (err) { console.error('3D capture effect:', err); }
  requestRender();
}
function setCaptureFx(on) {
  captureFx = Boolean(on);
  try { localStorage.setItem('board3dFx', captureFx ? 'on' : 'off'); } catch { /* not kept */ }
}

// ---------------------------------------------------------------------------
// Input: the square under the pointer, for the 2D board's handlers.
// ---------------------------------------------------------------------------
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function boardPoint(x, y) {
  const r = canvas.getBoundingClientRect();
  if (!r.width) return null;
  ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
  const p = new THREE.Vector3();
  return ray.ray.intersectPlane(plane, p) ? p : null;
}
function squareAt3d(x, y) {
  const p = boardPoint(x, y);
  if (!p) return null;
  const col = Math.floor(p.x + 4);
  const row = Math.floor(p.z + 4);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return squareName(col, row);
}
let dropped3d = null;
let dragMesh = null;
canvas.addEventListener('pointerdown', (e) => {
  // The middle button always turns the board.
  if (e.button === 1) { startOrbit(e); e.preventDefault(); return; }
  const sq = squareAt3d(e.clientX, e.clientY);
  const node = sq && boardEl.querySelector(`.square[data-sq="${sq}"]`);
  if (node) {
    node.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: e.button, buttons: e.buttons, clientX: e.clientX, clientY: e.clientY,
      pointerId: e.pointerId, pointerType: e.pointerType, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
    }));
  }
  // Not picking up a piece (an empty square, the board's edge, around it):
  // a drag turns the board instead.
  if (e.button === 0 && !drag) startOrbit(e);
  if (e.button === 0) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Turning the board: drag to go round it and tilt it, scroll or pinch to
// come closer or go back, double-click to see it from your side again. The
// view is kept for next time.
// ---------------------------------------------------------------------------
const VIEW_HOME = { az: 0, el: 0.92, zoom: 1 };
// `base` is the view you chose (kept for next time); `view` is what the
// camera shows now: the same, or, with Auto camera, a shot of the last move
// (with a point to look at, fx/fz, weighed by f) on its way back to it.
const base = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('board3dView') ?? 'null');
    if (v && [v.az, v.el, v.zoom].every(Number.isFinite)) return { az: v.az, el: v.el, zoom: v.zoom };
  } catch { /* storage unavailable */ }
  return { ...VIEW_HOME };
})();
const view = { ...base, fx: 0, fz: 0, f: 0 };
const EL_MIN = 0.3, EL_MAX = 1.5, ZOOM_MIN = 0.55, ZOOM_MAX = 2.4;
let saveTimer = 0;
function saveView() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('board3dView', JSON.stringify(base)); } catch { /* not kept */ } }, 300);
}
const clampView = (v) => {
  v.el = Math.min(EL_MAX, Math.max(EL_MIN, v.el));
  v.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom));
  return v;
};
// You moved the camera: that is the view now, and Auto camera lets go of
// it until the next move.
function setView(v) {
  stopShot();
  Object.assign(view, v);
  clampView(view);
  view.zoom = Math.min(1.8, view.zoom); // closer than that is for Auto camera's shots
  Object.assign(base, { az: view.az, el: view.el, zoom: view.zoom });
  fitCamera();
  requestRender();
  saveView();
  renderResetButton();
}
// Back to your side, from wherever it was turned to, in a moment.
function resetView() {
  stopShot();
  Object.assign(base, VIEW_HOME);
  saveView();
  renderResetButton();
  glideTo({ ...VIEW_HOME, az: Math.round(view.az / (Math.PI * 2)) * Math.PI * 2, fx: 0, fz: 0, f: 0 }, 450, () => { view.az = 0; });
}

// ---------------------------------------------------------------------------
// Auto camera: at each move the camera glides in on it (lower, closer,
// turned a little toward where the piece went; closer still for a capture
// or a check), holds a moment, and glides back to your view.
// ---------------------------------------------------------------------------
let autoCam = (() => { try { return localStorage.getItem('board3dAuto') === 'on'; } catch { return false; } })();
let shotTween = null;
let shotReturn = 0;
function stopShot() {
  if (shotTween) tweens.delete(shotTween);
  shotTween = null;
  clearTimeout(shotReturn);
}
function glideTo(to, ms, done) {
  if (shotTween) tweens.delete(shotTween);
  const from = { ...view };
  // The short way round.
  let daz = to.az - from.az;
  daz -= Math.round(daz / (Math.PI * 2)) * Math.PI * 2;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  shotTween = { start: performance.now(), ms, step: (t) => {
    const k = ease(t);
    view.az = from.az + daz * k;
    for (const key of ['el', 'zoom', 'fx', 'fz', 'f']) view[key] = from[key] + (to[key] - from[key]) * k;
    fitCamera();
    if (t >= 1) { shotTween = null; done?.(); }
  } };
  tweens.add(shotTween);
  requestRender();
}
function followMove(move, captured, checkSq) {
  if (!autoCam || !active || orbit?.moving) return;
  const at = (sq) => { const [c, r] = display(sq); return [cellX(c), cellZ(r)]; };
  const [x1, z1] = at(move.from);
  const [x2, z2] = at(move.to);
  let [fx, fz] = [x1 * 0.35 + x2 * 0.65, z1 * 0.35 + z2 * 0.65];
  if (checkSq) { const [kx, kz] = at(checkSq); [fx, fz] = [(fx + kx) / 2, (fz + kz) / 2]; }
  const side = Math.max(-0.5, Math.min(0.5, fx * 0.07 + (x2 - x1) * 0.05));
  const close = checkSq ? 1.7 : captured ? 1.6 : 1.45;
  const shot = clampView({ az: base.az + side, el: Math.max(0.5, base.el - 0.24), zoom: base.zoom * close, fx, fz, f: 0.8 });
  clearTimeout(shotReturn);
  glideTo(shot, 850, () => {
    shotReturn = setTimeout(() => glideTo({ ...base, fx: 0, fz: 0, f: 0 }, 1500), 2200);
  });
}
function setAutoCam(on) {
  autoCam = Boolean(on);
  try { localStorage.setItem('board3dAuto', autoCam ? 'on' : 'off'); } catch { /* not kept */ }
  if (!autoCam && (view.f || shotTween)) { clearTimeout(shotReturn); glideTo({ ...base, fx: 0, fz: 0, f: 0 }, 700); }
  renderCamButton();
}
const camButton = document.createElement('button');
camButton.type = 'button';
camButton.id = 'cam3d';
camButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10l5-3v10l-5-3z"/><rect x="3" y="6" width="12" height="12" rx="2.5"/></g></svg><span>Auto</span>';
camButton.onclick = () => setAutoCam(!autoCam);
const resetButton = document.createElement('button');
resetButton.type = 'button';
resetButton.id = 'view3d-reset';
resetButton.title = 'Reset the view: face the board from your side again (or double-click an empty spot)';
resetButton.setAttribute('aria-label', 'Reset the 3D view');
resetButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v4h4"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></g></svg>';
resetButton.onclick = () => resetView();
const camBar = document.createElement('div');
camBar.id = 'cam3d-bar';
camBar.append(resetButton, camButton);
wrap.append(camBar);
// Only of use when the view is not already the first one.
function renderResetButton() {
  const home = Math.abs(base.az - Math.round(base.az / (Math.PI * 2)) * Math.PI * 2) < 0.01 && Math.abs(base.el - VIEW_HOME.el) < 0.01 && Math.abs(base.zoom - VIEW_HOME.zoom) < 0.01;
  resetButton.disabled = home;
}
renderResetButton();
function renderCamButton() {
  camButton.setAttribute('aria-pressed', String(autoCam));
  camButton.title = autoCam ? 'Auto camera is on: the camera follows each move. Click to turn it off' : 'Auto camera: have the camera follow each move';
  const box = document.getElementById('board-3d-auto');
  if (box) box.checked = autoCam;
}
renderCamButton();

let orbit = null;
function startOrbit(e) {
  orbit = { x: e.clientX, y: e.clientY, az: view.az, el: view.el, moving: false, id: e.pointerId };
}
window.addEventListener('pointermove', (e) => {
  if (!orbit || !active) return;
  const dx = e.clientX - orbit.x;
  const dy = e.clientY - orbit.y;
  if (!orbit.moving) {
    if (Math.hypot(dx, dy) < 5) return;
    orbit.moving = true;
    canvas.classList.add('orbiting');
  }
  setView({ az: orbit.az - dx * 0.008, el: orbit.el + dy * 0.006 });
});
window.addEventListener('pointerup', () => {
  if (!orbit) return;
  orbit = null;
  canvas.classList.remove('orbiting');
});
canvas.addEventListener('wheel', (e) => {
  if (!active) return;
  e.preventDefault();
  // A pinch on a trackpad comes as a wheel with Ctrl held, in small steps.
  const k = e.ctrlKey ? 0.01 : 0.0015;
  setView({ zoom: view.zoom * Math.exp(e.deltaY * k) });
}, { passive: false });
canvas.addEventListener('dblclick', (e) => {
  const sq = squareAt3d(e.clientX, e.clientY);
  if (sq && parseBoard(shownFen())[sq]) return; // a piece: that is for moving
  resetView();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// While a piece is dragged, the 3D piece follows the pointer, lifted.
window.addEventListener('pointermove', (e) => {
  if (!active) return;
  if (drag?.ghost) {
    if (!dragMesh) dragMesh = meshes.get(drag.from) ?? null;
    const p = boardPoint(e.clientX, e.clientY);
    if (dragMesh && p) { dragMesh.position.set(p.x, 0.35, p.z); shadowsDirty = true; requestRender(); }
  }
});
window.addEventListener('pointerup', (e) => {
  if (!active || !dragMesh) return;
  const from = [...meshes].find(([, m]) => m === dragMesh)?.[0];
  const to = squareAt3d(e.clientX, e.clientY);
  if (from && to) dropped3d = { from, to };
  const mesh = dragMesh;
  dragMesh = null;
  // Not a move: back to its square (a move redraws the board anyway).
  setTimeout(() => { if (from && meshes.get(from) === mesh) { place(mesh, from); requestRender(); } }, 0);
}, true);

// ---------------------------------------------------------------------------
// Drawing: on request, and on every frame while something moves.
// ---------------------------------------------------------------------------
function requestRender() {
  if (frameAsked || !renderer) return;
  frameAsked = true;
  requestAnimationFrame(frame);
}
const fxSize = new THREE.Vector2();
function frame(t) {
  frameAsked = false;
  if (!active) return;
  for (const tw of tweens) {
    const k = Math.min(1, (t - tw.start) / tw.ms);
    tw.step(k);
    if (k >= 1) tweens.delete(tw);
  }
  fxScale.value = renderer.getDrawingBufferSize(fxSize).y * camera.projectionMatrix.elements[5] / 2;
  // The shadows are drawn again only when a piece has moved: not while the
  // camera turns or glides, or an effect plays.
  if (shadowsDirty) { renderer.shadowMap.needsUpdate = true; shadowsDirty = false; }
  renderer.render(scene, camera);
  placeOverlay();
  if (tweens.size) requestRender();
}

// The camera looks down at the board from the player's side; it stands as
// close as it can with the whole board, the frame and the tallest pieces in
// view, whatever the shape of the space.
const TARGET = new THREE.Vector3(0, 0, 0.35);
const CORNERS = [];
for (const x of [-4.5, 4.5]) for (const y of [-0.2, 1.15]) for (const z of [-4.5, 4.5]) CORNERS.push(new THREE.Vector3(x, y, z));
function fitCamera() {
  const r = canvas.getBoundingClientRect(); // the board's box, or the whole window in zen mode
  if (!r.width || !r.height) return;
  // Sharp on a Retina screen, but no more than about 4.5 million pixels
  // in all: a big board on a big screen costs no more than that to draw.
  const ratio = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(4.5e6 / (r.width * r.height)));
  if (Math.abs(renderer.getPixelRatio() - ratio) > 0.01) renderer.setPixelRatio(ratio);
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.clearViewOffset();
  camera.updateProjectionMatrix();
  const dir = new THREE.Vector3(Math.sin(view.az) * Math.cos(view.el), Math.sin(view.el), Math.cos(view.az) * Math.cos(view.el));
  const fits = (d) => {
    camera.position.copy(TARGET).addScaledVector(dir, d);
    camera.lookAt(TARGET);
    camera.updateMatrixWorld();
    return CORNERS.every((c) => { const p = c.clone().project(camera); return Math.abs(p.x) <= 0.97 && Math.abs(p.y) <= 0.97 && p.z < 1; });
  };
  let lo = 4, hi = 60;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  // As close as the whole board allows, then as close as you zoomed.
  fits(hi);
  // Centre the board's picture: shift the view by how far off centre it is
  // (not while the camera looks at a move, which it centres itself).
  const pts = CORNERS.map((c) => c.clone().project(camera));
  const offX = (Math.max(...pts.map((p) => p.x)) + Math.min(...pts.map((p) => p.x))) / 2;
  const offY = (Math.max(...pts.map((p) => p.y)) + Math.min(...pts.map((p) => p.y))) / 2;
  const look = TARGET.clone().lerp(new THREE.Vector3(view.fx, 0.25, view.fz), view.f);
  camera.position.copy(look).addScaledVector(dir, hi / view.zoom);
  camera.lookAt(look);
  camera.updateMatrixWorld();
  const k = 1 - view.f;
  camera.setViewOffset(r.width, r.height, offX * k * r.width / 2, -offY * k * r.height / 2, r.width, r.height);
}

function environment() {
  // A soft room of light for the reflections (no files needed).
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x404048);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const lamp = (x, y, z, sx, sy, sz, intensity) => {
    const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity) }));
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    room.add(m);
  };
  lamp(0, 9, 0, 14, 0.2, 14, 2.2);
  lamp(-9, 4, 2, 0.2, 6, 10, 1.4);
  lamp(9, 5, -3, 0.2, 5, 8, 1.1);
  lamp(0, 3, 10, 12, 4, 0.2, 0.8);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();
  return env;
}

function init() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  // Checking each shader program as it is built waits on the graphics card.
  renderer.debug.checkShaderErrors = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  scene = new THREE.Scene();
  scene.environment = environment();
  camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-4, 12, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 4;
  scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x404050, 0.5));
  boardGroup = new THREE.Group();
  pieceGroup = new THREE.Group();
  markGroup = new THREE.Group();
  // The arrows lie on the board but are drawn over the pieces, as on the
  // flat board: a piece standing on one does not hide it.
  arrowMesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false, opacity: 0.88 }));
  arrowMesh.rotation.x = -Math.PI / 2;
  arrowMesh.position.y = 0.006;
  arrowMesh.renderOrder = 10;
  fxGroup = new THREE.Group();
  scene.add(boardGroup, markGroup, arrowMesh, pieceGroup, fxGroup);
  new ResizeObserver(() => { if (active) { fitCamera(); requestRender(); } }).observe(canvas);
  // The arrows change without the board being drawn again (the engine's
  // lines as it thinks): follow them.
  let arrowTimer = 0;
  new MutationObserver(() => {
    if (!active) return;
    clearTimeout(arrowTimer);
    arrowTimer = setTimeout(syncArrows, 60);
  }).observe(document.getElementById('arrows'), { subtree: true, childList: true, attributes: true });
}

// Called by renderBoard after each drawing of the 2D board.
function sync() {
  if (!active) return;
  try {
    buildBoard();
    // Before the first position has come from the backend there is nothing
    // to show yet: the board is drawn bare, and filled at the first drawing
    // of the flat board.
    if (typeof state !== 'undefined' && state) {
      syncPieces();
      syncMarks();
      syncArrows();
    }
  } catch (err) {
    // Never let the 3D view break the board underneath.
    console.error('3D board:', err);
  }
  requestRender();
}

function setActive(on) {
  on = Boolean(on);
  if (on && !renderer) {
    try { init(); } catch (err) {
      console.error('3D board:', err);
      window.setStatus?.('The 3D board could not start: this computer’s graphics did not allow it.');
      return false;
    }
  }
  active = on;
  if (!on) stopShot();
  document.body.classList.toggle('board-3d', on);
  if (on) {
    // Materials follow Glassify board and the theme: made again.
    for (const k of Object.keys(materials)) { materials[k].dispose(); delete materials[k]; }
    for (const m of meshes.values()) pieceGroup.remove(m);
    meshes.clear();
    shown = {};
    colours = '';
    fitCamera();
    sync();
    if (!warmed) { warmed = true; setTimeout(() => { try { warmUp(); } catch { /* built when first used */ } }, 400); }
  }
  return true;
}

window.board3d = {
  get active() { return active; },
  get autoCamera() { return autoCam; },
  setAutoCamera: setAutoCam,
  get captureEffects() { return captureFx; },
  setCaptureEffects: setCaptureFx,
  captureEffect, // (square, piece letter, effect name?) — plays one now
  set nextEffect(name) { forcedFx = name; },
  setActive,
  sync,
  squareAt: squareAt3d,
  restyle() { if (active) setActive(true); },
};
window.dispatchEvent(new Event('board3d-ready'));
