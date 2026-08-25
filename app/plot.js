// ============================================================================
// plot.js - 2D canvas rendering for the Numpla shell.
//
// Two renderers:
//   TimePlot   state variables against time, one colored polyline each
//   PhasePlot  state[1] against state[0] (only meaningful when dim === 2)
//
// Both are device-pixel-ratio aware: the backing store is sized in device
// pixels and the context is scaled, so lines land on real pixels and the plot
// stays crisp on a HiDPI display.
// ============================================================================

export const SERIES = [
  '#60e0c8', // teal   (accent)
  '#f0b95e', // amber
  '#a48cf5', // violet
  '#f2808f', // rose
  '#5fb6f2', // sky
  '#a9dd63', // lime
  '#f29ad6', // pink
  '#7de3e8', // cyan
];

export const seriesColor = (i) => SERIES[i % SERIES.length];

const INK = {
  grid:     '#161c26',
  gridZero: '#242d3b',
  frame:    '#1e2531',
  label:    '#6d788a',
  ghost:    'rgba(150, 162, 180, 0.30)',
  playhead: 'rgba(96, 224, 200, 0.42)',
  bg:       '#0c0f14',
};

const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

// ---------------------------------------------------------------------------
// numeric helpers
// ---------------------------------------------------------------------------

/** Nice round tick step covering [lo, hi] in roughly `target` divisions. */
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

/** Compact fixed-width-ish formatting for readouts. */
export function fmtValue(v) {
  if (!isFinite(v)) return String(v);
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
 * units are CSS pixels. Returns null when the element has no layout box yet.
 */
function prepare(canvas) {
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
  ctx.fillStyle = INK.label;
  ctx.font = `12px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// TimePlot
// ---------------------------------------------------------------------------

export class TimePlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.pad = { l: 56, r: 16, t: 12, b: 30 };
  }

  /**
   * @param {object|null} f  frame: { names, dim, n, data:Float64Array,
   *                                  t0, t1, playT, playY }
   */
  draw(frame) {
    const p = prepare(this.canvas);
    if (!p) return;
    const { ctx, w, h, dpr } = p;

    if (!frame || !frame.n || !frame.dim) {
      emptyState(ctx, w, h, frame && frame.message ? frame.message : 'no solution');
      return;
    }

    const { dim, n, data, t0, t1 } = frame;
    const stride = dim + 1;

    // y extent across every state variable
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

    const L = this.pad.l;
    const R = w - this.pad.r;
    const T = this.pad.t;
    const B = h - this.pad.b;
    if (R - L < 20 || B - T < 20) return;

    const sx = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (R - L);
    const sy = (v) => B - ((v - lo) / (hi - lo || 1)) * (B - T);

    // ---- grid ------------------------------------------------------------
    const xt = ticksFor(t0, t1, Math.max(2, Math.round((R - L) / 96)));
    const yt = ticksFor(lo, hi, Math.max(2, Math.round((B - T) / 54)));

    ctx.lineWidth = 1 / dpr;
    ctx.font = `10.5px ${MONO}`;
    ctx.fillStyle = INK.label;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xt.values) {
      const x = crisp(sx(v), dpr);
      ctx.strokeStyle = INK.grid;
      ctx.beginPath();
      ctx.moveTo(x, T);
      ctx.lineTo(x, B);
      ctx.stroke();
      ctx.fillText(tickLabel(v, xt.step), sx(v), B + 9);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = crisp(sy(v), dpr);
      ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(R, y);
      ctx.stroke();
      ctx.fillText(tickLabel(v, yt.step), L - 10, sy(v));
    }

    // frame: left + bottom rules only, kept light
    ctx.strokeStyle = INK.frame;
    ctx.beginPath();
    ctx.moveTo(crisp(L, dpr), T);
    ctx.lineTo(crisp(L, dpr), crisp(B, dpr));
    ctx.lineTo(R, crisp(B, dpr));
    ctx.stroke();

    // axis captions
    ctx.fillStyle = INK.label;
    ctx.font = `10.5px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('t', R, h - 2);

    // ---- curves ----------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, R - L, B - T);
    ctx.clip();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.75;

    for (let d = 0; d < dim; d++) {
      ctx.strokeStyle = seriesColor(d);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const t = data[i * stride];
        const v = data[i * stride + 1 + d];
        if (!isFinite(v) || !isFinite(t)) {
          pen = false;
          continue;
        }
        const x = sx(t);
        const y = sy(v);
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // ---- playhead --------------------------------------------------------
    const pt = frame.playT;
    if (typeof pt === 'number' && isFinite(pt) && pt >= t0 - 1e-12 && pt <= t1 + 1e-12) {
      const x = crisp(sx(pt), dpr);
      ctx.save();
      ctx.strokeStyle = INK.playhead;
      ctx.lineWidth = 1 / dpr;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, T);
      ctx.lineTo(x, B);
      ctx.stroke();
      ctx.restore();

      const py = frame.playY;
      if (py && py.length >= dim) {
        for (let d = 0; d < dim; d++) {
          const v = py[d];
          if (!isFinite(v)) continue;
          const y = sy(v);
          if (y < T - 4 || y > B + 4) continue;
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
}

// ---------------------------------------------------------------------------
// PhasePlot
// ---------------------------------------------------------------------------

export class PhasePlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.pad = { l: 56, r: 18, t: 12, b: 30 };
  }

  draw(frame) {
    const p = prepare(this.canvas);
    if (!p) return;
    const { ctx, w, h, dpr } = p;

    if (!frame || !frame.n || frame.dim !== 2) {
      emptyState(ctx, w, h, 'phase plane needs exactly 2 states');
      return;
    }

    const { n, data, names } = frame;
    const stride = 3;

    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = data[i * stride + 1];
      const b = data[i * stride + 2];
      if (isFinite(a)) { if (a < xlo) xlo = a; if (a > xhi) xhi = a; }
      if (isFinite(b)) { if (b < ylo) ylo = b; if (b > yhi) yhi = b; }
    }
    [xlo, xhi] = padRange(xlo, xhi);
    [ylo, yhi] = padRange(ylo, yhi);

    const L = this.pad.l;
    const R = w - this.pad.r;
    const T = this.pad.t;
    const B = h - this.pad.b;
    const pw = R - L;
    const ph = B - T;
    if (pw < 20 || ph < 20) return;

    // equal aspect: one unit of x covers the same pixels as one unit of y
    const scale = Math.min(pw / (xhi - xlo), ph / (yhi - ylo));
    const cx = (xlo + xhi) / 2;
    const cy = (ylo + yhi) / 2;
    const halfX = pw / 2 / scale;
    const halfY = ph / 2 / scale;
    xlo = cx - halfX; xhi = cx + halfX;
    ylo = cy - halfY; yhi = cy + halfY;

    const sx = (v) => L + ((v - xlo) / (xhi - xlo)) * pw;
    const sy = (v) => B - ((v - ylo) / (yhi - ylo)) * ph;

    // ---- grid ------------------------------------------------------------
    const xt = ticksFor(xlo, xhi, Math.max(2, Math.round(pw / 88)));
    const yt = ticksFor(ylo, yhi, Math.max(2, Math.round(ph / 54)));

    ctx.lineWidth = 1 / dpr;
    ctx.font = `10.5px ${MONO}`;
    ctx.fillStyle = INK.label;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of xt.values) {
      const x = crisp(sx(v), dpr);
      ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
      ctx.beginPath();
      ctx.moveTo(x, T);
      ctx.lineTo(x, B);
      ctx.stroke();
      ctx.fillText(tickLabel(v, xt.step), sx(v), B + 9);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = crisp(sy(v), dpr);
      ctx.strokeStyle = v === 0 ? INK.gridZero : INK.grid;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(R, y);
      ctx.stroke();
      ctx.fillText(tickLabel(v, yt.step), L - 10, sy(v));
    }

    ctx.strokeStyle = INK.frame;
    ctx.beginPath();
    ctx.moveTo(crisp(L, dpr), T);
    ctx.lineTo(crisp(L, dpr), crisp(B, dpr));
    ctx.lineTo(R, crisp(B, dpr));
    ctx.stroke();

    // ---- trajectory ------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, pw, ph);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // whole orbit, ghosted
    ctx.strokeStyle = INK.ghost;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const a = data[i * stride + 1];
      const b = data[i * stride + 2];
      if (!isFinite(a) || !isFinite(b)) { pen = false; continue; }
      const x = sx(a), y = sy(b);
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
        const t = data[i * stride];
        if (t > pt) break;
        const a = data[i * stride + 1];
        const b = data[i * stride + 2];
        if (!isFinite(a) || !isFinite(b)) { pen = false; continue; }
        const x = sx(a), y = sy(b);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.restore();

    // ---- playhead marker -------------------------------------------------
    const py = frame.playY;
    if (py && py.length >= 2 && isFinite(py[0]) && isFinite(py[1])) {
      const x = sx(py[0]);
      const y = sy(py[1]);
      if (x >= L - 8 && x <= R + 8 && y >= T - 8 && y <= B + 8) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 8.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(96, 224, 200, 0.14)';
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

    // ---- axis captions ---------------------------------------------------
    if (names && names.length >= 2) {
      ctx.fillStyle = INK.label;
      ctx.font = `10.5px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(names[0], R, h - 2);
      ctx.save();
      ctx.translate(11, T + 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(names[1], 0, 0);
      ctx.restore();
    }
  }
}
