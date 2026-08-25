//! Measures the cost of a function-call row against the same arithmetic
//! inlined. The gap used to be ~3.5x because every call cloned the Env.
use std::time::Instant;

fn solve_once(src: &str) -> (bool, u128, Vec<f64>, usize) {
    let mut m = numpla_model::Model::new();
    let d = m.set_source(src);
    let errs: Vec<_> = d.issues.iter().filter(|i| format!("{:?}", i.severity) == "Error").collect();
    if !errs.is_empty() {
        println!("  ISSUES: {:?}", d.issues);
    }
    let t = Instant::now();
    let rep = m.solve(0.0, 20.0);
    let us = t.elapsed().as_micros();
    (rep.ok, us, m.eval(20.0), rep.accepted)
}

fn main() {
    // Same physics, written two ways: a named spring law vs inlined arithmetic.
    let with_fn = "\
k = 60
g = 40
f(u) = k u + g u^3
x' = v
v' = f(y - x) - f(x)
y' = w
w' = f(x - y) - f(y)
x(0) = 1
y(0) = 0
v(0) = 0
w(0) = 0";

    let inlined = "\
k = 60
g = 40
x' = v
v' = k (y - x) + g ((y - x)^3) - k x - g (x^3)
y' = w
w' = k (x - y) + g ((x - y)^3) - k y - g (y^3)
x(0) = 1
y(0) = 0
v(0) = 0
w(0) = 0";

    for (label, src) in [("function-call rows", with_fn), ("inlined", inlined)] {
        let mut best = u128::MAX;
        let mut ok = false;
        let mut end = Vec::new();
        let mut acc = 0;
        for _ in 0..5 {
            let (o, us, e, a) = solve_once(src);
            ok = o; end = e; acc = a;
            best = best.min(us);
        }
        let shown: Vec<String> = end.iter().map(|v| format!("{:.6}", v)).collect();
        println!("{:>20}: {:>8} us  steps={:<6} ok={}  y(20)=[{}]",
                 label, best, acc, ok, shown.join(", "));
    }
}
