// A DOM shim just large enough to boot app/main.js in Node.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => x && this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { if (on === undefined) on = !this.set.has(c); if (on) this.set.add(c); else this.set.delete(c); return on; }
  get value() { return Array.from(this.set).join(' '); }
  toString() { return this.value; }
}

let ACTIVE = null;

function matchesSimple(el, sel) {
  const parts = sel.match(/[.#]?[A-Za-z0-9_-]+/g) || [];
  for (const p of parts) {
    if (p[0] === '.') { if (!el.classList.contains(p.slice(1))) return false; }
    else if (p[0] === '#') { if (el.id !== p.slice(1)) return false; }
    else if (el.tagName !== p.toUpperCase()) return false;
  }
  return parts.length > 0;
}
function matches(el, selector) {
  return String(selector).split(',').map((s) => s.trim()).filter(Boolean)
    .some((s) => matchesSimple(el, s));
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attrs = new Map();
    this._text = '';
    this._listeners = [];
    this.id = '';
    this.hidden = false;
    this.title = '';
    this.tabIndex = -1;
    this.offsetWidth = 200;
    this.offsetHeight = 100;
    this.value = '';
    this.isContentEditable = false;
  }
  get className() { return this.classList.value; }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get firstChild() { return this.childNodes[0] || null; }

  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); this._text = ''; return n; }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }
  insertBefore(n, before) {
    if (!before) return this.appendChild(n);
    const i = this.childNodes.indexOf(before);
    if (i < 0) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; } return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }

  get textContent() {
    if (this.childNodes.length) return this.childNodes.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._text = v == null ? '' : String(v); }
  set innerHTML(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._text = String(v).replace(/<[^>]*>/g, ''); }
  get innerHTML() { return this.textContent; }

  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }

  get nodeType() { return 1; }

  * walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelector(sel) { for (const n of this.walk()) if (matches(n, sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; for (const n of this.walk()) if (matches(n, sel)) out.push(n); return out; }
  closest(sel) { for (let p = this; p; p = p.parentNode) if (p instanceof El && matches(p, sel)) return p; return null; }
  matches(sel) { return matches(this, sel); }

  getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40, x: 0, y: 0 }; }
  getContext() {
    const noop = () => {};
    const self = this;
    return new Proxy({}, {
      get: (t, k) => (k === 'canvas' ? self
        : k === 'measureText' ? (() => ({ width: 10 }))
        : k in t ? t[k] : noop),
      set: (t, k, v) => { t[k] = v; return true; },
    });
  }
  focus() { if (ACTIVE === this) return; const prev = ACTIVE; ACTIVE = this; doc.activeElement = this; if (prev) prev._fire('blur'); this._fire('focus'); }
  blur() { if (ACTIVE === this) { ACTIVE = null; doc.activeElement = doc.body; this._fire('blur'); } }
  select() {}
  setPointerCapture() {}

  addEventListener(type, fn, opts) { this._listeners.push({ type, fn, capture: !!(opts === true || (opts && opts.capture)) }); }
  removeEventListener(type, fn) { this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn)); }
  _fire(type, init) { return dispatch(this, type, init); }
  dispatchEvent(ev) { return dispatch(this, ev.type, ev); }
}

function dispatch(target, type, init = {}) {
  const ev = Object.assign({
    currentTarget: null, defaultPrevented: false, _stop: false,
    key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    button: 0, clientX: 0, clientY: 0, pointerId: 1,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
  }, init);
  ev.type = type;
  ev.target = target;

  const chain = [];
  for (let p = target; p; p = p.parentNode) chain.push(p);
  const down = chain.slice().reverse();
  for (const node of down) {
    if (ev._stop) return !ev.defaultPrevented;
    for (const l of node._listeners.slice()) {
      if (l.type === type && (l.capture || node === target)) { ev.currentTarget = node; l.fn.call(node, ev); }
    }
  }
  for (const node of chain) {
    if (ev._stop) return !ev.defaultPrevented;
    if (node === target) continue;
    for (const l of node._listeners.slice()) {
      if (l.type === type && !l.capture) { ev.currentTarget = node; l.fn.call(node, ev); }
    }
  }
  return !ev.defaultPrevented;
}

const doc = {
  _byId: new Map(),
  documentElement: new El('html'),
  body: new El('body'),
  activeElement: null,
  createElement(tag) { return new El(tag); },
  createElementNS(ns, tag) { return new El(tag); },
  getElementById(id) { return doc._byId.get(id) || null; },
  querySelector(sel) { return doc.body.querySelector(sel); },
  querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
  addEventListener(t, fn, o) { doc.body.addEventListener(t, fn, o); },
  removeEventListener(t, fn) { doc.body.removeEventListener(t, fn); },
};
doc.documentElement.appendChild(doc.body);
doc.activeElement = doc.body;

/** Register an element under an id, parented to `parent`. */
export function mount(id, tag, cls, parent) {
  const e = new El(tag);
  e.id = id;
  if (cls) e.className = cls;
  (parent || doc.body).appendChild(e);
  if (id) doc._byId.set(id, e);
  return e;
}
export { doc, El, dispatch };

export function install() {
  const g = globalThis;
  g.document = doc;
  g.Element = El;
  g.window = g;
  g.devicePixelRatio = 1;
  g.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
  g.cancelAnimationFrame = (h) => clearTimeout(h);
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
  };
  g.addEventListener = (t, fn, o) => doc.body.addEventListener(t, fn, o);
  g.removeEventListener = (t, fn) => doc.body.removeEventListener(t, fn);
  g.innerWidth = 1400;
  g.innerHeight = 900;
  const realFetch = g.fetch;
  g.fetch = async (url, opts) => {
    const s = String(url);
    if (s.startsWith('file:')) {
      const buf = fs.readFileSync(fileURLToPath(s));
      return new Response(buf, {
        headers: { 'content-type': s.endsWith('.wasm') ? 'application/wasm' : 'text/plain' },
      });
    }
    return realFetch(url, opts);
  };
}

// ---------------------------------------------------------------------------
// Build the document from the real index.html.
//
// The alternative — hand-mounting the elements a harness thinks the app needs —
// drifts the moment the markup changes, and drifts silently: the harness keeps
// passing while the real page is missing an element. Reading the actual file
// means the harness cannot go stale, and a `getElementById` in main.js with no
// matching id in the HTML fails here instead of in someone's browser.
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseAttrs(text) {
  const attrs = [];
  const re = /([:A-Za-z_][-.:\w]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? '']);
  }
  return attrs;
}

/** Populate `doc.body` from an HTML file's <body>. Returns the body element. */
export function buildFromHtml(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const bodyStart = html.indexOf('<body');
  const src = bodyStart < 0 ? html : html.slice(html.indexOf('>', bodyStart) + 1);

  const stack = [doc.body];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][-\w]*)\s*>|<([A-Za-z][-\w]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const [all, closeTag, openTag, attrText, selfClose, text] = m;
    if (all.startsWith('<!--')) continue;

    if (closeTag) {
      if (closeTag.toLowerCase() === 'body') break;
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (openTag) {
      const el = new El(openTag.toUpperCase());
      for (const [k, v] of parseAttrs(attrText || '')) {
        if (k === 'class') el.className = v;
        else if (k === 'hidden') el.hidden = true;
        else if (k === 'value') el.value = v;
        else if (k === 'title') { el.title = v; el.setAttribute(k, v); }
        else if (k.startsWith('data-')) {
          el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
          el.setAttribute(k, v);
        } else el.setAttribute(k, v);
      }
      // getElementById is backed by an explicit index, so an id written in the
      // markup has to be registered here or the app cannot find it.
      if (el.id) doc._byId.set(el.id, el);
      stack[stack.length - 1].appendChild(el);
      if (!selfClose && !VOID_TAGS.has(openTag.toLowerCase())) stack.push(el);
      continue;
    }
    if (text && text.trim()) {
      const host = stack[stack.length - 1];
      // Only meaningful for leaves; a container's text is rebuilt by the app.
      if (host.childNodes.length === 0) host._text = (host._text || '') + text.trim();
    }
  }
  return doc.body;
}
