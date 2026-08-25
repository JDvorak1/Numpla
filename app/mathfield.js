// ============================================================================
// mathfield.js - Numpla's editable math field.
//
// Self-contained. No dependencies, no web fonts, no CDN, and no DOM access at
// import time, so the model + serialiser layer is importable in plain Node.
//
// The internal representation is a *tree of atoms*, never a string. A math list
// is a plain array of atoms; structures (fractions, radicals, superscripts,
// delimiters, subscripts) own child lists called *slots*. The caret is a
// position inside that tree: a path of [atomIndex, slotKey] steps from the root
// plus an integer index into the list that path resolves to.
//
// Rendering is a pure projection of the tree onto DOM + CSS. Nothing in the
// edit model depends on the rendering, which is why it can all be tested
// headlessly.
// ============================================================================

// ---------------------------------------------------------------------------
// Vocabulary - mirrors crates/numpla-expr/src/lexer.rs
//
// Numpla's convention: an identifier is ONE letter plus an optional subscript,
// so `xy` is x*y. A multi-letter run only stays whole when it is a known
// function name or a named constant.
// ---------------------------------------------------------------------------

export const FUNCS = [
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan',
  'sqrt', 'exp', 'ln', 'log', 'abs', 'min', 'max', 'floor', 'ceil', 'round',
  'sign', 'mod',
];

export const CONSTS = ['pi', 'tau', 'inf'];

const WORDS = FUNCS.concat(CONSTS);

/**
 * User-defined function names, normalised.
 *
 * `f(u)` is a call; `g (u)` is `g` times `u`, and which one a row means is
 * decided by the rest of the document: a name with an `f(u) = ...` row is a
 * function, everything else followed by `(` is a coefficient (docs/wasm-api.md,
 * "Calls and coefficients"). One row cannot answer that on its own, so the
 * shell tells the field which names are functions and the field mirrors the
 * grammar rather than guessing.
 *
 * @param {Iterable<string>|null} names e.g. ['d', 'k_1'] - braces and spaces in
 *   a name are ignored, so `k_{1}` and `k_1` are the same function.
 * @returns {Set<string>}
 */
export function normaliseFunctions(names) {
  const out = new Set();
  for (const n of names || []) {
    const clean = String(n).replace(/[{}\s]/g, '');
    if (clean) out.add(clean);
  }
  return out;
}

/**
 * The function names a whole document defines: its `f(u) = ...` rows, where
 * every argument is a plain identifier. `x(0) = 1` is an initial condition, not
 * a definition, so it does not count - which is the same distinction the Rust
 * side draws. Hand the result to setFunctions() on every row.
 *
 * @param {string} source the whole document, one row per line
 * @returns {string[]}
 */
export function functionNamesIn(source) {
  const NAME = String.raw`[A-Za-z](?:_[A-Za-z0-9]+|_\{[^}]*\})?`;
  const head = new RegExp(String.raw`^\s*(${NAME})\s*\(([^)]*)\)\s*=`);
  const arg = new RegExp(String.raw`^${NAME}$`);
  const out = [];
  for (const line of String(source == null ? '' : source).split(/\r?\n/)) {
    const m = head.exec(line.split('#')[0]);
    if (!m) continue;
    const args = m[2].split(',').map((a) => a.trim());
    if (!args.every((a) => arg.test(a))) continue;
    out.push(m[1].replace(/[{}]/g, ''));
  }
  return out;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** The name a `var` atom would have in the document, e.g. `k_1`. */
function varKey(atom) {
  if (!atom || atom.type !== 'var') return null;
  if (!atom.sub) return atom.name;
  const sub = atom.sub.map((a) => a.ch || a.name || '').join('');
  return sub ? atom.name + '_' + sub : atom.name;
}
const MAX_WORD = WORDS.reduce((m, w) => Math.max(m, w.length), 0);

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------
//   digit  { ch }                 one character of a numeric literal ('.' too)
//   var    { name, sub|null }     a single letter, optional subscript slot
//   const  { name }               pi | tau | inf - upright, never split
//   func   { name }               sin, cos, exp... - upright function name
//   op     { ch }                 + - * = ,
//   prime  {}                     one ' mark
//   frac   { num, den }           stacked fraction
//   sup    { body }               superscript riding on whatever precedes it
//   sqrt   { body }               radical
//   group  { open, close, body }  matched delimiters that grow
//   text   { ch }                 one verbatim character of a `#` comment
//
// `text` atoms are the one exception to "everything here is mathematics": they
// only ever appear as a suffix of the ROOT list, that suffix always starts with
// the `#`, and every character is stored and emitted byte for byte. It mirrors
// numpla-model, which reads each line up to its first `#` and discards the rest
// (crates/numpla-model/src/document.rs).
// ---------------------------------------------------------------------------

export const A = {
  digit: (ch) => ({ type: 'digit', ch }),
  var: (name, sub = null) => ({ type: 'var', name, sub }),
  konst: (name) => ({ type: 'const', name }),
  func: (name) => ({ type: 'func', name }),
  op: (ch) => ({ type: 'op', ch }),
  prime: () => ({ type: 'prime' }),
  frac: (num = [], den = []) => ({ type: 'frac', num, den }),
  sup: (body = []) => ({ type: 'sup', body }),
  sqrt: (body = []) => ({ type: 'sqrt', body }),
  group: (open = '(', body = []) => ({
    type: 'group', open, close: open === '[' ? ']' : ')', body,
  }),
  text: (ch) => ({ type: 'text', ch }),
};

/** Index of the `#` that opens the comment tail, or -1 if the row has none. */
export function tailStart(list) {
  for (let i = 0; i < list.length; i++) if (list[i].type === 'text') return i;
  return -1;
}

/**
 * A *comment row* carries nothing but a comment - its tail starts at the very
 * beginning. These are the rows numpla-model discards wholesale, and the rows
 * the field sets as prose rather than as mathematics.
 */
export function isCommentRow(list) {
  return list.length > 0 && list[0].type === 'text';
}

/** One text atom per character. A row is a row, so newlines cannot survive. */
function textAtoms(str) {
  return Array.from(String(str).replace(/[\r\n]/g, '')).map((c) => A.text(c));
}

/** Child slots of an atom, in caret-traversal order. */
export function slotKeys(a) {
  switch (a.type) {
    case 'frac': return ['num', 'den'];
    case 'sup':
    case 'sqrt':
    case 'group': return ['body'];
    case 'var': return a.sub ? ['sub'] : [];
    default: return [];
  }
}

/** Atom types that can form part of an operand (what `/` and `^` grab). */
const OPERAND = new Set(['digit', 'var', 'const', 'prime', 'frac', 'sup', 'sqrt', 'group']);

/** Deep copy of a math list. */
export function cloneList(list) {
  return list.map((a) => {
    const c = { ...a };
    for (const k of slotKeys(a)) c[k] = cloneList(a[k]);
    return c;
  });
}

// ---------------------------------------------------------------------------
// Caret state: { root, path, index }
//
// `path` is [[atomIndex, slotKey], ...]; `index` is a position in the list that
// path resolves to (0 .. list.length, i.e. always *between* atoms).
// ---------------------------------------------------------------------------

export function newState(root = [], funcs = null) {
  return {
    root,
    path: [],
    index: 0,
    funcs: funcs instanceof Set ? funcs : normaliseFunctions(funcs),
    // The text this row was last *given*, or null once the user has edited it.
    // Emission parenthesises, so `(1)/(d)(x, y)` cannot be told apart from a
    // row the user typed that way: the only faithful thing to re-read when the
    // function set arrives late is the text as it was handed over.
    pristine: null,
  };
}

export function listAt(root, path) {
  let l = root;
  for (const [i, k] of path) {
    const a = l[i];
    if (!a || !a[k]) return null;
    l = a[k];
  }
  return l;
}

export function curList(st) {
  return listAt(st.root, st.path) || st.root;
}

/** The slot the caret currently sits in: { list, index, key, atom }. */
function parentOf(st) {
  if (!st.path.length) return null;
  const [i, k] = st.path[st.path.length - 1];
  const list = listAt(st.root, st.path.slice(0, -1));
  if (!list || !list[i]) return null;
  return { list, index: i, key: k, atom: list[i] };
}

/** Force the caret back onto a valid position (after a model replacement). */
export function clampCaret(st) {
  while (st.path.length && !listAt(st.root, st.path)) st.path.pop();
  const L = curList(st);
  st.index = Math.max(0, Math.min(st.index, L.length));
}

export function samePath(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

// --- movement --------------------------------------------------------------

function enterFirst(st, at, atom) {
  st.path.push([at, slotKeys(atom)[0]]);
  st.index = 0;
}

function enterLast(st, at, atom) {
  const ks = slotKeys(atom);
  const k = ks[ks.length - 1];
  st.path.push([at, k]);
  st.index = atom[k].length;
}

function exitRight(st) {
  const p = parentOf(st);
  if (!p) return false;
  const ks = slotKeys(p.atom);
  const ki = ks.indexOf(p.key);
  if (ki >= 0 && ki < ks.length - 1) {
    st.path[st.path.length - 1] = [p.index, ks[ki + 1]];
    st.index = 0;
    return true;
  }
  st.path.pop();
  st.index = p.index + 1;
  return true;
}

function exitLeft(st) {
  const p = parentOf(st);
  if (!p) return false;
  const ks = slotKeys(p.atom);
  const ki = ks.indexOf(p.key);
  if (ki > 0) {
    const prev = ks[ki - 1];
    st.path[st.path.length - 1] = [p.index, prev];
    st.index = p.atom[prev].length;
    return true;
  }
  st.path.pop();
  st.index = p.index;
  return true;
}

export function moveRight(st) {
  const L = curList(st);
  if (st.index < L.length) {
    const a = L[st.index];
    if (slotKeys(a).length) enterFirst(st, st.index, a);
    else st.index++;
    return true;
  }
  return exitRight(st);
}

export function moveLeft(st) {
  const L = curList(st);
  if (st.index > 0) {
    const a = L[st.index - 1];
    if (slotKeys(a).length) enterLast(st, st.index - 1, a);
    else st.index--;
    return true;
  }
  return exitLeft(st);
}

/**
 * Up/down. Walks outward through enclosing structures looking for somewhere
 * vertical to go (a fraction's other half, out of a superscript). Returns false
 * when there is nowhere - the field then reports the keystroke to the host list
 * through onNavigate so focus can move between rows.
 */
export function moveVert(st, dir) {
  for (let d = st.path.length - 1; d >= 0; d--) {
    const [i, k] = st.path[d];
    const outer = listAt(st.root, st.path.slice(0, d));
    const atom = outer && outer[i];
    if (!atom) continue;
    if (atom.type === 'frac') {
      const want = dir < 0 ? 'num' : 'den';
      if (k !== want) {
        st.path = st.path.slice(0, d).concat([[i, want]]);
        st.index = Math.min(st.index, atom[want].length);
        return true;
      }
    }
    if (atom.type === 'sup' && dir > 0) {
      st.path = st.path.slice(0, d);
      st.index = i + 1;
      return true;
    }
  }
  if (dir < 0) {
    const L = curList(st);
    const prev = L[st.index - 1];
    if (prev && prev.type === 'sup') {
      st.path.push([st.index - 1, 'body']);
      st.index = prev.body.length;
      return true;
    }
  }
  return false;
}

export function moveHome(st) { st.path = []; st.index = 0; }
export function moveEnd(st) { st.path = []; st.index = st.root.length; }

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function insert(st, atoms) {
  const L = curList(st);
  L.splice(st.index, 0, ...atoms);
  st.index += atoms.length;
}

/**
 * Start of the operand ending at `i`: what `/` pulls into the numerator and
 * what `^` raises. Walks back over operand atoms, stops at any operator, and
 * swallows a leading function name (`sin(x)/2` -> numerator is all of sin(x)).
 */
export function operandStart(L, i) {
  let j = i;
  while (j > 0) {
    const a = L[j - 1];
    if (a.type === 'func') { j--; break; }
    if (!OPERAND.has(a.type)) break;
    j--;
  }
  return j;
}

/** `(x)` used as an operand is just `x` - keeps round trips from nesting. */
function unwrap(atoms) {
  if (atoms.length === 1 && atoms[0].type === 'group' && atoms[0].open === '(') {
    return atoms[0].body;
  }
  return atoms;
}

function inSubscript(st) {
  return st.path.length > 0 && st.path[st.path.length - 1][1] === 'sub';
}

/**
 * A letter was just typed. If the run of plain letters ending at the caret has
 * a known function name or constant as its suffix, inflate it: `sqrt` becomes a
 * radical, `sin` becomes an upright name with its parentheses already open,
 * `pi` becomes the constant. Longest match wins, so `arctan` never collapses to
 * `tan`. Disabled inside subscripts, which are labels rather than mathematics.
 */
function inflateWord(st) {
  if (inSubscript(st)) return false;
  const L = curList(st);
  let start = st.index;
  while (start > 0 && L[start - 1].type === 'var' && !L[start - 1].sub) start--;
  const letters = L.slice(start, st.index).map((a) => a.name).join('');
  for (let len = Math.min(letters.length, MAX_WORD); len >= 2; len--) {
    const w = letters.slice(letters.length - len);
    if (!WORDS.includes(w)) continue;
    const from = st.index - len;
    if (w === 'sqrt') {
      L.splice(from, len, A.sqrt([]));
      st.path.push([from, 'body']);
      st.index = 0;
    } else if (FUNCS.includes(w)) {
      L.splice(from, len, A.func(w), A.group('(', []));
      st.path.push([from + 1, 'body']);
      st.index = 0;
    } else {
      L.splice(from, len, A.konst(w));
      st.index = from + 1;
    }
    return true;
  }
  return false;
}

/** `/` - the preceding operand becomes the numerator. */
export function startFraction(st) {
  const L = curList(st);
  const start = operandStart(L, st.index);
  const num = L.splice(start, st.index - start);
  const f = A.frac(num, []);
  L.splice(start, 0, f);
  st.path.push([start, num.length ? 'den' : 'num']);
  st.index = 0;
}

/** `^` - opens an empty superscript riding on whatever precedes the caret. */
export function startSup(st) {
  const L = curList(st);
  const s = A.sup([]);
  L.splice(st.index, 0, s);
  st.path.push([st.index, 'body']);
  st.index = 0;
}

/** `_` - opens (or re-enters) the subscript of the letter before the caret. */
export function startSub(st) {
  const L = curList(st);
  const prev = L[st.index - 1];
  if (!prev || prev.type !== 'var') return false;
  if (!prev.sub) prev.sub = [];
  st.path.push([st.index - 1, 'sub']);
  st.index = prev.sub.length;
  return true;
}

function startGroup(st, open) {
  const L = curList(st);
  const g = A.group(open, []);
  L.splice(st.index, 0, g);
  st.path.push([st.index, 'body']);
  st.index = 0;
}

/**
 * `)` - jump past the innermost enclosing group rather than inserting junk.
 * A radical also answers to `)`: it has no visible closer, so `sqrt2)` has to
 * mean "and I am done with the radicand".
 */
function closeGroup(st, close) {
  for (let d = st.path.length - 1; d >= 0; d--) {
    const [i, k] = st.path[d];
    const outer = listAt(st.root, st.path.slice(0, d));
    const atom = outer && outer[i];
    if (!atom || k !== 'body') continue;
    const isGroup = atom.type === 'group' && atom.close === close;
    if (isGroup || atom.type === 'sqrt') {
      st.path = st.path.slice(0, d);
      st.index = i + 1;
      return true;
    }
  }
  return false;
}

/** Insert one typed character. Returns true when the model changed. */
function inTail(st) {
  if (st.path.length) return false;
  const t = tailStart(st.root);
  return t !== -1 && st.index > t;
}

export function typeChar(st, ch) {
  st.pristine = null;
  if (ch === '\n' || ch === '\t') return false;
  // Inside the comment tail every character is taken verbatim - spaces,
  // punctuation, further `#`s and all. Plain text editing, nothing else.
  if (inTail(st)) { insert(st, [A.text(ch)]); return true; }
  // `#` opens a comment, but only at the end of a row: on an empty row that
  // makes the whole row a comment, after mathematics it opens a trailing one,
  // exactly as the document format reads it. It never converts content that is
  // already there, and it keeps the tail a suffix of the row.
  if (ch === '#' && !st.path.length && st.index === st.root.length) {
    insert(st, [A.text('#')]);
    return true;
  }
  if (/\s/.test(ch)) return false;                    // spaces carry no meaning
  if (/[0-9.]/.test(ch)) { insert(st, [A.digit(ch)]); return true; }
  if (/[A-Za-z]/.test(ch)) {
    insert(st, [A.var(ch)]);
    inflateWord(st);
    return true;
  }
  switch (ch) {
    case '/': startFraction(st); return true;
    case '^': startSup(st); return true;
    case '_': return startSub(st);
    case '(':
    case '[': startGroup(st, ch); return true;
    case ')':
    case ']': return closeGroup(st, ch);
    case "'": insert(st, [A.prime()]); return true;
    case '+': case '-': case '*': case '=': case ',':
      insert(st, [A.op(ch)]); return true;
    default:
      return false;
  }
}

export function typeString(st, text) {
  let changed = false;
  for (const ch of String(text)) changed = typeChar(st, ch) || changed;
  return changed;
}

/**
 * Backspace.
 *   - before a leaf: delete it.
 *   - before a structure: step inside it (or delete it outright if it is empty).
 *   - at the left edge of a slot: move to the end of the previous slot, or, for
 *     the first slot, COLLAPSE the structure - its contents are spliced into the
 *     surrounding list. Never deletes an invisible character.
 */
/**
 * The `#` at `at` is going away, so the row stops being a comment: whatever
 * followed it is re-read as mathematics. `# k = 2` backspaces into `k = 2`;
 * `## note` backspaces into `# note`, which is a comment once more.
 */
function dissolveTail(st, at) {
  const rest = st.root.slice(at + 1).map((a) => a.ch).join('');
  const reparsed = parseSource(rest, st.funcs);
  st.root.splice(at, st.root.length - at, ...reparsed);
  st.path = [];
  st.index = at;
  return true;
}

export function backspace(st) {
  st.pristine = null;
  const L = curList(st);
  if (!st.path.length && st.index > 0 && L[st.index - 1].type === 'text') {
    if (st.index - 1 === tailStart(st.root)) return dissolveTail(st, st.index - 1);
    L.splice(st.index - 1, 1);
    st.index--;
    return true;
  }
  if (st.index > 0) {
    const a = L[st.index - 1];
    const ks = slotKeys(a);
    if (ks.length) {
      if (ks.every((k) => a[k].length === 0)) {
        if (a.type === 'var') { a.sub = null; return true; }
        L.splice(st.index - 1, 1);
        st.index--;
      } else {
        enterLast(st, st.index - 1, a);
      }
      return true;
    }
    L.splice(st.index - 1, 1);
    st.index--;
    return true;
  }

  const p = parentOf(st);
  if (!p) return false;
  const ks = slotKeys(p.atom);
  const ki = ks.indexOf(p.key);
  if (ki > 0) {
    const prev = ks[ki - 1];
    st.path[st.path.length - 1] = [p.index, prev];
    st.index = p.atom[prev].length;
    return true;
  }

  // Left edge of the first slot: collapse the structure.
  if (p.atom.type === 'var') {
    // Peel the subscript off the letter instead of eating the letter.
    const sub = p.atom.sub || [];
    p.atom.sub = null;
    st.path.pop();
    p.list.splice(p.index + 1, 0, ...sub);
    st.index = p.index + 1;
    return true;
  }
  const contents = ks.reduce((acc, k) => acc.concat(p.atom[k]), []);
  st.path.pop();
  p.list.splice(p.index, 1, ...contents);
  st.index = p.index;
  return true;
}

/** Forward delete - the mirror of backspace. */
export function deleteForward(st) {
  st.pristine = null;
  const L = curList(st);
  if (!st.path.length && st.index < L.length && L[st.index].type === 'text') {
    if (st.index === tailStart(st.root)) return dissolveTail(st, st.index);
    L.splice(st.index, 1);
    return true;
  }
  if (st.index < L.length) {
    const a = L[st.index];
    const ks = slotKeys(a);
    if (ks.length && !ks.every((k) => a[k].length === 0) && a.type !== 'var') {
      enterFirst(st, st.index, a);
      return true;
    }
    L.splice(st.index, 1);
    return true;
  }
  if (!st.path.length) return false;
  return exitRight(st);
}

// ---------------------------------------------------------------------------
// Serialisation - the contract with the solver
//
//   fraction     ->  (num)/(den)     parenthesised, so precedence survives
//   superscript  ->  ^(body)
//   radical      ->  sqrt(body)
//   subscript    ->  _1 when unambiguous, else _{...}
//
// Setting `source` and reading it back is stable: parseSource(toSource(m))
// serialises to exactly the same text.
// ---------------------------------------------------------------------------

/** A `+`/`-` is unary when nothing, or another operator, precedes it. */
function isUnary(list, i) {
  const prev = list[i - 1];
  if (!prev) return true;
  return prev.type === 'op';
}

function alnumStart(a) {
  return !!a && (a.type === 'digit' || a.type === 'var' || a.type === 'const' || a.type === 'func');
}

/**
 * Would gluing `name` onto the letters already emitted accidentally spell a
 * function name or a constant? Two adjacent variables p and i must not come
 * back as the constant pi. A space is invisible to the lexer and fixes it.
 */
function needsWordGap(out, name) {
  const tail = /[A-Za-z]+$/.exec(out);
  if (!tail) return false;
  const run = tail[0] + name;
  return WORDS.some((w) => w.length > name.length && run.endsWith(w));
}

function subSource(sub, next) {
  if (!sub) return '';
  const inner = toSource(sub, true);
  // Numpla's lexer reads a braceless subscript as a run of alphanumerics, so a
  // bare `_1` is only safe when the next atom cannot extend it.
  if (/^[A-Za-z0-9]+$/.test(inner) && !alnumStart(next)) return '_' + inner;
  return '_{' + inner + '}';
}

export function toSource(list, inSub = false) {
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const next = list[i + 1];
    switch (a.type) {
      case 'digit': out += a.ch; break;
      case 'var':
        if (!inSub && needsWordGap(out, a.name)) out += ' ';
        out += a.name + subSource(a.sub, next);
        break;
      case 'const':
        if (!inSub && needsWordGap(out, a.name)) out += ' ';
        out += a.name;
        break;
      case 'func':
        if (!inSub && needsWordGap(out, a.name)) out += ' ';
        out += a.name;
        if (!(next && next.type === 'group' && next.open === '(')) out += ' ';
        break;
      case 'prime': out += "'"; break;
      case 'op':
        if ((a.ch === '+' || a.ch === '-') && isUnary(list, i)) out += a.ch;
        else if (a.ch === ',') out += ', ';
        else if (a.ch === '*') out += '*';
        else out += ' ' + a.ch + ' ';
        break;
      case 'frac': out += '(' + toSource(a.num) + ')/(' + toSource(a.den) + ')'; break;
      case 'sup': out += '^(' + toSource(a.body) + ')'; break;
      case 'sqrt': out += 'sqrt(' + toSource(a.body) + ')'; break;
      case 'group': out += a.open + toSource(a.body) + a.close; break;
      case 'text':
        // Byte for byte. The only shaping anywhere near a comment is the single
        // space that separates it from mathematics on the same row.
        if (i > 0 && list[i - 1].type !== 'text' && !/\s$/.test(out)) out += ' ';
        out += a.ch;
        break;
      default: break;
    }
  }
  return out;
}

const LATEX_FUNC = new Set([
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'sin', 'cos', 'tan',
  'exp', 'ln', 'log', 'min', 'max', 'sqrt',
]);

/** Minimal standard escaping, so a comment survives into a LaTeX document. */
function latexText(str) {
  // One pass, so the braces this emits are never escaped a second time.
  const NAMED = {
    '\\': '\\textbackslash{}',
    '~': '\\textasciitilde{}',
    '^': '\\textasciicircum{}',
  };
  return str.replace(/[\\{}#$%&_~^]/g, (c) => NAMED[c] || '\\' + c);
}

export function toLatex(list) {
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    // The comment tail is one \text{} run, not a command per character.
    if (a.type === 'text') {
      const run = list.slice(i).map((t) => t.ch).join('');
      if (out && !/\s$/.test(out)) out += ' ';
      out += '\\text{' + latexText(run) + '}';
      break;
    }
    switch (a.type) {
      case 'digit': out += a.ch; break;
      case 'var':
        out += a.name + (a.sub ? '_{' + toLatex(a.sub) + '}' : '');
        break;
      case 'const':
        out += a.name === 'inf' ? '\\infty ' : '\\' + a.name + ' ';
        break;
      case 'func':
        out += LATEX_FUNC.has(a.name)
          ? '\\' + a.name + ' '
          : '\\operatorname{' + a.name + '}';
        break;
      case 'prime': out += "'"; break;
      case 'op': out += a.ch === '*' ? '\\cdot ' : a.ch; break;
      case 'frac': out += '\\frac{' + toLatex(a.num) + '}{' + toLatex(a.den) + '}'; break;
      case 'sup': out += '^{' + toLatex(a.body) + '}'; break;
      case 'sqrt': out += '\\sqrt{' + toLatex(a.body) + '}'; break;
      case 'group':
        out += '\\left' + a.open + toLatex(a.body) + '\\right' + a.close;
        break;
      default: break;
    }
  }
  return out;
}

// --- text -> atoms ---------------------------------------------------------

function longestWord(rest, table) {
  let best = null;
  for (const w of table) {
    if (rest.startsWith(w) && (!best || w.length > best.length)) best = w;
  }
  return best;
}

/**
 * Parse plain solver source into atoms. `/` and `^` rebuild real structures
 * (with `(x)` unwrapped back to `x`), which is what makes the round trip stable
 * and what lets a document loaded from disk render as proper notation.
 */
export function parseSource(text, funcs = null) {
  const userFuncs = funcs instanceof Set ? funcs : normaliseFunctions(funcs);
  const raw = String(text == null ? '' : text);
  // Split where numpla-model splits: at the first `#`. What it discards, the
  // field keeps - unparsed, unshaped, exactly as typed.
  const hash = raw.indexOf('#');
  const s = hash === -1 ? raw : raw.slice(0, hash);
  const tail = hash === -1 ? [] : textAtoms(raw.slice(hash));
  let i = 0;

  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const isDigitStart = (j) => /[0-9]/.test(s[j] || '')
    || (s[j] === '.' && /[0-9]/.test(s[j + 1] || ''));

  function readNumber(out) {
    while (i < s.length && /[0-9.]/.test(s[i])) out.push(A.digit(s[i++]));
  }

  function readSubChars(stop) {
    const out = [];
    while (i < s.length && s[i] !== stop) {
      const c = s[i++];
      if (/[0-9.]/.test(c)) out.push(A.digit(c));
      else if (/[A-Za-z]/.test(c)) out.push(A.var(c));
    }
    return out;
  }

  function readWord(out) {
    const rest = s.slice(i);
    const f = longestWord(rest, FUNCS);
    if (f) {
      i += f.length;
      if (f === 'sqrt') {
        ws();
        if (s[i] === '(') {
          i++;
          const body = parseList(')');
          if (s[i] === ')') i++;
          out.push(A.sqrt(body));
        } else {
          out.push(A.sqrt(unwrap(parseOperand(''))));
        }
      } else {
        out.push(A.func(f));
      }
      return;
    }
    const k = longestWord(rest, CONSTS);
    if (k) { i += k.length; out.push(A.konst(k)); return; }

    const name = s[i++];
    let sub = null;
    if (s[i] === '_') {
      i++;
      if (s[i] === '{') {
        i++;
        sub = readSubChars('}');
        if (s[i] === '}') i++;
      } else {
        sub = [];
        while (i < s.length && /[A-Za-z0-9]/.test(s[i])) {
          const c = s[i++];
          sub.push(/[0-9]/.test(c) ? A.digit(c) : A.var(c));
        }
      }
    }
    out.push(A.var(name, sub));
  }

  function readGroup(out) {
    const open = s[i++];
    const close = open === '(' ? ')' : ']';
    const body = parseList(close);
    if (s[i] === close) i++;
    out.push(A.group(open, body));
  }

  /**
   * Is `name(` a call, and therefore part of this one primary? Builtins always
   * are; a plain name only when the document defines it as a function. A primed
   * name always is - `x'(0)` is the initial condition for a lowered velocity
   * state, which the Rust parser special-cases for the same reason.
   */
  function isCall(atom, primes) {
    if (!atom) return false;
    if (atom.type === 'func') return true;
    if (atom.type !== 'var') return false;
    if (primes > 0) return true;
    return userFuncs.has(varKey(atom));
  }

  /**
   * One primary, plus any leading sign, trailing primes and superscript. This
   * is what `/` takes as its denominator and `^` as its exponent, so getting
   * the extent of a primary right is what keeps `-m x / d(x, y)` meaning what
   * it says.
   */
  function parseOperand(stops) {
    const out = [];
    ws();
    if (s[i] === '-' || s[i] === '+') { out.push(A.op(s[i])); i++; ws(); }
    const c = s[i];
    if (c === undefined || stops.includes(c)) return out;
    if (isDigitStart(i)) readNumber(out);
    else if (/[A-Za-z]/.test(c)) {
      readWord(out);
      const head = out[out.length - 1];
      let primes = 0;
      while (s[i] === "'") { out.push(A.prime()); i++; primes++; }
      if (s[i] === '(' && isCall(head, primes)) {
        readGroup(out);                    // f(u) is a single primary
      } else if (head && head.type === 'func') {
        // A bare function name applies to what follows: `1/sin x` is 1/sin(x).
        for (const a of parseOperand(stops)) out.push(a);
      }
    } else if (c === '(' || c === '[') readGroup(out);
    else return out;
    while (s[i] === "'") { out.push(A.prime()); i++; }
    if (s[i] === '^') { i++; out.push(A.sup(unwrap(parseOperand(stops)))); }
    return out;
  }

  function parseList(stops) {
    const out = [];
    while (i < s.length) {
      const c = s[i];
      if (stops.includes(c)) break;
      if (/\s/.test(c)) { i++; continue; }
      if (isDigitStart(i)) { readNumber(out); continue; }
      if (/[A-Za-z]/.test(c)) { readWord(out); continue; }
      if (c === '(' || c === '[') { readGroup(out); continue; }
      if (c === ')' || c === ']') { i++; continue; }   // stray closer: drop it
      if (c === "'") { i++; out.push(A.prime()); continue; }
      if (c === '/') {
        i++;
        const start = operandStart(out, out.length);
        const num = unwrap(out.splice(start, out.length - start));
        const den = unwrap(parseOperand(stops));
        out.push(A.frac(num, den));
        continue;
      }
      if (c === '^') { i++; out.push(A.sup(unwrap(parseOperand(stops)))); continue; }
      if ('+-*=,'.includes(c)) { i++; out.push(A.op(c)); continue; }
      i++;                                            // unknown character: drop
    }
    return out;
  }

  return parseList('').concat(tail);
}

// ---------------------------------------------------------------------------
// MathModel - the headless half of a field
// ---------------------------------------------------------------------------

export class MathModel {
  constructor(src = '', funcs = null) {
    this.st = newState([], funcs);
    this.st.root = parseSource(src, this.st.funcs);
    this.st.pristine = String(src == null ? '' : src);
    moveEnd(this.st);
  }

  get root() { return this.st.root; }
  get source() { return toSource(this.st.root); }
  set source(text) {
    this.st.root = parseSource(text, this.st.funcs);
    this.st.pristine = String(text == null ? '' : text);
    this.st.path = [];
    this.st.index = this.st.root.length;
  }

  /** The document's function names, as last given. Builtins are not listed. */
  get functions() { return Array.from(this.st.funcs); }

  /**
   * Tell the row which names the document defines as functions. Re-reads the
   * row when the answer changes how it parses; returns true if it did.
   */
  setFunctions(names) {
    const next = normaliseFunctions(names);
    if (setsEqual(next, this.st.funcs)) return false;
    this.st.funcs = next;
    // An untouched row re-reads what it was handed; an edited one re-reads what
    // it now says, which is what the parser sees too.
    const text = this.st.pristine == null ? toSource(this.st.root) : this.st.pristine;
    const root = parseSource(text, next);
    if (JSON.stringify(root) === JSON.stringify(this.st.root)) return false;
    this.st.root = root;
    this.st.path = [];
    this.st.index = root.length;
    return true;
  }

  get latex() { return toLatex(this.st.root); }
  isEmpty() { return this.st.root.length === 0; }

  /** True when this row is a comment rather than mathematics. */
  isComment() { return isCommentRow(this.st.root); }

  type(text) { return typeString(this.st, text); }
  backspace() { return backspace(this.st); }
  del() { return deleteForward(this.st); }
  left() { return moveLeft(this.st); }
  right() { return moveRight(this.st); }
  up() { return moveVert(this.st, -1); }
  down() { return moveVert(this.st, 1); }
  home() { moveHome(this.st); }
  end() { moveEnd(this.st); }
}

// ===========================================================================
// Rendering + the DOM field
//
// Everything below touches the DOM, and only ever from a method call - never at
// import time, so `import { MathModel } from './mathfield.js'` works in Node.
// ===========================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function svgShape(cls, viewBox, d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(path);
  return svg;
}

// A radical sign that stretches with its radicand: the hook and the diagonal
// scale vertically while the stroke stays a constant width.
const RADICAL_D = 'M0.8 14 L3.6 12.4 L6.4 23.2 L11.2 1';
const PAREN_D = 'M7.6 1 C3.4 8, 3.4 22, 7.6 29';
const BRACKET_D = 'M7.6 1 L3.4 1 L3.4 29 L7.6 29';

const DISPLAY_OP = { '-': '−', '*': '·' };
const DISPLAY_CONST = { pi: 'π', tau: 'τ', inf: '∞' };

function renderList(list, path, ctx) {
  const box = el('span', 'mf-list' + (list.length ? '' : ' mf-list--empty'));
  for (let k = 0; k <= list.length; k++) {
    box.appendChild(renderPos(path, k, ctx));
    if (k < list.length) box.appendChild(renderAtom(list, k, path, ctx));
  }
  return box;
}

function renderPos(path, index, ctx) {
  const p = el('i', 'mf-pos');
  p._mfPath = path;
  p._mfIndex = index;
  if (ctx.caretVisible && index === ctx.index && samePath(path, ctx.path)) {
    p.classList.add('mf-pos--caret');
  }
  ctx.positions.push(p);
  return p;
}

function slot(list, path, at, key, ctx, cls) {
  const s = renderList(list, path.concat([[at, key]]), ctx);
  s.classList.add(cls);
  return s;
}

function renderAtom(list, at, path, ctx) {
  const a = list[at];
  switch (a.type) {
    case 'digit': {
      const e = el('span', 'mf-digit');
      e.textContent = a.ch;
      return e;
    }
    case 'var': {
      const box = el('span', 'mf-varbox');
      const v = el('span', 'mf-var');
      v.textContent = a.name;
      box.appendChild(v);
      if (a.sub) box.appendChild(slot(a.sub, path, at, 'sub', ctx, 'mf-sub'));
      return box;
    }
    case 'const': {
      const e = el('span', 'mf-const');
      e.textContent = DISPLAY_CONST[a.name] || a.name;
      return e;
    }
    case 'func': {
      const e = el('span', 'mf-func');
      e.textContent = a.name;
      const next = list[at + 1];
      if (!(next && next.type === 'group')) e.classList.add('mf-func--bare');
      return e;
    }
    case 'op': {
      const e = el('span', 'mf-op');
      e.textContent = DISPLAY_OP[a.ch] || a.ch;
      if ((a.ch === '+' || a.ch === '-') && isUnary(list, at)) {
        e.classList.add('mf-op--unary');
      }
      if (a.ch === '=') e.classList.add('mf-op--rel');
      if (a.ch === ',') e.classList.add('mf-op--comma');
      return e;
    }
    case 'prime': {
      const e = el('span', 'mf-prime');
      e.textContent = '′';
      return e;
    }
    case 'frac': {
      const e = el('span', 'mf-frac');
      e.appendChild(slot(a.num, path, at, 'num', ctx, 'mf-num'));
      e.appendChild(slot(a.den, path, at, 'den', ctx, 'mf-den'));
      return e;
    }
    case 'sup': {
      const e = el('span', 'mf-sup');
      e.appendChild(slot(a.body, path, at, 'body', ctx, 'mf-sup-body'));
      return e;
    }
    case 'sqrt': {
      const e = el('span', 'mf-sqrt');
      e.appendChild(svgShape('mf-radical', '0 0 12 24', RADICAL_D));
      e.appendChild(slot(a.body, path, at, 'body', ctx, 'mf-sqrt-body'));
      return e;
    }
    case 'group': {
      const e = el('span', 'mf-group');
      const d = a.open === '[' ? BRACKET_D : PAREN_D;
      const open = svgShape('mf-delim mf-delim--open', '0 0 10 30', d);
      const close = svgShape('mf-delim mf-delim--close', '0 0 10 30', d);
      e.appendChild(open);
      e.appendChild(slot(a.body, path, at, 'body', ctx, 'mf-group-body'));
      e.appendChild(close);
      return e;
    }
    case 'text': {
      // Prose, not notation: upright, muted, one span per character so that
      // every character keeps its own caret position, and `white-space: pre`
      // so the spaces the author typed are the spaces on screen.
      const e = el('span', 'mf-text');
      if (at === tailStart(list)) e.classList.add('mf-text--hash');
      e.textContent = a.ch;
      return e;
    }
    default: {
      const e = el('span', 'mf-unknown');
      e.textContent = '?';
      return e;
    }
  }
}

/**
 * An editable math field.
 *
 * @param host  element to mount into (the field replaces its contents)
 * @param opts.functions  names the document defines as functions, so that
 *                        `d(x, y)` reads as a call - see setFunctions()
 * @param opts  { value?: string, onChange?: (field) => void,
 *                onFocus?: (field) => void, onBlur?: (field) => void,
 *                onEnter?: (field) => void, onNavigate?: (field, dir) => void }
 */
export class MathField {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.model = new MathModel(opts.value || '', opts.functions);
    this.focused = false;
    this.diagnostic = null;
    this.diagnosticMessage = '';
    this._positions = [];

    host.innerHTML = '';
    const root = el('div', 'mf');
    root.tabIndex = 0;
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-label', opts.ariaLabel || 'math expression');
    root.spellcheck = false;
    this.el = root;

    this.body = el('span', 'mf-body');
    root.appendChild(this.body);
    host.appendChild(root);

    this._onKeyDown = (e) => this._keydown(e);
    this._onPointerDown = (e) => this._pointerdown(e);
    this._onFocus = () => { this.focused = true; root.classList.add('is-focused'); this.render(); if (opts.onFocus) opts.onFocus(this); };
    this._onBlur = () => { this.focused = false; root.classList.remove('is-focused'); this.render(); if (opts.onBlur) opts.onBlur(this); };
    this._onPaste = (e) => this._paste(e);

    root.addEventListener('keydown', this._onKeyDown);
    root.addEventListener('mousedown', this._onPointerDown);
    root.addEventListener('focus', this._onFocus);
    root.addEventListener('blur', this._onBlur);
    root.addEventListener('paste', this._onPaste);

    this.render();
  }

  // --- public API ---------------------------------------------------------

  get source() { return this.model.source; }

  // Setting `source` deliberately does NOT fire onChange: the shell owns that
  // write, and echoing it back would loop straight through its re-solve.
  set source(text) { this.model.source = text; this.render(); }
  get latex() { return this.model.latex; }

  /** The document's function names, as last given. */
  get functions() { return this.model.functions; }

  /**
   * Tell the field which names the document defines as functions, so that
   * `d(x, y)` is read as a call rather than as `d` times `(x, y)`. Returns true
   * when the row had to be re-read, which moves the caret to the end and can
   * change `source`; like the `source` setter it does not fire onChange, since
   * the shell is the one making the change.
   */
  setFunctions(names) {
    const changed = this.model.setFunctions(names);
    if (changed) this.render();
    return changed;
  }

  focus() { this.el.focus(); }
  blur() { this.el.blur(); }
  isEmpty() { return this.model.isEmpty(); }

  /** True when this row is a comment rather than mathematics. */
  isComment() { return this.model.isComment(); }

  setDiagnostic(severity, message) {
    this.diagnostic = severity || null;
    this.diagnosticMessage = message || '';
    this.el.classList.toggle('is-error', severity === 'error');
    this.el.classList.toggle('is-pending', severity === 'pending');
    if (message) this.el.setAttribute('title', message);
    else this.el.removeAttribute('title');
  }

  destroy() {
    this.el.removeEventListener('keydown', this._onKeyDown);
    this.el.removeEventListener('mousedown', this._onPointerDown);
    this.el.removeEventListener('focus', this._onFocus);
    this.el.removeEventListener('blur', this._onBlur);
    this.el.removeEventListener('paste', this._onPaste);
    this.host.innerHTML = '';
    this.el = null;
    this.body = null;
    this._positions = [];
  }

  // --- rendering ----------------------------------------------------------

  render() {
    const st = this.model.st;
    clampCaret(st);
    this._positions = [];
    const ctx = {
      path: st.path,
      index: st.index,
      caretVisible: this.focused,
      positions: this._positions,
    };
    const tree = renderList(st.root, [], ctx);
    this.body.innerHTML = '';
    this.body.appendChild(tree);
    this.el.classList.toggle('is-empty', st.root.length === 0);
    this.el.classList.toggle('is-comment', isCommentRow(st.root));
  }

  _changed() {
    if (this.opts.onChange) this.opts.onChange(this);
  }

  _apply(changed) {
    this.render();
    if (changed) this._changed();
  }

  // --- input --------------------------------------------------------------

  _keydown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const st = this.model.st;
    const nav = (dir) => {
      if (!moveVert(st, dir) && this.opts.onNavigate) this.opts.onNavigate(this, dir < 0 ? 'up' : 'down');
      this.render();
    };

    switch (e.key) {
      case 'ArrowLeft':
        if (!moveLeft(st) && this.opts.onNavigate) this.opts.onNavigate(this, 'left');
        this.render(); e.preventDefault(); return;
      case 'ArrowRight':
        if (!moveRight(st) && this.opts.onNavigate) this.opts.onNavigate(this, 'right');
        this.render(); e.preventDefault(); return;
      case 'ArrowUp': nav(-1); e.preventDefault(); return;
      case 'ArrowDown': nav(1); e.preventDefault(); return;
      case 'Home': moveHome(st); this.render(); e.preventDefault(); return;
      case 'End': moveEnd(st); this.render(); e.preventDefault(); return;
      case 'Backspace': this._apply(backspace(st)); e.preventDefault(); return;
      case 'Delete': this._apply(deleteForward(st)); e.preventDefault(); return;
      case 'Enter':
        if (this.opts.onEnter) this.opts.onEnter(this);
        e.preventDefault(); return;
      case 'Escape': this.blur(); e.preventDefault(); return;
      default: break;
    }

    if (e.key.length === 1) {
      const changed = typeChar(st, e.key);
      this._apply(changed);
      e.preventDefault();
    }
  }

  _paste(e) {
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (!text) return;
    const atoms = parseSource(text.replace(/\r?\n/g, ' '), this.model.st.funcs);
    const st = this.model.st;
    st.pristine = null;
    const L = curList(st);
    L.splice(st.index, 0, ...atoms);
    st.index += atoms.length;
    this._apply(true);
  }

  _pointerdown(e) {
    const hit = this._nearest(e.clientX, e.clientY);
    if (hit) {
      this.model.st.path = hit._mfPath;
      this.model.st.index = hit._mfIndex;
    }
    // Focus first (so the caret is visible), then paint the new position.
    if (!this.focused) this.el.focus();
    this.render();
    e.preventDefault();
  }

  /** Nearest valid caret position to a point. Same-line candidates win. */
  _nearest(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const p of this._positions) {
      const r = p.getBoundingClientRect();
      const dx = Math.abs(x - r.left);
      const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
      const d = dy * 6 + dx;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
}

export default MathField;
