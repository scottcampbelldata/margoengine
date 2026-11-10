use crate::attrs::{input, optional, same_type, Attrs};
use crate::tensor::{axis, product, strides, Number, Result, Tensor};
use std::collections::HashSet;

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "Slice"
            | "Gather"
            | "GatherElements"
            | "GatherND"
            | "Scatter"
            | "ScatterElements"
            | "ScatterND"
            | "Split"
            | "Compress"
            | "NonZero"
            | "Pad"
            | "DepthToSpace"
            | "SpaceToDepth"
            | "Trilu"
            | "EyeLike"
            | "Range"
            | "OneHot"
    )
}
fn vector(t: &Tensor) -> Result<Vec<i64>> {
    if t.shape.len() != 1 || !matches!(t.kind, 6 | 7) {
        return Err(
            "index list must be a one-dimensional int32/int64 tensor; provide integer indices"
                .into(),
        );
    }
    t.ints()
}
fn index(n: i64, dim: usize) -> Result<usize> {
    let n = if n < 0 { n + dim as i64 } else { n };
    if n < 0 || n >= dim as i64 {
        Err("index is outside its tensor dimension; supply an in-range index".into())
    } else {
        Ok(n as usize)
    }
}
fn coords(mut flat: usize, shape: &[usize]) -> Vec<usize> {
    let s = strides(shape);
    shape
        .iter()
        .enumerate()
        .map(|(i, &d)| {
            let c = if d == 0 { 0 } else { flat / s[i] };
            if s[i] != 0 {
                flat %= s[i];
            }
            c
        })
        .collect()
}
fn offset(c: &[usize], s: &[usize]) -> usize {
    c.iter().zip(s).map(|(a, b)| a * b).sum()
}
fn merge(out: &mut Tensor, at: usize, src: &Tensor, i: usize, reduction: &str) -> Result<()> {
    if reduction == "none" {
        out.copy_element(at, src, i);
        return Ok(());
    }
    out.numeric()?;
    src.numeric()?;
    let a = out.get(at);
    let b = src.get(i);
    let v = match reduction {
        "add" => a.add(b),
        "mul" => a.mul(b),
        "max" => {
            if a.cmp(b) == Some(std::cmp::Ordering::Less) {
                b
            } else {
                a
            }
        }
        "min" => {
            if a.cmp(b) == Some(std::cmp::Ordering::Greater) {
                b
            } else {
                a
            }
        }
        _ => {
            return Err(
                "scatter reduction must be none/add/mul/max/min; choose a supported reduction"
                    .into(),
            )
        }
    };
    out.set(at, v);
    Ok(())
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs, nout: usize) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let rank = x.shape.len();
    let mut out = match op {
        "Slice" => {
            let starts = if let Some(t) = optional(inputs, 1) {
                vector(t)?
            } else {
                a.ints("starts")?
                    .ok_or("Slice starts are required; supply start indices")?
            };
            let ends = if let Some(t) = optional(inputs, 2) {
                vector(t)?
            } else {
                a.ints("ends")?
                    .ok_or("Slice ends are required; supply end indices")?
            };
            let axes = if let Some(t) = optional(inputs, 3) {
                vector(t)?
            } else {
                a.ints("axes")?.unwrap_or((0..rank as i64).collect())
            };
            let steps = if let Some(t) = optional(inputs, 4) {
                vector(t)?
            } else {
                vec![1; starts.len()]
            };
            if starts.len() != ends.len()
                || starts.len() != axes.len()
                || starts.len() != steps.len()
            {
                return Err(
                    "Slice index lists must have equal lengths; supply one start/end/step per axis"
                        .into(),
                );
            }
            let mut begin = vec![0i64; rank];
            let mut step = vec![1i64; rank];
            let mut dims = x.shape.clone();
            let mut seen = HashSet::new();
            for i in 0..starts.len() {
                let d = axis(axes[i], rank)?;
                if !seen.insert(d) || steps[i] == 0 {
                    return Err(
                        "Slice axes must be unique and steps nonzero; repair the slice".into(),
                    );
                }
                let size = x.shape[d] as i64;
                let s = steps[i];
                let adjust = |n: i64| if n < 0 { n.saturating_add(size) } else { n };
                let lo = adjust(starts[i]).clamp(0, if s < 0 { (size - 1).max(0) } else { size });
                let hi = adjust(ends[i]).clamp(
                    if s < 0 { -1 } else { 0 },
                    if s < 0 { (size - 1).max(-1) } else { size },
                );
                begin[d] = lo;
                step[d] = s;
                let length = if size == 0 {
                    0
                } else if s > 0 {
                    ((hi - lo).max(0) as u64).div_ceil(s as u64)
                } else {
                    ((lo - hi).max(0) as u64).div_ceil(s.unsigned_abs())
                };
                dims[d] = length as usize;
            }
            let mut y = Tensor::zeros(x.kind, dims.clone())?;
            let xs = strides(&x.shape);
            for i in 0..y.size() {
                let c = coords(i, &dims);
                let at = c
                    .iter()
                    .enumerate()
                    .map(|(d, &v)| {
                        ((begin[d] as i128 + v as i128 * step[d] as i128) as usize) * xs[d]
                    })
                    .sum();
                y.copy_element(i, x, at);
            }
            y
        }
        "Gather" => {
            let ids = input(inputs, 1)?;
            if !matches!(ids.kind, 6 | 7) {
                return Err("Gather indices must be int32/int64; supply integer indices".into());
            }
            let d = axis(a.int("axis", 0)?, rank)?;
            let inner = product(&x.shape[d + 1..])?;
            let outer = product(&x.shape[..d])?;
            let mut dims = x.shape[..d].to_vec();
            dims.extend(&ids.shape);
            dims.extend(&x.shape[d + 1..]);
            let mut y = Tensor::zeros(x.kind, dims)?;
            if y.size() > 0 {
                for p in 0..outer {
                    for j in 0..ids.size() {
                        let q = index(ids.get(j).i(), x.shape[d])?;
                        for k in 0..inner {
                            y.copy_element(
                                (p * ids.size() + j) * inner + k,
                                x,
                                (p * x.shape[d] + q) * inner + k,
                            );
                        }
                    }
                }
            }
            y
        }
        "GatherElements" | "Scatter" | "ScatterElements" => {
            let ids = input(inputs, 1)?;
            if !matches!(ids.kind, 6 | 7) || ids.shape.len() != rank {
                return Err("element indices must have the data rank and int32/int64 type; repair the indices".into());
            }
            let d = axis(a.int("axis", 0)?, rank)?;
            for j in 0..rank {
                if j != d && ids.shape[j] > x.shape[j] {
                    return Err(
                        "indices exceed a non-axis data dimension; use a matching shape".into(),
                    );
                }
            }
            let scatter = op != "GatherElements";
            let updates = if scatter {
                let t = input(inputs, 2)?;
                same_type(x, t)?;
                if t.shape != ids.shape {
                    return Err(
                        "scatter updates must match indices shape; supply one update per index"
                            .into(),
                    );
                }
                Some(t)
            } else {
                None
            };
            let mut y = if scatter {
                x.clone()
            } else {
                Tensor::zeros(x.kind, ids.shape.clone())?
            };
            let xs = strides(&x.shape);
            let reduction = a.string("reduction", "none")?;
            let mut seen = HashSet::new();
            for i in 0..ids.size() {
                let mut c = coords(i, &ids.shape);
                c[d] = index(ids.get(i).i(), x.shape[d])?;
                let at = offset(&c, &xs);
                if let Some(u) = updates {
                    if reduction == "none" && !seen.insert(at) {
                        return Err("scatter none has duplicate destination indices; use a reduction or unique indices".into());
                    }
                    merge(&mut y, at, u, i, reduction)?;
                } else {
                    y.copy_element(i, x, at);
                }
            }
            y
        }
        "GatherND" | "ScatterND" => {
            let ids = input(inputs, 1)?;
            if rank == 0 || ids.shape.is_empty() || ids.kind != 7 {
                return Err("ND indices must be int64 tuples and data must have positive rank; repair the indices".into());
            }
            let b = if op == "GatherND" {
                a.int("batch_dims", 0)?
            } else {
                0
            };
            if b < 0 || b as usize >= rank.min(ids.shape.len()) {
                return Err(
                    "batch_dims must be less than both ranks; use matching leading batches".into(),
                );
            }
            let b = b as usize;
            let k = *ids.shape.last().unwrap();
            if k == 0 || k > rank - b || x.shape[..b] != ids.shape[..b] {
                return Err(
                    "ND tuple length or batch shape is invalid; supply valid coordinates".into(),
                );
            }
            let mut dims = ids.shape[..ids.shape.len() - 1].to_vec();
            dims.extend(&x.shape[b + k..]);
            let scatter = op == "ScatterND";
            let u = if scatter {
                let t = input(inputs, 2)?;
                same_type(x, t)?;
                if t.shape != dims {
                    return Err("ScatterND updates shape must match selected slices; supply complete slices".into());
                }
                Some(t)
            } else {
                None
            };
            let mut y = if scatter {
                x.clone()
            } else {
                Tensor::zeros(x.kind, dims)?
            };
            let inner = product(&x.shape[b + k..])?;
            let xs = strides(&x.shape);
            let tuples = ids.size() / k;
            let per_batch = product(&ids.shape[b..ids.shape.len() - 1])?;
            let batch_stride = product(&x.shape[b..])?;
            let mut seen = HashSet::new();
            let reduction = a.string("reduction", "none")?;
            if inner > 0 {
                for row in 0..tuples {
                    let mut at = if b == 0 {
                        0
                    } else {
                        row / per_batch * batch_stride
                    };
                    for j in 0..k {
                        at += index(ids.get(row * k + j).i(), x.shape[b + j])? * xs[b + j];
                    }
                    if scatter && reduction == "none" && !seen.insert(at) {
                        return Err("ScatterND none has duplicate destination tuples; use unique tuples or a reduction".into());
                    }
                    for i in 0..inner {
                        if let Some(u) = u {
                            merge(&mut y, at + i, u, row * inner + i, reduction)?;
                        } else {
                            y.copy_element(row * inner + i, x, at + i);
                        }
                    }
                }
            }
            y
        }
        "Split" => {
            let d = axis(a.int("axis", 0)?, rank)?;
            if nout == 0 {
                return Err("Split needs at least one output; name its outputs".into());
            }
            let splits = if let Some(t) = optional(inputs, 1) {
                vector(t)?
            } else if let Some(v) = a.ints("split")? {
                v
            } else {
                let count = a.int("num_outputs", nout as i64)?;
                if count != nout as i64 {
                    return Err("num_outputs must match Split's outputs; repair the node".into());
                }
                let length = x.shape[d].div_ceil(nout);
                (0..nout)
                    .map(|i| length.min(x.shape[d].saturating_sub(i * length)) as i64)
                    .collect()
            };
            if splits.len() != nout
                || splits.iter().any(|&v| v < 0)
                || splits.iter().map(|&v| v as u128).sum::<u128>() != x.shape[d] as u128
            {
                return Err("Split lengths must be nonnegative, match outputs and sum to the axis length; repair the split".into());
            }
            let inner = product(&x.shape[d + 1..])?;
            let outer = product(&x.shape[..d])?;
            let mut start = 0;
            let mut result = Vec::new();
            for n in splits {
                let n = n as usize;
                let mut dims = x.shape.clone();
                dims[d] = n;
                let mut y = Tensor::zeros(x.kind, dims)?;
                if y.size() > 0 {
                    for p in 0..outer {
                        for i in 0..n * inner {
                            y.copy_element(
                                p * n * inner + i,
                                x,
                                (p * x.shape[d] + start) * inner + i,
                            );
                        }
                    }
                }
                start += n;
                result.push(y);
            }
            return Ok(result);
        }
        "NonZero" => {
            let selected: Vec<_> = (0..x.size())
                .filter(|&i| {
                    if x.kind == 8 {
                        !x.strings.as_ref().unwrap()[i].is_empty()
                    } else {
                        x.get(i).nonzero()
                    }
                })
                .collect();
            let mut y = Tensor::zeros(7, vec![rank, selected.len()])?;
            for (i, &v) in selected.iter().enumerate() {
                for (d, c) in coords(v, &x.shape).iter().enumerate() {
                    y.set(d * selected.len() + i, Number::I(*c as i64));
                }
            }
            y
        }
        "Compress" => {
            let cond = input(inputs, 1)?;
            if cond.kind != 9 || cond.shape.len() != 1 {
                return Err(
                    "Compress condition must be a one-dimensional bool tensor; supply bool flags"
                        .into(),
                );
            }
            let d = if a.has("axis") {
                Some(axis(a.int("axis", 0)?, rank)?)
            } else {
                None
            };
            let size = d.map_or(x.size(), |d| x.shape[d]);
            let ids: Vec<_> = (0..size.min(cond.size()))
                .filter(|&i| cond.get(i).nonzero())
                .collect();
            let (outer, inner, dims) = if let Some(d) = d {
                let mut dims = x.shape.clone();
                dims[d] = ids.len();
                (product(&x.shape[..d])?, product(&x.shape[d + 1..])?, dims)
            } else {
                (1, 1, vec![ids.len()])
            };
            let mut y = Tensor::zeros(x.kind, dims)?;
            if y.size() > 0 {
                for p in 0..outer {
                    for (j, &v) in ids.iter().enumerate() {
                        for i in 0..inner {
                            y.copy_element(
                                (p * ids.len() + j) * inner + i,
                                x,
                                (p * size + v) * inner + i,
                            );
                        }
                    }
                }
            }
            y
        }
        "EyeLike" => {
            if rank != 2 {
                return Err("EyeLike input must be rank two; supply a matrix".into());
            }
            let kind = a.int("dtype", x.kind as i64)?;
            if kind == 8 {
                return Err(
                    "EyeLike output must be numeric or bool; choose a numeric dtype".into(),
                );
            }
            let mut y = Tensor::zeros(kind as u32, x.shape.clone())?;
            if y.size() == 0 {
                return Ok(vec![y]);
            }
            let diagonal = a.int("k", 0)?;
            for row in 0..x.shape[0] {
                let col = (row as i128) + (diagonal as i128);
                if col >= 0 && col < (x.shape[1] as i128) {
                    y.set(row * x.shape[1] + col as usize, Number::U(1));
                }
            }
            y
        }
        "Trilu" => {
            x.numeric()?;
            if rank < 2 {
                return Err("Trilu input must have rank at least two; supply matrices".into());
            }
            let k = if let Some(t) = optional(inputs, 1) {
                if t.kind != 7 || t.size() != 1 {
                    return Err(
                        "Trilu diagonal must be an int64 scalar; supply one diagonal".into(),
                    );
                }
                t.get(0).i()
            } else {
                0
            };
            let upper = a.flag("upper", true)?;
            let mut y = x.clone();
            let cols = x.shape[rank - 1];
            let rows = x.shape[rank - 2];
            for i in 0..x.size() {
                let row = i / cols % rows;
                let col = i % cols;
                let diff = col as i128 - row as i128;
                if if upper {
                    diff < k as i128
                } else {
                    diff > k as i128
                } {
                    y.set(i, Number::U(0));
                }
            }
            y
        }
        "Range" => {
            x.numeric()?;
            let limit = input(inputs, 1)?;
            let delta = input(inputs, 2)?;
            same_type(x, limit)?;
            same_type(x, delta)?;
            if x.size() != 1 || limit.size() != 1 || delta.size() != 1 {
                return Err(
                    "Range inputs must be scalars; supply start/limit/delta scalars".into(),
                );
            }
            let step = delta.get(0);
            let len = match (x.get(0), limit.get(0), step) {
                (Number::I(s), Number::I(e), Number::I(d)) => {
                    if d == 0 {
                        return Err("Range delta must be nonzero; supply a nonzero delta".into());
                    }
                    let diff = e as i128 - s as i128;
                    let d = d as i128;
                    if diff.signum() != d.signum() {
                        0
                    } else {
                        diff.unsigned_abs().div_ceil(d.unsigned_abs())
                    }
                }
                (s, e, d) => {
                    let (s, e, d) = (s.f(), e.f(), d.f());
                    if !s.is_finite() || !e.is_finite() || !d.is_finite() || d == 0. {
                        return Err(
                            "Range inputs must be finite with nonzero delta; repair the range"
                                .into(),
                        );
                    }
                    ((e - s) / d).ceil().max(0.) as u128
                }
            };
            if len > crate::tensor::MAX_ELEMENTS as u128 {
                return Err("Range exceeds the tensor element limit; use a smaller range".into());
            }
            let mut y = Tensor::zeros(x.kind, vec![len as usize])?;
            for i in 0..y.size() {
                let v = match x.get(0) {
                    Number::I(s) => Number::I((s as i128 + i as i128 * step.i() as i128) as i64),
                    s => Number::F(s.f() + i as f64 * step.f()),
                };
                y.set(i, v);
            }
            y
        }
        "OneHot" => {
            let depth = input(inputs, 1)?;
            let vals = input(inputs, 2)?;
            if depth.size() != 1 || vals.size() != 2 {
                return Err(
                    "OneHot requires scalar depth and two off/on values; supply valid inputs"
                        .into(),
                );
            }
            let n = depth.get(0).f();
            if !n.is_finite() || n < 0. || n.fract() != 0. || n > i32::MAX as f64 {
                return Err(
                    "OneHot depth must be a nonnegative integer; supply a valid depth".into(),
                );
            }
            let n = n as usize;
            let d = axis(a.int("axis", -1)?, rank + 1)?;
            let mut dims = x.shape.clone();
            dims.insert(d, n);
            let mut y = Tensor::zeros(vals.kind, dims.clone())?;
            for i in 0..y.size() {
                let mut c = coords(i, &dims);
                let on = c.remove(d);
                let v = x.get(offset(&c, &strides(&x.shape))).f();
                let v = if v < 0. { v + n as f64 } else { v };
                let yes = v.is_finite() && v.fract() == 0. && v == on as f64;
                y.copy_element(i, vals, yes as usize);
            }
            y
        }
        "DepthToSpace" | "SpaceToDepth" => {
            if rank != 4 {
                return Err("space/depth transforms need NCHW rank-four input; supply a four-dimensional tensor".into());
            }
            let block = a.int("blocksize", 0)?;
            if block <= 0 {
                return Err("blocksize must be positive; supply a block size".into());
            }
            let b = block as usize;
            let b2 = b
                .checked_mul(b)
                .ok_or("block size overflow; choose a smaller block")?;
            let (n, c, h, w) = (x.shape[0], x.shape[1], x.shape[2], x.shape[3]);
            let mode = a.string("mode", "DCR")?;
            if !matches!(mode, "DCR" | "CRD") {
                return Err("DepthToSpace mode must be DCR or CRD; select a valid mode".into());
            }
            let dims = if op == "DepthToSpace" {
                if c % b2 != 0 {
                    return Err(
                        "channels must divide by blocksize squared; repair the input shape".into(),
                    );
                }
                vec![
                    n,
                    c / b2,
                    h.checked_mul(b)
                        .ok_or("height overflow; reduce blocksize")?,
                    w.checked_mul(b).ok_or("width overflow; reduce blocksize")?,
                ]
            } else {
                if h % b != 0 || w % b != 0 {
                    return Err(
                        "spatial dimensions must divide by blocksize; repair the input shape"
                            .into(),
                    );
                }
                vec![
                    n,
                    c.checked_mul(b2)
                        .ok_or("channel overflow; reduce blocksize")?,
                    h / b,
                    w / b,
                ]
            };
            let mut y = Tensor::zeros(x.kind, dims.clone())?;
            for i in 0..y.size() {
                let q = coords(i, &dims);
                let at = if op == "DepthToSpace" {
                    let sub = (q[2] % b) * b + q[3] % b;
                    let ch = if mode == "DCR" {
                        sub * dims[1] + q[1]
                    } else {
                        q[1] * b2 + sub
                    };
                    ((q[0] * c + ch) * h + q[2] / b) * w + q[3] / b
                } else {
                    let ch = q[1] / b2;
                    let sub = q[1] % b2;
                    ((q[0] * c + ch) * h + q[2] * b + sub / b) * w + q[3] * b + sub % b
                };
                y.copy_element(i, x, at);
            }
            y
        }
        "Pad" => {
            let pads = if let Some(t) = optional(inputs, 1) {
                vector(t)?
            } else {
                a.ints("pads")?
                    .ok_or("Pad pads are required; supply beginning/end pads")?
            };
            let axes = if let Some(t) = optional(inputs, 3) {
                vector(t)?
            } else {
                (0..rank as i64).collect()
            };
            if pads.len() != axes.len() * 2 {
                return Err(
                    "Pad needs two pads per axis; supply begin pads followed by end pads".into(),
                );
            }
            let mut before = vec![0i64; rank];
            let mut after = vec![0i64; rank];
            let mut seen = HashSet::new();
            for (i, &d) in axes.iter().enumerate() {
                let d = axis(d, rank)?;
                if !seen.insert(d) {
                    return Err("Pad axes must be unique; remove repeated axes".into());
                }
                before[d] = pads[i];
                after[d] = pads[i + axes.len()];
            }
            let dims = (0..rank)
                .map(|d| {
                    let n = x.shape[d] as i128 + before[d] as i128 + after[d] as i128;
                    if n < 0 || n > i32::MAX as i128 {
                        Err("Pad output dimension is outside supported range; repair pads".into())
                    } else {
                        Ok(n as usize)
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            let mode = a.string("mode", "constant")?;
            if !matches!(mode, "constant" | "edge" | "reflect" | "wrap") {
                return Err(
                    "Pad mode must be constant/edge/reflect/wrap; select a valid mode".into(),
                );
            }
            let value = optional(inputs, 2);
            if let Some(v) = value {
                same_type(x, v)?;
                if v.size() != 1 {
                    return Err("Pad constant must be scalar; supply one pad value".into());
                }
            }
            let mut y = Tensor::zeros(x.kind, dims.clone())?;
            let xs = strides(&x.shape);
            for i in 0..y.size() {
                let c = coords(i, &dims);
                let mut at = 0;
                let mut outside = false;
                for d in 0..rank {
                    let p = c[d] as i128 - before[d] as i128;
                    let size = x.shape[d] as i128;
                    let q = if p < 0 || p >= size {
                        if mode == "constant" {
                            outside = true;
                            0
                        } else {
                            if size == 0 {
                                return Err("nonconstant Pad cannot pad an empty dimension; use constant padding".into());
                            }
                            match mode {
                                "edge" => p.clamp(0, size - 1),
                                "wrap" => p.rem_euclid(size),
                                _ => {
                                    if size <= 1 {
                                        return Err("reflect Pad needs at least two elements along padded axes; use edge padding".into());
                                    }
                                    let period = 2 * (size - 1);
                                    let r = p.rem_euclid(period);
                                    r.min(period - r)
                                }
                            }
                        }
                    } else {
                        p
                    };
                    at += q as usize * xs[d];
                }
                if outside {
                    if let Some(v) = value {
                        y.copy_element(i, v, 0);
                    } else if x.kind == 8 { /* empty string default */
                    } else {
                        y.set(i, Number::F(a.float("value", 0.)?));
                    }
                } else {
                    y.copy_element(i, x, at);
                }
            }
            y
        }
        _ => {
            return Err(format!(
                "unknown indexing operator {op}; use a supported operator"
            ))
        }
    };
    // Preserve owned output storage; aliases use Arc and mutate through copy-on-write.
    out.shape.shrink_to_fit();
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    fn attr(name: &str, kind: i64, value: Json) -> Json {
        Json::object([
            ("name", Json::s(name)),
            ("kind", Json::s(kind.to_string())),
            ("value", value),
        ])
    }
    #[test]
    fn backwards_slice_and_exact_gather() {
        let s = Store::new();
        let entries = vec![];
        let a = Attrs {
            entries: &entries,
            store: &s,
        };
        let x = Tensor::vector_i64(&[9007199254740993, 2, 3, 4]).unwrap();
        let r = execute(
            "Slice",
            &[
                Some(x.clone()),
                Some(Tensor::vector_i64(&[-1]).unwrap()),
                Some(Tensor::vector_i64(&[i64::MIN]).unwrap()),
                Some(Tensor::vector_i64(&[0]).unwrap()),
                Some(Tensor::vector_i64(&[-1]).unwrap()),
            ],
            &a,
            1,
        )
        .unwrap();
        assert_eq!(r[0].ints().unwrap(), vec![4, 3, 2, 9007199254740993]);
        let r = execute(
            "Gather",
            &[Some(x), Some(Tensor::vector_i64(&[-4, -1]).unwrap())],
            &a,
            1,
        )
        .unwrap();
        assert_eq!(r[0].ints().unwrap(), vec![9007199254740993, 4]);
    }
    #[test]
    fn nd_batch_and_duplicate_scatter() {
        let s = Store::new();
        let entries = vec![attr("batch_dims", 2, Json::s("1"))];
        let a = Attrs {
            entries: &entries,
            store: &s,
        };
        let x = Tensor::raw(
            7,
            vec![2, 2, 2],
            (0i64..8).flat_map(i64::to_le_bytes).collect(),
        )
        .unwrap();
        let ids = Tensor::raw(
            7,
            vec![2, 1, 1],
            vec![1i64, 0]
                .into_iter()
                .flat_map(i64::to_le_bytes)
                .collect(),
        )
        .unwrap();
        let y = execute("GatherND", &[Some(x), Some(ids)], &a, 1).unwrap();
        assert_eq!(y[0].shape, vec![2, 1, 2]);
        assert_eq!(y[0].ints().unwrap(), vec![2, 3, 4, 5]);
        let entries = vec![];
        let a = Attrs {
            entries: &entries,
            store: &s,
        };
        assert!(execute(
            "ScatterElements",
            &[
                Some(Tensor::vector_i64(&[0, 0]).unwrap()),
                Some(Tensor::vector_i64(&[0, -2]).unwrap()),
                Some(Tensor::vector_i64(&[1, 2]).unwrap())
            ],
            &a,
            1
        )
        .is_err());
    }
    #[test]
    fn empty_slice_no_division_and_exact_integer_range() {
        let s = Store::new();
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let empty = Tensor::zeros(1, vec![2_000_000_000, 0]).unwrap();
        assert_eq!(
            execute("EyeLike", &[Some(empty)], &a, 1).unwrap()[0].size(),
            0
        );
        let x = Tensor::zeros(7, vec![0]).unwrap();
        let y = execute(
            "Slice",
            &[
                Some(x),
                Some(Tensor::vector_i64(&[0]).unwrap()),
                Some(Tensor::vector_i64(&[99]).unwrap()),
            ],
            &a,
            1,
        )
        .unwrap();
        assert_eq!(y[0].size(), 0);
        let scalar = |v| {
            let mut t = Tensor::zeros(7, vec![]).unwrap();
            t.set(0, Number::I(v));
            Some(t)
        };
        let y = execute(
            "Range",
            &[
                scalar(9007199254740993),
                scalar(9007199254740996),
                scalar(1),
            ],
            &a,
            1,
        )
        .unwrap();
        assert_eq!(
            y[0].ints().unwrap(),
            vec![9007199254740993, 9007199254740994, 9007199254740995]
        );
    }
}
