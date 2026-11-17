'use strict';
// Floating windows: a panel taken out of the side column and laid over the
// app. It is moved by its header, resized by its bottom right corner (a
// double-click there gives it its own size back), folded down to its header
// with the arrow (or a double-click on the header) and hidden with ✕; a
// button in the tray at the bottom right of the window brings it back.
// Where it is, its size, and whether it is folded or hidden are kept.
//
// floatWindow(panel, options) returns { set(on), sync(), reopen() }:
//   key     where the state is kept (localStorage)
//   name    what the window is called, for its buttons ("chat")
//   head    the header: the handle to drag, where the buttons go
//   size    its size when not resized: { w, h } in px
//   start   (width, height) => { x, y }: where it first appears
//   pill    () => content of the tray button while it is hidden

// Floating windows overlap: the one last clicked or tabbed into comes to the
// front. Every kind takes part (these, the engine panels, the challenges
// window). The order is set through --float-z, which only the floating
// styles read, so a panel back in its column is not affected. They stay in
// 42–49, above windows not touched yet and below pop-ups and dialogs.
const FLOAT_WINDOWS = '.fw.floating, .engine.floating, .float-win';
let floatOrder = [];
function raiseFloat(win) {
  if (floatOrder.at(-1) === win) return;
  floatOrder = floatOrder.filter((w) => w !== win && w.matches(FLOAT_WINDOWS));
  floatOrder.push(win);
  floatOrder.forEach((w, i) => w.style.setProperty('--float-z', String(Math.min(49, 42 + i))));
}
for (const type of ['pointerdown', 'focusin']) {
  document.addEventListener(type, (e) => {
    const win = e.target.closest?.(FLOAT_WINDOWS);
    if (win) raiseFloat(win);
  }, true);
}

function floatWindow(panel, o) {
  const st = (() => { try { return JSON.parse(localStorage.getItem(o.key)) || {}; } catch { return {}; } })();
  const save = () => { try { localStorage.setItem(o.key, JSON.stringify(st)); } catch { /* not kept */ } };
  const m = 8;
  const MIN_W = 240;
  const MIN_H = 140;
  let home = null; // where it sits in the side column: { parent, next }

  panel.classList.add('fw');
  o.head.classList.add('fw-head');
  const fold = el('button', { type: 'button', className: 'float-toggle fw-fold' });
  const close = el('button', { type: 'button', className: 'float-toggle fw-close', textContent: '✕' });
  close.title = `Hide the ${o.name} window (a button at the bottom right brings it back)`;
  close.setAttribute('aria-label', `Hide the ${o.name} window`);
  o.head.append(el('span', { className: 'fw-tools' }, [fold, close]));
  const grip = el('div', { className: 'float-grip', title: 'Drag to resize · double-click to reset' });
  panel.append(grip);
  const pill = el('button', { type: 'button', className: 'fw-pill', hidden: true });
  pill.title = `Show the ${o.name} window`;
  $('#float-tray').append(pill);

  const floating = () => panel.classList.contains('floating');
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));

  function place() {
    if (!floating() || panel.hidden || st.hidden) return;
    const folded = Boolean(st.folded);
    const w = st.w > 0 ? st.w : o.size.w;
    const h = st.h > 0 ? st.h : o.size.h;
    panel.style.width = clamp(w, MIN_W, window.innerWidth - 2 * m) + 'px';
    panel.style.height = folded ? '' : clamp(h, MIN_H, window.innerHeight - 2 * m) + 'px';
    const r = panel.getBoundingClientRect();
    const first = o.start(r.width, r.height);
    panel.style.left = clamp(st.x ?? first.x, m, window.innerWidth - r.width - m) + 'px';
    panel.style.top = clamp(st.y ?? first.y, m, window.innerHeight - r.height - m) + 'px';
  }

  function sync() {
    const on = floating();
    panel.classList.toggle('folded', on && Boolean(st.folded));
    panel.classList.toggle('fw-hidden', on && Boolean(st.hidden));
    fold.textContent = st.folded ? '▸' : '▾';
    fold.title = st.folded ? `Show the ${o.name}` : 'Fold the window down to this bar';
    fold.setAttribute('aria-label', fold.title);
    fold.setAttribute('aria-expanded', String(!st.folded));
    pill.hidden = !(on && st.hidden && !panel.hidden);
    if (!pill.hidden) pill.replaceChildren(...[].concat(o.pill()));
    place();
  }

  function set(on) {
    if (on === floating()) { sync(); return; }
    if (on) {
      home = { parent: panel.parentElement, next: panel.nextSibling };
      panel.classList.add('floating');
      document.body.append(panel);
    } else {
      panel.classList.remove('floating', 'folded', 'fw-hidden');
      for (const k of ['left', 'top', 'width', 'height']) panel.style[k] = '';
      if (home?.parent) home.parent.insertBefore(panel, home.next?.parentElement === home.parent ? home.next : null);
    }
    sync();
  }

  // Back in view, open: for a new game.
  function reopen() {
    if (!st.hidden && !st.folded) return;
    st.hidden = false;
    st.folded = false;
    save();
    sync();
  }

  const toggleFold = () => { st.folded = !st.folded; save(); sync(); };
  fold.onclick = toggleFold;
  close.onclick = () => { st.hidden = true; save(); sync(); };
  pill.onclick = () => { st.hidden = false; save(); sync(); };
  const control = (t) => t instanceof Element && t.closest('button, input, textarea, select, a, .seg');
  o.head.addEventListener('dblclick', (e) => { if (floating() && !control(e.target)) toggleFold(); });

  // Drags with the pointer captured on handle: move(ev, start) each step.
  function drag(handle, begin, move) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !floating() || (handle === o.head && control(e.target))) return;
      e.preventDefault();
      const start = begin(e);
      try { handle.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
      panel.classList.add('dragging');
      const step = (ev) => move(ev, start);
      const up = () => {
        try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        panel.classList.remove('dragging');
        handle.removeEventListener('pointermove', step);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        // Kept as it ended up: inside the window.
        st.x = parseFloat(panel.style.left);
        st.y = parseFloat(panel.style.top);
        if (handle === grip) { st.w = parseFloat(panel.style.width); st.h = parseFloat(panel.style.height); }
        save();
      };
      handle.addEventListener('pointermove', step);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
  drag(o.head, (e) => {
    const r = panel.getBoundingClientRect();
    return { dx: e.clientX - r.left, dy: e.clientY - r.top };
  }, (ev, s) => { st.x = ev.clientX - s.dx; st.y = ev.clientY - s.dy; place(); });
  // The corner moves; the top left stays where it is.
  drag(grip, (e) => {
    const r = panel.getBoundingClientRect();
    st.x = r.left;
    st.y = r.top;
    return { dw: r.width - e.clientX, dh: r.height - e.clientY, r };
  }, (ev, s) => {
    st.w = Math.max(MIN_W, Math.min(ev.clientX + s.dw, window.innerWidth - m - s.r.left));
    st.h = Math.max(MIN_H, Math.min(ev.clientY + s.dh, window.innerHeight - m - s.r.top));
    place();
  });
  grip.addEventListener('dblclick', () => { delete st.w; delete st.h; save(); place(); });
  window.addEventListener('resize', place);

  return { set, sync, reopen };
}
