use crate::attrs::{floating, input, optional, same_type, Attrs};
use crate::tensor::{axis, broadcast, broadcast_index, product, strides, Number, Result, Tensor};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "MatMul"
            | "Gemm"
            | "Einsum"
            | "ReduceSum"
            | "ReduceProd"
            | "ReduceMin"
            | "ReduceMax"
            | "ReduceMean"
            | "ReduceL1"
            | "ReduceL2"
            | "ReduceLogSum"
            | "ReduceLogSumExp"
            | "ReduceSumSquare"
            | "ArgMax"
            | "ArgMin"
            | "TopK"
            | "CumSum"
            | "CumProd"
            | "Softmax"
            | "LogSoftmax"
            | "Hardmax"
    )
}
fn zero(kind: u32) -> Number {
    if matches!(kind, 1 | 10 | 11 | 16) {
        Number::F(0.)
    } else if matches!(kind, 3 | 5 | 6 | 7 | 22) {
        Number::I(0)
    } else {
        Number::U(0)
    }
}
fn one(kind: u32) -> Number {
    zero(kind).add(Number::U(1))
}
pub fn matmul(a: &Tensor, b: &Tensor) -> Result<Tensor> {
    same_type(a, b)?;
    a.numeric()?;
    if a.shape.is_empty() || b.shape.is_empty() {
        return Err("MatMul operands must have positive rank; use Mul for scalars".into());
    }
    let av = a.shape.len() == 1;
    let bv = b.shape.len() == 1;
    let (m, k) = if av {
        (1, a.shape[0])
    } else {
        (a.shape[a.shape.len() - 2], a.shape[a.shape.len() - 1])
    };
    let (bk, n) = if bv {
        (b.shape[0], 1)
    } else {
        (b.shape[b.shape.len() - 2], b.shape[b.shape.len() - 1])
    };
    if k != bk {
        return Err("MatMul contracted dimensions differ; supply compatible matrices".into());
    }
    let ab = if av {
        &[][..]
    } else {
        &a.shape[..a.shape.len() - 2]
    };
    let bb = if bv {
        &[][..]
    } else {
        &b.shape[..b.shape.len() - 2]
    };
    let batches = broadcast(ab, bb)?;
    let mut shape = batches.clone();
    if !av {
        shape.push(m);
    }
    if !bv {
        shape.push(n);
    }
    let mut y = Tensor::zeros(a.kind, shape)?;
    if y.size() == 0 {
        return Ok(y);
    }
    for batch in 0..product(&batches)? {
        let ap = broadcast_index(batch, &batches, ab) * m * k;
        let bp = broadcast_index(batch, &batches, bb) * k * n;
        for row in 0..m {
            for col in 0..n {
                let mut sum = zero(a.kind);
                for j in 0..k {
                    sum = sum.add(a.get(ap + row * k + j).mul(b.get(bp + j * n + col)));
                }
                y.set((batch * m + row) * n + col, sum);
            }
        }
    }
    Ok(y)
}
fn einsum(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Tensor> {
    let first = input(inputs, 0)?;
    first.numeric()?;
    let equation = a.string("equation", "")?.replace(' ', "");
    let mut parts = equation.split("->");
    let lhs = parts.next().unwrap();
    let explicit = parts.next();
    if parts.next().is_some() {
        return Err("Einsum contains multiple arrows; use one equation output".into());
    }
    let terms: Vec<_> = lhs.split(',').collect();
    if terms.len() != inputs.len() {
        return Err("Einsum term count must match inputs; supply one term per tensor".into());
    }
    let mut ellipsis = None;
    let mut expanded = Vec::new();
    let mut counts = BTreeMap::<usize, usize>::new();
    let mut dims = BTreeMap::<usize, usize>::new();
    let parse = |term: &str, rank: usize, ell: &mut Option<usize>| -> Result<Vec<usize>> {
        let dots = term.match_indices("...").count();
        let labels = term.chars().filter(|c| c.is_ascii_alphabetic()).count();
        if dots > 1
            || term
                .replace("...", "")
                .chars()
                .any(|c| !c.is_ascii_alphabetic())
            || labels > rank
        {
            return Err(
                "Einsum term has invalid labels or rank; supply letters with at most one ellipsis"
                    .into(),
            );
        }
        let n = rank - labels;
        if dots == 0 && n != 0 {
            return Err(
                "Einsum term rank differs from tensor; add an ellipsis or matching labels".into(),
            );
        }
        if dots == 1 {
            if ell.is_some_and(|v| v != n) {
                return Err(
                    "ONNX Einsum ellipses must represent equal rank; export matching ellipses"
                        .into(),
                );
            }
            *ell = Some(n);
        }
        let mut result = Vec::new();
        for (i, p) in term.split("...").enumerate() {
            if i > 0 {
                result.extend((0..n).map(|v| 256 + v));
            }
            result.extend(p.bytes().map(|c| c as usize));
        }
        Ok(result)
    };
    for (i, term) in terms.iter().enumerate() {
        let t = input(inputs, i)?;
        same_type(first, t)?;
        let labels = parse(term, t.shape.len(), &mut ellipsis)?;
        let mut local = BTreeMap::new();
        for (&label, &n) in labels.iter().zip(&t.shape) {
            if let Some(previous) = local.insert(label, n) {
                if previous != n {
                    return Err("Einsum repeated labels need equal dimensions; supply square diagonal dimensions".into());
                }
            }
            if let Some(&previous) = dims.get(&label) {
                if n != previous && n != 1 && previous != 1 {
                    return Err(
                        "Einsum label dimensions do not broadcast; supply compatible dimensions"
                            .into(),
                    );
                }
                dims.insert(label, if previous == 1 { n } else { previous });
            } else {
                dims.insert(label, n);
            }
            *counts.entry(label).or_default() += 1;
        }
        expanded.push(labels);
    }
    let output = if let Some(rhs) = explicit {
        let rank = rhs.chars().filter(|c| c.is_ascii_alphabetic()).count()
            + if rhs.contains("...") {
                ellipsis.unwrap_or(0)
            } else {
                0
            };
        parse(rhs, rank, &mut ellipsis)?
    } else {
        (0..ellipsis.unwrap_or(0))
            .map(|v| 256 + v)
            .chain(
                counts
                    .iter()
                    .filter(|(&k, &n)| k < 256 && n == 1)
                    .map(|(&k, _)| k),
            )
            .collect()
    };
    let mut seen = HashSet::new();
    if output
        .iter()
        .any(|l| !dims.contains_key(l) || !seen.insert(*l))
    {
        return Err(
            "Einsum output labels must be unique and present in inputs; repair the output term"
                .into(),
        );
    }
    let reduced: Vec<_> = dims
        .keys()
        .filter(|l| !seen.contains(*l))
        .copied()
        .collect();
    let mut all = output.clone();
    all.extend(&reduced);
    let all_dims: Vec<_> = all.iter().map(|l| dims[l]).collect();
    let output_dims = all_dims[..output.len()].to_vec();
    let reduce_dims = &all_dims[output.len()..];
    let mut y = Tensor::zeros(first.kind, output_dims.clone())?;
    if y.size() == 0 {
        return Ok(y);
    }
    let reduce_count = product(reduce_dims)?;
    let os = strides(&output_dims);
    let rs = strides(reduce_dims);
    for i in 0..y.size() {
        let mut coords = vec![0; all.len()];
        for d in 0..output.len() {
            coords[d] = i / os[d] % all_dims[d];
        }
        let mut sum = zero(first.kind);
        for r in 0..reduce_count {
            for d in 0..reduced.len() {
                coords[d + output.len()] = r / rs[d] % reduce_dims[d];
            }
            let mut term = one(first.kind);
            for (j, labels) in expanded.iter().enumerate() {
                let t = input(inputs, j)?;
                let s = strides(&t.shape);
                let mut at = 0;
                for (d, label) in labels.iter().enumerate() {
                    let p = all.iter().position(|l| l == label).unwrap();
                    at += if t.shape[d] == 1 { 0 } else { coords[p] * s[d] };
                }
                term = term.mul(t.get(at));
            }
            sum = sum.add(term);
        }
        y.set(i, sum);
    }
    Ok(y)
}
pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    a: &Attrs,
    version: u32,
) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    x.numeric()?;
    if op == "MatMul" {
        return Ok(vec![matmul(x, input(inputs, 1)?)?]);
    }
    if op == "Einsum" {
        return Ok(vec![einsum(inputs, a)?]);
    }
    if op == "Gemm" {
        floating(x)?;
        let b = input(inputs, 1)?;
        same_type(x, b)?;
        if x.shape.len() != 2 || b.shape.len() != 2 {
            return Err("Gemm inputs A/B must be matrices; supply rank-two inputs".into());
        }
        let transpose = |t: &Tensor, flag: bool| -> Result<Tensor> {
            if !flag {
                return Ok(t.clone());
            }
            let mut y = Tensor::zeros(t.kind, vec![t.shape[1], t.shape[0]])?;
            for i in 0..t.shape[0] {
                for j in 0..t.shape[1] {
                    y.copy_element(j * t.shape[0] + i, t, i * t.shape[1] + j);
                }
            }
            Ok(y)
        };
        let mut y = matmul(
            &transpose(x, a.flag("transA", false)?)?,
            &transpose(b, a.flag("transB", false)?)?,
        )?;
        let alpha = a.float("alpha", 1.)?;
        let beta = a.float("beta", 1.)?;
        let c = optional(inputs, 2);
        if let Some(c) = c {
            same_type(x, c)?;
            if broadcast(&c.shape, &y.shape)? != y.shape {
                return Err(
                    "Gemm C must broadcast to its result; supply compatible bias dimensions".into(),
                );
            }
        }
        for i in 0..y.size() {
            let bias = c.map_or(0., |c| {
                beta * c.get(broadcast_index(i, &y.shape, &c.shape)).f()
            });
            y.set(i, Number::F(alpha * y.get(i).f() + bias));
        }
        return Ok(vec![y]);
    }
    if op.starts_with("Reduce") {
        let axes = if let Some(t) = optional(inputs, 1) {
            if t.kind != 7 || t.shape.len() != 1 {
                return Err(
                    "reduction axes must be one-dimensional int64; provide valid axes".into(),
                );
            }
            t.ints()?
        } else {
            a.ints("axes")?.unwrap_or_default()
        };
        let axes = if axes.is_empty() && !a.flag("noop_with_empty_axes", false)? {
            (0..x.shape.len() as i64).collect()
        } else {
            axes
        };
        let mut reduced = vec![false; x.shape.len()];
        for d in axes {
            let d = axis(d, x.shape.len())?;
            if reduced[d] {
                return Err("reduction axes must be unique; remove repeated axes".into());
            }
            reduced[d] = true;
        }
        let keep = a.flag("keepdims", true)?;
        let shape: Vec<_> = x
            .shape
            .iter()
            .enumerate()
            .filter_map(|(d, &n)| {
                if reduced[d] {
                    keep.then_some(1)
                } else {
                    Some(n)
                }
            })
            .collect();
        let mut y = Tensor::zeros(x.kind, shape.clone())?;
        let mut counts = vec![0usize; y.size()];
        let mut values = vec![
            if op == "ReduceProd" {
                one(x.kind)
            } else {
                zero(x.kind)
            };
            y.size()
        ];
        let mut maxima = vec![f64::NEG_INFINITY; y.size()];
        let exact_mean = op == "ReduceMean" && !matches!(x.kind, 1 | 10 | 11 | 16);
        let mut signed = if exact_mean && matches!(x.kind, 3 | 5 | 6 | 7 | 22) {
            Some(vec![0i128; y.size()])
        } else {
            None
        };
        let mut unsigned = if exact_mean && signed.is_none() {
            Some(vec![0u128; y.size()])
        } else {
            None
        };
        let xs = strides(&x.shape);
        let ys = strides(&shape);
        for i in 0..x.size() {
            let mut out = 0;
            let mut j = 0;
            for d in 0..x.shape.len() {
                if reduced[d] {
                    if keep {
                        j += 1;
                    }
                } else {
                    out += (i / xs[d] % x.shape[d]) * ys[j];
                    j += 1;
                }
            }
            let v = x.get(i);
            if let Some(sums) = &mut signed {
                sums[out] += v.i() as i128;
            }
            if let Some(sums) = &mut unsigned {
                sums[out] += v.u() as u128;
            }
            let previous = values[out];
            values[out] = match op {
                "ReduceMean" if exact_mean => previous,
                "ReduceMin" => {
                    if counts[out] == 0 || v.cmp(previous) == Some(Ordering::Less) || v.f().is_nan()
                    {
                        v
                    } else {
                        previous
                    }
                }
                "ReduceMax" => {
                    if counts[out] == 0
                        || v.cmp(previous) == Some(Ordering::Greater)
                        || v.f().is_nan()
                    {
                        v
                    } else {
                        previous
                    }
                }
                "ReduceProd" => previous.mul(v),
                "ReduceL1" => previous.add(match v {
                    Number::I(v) => Number::I(v.wrapping_abs()),
                    Number::F(v) => Number::F(v.abs()),
                    v => v,
                }),
                "ReduceL2" | "ReduceSumSquare" => previous.add(v.mul(v)),
                "ReduceLogSumExp" => {
                    let p = maxima[out];
                    let q = v.f();
                    let maximum = p.max(q);
                    let sum = if counts[out] == 0 {
                        1.
                    } else if q.is_nan() || p.is_nan() {
                        f64::NAN
                    } else if maximum == f64::INFINITY {
                        (if p == maximum { previous.f() } else { 0. })
                            + (if q == maximum { 1. } else { 0. })
                    } else if maximum == f64::NEG_INFINITY {
                        previous.f() + 1.
                    } else {
                        previous.f() * (p - maximum).exp() + (q - maximum).exp()
                    };
                    maxima[out] = if q.is_nan() { q } else { maximum };
                    Number::F(sum)
                }
                _ => previous.add(v),
            };
            counts[out] += 1;
        }
        for i in 0..y.size() {
            let n = counts[i];
            let v = if n > 0 {
                if let Some(sums) = &signed {
                    Number::I((sums[i] / n as i128) as i64)
                } else if let Some(sums) = &unsigned {
                    Number::U((sums[i] / n as u128) as u64)
                } else {
                    values[i]
                }
            } else {
                values[i]
            };
            let f = match op {
                "ReduceMean" if !exact_mean => Some(v.f() / n as f64),
                "ReduceL2" => Some(v.f().sqrt()),
                "ReduceLogSum" => Some(v.f().ln()),
                "ReduceLogSumExp" => Some(if n == 0 {
                    f64::NEG_INFINITY
                } else {
                    maxima[i] + v.f().ln()
                }),
                "ReduceMin" if n == 0 => Some(f64::INFINITY),
                "ReduceMax" if n == 0 => Some(f64::NEG_INFINITY),
                _ => None,
            };
            y.set(i, if let Some(f) = f { Number::F(f) } else { v });
        }
        return Ok(vec![y]);
    }
    let d = axis(
        a.int(
            "axis",
            if matches!(op, "Softmax" | "LogSoftmax" | "Hardmax") {
                if version >= 13 {
                    -1
                } else {
                    1
                }
            } else {
                0
            },
        )?,
        x.shape.len(),
    )?;
    let width = x.shape[d];
    let inner = product(&x.shape[d + 1..])?;
    let outer = product(&x.shape[..d])?;
    if matches!(op, "ArgMax" | "ArgMin" | "TopK") {
        let top = op == "TopK";
        let k = if top {
            let k = if let Some(t) = optional(inputs, 1) {
                if t.kind != 7 || t.size() != 1 {
                    return Err("TopK K must contain one int64; supply the requested count".into());
                }
                t.get(0).i()
            } else {
                a.int("k", 0)?
            };
            if k < 0 || k as usize > width {
                return Err("TopK K must be in 0..axis size; choose a valid count".into());
            }
            k as usize
        } else {
            if width == 0 {
                return Err(
                    "ArgMax/ArgMin cannot reduce an empty axis; supply a nonempty axis".into(),
                );
            }
            1
        };
        let mut shape = x.shape.clone();
        shape[d] = k;
        if !top && !a.flag("keepdims", true)? {
            shape.remove(d);
        }
        let mut indices = Tensor::zeros(7, shape.clone())?;
        let mut values = Tensor::zeros(x.kind, shape)?;
        let largest = if top {
            a.flag("largest", true)?
        } else {
            op == "ArgMax"
        };
        let last = !top && a.flag("select_last_index", false)?;
        if indices.size() > 0 {
            for p in 0..outer {
                for q in 0..inner {
                    let mut order: Vec<_> = (0..width).collect();
                    order.sort_by(|&i, &j| {
                        let aa = x.get((p * width + i) * inner + q);
                        let bb = x.get((p * width + j) * inner + q);
                        let cmp = aa.cmp(bb).unwrap_or_else(|| {
                            match (aa.f().is_nan(), bb.f().is_nan()) {
                                (true, false) => Ordering::Greater,
                                (false, true) => Ordering::Less,
                                _ => Ordering::Equal,
                            }
                        });
                        let cmp = if largest { cmp.reverse() } else { cmp };
                        cmp.then_with(|| if last { j.cmp(&i) } else { i.cmp(&j) })
                    });
                    for r in 0..k {
                        let at = (p * k + r) * inner + q;
                        indices.set(at, Number::I(order[r] as i64));
                        values.copy_element(at, x, (p * width + order[r]) * inner + q);
                    }
                }
            }
        }
        return Ok(if top {
            vec![values, indices]
        } else {
            vec![indices]
        });
    }
    if op == "CumSum" || op == "CumProd" {
        let at = input(inputs, 1)?;
        if !matches!(at.kind, 6 | 7) || at.size() != 1 {
            return Err("CumSum axis must be one integer value; supply a scalar axis".into());
        }
        let d = axis(at.get(0).i(), x.shape.len())?;
        let width = x.shape[d];
        let inner = product(&x.shape[d + 1..])?;
        let outer = product(&x.shape[..d])?;
        let reverse = a.flag("reverse", false)?;
        let exclusive = a.flag("exclusive", false)?;
        let mut y = Tensor::zeros(x.kind, x.shape.clone())?;
        if y.size() > 0 {
            for p in 0..outer {
                for q in 0..inner {
                    let mut sum = if op == "CumProd" {
                        one(x.kind)
                    } else {
                        zero(x.kind)
                    };
                    for j in 0..width {
                        let at = (p * width + if reverse { width - 1 - j } else { j }) * inner + q;
                        let v = x.get(at);
                        if exclusive {
                            y.set(at, sum);
                            sum = if op == "CumProd" {
                                sum.mul(v)
                            } else {
                                sum.add(v)
                            };
                        } else {
                            sum = if op == "CumProd" {
                                sum.mul(v)
                            } else {
                                sum.add(v)
                            };
                            y.set(at, sum);
                        }
                    }
                }
            }
        }
        return Ok(vec![y]);
    }
    floating(x)?;
    let (width, inner) = if version < 13 {
        (width * inner, 1)
    } else {
        (width, inner)
    };
    let mut y = Tensor::zeros(x.kind, x.shape.clone())?;
    if y.size() > 0 {
        for p in 0..outer {
            for q in 0..inner {
                let mut max = f64::NEG_INFINITY;
                let mut best = 0;
                for j in 0..width {
                    let v = x.get((p * width + j) * inner + q).f();
                    if v > max {
                        max = v;
                        best = j;
                    }
                    if v.is_nan() {
                        max = v;
                    }
                }
                let mut sum = 0.;
                if op != "Hardmax" {
                    for j in 0..width {
                        sum += (x.get((p * width + j) * inner + q).f() - max).exp();
                    }
                }
                for j in 0..width {
                    let at = (p * width + j) * inner + q;
                    let v = if op == "Hardmax" {
                        (j == best) as u8 as f64
                    } else if op == "LogSoftmax" {
                        x.get(at).f() - max - sum.ln()
                    } else {
                        (x.get(at).f() - max).exp() / sum
                    };
                    y.set(at, Number::F(v));
                }
            }
        }
    }
    Ok(vec![y])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    #[test]
    fn integer_mean_preserves_large_values_without_sum_overflow_or_float_narrowing() {
        let s = Store::new();
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        for n in [9007199254740993, i64::MAX, i64::MIN] {
            let x = Tensor::vector_i64(&[n, n]).unwrap();
            let y = execute("ReduceMean", &[Some(x)], &a, 18).unwrap();
            assert_eq!(y[0].get(0).i(), n);
        }
        let mut x = Tensor::zeros(13, vec![2]).unwrap();
        x.set(0, Number::U(u64::MAX));
        x.set(1, Number::U(u64::MAX));
        let y = execute("ReduceMean", &[Some(x)], &a, 18).unwrap();
        assert_eq!(y[0].get(0).u(), u64::MAX);
    }
    #[test]
    fn topk_nan_comparator_is_total_and_equal_values_keep_lower_indices() {
        let s = Store::new();
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let values = [3f64, f64::NAN, -1., f64::NAN, 2.];
        let x = Tensor::raw(
            11,
            vec![5],
            values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        )
        .unwrap();
        let k = Tensor::vector_i64(&[5]).unwrap();
        let y = execute("TopK", &[Some(x), Some(k)], &a, 18).unwrap();
        assert_eq!(y[1].ints().unwrap(), vec![1, 3, 0, 4, 2]);
    }
    fn attr(n: &str, k: i64, v: Json) -> Json {
        Json::object([
            ("name", Json::s(n)),
            ("kind", Json::s(k.to_string())),
            ("value", v),
        ])
    }
    #[test]
    fn matmul_vectors_batches_empty_and_exact_int64() {
        let a = Tensor::vector_i64(&[9007199254740993, 2]).unwrap();
        let b = Tensor::vector_i64(&[1, 3]).unwrap();
        let y = matmul(&a, &b).unwrap();
        assert!(y.shape.is_empty());
        assert_eq!(y.get(0).i(), 9007199254740999);
        let a = Tensor::zeros(1, vec![2, 3, 0]).unwrap();
        let b = Tensor::zeros(1, vec![1, 0, 4]).unwrap();
        let y = matmul(&a, &b).unwrap();
        assert_eq!(y.shape, vec![2, 3, 4]);
        assert!(y.data.iter().all(|&v| v == 0));
    }
    #[test]
    fn einsum_diagonal_ellipsis_and_contract() {
        let s = Store::new();
        let entries = vec![attr("equation", 3, Json::s("...ii->..."))];
        let a = Attrs {
            entries: &entries,
            store: &s,
        };
        let t = Tensor::raw(
            7,
            vec![2, 2, 2],
            (1i64..=8).flat_map(i64::to_le_bytes).collect(),
        )
        .unwrap();
        let y = execute("Einsum", &[Some(t)], &a, 13).unwrap();
        assert_eq!(y[0].ints().unwrap(), vec![5, 13]);
    }
    #[test]
    fn composite_noop_reduction_and_stable_logsumexp() {
        let s = Store::new();
        let entries = vec![attr("noop_with_empty_axes", 2, Json::s("1"))];
        let a = Attrs {
            entries: &entries,
            store: &s,
        };
        let t = Tensor::vector_i64(&[3, -4]).unwrap();
        let y = execute("ReduceSumSquare", &[Some(t)], &a, 18).unwrap();
        assert_eq!(y[0].ints().unwrap(), vec![9, 16]);
        let mut t = Tensor::zeros(11, vec![2]).unwrap();
        t.set(0, Number::F(1000.));
        t.set(1, Number::F(1000.));
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let y = execute("ReduceLogSumExp", &[Some(t)], &a, 18).unwrap();
        assert!((y[0].get(0).f() - (1000. + 2f64.ln())).abs() < 1e-12);
    }
}
