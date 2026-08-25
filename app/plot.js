// ============================================================================
// plot.js - the single plot surface for the Numpla shell.
//
// ONE renderer, three views:
//   'time'   every state variable against t, one coloured polyline each
//   'phase'  state[1] against state[0]   (needs exactly 2 states)
//   'polar'  r against theta, drawn on a polar grid (needs an `r` state)
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
  label:    '#78818f',
  faint:    '#9aa2b0',
  ghost:    'rgba(88, 98, 116, 0.26)',
  playhead: 'rgba(15, 125, 112, 0.42)',
  halo:     'rgba(15, 125, 112, 0.13)',
};

const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

/** The view ids this module understands. `main.js` shares this vocabulary. */
export const VIEWS = ['time', 'phase', 'polar'];

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

function emptyState(ctx, w, h, msg) {
  ctx.save();
  ctx.fillStyle = INK.faint;
  ctx.font = `12px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
  ctx.restore();
}

/** The L / R / T / B box the data is drawn inside. */
function box(pad, w, h) {
  return { L: pad.l, R: w - pad.r, T: pad.t, B: h - pad.b };
}

// ---------------------------------------------------------------------------
// Plot - one canvas, one active view
// ---------------------------------------------------------------------------

export class Plot {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.view = 'time';
    this.pad = { l: 58, r: 20, t: 16, b: 32 };
  }

  /** @param {'time'|'phase'|'polar'} view */
  setView(view) {
    this.view = VIEWS.includes(view) ? view : 'time';
  }

  /**
   * @param {object|null} frame  { names, dim, n, data:Float64Array, t0, t1,
   *                               playT, playY, polar:{r,theta}|null }
   */
  draw(frame) {
    const p = prepare(this.canvas);
    if (!p) return;
    const { ctx, w, h, dpr } = p;

    if (!frame || !frame.n || !frame.dim) {
      emptyState(ctx, w, h, (frame && frame.message) || 'no solution yet');
      return;
    }

    const b = box(this.pad, w, h);
    if (b.R - b.L < 40 || b.B - b.T < 40) return;

    if (this.view === 'phase') {
      if (frame.dim !== 2) {
        emptyState(ctx, w, h, 'the phase plane needs exactly 2 states');
        return;
      }
      this._phase(ctx, w, h, dpr, b, frame);
      return;
    }

    if (this.view === 'polar') {
      if (!frame.polar || frame.polar.r < 0) {
        emptyState(ctx, w, h, 'no polar content in this document');
        return;
      }
      this._polar(ctx, w, h, dpr, b, frame);
      return;
    }

    this._time(ctx, w, h, dpr, b, frame);
  }

  // -- shared chrome --------------------------------------------------------

  /** Left + bottom rules. Kept light: the data is the loud part. */
  _rules(ctx, dpr, b) {
    ctx.strokeStyle = INK.frame;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    ctx.moveTo(crisp(b.L, dpr), b.T);
    ctx.lineTo(crisp(b.L, dpr), crisp(b.B, dpr));
    ctx.lineTo(b.R, crisp(b.B, dpr));
    ctx.stroke();
  }

  _caption(ctx, h, b, xText, yText) {
    ctx.fillStyle = INK.faint;
    ctx.font = `10.5px ${MONO}`;
    if (xText) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(xText, b.R, h - 3);
    }
    if (yText) {
      ctx.save();
      ctx.translate(12, b.T + 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(yText, 0, 0);
      ctx.restore();
    }
  }

  // -- view: t vs y ---------------------------------------------------------

  _time(ctx, w, h, dpr, b, frame) {
    const { dim, n, data, t0, t1 } = frame;
    const stride = dim + 1;

    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < dim; d++) {
        const v = data[i * stride + 1 + d];
        if (!isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    [lo, hi] = padRange(lo, hi);

    const sx = (t) => b.L + ((t - t0) / (t1 - t0 || 1)) * (b.R - b.L);
    const sy = (v) => b.B - ((v - lo) / (hi - lo || 1)) * (b.B - b.T);

    const xt = ticksFor(t0, t1, Math.max(2, Math.round((b.R - b.L) / 96)));
    const yt = ticksFor(lo, hi, Math.max(2, Math.round((b.B - b.T) / 54)));

    ctx.lineWidth = 1 / dpr;
    ctx.font = `10.5px ${MONO}`;
    ctx.fillStyle = INK.label;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xt.values) {
      const x = crisp(sx(v), dpr);
      ctx.strokeStyle = INK.grid;
      ctx.beginPath();
      ctx.moveTo(x, b.T);
      ctx.lineTo(x, b.B);
      ctx.stroke();
      ctx.fillText(tickLabel(v, xt.step), sx(v), b.B + 9);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = crisp(sy(v), dpr);
      ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
      ctx.beginPath();
      ctx.moveTo(b.L, y);
      ctx.lineTo(b.R, y);
      ctx.stroke();
      ctx.fillText(tickLabel(v, yt.step), b.L - 10, sy(v));
    }

    this._rules(ctx, dpr, b);
    this._caption(ctx, h, b, 't', null);

    // ---- curves -----------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.L, b.T, b.R - b.L, b.B - b.T);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.8;

    for (let d = 0; d < dim; d++) {
      ctx.strokeStyle = seriesColor(d);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const t = data[i * stride];
        const v = data[i * stride + 1 + d];
        if (!isFinite(v) || !isFinite(t)) { pen = false; continue; }
        const x = sx(t);
        const y = sy(v);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.restore();

    // ---- playhead ---------------------------------------------------------
    const pt = frame.playT;
    if (typeof pt === 'number' && isFinite(pt) && pt >= t0 - 1e-12 && pt <= t1 + 1e-12) {
      const x = crisp(sx(pt), dpr);
      ctx.save();
      ctx.strokeStyle = INK.playhead;
      ctx.lineWidth = 1 / dpr;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, b.T);
      ctx.lineTo(x, b.B);
      ctx.stroke();
      ctx.restore();

      const py = frame.playY;
      if (py && py.length >= dim) {
        for (let d = 0; d < dim; d++) {
          const v = py[d];
          if (!isFinite(v)) continue;
          const y = sy(v);
          if (y < b.T - 4 || y > b.B + 4) continue;
          ctx.beginPath();
          ctx.arc(sx(pt), y, 4, 0, Math.PI * 2);
          ctx.fillStyle = seriesColor(d);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = INK.bg;
          ctx.stroke();
        }
      }
    }
  }

  // -- view: phase plane ----------------------------------------------------

  _phase(ctx, w, h, dpr, b, frame) {
    const { n, data, names } = frame;
    const stride = 3;

    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = data[i * stride + 1];
      const c = data[i * stride + 2];
      if (isFinite(a)) { if (a < xlo) xlo = a; if (a > xhi) xhi = a; }
      if (isFinite(c)) { if (c < ylo) ylo = c; if (c > yhi) yhi = c; }
    }
    [xlo, xhi] = padRange(xlo, xhi);
    [ylo, yhi] = padRange(ylo, yhi);

    const pw = b.R - b.L;
    const ph = b.B - b.T;

    // equal aspect: one unit of x covers the same pixels as one unit of y
    const scale = Math.min(pw / (xhi - xlo), ph / (yhi - ylo));
    const cx = (xlo + xhi) / 2;
    const cy = (ylo + yhi) / 2;
    xlo = cx - pw / 2 / scale; xhi = cx + pw / 2 / scale;
    ylo = cy - ph / 2 / scale; yhi = cy + ph / 2 / scale;

    const sx = (v) => b.L + ((v - xlo) / (xhi - xlo)) * pw;
    const sy = (v) => b.B - ((v - ylo) / (yhi - ylo)) * ph;

    this._cartesianGrid(ctx, dpr, b, sx, sy, xlo, xhi, ylo, yhi);
    this._rules(ctx, dpr, b);

    // ---- orbit ------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.L, b.T, pw, ph);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = INK.ghost;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const a = data[i * stride + 1];
      const c = data[i * stride + 2];
      if (!isFinite(a) || !isFinite(c)) { pen = false; continue; }
      const x = sx(a), y = sy(c);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    // travelled arc, up to the playhead
    const pt = frame.playT;
    if (typeof pt === 'number' && isFinite(pt)) {
      ctx.strokeStyle = seriesColor(0);
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      pen = false;
      for (let i = 0; i < n; i++) {
        if (data[i * stride] > pt) break;
        const a = data[i * stride + 1];
        const c = data[i * stride + 2];
        if (!isFinite(a) || !isFinite(c)) { pen = false; continue; }
        const x = sx(a), y = sy(c);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.restore();

    const py = frame.playY;
    if (py && py.length >= 2) this._marker(ctx, b, sx(py[0]), sy(py[1]));

    if (names && names.length >= 2) this._caption(ctx, h, b, names[0], names[1]);
  }

  // -- view: polar ----------------------------------------------------------

  _polar(ctx, w, h, dpr, b, frame) {
    const { n, data, dim, polar } = frame;
    const stride = dim + 1;
    const ri = polar.r;
    const ai = polar.theta; // < 0 means "the angle is t"

    const rOf = (i) => data[i * stride + 1 + ri];
    const aOf = (i) => (ai >= 0 ? data[i * stride + 1 + ai] : data[i * stride]);

    let rmax = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.abs(rOf(i));
      if (isFinite(r) && r > rmax) rmax = r;
    }
    if (!(rmax > 0)) rmax = 1;
    rmax *= 1.06;

    const pw = b.R - b.L;
    const ph = b.B - b.T;
    const cx = b.L + pw / 2;
    const cy = b.T + ph / 2;
    const rad = Math.min(pw, ph) / 2;
    const k = rad / rmax;

    const px = (r, a) => cx + r * Math.cos(a) * k;
    const py = (r, a) => cy - r * Math.sin(a) * k;

    // ---- polar grid: rings + spokes ---------------------------------------
    const rt = ticksFor(0, rmax, Math.max(2, Math.round(rad / 46)));
    ctx.lineWidth = 1 / dpr;

    ctx.strokeStyle = INK.grid;
    for (const v of rt.values) {
      if (v <= 0) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, v * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let deg = 0; deg < 180; deg += 30) {
      const a = (deg * Math.PI) / 180;
      ctx.strokeStyle = deg === 0 || deg === 90 ? INK.gridZero : INK.grid;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * rad, cy + Math.sin(a) * rad);
      ctx.lineTo(cx + Math.cos(a) * rad, cy - Math.sin(a) * rad);
      ctx.stroke();
    }

    ctx.strokeStyle = INK.frame;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();

    // radius labels along the positive x axis
    ctx.fillStyle = INK.label;
    ctx.font = `10.5px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of rt.values) {
      if (v <= 0) continue;
      ctx.fillText(tickLabel(v, rt.step), cx + v * k, cy + 4);
    }

    // ---- curve ------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = INK.ghost;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const r = rOf(i), a = aOf(i);
      if (!isFinite(r) || !isFinite(a)) { pen = false; continue; }
      const x = px(r, a), y = py(r, a);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    const pt = frame.playT;
    if (typeof pt === 'number' && isFinite(pt)) {
      ctx.strokeStyle = seriesColor(ri);
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      pen = false;
      for (let i = 0; i < n; i++) {
        if (data[i * stride] > pt) break;
        const r = rOf(i), a = aOf(i);
        if (!isFinite(r) || !isFinite(a)) { pen = false; continue; }
        const x = px(r, a), y = py(r, a);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.restore();

    // ---- playhead marker --------------------------------------------------
    const pv = frame.playY;
    if (pv && pv.length > ri) {
      const r = pv[ri];
      const a = ai >= 0 && pv.length > ai ? pv[ai] : frame.playT;
      if (isFinite(r) && isFinite(a)) this._marker(ctx, b, px(r, a), py(r, a));
    }

    const rName = (frame.names && frame.names[ri]) || 'r';
    const aName = ai >= 0 ? (frame.names && frame.names[ai]) || 'theta' : 't';
    this._caption(ctx, h, b, `${rName} ∠ ${aName}`, null);
  }

  // -- shared bits ----------------------------------------------------------

  _cartesianGrid(ctx, dpr, b, sx, sy, xlo, xhi, ylo, yhi) {
    const xt = ticksFor(xlo, xhi, Math.max(2, Math.round((b.R - b.L) / 88)));
    const yt = ticksFor(ylo, yhi, Math.max(2, Math.round((b.B - b.T) / 54)));

    ctx.lineWidth = 1 / dpr;
    ctx.font = `10.5px ${MONO}`;
    ctx.fillStyle = INK.label;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xt.values) {
      const x = crisp(sx(v), dpr);
      ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
      ctx.beginPath();
      ctx.moveTo(x, b.T);
      ctx.lineTo(x, b.B);
      ctx.stroke();
      ctx.fillText(tickLabel(v, xt.step), sx(v), b.B + 9);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = crisp(sy(v), dpr);
      ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
      ctx.beginPath();
      ctx.moveTo(b.L, y);
      ctx.lineTo(b.R, y);
      ctx.stroke();
      ctx.fillText(tickLabel(v, yt.step), b.L - 10, sy(v));
    }
  }

  /** The playhead dot: a soft halo, a filled core, a paper-coloured ring. */
  _marker(ctx, b, x, y) {
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < b.L - 10 || x > b.R + 10 || y < b.T - 10 || y > b.B + 10) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = INK.halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = seriesColor(0);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK.bg;
    ctx.stroke();
    ctx.restore();
  }
}
