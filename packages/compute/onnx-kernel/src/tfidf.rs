//! ONNX TfIdfVectorizer, written from https://onnx.ai/onnx/operators/onnx__TfIdfVectorizer.html . N-grams with
//! skips follow Guthrie et al., "A Closer Look at Skip-gram Modelling", 2006; the weighting is Sparck Jones,
//! "A statistical interpretation of term specificity and its application in retrieval", 1972.
use crate::attrs::{input, Attrs};
use crate::tensor::{elements, Number, Result, Tensor};
use std::collections::HashMap;

const REPAIR: &str = "repair the TfIdfVectorizer pool attributes";

pub fn supports(op: &str) -> bool {
    op == "TfIdfVectorizer"
}

fn positive(a: &Attrs, name: &str, least: i64) -> Result<usize> {
    let v = a.int(name, i64::MIN)?;
    if v < least {
        Err(format!("TfIdfVectorizer requires {name} of at least {least}"))
    } else {
        Ok(v as usize)
    }
}

fn indices(a: &Attrs, name: &str) -> Result<Vec<usize>> {
    a.ints(name)?
        .ok_or_else(|| format!("TfIdfVectorizer requires {name}"))?
        .into_iter()
        .map(|v| usize::try_from(v).map_err(|_| format!("{name} must be nonnegative; {REPAIR}")))
        .collect()
}

#[derive(Hash, PartialEq, Eq)]
enum Token<'a> {
    Text(&'a [u8]),
    Integer(i64),
}

pub fn execute(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let shortest = positive(a, "min_gram_length", 1)?;
    let longest = positive(a, "max_gram_length", 1)?;
    let skips = positive(a, "max_skip_count", 0)?;
    let mode = a.string("mode", "")?;
    if !matches!(mode, "TF" | "IDF" | "TFIDF") || longest < shortest {
        return Err("TfIdfVectorizer needs mode TF, IDF or TFIDF and ordered gram lengths".into());
    }
    let counts = indices(a, "ngram_counts")?;
    let targets = indices(a, "ngram_indexes")?;
    let words = a.strings("pool_strings")?;
    let numbers = a.ints("pool_int64s")?;
    let pool: Vec<Token> = match (&words, &numbers) {
        (Some(w), None) if x.kind == 8 => w.iter().map(|s| Token::Text(s.as_bytes())).collect(),
        (None, Some(n)) if matches!(x.kind, 6 | 7) => n.iter().map(|&v| Token::Integer(v)).collect(),
        _ => {
            return Err("TfIdfVectorizer needs pool_strings for string input or pool_int64s for int32/int64 input".into())
        }
    };
    // Section n of the pool holds the (n+1)-grams, flattened; ngram_indexes lists every n-gram in order.
    let mut grams: Vec<HashMap<&[u32], Vec<usize>>> = Vec::new();
    let mut vocabulary: HashMap<&Token, u32> = HashMap::new();
    let ids: Vec<u32> = pool
        .iter()
        .map(|t| {
            let next = vocabulary.len() as u32;
            *vocabulary.entry(t).or_insert(next)
        })
        .collect();
    let mut gram = 0;
    for (section, &start) in counts.iter().enumerate() {
        let n = section + 1;
        let end = counts.get(section + 1).copied().unwrap_or(ids.len());
        if (section == 0 && start != 0) || end < start || end > ids.len() || (end - start) % n != 0 {
            return Err(format!("ngram_counts do not split the pool into whole n-grams; {REPAIR}"));
        }
        let mut map: HashMap<&[u32], Vec<usize>> = HashMap::new();
        for key in ids[start..end].chunks_exact(n) {
            map.entry(key).or_default().push(gram);
            gram += 1;
        }
        grams.push(map);
    }
    if gram != targets.len() || gram == 0 {
        return Err(format!("ngram_indexes must list one output position per pool n-gram; {REPAIR}"));
    }
    let weights = a.floats("weights")?;
    if weights.as_ref().is_some_and(|w| w.len() != gram) {
        return Err(format!("weights must have one value per pool n-gram; {REPAIR}"));
    }
    let (rows, columns) = match x.shape[..] {
        [c] => (1, c),
        [n, c] => (n, c),
        _ => return Err("TfIdfVectorizer input must have shape [C] or [N,C]".into()),
    };
    let width = targets.iter().max().unwrap().checked_add(1).ok_or(REPAIR)?;
    let shape = if x.shape.len() == 1 {
        vec![width]
    } else {
        vec![rows, width]
    };
    let size = elements(&shape)?;
    let mut totals = vec![0u32; size];
    let mut y = Tensor::zeros(1, shape)?;
    // Which pool n-gram feeds each output position, for the weights.
    let mut weight_at = vec![None; width];
    for (g, &target) in targets.iter().enumerate() {
        weight_at[target] = Some(g);
    }
    for row in 0..rows {
        let tokens: Vec<Option<u32>> = (row * columns..(row + 1) * columns)
            .map(|i| {
                let token = match &x.strings {
                    Some(s) => Token::Text(&s[i]),
                    None => Token::Integer(x.get(i).i()),
                };
                vocabulary.get(&token).copied()
            })
            .collect();
        let mut key = Vec::new();
        for n in shortest..=longest.min(grams.len()) {
            let map = &grams[n - 1];
            if map.is_empty() || n > columns {
                continue;
            }
            // A single token has no gaps, so skips never count it again.
            let widest = if n == 1 {
                0
            } else {
                skips.min((columns - n) / (n - 1))
            };
            for skip in 0..=widest {
                let step = skip + 1;
                for first in 0..columns - (n - 1) * step {
                    key.clear();
                    key.extend((0..n).map_while(|j| tokens[first + j * step]));
                    if key.len() == n {
                        if let Some(found) = map.get(key.as_slice()) {
                            for &g in found {
                                totals[row * width + targets[g]] += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    for (i, &count) in totals.iter().enumerate() {
        if count == 0 {
            continue;
        }
        let weight = match (&weights, weight_at[i % width]) {
            (Some(w), Some(g)) => w[g],
            _ => 1.,
        };
        let value = match mode {
            "TF" => count as f64,
            "IDF" => weight,
            _ => count as f64 * weight,
        };
        y.set(i, Number::F(value));
    }
    Ok(vec![y])
}
