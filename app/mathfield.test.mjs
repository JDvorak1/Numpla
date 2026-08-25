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
  backspace, moveLeft, moveRight, moveVert, curList, slotKeys, tailStart, functionNamesIn, normaliseFunctions,
  FUNCS, CONSTS, arityOf, commonPrefix,
} from './mathfield.js';
import { DEMOS } from './demos.js';

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
// 14. Comment rows
//
// numpla-model reads each line up to its first `#` and discards the rest, so a
// row that starts with `#` is prose. The field keeps that prose byte for byte:
// it is the teaching material in every demo, and mangling it is what made the
// demo loader look broken.
// ---------------------------------------------------------------------------

/** A comment must survive `source` -> model -> `source` as the identity. */
function verbatim(text, why) {
  const m = new MathModel();
  m.source = text;
  eq((why || 'verbatim') + ' ' + JSON.stringify(text), m.source, text);
}

verbatim('#', 'a bare hash');
verbatim('# A PLUCKED STRING');
verbatim('##', 'a doubled hash');
verbatim('# ', 'hash and a space');
verbatim('#no space after the hash');
verbatim('# equation: k(x_{i+1} - 2x_i + x_{i-1}) is the curvature of the string');
verbatim('# bridge, so they never move and never appear as states — they show up');
verbatim('# At a = 0.2 the period is 2.0 s. At a = 3.0 it is 5.0 s. Same pendulum.');
verbatim('# gravity and length set the small-angle period, 2 pi sqrt(l/g).');
verbatim('#   leading, inner    and trailing spaces   ', 'spacing');
verbatim('#\t\ttabs are content too', 'tabs');
verbatim('# 100% "quoted", <angled>, back\\slash, $5 & more; 50/50 ^ ~ | @', 'punctuation');
verbatim('# sqrt sin cos pi xy k_1 x^2 1/2 -- none of this is mathematics', 'math words');
verbatim('# unicode: åäö λ → ∫ — ‘quotes’ …', 'unicode');
verbatim('# ### not a heading, just hashes ###', 'inner hashes');

{
  const m = new MathModel();
  m.source = '# a comment';
  ok('a comment row knows it is one', m.isComment());
  eq('every character is its own atom', m.root.length, '# a comment'.length);
  ok('and they are all text', m.root.every((a) => a.type === 'text'));
  ok('no math atom sneaked in', !m.root.some((a) => a.type === 'var'));
  ok('a comment row is not empty', !m.isEmpty());
}

{
  const m = new MathModel();
  m.source = "x' = -y";
  ok('a math row is not a comment', !m.isComment());
}

// --- typing `#` in and backspacing it out -----------------------------------

{
  const m = new MathModel();
  ok('an empty row starts as math', !m.isComment());
  m.type('#');
  ok('typing # on an empty row makes it a comment', m.isComment());
  eq('and the row is just the hash', m.source, '#');
  m.type(' A PLUCKED STRING');
  eq('the rest is taken verbatim', m.source, '# A PLUCKED STRING');
  ok('still a comment', m.isComment());
}

{
  // Spaces are meaningless in mathematics and meaningful in prose. The comment
  // tail is the one place the field keeps them.
  const m = new MathModel();
  m.type('#  two  spaces  everywhere  ');
  eq('spaces are kept inside a comment', m.source, '#  two  spaces  everywhere  ');
  const math = new MathModel();
  math.type('x  +  1');
  eq('and still dropped outside one', math.source, 'x + 1');
}

{
  const m = new MathModel();
  m.type('#');
  m.type('sqrt');
  eq('sqrt does not inflate inside a comment', m.source, '#sqrt');
  ok('no radical was built', !m.root.some((a) => a.type === 'sqrt'));
  m.type('1/2');
  eq('nor does a fraction', m.source, '#sqrt1/2');
  ok('no fraction was built', !m.root.some((a) => a.type === 'frac'));
  m.type('xy');
  eq('adjacent letters are not split', m.source, '#sqrt1/2xy');
  m.type('#');
  eq('a second hash is ordinary text', m.source, '#sqrt1/2xy#');
  ok('and the row is still one comment', m.isComment());
}

{
  const m = new MathModel();
  m.source = '# k = 2';
  m.home();
  m.right();                      // caret just past the hash
  m.backspace();                  // ... take the hash away
  ok('deleting the hash ends the comment', !m.isComment());
  eq('and what is left is read as mathematics', m.source, 'k = 2');
  eq('the caret stays where the hash was', m.st.index, 0);
  ok('it really is mathematics now', m.root[0].type === 'var');
}

{
  const m = new MathModel();
  m.source = '## note';
  m.home();
  m.right();
  m.backspace();
  eq('one hash off a doubled hash leaves a comment', m.source, '# note');
  ok('and it is still a comment row', m.isComment());
}

{
  const m = new MathModel();
  m.source = '#';
  m.end();
  m.backspace();
  eq('backspacing the only hash empties the row', m.source, '');
  ok('the row is empty and back to mathematics', m.isEmpty() && !m.isComment());
  m.type('1/2');
  eq('and behaves as a math row again', m.source, '(1)/(2)');
}

{
  // Forward delete over the hash dissolves the comment the same way.
  const m = new MathModel();
  m.source = '# k = 2';
  m.home();
  m.del();
  ok('delete over the hash ends the comment', !m.isComment());
  eq('leaving the mathematics behind', m.source, 'k = 2');
}

{
  const m = new MathModel();
  m.source = '# abc';
  m.end();
  m.backspace();
  eq('plain backspace deletes one character', m.source, '# ab');
  m.left();
  m.backspace();
  eq('and it deletes at the caret, not the end', m.source, '# b');
  ok('the row is still a comment', m.isComment());
}

// --- a `#` that is not at the start -----------------------------------------

{
  const m = new MathModel();
  m.source = "y' = x   # trailing comment";
  ok('a trailing comment does not make the row a comment row', !m.isComment());
  ok('the mathematics is still mathematics', m.root[0].type === 'var');
  eq('the row keeps both halves', m.source, "y' = x # trailing comment");
  const once = m.source;
  m.source = once;
  eq('and that is a fixed point', m.source, once);
  eq('the tail begins at the hash', m.root[tailStart(m.root)].ch, '#');
  eq('the comment text is untouched', m.root.slice(tailStart(m.root)).map((a) => a.ch).join(''),
    '# trailing comment');
}

{
  // Typing `#` mid-row must not silently convert what is already there.
  const m = new MathModel();
  m.source = 'x + 1';
  m.home();
  m.type('#');
  eq('a hash inside existing content is ignored', m.source, 'x + 1');
  ok('the row stays mathematics', !m.isComment());
  m.right();
  m.type('#');
  eq('still ignored one atom in', m.source, 'x + 1');
}

{
  const m = new MathModel();
  m.source = 'x + 1';
  m.end();
  m.type('# why');
  eq('at the end of the row it opens a trailing comment', m.source, 'x + 1 # why');
  ok('which is not a comment row', !m.isComment());
  m.type(' more');
  eq('and keeps taking prose', m.source, 'x + 1 # why more');
}

{
  const m = new MathModel();
  m.source = 'k = (1)/(2) # half';
  eq('a fraction survives beside a comment', m.source, 'k = (1)/(2) # half');
  ok('the fraction is real', m.root.some((a) => a.type === 'frac'));
  const st = newState(parseSource('k = (1)/(2) # half'));
  st.path = [[2, 'num']];
  st.index = 0;
  ok('typing # inside a structure does nothing', typeString(st, '#') === false);
}

// --- caret and arrows behave like a text field ------------------------------

{
  const st = newState(parseSource('# ab'));
  eq('a comment has one position per character boundary', st.root.length + 1, 5);
  let n = 0;
  while (moveRight(st)) n++;
  eq('right walks every character', n, 4);
  eq('and stops at the end', st.index, 4);
  n = 0;
  while (moveLeft(st)) n++;
  eq('left walks back over every character', n, 4);
  eq('and stops at the start', st.index, 0);
  ok('there is nothing to move up into', moveVert(st, -1) === false);
  ok('nor down', moveVert(st, 1) === false);
  ok('the caret never leaves the root list', st.path.length === 0);
}

// --- the real thing: every comment line in the demo gallery -----------------

{
  const lines = DEMOS.flatMap((d) => d.source.split('\n'));

  // The gallery deliberately carries no comments now — an example is read by
  // looking at it — so comment round-tripping is pinned with its own fixtures.
  // People still write comments in their own documents, and mangling one would
  // break the document, so this stays as thoroughly tested as it ever was.
  const comments = [
    '# a plucked string',
    '#',
    '## twice hashed',
    '#    leading spaces inside are kept',
    '# punctuation: k(x_{i+1} - 2x_i), 50% of it, "quoted"',
    '# unicode — em dash, theta, +/-',
    '# sin cos sqrt must not inflate here',
    '# trailing spaces are kept   ',
  ];
  ok('the demo gallery carries no comments',
    lines.filter((l) => l.trimStart().startsWith('#')).length === 0,
    'found ' + lines.filter((l) => l.trimStart().startsWith('#')).length);

  for (const line of comments) {
    const m = new MathModel();
    m.source = line;
    ok('demo comment survives ' + JSON.stringify(line), m.source === line,
      'got ' + JSON.stringify(m.source));
    ok('demo comment is a comment row ' + JSON.stringify(line), m.isComment());
  }

  // Every row of every demo - comment or mathematics - must be a fixed point,
  // because the shell round-trips each line through a field on every edit.
  for (const line of lines) {
    if (line.trim() === '') continue;
    const once = new MathModel(line).source;
    const twice = new MathModel(once).source;
    ok('demo row is stable ' + JSON.stringify(line), once === twice,
      JSON.stringify(once) + ' -> ' + JSON.stringify(twice));
  }

  // And a whole document, rebuilt row by row the way the shell does it.
  const doc = DEMOS[0].source.split('\n');
  const rebuilt = doc.map((l) => (l.trim() === '' ? l : new MathModel(l).source));
  eq('every comment line of the first demo is untouched',
    rebuilt.filter((l, i) => doc[i].startsWith('#') && l !== doc[i]).length, 0);
}

// --- latex ------------------------------------------------------------------

{
  eq('a comment becomes a \\text run',
    toLatex(parseSource('# A PLUCKED STRING')), '\\text{\\# A PLUCKED STRING}');
  eq('latex specials are escaped',
    toLatex(parseSource('# 50% of {a_b} & $c^2')),
    '\\text{\\# 50\\% of \\{a\\_b\\} \\& \\$c\\textasciicircum{}2}');
  eq('a backslash is escaped too',
    toLatex(parseSource('# back\\slash')), '\\text{\\# back\\textbackslash{}slash}');
  eq('a trailing comment rides after the mathematics',
    toLatex(parseSource('k = 2 # note')), 'k=2 \\text{\\# note}');
  eq('one run, not one command per character',
    (toLatex(parseSource('# abc')).match(/text/g) || []).length, 1);
}

// ---------------------------------------------------------------------------
// 15. Calls and coefficients
//
// `f(u)` is a call; `g (u)` is `g` times `u`, and the difference is decided by
// the whole document, not by the row (docs/wasm-api.md). The field is told the
// document's function names and mirrors the rule, because what `/` takes as its
// denominator depends on the answer: `-m x / d(x, y)` is a division by the
// distance when `d` is a function and something else entirely when it is not.
// ---------------------------------------------------------------------------

/** Find the first fraction anywhere in a tree. */
function firstFrac(list) {
  for (const a of list) {
    if (a.type === 'frac') return a;
    for (const k of slotKeys(a)) {
      const found = firstFrac(a[k]);
      if (found) return found;
    }
  }
  return null;
}

{
  const line = "x'' = -m x / d(x, y)";
  const asCall = new MathModel(line, ['d']);
  const asCoeff = new MathModel(line);

  eq('a declared function keeps its arguments in the denominator',
    asCall.source, "x'' = -(mx)/(d(x, y))");
  eq('an undeclared name is a coefficient, and the arguments stay outside',
    asCoeff.source, "x'' = -(mx)/(d)(x, y)");
  ok('the two readings are genuinely different documents',
    asCall.source !== asCoeff.source);

  eq('the call reading is a fixed point',
    new MathModel(asCall.source, ['d']).source, asCall.source);
  eq('the coefficient reading is a fixed point',
    new MathModel(asCoeff.source).source, asCoeff.source);

  eq('the denominator is the whole call',
    toSource(firstFrac(asCall.root).den), 'd(x, y)');
  eq('and just the name when it is a coefficient',
    toSource(firstFrac(asCoeff.root).den), 'd');
  eq('both numerators are the product before the slash',
    toSource(firstFrac(asCall.root).num), 'mx');

  // The other orbit row, and the helper definition itself.
  eq('the y row too',
    new MathModel("y'' = -m y / d(x, y)", ['d']).source, "y'' = -(my)/(d(x, y))");
  eq('the helper definition survives',
    new MathModel('d(p, q) = (p^2 + q^2)^1.5', ['d']).source,
    'd(p, q) = (p^(2) + q^(2))^(1.5)');
}

{
  // The same bug class for builtins: a function call is one primary, so the
  // parentheses belong to the denominator.
  eq('1/sin(x)', new MathModel('1/sin(x)').source, '(1)/(sin(x))');
  eq('1/abs(x + 1)', new MathModel('1/abs(x + 1)').source, '(1)/(abs(x + 1))');
  eq('1/sqrt(2)', new MathModel('1/sqrt(2)').source, '(1)/(sqrt(2))');
  eq('2/exp(-t)', new MathModel('2/exp(-t)').source, '(2)/(exp(-t))');
  eq('m/min(a, b)', new MathModel('m/min(a, b)').source, '(m)/(min(a, b))');
  // A bare function name applies to what follows: `1/sin x` is 1/sin(x).
  eq('1/sin x', new MathModel('1/sin x').source, '(1)/(sin x)');
  eq('1/sin x^2', new MathModel('1/sin x^2').source, '(1)/(sin x^(2))');
  for (const t of ['(1)/(sin(x))', '(1)/(sin x)', '(2)/(exp(-t))', '(1)/(sqrt(2))']) {
    eq('and it stays put: ' + t, new MathModel(t).source, t);
  }
}

{
  // `^` grabs a primary too, so it has the same question to answer.
  eq('x^f(2) with f declared', new MathModel('x^f(2)', ['f']).source, 'x^(f(2))');
  eq('x^g(2) with g undeclared', new MathModel('x^g(2)').source, 'x^(g)(2)');
  ok('the two differ',
    new MathModel('x^f(2)', ['f']).source !== new MathModel('x^f(2)').source);
  eq('call exponent is a fixed point',
    new MathModel('x^(f(2))', ['f']).source, 'x^(f(2))');
  eq('coefficient exponent is a fixed point',
    new MathModel('x^(g)(2)').source, 'x^(g)(2)');
  eq('x^sin(t)', new MathModel('x^sin(t)').source, 'x^(sin(t))');
  // The doc's own example: g (y - x)^3 scales a cubed difference.
  eq('a coefficient before a power', new MathModel('g(y - x)^3').source, 'g(y - x)^(3)');
  eq('a call before a power', new MathModel('f(y - x)^3', ['f']).source, 'f(y - x)^(3)');
}

{
  // A primed name followed by parentheses is always a call - that is how an
  // initial condition for a lowered velocity state is written.
  eq("1/x'(0)", new MathModel("1/x'(0)").source, "(1)/(x'(0))");
  eq("x'(0) = 0 still round-trips", new MathModel("x'(0) = 0").source, "x'(0) = 0");
  eq('x(0) = 1 is not affected', new MathModel('x(0) = 1').source, 'x(0) = 1');
}

{
  // Subscripted function names.
  eq('k_1(u) as a call', new MathModel('1/k_1(u)', ['k_1']).source, '(1)/(k_1(u))');
  eq('k_1(u) as a coefficient', new MathModel('1/k_1(u)').source, '(1)/(k_1)(u)');
  eq('braces in a supplied name are ignored',
    new MathModel('1/k_1(u)', ['k_{1}']).source, '(1)/(k_1(u))');
}

// --- the setFunctions API ---------------------------------------------------

{
  const m = new MathModel("x'' = -m x / d(x, y)");
  eq('it starts as a coefficient', m.source, "x'' = -(mx)/(d)(x, y)");
  ok('the function set arriving late re-reads the row', m.setFunctions(['d']));
  eq('and the row now divides by the call', m.source, "x'' = -(mx)/(d(x, y))");
  ok('setting the same names again changes nothing', m.setFunctions(['d']) === false);
  eq('the names are readable back', m.functions.join(','), 'd');
  ok('taking the function away re-reads it once more', m.setFunctions([]));
  eq('back to a coefficient', m.source, "x'' = -(mx)/(d)(x, y)");
}

{
  const m = new MathModel('k = 0.5');
  ok('a row with no calls is left alone', m.setFunctions(['d']) === false);
  eq('and keeps its source', m.source, 'k = 0.5');
}

{
  // Once the user has edited a row, the text on screen is what gets re-read -
  // the same text the parser sees.
  const m = new MathModel("x'' = -m x / d(x, y)");
  m.type('z');
  ok('an edited row is re-read from what it now says',
    m.setFunctions(['d']) === false);
  eq('which is exactly what is on screen', m.source, "x'' = -(mx)/(d)(x, y)z");
}

{
  const m = new MathModel('1/d(x)', ['d']);
  eq('the constructor takes the set too', m.source, '(1)/(d(x))');
  eq('normalising drops braces and spaces',
    Array.from(normaliseFunctions([' d ', 'k_{1}', ''])).join(','), 'd,k_1');
}

// --- the document-level rule the shell needs --------------------------------

{
  const doc = [
    '# a comment mentioning f(x) = x',
    'd(p, q) = (p^2 + q^2)^1.5',
    'k_1(a, b) = a + b',
    'h(x) = 1 # trailing comment',
    'x(0) = 1',
    "x'(0) = 2",
    'y = f(x)',
    'g(2) = 3',
  ].join('\n');
  eq('only real definitions count', functionNamesIn(doc).join(','), 'd,k_1,h');
  eq('an empty document has none', functionNamesIn('').length, 0);
  eq('the orbit demo defines exactly one function',
    functionNamesIn(DEMOS.find((d) => d.id === 'orbit').source).join(','), 'd');
  for (const demo of DEMOS) {
    if (demo.id === 'orbit') continue;
    eq('no accidental functions in ' + demo.id, functionNamesIn(demo.source).length, 0);
  }
}

// --- every demo still describes the same system after the field has seen it --

/** Rebuild a document the way the shell does: one field per line. */
function reflow(source, funcs) {
  return source
    .split('\n')
    .map((line) => (line.trim() === '' ? line : new MathModel(line, funcs).source))
    .join('\n');
}

{
  const orbit = DEMOS.find((d) => d.id === 'orbit');
  const funcs = functionNamesIn(orbit.source);
  const rebuilt = reflow(orbit.source, funcs);
  ok('the orbit rows keep their calls',
    rebuilt.includes("x'' = -(mx)/(d(x, y))") && rebuilt.includes("y'' = -(my)/(d(x, y))"),
    rebuilt.split('\n').filter((l) => l.includes('d(')).join(' | '));
  ok('and nothing is left dangling outside a denominator',
    !rebuilt.includes('/(d)('));
  eq('the rebuilt document is a fixed point', reflow(rebuilt, funcs), rebuilt);
  eq('every comment line is still untouched',
    orbit.source.split('\n').filter((l, i) => l.startsWith('#')
      && rebuilt.split('\n')[i] !== l).length, 0);
}

{
  // The real check: hand the rebuilt documents to the actual parser and demand
  // zero errors. Skipped, loudly, if the WASM build is not there.
  let wasm = null;
  try {
    const fs = await import('node:fs');
    wasm = await import('./pkg/numpla_wasm.js');
    wasm.initSync({
      module: fs.readFileSync(new URL('./pkg/numpla_wasm_bg.wasm', import.meta.url)),
    });
  } catch (e) {
    wasm = null;
  }

  if (!wasm) {
    console.warn('  note: no WASM build found, the semantic demo check was skipped');
  } else {
    const compile = (src) => JSON.parse(new wasm.Model().set_source(src));
    for (const demo of DEMOS) {
      const funcs = functionNamesIn(demo.source);
      const before = compile(demo.source);
      const after = compile(reflow(demo.source, funcs));
      const errs = after.issues.filter((i) => i.severity === 'error');
      ok('demo ' + demo.id + ' still compiles after the field has read it',
        errs.length === 0, JSON.stringify(errs.slice(0, 3)));
      eq('demo ' + demo.id + ' keeps its state vector',
        after.states.join(','), before.states.join(','));
      eq('demo ' + demo.id + ' keeps its parameters',
        after.params.join(','), before.params.join(','));
      eq('demo ' + demo.id + ' gains no diagnostics',
        after.issues.length, before.issues.length);
    }

    // And prove the function set is load-bearing: without it, orbit breaks in
    // exactly the way it broke in the shell.
    const orbit = DEMOS.find((d) => d.id === 'orbit');
    const naive = compile(reflow(orbit.source, []));
    ok('without the function set the orbit really does break',
      naive.issues.some((i) => i.severity === 'error'));
    ok('and it is the missing helper that breaks it',
      naive.issues.some((i) => /d is not defined/.test(i.message)),
      JSON.stringify(naive.issues.map((i) => i.message)));
  }
}

// ---------------------------------------------------------------------------
// 16. Tab completion
//
// Type a prefix, press Tab. One match completes; several fill in as much as the
// candidates agree on and then, when that adds nothing, offer a menu. Nothing
// completes to something the engine does not have - there is no `diff`.
// ---------------------------------------------------------------------------

/** Type `text` into a fresh row, press Tab, and report what happened. */
function tabbed(text, names) {
  const m = new MathModel();
  if (names) m.setDocumentNames(names);
  m.type(text);
  const r = m.tab();
  return { model: m, action: r.action, source: m.source, cands: r.candidates };
}

const labelsOf = (r) => (r.cands || r.candidates || []).map((c) => c.label).join(' | ');

// --- one match completes ----------------------------------------------------

{
  const cases = [
    ['sq', 'sqrt()'], ['sqr', 'sqrt()'], ['ab', 'abs()'], ['fl', 'floor()'],
    ['ce', 'ceil()'], ['ro', 'round()'], ['ex', 'exp()'], ['mo', 'mod(, )'],
    ['wh', 'white()'], ['sm', 'smooth()'], ['te', 'telegraph()'],
    ['bl', 'blue()'], ['br', 'brown()'], ['pin', 'pink()'],
    ['arcs', 'arcsin()'], ['arcc', 'arccos()'], ['arct', 'arctan()'],
  ];
  for (const [prefix, want] of cases) {
    const r = tabbed(prefix);
    eq('Tab on ' + JSON.stringify(prefix) + ' completes', r.source, want);
    eq('and reports it: ' + prefix, r.action, 'applied');
  }
}

{
  // Every builtin the engine has is reachable, and completes to itself.
  for (const name of FUNCS) {
    const m = new MathModel();
    m.st.root = Array.from(name.slice(0, -1)).map((c) => A.var(c));
    m.st.index = m.st.root.length;
    const before = m.st.root.length;
    const r = m.tab();
    ok('a prefix of ' + name + ' completes to something', r.action !== 'none');
    ok('and it offers ' + name,
      r.action === 'applied' || r.candidates.some((c) => c.word === name),
      labelsOf(r));
    ok('the prefix was consumed for ' + name,
      r.action !== 'applied' || m.st.root.length < before + name.length);
  }
  for (const name of CONSTS) {
    const m = new MathModel();
    m.type(name.slice(0, 1));
    const r = m.tab();
    ok('the constant ' + name + ' is offered',
      r.candidates.some((c) => c.word === name)
      || (r.action === 'applied' && m.source === name), labelsOf({ cands: r.candidates }));
  }
}

// --- structure, not letters -------------------------------------------------

{
  const r = tabbed('sq');
  eq('sqrt completes to a real radical', r.model.root[0].type, 'sqrt');
  ok('and not to four letters', !r.model.root.some((a) => a.type === 'var'));
  r.model.type('2');
  eq('with the caret inside it', r.model.source, 'sqrt(2)');
}

{
  const r = tabbed('wh');
  eq('a noise call is a function atom', r.model.root[0].type, 'func');
  eq('with its parentheses', r.model.root[1].type, 'group');
}

// --- caret placement --------------------------------------------------------

{
  const after = (prefix, typing) => {
    const r = tabbed(prefix);
    r.model.type(typing);
    return r.model.source;
  };
  eq('sqrt leaves the caret inside the radical', after('sq', 'x'), 'sqrt(x)');
  eq('abs leaves it inside the call', after('ab', 'x'), 'abs(x)');
  eq('min leaves it in the first argument', after('mi', 'a'), 'min(a, )');
  eq('max too', after('ma', 'a'), 'max(a, )');
  eq('mod too', after('mo', 'a'), 'mod(a, )');
  eq('log leaves it on the only required argument', after('lo', 'x'), 'log(x)');
  eq('a noise call leaves it on t', after('sm', 't'), 'smooth(t)');
  // rand() usually wants no argument at all, so the caret lands after the call.
  eq('rand leaves the caret after the call', after('randn', '+1'), 'randn() + 1');
  eq('and the argument is still reachable', (() => {
    const m = new MathModel();
    m.type('randn');
    m.left();
    m.type('7');
    return m.source;
  })(), 'randn(7)');
}

{
  // The second argument of a two-argument call is one arrow away, and typing a
  // comma steps over the one that is already there rather than doubling it.
  const m = new MathModel();
  m.type('mi');
  m.tab();
  m.type('a');
  m.type(',');
  m.type('b');
  eq('a two-argument call fills in naturally', m.source, 'min(a, b)');
}

// --- several matches --------------------------------------------------------

{
  const r = tabbed('ar');
  eq('a shared prefix is filled in first', r.action, 'extended');
  eq('as far as the candidates agree', r.source, 'arc');
  eq('and all three are still on offer', r.cands.length, 3);
  const again = r.model.tab();
  eq('a second Tab has nothing left to fill in', again.action, 'menu');
  eq('so it offers the three', again.candidates.map((c) => c.word).join(','),
    'arccos,arcsin,arctan');
}

{
  // When the shared prefix is itself a name, filling it in would look finished.
  const r = tabbed('si');
  eq('so the menu opens instead', r.action, 'menu');
  eq('with nothing typed for the user', r.source, 'si');
  eq('shortest first, then alphabetical', r.cands.map((c) => c.word).join(','),
    'sin,sign,sinh');
  const rr = tabbed('ra');
  eq('rand and randn behave the same way', rr.action, 'menu');
  eq('and both are offered', rr.cands.map((c) => c.word).join(','), 'rand,randn');
  eq('nothing was typed', rr.source, 'ra');
}

{
  const r = tabbed('c');
  ok('a one-letter prefix still offers what starts with it',
    r.cands.every((c) => !c.word || c.word.startsWith('c')), labelsOf(r));
  ok('including cos and ceil',
    r.cands.some((c) => c.word === 'cos') && r.cands.some((c) => c.word === 'ceil'));
}

// --- nothing matches --------------------------------------------------------

{
  for (const prefix of ['zz', 'qq', 'diff', 'derivative', 'integrate', 'solve']) {
    const r = tabbed(prefix);
    eq('Tab on ' + JSON.stringify(prefix) + ' does nothing', r.action, 'none');
    eq('and leaves the row alone', r.source, new MathModel(prefix).source);
  }
  ok('there is no diff to complete',
    !FUNCS.includes('diff') && !CONSTS.includes('diff'));
}

{
  const m = new MathModel();
  const r = m.tab();
  eq('Tab on an empty row does nothing', r.action, 'none');
  eq('and Tab mid-expression with no prefix does nothing',
    (() => { const n = new MathModel('1 + 2'); return n.tab().action; })(), 'none');
}

// --- the names really are the engine's --------------------------------------

{
  // The builtin list is the lexer's list; the noise family is in it because the
  // lexer reserves those names too (crates/numpla-expr/src/lexer.rs).
  for (const n of ['sin', 'cos', 'tan', 'sqrt', 'exp', 'ln', 'log', 'abs', 'min',
    'max', 'floor', 'ceil', 'round', 'sign', 'mod', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'white', 'pink', 'brown', 'blue', 'smooth',
    'telegraph', 'rand', 'randn']) {
    ok('the field knows ' + n, FUNCS.includes(n));
  }
  for (const n of ['pi', 'tau', 'inf']) ok('the field knows ' + n, CONSTS.includes(n));
  eq('two-argument builtins', ['min', 'max', 'mod'].map((n) => arityOf(n).join('-')).join(' '),
    '2-2 2-2 2-2');
  eq('log takes an optional base', arityOf('log').join('-'), '1-2');
  eq('noise takes an optional rate and seed', arityOf('smooth').join('-'), '1-3');
  eq('rand takes an optional seed', arityOf('rand').join('-'), '0-1');
  eq('everything else takes one', arityOf('sin').join('-'), '1-1');
}

// --- a name that inflated can still grow ------------------------------------

{
  // `sin` inflates the moment it is typed, so `sinh` has to be able to grow out
  // of it - likewise `pink` out of `pi` and `randn` out of `rand`.
  const typed = (t) => { const m = new MathModel(); m.type(t); return m.source; };
  eq('sinh is typeable', typed('sinh'), 'sinh()');
  eq('cosh is typeable', typed('cosh'), 'cosh()');
  eq('tanh is typeable', typed('tanh'), 'tanh()');
  eq('pink is typeable', typed('pink'), 'pink()');
  eq('randn is typeable', typed('randn'), 'randn()');
  eq('and the short names still inflate', typed('sin'), 'sin()');
  eq('pi still inflates', typed('pi'), 'pi');
  eq('rand still inflates', typed('rand'), 'rand()');
  eq('pi times t is still a product', typed('pit'), 'pit');
  eq('sin of x is still sin of x', typed('sinx'), 'sin(x)');
  eq('a full noise call types straight through', typed('smootht'), 'smooth(t)');
  eq('and so does a nested one', typed('sqrtpink2'), 'sqrt(pink(2))');
}

// --- row kinds --------------------------------------------------------------

{
  const r = tabbed('x');
  eq('a lone identifier offers the row kinds', r.action, 'menu');
  eq('all four of them',
    r.cands.map((c) => c.label).join(' | '), "x' = | x'' = | x(0) = | x(u) =");
  ok('and nothing else', r.cands.every((c) => c.kind === 'row'));
}

{
  /** Pick a candidate by the label the menu shows, then apply it. */
  const pick = (prefix, label, typing) => {
    const r = tabbed(prefix);
    const chosen = r.cands.find((c) => c.label === label);
    ok('there is a candidate labelled ' + label, !!chosen, labelsOf(r));
    if (!chosen) return null;
    chosen.apply(r.model.st);
    if (typing) r.model.type(typing);
    return r.model.source;
  };
  eq('first-order ODE row, caret after the equals',
    pick('x', "x' =", '-y'), "x' = -y");
  eq('second-order ODE row', pick('x', "x'' =", '-x'), "x'' = -x");
  eq('initial condition', pick('x', 'x(0) =', '1'), 'x(0) = 1');
  eq('function definition, caret on the argument',
    pick('f', 'f(u) =', 'u'), 'f(u) = ');
  eq('and then the body is one arrow away', (() => {
    const r = tabbed('f');
    r.cands.find((c) => c.label === 'f(u) =').apply(r.model.st);
    r.model.type('u');
    r.model.end();
    r.model.type('2u');
    return r.model.source;
  })(), 'f(u) = 2u');
}

{
  const r = tabbed("x'");
  eq('a primed identifier offers what fits it',
    r.cands.map((c) => c.label).join(' | '), "x' = | x'(0) =");
  const sub = new MathModel('k_1');
  const s = { cands: sub.tab().candidates };
  ok('so does a subscripted one', s.cands.some((c) => c.label === "k_1' ="),
    labelsOf(s));
}

{
  const m = new MathModel('1 + x');
  m.end();
  const r = m.tab();
  eq('an identifier inside an expression is not a row kind', r.action, 'none');
  const n = new MathModel('x');
  n.home();
  eq('nor is one with the caret before it', n.tab().action, 'none');
}

// --- the comment snippet ----------------------------------------------------

{
  const r = tabbed('com');
  eq('com completes to a comment row', r.source, '# ');
  ok('and the row really is a comment', r.model.isComment());
  r.model.type('like this');
  eq('with the caret ready for prose', r.model.source, '# like this');
  ok('co offers it alongside the cosines',
    tabbed('co').cands.some((c) => c.label === '# comment'));
  ok('c alone does not', !tabbed('c').cands.some((c) => c.label === '# comment'));
  ok('and neither does a half-written expression',
    !(() => { const m = new MathModel('1 + com'); m.end(); return m.tab().candidates; })()
      .some((c) => c.label === '# comment'));
}

// --- document names ---------------------------------------------------------

{
  const names = { functions: ['d'], params: ['k_1', 'm'], states: ['theta'] };
  const m = new MathModel();
  m.setDocumentNames(names);
  eq('the names come back', m.documentNames.functions.join(','), 'd');
  eq('parameters too', m.documentNames.params.join(','), 'k_1,m');

  const r = tabbed('d', names);
  ok('a document function is offered as a call',
    r.cands.some((c) => c.word === 'd' && c.label === 'd(x)'), labelsOf(r));
  const call = r.cands.find((c) => c.word === 'd');
  call.apply(r.model.st);
  r.model.type('x');
  eq('and completes with its parentheses', r.model.source, 'd(x)');

  const p = tabbed('k', names);
  ok('a parameter completes to its full name',
    p.cands.some((c) => c.word === 'k_1'), labelsOf(p));
  const t = tabbed('t', names);
  ok('a state does too', t.cands.some((c) => c.word === 'theta'), labelsOf(t));
}

{
  // setDocumentNames carries the function set, since it is the same fact.
  const m = new MathModel("x'' = -m x / d(x, y)");
  eq('it starts as a coefficient', m.source, "x'' = -(mx)/(d)(x, y)");
  ok('setDocumentNames re-reads the row', m.setDocumentNames({ functions: ['d'] }));
  eq('and the call is restored', m.source, "x'' = -(mx)/(d(x, y))");
  eq('the parser set agrees', m.functions.join(','), 'd');

  const n = new MathModel("x'' = -m x / d(x, y)", ['d']);
  ok('omitting functions leaves the parser alone',
    n.setDocumentNames({ params: ['k'] }) === false);
  eq('so the row keeps its call', n.source, "x'' = -(mx)/(d(x, y))");
  eq('and the parser set is untouched', n.functions.join(','), 'd');
}

{
  // A name that is no longer than the prefix would complete to itself, so it is
  // not offered - only the row kinds are, because the row is a lone identifier.
  const m = new MathModel();
  m.setDocumentNames({ params: ['k'] });
  m.type('k');
  const r = m.completions();
  ok('a name no longer than the prefix is not a completion',
    !r.candidates.some((c) => c.word === 'k'), labelsOf(r));
  ok('only the row kinds are left', r.candidates.every((c) => c.kind === 'row'));

  const n = new MathModel('1 + k');
  n.setDocumentNames({ params: ['k'] });
  n.end();
  eq('and mid-expression there is nothing at all', n.tab().action, 'none');
}

// --- completionsFor is a pure question --------------------------------------

{
  const m = new MathModel();
  m.type('sq');
  const before = m.source;
  const list = m.completions();
  eq('asking does not change the row', m.source, before);
  eq('the prefix is reported', list.prefix, 'sq');
  eq('and where it starts', list.start, 0);
  eq('with one candidate', list.candidates.length, 1);
  eq('carrying a label', list.candidates[0].label, 'sqrt(x)');
  eq('and a hint', list.candidates[0].hint, 'square root');
  eq('and its kind', list.candidates[0].kind, 'builtin');
}

{
  eq('the common prefix of nothing is nothing', commonPrefix([]), '');
  eq('of one word, itself', commonPrefix(['sin']), 'sin');
  eq('of a family, the shared head', commonPrefix(['arcsin', 'arccos', 'arctan']), 'arc');
  eq('of strangers, nothing', commonPrefix(['sin', 'cos']), '');
}

// --- completion inside structures -------------------------------------------

{
  const m = new MathModel();
  m.type('1/sq');
  eq('completion works inside a denominator', m.tab().action, 'applied');
  m.type('2');
  eq('and builds there', m.source, '(1)/(sqrt(2))');
}

{
  const m = new MathModel();
  m.type('#');
  m.type('sq');
  eq('Tab does not complete inside a comment', m.tab().action, 'none');
  eq('the prose is untouched', m.source, '#sq');
}

{
  const m = new MathModel();
  m.type('k_');
  m.type('m');
  eq('nor inside a subscript', m.tab().action, 'none');
  eq('the subscript is a label', m.source, 'k_m');
}

// ---------------------------------------------------------------------------
// 17. The rendering half, over a ~40-line DOM shim
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
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
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
  body: new ShimEl('body'),
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
// 18. Comment rows, rendered
// ---------------------------------------------------------------------------

{
  const line = '# A string is a chain of little masses, each one pulled toward';
  const f = new MathField(new ShimEl('div'), { value: line });
  ok('a comment row is flagged for styling', f.el.classList.contains('is-comment'));
  ok('the field agrees', f.isComment());
  eq('it renders the line character for character', f.el.text(), line);
  const cls = f.el.classes().join(' ');
  ok('as prose spans', cls.includes('mf-text'));
  ok('with the hash marked', cls.includes('mf-text--hash'));
  ok('and no italic variables anywhere', !cls.includes('mf-var'));
  ok('and no math structures', !/mf-frac|mf-sqrt|mf-sup/.test(cls));
  eq('every character keeps a caret position', f._positions.length, line.length + 1);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  ok('an empty row is not a comment', !f.el.classList.contains('is-comment'));
  press(f, '#');
  ok('typing # converts the row', f.el.classList.contains('is-comment'));
  for (const ch of ' tension: this is the pitch.') press(f, ch);
  eq('and the prose arrives verbatim', f.source, '# tension: this is the pitch.');
  eq('rendered exactly as typed', f.el.text(), '# tension: this is the pitch.');

  press(f, 'Home');
  press(f, 'ArrowRight');
  press(f, 'Backspace');
  ok('backspacing the hash converts it back to mathematics',
    !f.el.classList.contains('is-comment'));
  ok('the field agrees', !f.isComment());
  f.destroy();
}

{
  // A comment row is a text field: clicking still lands on a valid position and
  // the diagnostic styling still applies to it.
  const f = new MathField(new ShimEl('div'), { value: '# note' });
  f.focus();
  eq('one caret is painted',
    f.el.classes().filter((c) => c.includes('mf-pos--caret')).length, 1);
  f.el.fire('mousedown', { clientX: 0, clientY: 0, preventDefault() {} });
  ok('a click lands somewhere valid', f.model.st.index >= 0);
  f.setDiagnostic('pending', 'nothing to solve here');
  ok('diagnostics still apply', f.el.classList.contains('is-pending'));
  f.destroy();
}

{
  // The bug that started this: a whole document, one field per line. The demo
  // gallery no longer carries comments, so the commented rows are supplied
  // here — a sharper fixture anyway, since it mixes prose and mathematics in
  // one document on purpose.
  const doc = [
    '# a damped oscillator',
    'k = 0.4',
    "x'' = -x - k x'",
    '# released from rest',
    'x(0) = 1',
    "x'(0) = 0",
  ].concat(DEMOS[0].source.split('\n'));
  const out = doc.map((line) => {
    const f = new MathField(new ShimEl('div'), { value: line });
    const src = f.source;
    f.destroy();
    return src;
  });
  const mangled = doc.filter((line, i) => line.startsWith('#') && out[i] !== line);
  eq('no comment line is mangled by the field', mangled.length, 0,
    JSON.stringify(mangled.slice(0, 3)));
  ok('every comment in the document survives the field',
    out.filter((l) => l.startsWith('#')).length ===
      doc.filter((l) => l.startsWith('#')).length);
}

// ---------------------------------------------------------------------------
// 19. The function set, through the field
// ---------------------------------------------------------------------------

{
  const line = "x'' = -m x / d(x, y)";
  const f = new MathField(new ShimEl('div'), { value: line, functions: ['d'] });
  eq('the constructor option reaches the parser', f.source, "x'' = -(mx)/(d(x, y))");
  eq('and the field reports the set back', f.functions.join(','), 'd');
  ok('the denominator renders as one fraction',
    f.el.classes().join(' ').includes('mf-frac'));
  f.destroy();

  const g = new MathField(new ShimEl('div'), { value: line });
  eq('without it the row reads as a coefficient', g.source, "x'' = -(mx)/(d)(x, y)");
  ok('telling it later re-reads the row', g.setFunctions(['d']));
  eq('and fixes the row', g.source, "x'' = -(mx)/(d(x, y))");
  ok('a second identical call does nothing', g.setFunctions(['d']) === false);
  g.destroy();

  let changes = 0;
  const h = new MathField(new ShimEl('div'), {
    value: line,
    onChange: () => changes++,
  });
  h.setFunctions(['d']);
  eq('setFunctions does not echo onChange - the shell made the change',
    changes, 0);
  h.destroy();
}

// ---------------------------------------------------------------------------
// 20. Tab completion, through the field
// ---------------------------------------------------------------------------

/** Press Tab, and report whether the field consumed the key. */
function pressTab(f, shift) {
  let prevented = false;
  f.el.fire('keydown', {
    key: 'Tab',
    shiftKey: !!shift,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() { prevented = true; },
  });
  return prevented;
}

const menuOf = () => document.body.children[document.body.children.length - 1];
const selectedIn = (menu) => menu.children.findIndex((c) => c.classes().join(' ').includes('is-selected'));

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'sq') press(f, ch);
  ok('Tab consumes the key when it completes', pressTab(f));
  eq('and completes', f.source, 'sqrt()');
  ok('with no menu', !f.menuOpen);
  eq('the body is left clean', document.body.children.length, 0);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'si') press(f, ch);
  ok('Tab consumes the key when it opens a menu', pressTab(f));
  ok('the menu is open', f.menuOpen);
  eq('and is in the document', document.body.children.length, 1);

  const menu = menuOf();
  eq('with one item per candidate', menu.children.length, 3);
  eq('the first is selected', selectedIn(menu), 0);
  ok('items carry the signature', menu.text().includes('sin(x)'));
  ok('and the hint', menu.text().includes('sine'));

  press(f, 'ArrowDown');
  eq('arrow down moves the selection', selectedIn(menuOf()), 1);
  press(f, 'ArrowUp');
  eq('arrow up moves it back', selectedIn(menuOf()), 0);
  press(f, 'ArrowUp');
  eq('and it wraps', selectedIn(menuOf()), 2);

  pressTab(f);
  eq('Tab cycles forward', selectedIn(menuOf()), 0);
  pressTab(f, true);
  eq('shift+Tab cycles back', selectedIn(menuOf()), 2);

  press(f, 'Enter');
  ok('Enter accepts and closes', !f.menuOpen);
  eq('the chosen completion is inserted', f.source, 'sinh()');
  eq('and the menu is gone from the document', document.body.children.length, 0);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  let entered = 0;
  f.opts.onEnter = () => { entered += 1; };
  for (const ch of 'si') press(f, ch);
  pressTab(f);
  press(f, 'Enter');
  eq('Enter into a menu does not also submit the row', entered, 0);
  press(f, 'Enter');
  eq('but the next one does', entered, 1);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'si') press(f, ch);
  pressTab(f);
  press(f, 'Escape');
  ok('Escape dismisses the menu', !f.menuOpen);
  eq('and leaves the row untouched', f.source, 'si');
  eq('the document is clean', document.body.children.length, 0);
  ok('the field still has focus', f.focused);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'si') press(f, ch);
  pressTab(f);
  press(f, 'n');
  ok('typing dismisses the menu', !f.menuOpen);
  eq('and the key is not swallowed', f.source, 'sin()');
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'si') press(f, ch);
  pressTab(f);
  f.el.fire('mousedown', { clientX: 0, clientY: 0, preventDefault() {} });
  ok('clicking in the field dismisses the menu', !f.menuOpen);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'si') press(f, ch);
  pressTab(f);
  const item = menuOf().children[2];
  item.fire('mousedown', { preventDefault() {} });
  eq('clicking an item completes it', f.source, 'sinh()');
  ok('and closes the menu', !f.menuOpen);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'si') press(f, ch);
  pressTab(f);
  f.blur();
  ok('blur dismisses the menu', !f.menuOpen);
  eq('nothing is left behind', document.body.children.length, 0);
  f.destroy();
}

{
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  for (const ch of 'si') press(f, ch);
  pressTab(f);
  f.destroy();
  eq('destroy takes the menu with it', document.body.children.length, 0);
}

{
  // A Tab that completes nothing belongs to whoever moves focus.
  const f = new MathField(new ShimEl('div'), { value: '' });
  f.focus();
  ok('Tab on an empty row is not consumed', pressTab(f) === false);
  for (const ch of 'zz') press(f, ch);
  ok('nor is Tab on a prefix that matches nothing', pressTab(f) === false);
  eq('and the row is unchanged', f.source, 'zz');
  ok('shift+Tab never completes', pressTab(f, true) === false);
  f.destroy();
}

{
  let changes = 0;
  const f = new MathField(new ShimEl('div'), { value: '', onChange: () => { changes += 1; } });
  f.focus();
  for (const ch of 'sq') press(f, ch);
  const before = changes;
  pressTab(f);
  eq('a completion is a change like any other', changes, before + 1);
  f.destroy();
}

{
  // Document names reach completion through the field.
  const f = new MathField(new ShimEl('div'), {
    value: '',
    documentNames: { functions: ['d'], params: ['k_1'], states: [] },
  });
  f.focus();
  eq('the field reports them back', f.documentNames.functions.join(','), 'd');
  for (const ch of 'k') press(f, ch);
  const labels = f.completions().candidates.map((c) => c.label);
  ok('a document parameter is offered', labels.includes('k_1'), labels.join(' | '));
  f.destroy();

  const g = new MathField(new ShimEl('div'), { value: "x'' = -m x / d(x, y)" });
  ok('setDocumentNames re-reads the row through the field',
    g.setDocumentNames({ functions: ['d'] }));
  eq('and fixes the call', g.source, "x'' = -(mx)/(d(x, y))");
  g.destroy();
}

// ---------------------------------------------------------------------------

console.log((failed ? 'FAILED  ' : 'ok  ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
