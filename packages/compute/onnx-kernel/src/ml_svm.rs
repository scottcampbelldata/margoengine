// ONNX kernel expansion and Wu, Lin and Weng (2004), equations 22 and 26-27.
use crate::attrs::{input, Attrs};
use crate::ml_linear::post;
use crate::tensor::{Number, Result, Tensor, MAX_ELEMENTS};

pub fn supports(op: &str) -> bool {
    matches!(op, "SVMClassifier" | "SVMRegressor")
}
pub fn validate(op: &str, n: usize, nout: usize, a: &Attrs) -> Result<()> {
    if n != 1 || nout != if op == "SVMClassifier" { 2 } else { 1 } {
        return Err("SVM needs one input and its declared outputs; repair node arity".into());
    }
    a.known(if op == "SVMClassifier" {
        &[
            "classlabels_ints",
            "classlabels_strings",
            "coefficients",
            "kernel_params",
            "kernel_type",
            "post_transform",
            "prob_a",
            "prob_b",
            "rho",
            "support_vectors",
            "vectors_per_class",
        ]
    } else {
        &[
            "coefficients",
            "kernel_params",
            "kernel_type",
            "n_supports",
            "one_class",
            "post_transform",
            "rho",
            "support_vectors",
        ]
    })
}
fn floats(a: &Attrs, name: &str) -> Result<Vec<f64>> {
    let v = a.floats(name)?.unwrap_or_default();
    if v.iter().any(|v| !v.is_finite()) {
        return Err(format!(
            "SVM {name} must be finite; repair model parameters"
        ));
    }
    Ok(v)
}
fn kernel(x: &Tensor, row: usize, features: usize, v: &[f64], mode: &str, p: &[f64]) -> f64 {
    let mut dot = 0.;
    let mut distance = 0.;
    for (j, &w) in v.iter().enumerate() {
        let a = x.get(row * features + j).f();
        dot += a * w;
        distance += (a - w) * (a - w);
    }
    match mode {
        "LINEAR" => dot,
        "POLY" => (p[0] * dot + p[1]).powf(p[2]),
        "RBF" => (-p[0] * distance).exp(),
        "SIGMOID" => (p[0] * dot + p[1]).tanh(),
        _ => unreachable!(),
    }
}
fn logistic_negative(x: f64) -> f64 {
    if x >= 0. {
        let e = (-x).exp();
        e / (1. + e)
    } else {
        1. / (1. + x.exp())
    }
}
// A deterministic coordinate solve of the paper's convex coupling objective. The residual
// threshold is its practical 0.005/k convention, with an explicit failure on exhaustion.
fn couple(r: &[f64], k: usize) -> Result<Vec<f64>> {
    if k.checked_mul(k).is_none_or(|n| n > MAX_ELEMENTS) {
        return Err("SVM probability workspace exceeds 16777216 scalars; use fewer classes".into());
    }
    let mut q = vec![0.; k * k];
    for i in 0..k {
        for j in 0..k {
            if i != j {
                q[i * k + i] += r[j * k + i] * r[j * k + i];
                q[i * k + j] = -r[i * k + j] * r[j * k + i];
            }
        }
    }
    let mut p = vec![1. / k as f64; k];
    let mut qp = vec![0.; k];
    for _ in 0..k.max(100) {
        for i in 0..k {
            qp[i] = (0..k).map(|j| q[i * k + j] * p[j]).sum();
        }
        let mut energy = (0..k).map(|i| p[i] * qp[i]).sum::<f64>();
        if qp.iter().all(|&v| (v - energy).abs() < 0.005 / k as f64) {
            return Ok(p);
        }
        for t in 0..k {
            let delta = (energy - qp[t]) / q[t * k + t];
            let scale = 1. + delta;
            p[t] += delta;
            energy = (energy + delta * (2. * qp[t] + delta * q[t * k + t])) / (scale * scale);
            for j in 0..k {
                qp[j] = (qp[j] + delta * q[j * k + t]) / scale;
                p[j] /= scale;
            }
        }
    }
    Err(
        "SVM probability coupling did not converge; repair ill-conditioned probability calibration"
            .into(),
    )
}
fn best(v: &[f64]) -> usize {
    let mut b = 0;
    for j in 1..v.len() {
        if v[j] > v[b] {
            b = j;
        }
    }
    b
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    if !matches!(x.kind, 1 | 6 | 7 | 11) || !matches!(x.shape.len(), 1 | 2) {
        return Err("SVM input must be float/integer [C] or [N,C]; repair its dtype/shape".into());
    }
    let features = *x.shape.last().unwrap();
    let rows = if x.shape.len() == 1 { 1 } else { x.shape[0] };
    let classifier = op == "SVMClassifier";
    let mode = a.string("kernel_type", "LINEAR")?;
    if !["LINEAR", "POLY", "RBF", "SIGMOID"].contains(&mode) {
        return Err(
            "SVM kernel_type must be LINEAR, POLY, RBF or SIGMOID; repair attribute".into(),
        );
    }
    let params = if a.has("kernel_params") {
        floats(a, "kernel_params")?
    } else {
        vec![0.; 3]
    };
    if params.len() != 3
        || params[0] < 0.
        || mode == "POLY" && (params[2] < 0. || params[2].fract() != 0.)
    {
        return Err("SVM kernel_params needs gamma>=0, coef0 and a nonnegative integer degree; repair kernel parameters".into());
    }
    let weights = floats(a, "coefficients")?;
    let vectors = floats(a, "support_vectors")?;
    let rho = floats(a, "rho")?;
    let post_mode = a.string("post_transform", "NONE")?;
    post(&mut [], post_mode)?;
    let labels_i = a.ints("classlabels_ints")?;
    let labels_s = a.strings("classlabels_strings")?;
    let classes = if classifier {
        if labels_i.is_some() == labels_s.is_some() {
            return Err("SVM classifier needs exactly one class label list; supply integer or string labels".into());
        }
        labels_i
            .as_ref()
            .map_or_else(|| labels_s.as_ref().unwrap().len(), Vec::len)
    } else {
        1
    };
    if classes == 0 || classes > MAX_ELEMENTS || classifier && classes < 2 {
        return Err("SVM classifier requires at least two classes within the tensor limit; repair class labels".into());
    }
    let counts = if classifier {
        a.ints("vectors_per_class")?
            .unwrap_or_else(|| vec![0; classes])
    } else {
        vec![a.int("n_supports", 0)?]
    };
    if counts.len() != classes
        || counts
            .iter()
            .any(|&n| n < 0 || n as u64 > MAX_ELEMENTS as u64)
    {
        return Err(
            "SVM support counts must be nonnegative and match classes; repair vector counts".into(),
        );
    }
    let supports = counts
        .iter()
        .try_fold(0usize, |s, &n| s.checked_add(n as usize))
        .ok_or("SVM support count overflow; reduce support counts")?;
    if supports > MAX_ELEMENTS
        || supports.checked_mul(features) != Some(vectors.len())
        || supports == 0 && !vectors.is_empty()
    {
        return Err("SVM support_vectors length does not match count and input features; repair vector storage".into());
    }
    let pairs = classes
        .checked_mul(classes - 1)
        .ok_or("SVM class pair count overflow; reduce classes")?
        / 2;
    let learned = if classifier {
        if supports > 0 {
            classes - 1
        } else {
            classes
        }
    } else {
        1
    };
    let width = if supports > 0 { supports } else { features };
    if learned.checked_mul(width) != Some(weights.len())
        || rho.len() != if classifier && supports > 0 { pairs } else { 1 }
    {
        return Err(
            "SVM coefficient/rho lengths do not match class and support counts; repair parameters"
                .into(),
        );
    }
    let pa = floats(a, "prob_a")?;
    let pb = floats(a, "prob_b")?;
    if pa.len() != pb.len() || !pa.is_empty() && (!classifier || supports == 0 || pa.len() != pairs)
    {
        return Err("SVM probability calibration must provide one prob_a/prob_b pair per class pair; repair calibration".into());
    }
    if !pa.is_empty()
        && classes
            .checked_mul(classes)
            .is_none_or(|n| n > MAX_ELEMENTS)
    {
        return Err("SVM probability workspace exceeds 16777216 scalars; use fewer classes".into());
    }
    let score_count = if classifier && supports > 0 && pa.is_empty() {
        if classes == 2 {
            2
        } else {
            pairs
        }
    } else {
        classes
    };
    let mut out = Tensor::zeros(1, vec![rows, score_count])?;
    let mut chosen = Vec::with_capacity(rows);
    let one_class = if classifier {
        false
    } else {
        a.flag("one_class", false)?
    };
    let mut starts = vec![0usize; classes + 1];
    for j in 0..classes {
        starts[j + 1] = starts[j] + counts[j] as usize;
    }
    for row in 0..rows {
        let mut scores = Vec::new();
        let label;
        if supports == 0 {
            for c in 0..classes {
                let mut s = rho[0];
                for j in 0..features {
                    s += weights[c * features + j] * x.get(row * features + j).f();
                }
                scores.push(s);
            }
            label = best(&scores);
        } else {
            let kernels = (0..supports)
                .map(|j| {
                    kernel(
                        x,
                        row,
                        features,
                        &vectors[j * features..(j + 1) * features],
                        mode,
                        &params,
                    )
                })
                .collect::<Vec<_>>();
            if !classifier {
                scores.push(
                    rho[0]
                        + weights
                            .iter()
                            .zip(&kernels)
                            .map(|(w, k)| w * k)
                            .sum::<f64>(),
                );
                label = 0;
            } else {
                let mut votes = vec![0.; classes];
                let mut pair = 0;
                for i in 0..classes {
                    for j in i + 1..classes {
                        let mut s = rho[pair];
                        for v in starts[i]..starts[i + 1] {
                            s += weights[(j - 1) * supports + v] * kernels[v];
                        }
                        for v in starts[j]..starts[j + 1] {
                            s += weights[i * supports + v] * kernels[v];
                        }
                        votes[if s > 0. { i } else { j }] += 1.;
                        scores.push(s);
                        pair += 1;
                    }
                }
                label = best(&votes);
                if !pa.is_empty() {
                    let mut r = vec![0.; classes * classes];
                    let mut t = 0;
                    for i in 0..classes {
                        for j in i + 1..classes {
                            let p =
                                logistic_negative(scores[t] * pa[t] + pb[t]).clamp(1e-7, 1. - 1e-7);
                            r[i * classes + j] = p;
                            r[j * classes + i] = 1. - p;
                            t += 1;
                        }
                    }
                    scores = couple(&r, classes)?;
                } else if classes == 2 {
                    scores = vec![-scores[0], scores[0]];
                }
            }
        }
        if one_class {
            scores[0] = if scores[0] > 0. { 1. } else { -1. };
        }
        post(&mut scores, post_mode)?;
        for (j, s) in scores.into_iter().enumerate() {
            out.set(row * score_count + j, Number::F(s));
        }
        chosen.push(label);
    }
    if !classifier {
        return Ok(vec![out]);
    }
    let labels = if let Some(v) = labels_i {
        let mut t = Tensor::zeros(7, vec![rows])?;
        for (i, c) in chosen.into_iter().enumerate() {
            t.set(i, Number::I(v[c]));
        }
        t
    } else {
        let v = labels_s.unwrap();
        Tensor::text(
            vec![rows],
            chosen
                .into_iter()
                .map(|c| v[c].as_bytes().to_vec())
                .collect(),
        )?
    };
    Ok(vec![labels, out])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probability_coupling_preserves_uniform_and_consistent_distributions() {
        assert_eq!(couple(&[0., 0.5, 0.5, 0.], 2).unwrap(), vec![0.5, 0.5]);
        let p = [0.2, 0.3, 0.5];
        let mut r = vec![0.; 9];
        for i in 0..3 {
            for j in 0..3 {
                if i != j {
                    r[i * 3 + j] = p[i] / (p[i] + p[j]);
                }
            }
        }
        let got = couple(&r, 3).unwrap();
        for i in 0..3 {
            assert!((got[i] - p[i]).abs() < 0.001);
        }
        assert!((got.iter().sum::<f64>() - 1.).abs() < 1e-14);
    }
    #[test]
    fn calibrated_sigmoid_handles_extreme_margins() {
        assert_eq!(logistic_negative(1000.), 0.);
        assert_eq!(logistic_negative(-1000.), 1.);
        assert_eq!(logistic_negative(0.), 0.5);
    }
}
