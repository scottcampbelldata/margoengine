use crate::attrs::{floating, input, optional, Attrs};
use crate::tensor::{axis, broadcast, broadcast_index, product, Number, Result, Tensor};
pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "BatchNormalization"
            | "InstanceNormalization"
            | "GroupNormalization"
            | "LayerNormalization"
            | "RMSNormalization"
            | "LRN"
            | "MeanVarianceNormalization"
            | "LpNormalization"
    )
}
fn stats(
    x: &Tensor,
    indices: impl Iterator<Item = usize> + Clone,
    round: impl Fn(f64) -> f64,
    rms: bool,
) -> (f64, f64) {
    let mut sum = 0.;
    let mut n = 0;
    for i in indices.clone() {
        sum = round(sum + round(x.get(i).f()));
        n += 1;
    }
    let mean = if rms { 0. } else { round(sum / n as f64) };
    let mut sq = 0.;
    for i in indices {
        let d = round(round(x.get(i).f()) - mean);
        sq = round(sq + round(d * d));
    }
    (mean, round(sq / n as f64))
}
pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    a: &Attrs,
    version: u32,
    nout: usize,
) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    floating(x)?;
    let epsilon = a.float("epsilon", 1e-5)?;
    if !epsilon.is_finite() || epsilon < 0. {
        return Err(
            "normalization epsilon must be finite and nonnegative; choose a valid epsilon".into(),
        );
    }
    let mut y = Tensor::zeros(x.kind, x.shape.clone())?;
    if op == "LRN" {
        if x.shape.len() < 3 {
            return Err(
                "LRN requires channels-first input with spatial axes; supply N,C,... dimensions"
                    .into(),
            );
        }
        let size = a.int("size", 0)?;
        if size <= 0 {
            return Err("LRN size must be positive; choose a positive channel neighborhood".into());
        }
        let c = x.shape[1];
        let inner = product(&x.shape[2..])?;
        let alpha = a.float("alpha", 0.0001)?;
        let beta = a.float("beta", 0.75)?;
        let bias = a.float("bias", 1.)?;
        for i in 0..x.size() {
            let ch = i / inner % c;
            let batch = i / (c * inner);
            let q = i % inner;
            let start = (ch as i128 - (size as i128 - 1) / 2).max(0) as usize;
            let end = (ch as i128 + size as i128 / 2 + 1).min(c as i128) as usize;
            let mut square = 0.;
            for j in start..end {
                let v = x.get((batch * c + j) * inner + q).f();
                square += v * v;
            }
            y.set(
                i,
                Number::F(x.get(i).f() / (bias + alpha / size as f64 * square).powf(beta)),
            );
        }
        return Ok(vec![y]);
    }
    if matches!(op, "LayerNormalization" | "RMSNormalization") {
        let d = axis(a.int("axis", -1)?, x.shape.len())?;
        let inner = product(&x.shape[d..])?;
        let outer = product(&x.shape[..d])?;
        let stash = a.int("stash_type", 1)?;
        if !matches!(stash, 1 | 11) {
            return Err("normalization stash_type must be FLOAT or DOUBLE; choose a supported accumulation type".into());
        }
        let round = |v: f64| if stash == 1 { v as f32 as f64 } else { v };
        let scale = input(inputs, 1)?;
        floating(scale)?;
        let bias = optional(inputs, 2);
        for t in [Some(scale), bias].into_iter().flatten() {
            floating(t)?;
            if broadcast(&t.shape, &x.shape)? != x.shape {
                return Err(
                    "normalization scale/bias must broadcast to X; supply compatible affine inputs"
                        .into(),
                );
            }
        }
        let mut dims = x.shape[..d].to_vec();
        dims.extend(vec![1; x.shape.len() - d]);
        let mut means = Tensor::zeros(stash as u32, dims.clone())?;
        let mut invs = Tensor::zeros(stash as u32, dims)?;
        let rms = op == "RMSNormalization";
        if rms {
            y = Tensor::zeros(scale.kind, x.shape.clone())?;
        }
        for row in 0..outer {
            let (mean, var) = stats(x, row * inner..(row + 1) * inner, round, rms);
            let inv = round(1. / round(round(var + round(epsilon)).sqrt()));
            means.set(row, Number::F(mean));
            invs.set(row, Number::F(inv));
            for j in 0..inner {
                let i = row * inner + j;
                let norm = round(round(round(x.get(i).f()) - mean) * inv);
                let v = norm * scale.get(broadcast_index(i, &x.shape, &scale.shape)).f()
                    + bias.map_or(0., |b| b.get(broadcast_index(i, &x.shape, &b.shape)).f());
                y.set(i, Number::F(v));
            }
        }
        return Ok(if rms { vec![y] } else { vec![y, means, invs] });
    }
    if op == "MeanVarianceNormalization" || op == "LpNormalization" {
        let axes = if op == "LpNormalization" {
            vec![a.int("axis", -1)?]
        } else {
            a.ints("axes")?.unwrap_or(vec![0, 2, 3])
        };
        let mut reduced = vec![false; x.shape.len()];
        for d in axes {
            let d = axis(d, x.shape.len())?;
            if reduced[d] {
                return Err("normalization axes must be unique; remove duplicates".into());
            }
            reduced[d] = true;
        }
        let mut shape = x.shape.clone();
        for (d, n) in shape.iter_mut().enumerate() {
            if reduced[d] {
                *n = 1;
            }
        }
        let groups = product(&shape)?;
        let mut sums = vec![0.; groups];
        let mut sq = vec![0.; groups];
        let mut counts = vec![0usize; groups];
        let p = a.int("p", 2)?;
        if op == "LpNormalization" && !matches!(p, 1 | 2) {
            return Err("LpNormalization supports p=1 or p=2; choose a supported norm".into());
        }
        let xs = crate::tensor::strides(&x.shape);
        let gs = crate::tensor::strides(&shape);
        let group = |i: usize| -> usize {
            (0..shape.len())
                .map(|d| {
                    if reduced[d] {
                        0
                    } else {
                        i / xs[d] % x.shape[d] * gs[d]
                    }
                })
                .sum()
        };
        for i in 0..x.size() {
            let g = group(i);
            let v = x.get(i).f();
            sums[g] += v;
            counts[g] += 1;
        }
        for i in 0..x.size() {
            let g = group(i);
            let v = x.get(i).f();
            sq[g] += if op == "LpNormalization" {
                if p == 1 {
                    v.abs()
                } else {
                    v * v
                }
            } else {
                let d = v - sums[g] / counts[g] as f64;
                d * d
            };
        }
        for i in 0..x.size() {
            let g = group(i);
            let v = x.get(i).f();
            y.set(
                i,
                Number::F(if op == "LpNormalization" {
                    let norm = if p == 1 { sq[g] } else { sq[g].sqrt() };
                    if norm == 0. {
                        0.
                    } else {
                        v / norm
                    }
                } else {
                    (v - sums[g] / counts[g] as f64) / ((sq[g] / counts[g] as f64).sqrt() + 1e-9)
                }),
            );
        }
        return Ok(vec![y]);
    }
    if x.shape.len() < 2 {
        return Err(
            "channel normalization requires N,C,... input; supply a channel dimension".into(),
        );
    }
    let channels = x.shape[1];
    let inner = product(&x.shape[2..])?;
    let batches = x.shape[0];
    let scale = input(inputs, 1)?;
    let bias = input(inputs, 2)?;
    floating(scale)?;
    floating(bias)?;
    if op == "BatchNormalization" {
        let mean = input(inputs, 3)?;
        let var = input(inputs, 4)?;
        for t in [scale, bias, mean, var] {
            floating(t)?;
            if t.shape != [channels] {
                return Err("BatchNormalization affine/statistic inputs must have shape [C]; supply channel vectors".into());
            }
        }
        let training = if version < 14 {
            nout > 1
        } else {
            a.flag("training_mode", false)?
        };
        if !training && nout > 1 {
            return Err(
                "inference BatchNormalization has only one output; remove training outputs".into(),
            );
        }
        let momentum = a.float("momentum", 0.9)?;
        let mut running_mean = mean.clone();
        let mut running_var = var.clone();
        let mut saved_mean = Tensor::zeros(mean.kind, vec![channels])?;
        let mut saved_var = Tensor::zeros(var.kind, vec![channels])?;
        for c in 0..channels {
            let indices =
                (0..batches * inner).map(|i| (i / inner * channels + c) * inner + i % inner);
            let (m, v) = if training {
                stats(x, indices.clone(), |v| v, false)
            } else {
                (mean.get(c).f(), var.get(c).f())
            };
            saved_mean.set(c, Number::F(m));
            saved_var.set(c, Number::F(v));
            if training {
                running_mean.set(
                    c,
                    Number::F(momentum * mean.get(c).f() + (1. - momentum) * m),
                );
                running_var.set(
                    c,
                    Number::F(momentum * var.get(c).f() + (1. - momentum) * v),
                );
            }
            for i in indices {
                y.set(
                    i,
                    Number::F(
                        (x.get(i).f() - m) / (v + epsilon).sqrt() * scale.get(c).f()
                            + bias.get(c).f(),
                    ),
                );
            }
        }
        return Ok(if !training {
            vec![y]
        } else if version < 14 {
            vec![y, running_mean, running_var, saved_mean, saved_var]
        } else {
            vec![y, running_mean, running_var]
        });
    }
    let groups = if op == "InstanceNormalization" {
        channels
    } else {
        let n = a.int("num_groups", 0)?;
        if n <= 0 || channels % n as usize != 0 {
            return Err(
                "num_groups must be positive and divide channels; choose a valid group count"
                    .into(),
            );
        }
        n as usize
    };
    let old = op == "GroupNormalization" && version < 21;
    let affine = if old { groups } else { channels };
    for t in [scale, bias] {
        if t.shape != [affine] {
            return Err("normalization affine shape differs from channels/groups; supply the vector required by this opset".into());
        }
    }
    let width = if groups == 0 {
        0
    } else {
        channels / groups * inner
    };
    let stash = if op == "GroupNormalization" && version >= 21 {
        a.int("stash_type", 1)?
    } else {
        11
    };
    if !matches!(stash, 1 | 11) {
        return Err(
            "normalization stash_type must be FLOAT or DOUBLE; choose a supported type".into(),
        );
    }
    let round = |v: f64| if stash == 1 { v as f32 as f64 } else { v };
    for batch in 0..batches {
        for group in 0..groups {
            let start = (batch * groups + group) * width;
            let (mean, var) = stats(x, start..start + width, round, false);
            let inv = round(1. / round(round(var + round(epsilon)).sqrt()));
            for i in start..start + width {
                let c = if old { group } else { i / inner % channels };
                let norm = round(round(round(x.get(i).f()) - mean) * inv);
                y.set(i, Number::F(norm * scale.get(c).f() + bias.get(c).f()));
            }
        }
    }
    Ok(vec![y])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    fn tensor(shape: Vec<usize>, v: &[f32]) -> Tensor {
        Tensor::raw(1, shape, v.iter().flat_map(|n| n.to_le_bytes()).collect()).unwrap()
    }
    #[test]
    fn batch_inference_and_training_population_variance() {
        let s = Store::new();
        let x = tensor(vec![2, 1, 2], &[1., 3., 5., 7.]);
        let inputs = vec![
            Some(x),
            Some(tensor(vec![1], &[2.])),
            Some(tensor(vec![1], &[1.])),
            Some(tensor(vec![1], &[4.])),
            Some(tensor(vec![1], &[5.])),
        ];
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let y = execute("BatchNormalization", &inputs, &a, 15, 1).unwrap();
        assert!((y[0].get(0).f() - (1. - 6. / (5.00001f64).sqrt())).abs() < 1e-6);
        let entries = vec![Json::object([
            ("name", Json::s("training_mode")),
            ("kind", Json::n(2)),
            ("value", Json::s("1")),
        ])];
        let a = Attrs {
            entries: &entries,
            store: &s,
        };
        let y = execute("BatchNormalization", &inputs, &a, 15, 3).unwrap();
        assert_eq!(y[1].get(0).f(), 4.);
        assert_eq!(y[2].get(0).f(), 5.);
    }
    #[test]
    fn layer_outputs_and_group_channel_affine() {
        let s = Store::new();
        let x = tensor(vec![2, 2], &[1., 3., 5., 7.]);
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let y = execute(
            "LayerNormalization",
            &[Some(x), Some(tensor(vec![2], &[1., 1.]))],
            &a,
            17,
            3,
        )
        .unwrap();
        assert_eq!(y[1].shape, vec![2, 1]);
        assert_eq!(y[1].get(0).f(), 2.);
        assert_eq!(y[1].get(1).f(), 6.);
        let entries = vec![Json::object([
            ("name", Json::s("num_groups")),
            ("kind", Json::n(2)),
            ("value", Json::s("1")),
        ])];
        let a = Attrs {
            entries: &entries,
            store: &s,
        };
        let y = execute(
            "GroupNormalization",
            &[
                Some(tensor(vec![1, 2, 1], &[1., 3.])),
                Some(tensor(vec![2], &[1., 2.])),
                Some(tensor(vec![2], &[0., 1.])),
            ],
            &a,
            21,
            1,
        )
        .unwrap();
        assert!((y[0].get(0).f() + 1.).abs() < 1e-5);
        assert!((y[0].get(1).f() - 3.).abs() < 2e-5);
    }
}
