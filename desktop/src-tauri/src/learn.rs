//! Auto-learn: when the user corrects a dictation (in History), compare the original with the
//! corrected text and turn small, local word changes into dictionary entries. Whole rewrites
//! teach nothing (they're edits, not misrecognitions).

use std::collections::HashSet;
use std::sync::LazyLock;

/// A learned dictionary entry: `replacement == None` means a spelling/capitalization fix.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Correction {
    pub phrase: String,
    pub replacement: Option<String>,
}

/// Most words a misrecognized phrase (or its correction) may span.
const MAX_SPAN: usize = 3;

fn bare(w: &str) -> &str {
    w.trim_matches(|c: char| !c.is_alphanumeric() && !matches!(c, '/' | '_' | '-' | '+' | '#' | '.' | '@'))
        .trim_end_matches('.')
}

pub fn corrections(original: &str, corrected: &str) -> Vec<Correction> {
    let a: Vec<&str> = original.split_whitespace().map(bare).filter(|w| !w.is_empty()).collect();
    // Corrected words keep their raw form too, to tell sentence starts apart.
    let b_raw: Vec<&str> = corrected.split_whitespace().filter(|w| !bare(w).is_empty()).collect();
    let b: Vec<&str> = b_raw.iter().map(|w| bare(w)).collect();
    if a.is_empty() || b.is_empty() || a.len() > 400 || b.len() > 400 {
        return Vec::new();
    }
    // Longest common subsequence on case-insensitive words.
    let eq = |x: &str, y: &str| x.to_lowercase() == y.to_lowercase();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if eq(a[i], b[j]) { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    // Mostly rewritten: learning from it would add noise.
    if (lcs[0][0] as usize) * 2 < n.max(m) {
        return Vec::new();
    }

    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    let (mut gap_a, mut gap_b): (Vec<&str>, Vec<&str>) = (Vec::new(), Vec::new());
    let flush = |ga: &mut Vec<&str>, gb: &mut Vec<&str>, out: &mut Vec<Correction>| {
        if !ga.is_empty() && !gb.is_empty() && ga.len() <= MAX_SPAN && gb.len() <= MAX_SPAN {
            out.push(Correction { phrase: ga.join(" "), replacement: Some(gb.join(" ")) });
        }
        ga.clear();
        gb.clear();
    };
    while i < n || j < m {
        if i < n && j < m && eq(a[i], b[j]) {
            flush(&mut gap_a, &mut gap_b, &mut out);
            // Same word, different capitalization: a spelling fix ("kubernetes" -> "Kubernetes",
            // "github" -> "GitHub"), unless it's just a sentence being capitalized.
            let sentence_start = j == 0 || b_raw[j - 1].ends_with(['.', '!', '?', ':']);
            let inner_caps = b[j].chars().skip(1).any(char::is_uppercase);
            let starts_upper = b[j].chars().next().is_some_and(char::is_uppercase);
            if a[i] != b[j] && (inner_caps || (starts_upper && !sentence_start)) {
                out.push(Correction { phrase: b[j].to_string(), replacement: None });
            }
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            gap_b.push(b[j]);
            j += 1;
        } else {
            gap_a.push(a[i]);
            i += 1;
        }
    }
    flush(&mut gap_a, &mut gap_b, &mut out);
    // One save is one correction event: "Bob ... Bob" -> "Alice ... Alice" counts once.
    let mut seen = Vec::new();
    out.into_iter()
        .filter_map(guard)
        .filter(|c| {
            let k = (c.phrase.to_lowercase(), c.replacement.clone());
            !seen.contains(&k) && {
                seen.push(k);
                true
            }
        })
        .collect()
}

/// Drops corrections too generic to apply everywhere. A misheard common phrase ("call" -> "Karl",
/// "their" -> "there") can't become a global replacement, but a rare word the user meant is
/// still worth knowing as a spelling hint for the transcriber ("Karl").
fn guard(c: Correction) -> Option<Correction> {
    let c = match c.replacement {
        Some(r) if common(&c.phrase) => Correction { phrase: r, replacement: None },
        _ => c,
    };
    let target = c.replacement.as_deref().unwrap_or(&c.phrase);
    // Pure numbers/punctuation and one-letter tokens are too generic to learn.
    let ok = target.chars().filter(|ch| ch.is_alphabetic()).count() >= 2 && target.len() <= 60 && !common(&c.phrase) && !common(target);
    ok.then_some(c)
}

/// Misrecognitions sound like what was meant ("Karl" -> "Karol", "cube control" -> "kubectl");
/// edits usually don't ("Bob" -> "Alice"). Expansions that keep the spoken text count too
/// ("nest dev" -> "feature/nest_dev").
pub fn sounds_alike(c: &Correction) -> bool {
    let Some(r) = &c.replacement else { return true };
    let (a, b) = (letters(&c.phrase), letters(r));
    let close = |a: &[char], b: &[char]| !a.is_empty() && !b.is_empty() && 3 * distance(a, b) <= a.len().max(b.len());
    let contains = |a: &[char], b: &[char]| b.len() >= 3 && a.windows(b.len()).any(|w| w == b);
    contains(&a, &b) || contains(&b, &a) || close(&a, &b) || close(&sound(&a), &sound(&b))
}

fn letters(s: &str) -> Vec<char> {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Rough sound key: similar consonants merged, vowels and repeats dropped ("cube control" and
/// "kubectl" -> "kpkntrl" and "kpktl").
fn sound(s: &[char]) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for (i, &c) in s.iter().enumerate() {
        let k = match c {
            'a' | 'e' | 'i' | 'o' | 'u' | 'y' | 'h' | 'w' => continue,
            'c' | 'q' | 'k' => 'k',
            'z' => 's',
            'v' => 'f',
            'd' => 't',
            'b' => 'p',
            'j' => 'g',
            'x' => {
                out.extend(['k', 's']);
                continue;
            }
            'p' if s.get(i + 1) == Some(&'h') => 'f',
            c => c,
        };
        if out.last() != Some(&k) {
            out.push(k);
        }
    }
    out
}

/// Levenshtein distance.
fn distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != cb)).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

/// Only very common English words: never a misheard name or term.
pub fn common(phrase: &str) -> bool {
    phrase
        .split_whitespace()
        .all(|w| COMMON.contains(w.to_lowercase().replace('’', "'").trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')))
}

static COMMON: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    "a about above after again against all also am an and another any are as at back be because been before being below \
     between both but by can can't come could did didn't do does doesn't doing don't down during each even every few for from \
     further get gets getting go goes going gone good got great had hadn't has hasn't have haven't having he he's her here \
     hers herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself just know let let's like \
     make many may me might more most much must my myself need new no nor not now of off on once one only or other our ours \
     ourselves out over own please put really right said same say see she she's should shouldn't so some such take than \
     thank thanks that that's the their theirs them themselves then there there's these they they're this those through \
     to too two under until up us very want was wasn't way we we'll we're we've well were weren't what what's when where \
     which while who whom why will with won't would wouldn't yes yet you you'd you'll you're you've your yours yourself \
     call called calls today tomorrow yesterday time day week year here okay ok sure next last first also back just still \
     think look give use find tell ask work seem feel try leave mean keep begin show hear play run move live bring happen \
     write sit stand lose pay meet set learn change lead understand watch follow stop create speak read spend grow open \
     walk win send build stay fall cut reach pass sell decide return hope carry break hit eat cover catch draw choose \
     sent made took came went saw thought told asked worked used found gave done seen known taken given"
        .split_whitespace()
        .collect()
});

#[cfg(test)]
mod tests {
    use super::*;

    fn rep(p: &str, r: &str) -> Correction {
        Correction { phrase: p.into(), replacement: Some(r.into()) }
    }

    #[test]
    fn learns_small_substitutions() {
        assert_eq!(
            corrections("Merge nest dev into main today.", "Merge feature/nest_dev into main today."),
            vec![rep("nest dev", "feature/nest_dev")]
        );
        assert_eq!(corrections("Ask Karl about it", "Ask Karol about it"), vec![rep("Karl", "Karol")]);
    }

    #[test]
    fn learns_capitalization_fixes_but_not_sentence_starts() {
        assert_eq!(
            corrections("deploy it to kubernetes and github", "deploy it to Kubernetes and GitHub"),
            vec![Correction { phrase: "Kubernetes".into(), replacement: None }, Correction { phrase: "GitHub".into(), replacement: None }]
        );
        assert!(corrections("done. next we ship", "done. Next we ship").is_empty());
    }

    #[test]
    fn ignores_rewrites_insertions_and_noise() {
        assert!(corrections("let's meet tomorrow at noon", "Could we push our sync to Friday afternoon instead?").is_empty());
        assert!(corrections("send the report", "send the final report").is_empty(), "pure insertion");
        assert!(corrections("we need 3 more", "we need 4 more").is_empty(), "numbers");
        assert!(corrections("same text.", "same text.").is_empty());
        assert!(corrections("the a b c d e f", "the q r s t u v").is_empty());
    }

    #[test]
    fn common_words_never_become_replacements() {
        assert!(corrections("put it over their", "put it over there").is_empty());
        assert!(corrections("we can do it", "we can't do it").is_empty());
        assert!(corrections("we go now", "we Go now").is_empty(), "capitalized common word");
        assert!(corrections("we can’t ship this today", "we don’t ship this today").is_empty(), "curly apostrophes");
        assert!(corrections("we can't ship this today", "we don't ship this today").is_empty(), "straight apostrophes");
        // A misheard common word teaches only the spelling of what was meant.
        assert_eq!(corrections("please call about it", "please Karl about it"), vec![Correction { phrase: "Karl".into(), replacement: None }]);
    }

    #[test]
    fn one_save_is_one_correction() {
        assert_eq!(corrections("Bob reviews and Bob approves today", "Alice reviews and Alice approves today"), vec![rep("Bob", "Alice")]);
    }

    #[test]
    fn tells_misrecognitions_from_edits() {
        let alike = |a: &str, b: &str| sounds_alike(&rep(a, b));
        assert!(alike("Karl", "Karol") && alike("Sam", "Pam") && alike("Jon", "John"));
        assert!(alike("cube control", "kubectl") && alike("post gress", "Postgres") && alike("engine x", "nginx"));
        assert!(alike("jason", "JSON") && alike("nest dev", "feature/nest_dev") && alike("Cooper Netties", "Kubernetes"));
        assert!(!alike("Bob", "Alice") && !alike("Friday", "Monday") && !alike("report", "summary"));
        assert!(sounds_alike(&Correction { phrase: "GitHub".into(), replacement: None }));
    }
}
