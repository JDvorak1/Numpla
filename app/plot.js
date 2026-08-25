// ============================================================================
// plot.js - the single plot surface for the Numpla shell.
//
// ONE canvas, THREE independent views. Each view is a switch, not a choice, so
// any subset of them can be on at once:
//
//   'time'   every state variable against t, one coloured polyline each
//   'phase'  state[1] against state[0]   (needs exactly 2 states)
//   'polar'  r against the angle, drawn on a polar grid (needs an `r` state)
//
// HOW SEVERAL VIEWS SHARE THE CANVAS
// ----------------------------------
// They tile it. The canvas is split by recursive bisection along its longer
// side: one view fills it, two split it in half, three give the first view half
// and the other two a quarter each. Splitting always cuts the LONGER side, so
// no pane ever ends up a sliver, and the order is fixed (t-y, phase, polar) so
// turning a view on never reshuffles the ones already there. Overlaying was the
// alternative and it is not legible: these views do not share an x axis, so
// stacking them would put two unrelated coordinate systems under one set of
// gridlines.
//
// THE WINDOW IS THE USER'S
// ------------------------
// Every view carries its own window - x0..x1, y0..y1 - defaulting to -5..5 on
// both axes rather than fitting the data, so two runs are comparable. Nothing
// in here ever changes a window on the user's behalf: a re-solve redraws inside
// the frame they left. Panning, axis scaling and zooming are all done by the
// shell calling setWindow(); this module only supplies the geometry to do it
// with (hit) and the arithmetic (dataAt, panned, scaled, zoomed, fitted).
//
// Light theme: the canvas is paper. Gridlines are barely there, axis rules are
// a shade stronger, labels are grey, and the curves carry all the saturation.
//
// Device-pixel-ratio aware: the backing store is sized in device pixels and the
// context is scaled, so lines land on real pixels on a HiDPI display.
// ============================================================================

/** Series palette, tuned for ink-on-paper: mid-dark, all legible on white. */
export const SERIES = [
  '#0f7d70', // teal (the accent)
  '#b5651d', // ochre
  '#5a4fcf', // indigo
  '#c2185b', // crimson
  '#1f6fb2', // blue
  '#5f8a1b', // olive
  '#7a5230', // brown
  '#a5399a', // magenta
];

export const seriesColor = (i) => SERIES[i % SERIES.length];

/** Every non-curve colour on the canvas, in one place. */
const INK = {
  bg:       '#ffffff',
  grid:     '#eceef1',
  gridZero: '#c7ccd4',
  frame:    '#bfc4cd',
  paneEdge: '#e6e9ee',
  label:    '#78818f',
  faint:    '#9aa2b0',
  title:    '#a7aeba',
  playhead: 'rgba(15, 125, 112, 0.42)',
  halo:     'rgba(15, 125, 112, 0.13)',
};

/** How much of a curve that has not been reached yet still shows. */
const AHEAD_ALPHA = 0.24;

const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

/** The view ids this module understands. `main.js` shares this vocabulary. */
export const VIEWS = ['time', 'phase', 'polar'];

/** What each pane is called on the canvas. */
export const VIEW_LABEL = { time: 't–y', phase: 'phase', polar: 'polar' };

/** The frame every view starts in, and the one the reset control returns to. */
export const DEFAULT_WINDOW = Object.freeze({ x0: -5, x1: 5, y0: -5, y1: 5 });

const MIN_SPAN = 1e-9;
const MAX_SPAN = 1e12;
const PANE_GAP = 14;

// ---------------------------------------------------------------------------
// numeric helpers
// ---------------------------------------------------------------------------

/** Nice round tick step covering `span` in roughly `target` divisions. */
function niceStep(span, target) {
  if (!(span > 0) || !isFinite(span)) return 1;
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function ticksFor(lo, hi, target) {
  const step = niceStep(hi - lo, target);
  const out = [];
  const first = Math.ceil(lo / step - 1e-9) * step;
  for (let v = first; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    if (out.length > 200) break;
  }
  return { step, values: out };
}

function decimalsFor(step) {
  if (!(step > 0) || !isFinite(step)) return 2;
  return Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
}

function tickLabel(v, step) {
  const a = Math.abs(v);
  if (v === 0) return '0';
  if (a >= 1e5 || a < 1e-4) return v.toExponential(1).replace('e+', 'e');
  return v.toFixed(decimalsFor(step));
}

/** Compact formatting for readouts and slider values. */
export function fmtValue(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (v === 0) return '0.000';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(3);
  if (a >= 1e3) return v.toFixed(1);
  if (a >= 1e2) return v.toFixed(2);
  return v.toFixed(4);
}

/** Widen a degenerate or zero-height range into something drawable. */
function padRange(lo, hi, frac = 0.08) {
  if (!isFinite(lo) || !isFinite(hi)) return [-1, 1];
  if (hi - lo <= 0) {
    const c = isFinite(lo) ? lo : 0;
    const r = Math.max(1, Math.abs(c)) * 0.5;
    return [c - r, c + r];
  }
  const p = (hi - lo) * frac;
  return [lo - p, hi + p];
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A window is only ever accepted if it is finite and has a usable span. */
export function normaliseWindow(w, fallback = DEFAULT_WINDOW) {
  const f = fallback || DEFAULT_WINDOW;
  if (!w || typeof w !== 'object') return { ...f };
  let { x0, x1, y0, y1 } = w;
  if (![x0, x1, y0, y1].every((v) => typeof v === 'number' && isFinite(v))) return { ...f };
  if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
  if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const sx = clamp(x1 - x0, MIN_SPAN, MAX_SPAN);
  const sy = clamp(y1 - y0, MIN_SPAN, MAX_SPAN);
  return { x0: cx - sx / 2, x1: cx + sx / 2, y0: cy - sy / 2, y1: cy + sy / 2 };
}

export const sameWindow = (a, b) =>
  !!a && !!b && a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;

/** Translate a window by a pixel delta inside `box`. */
export function panned(win, box, dxPx, dyPx) {
  const w = Math.max(1, box.R - box.L);
  const h = Math.max(1, box.B - box.T);
  const ux = ((win.x1 - win.x0) / w) * dxPx;
  const uy = ((win.y1 - win.y0) / h) * dyPx;
  return normaliseWindow({
    x0: win.x0 - ux, x1: win.x1 - ux,
    y0: win.y0 + uy, y1: win.y1 + uy,
  }, win);
}

/** Multiply one axis' span by `f`, holding `anchor` (a data value) still. */
export function scaled(win, axis, f, anchor) {
  const k = clamp(isFinite(f) && f > 0 ? f : 1, 1e-6, 1e6);
  if (axis === 'x') {
    const a = isFinite(anchor) ? anchor : (win.x0 + win.x1) / 2;
    return normaliseWindow({
      x0: a + (win.x0 - a) * k, x1: a + (win.x1 - a) * k,
      y0: win.y0, y1: win.y1,
    }, win);
  }
  const a = isFinite(anchor) ? anchor : (win.y0 + win.y1) / 2;
  return normaliseWindow({
    x0: win.x0, x1: win.x1,
    y0: a + (win.y0 - a) * k, y1: a + (win.y1 - a) * k,
  }, win);
}

/** Zoom both axes about a data point - the wheel gesture. */
export function zoomed(win, f, ax, ay) {
  return scaled(scaled(win, 'x', f, ax), 'y', f, ay);
}

// ---------------------------------------------------------------------------
// canvas plumbing
// ---------------------------------------------------------------------------

/**
 * Size the backing store to devicePixelRatio and return a context whose user
 * units are CSS pixels.
 */
function prepare(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);

  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h, dpr };
}

/** Snap to a half-pixel so 1px strokes are not smeared across two pixels. */
const crisp = (v, dpr) => Math.round(v * dpr) / dpr + 0.5 / dpr;

function centredText(ctx, box, msg, colour) {
  ctx.save();
  ctx.fillStyle = colour || INK.faint;
  ctx.font = `12px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, (box.L + box.R) / 2, (box.T + box.B) / 2);
  ctx.restore();
}

/** Split a rectangle in two along its longer side, leaving a gap between. */
function bisect(cell) {
  const w = cell.R - cell.L;
  const h = cell.B - cell.T;
  if (w >= h) {
    const m = cell.L + w / 2;
    return [
      { L: cell.L, R: m - PANE_GAP / 2, T: cell.T, B: cell.B },
      { L: m + PANE_GAP / 2, R: cell.R, T: cell.T, B: cell.B },
    ];
  }
  const m = cell.T + h / 2;
  return [
    { L: cell.L, R: cell.R, T: cell.T, B: m - PANE_GAP / 2 },
    { L: cell.L, R: cell.R, T: m + PANE_GAP / 2, B: cell.B },
  ];
}

/** n cells by recursive bisection: the first view keeps the largest share. */
function cellsFor(area, n) {
  if (n <= 1) return [area];
  const [first, rest] = bisect(area);
  return [first].concat(cellsFor(rest, n - 1));
}

/** The data box inside a cell: room for tick labels on the left and below. */
function boxIn(cell) {
  const w = cell.R - cell.L;
  const h = cell.B - cell.T;
  const l = Math.min(52, Math.max(26, w * 0.16));
  const b = Math.min(28, Math.max(16, h * 0.12));
  return {
    L: cell.L + l,
    R: cell.R - 12,
    T: cell.T + 20,
    B: cell.B - b,
  };
}

// ---------------------------------------------------------------------------
// Plot - one canvas, a tile per active view
// ---------------------------------------------------------------------------

export class Plot {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    /** The views that are ON, in VIEWS order. Never changed from in here. */
    this.views = ['time'];
    /** view id -> the window the user is looking through. */
    this.windows = new Map(VIEWS.map((v) => [v, { ...DEFAULT_WINDOW }]));
    /** view id -> false when the model cannot support it (drawn as a reason). */
    this.support = { time: true, phase: true, polar: true };
    /** The panes as last drawn: what hit testing and the pointer gestures use. */
    this.panes = [];
  }

  /** @param {string[]} list the views that are on; order is canonical. */
  setViews(list) {
    const on = Array.isArray(list) ? list : [];
    this.views = VIEWS.filter((v) => on.indexOf(v) >= 0);
  }

  setSupport(support) {
    for (const v of VIEWS) this.support[v] = !!(support && support[v]);
  }

  getWindow(view) {
    const w = this.windows.get(view);
    return w ? { ...w } : { ...DEFAULT_WINDOW };
  }

  setWindow(view, win) {
    if (!this.windows.has(view)) return;
    this.windows.set(view, normaliseWindow(win, this.windows.get(view)));
  }

  resetWindow(view) {
    if (this.windows.has(view)) this.windows.set(view, { ...DEFAULT_WINDOW });
  }

  resetAllWindows() {
    for (const v of VIEWS) this.windows.set(v, { ...DEFAULT_WINDOW });
  }

  /** True when every window is still the default one. */
  isDefaultFrame() {
    for (const v of VIEWS) {
      if (!sameWindow(this.windows.get(v), DEFAULT_WINDOW)) return false;
    }
    return true;
  }

  /**
   * The pane under a point, in CSS pixels relative to the canvas, plus which
   * part of it: 'body' pans, 'x' and 'y' scale that one axis.
   * @returns {{view:string, cell:object, box:object, region:string}|null}
   */
  hit(px, py) {
    for (const pane of this.panes) {
      const c = pane.cell;
      if (px < c.L || px > c.R || py < c.T || py > c.B) continue;
      const b = pane.box;
      let region = 'body';
      if (px < b.L) region = py <= b.B ? 'y' : 'body';
      else if (py > b.B) region = 'x';
      return { view: pane.view, cell: c, box: b, region };
    }
    return null;
  }

  /** Pixel -> data, inside a pane's box. */
  dataAt(view, box, px, py) {
    const w = this.getWindow(view);
    const bw = Math.max(1, box.R - box.L);
    const bh = Math.max(1, box.B - box.T);
    return {
      x: w.x0 + ((px - box.L) / bw) * (w.x1 - w.x0),
      y: w.y0 + ((box.B - py) / bh) * (w.y1 - w.y0),
    };
  }

  /**
   * The window that would show all of `sol` in `view`, or null when there is
   * nothing to fit. Only ever called because someone asked for it.
   */
  fitWindow(view, sol) {
    if (!sol || !sol.n || !sol.dim) return null;
    const { dim, n, data } = sol;
    const stride = dim + 1;
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    const take = (x, y) => {
      if (isFinite(x)) { if (x < xlo) xlo = x; if (x > xhi) xhi = x; }
      if (isFinite(y)) { if (y < ylo) ylo = y; if (y > yhi) yhi = y; }
    };

    if (view === 'time') {
      for (let i = 0; i < n; i++) {
        const t = data[i * stride];
        for (let d = 0; d < dim; d++) take(t, data[i * stride + 1 + d]);
      }
    } else if (view === 'phase') {
      if (dim !== 2) return null;
      for (let i = 0; i < n; i++) take(data[i * stride + 1], data[i * stride + 2]);
    } else if (view === 'polar') {
      const map = sol.polar;
      if (!map || map.r < 0) return null;
      for (let i = 0; i < n; i++) {
        const r = data[i * stride + 1 + map.r];
        const a = map.theta >= 0 ? data[i * stride + 1 + map.theta] : data[i * stride];
        if (!isFinite(r) || !isFinite(a)) continue;
        take(r * Math.cos(a), r * Math.sin(a));
      }
    } else {
      return null;
    }

    if (!isFinite(xlo) || !isFinite(ylo)) return null;
    const [x0, x1] = padRange(xlo, xhi, 0.06);
    const [y0, y1] = padRange(ylo, yhi, 0.06);
    return normaliseWindow({ x0, x1, y0, y1 });
  }

  /**
   * @param {object|null} sol  { names, dim, n, data:Float64Array, t0, t1,
   *                             playT, playY, polar:{r,theta}|null }
   */
  draw(sol) {
    const p = prepare(this.canvas);
    if (!p) return;
    const { ctx, w, h, dpr } = p;
    this.panes = [];

    const area = { L: 6, R: w - 6, T: 4, B: h - 4 };

    if (!this.views.length) {
      centredText(ctx, area, 'no view is on — turn one on above');
      return;
    }

    const cells = cellsFor(area, this.views.length);
    const many = this.views.length > 1;

    this.views.forEach((view, i) => {
      const cell = cells[i];
      const box = boxIn(cell);
      const pane = { view, cell, box, win: this.getWindow(view) };
      this.panes.push(pane);

      if (many) {
        ctx.save();
        ctx.strokeStyle = INK.paneEdge;
        ctx.lineWidth = 1 / dpr;
        ctx.strokeRect(
          crisp(cell.L, dpr), crisp(cell.T, dpr),
          Math.max(0, cell.R - cell.L), Math.max(0, cell.B - cell.T),
        );
        ctx.restore();
      }

      this._title(ctx, cell, VIEW_LABEL[view] || view);

      if (box.R - box.L < 60 || box.B - box.T < 46) return;

      const reason = this._reasonToNotDraw(view, sol);
      this._axes(ctx, dpr, pane, view !== 'polar');
      if (view === 'polar') this._polarGrid(ctx, dpr, pane);
      this._rules(ctx, dpr, box);

      if (reason) { centredText(ctx, box, reason); return; }

      if (view === 'time') this._time(ctx, dpr, pane, sol);
      else if (view === 'phase') this._phase(ctx, pane, sol);
      else if (view === 'polar') this._polar(ctx, pane, sol);
    });
  }

  /** Why this pane has no curve in it - a sentence, never an empty box. */
  _reasonToNotDraw(view, sol) {
    if (view === 'phase' && !this.support.phase) {
      return 'the phase plane needs exactly 2 states';
    }
    if (view === 'polar' && !this.support.polar) {
      return 'no polar content: define a state named r';
    }
    if (!sol || !sol.n || !sol.dim) return (sol && sol.message) || 'no solution yet';
    if (view === 'phase' && sol.dim !== 2) return 'the phase plane needs exactly 2 states';
    if (view === 'polar' && (!sol.polar || sol.polar.r < 0)) {
      return 'no polar content in this document';
    }
    return null;
  }

  // -- shared chrome --------------------------------------------------------

  _title(ctx, cell, text) {
    ctx.save();
    ctx.fillStyle = INK.title;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, cell.L + 6, cell.T + 4);
    ctx.restore();
  }

  /** Left + bottom rules. Kept light: the data is the loud part. */
  _rules(ctx, dpr, b) {
    ctx.save();
    ctx.strokeStyle = INK.frame;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    ctx.moveTo(crisp(b.L, dpr), b.T);
    ctx.lineTo(crisp(b.L, dpr), crisp(b.B, dpr));
    ctx.lineTo(b.R, crisp(b.B, dpr));
    ctx.stroke();
    ctx.restore();
  }

  /** The scales for a pane. `gridlines` off leaves the labels and the ticks. */
  _axes(ctx, dpr, pane, gridlines) {
    const b = pane.box;
    const w = pane.win;
    const sx = (v) => b.L + ((v - w.x0) / (w.x1 - w.x0)) * (b.R - b.L);
    const sy = (v) => b.B - ((v - w.y0) / (w.y1 - w.y0)) * (b.B - b.T);
    pane.sx = sx;
    pane.sy = sy;

    const xt = ticksFor(w.x0, w.x1, Math.max(2, Math.round((b.R - b.L) / 88)));
    const yt = ticksFor(w.y0, w.y1, Math.max(2, Math.round((b.B - b.T) / 54)));

    ctx.save();
    ctx.lineWidth = 1 / dpr;
    ctx.font = `10.5px ${MONO}`;
    ctx.fillStyle = INK.label;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xt.values) {
      const x = crisp(sx(v), dpr);
      if (gridlines || v === 0) {
        ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
        ctx.beginPath();
        ctx.moveTo(x, b.T);
        ctx.lineTo(x, b.B);
        ctx.stroke();
      }
      ctx.strokeStyle = INK.frame;
      ctx.beginPath();
      ctx.moveTo(x, crisp(b.B, dpr));
      ctx.lineTo(x, crisp(b.B, dpr) + 3);
      ctx.stroke();
      ctx.fillText(tickLabel(v, xt.step), sx(v), b.B + 6);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = crisp(sy(v), dpr);
      if (gridlines || v === 0) {
        ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
        ctx.beginPath();
        ctx.moveTo(b.L, y);
        ctx.lineTo(b.R, y);
        ctx.stroke();
      }
      ctx.strokeStyle = INK.frame;
      ctx.beginPath();
      ctx.moveTo(crisp(b.L, dpr) - 3, y);
      ctx.lineTo(crisp(b.L, dpr), y);
      ctx.stroke();
      ctx.fillText(tickLabel(v, yt.step), b.L - 6, sy(v));
    }
    ctx.restore();
  }

  /** Rings and spokes about the origin, in the pane's own (possibly
   *  anisotropic) scaling - an ellipse here is the honest picture of an axis
   *  the user has stretched. */
  _polarGrid(ctx, dpr, pane) {
    const b = pane.box;
    const w = pane.win;
    const cx = pane.sx(0);
    const cy = pane.sy(0);
    const kx = (b.R - b.L) / (w.x1 - w.x0);
    const ky = (b.B - b.T) / (w.y1 - w.y0);

    // the largest radius any corner of the window reaches
    let rmax = 0;
    for (const x of [w.x0, w.x1]) {
      for (const y of [w.y0, w.y1]) rmax = Math.max(rmax, Math.hypot(x, y));
    }
    if (!(rmax > 0)) rmax = 1;

    const rt = ticksFor(0, rmax, 5);

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.L, b.T, b.R - b.L, b.B - b.T);
    ctx.clip();
    ctx.lineWidth = 1 / dpr;
    ctx.strokeStyle = INK.grid;

    let drawn = 0;
    for (const v of rt.values) {
      if (v <= 0 || drawn > 14) continue;
      drawn++;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(v * kx), Math.abs(v * ky), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    const reach = Math.hypot((b.R - b.L), (b.B - b.T));
    for (let deg = 0; deg < 180; deg += 30) {
      const a = (deg * Math.PI) / 180;
      ctx.strokeStyle = deg === 0 || deg === 90 ? INK.gridZero : INK.grid;
      const ux = Math.cos(a) * reach;
      const uy = Math.sin(a) * reach;
      ctx.beginPath();
      ctx.moveTo(cx - ux, cy + uy);
      ctx.lineTo(cx + ux, cy - uy);
      ctx.stroke();
    }

    // label the rings along the positive x direction
    ctx.fillStyle = INK.faint;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    drawn = 0;
    for (const v of rt.values) {
      if (v <= 0 || drawn > 14) continue;
      drawn++;
      const x = cx + v * kx;
      if (x < b.L || x > b.R || cy < b.T - 4 || cy > b.B) continue;
      ctx.fillText(tickLabel(v, rt.step), x, cy + 3);
    }
    ctx.restore();
  }

  /** Clip to the data box and hand back a restore. */
  _clip(ctx, b) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.L, b.T, b.R - b.L, b.B - b.T);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  /**
   * One polyline. `upTo` < Infinity stops at the last sample whose time is not
   * past it, which is what makes travelled and ahead two different strokes of
   * the same curve.
   */
  _stroke(ctx, sol, xOf, yOf, sx, sy, upTo) {
    const stride = sol.dim + 1;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < sol.n; i++) {
      if (sol.data[i * stride] > upTo) break;
      const x = xOf(i);
      const y = yOf(i);
      if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
      const px = sx(x);
      const py = sy(y);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else { ctx.lineTo(px, py); }
    }
    ctx.stroke();
  }

  /** The playhead dot: a soft halo, a filled core, a paper-coloured ring. */
  _marker(ctx, b, x, y, colour) {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < b.L - 10 || x > b.R + 10 || y < b.T - 10 || y > b.B + 10) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = INK.halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = colour || seriesColor(0);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK.bg;
    ctx.stroke();
    ctx.restore();
  }

  // -- view: t vs y ---------------------------------------------------------

  _time(ctx, dpr, pane, sol) {
    const b = pane.box;
    const { dim, data } = sol;
    const stride = dim + 1;
    const sx = pane.sx;
    const sy = pane.sy;
    const pt = typeof sol.playT === 'number' && isFinite(sol.playT) ? sol.playT : Infinity;

    this._clip(ctx, b);
    ctx.lineWidth = 1.8;

    for (let d = 0; d < dim; d++) {
      const xOf = (i) => data[i * stride];
      const yOf = (i) => data[i * stride + 1 + d];
      ctx.strokeStyle = seriesColor(d);

      // what has not happened yet, ghosted...
      ctx.globalAlpha = AHEAD_ALPHA;
      this._stroke(ctx, sol, xOf, yOf, sx, sy, Infinity);
      // ...and what has, at full strength. Scrubbing reads as motion.
      ctx.globalAlpha = 1;
      this._stroke(ctx, sol, xOf, yOf, sx, sy, pt);
    }
    ctx.restore();

    if (!isFinite(pt)) return;

    const x = crisp(sx(pt), dpr);
    if (x >= b.L && x <= b.R) {
      ctx.save();
      ctx.strokeStyle = INK.playhead;
      ctx.lineWidth = 1 / dpr;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, b.T);
      ctx.lineTo(x, b.B);
      ctx.stroke();
      ctx.restore();
    }

    const py = sol.playY;
    if (!py || py.length < dim) return;
    for (let d = 0; d < dim; d++) {
      this._marker(ctx, b, sx(pt), sy(py[d]), seriesColor(d));
    }
  }

  // -- view: phase plane ----------------------------------------------------

  _phase(ctx, pane, sol) {
    const b = pane.box;
    const { data } = sol;
    const stride = sol.dim + 1;
    const sx = pane.sx;
    const sy = pane.sy;
    const pt = typeof sol.playT === 'number' && isFinite(sol.playT) ? sol.playT : Infinity;

    const xOf = (i) => data[i * stride + 1];
    const yOf = (i) => data[i * stride + 2];

    this._clip(ctx, b);
    ctx.strokeStyle = seriesColor(0);
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = AHEAD_ALPHA;
    this._stroke(ctx, sol, xOf, yOf, sx, sy, Infinity);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.9;
    this._stroke(ctx, sol, xOf, yOf, sx, sy, pt);
    ctx.restore();

    const py = sol.playY;
    if (py && py.length >= 2) this._marker(ctx, b, sx(py[0]), sy(py[1]), seriesColor(0));
  }

  // -- view: polar ----------------------------------------------------------

  _polar(ctx, pane, sol) {
    const b = pane.box;
    const { data, polar } = sol;
    const stride = sol.dim + 1;
    const sx = pane.sx;
    const sy = pane.sy;
    const ri = polar.r;
    const ai = polar.theta;             // < 0 means "the angle is t"
    const pt = typeof sol.playT === 'number' && isFinite(sol.playT) ? sol.playT : Infinity;

    const rOf = (i) => data[i * stride + 1 + ri];
    const aOf = (i) => (ai >= 0 ? data[i * stride + 1 + ai] : data[i * stride]);
    const xOf = (i) => rOf(i) * Math.cos(aOf(i));
    const yOf = (i) => rOf(i) * Math.sin(aOf(i));

    this._clip(ctx, b);
    ctx.strokeStyle = seriesColor(ri);
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = AHEAD_ALPHA;
    this._stroke(ctx, sol, xOf, yOf, sx, sy, Infinity);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.9;
    this._stroke(ctx, sol, xOf, yOf, sx, sy, pt);
    ctx.restore();

    const pv = sol.playY;
    if (pv && pv.length > ri) {
      const r = pv[ri];
      const a = ai >= 0 && pv.length > ai ? pv[ai] : sol.playT;
      if (isFinite(r) && isFinite(a)) {
        this._marker(ctx, b, sx(r * Math.cos(a)), sy(r * Math.sin(a)), seriesColor(ri));
      }
    }
  }
}
