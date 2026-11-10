use crate::attrs::{floating, input, same_type, Attrs};
use crate::tensor::{axis, elements, product, strides, width, Number, Result, Tensor};
use std::cmp::Ordering;

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "Unique"
            | "ReverseSequence"
            | "Det"
            | "CenterCropPad"
            | "BitCast"
            | "Celu"
            | "Shrink"
            | "Swish"
            | "SwiGLU"
    )
}
fn compare(x: &Tensor, i: usize, j: usize) -> Ordering {
    if let Some(strings) = &x.strings {
        return strings[i].cmp(&strings[j]);
    }
    x.get(i)
        .cmp(x.get(j))
        .unwrap_or_else(|| match (x.get(i).f().is_nan(), x.get(j).f().is_nan()) {
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            _ => Ordering::Equal,
        })
}
fn unique(x: &Tensor, a: &Attrs, nout: usize) -> Result<Vec<Tensor>> {
    let d = if a.has("axis") {
        Some(axis(a.int("axis", 0)?, x.shape.len())?)
    } else {
        None
    };
    let n = d.map_or(x.size(), |d| x.shape[d]);
    elements(&[n])?;
    let inner = if let Some(d) = d {
        product(&x.shape[d + 1..])?
    } else {
        1
    };
    let outer = if let Some(d) = d {
        product(&x.shape[..d])?
    } else {
        1
    };
    let cmp = |i: usize, j: usize| {
        for p in 0..outer {
            for q in 0..inner {
                let c = compare(x, (p * n + i) * inner + q, (p * n + j) * inner + q);
                if c != Ordering::Equal {
                    return c;
                }
            }
        }
        Ordering::Equal
    };
    let mut order: Vec<_> = (0..n).collect();
    order.sort_by(|&i, &j| cmp(i, j));
    let mut representatives = Vec::new();
    let mut counts: Vec<i64> = Vec::new();
    let mut inverse = vec![0i64; n];
    for i in order {
        if representatives
            .last()
            .is_none_or(|&j| cmp(i, j) != Ordering::Equal)
        {
            representatives.push(i);
            counts.push(0);
        }
        let group = representatives.len() - 1;
        counts[group] += 1;
        inverse[i] = group as i64;
    }
    if !a.flag("sorted", true)? {
        let mut groups: Vec<_> = (0..representatives.len()).collect();
        groups.sort_by_key(|&g| representatives[g]);
        let mut remap = vec![0; groups.len()];
        for (at, &g) in groups.iter().enumerate() {
            remap[g] = at;
        }
        for g in &mut inverse {
            *g = remap[*g as usize] as i64;
        }
        counts = groups.iter().map(|&g| counts[g]).collect();
        representatives = groups.iter().map(|&g| representatives[g]).collect();
    }
    let mut shape = if d.is_some() {
        x.shape.clone()
    } else {
        vec![n]
    };
    shape[d.unwrap_or(0)] = representatives.len();
    let mut y = Tensor::zeros(x.kind, shape)?;
    for (g, &i) in representatives.iter().enumerate() {
        for p in 0..outer {
            for q in 0..inner {
                y.copy_element(
                    (p * representatives.len() + g) * inner + q,
                    x,
                    (p * n + i) * inner + q,
                );
            }
        }
    }
    let mut result = vec![y];
    if nout > 1 {
        result.push(Tensor::vector_i64(
            &representatives
                .iter()
                .map(|&i| i as i64)
                .collect::<Vec<_>>(),
        )?);
    }
    if nout > 2 {
        result.push(Tensor::vector_i64(&inverse)?);
    }
    if nout > 3 {
        result.push(Tensor::vector_i64(&counts)?);
    }
    Ok(result)
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs, nout: usize) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    if op == "Unique" {
        return unique(x, a, nout);
    }
    let y = match op {
        "ReverseSequence" => {
            let batch = a.int("batch_axis", 1)?;
            let time = a.int("time_axis", 0)?;
            if x.shape.len() < 2
                || !matches!(batch, 0 | 1)
                || !matches!(time, 0 | 1)
                || time == batch
            {
                return Err("ReverseSequence needs distinct batch/time axes 0 and 1 and rank >=2; repair its attributes".into());
            }
            let batch = batch as usize;
            let time = time as usize;
            let lengths = input(inputs, 1)?;
            if lengths.kind != 7 || lengths.shape != [x.shape[batch]] {
                return Err(
                    "ReverseSequence lengths must be int64[batch]; repair its input".into(),
                );
            }
            let lengths = lengths.ints()?;
            if lengths.iter().any(|&n| n < 0 || n as usize > x.shape[time]) {
                return Err(
                    "ReverseSequence length is outside its time dimension; provide valid lengths"
                        .into(),
                );
            }
            let s = strides(&x.shape);
            let mut y = Tensor::zeros(x.kind, x.shape.clone())?;
            for i in 0..x.size() {
                let b = i / s[batch] % x.shape[batch];
                let t = i / s[time] % x.shape[time];
                let n = lengths[b] as usize;
                let j = if t < n {
                    i - t * s[time] + (n - 1 - t) * s[time]
                } else {
                    i
                };
                y.copy_element(i, x, j);
            }
            y
        }
        "CenterCropPad" => {
            let sizes = input(inputs, 1)?;
            if !matches!(sizes.kind, 6 | 7) || sizes.shape.len() != 1 {
                return Err(
                    "CenterCropPad shape must be an integer vector; repair its input".into(),
                );
            }
            let axes = a
                .ints("axes")?
                .unwrap_or_else(|| (0..x.shape.len() as i64).collect());
            if axes.len() != sizes.size() {
                return Err("CenterCropPad axes and shape lengths differ; repair shape".into());
            }
            let mut shape = x.shape.clone();
            let mut starts = vec![0i64; shape.len()];
            let mut used = vec![false; shape.len()];
            for (i, d) in axes.iter().enumerate() {
                let d = axis(*d, shape.len())?;
                let n = sizes.get(i).i();
                if used[d] || n < 0 || n > i32::MAX as i64 {
                    return Err("CenterCropPad requires unique axes and valid nonnegative dimensions; repair shape".into());
                }
                used[d] = true;
                starts[d] = if shape[d] as i64 >= n {
                    (shape[d] as i64 - n) / 2
                } else {
                    -((n - shape[d] as i64) / 2)
                };
                shape[d] = n as usize;
            }
            let mut y = Tensor::zeros(x.kind, shape.clone())?;
            let ys = strides(&shape);
            let xs = strides(&x.shape);
            for i in 0..y.size() {
                let mut at = 0;
                let mut inside = true;
                for d in 0..shape.len() {
                    let c = (i / ys[d] % shape[d]) as i64 + starts[d];
                    if c < 0 || c >= x.shape[d] as i64 {
                        inside = false;
                        break;
                    }
                    at += c as usize * xs[d];
                }
                if inside {
                    y.copy_element(i, x, at);
                }
            }
            y
        }
        "BitCast" => {
            let to = a.int("to", 0)? as u32;
            if x.kind == 8 || to == 8 || width(x.kind)? != width(to)? {
                return Err(
                    "BitCast needs equal bit widths and nonstring types; choose a compatible dtype"
                        .into(),
                );
            }
            let mut y = x.clone();
            y.kind = to;
            // A bool bitcast keeps its raw representation; numeric reads treat any nonzero byte as true.
            y
        }
        "Det" => {
            floating(x)?;
            let r = x.shape.len();
            if r < 2 || x.shape[r - 1] != x.shape[r - 2] {
                return Err("Det requires square matrices; repair its final two dimensions".into());
            }
            let n = x.shape[r - 1];
            let mut y = Tensor::zeros(x.kind, x.shape[..r - 2].to_vec())?;
            for b in 0..y.size() {
                let mut matrix: Vec<_> = (0..n * n).map(|i| x.get(b * n * n + i).f()).collect();
                let mut determinant = 1.;
                for k in 0..n {
                    let pivot = (k..n)
                        .max_by(|&i, &j| {
                            matrix[i * n + k].abs().total_cmp(&matrix[j * n + k].abs())
                        })
                        .unwrap();
                    if matrix[pivot * n + k] == 0. {
                        determinant = 0.;
                        break;
                    }
                    if pivot != k {
                        for j in 0..n {
                            matrix.swap(k * n + j, pivot * n + j);
                        }
                        determinant = -determinant;
                    }
                    let p = matrix[k * n + k];
                    determinant *= p;
                    for i in k + 1..n {
                        let m = matrix[i * n + k] / p;
                        for j in k + 1..n {
                            matrix[i * n + j] -= m * matrix[k * n + j];
                        }
                    }
                }
                y.set(b, Number::F(determinant));
            }
            y
        }
        "Celu" | "Swish" | "SwiGLU" | "Shrink" => {
            x.numeric()?;
            if op != "Shrink" {
                floating(x)?;
            }
            let b = if op == "SwiGLU" {
                let b = input(inputs, 1)?;
                same_type(x, b)?;
                if x.shape != b.shape {
                    return Err(
                        "SwiGLU inputs must have identical shapes; repair input dimensions".into(),
                    );
                }
                Some(b)
            } else {
                None
            };
            let alpha = a.float("alpha", 1.)?;
            let bias = a.float("bias", 0.)?;
            let lambd = a.float("lambd", 0.5)?;
            if op == "Celu" && alpha == 0. {
                return Err("Celu alpha must be nonzero; choose a valid alpha".into());
            }
            let mut y = Tensor::zeros(x.kind, x.shape.clone())?;
            // Cast Shrink's scalar attributes to the input dtype before arithmetic, as in its normative function.
            let mut scalar = Tensor::zeros(x.kind, vec![])?;
            scalar.set(0, Number::F(bias));
            let typed_bias = scalar.get(0);
            scalar.set(0, Number::F(lambd));
            let typed_lambda = scalar.get(0);
            let neg_lambda = match typed_lambda {
                Number::I(v) => Number::I(v.wrapping_neg()),
                Number::U(v) => Number::U(v.wrapping_neg()),
                Number::F(v) => Number::F(-v),
            };
            for i in 0..x.size() {
                let v = x.get(i);
                let f = v.f();
                let value = match op {
                    "Shrink" => {
                        if v.cmp(neg_lambda) == Some(Ordering::Less) {
                            v.add(typed_bias)
                        } else if v.cmp(typed_lambda) == Some(Ordering::Greater) {
                            v.sub(typed_bias)
                        } else {
                            Number::U(0)
                        }
                    }
                    "Celu" => Number::F(if f.is_nan() {
                        f
                    } else {
                        f.max(0.) + (alpha * (f / alpha).exp_m1()).min(0.)
                    }),
                    _ => {
                        let z = alpha * f;
                        let sigmoid = if z >= 0. {
                            1. / (1. + (-z).exp())
                        } else {
                            let e = z.exp();
                            e / (1. + e)
                        };
                        Number::F(f * sigmoid * b.map_or(1., |b| b.get(i).f()))
                    }
                };
                y.set(i, value);
            }
            y
        }
        _ => unreachable!(),
    };
    Ok(vec![y])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    fn attr(name: &str, n: i64) -> Json {
        Json::object([
            ("name", Json::s(name)),
            ("kind", Json::n(2)),
            ("value", Json::s(n.to_string())),
        ])
    }
    #[test]
    fn unique_slices_preserve_exact64_and_inverse() {
        let store = Store::new();
        let entries = vec![attr("axis", 1), attr("sorted", 0)];
        let a = Attrs {
            entries: &entries,
            store: &store,
        };
        let x = Tensor::vector_i64(&[9007199254740993, 2, 9007199254740993, 7, 8, 7])
            .unwrap()
            .reshape(vec![2, 3])
            .unwrap();
        let y = execute("Unique", &[Some(x)], &a, 4).unwrap();
        assert_eq!(y[0].shape, vec![2, 2]);
        assert_eq!(y[0].ints().unwrap(), vec![9007199254740993, 2, 7, 8]);
        assert_eq!(y[1].ints().unwrap(), vec![0, 1]);
        assert_eq!(y[2].ints().unwrap(), vec![0, 1, 0]);
        assert_eq!(y[3].ints().unwrap(), vec![2, 1]);
    }
    #[test]
    fn determinant_pivots_and_empty_matrices() {
        let store = Store::new();
        let a = Attrs {
            entries: &[],
            store: &store,
        };
        let mut x = Tensor::zeros(11, vec![2, 2, 2]).unwrap();
        for (i, &v) in [0., 2., 3., 4., 1., 2., 2., 4.].iter().enumerate() {
            x.set(i, Number::F(v));
        }
        let y = execute("Det", &[Some(x)], &a, 1).unwrap();
        assert_eq!(y[0].get(0).f(), -6.);
        assert_eq!(y[0].get(1).f(), 0.);
        let empty = Tensor::zeros(11, vec![3, 0, 0]).unwrap();
        let y = execute("Det", &[Some(empty)], &a, 1).unwrap();
        assert_eq!(y[0].get(2).f(), 1.);
    }
}
