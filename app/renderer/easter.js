'use strict';
// An easter egg: type "nyan" anywhere outside a text box and a pixel cat
// flies across the window on a rainbow, with stars and a little chiptune.
// The cat and the tune are Ponder's own, after the old internet meme.
// The tune follows the Sounds setting; with reduced motion the cat only
// fades in and out where it is.

const NYAN_WORD = 'nyan';
const NYAN_MS = 4200;
let nyanTyped = '';
let nyanFlying = false;

// The cat, 22 by 14 pixels: one letter a colour.
const NYAN_ART = [
  '..........K.......K...',
  '.........KGK.....KGK..',
  '.........KGGK...KGGK..',
  '........KGGGGKKKGGGGK.',
  '.......KGGGGGGGGGGGGK.',
  'KK.....KGGWKGGGGGWKGK.',
  'KGK...KGGGKKGGKGGKKGGK',
  '.KGKKKGGPPGGGGGGGPPGGK',
  '..KGGGGGGGGKGKGKGGGGK.',
  '..KGGGGGGGGGGGGGGGGK..',
  '...KGGGGGGGGGGGGGGK...',
  '...KGGKKGGGGGGKKGGK...',
  '...KGK.KGK..KGK.KGK...',
  '....K...K....K...K....',
];
const NYAN_COLOURS = { K: '#1b1b1f', G: '#a7a9b4', W: '#ffffff', P: '#ff8fb8' };

function nyanCatSvg() {
  const rects = [];
  NYAN_ART.forEach((row, y) => [...row].forEach((c, x) => {
    if (NYAN_COLOURS[c]) rects.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${NYAN_COLOURS[c]}"/>`);
  }));
  return `<svg viewBox="0 0 22 14" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

// A bright little tune on square waves: an arpeggio up and down, twice.
function nyanTune() {
  if (!sounds.enabled || sounds.volume === 0) return;
  let ctx;
  try { ctx = new AudioContext(); } catch { return; }
  const out = ctx.createGain();
  out.gain.value = 0.06 * sounds.volume;
  out.connect(ctx.destination);
  const notes = [76, 79, 83, 88, 86, 83, 79, 81, 84, 88, 91, 88, 84, 81, 83, 86, 91, 95, 91, 86, 88];
  const step = 0.17;
  const t0 = ctx.currentTime + 0.05;
  notes.forEach((n, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = 440 * 2 ** ((n - 69) / 12);
    const t = t0 + i * step;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.01);
    g.gain.setValueAtTime(1, t + step * 0.7);
    g.gain.linearRampToValueAtTime(0, t + step * 0.95);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + step);
  });
  // A soft bass under it.
  [52, 55, 57, 59].forEach((n, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = 440 * 2 ** ((n - 69) / 12);
    const t = t0 + i * step * 5.25;
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.01, t + step * 5);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + step * 5.2);
  });
  setTimeout(() => ctx.close().catch(() => {}), (notes.length * step + 1) * 1000);
}

function nyan() {
  if (nyanFlying) return;
  nyanFlying = true;
  const layer = el('div', { className: 'nyan', ariaHidden: 'true' });
  const cat = el('div', { className: 'nyan-cat' });
  cat.innerHTML = nyanCatSvg();
  layer.append(cat);
  document.body.append(layer);
  nyanTune();
  const done = () => { layer.remove(); nyanFlying = false; };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    layer.classList.add('still');
    setTimeout(done, 2500);
    return;
  }
  // Across the window at a height somewhere in its middle, leaving a trail
  // of rainbow pieces that bob up and down in step, and a few stars.
  const h = Math.max(48, Math.min(110, window.innerHeight / 8));
  const y = window.innerHeight * (0.25 + Math.random() * 0.4);
  cat.style.height = h + 'px';
  cat.style.top = y + 'px';
  const w = h * 22 / 14;
  const piece = h / 3;
  const start = performance.now();
  let laid = -w;
  const frame = (now) => {
    const t = (now - start) / NYAN_MS;
    if (t >= 1.25) { done(); return; }
    const x = -w + (window.innerWidth + 2 * w) * Math.min(1, t);
    const bob = Math.floor(now / 140) % 2 ? -h / 14 : h / 14;
    cat.style.transform = `translate(${x}px, ${bob}px)`;
    while (t < 1 && laid + piece < x + w * 0.25) {
      const p = el('div', { className: 'nyan-piece' });
      p.style.left = laid + 'px';
      p.style.top = y + h * 0.12 + (Math.floor(laid / piece) % 2 ? -h / 14 : h / 14) + 'px';
      p.style.width = piece + 1 + 'px';
      p.style.height = h * 0.72 + 'px';
      layer.insertBefore(p, cat);
      laid += piece;
      if (Math.random() < 0.18) {
        const s = el('div', { className: 'nyan-star', textContent: '✦' });
        s.style.left = laid + Math.random() * 60 - 30 + 'px';
        s.style.top = y + (Math.random() < 0.5 ? -1 : 1) * (h * (0.7 + Math.random() * 0.9)) + 'px';
        s.style.fontSize = h * (0.18 + Math.random() * 0.2) + 'px';
        layer.append(s);
      }
    }
    // The trail fades out once the cat has gone.
    if (t >= 1) layer.style.opacity = String(Math.max(0, 1 - (t - 1) * 4));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
window.nyan = nyan;

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  const key = e.key.toLowerCase();
  // "a" is the Annotate shortcut: in the middle of the word it is not.
  if (key === 'a' && nyanTyped.endsWith('ny')) e.stopImmediatePropagation();
  nyanTyped = (nyanTyped + key).slice(-NYAN_WORD.length);
  if (nyanTyped === NYAN_WORD) { nyanTyped = ''; nyan(); }
}, true);
