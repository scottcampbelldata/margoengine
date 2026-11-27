//! The ONNX sequence-model operators, written from https://onnx.ai/onnx/operators/ (Attention 23-25,
//! RotaryEmbedding 23, TensorScatter 24, CausalConvWithState 27, LinearAttention 27). Attention: Vaswani et al.,
//! "Attention Is All You Need", 2017 (https://arxiv.org/abs/1706.03762), grouped query heads: Ainslie et al., 2023
//! (https://arxiv.org/abs/2305.13245). Rotary embeddings: Su et al., "RoFormer", 2021
//! (https://arxiv.org/abs/2104.09864). Linear attention recurrences: Katharopoulos et al., 2020
//! (https://arxiv.org/abs/2006.16236), and Yang et al., "Gated Delta Networks", 2024
//! (https://arxiv.org/abs/2412.06464).
use crate::attrs::{input, optional, same_type, Attrs};
use crate::tensor::{axis, half, product, to_bfloat, to_half, Number, Result, Tensor};

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "Attention" | "RotaryEmbedding" | "TensorScatter" | "CausalConvWithState" | "LinearAttention"
    )
}

pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs, version: u32) -> Result<Vec<Tensor>> {
    match op {
        "Attention" => attention(inputs, a, version),
        "RotaryEmbedding" => rotary(inputs, a),
        "TensorScatter" => tensor_scatter(inputs, a),
        "CausalConvWithState" => causal_convolution(inputs, a),
        _ => linear_attention(inputs, a),
    }
}

fn float(t: &Tensor) -> Result<()> {
    if matches!(t.kind, 1 | 10 | 11 | 16) {
        Ok(())
    } else {
        Err("sequence operators need float16, bfloat16, float or double tensors".into())
    }
}

/// Round to nearest even in a floating tensor type.
fn rounded(kind: i64, x: f64) -> f64 {
    match kind {
        1 => x as f32 as f64,
        10 => half(to_half(x)),
        16 => f32::from_bits((to_bfloat(x) as u32) << 16) as f64,
        _ => x,
    }
}

fn put(t: &mut Tensor, i: usize, x: f64) {
    t.set(i, Number::F(x));
}

fn tensor_scatter(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let past = input(inputs, 0)?;
    let update = input(inputs, 1)?;
    let indices = optional(inputs, 2);
    same_type(past, update)?;
    let rank = past.shape.len();
    let at = axis(a.int("axis", -2)?, rank)?;
    let circular = match a.string("mode", "linear")? {
        "linear" => false,
        "circular" => true,
        _ => return Err("TensorScatter mode must be linear or circular".into()),
    };
    if at == 0 || update.shape.len() != rank {
        return Err("TensorScatter needs matching ranks and a sequence axis after the batch axis".into());
    }
    let (capacity, length) = (past.shape[at], update.shape[at]);
    let others = (0..rank).all(|d| d == at || past.shape[d] == update.shape[d]);
    if !others || length > capacity {
        return Err("TensorScatter update may differ from the cache only by a shorter sequence axis".into());
    }
    let batch = past.shape[0];
    if indices.is_some_and(|t| t.kind != 7 || t.shape != [batch]) {
        return Err("TensorScatter write_indices must be int64 with one entry per batch".into());
    }
    let mut starts = vec![0usize; batch];
    if let Some(t) = indices {
        for (b, start) in starts.iter_mut().enumerate() {
            let v = t.get(b).i();
            *start = if circular && capacity > 0 {
                v.rem_euclid(capacity as i64) as usize
            } else if v >= 0 && v as u64 + length as u64 <= capacity as u64 {
                v as usize
            } else {
                return Err("TensorScatter linear writes must stay inside the cache".into());
            };
        }
    } else {
        starts.fill(0);
    }
    let mut y = past.clone();
    let inner = product(&past.shape[at + 1..])?;
    let prefix = product(&past.shape[..at])?;
    for p in 0..prefix {
        let start = starts[p / (prefix / batch)];
        for s in 0..length {
            let to = if circular { (start + s) % capacity } else { start + s };
            for k in 0..inner {
                y.copy_element((p * capacity + to) * inner + k, update, (p * length + s) * inner + k);
            }
        }
    }
    Ok(vec![y])
}

/// Heads, sequence length and head width of a [B,H,S,D] or packed [B,S,H*D] tensor, with the flat position of
/// (batch, head, step, element).
struct Heads {
    batch: usize,
    heads: usize,
    steps: usize,
    width: usize,
    packed: bool,
}

impl Heads {
    fn of(t: &Tensor, attribute: i64, name: &str) -> Result<Self> {
        match t.shape[..] {
            [batch, heads, steps, width] => {
                if attribute != 0 && attribute as u64 != heads as u64 {
                    return Err(format!("{name} differs from the 4-D tensor's head axis"));
                }
                Ok(Self { batch, heads, steps, width, packed: false })
            }
            [batch, steps, hidden] => {
                if attribute <= 0 || hidden % attribute as usize != 0 {
                    return Err(format!("3-D input needs a positive {name} that divides its hidden size"));
                }
                let heads = attribute as usize;
                Ok(Self { batch, heads, steps, width: hidden / heads, packed: true })
            }
            _ => Err("attention tensors must be [B,H,S,D] or [B,S,H*D]".into()),
        }
    }
    fn at(&self, b: usize, h: usize, s: usize, d: usize) -> usize {
        if self.packed {
            (b * self.steps + s) * self.heads * self.width + h * self.width + d
        } else {
            ((b * self.heads + h) * self.steps + s) * self.width + d
        }
    }
}

/// past ++ new along the sequence axis, as [B,H,total,D].
fn extend(past: Option<&Tensor>, new: &Tensor, h: &Heads) -> Result<(Tensor, usize)> {
    let before = match past {
        None => 0,
        Some(p) => {
            same_type(p, new)?;
            match p.shape[..] {
                [b, n, s, d] if b == h.batch && n == h.heads && d == h.width => s,
                _ => return Err("Attention past state must be [B,kv_heads,past_length,head_size]".into()),
            }
        }
    };
    let total = before + h.steps;
    let mut y = Tensor::zeros(new.kind, vec![h.batch, h.heads, total, h.width])?;
    for b in 0..h.batch {
        for n in 0..h.heads {
            for s in 0..total {
                for d in 0..h.width {
                    let to = ((b * h.heads + n) * total + s) * h.width + d;
                    if s < before {
                        let from = ((b * h.heads + n) * before + s) * h.width + d;
                        y.copy_element(to, past.unwrap(), from);
                    } else {
                        y.copy_element(to, new, h.at(b, n, s - before, d));
                    }
                }
            }
        }
    }
    Ok((y, before))
}

fn attention(inputs: &[Option<Tensor>], a: &Attrs, version: u32) -> Result<Vec<Tensor>> {
    let q = input(inputs, 0)?;
    let k = input(inputs, 1)?;
    let v = input(inputs, 2)?;
    let mask = optional(inputs, 3);
    let past_key = optional(inputs, 4);
    let past_value = optional(inputs, 5);
    let valid = optional(inputs, 6);
    float(q)?;
    float(v)?;
    same_type(q, k)?;
    let (q_heads, kv_heads) = (a.int("q_num_heads", 0)?, a.int("kv_num_heads", 0)?);
    let qh = Heads::of(q, q_heads, "q_num_heads")?;
    let kh = Heads::of(k, kv_heads, "kv_num_heads")?;
    let vh = Heads::of(v, kv_heads, "kv_num_heads")?;
    if kh.batch != qh.batch || vh.batch != qh.batch || kh.width != qh.width || vh.heads != kh.heads {
        return Err("Attention batch sizes, head counts and key width must agree".into());
    }
    if vh.steps != kh.steps || kh.heads == 0 || qh.heads % kh.heads != 0 {
        return Err("Attention needs equal key and value lengths and q heads divisible by kv heads".into());
    }
    if past_key.is_some() != past_value.is_some() || (valid.is_some() && past_key.is_some()) {
        return Err("Attention past key and value go together, and exclude nonpad_kv_seqlen".into());
    }
    if valid.is_some_and(|t| t.kind != 7 || t.shape != [qh.batch]) {
        return Err("nonpad_kv_seqlen must be int64 with one entry per batch".into());
    }
    let (keys, before) = extend(past_key, k, &kh)?;
    let (values, value_before) = extend(past_value, v, &vh)?;
    if before != value_before {
        return Err("Attention past key and value lengths differ".into());
    }
    let total = before + kh.steps;
    let causal = a.flag("is_causal", false)?;
    let left = a.int("left_window_size", -1)?;
    let right = a.int("right_window_size", -1)?;
    let mode = a.int("qk_matmul_output_mode", 0)?;
    let scale = a.float("scale", 1. / (qh.width as f64).sqrt())?;
    let softcap = a.float("softcap", 0.)?;
    let precision = a.int("softmax_precision", q.kind as i64)?;
    if !(0..=3).contains(&mode) || !matches!(precision, 1 | 10 | 11 | 16) || left < -1 || right < -1 {
        return Err("Attention has an invalid output mode, softmax precision or window size".into());
    }
    if scale < 0. {
        return Err("Attention scale must be nonnegative; it is split as a square root".into());
    }
    let full = [qh.batch, qh.heads, qh.steps, total];
    if let Some(m) = mask {
        if !(m.kind == 9 || matches!(m.kind, 1..=7 | 10..=13 | 16)) || m.shape.len() > 4 {
            return Err("attn_mask must be a bool or numeric tensor broadcastable to [B,H,Q,K]".into());
        }
        for (d, &n) in m.shape.iter().rev().enumerate() {
            let want = full[3 - d];
            let padded = d == 0 && version >= 24 && n < want;
            if n != want && n != 1 && !padded {
                return Err("attn_mask shape does not broadcast to [B,H,Q,K]".into());
            }
        }
    }
    // The bias attn_mask adds for query (b, h, i) and key j.
    let bias = |b: usize, h: usize, i: usize, j: usize| -> f64 {
        let Some(m) = mask else { return 0. };
        let (mut flat, mut step) = (0, 1);
        for (d, &n) in m.shape.iter().rev().enumerate() {
            let c = [j, i, h, b][d];
            if n != 1 {
                if c >= n {
                    return f64::NEG_INFINITY;
                }
                flat += c * step;
            }
            step *= n;
        }
        match m.kind {
            9 if m.get(flat).nonzero() => 0.,
            9 => f64::NEG_INFINITY,
            _ => m.get(flat).f(),
        }
    };
    let packed = qh.packed;
    let shape = if packed {
        vec![qh.batch, qh.steps, qh.heads * vh.width]
    } else {
        vec![qh.batch, qh.heads, qh.steps, vh.width]
    };
    let mut y = Tensor::zeros(v.kind, shape)?;
    let out = Heads { batch: qh.batch, heads: qh.heads, steps: qh.steps, width: vh.width, packed };
    let mut weights = Tensor::zeros(q.kind, full.to_vec())?;
    let kind = q.kind as i64;
    let root = rounded(kind, scale.sqrt());
    let group = qh.heads / kh.heads;
    let mut scores = vec![0f64; total];
    let mut query = vec![0f64; qh.width];
    for b in 0..qh.batch {
        let used = match valid {
            None => None,
            Some(t) => {
                let n = t.get(b).i();
                if n < 0 || n as u64 > total as u64 {
                    return Err("nonpad_kv_seqlen must lie between 0 and the key length".into());
                }
                Some(n as usize)
            }
        };
        // Valid keys that precede the query block, for the causal frontier and the windows.
        let offset = match (past_key, used) {
            (Some(_), _) => before as i64,
            (None, Some(n)) => n as i64 - qh.steps as i64,
            (None, None) => 0,
        };
        for h in 0..qh.heads {
            let shared = h / group;
            for i in 0..qh.steps {
                for (d, value) in query.iter_mut().enumerate() {
                    *value = rounded(kind, q.get(qh.at(b, h, i, d)).f() * root);
                }
                let position = offset + i as i64;
                let row = ((b * qh.heads + h) * qh.steps + i) * total;
                let mut largest = f64::NEG_INFINITY;
                for (j, score) in scores.iter_mut().enumerate() {
                    let first = ((b * kh.heads + shared) * total + j) * kh.width;
                    let mut sum = 0.;
                    for (d, &value) in query.iter().enumerate() {
                        sum += value * rounded(kind, keys.get(first + d).f() * root);
                    }
                    let mut s = rounded(kind, sum);
                    if mode == 0 {
                        put(&mut weights, row + j, s);
                    }
                    if softcap != 0. {
                        s = rounded(kind, softcap * (s / softcap).tanh());
                    }
                    if mode == 1 {
                        put(&mut weights, row + j, s);
                    }
                    let k = j as i64;
                    let hidden = (causal && k > position)
                        || (left >= 0 && k < position.saturating_sub(left))
                        || (right >= 0 && k > position.saturating_add(right))
                        || used.is_some_and(|n| j >= n);
                    s += if hidden { f64::NEG_INFINITY } else { bias(b, h, i, j) };
                    if s.is_nan() && hidden {
                        s = f64::NEG_INFINITY;
                    }
                    if mode == 2 {
                        put(&mut weights, row + j, s);
                    }
                    *score = rounded(precision, s);
                    largest = largest.max(*score);
                }
                // A query that may attend to no key gives a zero row, as the specification requires.
                if largest == f64::NEG_INFINITY {
                    continue;
                }
                let mut sum = 0.;
                for score in &mut scores {
                    *score = (*score - largest).exp();
                    sum += *score;
                }
                for (j, score) in scores.iter_mut().enumerate() {
                    *score = rounded(precision, *score / sum);
                    if mode == 3 {
                        put(&mut weights, row + j, *score);
                    }
                }
                for d in 0..vh.width {
                    let mut sum = 0.;
                    for (j, &p) in scores.iter().enumerate() {
                        if p != 0. {
                            let at = ((b * vh.heads + shared) * total + j) * vh.width + d;
                            sum += p * values.get(at).f();
                        }
                    }
                    put(&mut y, out.at(b, h, i, d), sum);
                }
            }
        }
    }
    Ok(vec![y, keys, values, weights])
}

fn rotary(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let cos = input(inputs, 1)?;
    let sin = input(inputs, 2)?;
    let positions = optional(inputs, 3);
    float(x)?;
    same_type(x, cos)?;
    same_type(x, sin)?;
    let heads = a.int("num_heads", 0)?;
    let h = Heads::of(x, heads, "num_heads")?;
    let requested = a.int("rotary_embedding_dim", 0)?;
    let turned = if requested == 0 { h.width as i64 } else { requested };
    if turned < 0 || turned as u64 > h.width as u64 || turned % 2 != 0 {
        return Err("RotaryEmbedding rotates an even number of elements no larger than the head size".into());
    }
    let pairs = turned as usize / 2;
    let interleaved = a.flag("interleaved", false)?;
    let shaped = match positions {
        Some(p) => {
            p.kind == 7 && p.shape == [h.batch, h.steps] && cos.shape.len() == 2 && cos.shape[1] == pairs
        }
        None => cos.shape == [h.batch, h.steps, pairs],
    };
    if !shaped || sin.shape != cos.shape {
        return Err("RotaryEmbedding needs [positions,dim/2] caches with position_ids, or [B,S,dim/2] without".into());
    }
    let mut y = x.clone();
    let kind = x.kind as i64;
    for b in 0..h.batch {
        for s in 0..h.steps {
            let row = match positions {
                None => b * h.steps + s,
                Some(p) => {
                    let id = p.get(b * h.steps + s).i();
                    if id < 0 || id as u64 >= cos.shape[0] as u64 {
                        return Err("RotaryEmbedding position id is outside its caches".into());
                    }
                    id as usize
                }
            };
            for head in 0..h.heads {
                for p in 0..pairs {
                    let (first, second) = if interleaved {
                        (2 * p, 2 * p + 1)
                    } else {
                        (p, p + pairs)
                    };
                    let (i, j) = (h.at(b, head, s, first), h.at(b, head, s, second));
                    let c = cos.get(row * pairs + p).f();
                    let n = sin.get(row * pairs + p).f();
                    let (u, w) = (x.get(i).f(), x.get(j).f());
                    put(&mut y, i, rounded(kind, rounded(kind, c * u) - rounded(kind, n * w)));
                    put(&mut y, j, rounded(kind, rounded(kind, n * u) + rounded(kind, c * w)));
                }
            }
        }
    }
    Ok(vec![y])
}

fn causal_convolution(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let w = input(inputs, 1)?;
    let bias = optional(inputs, 2);
    let past = optional(inputs, 3);
    float(x)?;
    for t in [Some(w), bias, past].into_iter().flatten() {
        same_type(x, t)?;
    }
    let silu = match a.string("activation", "none")? {
        "none" => false,
        "silu" | "swish" => true,
        _ => return Err("CausalConvWithState activation must be none, silu or swish".into()),
    };
    let [batch, channels, length] = x.shape[..] else {
        return Err("CausalConvWithState input must be [B,C,L]".into());
    };
    let kernel = match w.shape[..] {
        [c, 1, k] if c == channels && k > 0 => k,
        _ => return Err("CausalConvWithState weight must be [C,1,K] with K of at least 1".into()),
    };
    let history = kernel - 1;
    if bias.is_some_and(|b| b.shape != [channels]) || past.is_some_and(|p| p.shape != [batch, channels, history]) {
        return Err("CausalConvWithState needs bias [C] and past_state [B,C,K-1]".into());
    }
    let mut y = Tensor::zeros(x.kind, x.shape.clone())?;
    let mut state = Tensor::zeros(x.kind, vec![batch, channels, history])?;
    for b in 0..batch {
        for c in 0..channels {
            let line = b * channels + c;
            // The history followed by the input, in time order.
            let sample = |t: usize| -> f64 {
                if t >= history {
                    x.get(line * length + t - history).f()
                } else {
                    past.map_or(0., |p| p.get(line * history + t).f())
                }
            };
            for t in 0..length {
                let mut sum = bias.map_or(0., |v| v.get(c).f());
                for j in 0..kernel {
                    sum += w.get(c * kernel + j).f() * sample(t + j);
                }
                if silu {
                    let z = rounded(x.kind as i64, sum);
                    sum = z / (1. + (-z).exp());
                }
                put(&mut y, line * length + t, sum);
            }
            for j in 0..history {
                put(&mut state, line * history + j, sample(length + j));
            }
        }
    }
    Ok(vec![y, state])
}

fn linear_attention(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let q = input(inputs, 0)?;
    let k = input(inputs, 1)?;
    let v = input(inputs, 2)?;
    let past = optional(inputs, 3);
    let decay = optional(inputs, 4);
    let beta = optional(inputs, 5);
    for t in [Some(q), Some(k), Some(v), past, decay, beta].into_iter().flatten() {
        if !matches!(t.kind, 1 | 10 | 16) {
            return Err("LinearAttention needs float16, bfloat16 or float tensors".into());
        }
    }
    for t in [Some(k), Some(v), decay, beta].into_iter().flatten() {
        same_type(q, t)?;
    }
    let (q_heads, kv_heads) = (a.int("q_num_heads", 0)?, a.int("kv_num_heads", 0)?);
    if q_heads <= 0 || kv_heads <= 0 || q_heads % kv_heads != 0 {
        return Err("LinearAttention needs positive head counts with q divisible by kv".into());
    }
    let qh = Heads::of_packed(q, q_heads as usize)?;
    let kh = Heads::of_packed(k, kv_heads as usize)?;
    let vh = Heads::of_packed(v, kv_heads as usize)?;
    if [kh.batch, vh.batch] != [qh.batch; 2] || [kh.steps, vh.steps] != [qh.steps; 2] || kh.width != qh.width {
        return Err("LinearAttention query, key and value must share batch, length and key width".into());
    }
    let (gated, delta) = match a.string("update_rule", "gated_delta")? {
        "linear" => (false, false),
        "gated" => (true, false),
        "delta" => (false, true),
        "gated_delta" => (true, true),
        _ => return Err("LinearAttention update_rule must be linear, gated, delta or gated_delta".into()),
    };
    if decay.is_some() != gated || beta.is_some() != delta {
        return Err("LinearAttention takes decay exactly for gated rules and beta exactly for delta rules".into());
    }
    let (batch, steps, heads, dk, dv) = (qh.batch, qh.steps, kh.heads, kh.width, vh.width);
    if dk == 0 || dv == 0 {
        return Err("LinearAttention head widths must be positive".into());
    }
    let per_element = match decay {
        None => false,
        Some(d) if d.shape == [batch, steps, heads * dk] => true,
        Some(d) if d.shape == [batch, steps, heads] => false,
        Some(_) => return Err("LinearAttention decay must be [B,T,H*dk] or [B,T,H]".into()),
    };
    let rates = match beta {
        None => 0,
        Some(b) if b.shape == [batch, steps, heads] => heads,
        Some(b) if b.shape == [batch, steps, 1] => 1,
        Some(_) => return Err("LinearAttention beta must be [B,T,H] or [B,T,1]".into()),
    };
    let state_shape = vec![batch, heads, dk, dv];
    if past.is_some_and(|p| p.shape != state_shape) {
        return Err("LinearAttention past_state must be [B,kv_heads,dk,dv]".into());
    }
    let scale = a.float("scale", 0.)?;
    let scale = if scale == 0. { 1. / (dk as f32).sqrt() } else { scale as f32 };
    let mut state = Tensor::zeros(past.map_or(q.kind, |p| p.kind), state_shape)?;
    let mut y = Tensor::zeros(q.kind, vec![batch, steps, qh.heads * dv])?;
    let group = qh.heads / heads;
    let (mut s, mut key, mut update) = (vec![0f32; dk * dv], vec![0f32; dk], vec![0f32; dv]);
    for b in 0..batch {
        for h in 0..heads {
            let first = (b * heads + h) * dk * dv;
            for (i, value) in s.iter_mut().enumerate() {
                *value = past.map_or(0., |p| p.get(first + i).f() as f32);
            }
            for t in 0..steps {
                let step = b * steps + t;
                for (i, value) in key.iter_mut().enumerate() {
                    *value = k.get(kh.at(b, h, t, i)).f() as f32;
                }
                if let Some(d) = decay {
                    for i in 0..dk {
                        let at = if per_element {
                            step * heads * dk + h * dk + i
                        } else {
                            step * heads + h
                        };
                        let gate = (d.get(at).f() as f32).exp();
                        for value in &mut s[i * dv..(i + 1) * dv] {
                            *value *= gate;
                        }
                    }
                }
                for (j, value) in update.iter_mut().enumerate() {
                    *value = v.get(vh.at(b, h, t, j)).f() as f32;
                }
                if let Some(rate) = beta {
                    let at = step * rates + if rates == 1 { 0 } else { h };
                    let rate = rate.get(at).f() as f32;
                    for (j, value) in update.iter_mut().enumerate() {
                        let read: f32 = (0..dk).map(|i| s[i * dv + j] * key[i]).sum();
                        *value = rate * (*value - read);
                    }
                }
                for i in 0..dk {
                    for j in 0..dv {
                        s[i * dv + j] += key[i] * update[j];
                    }
                }
                for query in h * group..(h + 1) * group {
                    for j in 0..dv {
                        let sum: f32 = (0..dk)
                            .map(|i| q.get(qh.at(b, query, t, i)).f() as f32 * s[i * dv + j])
                            .sum();
                        put(&mut y, step * qh.heads * dv + query * dv + j, (scale * sum) as f64);
                    }
                }
            }
            for (i, &value) in s.iter().enumerate() {
                put(&mut state, first + i, value as f64);
            }
        }
    }
    Ok(vec![y, state])
}

impl Heads {
    fn of_packed(t: &Tensor, heads: usize) -> Result<Self> {
        if t.shape.len() != 3 {
            return Err("LinearAttention inputs must be [B,T,H*D]".into());
        }
        Self::of(t, heads as i64, "head count")
    }
}
