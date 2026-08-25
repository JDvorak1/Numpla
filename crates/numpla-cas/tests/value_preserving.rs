//! The test the CAS exists to pass.
//!
//! **Every rewrite preserves value.** A simplifier that is merely plausible is
//! worse than none, because the person reading the answer cannot tell when it
//! lied — so this file is not a suite of examples, it is the specification. A
//! corpus of expressions is evaluated before and after each rewrite at many
//! pseudo-random points, and any disagreement fails the build.
//!
//! Seven properties, over one corpus:
//!
//! 1. `simplify` does not change the value.
//! 2. `expand` does not change the value.
//! 3. `factor` does not change the value.
//! 4. everything printed is Numpla source that parses, prints identically the
//!    second time round, and still has the same value — a result you cannot
//!    paste back into your document is not a result.
//! 5. `diff` agrees with a high-order numerical derivative.
//! 6. **every candidate `equal` returns really equals the input.** An "equal"
//!    list containing something unequal is worse than no list, so this is the
//!    property the whole feature rests on. Candidates that carry a
//!    [`numpla_cas::Condition`] are checked at the sample points where that
//!    condition holds and skipped elsewhere — which is what makes a conditional
//!    identity honest rather than merely hedged. Candidates that are numeric
//!    identifications are checked against the value they claim to match.
//! 7. **every root `solve` returns satisfies the equation**, symbolically where
//!    the algebra closes and numerically where it does not, and the number of
//!    roots is what it should be wherever that is known.
//!
//! # Sampling, domains, and why points get skipped
//!
//! Random points are drawn per case from a domain the case declares, because
//! `ln(x)` and `arcsin(x)` are not functions of all of the reals and testing
//! them outside their domain would compare NaN with NaN and prove nothing.
//! Beyond that, a point is skipped when the input is not finite there — and
//! "the input" means every subexpression of it, not just the whole. That is not
//! a way of hiding failures, it is the precise statement of what the two
//! rewrites this CAS knowingly makes are claimed to be right about: `0 * u -> 0`
//! and cancelling `u/u -> 1` both differ from the input exactly where `u` is
//! not finite, and an infinity can hide *inside* an expression whose overall
//! value is perfectly ordinary — `max(0 * ln(0), -8)` is `-8` because `max`
//! discards the NaN, while the simplified `max(0, -8)` is `0`. Testing only the
//! top-level value would have called that a lie about a value; testing every
//! node calls it what it is, a point where the input has no finite meaning.
//! Where the input *is* finite throughout, the output must be finite and equal.
//!
//! # The numerical derivative
//!
//! A **fourth-order central difference** —
//! `(-f(x+2h) + 8f(x+h) - 8f(x-h) + f(x-2h)) / 12h` — evaluated at
//! `h = 1e-3 * max(1, |x|)` and again at `2h`, then Richardson-extrapolated to
//! sixth order.
//!
//! Complex-step differentiation would be more accurate and is the usual advice,
//! but it needs an evaluator over the complex numbers and `numpla-expr` has one
//! over `f64`; writing a second evaluator in order to test the first would be
//! testing the wrong thing. So: a five-point stencil, whose truncation error is
//! `O(h^4)` — about `1e-12` on a well-scaled function — against a roundoff floor
//! of `eps|f|/h`, about `2e-13`. Both sit six orders below the `1e-6` tolerance,
//! which is loose enough never to fail on arithmetic and far tighter than any
//! structural mistake: a dropped chain-rule factor, a wrong sign or a `cos`
//! where a `-sin` belongs all miss by a factor, not by a decimal.
//!
//! "Well-scaled" is doing work in that sentence, and the pair of step sizes is
//! how it is earned rather than assumed: near a pole the fourth-order error
//! reaches the tolerance itself (`d/dy` of `1/y` at `y = 0.04` is only accurate
//! to `1e-6`), so the two estimates are combined into a sixth-order one and
//! *their difference* is used as an error bar. A point where that error bar is
//! large is skipped: a pole or a corner sits inside the stencil, and there is
//! no derivative there to be right about.

use numpla_cas::{diff, expand, factor, simplify, to_source, FormKind, RootCheck};
use numpla_expr::{parse, BinOp, Env, Expr, Stmt, Value};

// ---- the corpus ---------------------------------------------------------

/// Where a case's variables may be sampled from.
#[derive(Clone, Copy, PartialEq)]
enum Domain {
    /// All of the reals — well, `[-3, 3]`.
    Real,
    /// Strictly positive, `[0.5, 4]`. `ln`, `sqrt`, `log` and `x^y` are only
    /// real-valued here, and comparing NaN with NaN proves nothing.
    Positive,
    /// `[-0.85, 0.85]`, inside the domain of `arcsin` and `arccos` with room
    /// for the derivative stencil to stay there too.
    Unit,
}

const CORPUS: &[(&str, Domain)] = &[
    // --- identities, zero laws, like terms ---
    ("0", Domain::Real),
    ("x", Domain::Real),
    ("x + 0", Domain::Real),
    ("0 + x", Domain::Real),
    ("1 * x", Domain::Real),
    ("x * 1", Domain::Real),
    ("x - x", Domain::Real),
    ("x + x", Domain::Real),
    ("2x + 3x", Domain::Real),
    ("2x + 1 - x - 1", Domain::Real),
    ("x*x", Domain::Real),
    ("x^2 * x^3", Domain::Real),
    ("x^2/x", Domain::Real),
    ("x*y/x", Domain::Real),
    ("x + y - x", Domain::Real),
    ("x^3 - x^3", Domain::Real),
    ("0 * x + y", Domain::Real),
    ("2sin(x) + 3sin(x)", Domain::Real),
    // --- arithmetic folding ---
    ("2 + 3*4", Domain::Real),
    ("2^10", Domain::Real),
    ("(1 + 2)/4", Domain::Real),
    ("2/3 * 3", Domain::Real),
    ("x/2", Domain::Real),
    ("x/2 + x/2", Domain::Real),
    ("4x/2", Domain::Real),
    ("x/3", Domain::Real),
    ("2 - 5", Domain::Real),
    ("-2 * -3", Domain::Real),
    // --- distribution ---
    ("2(x + 3)", Domain::Real),
    ("2(x + y)", Domain::Real),
    ("x*(y + z)", Domain::Real),
    ("(x + 1)(x - 1)", Domain::Real),
    ("(x + 1)^2", Domain::Real),
    ("(x + 1)^3", Domain::Real),
    ("(x + y)^2", Domain::Real),
    ("(x + y)^4", Domain::Real),
    ("(x - y)(x + y)", Domain::Real),
    ("(x + y)(y + z)", Domain::Real),
    ("(x + 1)^2 - (x - 1)^2", Domain::Real),
    ("x^2 + 2x + 1 - (x + 1)^2", Domain::Real),
    ("3(x + 2) - 3x", Domain::Real),
    ("(x + 1) - (x - 1)", Domain::Real),
    ("(x + 2)/y", Domain::Real),
    ("(2x + 4y)/2", Domain::Real),
    // --- signs and nesting ---
    ("-x", Domain::Real),
    ("-(-x)", Domain::Real),
    ("-x * y", Domain::Real),
    ("-(x + y)", Domain::Real),
    ("x - (y - z)", Domain::Real),
    ("(x - y) - z", Domain::Real),
    ("-x^2", Domain::Real),
    ("(-x)^2", Domain::Real),
    ("x - 2y + 3z", Domain::Real),
    ("2^3^2", Domain::Real),
    ("(2^3)^2", Domain::Real),
    ("(x^2)^3", Domain::Real),
    // --- powers ---
    ("x^0", Domain::Real),
    ("x^1", Domain::Real),
    ("1^x", Domain::Real),
    ("2^x", Domain::Real),
    ("2^x * 2^y", Domain::Real),
    ("e^x", Domain::Real),
    ("x^2 * y^2", Domain::Real),
    ("(x*y)^3", Domain::Real),
    // --- trigonometry and the rest of the builtins ---
    ("sin(x)", Domain::Real),
    ("cos(x)", Domain::Real),
    ("cos(x)^2 + sin(x)^2", Domain::Real),
    ("sin(x)*cos(y)", Domain::Real),
    ("sin(x + y)", Domain::Real),
    ("sin(2x)", Domain::Real),
    ("cos(x^2)", Domain::Real),
    ("tan(x)", Domain::Real),
    ("sin(x)/cos(x)", Domain::Real),
    ("sinh(x)", Domain::Real),
    ("cosh(x)", Domain::Real),
    ("tanh(x)", Domain::Real),
    ("cosh(x)^2 - sinh(x)^2", Domain::Real),
    ("arctan(x)", Domain::Real),
    ("arctan(x)*x", Domain::Real),
    ("exp(x)", Domain::Real),
    ("exp(x)*exp(y)", Domain::Real),
    ("exp(-x^2)", Domain::Real),
    ("exp(x)/exp(x)", Domain::Real),
    ("pi*x", Domain::Real),
    ("sin(pi*x)", Domain::Real),
    ("x/(y^2 + 1)", Domain::Real),
    ("1/(1 + x^2)", Domain::Real),
    ("sin(x)^2", Domain::Real),
    ("sin(cos(x))", Domain::Real),
    ("tanh(x)*cosh(x)", Domain::Real),
    // --- the ones with corners, kept out of the derivative comparison ---
    ("abs(x)", Domain::Real),
    ("abs(-x)", Domain::Real),
    ("abs(x)*abs(x)", Domain::Real),
    ("sign(x)*x", Domain::Real),
    ("floor(x) + ceil(x)", Domain::Real),
    ("round(x)", Domain::Real),
    ("min(x, y) + max(x, y)", Domain::Real),
    ("max(x, 0) - min(x, 0)", Domain::Real),
    ("mod(x, 3)", Domain::Real),
    ("abs(sin(x))", Domain::Real),
    // --- positive domain ---
    ("ln(x)", Domain::Positive),
    ("ln(x) + ln(y)", Domain::Positive),
    ("ln(x*y)", Domain::Positive),
    ("ln(x)/ln(2)", Domain::Positive),
    ("log(x)", Domain::Positive),
    ("log(2, x)", Domain::Positive),
    ("log(x, y)", Domain::Positive),
    ("sqrt(x)", Domain::Positive),
    ("sqrt(x)*sqrt(x)", Domain::Positive),
    ("sqrt(x)^2", Domain::Positive),
    ("sqrt(x + y)", Domain::Positive),
    ("1/sqrt(x)", Domain::Positive),
    ("(x^2)^0.5", Domain::Positive),
    ("x^0.5 * x^0.5", Domain::Positive),
    ("x^1.5", Domain::Positive),
    ("x^x", Domain::Positive),
    ("x^y", Domain::Positive),
    ("(x*y)^2", Domain::Positive),
    ("exp(ln(x))", Domain::Positive),
    ("ln(exp(x))", Domain::Positive),
    ("x^(1/2)", Domain::Positive),
    ("ln(x^2)", Domain::Positive),
    ("x*ln(x) - x", Domain::Positive),
    // --- the inverse trigonometric domain ---
    ("arcsin(x)", Domain::Unit),
    ("arccos(x)", Domain::Unit),
    ("arcsin(x) + arccos(x)", Domain::Unit),
    ("arcsin(x)*x", Domain::Unit),
    ("arctan(x) - arcsin(x)", Domain::Unit),
];

/// Functions with a corner or a jump in them. Their derivatives are correct
/// almost everywhere (see `numpla_cas::diff`), which is precisely what a
/// difference quotient cannot check, so they are held out of property 4 and
/// covered by the unit tests instead.
const NOT_SMOOTH: &[&str] = &[
    "floor", "ceil", "round", "sign", "abs", "min", "max", "mod",
];

/// How many points each case is checked at.
const SAMPLES: usize = 48;

/// Relative-or-absolute tolerance for "the same value".
///
/// Absolute where the numbers are small, relative where they are large.
/// Simplification legitimately changes the *order* of floating-point
/// operations — that is most of what it does — so `(x+1)^2 - x^2 - 2x - 1`
/// evaluates to about `1e-16` before and exactly `0` after. Demanding bit
/// equality would be demanding that the simplifier do nothing.
const TOL: f64 = 1e-9;

/// Tolerance for the symbolic derivative against the numerical one. Six orders
/// of magnitude above the stencil's own error, and far below any wrong rule.
const DERIV_TOL: f64 = 1e-6;

/// Beyond this, floating-point evaluation has no digits left to compare and the
/// point tells us nothing about the algebra. See `amplification`.
const UNCOMPARABLE: f64 = 1e-3;

// ---- the harness --------------------------------------------------------

fn tree(src: &str) -> Expr {
    let (stmt, errs) = parse(src);
    assert!(errs.is_empty(), "{}: {:?}", src, errs);
    match stmt {
        Stmt::Expr(e) => e,
        other => panic!("{} is not a bare expression: {:?}", src, other),
    }
}

/// The free names of a case: everything it reads that is not a built-in
/// constant. `pi` and `e` are left unbound on purpose, so the evaluator's own
/// values are used and a case can mention them.
fn variables(e: &Expr) -> Vec<String> {
    e.deps()
        .into_iter()
        .filter(|n| !matches!(n.as_str(), "pi" | "tau" | "e" | "inf"))
        .collect()
}

/// SplitMix64: eight lines, no dependencies, and good enough to be uncorrelated
/// across the dimensions of a sample point. The seed is fixed, so a failure is
/// reproducible — a property test nobody can re-run is a rumour.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[lo, hi)`.
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        let u = (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64;
        lo + (hi - lo) * u
    }

    fn sample(&mut self, domain: Domain) -> f64 {
        match domain {
            Domain::Real => self.range(-3.0, 3.0),
            Domain::Positive => self.range(0.5, 4.0),
            Domain::Unit => self.range(-0.85, 0.85),
        }
    }
}

fn env_at(vars: &[String], point: &[f64]) -> Env {
    let mut env = Env::new();
    for (name, v) in vars.iter().zip(point) {
        env.set(name, *v);
    }
    env
}

/// The value of `e` at a point, but only where every subexpression of `e` is
/// finite there too — the domain on which a rewrite is claimed to preserve it.
///
/// See the module docs: an infinity inside an expression can be swallowed by
/// the operation above it, so a finite answer is not evidence that the point is
/// a regular one.
fn at_regular(e: &Expr, vars: &[String], point: &[f64]) -> Option<f64> {
    let value = at(e, vars, point)?;
    let children: &[&Expr] = &match e {
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => Vec::new(),
        Expr::Neg(a) => vec![&**a],
        Expr::Bin { lhs, rhs, .. } => vec![&**lhs, &**rhs],
        Expr::Call { args, .. } => args.iter().collect(),
        Expr::List(items) => items.iter().collect(),
    };
    children
        .iter()
        .all(|c| at_regular(c, vars, point).is_some())
        .then_some(value)
}

/// The value of `e` at a point, or `None` if it is not a finite scalar there.
fn at(e: &Expr, vars: &[String], point: &[f64]) -> Option<f64> {
    let env = env_at(vars, point);
    match numpla_expr::eval(e, &env) {
        Ok(Value::Scalar(x)) if x.is_finite() => Some(x),
        _ => None,
    }
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * a.abs().max(b.abs()).max(1.0)
}

/// Check one rewrite over the whole corpus.
///
/// Returns how many (case, point) pairs actually compared, so the tests can
/// assert that the corpus is doing work rather than skipping quietly — a
/// property test that silently stops testing is the worst outcome of all.
fn check_rewrite(name: &str, rewrite: impl Fn(&Expr) -> Expr) -> usize {
    let mut checked = 0usize;
    for (src, domain) in CORPUS {
        let input = tree(src);
        let output = rewrite(&input);
        let vars = variables(&input);
        let mut rng = Rng(0xC0FF_EE00_1234_5678);
        for _ in 0..SAMPLES {
            let point: Vec<f64> = vars.iter().map(|_| rng.sample(*domain)).collect();
            let Some(want) = at_regular(&input, &vars, &point) else {
                continue;
            };
            let got = at(&output, &vars, &point).unwrap_or_else(|| {
                panic!(
                    "{} of `{}` gave `{}`, which is not finite at {:?} where the input is {}",
                    name,
                    src,
                    to_source(&output),
                    point,
                    want
                )
            });
            assert!(
                close(want, got, TOL),
                "{} changed the value of `{}` to `{}`: {} vs {} at {:?}",
                name,
                src,
                to_source(&output),
                want,
                got,
                point
            );
            checked += 1;
        }
    }
    assert!(checked > 1000, "{} only compared {} points", name, checked);
    checked
}

// ---- the four properties ------------------------------------------------

#[test]
fn the_corpus_is_big_enough_to_mean_something() {
    // A floor, not a target: if someone deletes cases to make a change pass,
    // this is the line that objects.
    assert!(CORPUS.len() >= 100, "corpus has shrunk to {}", CORPUS.len());
}

#[test]
fn simplify_preserves_value() {
    check_rewrite("simplify", simplify);
}

#[test]
fn expand_preserves_value() {
    check_rewrite("expand", expand);
}

#[test]
fn factor_preserves_value() {
    check_rewrite("factor", factor);
}

/// Everything the CAS can produce must be source a person can paste back.
///
/// Three things at once, because they are one promise: the text parses, the
/// tree it parses to has the same value, and printing that tree again gives the
/// same text. The last is what catches a printer that drops brackets — the
/// second pass would place them differently.
#[test]
fn every_result_is_source_that_round_trips() {
    let mut checked = 0usize;
    for (src, domain) in CORPUS {
        let input = tree(src);
        let vars = variables(&input);
        let mut results = vec![simplify(&input), expand(&input), factor(&input)];
        for v in &vars {
            results.push(diff(&input, v).unwrap_or_else(|e| panic!("diff of `{}`: {}", src, e)));
        }
        // Every alternative form is an answer somebody may paste back, so it is
        // held to exactly the same standard as the primary one.
        results.extend(numpla_cas::equal(&input).into_iter().map(|f| f.expr));

        for result in &results {
            let text = to_source(result);
            let (stmt, errs) = parse(&text);
            assert!(errs.is_empty(), "`{}` from `{}`: {:?}", text, src, errs);
            let reparsed = match stmt {
                Stmt::Expr(e) => e,
                other => panic!("`{}` from `{}` parsed as {:?}", text, src, other),
            };
            assert_eq!(
                to_source(&reparsed),
                text,
                "`{}` from `{}` does not print the same way twice",
                text,
                src
            );

            let mut rng = Rng(0x5EED_0BAD_C0DE_1111);
            for _ in 0..SAMPLES {
                let point: Vec<f64> = vars.iter().map(|_| rng.sample(*domain)).collect();
                let Some(want) = at(result, &vars, &point) else {
                    continue;
                };
                let got = at(&reparsed, &vars, &point).expect("re-parsed result is finite");
                assert!(
                    close(want, got, TOL),
                    "`{}` re-parsed to a different value: {} vs {} at {:?}",
                    text,
                    want,
                    got,
                    point
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 1000, "only compared {} points", checked);
}

/// The symbolic derivative against a fourth-order numerical one.
///
/// See the module docs for the stencil, the step, and why a point is allowed to
/// be skipped.
#[test]
fn diff_agrees_with_a_numerical_derivative() {
    let mut checked = 0usize;
    for (src, domain) in CORPUS {
        if NOT_SMOOTH.iter().any(|f| src.contains(f)) {
            continue;
        }
        let input = tree(src);
        let vars = variables(&input);
        for (i, var) in vars.iter().enumerate() {
            let d = diff(&input, var).unwrap_or_else(|e| panic!("diff of `{}`: {}", src, e));
            let mut rng = Rng(0xD1FF_0000_ABCD_EF01);
            for _ in 0..SAMPLES {
                let mut point: Vec<f64> = vars.iter().map(|_| rng.sample(*domain)).collect();
                let Some(symbolic) = at(&d, &vars, &point) else {
                    continue;
                };
                let Some(numeric) = numerical(&input, &vars, &mut point, i) else {
                    continue;
                };
                assert!(
                    close(symbolic, numeric, DERIV_TOL),
                    "d/d{} of `{}` is `{}`: {} symbolically, {} numerically at {:?}",
                    var,
                    src,
                    to_source(&d),
                    symbolic,
                    numeric,
                    point
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 1000, "only compared {} derivatives", checked);
}

/// A Richardson-extrapolated central difference in coordinate `i`, or `None`
/// where the stencil says this is not a place with a derivative.
///
/// The estimate is formed at `h` and at `2h`. A fourth-order stencil has error
/// `c*h^4 + O(h^6)`, so the coarse estimate carries sixteen times the error of
/// the fine one, and two facts fall out of the pair:
///
/// - `(16*fine - coarse)/15` cancels the leading term — a sixth-order answer
///   for the cost of four more evaluations. This is what makes `1/y` at
///   `y = 0.04` comparable at all: there the plain fourth-order error is
///   `(h/y)^4`, about `1e-6`, which is the tolerance itself.
/// - `|fine - coarse|/15` *estimates* the error that was cancelled, and when
///   that estimate is large the extrapolation is not trustworthy either: a
///   pole, a corner, or an overflow sits inside the stencil, and there is
///   nothing there for the symbolic answer to be compared against. Those points
///   are skipped rather than asserted about.
fn numerical(e: &Expr, vars: &[String], point: &mut [f64], i: usize) -> Option<f64> {
    let x = point[i];
    let h = 1e-3 * x.abs().max(1.0);
    let coarse = stencil(e, vars, point, i, 2.0 * h)?;
    let fine = stencil(e, vars, point, i, h)?;
    point[i] = x;

    let refined = fine + (fine - coarse) / 15.0;
    let estimated_error = (fine - coarse).abs() / 15.0;
    if estimated_error > 1e-4 * refined.abs().max(1.0) {
        return None;
    }
    // Reject the enormous case too: a difference quotient of 1e8 is dominated
    // by whatever is happening to the function, not by its slope.
    if refined.abs() > 1e6 {
        return None;
    }
    Some(refined)
}

fn stencil(e: &Expr, vars: &[String], point: &mut [f64], i: usize, h: f64) -> Option<f64> {
    let x = point[i];
    let mut f = |offset: f64| {
        point[i] = x + offset;
        at(e, vars, point)
    };
    let p2 = f(2.0 * h)?;
    let p1 = f(h)?;
    let m1 = f(-h)?;
    let m2 = f(-2.0 * h)?;
    point[i] = x;
    let d = (-p2 + 8.0 * p1 - 8.0 * m1 + m2) / (12.0 * h);
    d.is_finite().then_some(d)
}

// ---- randomly generated trees -------------------------------------------
//
// The corpus above is written by hand, which means it contains the shapes
// somebody thought of. The printer in particular fails on shapes nobody thinks
// of — a negation under a power under a division — so it is also fed random
// trees, where the invariant is not "the text equals the source" (it cannot be:
// the lexer has no negative literal, so `Num(-2)` comes back as a negation of
// 2) but the two things that actually matter: printing is **idempotent** —
// print, parse, print again, and get the same text — and the parse has the same
// value. A dropped bracket breaks the first; a wrong one breaks the second.

/// One random expression, at most `depth` deep.
fn random_expr(rng: &mut Rng, depth: u32) -> Expr {
    const NUMS: [f64; 8] = [0.0, 1.0, 2.0, 3.0, 0.5, -1.0, -2.0, 10.0];
    const NAMES: [&str; 3] = ["x", "y", "k"];
    const ONE_ARG: [&str; 7] = ["sin", "cos", "exp", "ln", "sqrt", "abs", "tanh"];
    // `mod` is missing on purpose. `rem_euclid` of a large dividend by a small
    // divisor amplifies a last-ulp difference without bound — a random tree
    // reached `mod(600.0000000000001, 0.32)`, where reassociating the dividend
    // (which is most of what simplification *is*) moves the answer in the fifth
    // digit. Algebraic equality cannot be checked numerically through a
    // function with unbounded relative condition, so it is exercised by the
    // hand-written corpus above, where the arguments are of comparable size.
    const TWO_ARG: [&str; 3] = ["min", "max", "log"];

    if depth == 0 || rng.next_u64().is_multiple_of(5) {
        return if rng.next_u64().is_multiple_of(2) {
            Expr::Num(NUMS[(rng.next_u64() % 8) as usize])
        } else {
            Expr::Var(NAMES[(rng.next_u64() % 3) as usize].to_string())
        };
    }
    let kid = |rng: &mut Rng| Box::new(random_expr(rng, depth - 1));
    match rng.next_u64() % 8 {
        0 => Expr::Neg(kid(rng)),
        1 => Expr::Bin { op: BinOp::Add, lhs: kid(rng), rhs: kid(rng) },
        2 => Expr::Bin { op: BinOp::Sub, lhs: kid(rng), rhs: kid(rng) },
        3 => Expr::Bin { op: BinOp::Mul, lhs: kid(rng), rhs: kid(rng) },
        4 => Expr::Bin { op: BinOp::Div, lhs: kid(rng), rhs: kid(rng) },
        5 => Expr::Bin { op: BinOp::Pow, lhs: kid(rng), rhs: kid(rng) },
        6 => Expr::Call {
            name: ONE_ARG[(rng.next_u64() % 7) as usize].to_string(),
            args: vec![random_expr(rng, depth - 1)],
        },
        _ => Expr::Call {
            name: TWO_ARG[(rng.next_u64() % 3) as usize].to_string(),
            args: vec![random_expr(rng, depth - 1), random_expr(rng, depth - 1)],
        },
    }
}

#[test]
fn printing_random_trees_round_trips_and_simplifying_them_preserves_value() {
    const TREES: usize = 2000;
    let mut rng = Rng(0x1234_5678_9ABC_DEF0);
    let vars: Vec<String> = ["x", "y", "k"].iter().map(|s| s.to_string()).collect();
    let mut compared = 0usize;

    for _ in 0..TREES {
        let tree = random_expr(&mut rng, 4);
        for candidate in [tree.clone(), simplify(&tree), expand(&tree)] {
            let text = to_source(&candidate);
            let (stmt, errs) = parse(&text);
            assert!(errs.is_empty(), "`{}` does not parse: {:?}", text, errs);
            let reparsed = match stmt {
                Stmt::Expr(e) => e,
                other => panic!("`{}` parsed as {:?}", text, other),
            };
            assert_eq!(to_source(&reparsed), text, "`{}` printed differently twice", text);

            for _ in 0..4 {
                let point: Vec<f64> = vars.iter().map(|_| rng.range(-3.0, 3.0)).collect();
                // The tree that was printed is the reference; the question is
                // only whether the text says the same thing.
                let Some(want) = at(&candidate, &vars, &point) else {
                    continue;
                };
                let got = at(&reparsed, &vars, &point).expect("re-parsed tree is finite");
                assert!(
                    close(want, got, TOL),
                    "`{}` re-parsed to a different value: {} vs {} at {:?}",
                    text,
                    want,
                    got,
                    point
                );
                compared += 1;
            }

            // ...and the rewrite itself, wherever the original has a value —
            // at a tolerance that follows the arithmetic rather than being
            // guessed at. See `amplification`.
            for _ in 0..4 {
                let point: Vec<f64> = vars.iter().map(|_| rng.range(-3.0, 3.0)).collect();
                let Some(want) = at_regular(&tree, &vars, &point) else {
                    continue;
                };
                // The tolerance is decided *before* anything is demanded of
                // the result, because a point where the arithmetic has no
                // digits left is also a point where the result may not be a
                // number at all: an expansion that cancels to `-1e-16` where
                // the input was exactly `0` turns a following `^0.5` into NaN.
                // That is the conditioning speaking, not the algebra.
                let bound = tolerance_at(&[&tree, &candidate], &vars, &point);
                if bound > UNCOMPARABLE {
                    continue;
                }
                let got = at(&candidate, &vars, &point).unwrap_or_else(|| {
                    panic!(
                        "`{}` became `{}`, which is not finite at {:?} where the input is {}",
                        to_source(&tree),
                        text,
                        point,
                        want
                    )
                });
                assert!(
                    close(want, got, bound),
                    "`{}` changed the value: {} vs {} at {:?}",
                    text,
                    want,
                    got,
                    point
                );
                compared += 1;
            }
        }
    }
    assert!(compared > 5000, "only compared {} points", compared);
}

/// How closely two algebraically equal expressions can be expected to agree
/// *numerically* at this point.
///
/// Never tighter than `TOL`. Looser exactly where the arithmetic itself has
/// thrown digits away, and the reason this is computed rather than guessed is
/// that random trees stack the ill-conditioned cases on purpose. One of them
/// expanded `(k + 2)^10` at `k = -1.85`: the polynomial's terms are of size
/// `1e5` and their sum is `4e-9`, so *fourteen* digits cancel — and the result
/// is then raised to the power -10, multiplying what is left of the relative
/// error by ten again. The two forms genuinely differ by half a percent there,
/// and neither of them is wrong: expansion is by definition the rewrite that
/// trades conditioning for readability.
///
/// Nothing structural hides behind this. A wrong rewrite misses by a factor,
/// and a point where even that would be invisible is skipped outright as
/// `UNCOMPARABLE` rather than asserted about.
fn tolerance_at(trees: &[&Expr], vars: &[String], point: &[f64]) -> f64 {
    let worst = trees
        .iter()
        .map(|t| amplification(t, vars, point))
        .fold(0.0f64, f64::max);
    if !worst.is_finite() {
        return f64::INFINITY;
    }
    // Eight ulps per amplified operation is a running-error bound, not an
    // exact one; the factor is slack for the operations this walk approximates.
    (worst * f64::EPSILON * 8.0).max(TOL)
}

/// A crude running-error bound: the factor by which a last-bit rounding error
/// can grow by the time this expression finishes evaluating.
///
/// Only two things amplify: cancellation in a sum, which multiplies by
/// `(|a| + |b|) / |a + b|`, and a power, which multiplies the relative error of
/// its base by the exponent. Products and quotients leave relative error alone.
/// Calls are treated as neutral apart from `exp` and `ln`, whose relative
/// condition numbers (`|u|` and `1/|ln u|`) are unbounded and would otherwise be
/// missed.
fn amplification(e: &Expr, vars: &[String], point: &[f64]) -> f64 {
    let val = |x: &Expr| at(x, vars, point);
    let sub = |x: &Expr| amplification(x, vars, point);
    match e {
        Expr::Num(_) | Expr::Var(_) | Expr::Deriv { .. } | Expr::Hole => 1.0,
        Expr::Neg(a) => sub(a),
        Expr::List(items) => items.iter().map(&sub).fold(1.0f64, f64::max),
        Expr::Call { name, args } => {
            let inner = args.iter().map(&sub).fold(1.0f64, f64::max);
            match (name.as_str(), val(&args[0])) {
                ("exp", Some(u)) => inner * u.abs().max(1.0),
                ("ln", Some(u)) => inner / u.ln().abs().clamp(f64::MIN_POSITIVE, 1.0),
                _ => inner,
            }
        }
        Expr::Bin { op, lhs, rhs } => {
            let (a, b) = (sub(lhs), sub(rhs));
            match op {
                BinOp::Add | BinOp::Sub => match (val(lhs), val(rhs), val(e)) {
                    (Some(x), Some(y), Some(z)) if z != 0.0 => {
                        a.max(b) * ((x.abs() + y.abs()) / z.abs()).max(1.0)
                    }
                    // A sum that cancelled to exactly zero has no relative
                    // accuracy left at all.
                    (Some(_), Some(_), Some(_)) => f64::INFINITY,
                    _ => a.max(b),
                },
                BinOp::Mul | BinOp::Div => a + b,
                BinOp::Pow => match val(rhs) {
                    Some(p) => a * p.abs().max(1.0) + b,
                    None => a + b,
                },
            }
        }
    }
}

// ---- property 6: the `equal` list ----------------------------------------
//
// The rule from `docs/compute.md`, in code: *every candidate must equal the
// input*. A choice list is only useful if you can pick from it without
// checking, and one wrong entry costs you that for every entry — so this is
// the property the feature stands or falls on.
//
// The interesting part is the conditional candidates. `sqrt(u)^2 = u` is true
// where `u >= 0` and meaningless elsewhere, and the honest way to offer it is
// with the condition attached rather than to drop it or to pretend. That is
// only honest if the condition is *checked*, which is what the `holds` call
// below does: a conditional candidate is compared at every sampled point where
// its condition holds, and nowhere else.
//
// Tolerance follows the same running-error bound the random-tree test uses:
// putting a sum over a common denominator or splitting a logarithm
// reassociates the arithmetic, and a point where that has thrown away every
// digit says nothing about the algebra. Those points are skipped rather than
// asserted about.
#[test]
fn every_equal_candidate_really_equals_the_input() {
    let mut exact = 0usize;
    let mut conditional = 0usize;
    let mut numeric = 0usize;

    for (src, domain) in CORPUS {
        let input = tree(src);
        let vars = variables(&input);
        for form in numpla_cas::equal(&input) {
            let text = to_source(&form.expr);
            match form.kind {
                FormKind::Decimal | FormKind::Identification => {
                    // These only ever appear for an expression that is already
                    // a number, and the claim is about that number.
                    let want = at(&input, &[], &[]).expect("a numeric candidate needs a value");
                    let got = at(&form.expr, &[], &[]).unwrap_or_else(|| {
                        panic!("`{}` offered for `{}` has no value", text, src)
                    });
                    let tol = if form.kind == FormKind::Identification {
                        numpla_cas::identify::TOLERANCE
                    } else {
                        TOL
                    };
                    assert!(
                        close(want, got, tol),
                        "`{}` was offered as {} for `{}` but is {} rather than {}",
                        text,
                        form.kind.as_str(),
                        src,
                        got,
                        want
                    );
                    numeric += 1;
                }
                FormKind::Exact | FormKind::Conditional => {
                    let mut rng = Rng(0xEA11_0000_5A5A_1234);
                    for _ in 0..SAMPLES {
                        let point: Vec<f64> = vars.iter().map(|_| rng.sample(*domain)).collect();
                        let Some(want) = at_regular(&input, &vars, &point) else {
                            continue;
                        };
                        // A conditional candidate makes no claim outside its
                        // condition, so outside it there is nothing to check.
                        if let Some(condition) = &form.condition {
                            if !condition.holds(&env_at(&vars, &point)) {
                                continue;
                            }
                        }
                        let bound = tolerance_at(&[&input, &form.expr], &vars, &point);
                        if bound > UNCOMPARABLE {
                            continue;
                        }
                        let got = at(&form.expr, &vars, &point).unwrap_or_else(|| {
                            panic!(
                                "`{}` was offered as an equal form of `{}` but has no value at {:?}, where the input is {}",
                                text, src, point, want
                            )
                        });
                        assert!(
                            close(want, got, bound),
                            "`{}` was offered as an equal form of `{}` but is {} rather than {} at {:?}{}",
                            text,
                            src,
                            got,
                            want,
                            point,
                            match &form.condition {
                                Some(c) => format!(" (condition: {})", c.describe()),
                                None => String::new(),
                            }
                        );
                        if form.condition.is_some() {
                            conditional += 1;
                        } else {
                            exact += 1;
                        }
                    }
                }
            }
        }
    }

    // Each class has to be doing work. A conditional candidate whose condition
    // never holds at any sample point is a candidate nobody has checked, and
    // that is the exact failure mode this whole property exists to prevent.
    assert!(exact > 1000, "only compared {} exact candidates", exact);
    assert!(
        conditional > 100,
        "only compared {} conditional candidates - either the rules stopped producing them or their conditions never hold on the corpus",
        conditional
    );
    assert!(numeric > 0, "no numeric candidates were checked");
}

/// A conditional candidate must be *equal* where its condition holds, and the
/// condition must be doing something — a guard that is always true is a label,
/// not a condition.
#[test]
fn a_condition_is_the_thing_that_makes_a_candidate_true() {
    let input = tree("ln(x*y)");
    let split = numpla_cas::equal(&input)
        .into_iter()
        .find(|f| to_source(&f.expr) == "ln(x) + ln(y)")
        .expect("the product law is offered for ln(x*y)");
    let condition = split.condition.expect("...with a condition");

    let vars = vec!["x".to_string(), "y".to_string()];
    // Inside the condition: equal.
    let inside = [2.0, 3.0];
    assert!(condition.holds(&env_at(&vars, &inside)));
    assert!(close(
        at(&input, &vars, &inside).unwrap(),
        at(&split.expr, &vars, &inside).unwrap(),
        TOL
    ));
    // Outside it: the input is a perfectly good number and the candidate is
    // not. This is the point of the condition, and the reason the rewrite is
    // not in `simplify`.
    let outside = [-2.0, -3.0];
    assert!(!condition.holds(&env_at(&vars, &outside)));
    assert!(at(&input, &vars, &outside).is_some());
    assert!(at(&split.expr, &vars, &outside).is_none());
}

// ---- property 7: solutions ------------------------------------------------

/// One equation, and what is known about its answer.
struct Solvable {
    /// Source, as it would be typed.
    src: &'static str,
    var: &'static str,
    /// How many solutions there are, where that is known independently of the
    /// solver.
    count: usize,
}

const EQUATIONS: &[Solvable] = &[
    // The complaint that started all of this.
    Solvable { src: "2x = 2", var: "x", count: 1 },
    Solvable { src: "3x + 1 = 7", var: "x", count: 1 },
    Solvable { src: "x/4 - 1 = 0", var: "x", count: 1 },
    Solvable { src: "a*x = b", var: "x", count: 1 },
    Solvable { src: "a*x + b = 0", var: "x", count: 1 },
    // Quadratics: two roots, one root, no roots - all three are answers.
    Solvable { src: "x^2 = 4", var: "x", count: 2 },
    Solvable { src: "x^2 = 2", var: "x", count: 2 },
    Solvable { src: "x^2 - 3x + 2 = 0", var: "x", count: 2 },
    Solvable { src: "x^2 - 2x - 1 = 0", var: "x", count: 2 },
    Solvable { src: "2x^2 - 5x + 3 = 0", var: "x", count: 2 },
    Solvable { src: "x^2 + 2x + 1 = 0", var: "x", count: 1 },
    Solvable { src: "x^2 + 1 = 0", var: "x", count: 0 },
    Solvable { src: "x^2 + x = 0", var: "x", count: 2 },
    // Higher degree, through the rational roots.
    Solvable { src: "x^3 - x = 0", var: "x", count: 3 },
    Solvable { src: "x^3 - 6x^2 + 11x - 6 = 0", var: "x", count: 3 },
    Solvable { src: "x^3 - 2x^2 - x + 2 = 0", var: "x", count: 3 },
    Solvable { src: "x^3 - 3x^2 + 3x - 1 = 0", var: "x", count: 1 },
    Solvable { src: "x^4 - 5x^2 + 4 = 0", var: "x", count: 4 },
    Solvable { src: "x^4 - 1 = 0", var: "x", count: 2 },
    Solvable { src: "x^4 - 5x^2 + 5 = 0", var: "x", count: 4 },
    // One occurrence of the unknown: invert the operations around it.
    Solvable { src: "ln(x) = 0", var: "x", count: 1 },
    Solvable { src: "ln(x) = 2", var: "x", count: 1 },
    Solvable { src: "2exp(3x) = 8", var: "x", count: 1 },
    Solvable { src: "exp(x) = 5", var: "x", count: 1 },
    Solvable { src: "2^x = 8", var: "x", count: 1 },
    Solvable { src: "x^5 = 32", var: "x", count: 1 },
    Solvable { src: "3x^3 = 24", var: "x", count: 1 },
    Solvable { src: "x^4 = 16", var: "x", count: 2 },
    Solvable { src: "sqrt(x + 1) = 3", var: "x", count: 1 },
    Solvable { src: "abs(x - 1) = 2", var: "x", count: 2 },
    Solvable { src: "1/x = 4", var: "x", count: 1 },
    Solvable { src: "log(2, x) = 5", var: "x", count: 1 },
    // Domains that rule everything out, which is an answer and not a failure.
    Solvable { src: "sqrt(x) = -1", var: "x", count: 0 },
    Solvable { src: "exp(x) = -1", var: "x", count: 0 },
    // A product is zero where a factor is.
    Solvable { src: "exp(x)(x - 1) = 0", var: "x", count: 1 },
    Solvable { src: "(x - 1)(x - 2)(x - 3) = 0", var: "x", count: 3 },
];

/// Every root, put back into the equation it came from.
///
/// This is `solve`'s own version of the value-preservation rule: a solver is
/// exactly as trustworthy as its residuals. Symbolic zero where the algebra
/// closes, numeric zero where it does not — and the second case is not a
/// weakening, it is `sqrt(2)^2 -> 2` being a rewrite this crate deliberately
/// refuses to make, so the check falls back to arithmetic that cannot lie
/// about it either.
#[test]
fn every_root_satisfies_its_equation() {
    let mut exact = 0usize;
    let mut numeric = 0usize;
    for case in EQUATIONS {
        let (stmt, errs) = parse(case.src);
        assert!(errs.is_empty(), "{}: {:?}", case.src, errs);
        let (lhs, rhs) = numpla_cas::solve::equation_of(&stmt)
            .unwrap_or_else(|| panic!("{} is not an equation", case.src));
        let answer = numpla_cas::solve(&lhs, &rhs, case.var)
            .unwrap_or_else(|e| panic!("{}: {}", case.src, e));

        assert_eq!(
            answer.roots.len(),
            case.count,
            "{} should have {} solutions, got {:?}",
            case.src,
            case.count,
            answer.roots.iter().map(to_source).collect::<Vec<_>>()
        );
        for root in &answer.roots {
            // A root has to be source too: it is the first thing anybody pastes.
            let text = to_source(root);
            let (parsed, errs) = parse(&text);
            assert!(errs.is_empty(), "root `{}` of `{}`: {:?}", text, case.src, errs);
            assert!(matches!(parsed, Stmt::Expr(_)), "root `{}` is not an expression", text);

            match numpla_cas::check_root(&lhs, &rhs, case.var, root) {
                RootCheck::Exact => exact += 1,
                RootCheck::Numeric => numeric += 1,
                RootCheck::Failed => panic!(
                    "`{} = {}` does not hold at {} = {}",
                    to_source(&lhs),
                    to_source(&rhs),
                    case.var,
                    text
                ),
            }
        }
    }
    assert!(exact > 20, "only {} roots vanished symbolically", exact);
    assert!(numeric > 0, "no root needed the numeric check");
}

/// The refusals are part of the contract too: each one comes back as a sentence
/// rather than as a plausible answer.
#[test]
fn what_solve_refuses_it_refuses_by_name() {
    for (src, var, expected) in [
        ("sin(x) = 0", "x", "infinitely many"),
        ("cos(x) = 0.5", "x", "infinitely many"),
        ("x^3 - 6x - 6 = 0", "x", "no rational roots"),
        ("x^5 - x - 1 = 0", "x", "no rational roots"),
        ("x + ln(x) = 1", "x", "more than once"),
        ("floor(x) = 2", "x", "interval"),
    ] {
        let (stmt, _) = parse(src);
        let (lhs, rhs) = numpla_cas::solve::equation_of(&stmt).unwrap();
        match numpla_cas::solve(&lhs, &rhs, var) {
            Err(numpla_cas::CasError::Unsupported(message)) => assert!(
                message.contains(expected),
                "`{}` was refused with `{}`, which does not mention `{}`",
                src,
                message,
                expected
            ),
            other => panic!("`{}` was not refused: {:?}", src, other),
        }
    }
}

// ---- sums and products ----------------------------------------------------

/// A closed form has to agree with the sum it is a closed form *of*.
///
/// The formulas are the part of this crate most likely to be wrong in a way
/// nothing else notices — an off-by-one in a limit produces an expression that
/// looks entirely plausible — so every one of them is checked against the same
/// series added up one term at a time, at several limits including the empty
/// one.
#[test]
fn every_closed_form_agrees_with_the_series_it_closes() {
    let cases: &[(&str, &str)] = &[
        ("1", "k"),
        ("7", "k"),
        ("k", "k"),
        ("k^2", "k"),
        ("k^3", "k"),
        ("2k + 1", "k"),
        ("k^3 - 2k^2 + k - 5", "k"),
        ("2^k", "k"),
        ("(1/3)^k", "k"),
        ("3 * 2^k", "k"),
        ("exp(k)", "k"),
    ];
    let mut checked = 0usize;
    for (summand, k) in cases {
        let e = tree(summand);
        for lo in [0i64, 1, 3] {
            for hi in [lo - 1, lo, lo + 1, lo + 5, lo + 9] {
                let a = Expr::Num(lo as f64);
                let b = Expr::Num(hi as f64);
                let closed = numpla_cas::sum(&e, k, &a, &b).unwrap_or_else(|err| {
                    panic!("sum({}, {}, {}, {}): {}", summand, k, lo, hi, err)
                });
                let mut want = 0.0f64;
                for i in lo..=hi {
                    let mut env = Env::new();
                    env.set(k, i as f64);
                    want += match numpla_expr::eval(&e, &env) {
                        Ok(Value::Scalar(x)) => x,
                        other => panic!("{} at {} = {}: {:?}", summand, k, i, other),
                    };
                }
                let got = at(&closed.expr, &[], &[]).unwrap_or_else(|| {
                    panic!(
                        "sum({}, {}, {}, {}) gave `{}`",
                        summand,
                        k,
                        lo,
                        hi,
                        to_source(&closed.expr)
                    )
                });
                assert!(
                    close(want, got, 1e-9),
                    "sum({}, {}, {}, {}) is `{}` = {}, but adding it up gives {}",
                    summand,
                    k,
                    lo,
                    hi,
                    to_source(&closed.expr),
                    got,
                    want
                );
                checked += 1;
            }
        }
    }

    // The same for products, where the shapes with closed forms are fewer.
    for (factor_src, k) in [("3", "k"), ("2^k", "k"), ("(1/2)^k", "k")] {
        let e = tree(factor_src);
        for hi in [1i64, 2, 4, 6] {
            let closed = numpla_cas::product(&e, k, &Expr::Num(1.0), &Expr::Num(hi as f64))
                .unwrap_or_else(|err| panic!("product({}, {}, 1, {}): {}", factor_src, k, hi, err));
            let mut want = 1.0f64;
            for i in 1..=hi {
                let mut env = Env::new();
                env.set(k, i as f64);
                want *= numpla_expr::eval(&e, &env).unwrap().scalar().unwrap();
            }
            let got = at(&closed.expr, &[], &[]).expect("a closed product has a value");
            assert!(
                close(want, got, 1e-9),
                "product({}, {}, 1, {}) is `{}` = {}, but multiplying it out gives {}",
                factor_src,
                k,
                hi,
                to_source(&closed.expr),
                got,
                want
            );
            checked += 1;
        }
    }
    assert!(checked > 50, "only checked {} series", checked);
}

/// A symbolic closed form has to be right for *every* upper limit, not only the
/// ones that were tried while writing it.
#[test]
fn a_symbolic_closed_form_is_right_at_every_limit() {
    for (summand, expected_at_10) in [("k", 55.0), ("k^2", 385.0), ("k^3", 3025.0)] {
        let closed = numpla_cas::sum(&tree(summand), "k", &Expr::Num(1.0), &tree("n")).unwrap();
        let vars = vec!["n".to_string()];
        assert_eq!(at(&closed.expr, &vars, &[10.0]), Some(expected_at_10), "{}", summand);
        // ...and at the empty limit, where the sum is zero by definition.
        assert_eq!(at(&closed.expr, &vars, &[0.0]), Some(0.0), "{}", summand);
    }
}
