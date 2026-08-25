// ============================================================================
// plot.js - the single plot surface for the Numpla shell.
//
// ONE canvas, ONE frame, and every enabled view drawn INTO it:
//
//   'time'   every state variable against t, one coloured polyline each
//   'phase'  state[1] against state[0]   (needs exactly 2 states)
//   'polar'  r against the angle, on the same cartesian frame
//
// HOW SEVERAL VIEWS SHARE THE CANVAS
// ----------------------------------
// They overlap. There is no tiling and there are no panes: one set of axes, one
// window, everything drawn over everything else. Tiling was the previous answer
// and it was wrong - it turned "show me two things about this system" into a
// layout problem, and it shrank the picture every time you asked for more of
// it. The views share the frame deliberately (docs/ui-v5.md).
//
// THE WINDOW IS THE USER'S - AND IT IS THE QUERY
// ----------------------------------------------
// There is one window - x0..x1, y0..y1 - defaulting to -5..5 on both axes
// rather than fitting the data, so two runs are comparable. Nothing in here
// ever changes it: panning, axis scaling and zooming are all done by the shell
// calling setWindow(); this module only supplies the geometry to do it with
// (hit) and the arithmetic (dataAt, panned, scaled, zoomed, fitted).
//
// While the t-y view is on, x0..x1 IS the integration span: the shell re-solves
// over whatever the horizontal axis is showing. That loop lives in main.js;
// this module just draws whatever window it is given.
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
};

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

/**
 * A sentence in the middle of the box. It wraps, because the sentence that
 * matters most here is a refusal - "Verlet needs second-order rows - x is a
 * first-order row ..." - and a refusal truncated to one line is a broken plot
 * with an excuse on it.
 */
function centredText(ctx, box, msg, colour) {
  ctx.save();
  ctx.fillStyle = colour || INK.faint;
  ctx.font = `12px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxW = Math.max(80, (box.R - box.L) * 0.82);
  const words = String(msg).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (!lines.length) lines.push('');

  const lh = 16;
  const cx = (box.L + box.R) / 2;
  const cy = (box.T + box.B) / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((text, i) => ctx.fillText(text, cx, cy + i * lh));
  ctx.restore();
}

/** The data box inside the canvas: room for tick labels on the left and below. */
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
// `show` - a document saying what is worth looking at
//
// A twelve-state document draws twelve curves and nobody wants twelve. `show`
// names the series that are the picture; the rest are still solved, they are
// just not drawn (docs/ui-v5.md). Absent means draw everything, which is right
// for a two-state system.
//
// The shell resolves the names to indices before it gets here, so this module
// never has to know what a state is called.
// ---------------------------------------------------------------------------

/** The state columns to draw: the `show` list, or every one of them. */
function statesShown(sol) {
  if (Array.isArray(sol.showStates)) return sol.showStates;
  const all = [];
  for (let d = 0; d < sol.dim; d++) all.push(d);
  return all;
}

/**
 * The derived series to draw. Each keeps its `slot` - its position in the full
 * derived list - so hiding one never recolours another.
 */
function extrasShown(sol) {
  const extra = sol.extra || [];
  const out = [];
  for (let e = 0; e < extra.length; e++) {
    if (Array.isArray(sol.showExtra) && sol.showExtra.indexOf(e) < 0) continue;
    out.push({ ...extra[e], slot: e });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plot - one canvas, one frame, every enabled view drawn into it
// ---------------------------------------------------------------------------

export class Plot {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    /** The views that are ON, in VIEWS order. Never changed from in here. */
    this.views = ['time'];
    /** The one window every view is drawn through. */
    this.window = { ...DEFAULT_WINDOW };
    /** view id -> false when the model cannot support it. The shell's menu
     *  reads this; nothing in here switches a view on or off. */
    this.support = { time: true, phase: true, polar: true };
    /** The data box as last drawn: what hit testing and the gestures use. */
    this.box = null;
    /** The whole drawable area as last drawn. */
    this.area = null;
  }

  /** @param {string[]} list the views that are on; order is canonical. */
  setViews(list) {
    const on = Array.isArray(list) ? list : [];
    this.views = VIEWS.filter((v) => on.indexOf(v) >= 0);
  }

  setSupport(support) {
    for (const v of VIEWS) this.support[v] = !!(support && support[v]);
  }

  getWindow() {
    return { ...this.window };
  }

  setWindow(win) {
    this.window = normaliseWindow(win, this.window);
  }

  resetWindow() {
    this.window = { ...DEFAULT_WINDOW };
  }

  /** True while the frame is still the default one. */
  isDefaultFrame() {
    return sameWindow(this.window, DEFAULT_WINDOW);
  }

  /**
   * Which part of the frame a point is in: 'body' pans, 'x' and 'y' scale that
   * one axis. There is only one frame now, so there is nothing to identify.
   * @returns {{box:object, region:string}|null}
   */
  hit(px, py) {
    const a = this.area;
    const b = this.box;
    if (!a || !b) return null;
    if (px < a.L || px > a.R || py < a.T || py > a.B) return null;
    let region = 'body';
    if (px < b.L) region = py <= b.B ? 'y' : 'body';
    else if (py > b.B) region = 'x';
    return { box: b, region };
  }

  /** Pixel -> data, inside the frame's box. */
  dataAt(box, px, py) {
    const w = this.window;
    const bw = Math.max(1, box.R - box.L);
    const bh = Math.max(1, box.B - box.T);
    return {
      x: w.x0 + ((px - box.L) / bw) * (w.x1 - w.x0),
      y: w.y0 + ((box.B - py) / bh) * (w.y1 - w.y0),
    };
  }

  /**
   * The window that would show every enabled view's curve, or null when there
   * is nothing to fit. Only ever called because someone asked for it.
   */
  fitWindow(sol) {
    if (!sol || !sol.n || !sol.dim) return null;
    const { dim, n, data } = sol;
    const stride = dim + 1;
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    const take = (x, y) => {
      if (isFinite(x)) { if (x < xlo) xlo = x; if (x > xhi) xhi = x; }
      if (isFinite(y)) { if (y < ylo) ylo = y; if (y > yhi) yhi = y; }
    };

    if (this.views.indexOf('time') >= 0) {
      for (const d of statesShown(sol)) {
        for (let i = 0; i < n; i++) take(data[i * stride], data[i * stride + 1 + d]);
      }
      // Derived rows share the frame, so fitting must see them too.
      for (const ex of extrasShown(sol)) {
        for (let i = 0; i < ex.n; i++) take(ex.pairs[i * 2], ex.pairs[i * 2 + 1]);
      }
    }
    if (this.views.indexOf('phase') >= 0 && dim === 2) {
      for (let i = 0; i < n; i++) take(data[i * stride + 1], data[i * stride + 2]);
    }
    if (this.views.indexOf('polar') >= 0 && sol.polar && sol.polar.r >= 0) {
      const map = sol.polar;
      for (let i = 0; i < n; i++) {
        const r = data[i * stride + 1 + map.r];
        const a = map.theta >= 0 ? data[i * stride + 1 + map.theta] : data[i * stride];
        if (!isFinite(r) || !isFinite(a)) continue;
        take(r * Math.cos(a), r * Math.sin(a));
      }
    }

    if (!isFinite(xlo) || !isFinite(ylo)) return null;
    const [x0, x1] = padRange(xlo, xhi, 0.06);
    const [y0, y1] = padRange(ylo, yhi, 0.06);
    return normaliseWindow({ x0, x1, y0, y1 });
  }

  /**
   * @param {object|null} sol  { names, dim, n, data:Float64Array, t0, t1,
   *                             polar:{r,theta}|null, extra, showStates,
   *                             showExtra, message }
   */
  draw(sol) {
    const p = prepare(this.canvas);
    if (!p) return;
    const { ctx, w, h, dpr } = p;

    const area = { L: 6, R: w - 6, T: 4, B: h - 4 };
    const box = boxIn(area);
    this.area = area;
    this.box = box;

    this._title(ctx, area, this.views.map((v) => VIEW_LABEL[v] || v).join('  ·  '));

    if (box.R - box.L < 60 || box.B - box.T < 46) return;

    const win = this.getWindow();
    const pane = { box, win };
    this._axes(ctx, dpr, pane, true);
    if (this.views.indexOf('polar') >= 0) this._polarGrid(ctx, dpr, pane);
    this._rules(ctx, dpr, box);

    if (!this.views.length) {
      centredText(ctx, box, 'no view is on — turn one on in the views menu');
      return;
    }
    if (!sol || !sol.n || !sol.dim) {
      centredText(ctx, box, (sol && sol.message) || 'no solution yet');
      return;
    }

    // Everything overlaps, in a fixed order so a view turning on never moves
    // one already there: the time curves first, the portraits over them.
    if (this.views.indexOf('time') >= 0) this._time(ctx, pane, sol);
    if (this.views.indexOf('phase') >= 0 && sol.dim === 2) this._phase(ctx, pane, sol);
    if (this.views.indexOf('polar') >= 0 && sol.polar && sol.polar.r >= 0) {
      this._polar(ctx, pane, sol);
    }
  }

  // -- shared chrome --------------------------------------------------------

  _title(ctx, area, text) {
    if (!text) return;
    ctx.save();
    ctx.fillStyle = INK.title;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, area.L + 6, area.T + 2);
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

  /** The scales for the frame. `gridlines` off leaves the labels and ticks. */
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

  /** Rings and spokes about the origin, in the frame's own (possibly
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
   * Stroke a flat [t, value] series. Derived rows are sampled on their own
   * grid - the compiler raises the count to at least one per accepted step, so
   * a conserved quantity is not aliased into a drifting one - which is why they
   * cannot share the state array's stride.
   */
  _strokePairs(ctx, ex, sx, sy) {
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < ex.n; i++) {
      const x = ex.pairs[i * 2];
      const y = ex.pairs[i * 2 + 1];
      if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
      const px = sx(x);
      const py = sy(y);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else { ctx.lineTo(px, py); }
    }
    ctx.stroke();
  }

  _stroke(ctx, sol, xOf, yOf, sx, sy) {
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < sol.n; i++) {
      const x = xOf(i);
      const y = yOf(i);
      if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }
      const px = sx(x);
      const py = sy(y);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else { ctx.lineTo(px, py); }
    }
    ctx.stroke();
  }

  // -- view: t vs y ---------------------------------------------------------

  _time(ctx, pane, sol) {
    const b = pane.box;
    const { dim, data } = sol;
    const stride = dim + 1;
    const sx = pane.sx;
    const sy = pane.sy;

    this._clip(ctx, b);
    ctx.lineWidth = 1.8;

    // `show` is a display choice: everything is still solved, and the states
    // left out are simply not drawn.
    for (const d of statesShown(sol)) {
      const xOf = (i) => data[i * stride];
      const yOf = (i) => data[i * stride + 1 + d];
      ctx.strokeStyle = seriesColor(d);
      this._stroke(ctx, sol, xOf, yOf, sx, sy);
    }

    // Derived rows, dashed so they read as measurements of the solution rather
    // than as more of it. This is the conservation monitor: a symplectic method
    // holds this line in a band, an adaptive one lets it walk away.
    ctx.setLineDash([5, 4]);
    for (const ex of extrasShown(sol)) {
      ctx.strokeStyle = seriesColor(dim + ex.slot);
      this._strokePairs(ctx, ex, sx, sy);
    }
    ctx.setLineDash([]);

    ctx.restore();
  }

  // -- view: phase plane ----------------------------------------------------

  _phase(ctx, pane, sol) {
    const b = pane.box;
    const { data } = sol;
    const stride = sol.dim + 1;

    const xOf = (i) => data[i * stride + 1];
    const yOf = (i) => data[i * stride + 2];

    this._clip(ctx, b);
    ctx.strokeStyle = seriesColor(0);
    ctx.lineWidth = 1.9;
    this._stroke(ctx, sol, xOf, yOf, pane.sx, pane.sy);
    ctx.restore();
  }

  // -- view: polar ----------------------------------------------------------

  _polar(ctx, pane, sol) {
    const b = pane.box;
    const { data, polar } = sol;
    const stride = sol.dim + 1;
    const ri = polar.r;
    const ai = polar.theta;             // < 0 means "the angle is t"

    const rOf = (i) => data[i * stride + 1 + ri];
    const aOf = (i) => (ai >= 0 ? data[i * stride + 1 + ai] : data[i * stride]);
    const xOf = (i) => rOf(i) * Math.cos(aOf(i));
    const yOf = (i) => rOf(i) * Math.sin(aOf(i));

    this._clip(ctx, b);
    ctx.strokeStyle = seriesColor(ri);
    ctx.lineWidth = 1.9;
    this._stroke(ctx, sol, xOf, yOf, pane.sx, pane.sy);
    ctx.restore();
  }
}
