//! Built-in tech and workplace terms (`terms/tech.json`): fixes their common mis-hearings
//! ("cube control" -> "kubectl", "post gress" -> "Postgres") and finds the terms a user says, so the
//! ones they use most are sent to the transcriber as hints. Aliases were mined from TTS voices and
//! the local models (`tools/mine_aliases.py`). Aliases made only of dictionary words
//! ("type script") are applied in code editors and terminals only.

use regex::{Captures, Regex, RegexBuilder};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    term: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    tech_aliases: Vec<String>,
}

struct Pack {
    terms: Vec<String>,
    /// Normalized alias or term -> index into `terms`.
    lookup: HashMap<String, usize>,
    /// Aliases applied everywhere / also in technical contexts.
    any: Option<Regex>,
    tech: Option<Regex>,
    /// The terms themselves (usage).
    find: Option<Regex>,
}

static PACK: LazyLock<Pack> = LazyLock::new(|| load(include_str!("../terms/tech.json")));

/// Builds the pack off the dictation path (called at startup).
pub fn warm() {
    LazyLock::force(&PACK);
}

/// Replaces known mis-hearings with the term, except inside `keep` (byte ranges the user's own
/// dictionary or snippets own); returns the text and the number of fixes.
pub fn fix(text: &str, technical: bool, keep: &[(usize, usize)]) -> (String, usize) {
    let Some(re) = (if technical { &PACK.tech } else { &PACK.any }) else { return (text.to_string(), 0) };
    let mut n = 0;
    let out = re.replace_all(text, |c: &Captures| {
        let m = c.get(0).unwrap();
        // In terminals and code a hyphen joins a name ("fix-post-gress-pool" is a branch), not words.
        let hyphenated = technical && (text[..m.start()].ends_with('-') || text[m.end()..].starts_with('-'));
        let kept = keep.iter().any(|&(s, e)| m.start() < e && s < m.end()) || !standalone(text, m.start(), m.end()) || hyphenated;
        match PACK.lookup.get(&norm(m.as_str())).filter(|_| !kept) {
            Some(&i) => {
                n += 1;
                PACK.terms[i].clone()
            }
            None => m.as_str().to_string(),
        }
    });
    (out.into_owned(), n)
}

/// A match glued to a path, URL or file name ("feature/get-push", "https://no.js/health",
/// "kube control.yaml") isn't speech to fix; sentence punctuation after it and hyphenated
/// compounds ("Postgres-compatible") are fine.
pub(crate) fn standalone(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back();
    let mut after = text[end..].chars();
    let ok_before = before.is_none_or(|c| c.is_whitespace() || "([\"'“‘`-".contains(c));
    let ok_after = match after.next() {
        None => true,
        Some('.' | ':') => after.next().is_none_or(char::is_whitespace),
        Some(c) => c.is_whitespace() || ")]\"'”’,;!?`-".contains(c),
    };
    ok_before && ok_after
}

/// Built-in terms that occur in the text, once each.
pub fn find(text: &str) -> Vec<&'static str> {
    let Some(re) = &PACK.find else { return Vec::new() };
    let mut out: Vec<&'static str> = Vec::new();
    for m in re.find_iter(text) {
        if let Some(&i) = PACK.lookup.get(&norm(m.as_str())) {
            if !out.contains(&PACK.terms[i].as_str()) {
                out.push(&PACK.terms[i]);
            }
        }
    }
    out
}

/// Whether `s` is a built-in term as written ("Next.js"), not an alias.
pub fn is_term(s: &str) -> bool {
    PACK.lookup.get(&norm(s)).is_some_and(|&i| PACK.terms[i].eq_ignore_ascii_case(s))
}

/// Lowercase, with hyphens and runs of spaces as single spaces (how phrases are matched).
pub(crate) fn norm(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c == '-').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ").to_lowercase()
}

fn load(json: &str) -> Pack {
    let entries: Vec<Entry> = serde_json::from_str(json).expect("terms/tech.json");
    let mut lookup = HashMap::new();
    let (mut any, mut tech, mut terms) = (Vec::new(), Vec::new(), Vec::new());
    for (i, e) in entries.iter().enumerate() {
        lookup.insert(norm(&e.term), i);
        terms.push(e.term.as_str());
        for a in &e.aliases {
            lookup.insert(norm(a), i);
            any.push(a.as_str());
        }
        for a in &e.tech_aliases {
            lookup.insert(norm(a), i);
            tech.push(a.as_str());
        }
    }
    tech.extend(&any);
    let alternation = |mut phrases: Vec<&str>| {
        // Longest first, so "git hub actions" wins over "git hub".
        phrases.sort_by_key(|p| std::cmp::Reverse(p.len()));
        // Hyphens count as spaces ("post-gress" also matches "post gress"), like `lookup` keys.
        let parts: Vec<String> = phrases.iter().filter_map(|p| crate::text::phrase_pattern(&norm(p))).map(|p| format!("(?:{p})")).collect();
        (!parts.is_empty()).then(|| RegexBuilder::new(&parts.join("|")).case_insensitive(true).size_limit(1 << 25).build().expect("terms regex"))
    };
    Pack {
        any: alternation(any),
        tech: alternation(tech),
        find: alternation(terms),
        terms: entries.into_iter().map(|e| e.term).collect(),
        lookup,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixes_mishearings_by_context() {
        let (out, n) = fix("Run cube control apply, then check post gress and git hub actions.", true, &[]);
        assert_eq!(out, "Run kubectl apply, then check Postgres and GitHub Actions.");
        assert_eq!(n, 3);
        // Ordinary-word aliases stay out of prose.
        assert_eq!(fix("I need cube control here", false, &[]).0, "I need cube control here");
        // Paths, URLs and file names are not speech; sentence punctuation is fine.
        assert_eq!(fix("git checkout feature/get-push", true, &[]).0, "git checkout feature/get-push");
        assert_eq!(fix("open https://no.js/health and no.js.", false, &[]).0, "open https://no.js/health and Node.js.");
        assert_eq!(fix("(post gress), cube control.yaml", true, &[]).0, "(Postgres), cube control.yaml");
        // In technical contexts a hyphenated name (a branch, a package) is kept as typed.
        assert_eq!(fix("git checkout -b fix-post-gress-pool", true, &[]).0, "git checkout -b fix-post-gress-pool");
        // Ranges the user's dictionary or snippets own are left alone.
        assert_eq!(fix("ducker and ducker", true, &[(0, 6)]).0, "ducker and Docker");
        // Already-correct terms and words that merely contain an alias are untouched.
        assert_eq!(fix("Use kubectl and Postgres; postgresql works.", true, &[]).0, "Use kubectl and Postgres; postgresql works.");
    }

    #[test]
    fn finds_terms_once() {
        assert_eq!(find("kubectl get pods; kubectl logs, then open Next.js and node.js docs"), vec!["kubectl", "Next.js", "Node.js"]);
        assert!(find("nothing technical here").is_empty());
    }

    /// Cost on the dictation path: cargo test --release terms_speed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn terms_speed() {
        let t = std::time::Instant::now();
        warm();
        println!("build: {:?}", t.elapsed());
        let short = "Run cube control apply and check post gress before we merge the type script changes.";
        let long = short.repeat(70); // ~1000 words
        for (name, text) in [("short", short), ("1000 words", long.as_str())] {
            let t = std::time::Instant::now();
            for _ in 0..100 {
                std::hint::black_box(fix(text, true, &[]));
                std::hint::black_box(find(text));
            }
            println!("{name}: {:?} per fix + find", t.elapsed() / 100);
        }
    }

    /// Every alias is safe to apply: not a term itself, not owned by two terms, and an alias
    /// applied everywhere isn't made only of very common words.
    #[test]
    fn pack_is_consistent() {
        let entries: Vec<Entry> = serde_json::from_str(include_str!("../terms/tech.json")).unwrap();
        let mut owner: HashMap<String, &str> = entries.iter().map(|e| (norm(&e.term), e.term.as_str())).collect();
        for e in &entries {
            assert!(!crate::learn::common(&e.term), "term is a common word: {}", e.term);
            for a in e.aliases.iter().chain(&e.tech_aliases) {
                let prev = owner.insert(norm(a), &e.term);
                assert!(prev.is_none(), "alias {a:?} of {} collides with {prev:?}", e.term);
                assert!(norm(a).split(' ').count() > 1 || e.aliases.contains(a), "single-word tech alias {a:?}");
            }
            for a in &e.aliases {
                assert!(!crate::learn::common(a), "alias made of common words applied everywhere: {a:?}");
            }
        }
    }
}
