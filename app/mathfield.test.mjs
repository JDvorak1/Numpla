// ============================================================================
// mathfield.test.mjs - headless tests for the math field's model layer.
//
//   node app/mathfield.test.mjs
//
// No DOM: only the atom model, the editing operations and the serialiser are
// exercised. `source` round-tripping is the contract with numpla-model, so it
// gets the bulk of the coverage.
// ============================================================================

import {
  A, MathModel, parseSource, toSource, toLatex, newState, typeString,
  backspace, moveLeft, moveRight, moveVert, curList, slotKeys,
} from './mathfield.js';

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error('FAIL  ' + name + (detail ? '\n      ' + detail : ''));
}

function eq(name, actual, expected) {
  ok(name, actual === expected,
    'expected: ' + JSON.stringify(expected) + '\n      actual:   ' + JSON.stringify(actual));
}

/** Setting source then reading it back must return exactly the same text. */
function roundTrip(text) {
  const m = new MathModel();
  m.source = text;
  eq('round-trip ' + JSON.stringify(text), m.source, text);
  // and it must be a fixed point: a second pass changes nothing
  const once = m.source;
  m.source = once;
  eq('round-trip stable ' + JSON.stringify(text), m.source, once);
}

/** Type a string into an empty field and read the source back. */
function typed(text) {
  const m = new MathModel();
  m.type(text);
  return m.source;
}

// ---------------------------------------------------------------------------
// 1. Document rows from docs/wasm-api.md round-trip verbatim
// ---------------------------------------------------------------------------

roundTrip("x' = -y");
roundTrip("y' = x");
roundTrip("x'' = -x - 0.4x'");
roundTrip('k = 0.5');
roundTrip('x(0) = 1');
roundTrip("x'(0) = 0");
roundTrip('f(x) = x^(2)');
roundTrip('a = b + c*d');
roundTrip('r = sqrt(x^(2) + y^(2))');
roundTrip('y = sin(2pit)');
roundTrip('y = sin(2pi*t)');
roundTrip('k_1 = 0.5');
roundTrip('m = min(a, b)');
roundTrip("v' = -k*v - g");
roundTrip('z = [1, 2, 3]');
roundTrip('u = -(x)/(2)');
roundTrip('w = exp(-t)*cos(t)');

// ---------------------------------------------------------------------------
// 2. Structure emission - the exact shapes the parser must see
// ---------------------------------------------------------------------------

eq('fraction emits (num)/(den)',
  toSource([A.frac([A.var('x')], [A.digit('2')])]), '(x)/(2)');

eq('superscript emits ^(...)',
  toSource([A.var('x'), A.sup([A.digit('2')])]), 'x^(2)');

eq('radical emits sqrt(...)',
  toSource([A.sqrt([A.var('x')])]), 'sqrt(x)');

eq('subscript emits _1 when unambiguous',
  toSource([A.var('k', [A.digit('1')])]), 'k_1');

eq('subscript braces when a letter follows',
  toSource([A.var('k', [A.digit('1')]), A.var('y')]), 'k_{1}y');

eq('bare function name keeps a separator',
  toSource([A.func('sin'), A.var('x')]), 'sin x');

eq('applied function needs none',
  toSource([A.func('sin'), A.group('(', [A.var('x')])]), 'sin(x)');

eq('primes pass straight through',
  toSource([A.var('x'), A.prime(), A.prime()]), "x''");

eq('unary minus has no spaces',
  toSource([A.op('-'), A.var('x')]), '-x');

eq('binary minus does',
  toSource([A.var('a'), A.op('-'), A.var('b')]), 'a - b');

// ---------------------------------------------------------------------------
// 3. Fraction precedence: `1/2x` is (1/2)*x, a real fraction is not
// ---------------------------------------------------------------------------

{
  // Parsed from source, `/` binds like the Rust parser: the denominator is the
  // next primary only, so `1/2x` keeps x outside the fraction.
  const m = new MathModel();
  m.source = '1/2x';
  eq('1/2x -> (1)/(2)x', m.source, '(1)/(2)x');
  const atoms = m.root;
  eq('1/2x is frac then x', atoms.length, 2);
  eq('1/2x first atom is a fraction', atoms[0].type, 'frac');
  eq('1/2x denominator holds only the 2', toSource(atoms[0].den), '2');

  // Typed with `/`, the denominator is whatever the user then types into it.
  eq('typed 1/2x puts x in the denominator', typed('1/2x'), '(1)/(2x)');

  // ... and the two are genuinely different documents.
  ok('the two 1/2x readings differ', typed('1/2x') !== m.source);
}

{
  // `/` grabs the whole preceding product, matching the Rust parser's
  // left-associative implicit multiplication: 2x/3 == (2x)/3.
  const m = new MathModel();
  m.source = '2x/3';
  eq('2x/3 -> (2x)/(3)', m.source, '(2x)/(3)');
  eq('2x/3 numerator is 2x', toSource(m.root[0].num), '2x');
}

{
  const m = new MathModel();
  m.source = 'a + b/c';
  eq('a + b/c only takes b', m.source, 'a + (b)/(c)');
}

{
  const m = new MathModel();
  m.source = 'sin(x)/2';
  eq('function application is one operand', m.source, '(sin(x))/(2)');
}

// ---------------------------------------------------------------------------
// 4. Nested fractions
// ---------------------------------------------------------------------------

roundTrip('((1)/(2))/(3)');
roundTrip('(1)/((2)/(3))');
roundTrip('((a + b)/(c))/((d)/(e + f))');

{
  const m = new MathModel();
  m.source = '((1)/(2))/(3)';
  eq('nested numerator is itself a fraction', m.root[0].num[0].type, 'frac');
  eq('nested fraction has depth 2', toSource(m.root[0].num), '(1)/(2)');
}

{
  // Typing a fraction inside a fraction.
  const m = new MathModel();
  m.type('1/2');       // caret sits in the denominator
  m.type('/3');        // ... which becomes a numerator of its own
  eq('typed nested fraction', m.source, '(1)/((2)/(3))');
}

// ---------------------------------------------------------------------------
// 5. Superscripts
// ---------------------------------------------------------------------------

roundTrip('x^(2)');
roundTrip('x^(2) + y^(2)');
roundTrip('e^(-k*t)');
roundTrip('x^((1)/(2))');
roundTrip('2^(3^(2))');

eq('typing x^2 raises the 2', typed('x^2'), 'x^(2)');
eq('typing x^2+1 leaves the field after ^', (() => {
  const m = new MathModel();
  m.type('x^2');
  m.right();          // walk out of the superscript
  m.type('+1');
  return m.source;
})(), 'x^(2) + 1');

{
  const m = new MathModel();
  m.source = 'x^2';
  eq('bare ^2 parses as a superscript', m.root[1].type, 'sup');
  eq('bare ^2 re-emits parenthesised', m.source, 'x^(2)');
}

// ---------------------------------------------------------------------------
// 6. Radicals
// ---------------------------------------------------------------------------

roundTrip('sqrt(2)');
roundTrip('sqrt(x^(2) + y^(2))');
roundTrip('sqrt((a)/(b))');
roundTrip('1 + sqrt(sqrt(x))');

eq('typing sqrt inflates a radical', typed('sqrt'), 'sqrt()');
eq('a radical answers to )', typed('sqrt2)+1'), 'sqrt(2) + 1');
eq('a group answers to ) too', typed('(a+b)*2'), '(a + b)*2');
eq('typing sqrt2 fills the radicand', typed('sqrt2'), 'sqrt(2)');
{
  const m = new MathModel();
  m.type('sqrt');
  eq('sqrt made a radical atom', m.root[0].type, 'sqrt');
  eq('caret is inside the radicand', m.st.path.length, 1);
  m.type('x+1');
  eq('radicand collects what follows', m.source, 'sqrt(x + 1)');
}

// ---------------------------------------------------------------------------
// 7. Subscripts
// ---------------------------------------------------------------------------

roundTrip('k_1');
roundTrip('k_1 = 0.5');
roundTrip("x_1' = -x_2");
roundTrip('k_{1}y');
roundTrip('a_max = 3');

{
  const m = new MathModel();
  m.source = 'k_{max}';
  eq('braced subscript survives', m.source, 'k_max');
  eq('subscript hangs off the letter', m.root.length, 1);
  eq('subscript content', toSource(m.root[0].sub, true), 'max');
}

eq('typing k_1 makes a subscript', typed('k_1'), 'k_1');
{
  const m = new MathModel();
  m.type('k_max');
  eq('function names do not inflate inside subscripts', m.root.length, 1);
  eq('subscript stays a label', m.source, 'k_max');
}

// ---------------------------------------------------------------------------
// 8. Single-letter identifiers and function names
// ---------------------------------------------------------------------------

{
  const m = new MathModel();
  m.type('xy');
  eq('xy is two variables', m.root.length, 2);
  eq('xy stays xy', m.source, 'xy');
}

{
  const m = new MathModel();
  m.type('sin');
  eq('sin is one function atom', m.root[0].type, 'func');
  eq('sin opens its parentheses', m.source, 'sin()');
  m.type('t');
  eq('and the caret is inside them', m.source, 'sin(t)');
}

{
  const m = new MathModel();
  m.type('arctan');
  eq('longest function name wins', m.root[0].name, 'arctan');
}

{
  const m = new MathModel();
  m.type('pi');
  eq('pi is a constant atom', m.root[0].type, 'const');
  eq('pi emits pi', m.source, 'pi');
}

{
  const m = new MathModel();
  m.source = 'sinx';
  eq('sinx parses as sin applied to x', m.source, 'sin x');
}

// ---------------------------------------------------------------------------
// 9. Caret walks into and out of every structure
// ---------------------------------------------------------------------------

{
  const st = newState(parseSource('(1)/(2)'));
  // start of the row -> numerator -> denominator -> past the fraction
  const seen = [];
  for (let i = 0; i < 8; i++) {
    seen.push(st.path.map((p) => p[1]).join('/') + ':' + st.index);
    if (!moveRight(st)) break;
  }
  eq('right walks num then den then out',
    seen.join(' '), ':0 num:0 num:1 den:0 den:1 :1');

  // and back again, symmetrically
  const back = [];
  for (let i = 0; i < 8; i++) {
    back.push(st.path.map((p) => p[1]).join('/') + ':' + st.index);
    if (!moveLeft(st)) break;
  }
  eq('left mirrors right',
    back.join(' '), ':1 den:1 den:0 num:1 num:0 :0');
}

{
  const st = newState(parseSource('(1)/(2)'));
  moveRight(st); moveRight(st);          // in the numerator, after the 1
  ok('down goes to the denominator', moveVert(st, 1));
  eq('landed in the denominator', st.path[st.path.length - 1][1], 'den');
  ok('up goes back to the numerator', moveVert(st, -1));
  eq('landed in the numerator', st.path[st.path.length - 1][1], 'num');
  ok('up again escapes the field', moveVert(st, -1) === false);
}

{
  const st = newState(parseSource('x^(2)'));
  st.index = st.root.length;
  ok('up climbs into a superscript', moveVert(st, -1));
  eq('caret is in the superscript', st.path[0][1], 'body');
  ok('down climbs back out', moveVert(st, 1));
  eq('and is back on the baseline', st.path.length, 0);
}

// ---------------------------------------------------------------------------
// 10. Backspace collapses structures instead of eating ghosts
// ---------------------------------------------------------------------------

{
  const m = new MathModel();
  m.type('1/2');                    // caret in the denominator, before nothing
  m.left();                         // ... still at index 0 of the denominator
  m.backspace();                    // -> end of the numerator
  eq('backspace at den start hops to the numerator',
    m.st.path[m.st.path.length - 1][1], 'num');
  m.backspace();                    // deletes the 1
  m.backspace();                    // empty first slot -> collapse the fraction
  eq('collapsed fraction leaves the denominator behind', m.source, '2');
}

{
  const m = new MathModel();
  m.type('(x+1)');
  eq('typing ) walked out of the group', m.st.path.length, 0);
  eq('the group is matched', m.source, '(x + 1)');
  m.left();                         // and left() steps back inside it
  eq('left re-enters the group', m.st.path.length, 1);
  eq('at the end of its body', m.st.index, 3);
}

{
  // Adjacent letters that would accidentally spell a word get a separator.
  const m = new MathModel();
  m.source = 'p i';
  eq('p and i stay two variables', m.root.length, 2);
  eq('and are re-emitted unambiguously', m.source, 'p i');
}

{
  const m = new MathModel();
  m.type('x^');                     // empty superscript, caret inside
  m.backspace();                    // left edge of an empty slot
  eq('empty superscript collapses away', m.source, 'x');
}

{
  const m = new MathModel();
  m.type('sqrt');
  m.type('9');
  m.home();
  m.end();
  m.backspace();                    // steps into the radicand
  m.backspace();                    // deletes the 9
  m.backspace();                    // collapses the empty radical
  eq('radical collapses when emptied', m.source, '');
  ok('field reports empty', m.isEmpty());
}

{
  const m = new MathModel();
  m.source = 'k_1';
  m.end();
  m.backspace();                    // into the subscript
  m.backspace();                    // deletes the 1
  m.backspace();                    // peels the subscript off the letter
  eq('subscript peels, letter survives', m.source, 'k');
}

{
  const m = new MathModel();
  m.source = '(a + b)/(c)';
  m.st.path = [[0, 'num']];
  m.st.index = 0;
  m.backspace();
  eq('collapsing a filled fraction keeps its contents', m.source, 'a + bc');
}

// ---------------------------------------------------------------------------
// 11. Typing full document rows character by character
// ---------------------------------------------------------------------------

eq("typing x'=-y", typed("x'=-y"), "x' = -y");
eq("typing x''=-x-0.4x'", typed("x''=-x-0.4x'"), "x'' = -x - 0.4x'");
eq('typing k=0.5', typed('k=0.5'), 'k = 0.5');
eq('typing x(0)=1', typed('x(0)=1'), 'x(0) = 1');
eq('typing f(x)=x^2', (() => {
  const m = new MathModel();
  m.type('f(x)');                   // ( auto-closes, ) walks back out
  m.type('=x^2');
  return m.source;
})(), 'f(x) = x^(2)');

// ---------------------------------------------------------------------------
// 12. LaTeX projection
// ---------------------------------------------------------------------------

eq('latex fraction',
  toLatex(parseSource("x' = (-y)/(2)")), "x'=\\frac{-y}{2}");
eq('latex radical', toLatex(parseSource('sqrt(x)')), '\\sqrt{x}');
eq('latex superscript', toLatex(parseSource('x^2')), 'x^{2}');
eq('latex subscript', toLatex(parseSource('k_1')), 'k_{1}');
eq('latex function', toLatex(parseSource('sin(t)')), '\\sin \\left(t\\right)');
eq('latex constant', toLatex(parseSource('pi')), '\\pi ');
eq('latex product', toLatex(parseSource('a*b')), 'a\\cdot b');

// ---------------------------------------------------------------------------
// 13. Model invariants
// ---------------------------------------------------------------------------

{
  const m = new MathModel();
  m.source = '';
  ok('empty source is an empty model', m.isEmpty());
  eq('empty source emits nothing', m.source, '');
  eq('empty latex', m.latex, '');
  ok('backspace on an empty model is a no-op', m.backspace() === false);
  ok('left on an empty model is a no-op', m.left() === false);
  ok('right on an empty model is a no-op', m.right() === false);
}

{
  // Every slot key an atom advertises must actually exist on it.
  const atoms = parseSource("x'' = -x - 0.4x' + (1)/(2) + sqrt(y^(2)) + k_1 + [1, 2]");
  const walk = (list) => {
    for (const a of list) {
      for (const k of slotKeys(a)) {
        ok('slot ' + a.type + '.' + k + ' exists', Array.isArray(a[k]));
        walk(a[k]);
      }
    }
  };
  walk(atoms);
  eq('a long row still round-trips',
    toSource(atoms), "x'' = -x - 0.4x' + (1)/(2) + sqrt(y^(2)) + k_1 + [1, 2]");
}

{
  // Half-typed input is a normal state, never a crash.
  for (const junk of ['(', ')', '/', '^', '_', 'x/', '1/(', 'sqrt(', '((()))', '=', '- ', 'x^^2']) {
    const m = new MathModel();
    let threw = false;
    try { m.source = junk; m.source; m.latex; } catch (e) { threw = true; }
    ok('half-typed input survives ' + JSON.stringify(junk), !threw);
  }
}

{
  // Typing arbitrary garbage never throws and never desynchronises the caret.
  const m = new MathModel();
  const st = newState([]);
  let threw = false;
  try {
    typeString(st, "x'/2^(sqrt(pi))_1+[a,b]*-3.5=y''");
    for (let i = 0; i < 60; i++) { moveLeft(st); moveVert(st, 1); }
    for (let i = 0; i < 60; i++) { moveRight(st); moveVert(st, -1); }
    for (let i = 0; i < 60; i++) backspace(st);
    ok('everything deletes down to empty', st.root.length === 0);
    ok('caret ends at the root', st.path.length === 0 && st.index === 0);
  } catch (e) { threw = true; console.error(e); }
  ok('fuzzing never throws', !threw);
  ok('unused model builds', m instanceof MathModel);
}

// ---------------------------------------------------------------------------
// 14. The rendering half, over a ~40-line DOM shim
//
// The model above needs no DOM at all. The projection obviously does, so it is
// exercised through the smallest possible stand-in - enough to prove that every
// atom type renders, that the keyboard path drives the model, that exactly one
// caret is painted, and that destroy() lets go of the host.
// ---------------------------------------------------------------------------

class ShimEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this._class = '';
    this.textContent = '';
    this.listeners = {};
    this.style = {};
    const has = (c) => this._class.split(/\s+/).filter(Boolean).includes(c);
    this.classList = {
      add: (c) => { if (!has(c)) this._class = (this._class + ' ' + c).trim(); },
      remove: (c) => {
        this._class = this._class.split(/\s+/).filter((x) => x && x !== c).join(' ');
      },
      contains: has,
      toggle: (c, on) => (on ? this.classList.add(c) : this.classList.remove(c)),
    };
  }
  get className() { return this._class; }
  set className(v) { this._class = v || ''; }
  get innerHTML() { return ''; }
  set innerHTML(v) { if (v === '') this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this._class = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); }
  removeEventListener(k, f) {
    this.listeners[k] = (this.listeners[k] || []).filter((g) => g !== f);
  }
  fire(k, ev) { for (const f of this.listeners[k] || []) f(ev); }
  focus() { this.fire('focus', {}); }
  blur() { this.fire('blur', {}); }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 10 }; }
  text() { return this.textContent + this.children.map((c) => c.text()).join(''); }
  classes(out = []) {
    if (this._class) out.push(this._class);
    for (const c of this.children) c.classes(out);
    return out;
  }
}

globalThis.document = {
  createElement: (t) => new ShimEl(t),
  createElementNS: (_ns, t) => new ShimEl(t),
};

const { MathField } = await import('./mathfield.js');
const press = (f, k) => f.el.fire('keydown', {
  key: k, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {},
});

{
  const f = new MathField(new ShimEl('div'), {
    value: 'sqrt((a)/(b)) + x^(2) + k_1 + sin(pit) + [1] - 2',
  });
  const cls = f.el.classes().join(' ');
  for (const want of ['mf-sqrt', 'mf-radical', 'mf-frac', 'mf-num', 'mf-den',
    'mf-sup', 'mf-sub', 'mf-group', 'mf-delim', 'mf-var', 'mf-digit', 'mf-func',
    'mf-const', 'mf-op']) {
    ok('renders a ' + want, cls.includes(want));
  }
  ok('minus is typeset as a real minus', f.el.text().includes('−'));
  ok('pi is typeset as a glyph', f.el.text().includes('π'));
  f.destroy();
}

{
  const host = new ShimEl('div');
  let changes = 0, entered = 0;
  const navs = [];
  const f = new MathField(host, {
    value: '',
    onChange: () => changes++,
    onEnter: () => entered++,
    onNavigate: (_f, dir) => navs.push(dir),
  });
  f.focus();
  ok('focus is tracked', f.focused);
  for (const ch of "x''=-x-0.4x'") press(f, ch);
  eq('the keyboard drives the model', f.source, "x'' = -x - 0.4x'");
  eq('onChange fired once per keystroke', changes, 12);

  press(f, 'Enter');
  eq('onEnter fired', entered, 1);
  press(f, 'ArrowUp');
  ok('up out of the row reports to the host', navs.includes('up'));

  press(f, 'Home');
  press(f, 'ArrowLeft');
  ok('left off the start reports too', navs.includes('left'));

  press(f, 'End');
  for (let i = 0; i < 40; i++) press(f, 'Backspace');
  ok('backspace empties the row', f.isEmpty());

  for (const ch of '1/2') press(f, ch);
  eq('a fraction typed through the DOM', f.source, '(1)/(2)');
  eq('one caret, and only one',
    f.el.classes().filter((c) => c.includes('mf-pos--caret')).length, 1);
  eq('a caret position per slot boundary', f._positions.length, 6);

  f.el.fire('mousedown', { clientX: 0, clientY: 0, preventDefault() {} });
  ok('clicking lands on a valid position', f._positions.length > 0);

  f.blur();
  eq('an unfocused field paints no caret',
    f.el.classes().filter((c) => c.includes('mf-pos--caret')).length, 0);

  f.source = 'y = 2';
  eq('setting source re-renders', f.source, 'y = 2');
  eq('but does not echo onChange', changes, 27);

  f.setDiagnostic('pending', 'incomplete');
  ok('pending styling applied', f.el.classList.contains('is-pending'));
  f.setDiagnostic('error', 'broken');
  ok('error styling applied', f.el.classList.contains('is-error'));
  ok('and pending was cleared', !f.el.classList.contains('is-pending'));
  f.setDiagnostic(null, '');
  ok('diagnostics clear', !f.el.classList.contains('is-error'));

  f.destroy();
  eq('destroy releases the host', host.children.length, 0);
}

// ---------------------------------------------------------------------------

console.log((failed ? 'FAILED  ' : 'ok  ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
