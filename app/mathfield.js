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
  // The noise family is reserved in the lexer for the same reason `sin` is: a
  // multi-letter run is a known function or it is several variables.
  'white', 'pink', 'brown', 'blue', 'smooth', 'telegraph', 'randn', 'rand',
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
    // Names the document defines, for completion only - see setDocumentNames().
    names: normaliseNames(null),
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

/**
 * Step all the way out of whatever structures the caret is in, to the position
 * just after the outermost one. Only `=` uses this - see typeChar().
 */
function exitToRow(st) {
  while (st.path.length) {
    const [at] = st.path[st.path.length - 1];
    st.path.pop();
    st.index = at + 1;
  }
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
 * The name that has just been built, if the caret is still sitting on it:
 * after `pi`, inside the parentheses of `sin(`, or after `rand()`.
 */
function wordStructureAt(st) {
  const L = curList(st);
  const prev = L[st.index - 1];
  if (prev && (prev.type === 'const' || prev.type === 'func')) {
    return { name: prev.name, list: L, path: st.path.slice(), from: st.index - 1, count: 1 };
  }
  if (prev && prev.type === 'group' && prev.body.length === 0) {
    const fn = L[st.index - 2];
    if (fn && fn.type === 'func') {
      return { name: fn.name, list: L, path: st.path.slice(), from: st.index - 2, count: 2 };
    }
  }
  if (st.path.length) {
    const [i, k] = st.path[st.path.length - 1];
    const outer = listAt(st.root, st.path.slice(0, -1));
    const owner = outer && outer[i];
    if (k === 'body' && owner && owner.type === 'group' && owner.body.length === 0) {
      const fn = outer[i - 1];
      if (fn && fn.type === 'func') {
        return { name: fn.name, list: outer, path: st.path.slice(0, -1), from: i - 1, count: 2 };
      }
    }
  }
  return null;
}

/**
 * `sin` is a name, and so is `sinh`; `pi` is a name, and so is `pink`. Since
 * the shorter one inflates the moment it is typed, the longer one would be
 * unreachable from the keyboard. So when the next letter could still be going
 * somewhere longer, the structure dissolves back into its letters and carries
 * on - `sin(` + `h` is `sinh(`, not `sin(h)`.
 */
function growWord(st, ch) {
  const w = wordStructureAt(st);
  if (!w) return false;
  const grown = w.name + ch;
  if (!WORDS.some((x) => x.length > w.name.length && x.startsWith(grown))) return false;
  w.list.splice(w.from, w.count, ...Array.from(w.name).map((c) => A.var(c)));
  st.path = w.path;
  st.index = w.from + w.name.length;
  return true;
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
    if (FUNCS.includes(w)) {
      // The same insertion Tab performs, so a name typed out in full and a name
      // completed land the caret in the same place.
      insertCall(st, w, from, len);
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
    growWord(st, ch);
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
    case ',': {
      // `min(a, b)` arrives with its comma already in place, so typing one at
      // the comma steps over it instead of doubling it - the same type-through
      // rule as `)`.
      const L = curList(st);
      const next = L[st.index];
      if (next && next.type === 'op' && next.ch === ',') { st.index += 1; return true; }
      insert(st, [A.op(ch)]);
      return true;
    }
    case '=':
      // A row is `left = right`, and it has exactly one level: `=` is never
      // meaningful inside a numerator, an exponent or a radicand. So typing one
      // steps out of whatever structure the caret is in and lands it at row
      // level, which is the only place the language accepts it. Without this,
      // `dx/dt = -y` typed straight through puts the `=` in the denominator -
      // and so do `x/2 = 3` and `x^2 = 3`. It is the same rule the parser
      // already applies when it reads a row back.
      exitToRow(st);
      insert(st, [A.op(ch)]);
      return true;
    case '+': case '-': case '*':
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

// ---------------------------------------------------------------------------
// Leibniz notation
//
// `dx/dt = -y` is the same row as `x' = -y`, and `d2x/dt2` (or `d^2x/dt^2`) the
// same as `x''`; the denominator additionally names the document's independent
// variable, which is what makes `df/dx = 2x` an integral along `x`. See
// docs/wasm-api.md, "Leibniz notation, and the independent variable".
//
// The engine recognises it only when it spans the *whole* left-hand side of an
// `=`, so that `d = 0.25` stays a parameter and `y' = -c y + d x y` keeps `d`
// as a coefficient. The field mirrors that rule exactly, in one regex used by
// both halves of the round trip: the parser recognises a Leibniz left-hand side
// only where the serialiser will emit one, which is what keeps the two stable
// against each other.
//
// It is still a fraction. It parses to a `frac` atom, renders stacked with a
// rule between the two halves - which is how the notation is written, and the
// reason not to invent a new atom type for it - and only its *source* differs:
// `dx/dt`, not `(dx)/(dt)`, because that is the spelling the engine accepts.
// ---------------------------------------------------------------------------

/** A state's name: one letter, optionally subscripted. `dxy/dt` is not one. */
const LEIB_NAME = String.raw`[A-Za-z](?:_[A-Za-z0-9]+|_\{[A-Za-z0-9]*\})?`;
/** The order of the derivative, in either spelling: `d2x/dt2`, `d^2x/dt^2`. */
const LEIB_ORDER = String.raw`(?:\^\s*\d+|\d+)`;

/**
 * A whole Leibniz left-hand side. Whitespace is irrelevant (`d x / d t` is the
 * same row), and the two orders are matched independently: `d2x/dt` is a
 * derivative the engine reports as mismatched, not arithmetic, so the field
 * keeps it as written rather than rewriting it into something else.
 */
const LEIBNIZ_LHS = new RegExp(String.raw
  `^\s*d\s*${LEIB_ORDER}?\s*${LEIB_NAME}\s*/\s*d\s*${LEIB_NAME}\s*${LEIB_ORDER}?\s*$`);

function subSource(sub, next) {
  if (!sub) return '';
  const inner = toSource(sub, true, false);
  // Numpla's lexer reads a braceless subscript as a run of alphanumerics, so a
  // bare `_1` is only safe when the next atom cannot extend it.
  if (/^[A-Za-z0-9]+$/.test(inner) && !alnumStart(next)) return '_' + inner;
  return '_{' + inner + '}';
}

/**
 * One half of a Leibniz derivative as source text, or null when this list holds
 * something a derivative cannot. Only names, digits and a bare `^n` appear in
 * `d2x` or `dt^2`, and the order has to be written `^2` rather than `^(2)`:
 * the engine reads the first and rejects the second.
 */
function leibnizHalf(list) {
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.type === 'var') { out += a.name + subSource(a.sub, list[i + 1]); continue; }
    if (a.type === 'digit' && a.ch !== '.') { out += a.ch; continue; }
    if (a.type === 'sup' && a.body.length
      && a.body.every((b) => b.type === 'digit' && b.ch !== '.')) {
      out += '^' + a.body.map((b) => b.ch).join('');
      continue;
    }
    return null;
  }
  return out;
}

/**
 * `dx/dt` when this fraction is a Leibniz derivative, null when it is an
 * ordinary quotient. Whatever comes back is text the parser reads straight back
 * into the same fraction - LEIBNIZ_LHS decides both.
 */
function leibnizSource(frac) {
  const num = leibnizHalf(frac.num);
  if (num == null) return null;
  const den = leibnizHalf(frac.den);
  if (den == null) return null;
  const text = num + '/' + den;
  return LEIBNIZ_LHS.test(text) ? text : null;
}

/**
 * @param top true while serialising a whole row, which is the only place a
 *   Leibniz derivative is one - see LEIBNIZ_LHS.
 */
export function toSource(list, inSub = false, top = true) {
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
      case 'frac': {
        // A fraction that is the whole left-hand side of an `=` and reads as a
        // derivative is written the way the engine reads it: `dx/dt = -y`,
        // never `(dx)/(dt) = -y`, which it rejects.
        const leib = top && i === 0 && next && next.type === 'op' && next.ch === '='
          ? leibnizSource(a) : null;
        out += leib != null ? leib
          : '(' + toSource(a.num, false, false) + ')/(' + toSource(a.den, false, false) + ')';
        break;
      }
      case 'sup': out += '^(' + toSource(a.body, false, false) + ')'; break;
      case 'sqrt': out += 'sqrt(' + toSource(a.body, false, false) + ')'; break;
      case 'group': out += a.open + toSource(a.body, false, false) + a.close; break;
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
/**
 * A Leibniz derivative filling the whole left-hand side of an `=`, or null.
 * The two halves are read by the ordinary parser, so `d2x` is the atoms `d`,
 * `2`, `x` and `d^2x` carries a real superscript - a fraction of plain
 * notation, which is exactly what it is.
 *
 * @returns { frac, at } where `at` is the index of the `=` to carry on from.
 */
function leibnizLead(s, funcs) {
  const eq = s.indexOf('=');
  if (eq === -1) return null;
  const lhs = s.slice(0, eq);
  if (!LEIBNIZ_LHS.test(lhs)) return null;
  const slash = lhs.indexOf('/');
  return {
    frac: A.frac(parseSource(lhs.slice(0, slash), funcs),
      parseSource(lhs.slice(slash + 1), funcs)),
    at: eq,
  };
}

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

  // A Leibniz left-hand side is taken whole, before the general parse gets to
  // the `/` and builds an arithmetic quotient out of it. Everything from the
  // `=` onwards is ordinary mathematics and is read as such.
  const lead = leibnizLead(s, userFuncs);
  if (lead) i = lead.at;
  const body = parseList('');
  return (lead ? [lead.frac].concat(body) : body).concat(tail);
}

// ---------------------------------------------------------------------------
// Completion
//
// Type a prefix, press Tab, get the completion - the shell habit, in a math
// field. Everything here is a pure function of the model, so the whole feature
// is testable without a DOM; the field only draws the menu and forwards keys.
//
// What completes:
//   - every builtin the engine has (FUNCS/CONSTS above, taken from the lexer),
//     inserted as real structure: `sq` becomes a radical, not four letters
//   - the names the document itself defines - functions, parameters, states -
//     which the shell feeds in through setDocumentNames()
//   - row kinds, offered when the row is just an identifier: `x` then Tab
//     offers `x' =`, `x'' =`, `x(0) =`, `x(u) =`
//   - `comment`, which turns the row into a `#` comment
//
// Nothing completes to something the engine does not have. There is no `diff`:
// symbolic differentiation is a later milestone, and offering it would only
// produce a row that cannot parse.
// ---------------------------------------------------------------------------

/** Argument counts, mirroring `arity()` in crates/numpla-expr/src/eval.rs. */
const ARITY = {
  min: [2, 2], max: [2, 2], mod: [2, 2],
  log: [1, 2],
  rand: [0, 1], randn: [0, 1],
  white: [1, 3], pink: [1, 3], brown: [1, 3],
  blue: [1, 3], smooth: [1, 3], telegraph: [1, 3],
};

export function arityOf(name) {
  return ARITY[name] || [1, 1];
}

/** What the menu shows: the call as it will be inserted. */
export function signatureOf(name) {
  const [least, most] = arityOf(name);
  if (least === 0) return name + '()';
  if (least === 2) return name + '(a, b)';
  if (most === 3) return name + '(t)';
  return name + '(x)';
}

const NOTES = {
  sqrt: 'square root', exp: 'e to the x', ln: 'natural log',
  log: 'base 10 - log(x, b) for another base', abs: 'absolute value',
  min: 'smaller of two', max: 'larger of two', mod: 'remainder',
  floor: 'round down', ceil: 'round up', round: 'nearest', sign: '-1, 0 or 1',
  sin: 'sine', cos: 'cosine', tan: 'tangent',
  arcsin: 'inverse sine', arccos: 'inverse cosine', arctan: 'inverse tangent',
  sinh: 'hyperbolic sine', cosh: 'hyperbolic cosine', tanh: 'hyperbolic tangent',
  white: 'flat-spectrum noise - (t, rate, seed)',
  pink: '1/f noise - (t, rate, seed)',
  brown: '1/f^2 noise, wandering - (t, rate, seed)',
  blue: 'f noise, thin and hissy - (t, rate, seed)',
  smooth: 'band-limited noise, safest to integrate - (t, rate, seed)',
  telegraph: 'switches between +1 and -1 - (t, rate, seed)',
  rand: 'uniform on [0, 1), a pure function of its seed',
  randn: 'standard normal, a pure function of its seed',
  pi: '3.14159...', tau: '2 pi', inf: 'infinity',
};

/**
 * Insert a call to `name`, replacing `len` atoms ending at `from + len`.
 * The caret lands where the first argument goes - inside the radical for
 * `sqrt`, before the comma for the two-argument builtins - except for the
 * builtins whose argument is optional, where it lands after the call, because
 * `rand()` is the form people actually want.
 */
function insertCall(st, name, from, len) {
  const L = curList(st);
  if (name === 'sqrt') {
    L.splice(from, len, A.sqrt([]));
    st.path.push([from, 'body']);
    st.index = 0;
    return;
  }
  const [least] = arityOf(name);
  const body = least >= 2 ? [A.op(',')] : [];
  L.splice(from, len, A.func(name), A.group('(', body));
  if (least === 0) {
    st.index = from + 2;
    return;
  }
  st.path.push([from + 1, 'body']);
  st.index = 0;
}

/** Insert a plain name (a constant, parameter or state) over the prefix. */
function insertName(st, name, from, len) {
  const L = curList(st);
  const atoms = parseSource(name, st.funcs);
  L.splice(from, len, ...atoms);
  st.index = from + atoms.length;
}

/**
 * The names a document defines, for completion. Same shape as setFunctions():
 * `{ functions, params, states }`, each a list of names.
 */
export function normaliseNames(names) {
  const src = names || {};
  const pick = (v) => Array.from(normaliseFunctions(v));
  return {
    functions: pick(src.functions),
    params: pick(src.params),
    states: pick(src.states),
  };
}

/**
 * The variable names a document has in play, deduped and in a useful order:
 * states first - they are what the rows are about - then parameters. Functions
 * are deliberately absent; a keyboard offers those as calls, not as letters.
 * Takes the same `{ functions, params, states }` a field is given.
 */
export function variableNamesIn(names) {
  const n = normaliseNames(names);
  const out = [];
  for (const name of n.states.concat(n.params)) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The run of plain letters ending at the caret - the prefix Tab completes. */
function prefixAt(st) {
  const L = curList(st);
  let start = st.index;
  while (start > 0 && L[start - 1].type === 'var' && !L[start - 1].sub) start--;
  return { start, text: L.slice(start, st.index).map((a) => a.name).join('') };
}

/**
 * Is this row just an identifier, with the caret after it? That is the moment
 * row kinds are worth offering, and the only moment they are not noise.
 */
function rowIdentity(st) {
  if (st.path.length) return null;
  const R = st.root;
  if (!R.length || R[0].type !== 'var') return null;
  let primes = 0;
  for (let i = 1; i < R.length; i++) {
    if (R[i].type !== 'prime') return null;
    primes += 1;
  }
  if (st.index !== R.length) return null;
  return { name: toSource([R[0]]), primes };
}

function rowKinds(row) {
  const base = row.name + "'".repeat(row.primes);
  const out = [];
  const add = (label, hint, build, caret) => out.push({
    word: null,
    kind: 'row',
    label,
    hint,
    apply: (st) => {
      const at = st.root.length;
      const atoms = build();
      st.root.push(...atoms);
      st.path = [];
      if (caret === 'group') {
        const i = atoms.findIndex((a) => a.type === 'group');
        st.path = [[at + i, 'body']];
        st.index = 0;
      } else {
        st.index = st.root.length;
      }
    },
  });

  if (row.primes === 0) {
    add(base + "' =", 'first-order ODE row',
      () => [A.prime(), A.op('=')], 'end');
    add(base + "'' =", 'second-order ODE row',
      () => [A.prime(), A.prime(), A.op('=')], 'end');
    add(base + '(0) =', 'initial condition',
      () => [A.group('(', [A.digit('0')]), A.op('=')], 'end');
    add(base + '(u) =', 'function definition',
      () => [A.group('(', []), A.op('=')], 'group');
  } else {
    add(base + ' =', 'ODE row', () => [A.op('=')], 'end');
    add(base + '(0) =', 'initial condition',
      () => [A.group('(', [A.digit('0')]), A.op('=')], 'end');
  }
  return out;
}

/**
 * Everything Tab could do at the caret, in menu order: builtins, then the
 * document's own names, then constants, then row kinds.
 *
 * A function name matches even when the prefix is the whole name, because the
 * completion still adds its parentheses; a plain name has to be strictly longer
 * than the prefix, or completing it would do nothing at all.
 */
export function completionsFor(st) {
  // A subscript is a label, not mathematics - the same reason function names do
  // not inflate there. Nothing to complete.
  if (inSubscript(st)) return { prefix: '', start: st.index, candidates: [] };
  const { start, text: prefix } = prefixAt(st);
  const names = st.names || normaliseNames(null);
  const out = [];
  const seen = new Set();

  const addCall = (name, kind) => {
    if (seen.has(name) || !name.startsWith(prefix)) return;
    seen.add(name);
    out.push({
      word: name,
      kind,
      label: signatureOf(name),
      hint: NOTES[name] || (kind === 'function' ? 'defined in this document' : ''),
      apply: (s) => insertCall(s, name, start, prefix.length),
    });
  };

  const addName = (name, kind, hint) => {
    if (seen.has(name) || name.length <= prefix.length) return;
    if (!name.startsWith(prefix)) return;
    seen.add(name);
    out.push({
      word: name,
      kind,
      label: name,
      hint: NOTES[name] || hint || '',
      apply: (s) => insertName(s, name, start, prefix.length),
    });
  };

  if (prefix) {
    for (const n of FUNCS) addCall(n, 'builtin');
    for (const n of names.functions) addCall(n, 'function');
    for (const n of CONSTS) addName(n, 'constant');
    for (const n of names.params) addName(n, 'parameter', 'parameter in this document');
    for (const n of names.states) addName(n, 'state', 'state in this document');

    // `com` -> a comment row. Only when the prefix is the whole row: turning
    // something half-written into prose would throw the mathematics away.
    if (prefix.length >= 2 && 'comment'.startsWith(prefix)
        && !st.path.length && start === 0 && st.index === st.root.length) {
      out.push({
        word: null,
        kind: 'row',
        label: '# comment',
        hint: 'a comment row, kept verbatim',
        apply: (s) => {
          s.root.splice(0, s.root.length, A.text('#'), A.text(' '));
          s.path = [];
          s.index = 2;
        },
      });
    }
  }

  // Shortest first, then alphabetical: `sin` before `sign` before `sinh`, and
  // the name someone is most likely to have meant at the top.
  out.sort((a, b) => {
    if (!a.word || !b.word) return (a.word ? 0 : 1) - (b.word ? 0 : 1);
    return (a.word.length - b.word.length) || (a.word < b.word ? -1 : 1);
  });

  const row = rowIdentity(st);
  if (row) out.push(...rowKinds(row));

  return { prefix, start, candidates: out };
}

/** The longest prefix every one of these words starts with. */
export function commonPrefix(words) {
  if (!words.length) return '';
  let p = words[0];
  for (const w of words) {
    let i = 0;
    while (i < p.length && i < w.length && p[i] === w[i]) i += 1;
    p = p.slice(0, i);
  }
  return p;
}

function extendPrefix(st, extra) {
  const L = curList(st);
  const atoms = Array.from(extra).map((c) => A.var(c));
  L.splice(st.index, 0, ...atoms);
  st.index += atoms.length;
}

/**
 * Tab.
 *
 * One match completes. Several match the way a shell does: fill in as much as
 * every candidate agrees on, and only when that adds nothing, show the menu.
 * That is the behaviour the request asked for by name ("like diff then tab"),
 * it never picks for the user, and it means the common case - `ar` for the
 * three arc functions - needs no menu at all.
 *
 * The one exception: when the shared prefix is *itself* a name (`sin` shared by
 * sin and sinh), filling it in would look like the completion had finished, so
 * the menu opens instead.
 *
 * Returns { action: 'none' | 'applied' | 'extended' | 'menu', candidates }.
 * 'none' means Tab did nothing and the caller must let the key through - a Tab
 * that completes nothing belongs to whatever moves focus.
 */
export function tabComplete(st) {
  const { prefix, candidates } = completionsFor(st);
  if (!candidates.length) return { action: 'none', candidates: [] };

  st.pristine = null;
  if (candidates.length === 1) {
    candidates[0].apply(st);
    return { action: 'applied', candidates };
  }

  const words = candidates.filter((c) => c.word).map((c) => c.word);
  if (words.length === candidates.length) {
    const common = commonPrefix(words);
    if (common.length > prefix.length && !WORDS.includes(common)) {
      extendPrefix(st, common.slice(prefix.length));
      return { action: 'extended', candidates };
    }
  }
  return { action: 'menu', candidates };
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

  /** The document's names, as last given: { functions, params, states }. */
  get documentNames() {
    return {
      functions: this.st.names.functions.slice(),
      params: this.st.names.params.slice(),
      states: this.st.names.states.slice(),
    };
  }

  /**
   * Tell the row what the document defines, for completion. `functions` also
   * goes to setFunctions(), since it is the same fact - a name with an
   * `f(u) = ...` row - and two sources of truth for it would drift. Omit the
   * key to leave the parser's function set alone.
   *
   * @returns true when the row had to be re-read, as setFunctions() does.
   */
  setDocumentNames(names) {
    this.st.names = normaliseNames(names);
    const given = names && names.functions;
    return given ? this.setFunctions(given) : false;
  }

  /**
   * The variable names the document has in play - states then parameters,
   * deduped. What a keyboard offers as variable keys. See variableNamesIn().
   */
  variableNames() { return variableNamesIn(this.st.names); }

  /** Everything Tab could do at the caret, without doing any of it. */
  completions() { return completionsFor(this.st); }

  /** Tab. See tabComplete(). */
  tab() { return tabComplete(this.st); }

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

/** How many completions the menu shows before it says "+n more". */
const MENU_MAX = 10;

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

// ---------------------------------------------------------------------------
// The command table - the one path
//
// A tap on the on-screen keyboard and a keystroke on a desktop keyboard have to
// do exactly the same thing, so there is exactly one implementation of each.
// `field.command(name)` is it; `_keydown()` does nothing but translate a key
// event into a command name (or a character for `field.insert()`) and hand it
// over. Nothing below the translation layer knows whether a finger or a key
// started it, which is why the two cannot drift.
// ---------------------------------------------------------------------------

/**
 * Editing commands, by stable name. Each takes the field and returns true when
 * it changed the row. The structural ones are literally the character the
 * desktop keyboard sends, run through the same typeChar(), so `command('frac')`
 * grabs the preceding operand exactly as typing `/` does and `insert('sqrt')`
 * inflates a radical exactly as typing s-q-r-t does.
 */
const FIELD_COMMANDS = {
  // structure - the reason the keyboard exists
  frac: (f) => f._edit((st) => typeChar(st, '/')),
  sup: (f) => f._edit((st) => typeChar(st, '^')),
  sub: (f) => f._edit((st) => typeChar(st, '_')),
  prime: (f) => f._edit((st) => typeChar(st, "'")),
  sqrt: (f) => f.insert('sqrt'),
  // deletion
  backspace: (f) => f._edit(backspace),
  delete: (f) => f._edit(deleteForward),
  // navigation - never a change, but it still repaints and it still reports an
  // escape past the row's edge to the shell, so the row above takes the caret
  left: (f) => f._edit((st) => { f._nav(moveLeft(st), 'left'); }),
  right: (f) => f._edit((st) => { f._nav(moveRight(st), 'right'); }),
  up: (f) => f._edit((st) => { f._nav(moveVert(st, -1), 'up'); }),
  down: (f) => f._edit((st) => { f._nav(moveVert(st, 1), 'down'); }),
  home: (f) => f._edit(moveHome),
  end: (f) => f._edit(moveEnd),
  // the rest of what the desktop keyboard can do, for a panel that wants it
  enter: (f) => { if (f.opts.onEnter) f.opts.onEnter(f); return false; },
  tab: (f) => f._tab(),
};

/** Every name `field.command()` answers to. Anything else is ignored. */
export const COMMAND_NAMES = Object.keys(FIELD_COMMANDS);

/** Key event names that are simply commands under another name. */
const KEY_COMMAND = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  Backspace: 'backspace',
  Delete: 'delete',
};

/**
 * An editable math field.
 *
 * @param host  element to mount into (the field replaces its contents)
 * @param opts.functions  names the document defines as functions, so that
 *                        `d(x, y)` reads as a call - see setFunctions()
 * @param opts.documentNames  { functions, params, states } for Tab completion
 *                        - see setDocumentNames()
 * @param opts.touchDriven  true when an on-screen keyboard drives this field
 *                        and the OS keyboard must stay down - see touchDriven
 * @param opts  { value?: string, onChange?: (field) => void,
 *                onFocus?: (field) => void, onBlur?: (field) => void,
 *                onEnter?: (field) => void, onNavigate?: (field, dir) => void }
 */
export class MathField {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.model = new MathModel(opts.value || '', opts.functions);
    if (opts.documentNames) this.model.setDocumentNames(opts.documentNames);
    this._menu = null;
    this.focused = false;
    this.diagnostic = null;
    this.diagnosticMessage = '';
    this._positions = [];
    this._touchDriven = false;
    this._touch = null;      // the start of a touch, while one is in progress
    this._touchAt = 0;       // when the last tap was handled - see _pointerdown

    host.innerHTML = '';
    // The focusable element is a plain <div tabindex="0">. Not an <input>, not
    // a contenteditable, and there is no hidden input shadowing it: those are
    // the three things a mobile browser raises its keyboard for, so a field
    // built this way has nothing to suppress in the first place. `touchDriven`
    // then closes the remaining gap - see _applyTouchMode().
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
    this._onTouchStart = (e) => this._touchstart(e);
    this._onTouchEnd = (e) => this._touchend(e);
    this._onFocus = () => { this.focused = true; root.classList.add('is-focused'); this.render(); if (opts.onFocus) opts.onFocus(this); };
    this._onBlur = () => { this.focused = false; this._closeMenu(); root.classList.remove('is-focused'); this.render(); if (opts.onBlur) opts.onBlur(this); };
    this._onPaste = (e) => this._paste(e);

    root.addEventListener('keydown', this._onKeyDown);
    root.addEventListener('mousedown', this._onPointerDown);
    // A tap has to place the caret too, and a phone with no mouse never sends
    // `mousedown` until the tap is over (if at all). `touchstart` is passive so
    // a finger can still scroll the pane through a row.
    root.addEventListener('touchstart', this._onTouchStart, { passive: true });
    root.addEventListener('touchend', this._onTouchEnd);
    root.addEventListener('focus', this._onFocus);
    root.addEventListener('blur', this._onBlur);
    root.addEventListener('paste', this._onPaste);

    this.touchDriven = opts.touchDriven;
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

  /** The document's names, as last given: { functions, params, states }. */
  get documentNames() { return this.model.documentNames; }

  /**
   * Tell the field what the document defines, so Tab can complete it: user
   * functions, parameters and states. `functions` is forwarded to
   * setFunctions() as well, since it is the same fact; omit that key to leave
   * the parser's function set alone. Returns true when the row was re-read.
   */
  setDocumentNames(names) {
    const changed = this.model.setDocumentNames(names);
    if (changed) this.render();
    return changed;
  }

  /** Everything Tab could do at the caret, without doing any of it. */
  completions() { return this.model.completions(); }

  /**
   * The variable names the document has in play - states then parameters,
   * deduped, in document order - so an on-screen keyboard can offer the
   * document's own names as keys instead of keeping its own copy of them.
   * They arrive through setDocumentNames(); this is the way back out.
   */
  variableNames() { return this.model.variableNames(); }

  // --- the command API ----------------------------------------------------
  // The on-screen keyboard drives the field through these two calls and
  // nothing else: no synthetic key events, no hidden input. _keydown() is a
  // translator that ends up here too, so a tap and a keystroke are the same
  // operation and cannot drift apart.

  /**
   * Type text as if it were typed on a keyboard: 'x', '2', '+', 'sin', or a
   * whole expression. Structure inflates exactly as it does under the fingers,
   * so insert('sqrt') leaves a real radical with the caret inside its radicand
   * and insert('sin') leaves an open call with the caret in the argument.
   * Fires onChange when the row changed, exactly as typing does.
   *
   * @returns true when the row changed.
   */
  insert(text) {
    if (text == null) return false;
    return this._edit((st) => typeString(st, text));
  }

  /**
   * One editing command, by name. Names are stable and listed in
   * COMMAND_NAMES:
   *
   *   'frac' | 'sup' | 'sub' | 'sqrt' | 'prime'
   *   'backspace' | 'delete'
   *   'left' | 'right' | 'up' | 'down' | 'home' | 'end'
   *   'enter' | 'tab'
   *
   * An unknown name is ignored and returns false - never throws. A keyboard is
   * data, and a typo in a key definition must not take the app down with it.
   *
   * @returns true when the field acted on it (for the editing commands, when
   *   the row changed; navigation returns false because nothing changed).
   */
  command(name) {
    const run = Object.prototype.hasOwnProperty.call(FIELD_COMMANDS, name)
      ? FIELD_COMMANDS[name]
      : null;
    if (!run) return false;
    return run(this) === true;
  }

  /**
   * True when an on-screen keyboard drives this field and the OS keyboard must
   * stay down. The field still takes focus, still paints its caret and still
   * places it on a tap - only the phone's own keyboard is kept away, so it
   * cannot cover the panel that is doing the typing. See _applyTouchMode() for
   * what it actually changes in the DOM.
   */
  get touchDriven() { return this._touchDriven; }

  set touchDriven(on) {
    this._touchDriven = !!on;
    this._applyTouchMode();
  }

  /**
   * What `touchDriven` costs the DOM, and why each piece is there:
   *
   *   inputmode="none"     the documented way to tell a browser that an
   *                        element takes input from somewhere other than the
   *                        virtual keyboard. Browsers that would raise one for
   *                        role="textbox" honour this.
   *   aria-readonly="true" the field is genuinely not editable by the OS
   *                        keyboard, and assistive technology that would
   *                        summon one for an editable textbox reads this.
   *   .mf--touch           CSS: no long-press selection callout, no magnifier,
   *                        no double-tap zoom on a caret placement.
   *
   * The element stays tabbable and stays role="textbox", so it still focuses,
   * still shows a caret and still answers a hardware keyboard - a tablet with
   * one keeps working.
   */
  _applyTouchMode() {
    const root = this.el;
    if (!root) return;
    const on = this._touchDriven;
    root.classList.toggle('mf--touch', on);
    if (on) {
      root.setAttribute('inputmode', 'none');
      root.setAttribute('aria-readonly', 'true');
    } else {
      root.removeAttribute('inputmode');
      root.removeAttribute('aria-readonly');
    }
  }

  /** True while the completion menu is open. */
  get menuOpen() { return this._menu != null; }

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
    this._closeMenu();
    this.el.removeEventListener('keydown', this._onKeyDown);
    this.el.removeEventListener('mousedown', this._onPointerDown);
    this.el.removeEventListener('touchstart', this._onTouchStart);
    this.el.removeEventListener('touchend', this._onTouchEnd);
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

  /**
   * The bottom of every editing path, whatever started it. Runs one operation
   * against the model, repaints, and fires onChange if the row changed. The
   * completion menu is a desktop affordance layered on top of the keys, so any
   * edit dismisses it - which is what the key handler already did for every
   * key the menu did not claim.
   */
  _edit(op) {
    this._closeMenu();
    const changed = op(this.model.st) === true;
    this._apply(changed);
    return changed;
  }

  /** A move that hit the edge of the row belongs to the shell above us. */
  _nav(moved, dir) {
    if (!moved && this.opts.onNavigate) this.opts.onNavigate(this, dir);
  }

  // --- input --------------------------------------------------------------

  /**
   * A key event is translated into a command name or a character and handed to
   * the public API. This method decides *what* a key means; it never decides
   * what a command does. That is the whole of the one-path guarantee.
   */
  _keydown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // While the menu is open it owns the navigation keys. Anything else closes
    // it and is then handled as if it had never been there.
    if (this._menu) {
      switch (e.key) {
        case 'ArrowDown': this._moveMenu(1); e.preventDefault(); return;
        case 'ArrowUp': this._moveMenu(-1); e.preventDefault(); return;
        case 'Tab': this._moveMenu(e.shiftKey ? -1 : 1); e.preventDefault(); return;
        case 'Enter': this._acceptMenu(this._menu.index); e.preventDefault(); return;
        case 'Escape': this._closeMenu(); e.preventDefault(); return;
        default: this._closeMenu(); break;
      }
    }

    const named = KEY_COMMAND[e.key];
    if (named) { this.command(named); e.preventDefault(); return; }

    switch (e.key) {
      case 'Enter': this.command('enter'); e.preventDefault(); return;
      case 'Escape': this.blur(); e.preventDefault(); return;
      case 'Tab':
        // Shift+Tab never completes, and a Tab that completes nothing is not
        // ours: both fall through to whatever moves focus between rows.
        if (!e.shiftKey && this.command('tab')) e.preventDefault();
        return;
      default: break;
    }

    if (e.key.length === 1) {
      this.insert(e.key);
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
    // A tap already placed the caret; the compatibility mouse events a browser
    // sends afterwards would place it a second time, from stale coordinates.
    if (this._touchAt && Date.now() - this._touchAt < 700) {
      if (e.preventDefault) e.preventDefault();
      return;
    }
    this._place(e.clientX, e.clientY);
    if (e.preventDefault) e.preventDefault();
  }

  /** Put the caret at the position nearest to a point, and take focus. */
  _place(x, y) {
    this._closeMenu();
    const hit = this._nearest(x, y);
    if (hit) {
      this.model.st.path = hit._mfPath;
      this.model.st.index = hit._mfIndex;
    }
    // Focus first (so the caret is visible), then paint the new position.
    if (!this.focused) this.el.focus();
    this.render();
  }

  _touchstart(e) {
    const t = e.touches && e.touches[0];
    this._touch = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
  }

  /**
   * Caret placement happens on `touchend`, not `touchstart`: a finger that
   * came down on a row may be starting a scroll of the pane, and only the end
   * of the gesture says which it was. A short, still touch is a tap.
   */
  _touchend(e) {
    const start = this._touch;
    this._touch = null;
    const t = e.changedTouches && e.changedTouches[0];
    if (!start || !t) return;
    if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) return;
    if (Date.now() - start.at > 700) return;
    this._touchAt = Date.now();
    this._place(t.clientX, t.clientY);
    // Preventing the tap's default is what stops the browser synthesising a
    // mouse click - and, on a phone, what stops a double tap zooming.
    if (e.cancelable !== false && e.preventDefault) e.preventDefault();
  }

  /**
   * Tab. Returns true when the field consumed it; when it returns false the
   * key event is left alone, so the browser moves focus out of the field.
   */
  _tab() {
    const r = tabComplete(this.model.st);
    if (r.action === 'none') { this._closeMenu(); return false; }
    if (r.action === 'menu') {
      this._openMenu(r.candidates);
      return true;
    }
    this._closeMenu();
    this._apply(true);
    return true;
  }

  _openMenu(candidates) {
    this._closeMenu();
    if (typeof document === 'undefined' || !document.body) return;
    const shown = candidates.slice(0, MENU_MAX);
    const menu = el('div', 'mf-menu');
    menu.setAttribute('role', 'listbox');
    const items = shown.map((c, i) => {
      const item = el('div', 'mf-menu-item');
      item.setAttribute('role', 'option');
      const label = el('span', 'mf-menu-label');
      label.textContent = c.label;
      item.appendChild(label);
      if (c.hint) {
        const hint = el('span', 'mf-menu-hint');
        hint.textContent = c.hint;
        item.appendChild(hint);
      }
      item.addEventListener('mousedown', (ev) => { ev.preventDefault(); this._acceptMenu(i); });
      item.addEventListener('mousemove', () => this._selectMenu(i));
      menu.appendChild(item);
      return item;
    });
    if (candidates.length > shown.length) {
      const more = el('div', 'mf-menu-more');
      more.textContent = '+' + (candidates.length - shown.length) + ' more';
      menu.appendChild(more);
    }
    document.body.appendChild(menu);
    this._menu = { el: menu, items, candidates: shown, index: 0 };
    this._positionMenu();
    this._paintMenu();
    this._onViewChange = () => this._closeMenu();
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('scroll', this._onViewChange, true);
      window.addEventListener('resize', this._onViewChange);
    }
  }

  _positionMenu() {
    const caret = this._positions.find((q) => q.classList.contains('mf-pos--caret'));
    const box = (caret || this.el).getBoundingClientRect();
    const width = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024;
    const style = this._menu.el.style;
    style.position = 'fixed';
    style.left = Math.round(Math.max(4, Math.min(box.left, width - 280))) + 'px';
    style.top = Math.round(box.bottom + 4) + 'px';
  }

  _paintMenu() {
    this._menu.items.forEach((item, i) => {
      item.classList.toggle('is-selected', i === this._menu.index);
    });
  }

  _selectMenu(i) {
    if (!this._menu) return;
    this._menu.index = i;
    this._paintMenu();
  }

  _moveMenu(delta) {
    if (!this._menu) return;
    const n = this._menu.candidates.length;
    this._selectMenu(((this._menu.index + delta) % n + n) % n);
  }

  _acceptMenu(i) {
    if (!this._menu) return;
    const chosen = this._menu.candidates[i];
    this._closeMenu();
    if (!chosen) return;
    chosen.apply(this.model.st);
    this.model.st.pristine = null;
    this._apply(true);
  }

  _closeMenu() {
    if (!this._menu) return;
    const { el: menu } = this._menu;
    this._menu = null;
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    if (typeof window !== 'undefined' && window.removeEventListener && this._onViewChange) {
      window.removeEventListener('scroll', this._onViewChange, true);
      window.removeEventListener('resize', this._onViewChange);
    }
    this._onViewChange = null;
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
