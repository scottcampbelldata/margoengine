use crate::attrs::{input, Attrs};
use crate::tensor::{Number, Result, Tensor};
pub fn supports(op: &str) -> bool {
    matches!(op, "LinearClassifier" | "LinearRegressor")
}
pub fn validate(op: &str, n: usize, nout: usize, a: &Attrs) -> Result<()> {
    if n != 1 || nout != if op == "LinearClassifier" { 2 } else { 1 } {
        return Err("linear ML operator has invalid input/output arity; repair its node".into());
    }
    a.known(if op == "LinearClassifier" {
        &[
            "classlabels_ints",
            "classlabels_strings",
            "coefficients",
            "intercepts",
            "multi_class",
            "post_transform",
        ]
    } else {
        &["coefficients", "intercepts", "targets", "post_transform"]
    })
}
pub fn probit(p: f64) -> f64 {
    if p == 0. {
        return f64::NEG_INFINITY;
    }
    if p == 1. {
        return f64::INFINITY;
    }
    if !(0. ..1.).contains(&p) {
        return f64::NAN;
    }
    let lower = p < 0.5;
    let tail = if lower { p } else { 1. - p };
    let mut lo = 0.;
    let mut hi = 40.;
    // Invert the smaller normal tail, avoiding 1-CDF cancellation. NIST DLMF 7.9/8.9.
    for _ in 0..64 {
        let mid = (lo + hi) * 0.5;
        if 0.5 * crate::element::erfc(mid / std::f64::consts::SQRT_2) > tail {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let z = (lo + hi) * 0.5;
    if lower {
        -z
    } else {
        z
    }
}
pub fn post(values: &mut [f64], mode: &str) -> Result<()> {
    match mode{
        "NONE"=>{},
        "LOGISTIC"=>for v in values{*v=if *v>=0.{1./(1.+(-*v).exp())}else{let e=v.exp();e/(1.+e)};},
        "PROBIT"=>for v in values{*v=probit(*v);},
        "SOFTMAX"|"SOFTMAX_ZERO"=>{
            let max=values.iter().copied().fold(f64::NEG_INFINITY,f64::max);
            let mut total=0.;for v in values.iter_mut(){*v=if mode=="SOFTMAX_ZERO"&&*v==0.{0.}else{(*v-max).exp()};total+=*v;}
            if total!=0. {for v in values{*v/=total;}}
        }
        _=>return Err("ML post_transform must be NONE, LOGISTIC, SOFTMAX, SOFTMAX_ZERO or PROBIT; repair attribute".into()),
    }
    Ok(())
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    if !matches!(x.kind, 1 | 6 | 7 | 11) || !matches!(x.shape.len(), 1 | 2) {
        return Err(
            "linear ML input must be float/integer[C] or [N,C]; repair its dtype/shape".into(),
        );
    }
    let features = *x.shape.last().unwrap();
    let rows = if x.shape.len() == 1 { 1 } else { x.shape[0] };
    let coefficients = a
        .floats("coefficients")?
        .ok_or("linear ML requires coefficients; supply model weights")?;
    let intercepts = a.floats("intercepts")?.unwrap_or_default();
    let labels_int = a.ints("classlabels_ints")?;
    let labels_string = a.strings("classlabels_strings")?;
    let classifier = op == "LinearClassifier";
    if classifier && labels_int.is_some() == labels_string.is_some() {
        return Err("LinearClassifier requires one class label list; repair class labels".into());
    }
    let targets = if classifier {
        labels_int
            .as_ref()
            .map_or_else(|| labels_string.as_ref().unwrap().len(), Vec::len)
    } else {
        let n = a.int("targets", 1)?;
        if n < 1 {
            return Err("LinearRegressor targets must be positive; repair targets".into());
        }
        n as usize
    };
    if targets == 0 {
        return Err("LinearClassifier needs at least one class; supply labels".into());
    }
    let learned = if features == 0 {
        if classifier && intercepts.len() == 1 && targets == 2 {
            1
        } else {
            targets
        }
    } else {
        coefficients.len() / features
    };
    if coefficients.len() != learned * features
        || learned != targets && !(classifier && targets == 2 && learned == 1)
        || !intercepts.is_empty() && intercepts.len() != learned
    {
        return Err("linear ML coefficients/intercepts do not match input features and target count; repair parameters".into());
    }
    let multi = if classifier {
        a.flag("multi_class", false)?
    } else {
        false
    };
    let transform = a.string("post_transform", "NONE")?;
    let mut z = Tensor::zeros(1, vec![rows, targets])?;
    let mut chosen = Vec::new();
    for row in 0..rows {
        let mut scores = vec![0.; learned];
        for c in 0..learned {
            scores[c] = intercepts.get(c).copied().unwrap_or(0.);
            for j in 0..features {
                scores[c] += x.get(row * features + j).f() * coefficients[c * features + j];
            }
        }
        let selected = if learned == 1 && targets == 2 {
            usize::from(scores[0] > 0.)
        } else {
            let mut best = 0;
            for c in 1..learned {
                if scores[c] > scores[best] {
                    best = c;
                }
            }
            best
        };
        if classifier {
            chosen.push(selected);
        }
        if learned == 1 && targets == 2 {
            let margin = scores[0];
            scores = if multi {
                vec![-margin, margin]
            } else if transform == "LOGISTIC" {
                let mut v = [margin];
                post(&mut v, "LOGISTIC")?;
                vec![1. - v[0], v[0]]
            } else {
                vec![1. - margin, margin]
            };
            if multi || transform == "PROBIT" {
                post(&mut scores, transform)?;
            }
        } else {
            post(&mut scores, transform)?;
        }
        for c in 0..targets {
            z.set(row * targets + c, Number::F(scores[c]));
        }
    }
    if !classifier {
        return Ok(vec![z]);
    }
    let y = if let Some(labels) = labels_int {
        let mut y = Tensor::zeros(7, vec![rows])?;
        for (row, &c) in chosen.iter().enumerate() {
            y.set(row, Number::I(labels[c]));
        }
        y
    } else {
        let labels = labels_string.unwrap();
        Tensor::text(
            vec![rows],
            chosen
                .iter()
                .map(|&c| labels[c].as_bytes().to_vec())
                .collect(),
        )?
    };
    Ok(vec![y, z])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_quantiles_preserve_extreme_tails_and_endpoints() {
        for (p, z) in [
            (0.5, 0.),
            (0.975, 1.959963984540054),
            (0.2, -0.8416212335729143),
            (1e-20, -9.262340089798409),
            (1e-40, -13.31092137142517),
        ] {
            assert!((probit(p) - z).abs() < 2e-13);
        }
        assert_eq!(probit(0.), f64::NEG_INFINITY);
        assert_eq!(probit(1.), f64::INFINITY);
        assert!(probit(-1.).is_nan());
    }
}
