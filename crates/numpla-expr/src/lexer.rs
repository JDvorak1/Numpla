//! Tokenizer.
//!
//! Follows the Desmos convention: identifiers are a *single* letter plus an
//! optional subscript, so `xy` lexes as two variables and implicit
//! multiplication just works. Multi-character names are reserved for known
//! functions and constants, which are matched longest-first.

/// Function names recognised without parentheses (`sin x` == `sin(x)`).
///
/// The noise names are reserved here for the same reason `sin` is: a
/// multi-letter name is a known function or it is several variables, and
/// `smooth(t)` has to be the function. The cost is that `b*l*u*e` can no
/// longer be written as `blue`, which is the trade the single-letter
/// identifier rule makes everywhere else too.
pub const FUNCS: &[&str] = &[
    "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "sin", "cos", "tan",
    "sqrt", "exp", "ln", "log", "abs", "min", "max", "floor", "ceil", "round",
    "sign", "mod",
    "white", "pink", "brown", "blue", "smooth", "telegraph", "randn", "rand",
];

/// Multi-letter constants that must not be split into single letters.
pub const CONSTS: &[&str] = &["pi", "tau", "inf"];

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Num(f64),
    /// Variable: one letter, optionally `_sub` or `_{sub}`.
    Ident(String),
    /// Known function name.
    Func(String),
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Eq,
    Prime,
    Unknown(char),
}

impl Tok {
    /// Can this token begin a primary expression? Drives implicit multiplication.
    pub fn starts_primary(&self) -> bool {
        matches!(
            self,
            Tok::Num(_) | Tok::Ident(_) | Tok::Func(_) | Tok::LParen | Tok::LBracket
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Spanned {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
}

fn match_word(chars: &[char], i: usize, table: &[&str]) -> Option<String> {
    let mut best: Option<&str> = None;
    for w in table {
        let wc: Vec<char> = w.chars().collect();
        if i + wc.len() <= chars.len() && chars[i..i + wc.len()] == wc[..]
            && best.is_none_or(|b| b.len() < w.len()) {
                best = Some(w);
            }
    }
    best.map(|s| s.to_string())
}

pub fn lex(src: &str) -> Vec<Spanned> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let tok = match c {
            '+' => { i += 1; Tok::Plus }
            '-' => { i += 1; Tok::Minus }
            '*' => { i += 1; Tok::Star }
            '/' => { i += 1; Tok::Slash }
            '^' => { i += 1; Tok::Caret }
            '(' => { i += 1; Tok::LParen }
            ')' => { i += 1; Tok::RParen }
            '[' => { i += 1; Tok::LBracket }
            ']' => { i += 1; Tok::RBracket }
            ',' => { i += 1; Tok::Comma }
            '=' => { i += 1; Tok::Eq }
            '\'' => { i += 1; Tok::Prime }
            _ if c.is_ascii_digit()
                || (c == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit()) =>
            {
                let mut s = String::new();
                let mut seen_dot = false;
                while i < chars.len()
                    && (chars[i].is_ascii_digit() || (chars[i] == '.' && !seen_dot))
                {
                    if chars[i] == '.' {
                        seen_dot = true;
                    }
                    s.push(chars[i]);
                    i += 1;
                }
                Tok::Num(s.parse().unwrap_or(f64::NAN))
            }
            _ if c.is_alphabetic() => {
                if let Some(f) = match_word(&chars, i, FUNCS) {
                    i += f.chars().count();
                    Tok::Func(f)
                } else if let Some(k) = match_word(&chars, i, CONSTS) {
                    i += k.chars().count();
                    Tok::Ident(k)
                } else {
                    let mut s = String::new();
                    s.push(chars[i]);
                    i += 1;
                    if i < chars.len() && chars[i] == '_' {
                        i += 1;
                        s.push('_');
                        if i < chars.len() && chars[i] == '{' {
                            i += 1;
                            while i < chars.len() && chars[i] != '}' {
                                s.push(chars[i]);
                                i += 1;
                            }
                            if i < chars.len() {
                                i += 1;
                            }
                        } else {
                            while i < chars.len() && chars[i].is_alphanumeric() {
                                s.push(chars[i]);
                                i += 1;
                            }
                        }
                    }
                    Tok::Ident(s)
                }
            }
            _ => { i += 1; Tok::Unknown(c) }
        };
        out.push(Spanned { tok, start, end: i });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &str) -> Vec<Tok> {
        lex(s).into_iter().map(|s| s.tok).collect()
    }

    #[test]
    fn splits_adjacent_letters() {
        assert_eq!(
            toks("xy"),
            vec![Tok::Ident("x".into()), Tok::Ident("y".into())]
        );
    }

    #[test]
    fn keeps_function_names_whole() {
        assert_eq!(
            toks("sinx"),
            vec![Tok::Func("sin".into()), Tok::Ident("x".into())]
        );
    }

    #[test]
    fn prefers_longest_function_match() {
        assert_eq!(toks("arctan"), vec![Tok::Func("arctan".into())]);
    }

    #[test]
    fn reads_subscripts() {
        assert_eq!(toks("k_1"), vec![Tok::Ident("k_1".into())]);
        assert_eq!(toks("k_{max}"), vec![Tok::Ident("k_max".into())]);
    }

    #[test]
    fn reads_numbers_and_primes() {
        assert_eq!(
            toks("2.5x'"),
            vec![Tok::Num(2.5), Tok::Ident("x".into()), Tok::Prime]
        );
    }

    #[test]
    fn keeps_constants_whole() {
        assert_eq!(toks("pi"), vec![Tok::Ident("pi".into())]);
    }

    #[test]
    fn reads_noise_names_as_functions() {
        for name in [
            "white", "pink", "brown", "blue", "smooth", "telegraph", "rand", "randn",
        ] {
            assert_eq!(toks(name), vec![Tok::Func(name.into())], "{}", name);
        }
    }

    /// `randn` is `rand` plus a letter, and `pink` starts with the constant
    /// `pi`. Longest-match has to resolve both, or `randn(3)` silently becomes
    /// `rand(3) * n * 3`.
    #[test]
    fn noise_names_do_not_shadow_each_other() {
        assert_eq!(toks("randn"), vec![Tok::Func("randn".into())]);
        assert_eq!(toks("pink"), vec![Tok::Func("pink".into())]);
        assert_eq!(
            toks("pix"),
            vec![Tok::Ident("pi".into()), Tok::Ident("x".into())]
        );
    }
}
