// Philox4x32-10 from Salmon et al. (2011); Box-Muller (1958).
// Each expanded graph call site owns a persistent counter, independent of run scheduling.
use crate::attrs::{floating, input, optional, Attrs};
use crate::tensor::{Number, Result, Tensor};

#[derive(Clone)]
pub struct Random {
    key: [u32; 2],
    counter: u128,
    block: [u32; 4],
    lane: usize,
}
impl Random {
    pub fn new(seed: u64, stream: u32) -> Self {
        Self {
            key: [seed as u32, (seed >> 32) as u32],
            counter: (stream as u128) << 64,
            block: [0; 4],
            lane: 4,
        }
    }
    fn word(&mut self) -> u32 {
        if self.lane == 4 {
            let mut c = [
                self.counter as u32,
                (self.counter >> 32) as u32,
                (self.counter >> 64) as u32,
                (self.counter >> 96) as u32,
            ];
            let mut k = self.key;
            for _ in 0..10 {
                let a = (c[0] as u64) * 0xd2511f53;
                let b = (c[2] as u64) * 0xcd9e8d57;
                c = [
                    (b >> 32) as u32 ^ c[1] ^ k[0],
                    b as u32,
                    (a >> 32) as u32 ^ c[3] ^ k[1],
                    a as u32,
                ];
                k[0] = k[0].wrapping_add(0x9e3779b9);
                k[1] = k[1].wrapping_add(0xbb67ae85);
            }
            self.block = c;
            self.counter = self.counter.wrapping_add(1);
            self.lane = 0;
        }
        let word = self.block[self.lane];
        self.lane += 1;
        word
    }
    fn uniform(&mut self) -> f64 {
        // Exactly representable 53-bit fraction in [0,1), including zero.
        let a = (self.word() >> 5) as u64;
        let b = (self.word() >> 6) as u64;
        ((a << 26) | b) as f64 / 9007199254740992.
    }
    fn normal(&mut self) -> f64 {
        (-2. * (1. - self.uniform()).ln()).sqrt() * (std::f64::consts::TAU * self.uniform()).cos()
    }
}
pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "RandomUniform"
            | "RandomUniformLike"
            | "RandomNormal"
            | "RandomNormalLike"
            | "Bernoulli"
            | "Multinomial"
            | "Dropout"
    )
}
pub fn seed(op: &str, a: &Attrs, default: u64) -> Result<u64> {
    if !a.has("seed") {
        return Ok(default);
    }
    if op == "Dropout" {
        return Ok(a.int("seed", 0)? as u64);
    }
    let value = a.float("seed", 0.)?;
    if !value.is_finite() {
        return Err("random seed must be finite; choose a finite seed".into());
    }
    Ok((value as f32).to_bits() as u64)
}
fn floating_kind(kind: i64) -> Result<u32> {
    if matches!(kind, 1 | 10 | 11 | 16) {
        Ok(kind as u32)
    } else {
        Err("random output must have a floating dtype; specify float16, bfloat16, float32 or float64".into())
    }
}
pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    a: &Attrs,
    version: u32,
    nout: usize,
    rng: &mut Random,
) -> Result<Vec<Tensor>> {
    if op.starts_with("Random") {
        let like = op.ends_with("Like");
        let shape = if like {
            input(inputs, 0)?.shape.clone()
        } else {
            a.ints("shape")?
                .ok_or("random shape attribute is required; provide output dimensions")?
                .iter()
                .map(|&d| {
                    usize::try_from(d).map_err(|_| {
                        "random dimensions must be nonnegative; repair shape".to_string()
                    })
                })
                .collect::<Result<Vec<_>>>()?
        };
        let kind = floating_kind(a.int(
            "dtype",
            if like {
                input(inputs, 0)?.kind as i64
            } else {
                1
            },
        )?)?;
        let mut y = Tensor::zeros(kind, shape)?;
        let normal = op.starts_with("RandomNormal");
        let lo = a.float(if normal { "mean" } else { "low" }, 0.)?;
        let hi = a.float(if normal { "scale" } else { "high" }, 1.)?;
        if !lo.is_finite() || !hi.is_finite() || (normal && hi < 0.) || (!normal && hi <= lo) {
            return Err("random distribution parameters are invalid; use finite bounds with high>low or nonnegative scale".into());
        }
        for i in 0..y.size() {
            let v = if normal {
                lo + hi * rng.normal()
            } else {
                lo + (hi - lo) * rng.uniform()
            };
            // Rounding to a narrower type may otherwise include the excluded high endpoint.
            y.set(i, Number::F(v));
            if !normal && y.get(i).f() >= hi {
                let mut next = v;
                // Compute the previous representable value directly for the declared dtype.
                if kind == 11 {
                    next = if hi == 0. {
                        -f64::from_bits(1)
                    } else {
                        f64::from_bits(hi.to_bits().wrapping_add(if hi > 0. {
                            u64::MAX
                        } else {
                            1
                        }))
                    };
                } else if kind == 1 {
                    let h = hi as f32;
                    next = if h == 0. {
                        -f32::from_bits(1) as f64
                    } else {
                        f32::from_bits(h.to_bits().wrapping_add(if h > 0. { u32::MAX } else { 1 }))
                            as f64
                    };
                } else {
                    let bits = u16::from_le_bytes(y.data[i * 2..i * 2 + 2].try_into().unwrap());
                    let previous = if bits & 0x7fff == 0 {
                        0x8001
                    } else {
                        bits.wrapping_add(if hi > 0. { u16::MAX } else { 1 })
                    };
                    std::sync::Arc::make_mut(&mut y.data)[i * 2..i * 2 + 2]
                        .copy_from_slice(&previous.to_le_bytes());
                    continue;
                }
                y.set(i, Number::F(next));
            }
        }
        return Ok(vec![y]);
    }
    let x = input(inputs, 0)?;
    floating(x)?;
    if op == "Bernoulli" {
        let kind = a.int("dtype", x.kind as i64)?;
        if !matches!(kind, 1..=7 | 9..=13 | 16) {
            return Err("Bernoulli dtype must be numeric or bool; choose a supported dtype".into());
        }
        let mut y = Tensor::zeros(kind as u32, x.shape.clone())?;
        for i in 0..x.size() {
            let p = x.get(i).f();
            if !(0. ..=1.).contains(&p) {
                return Err("Bernoulli probabilities must be in [0,1]; repair its input".into());
            }
            y.set(i, Number::U((rng.uniform() < p) as u64));
        }
        return Ok(vec![y]);
    }
    if op == "Multinomial" {
        if x.shape.len() != 2 || x.shape[1] == 0 {
            return Err("Multinomial input must be [batch,classes] with at least one class; repair its input".into());
        }
        let samples = a.int("sample_size", 1)?;
        let kind = a.int("dtype", 6)?;
        if samples < 1 || !matches!(kind, 6 | 7) {
            return Err("Multinomial needs positive sample_size and int32/int64 dtype; repair its attributes".into());
        }
        let mut y = Tensor::zeros(kind as u32, vec![x.shape[0], samples as usize])?;
        for batch in 0..x.shape[0] {
            let start = batch * x.shape[1];
            let logits: Vec<_> = (0..x.shape[1]).map(|j| x.get(start + j).f()).collect();
            if logits.iter().any(|v| v.is_nan() || *v == f64::INFINITY) {
                return Err("Multinomial log probabilities contain NaN or positive infinity; provide finite or negative-infinite logits".into());
            }
            let max = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            if !max.is_finite() {
                return Err("Multinomial needs at least one finite log probability per row; repair its input".into());
            }
            let weights: Vec<_> = logits.iter().map(|v| (v - max).exp()).collect();
            let total: f64 = weights.iter().sum();
            for sample in 0..samples as usize {
                let mut pick = rng.uniform() * total;
                let mut selected = weights.iter().rposition(|&w| w > 0.).unwrap();
                for (j, &w) in weights.iter().enumerate() {
                    if pick < w {
                        selected = j;
                        break;
                    }
                    pick -= w;
                }
                y.set(
                    batch * samples as usize + sample,
                    Number::I(selected as i64),
                );
            }
        }
        return Ok(vec![y]);
    }
    let ratio = if version < 12 {
        a.float("ratio", 0.5)?
    } else if let Some(r) = optional(inputs, 1) {
        floating(r)?;
        if !r.shape.is_empty() {
            return Err("Dropout ratio must be a scalar; repair its shape".into());
        }
        r.get(0).f()
    } else {
        0.5
    };
    if !(0. ..1.).contains(&ratio) {
        return Err("Dropout ratio must be in [0,1); choose a valid ratio".into());
    }
    let training = if version < 7 {
        !a.flag("is_test", false)?
    } else if version < 12 {
        false
    } else if let Some(t) = optional(inputs, 2) {
        if t.kind != 9 || !t.shape.is_empty() {
            return Err("Dropout training_mode must be a bool scalar; repair its input".into());
        }
        t.get(0).nonzero()
    } else {
        false
    };
    let mut y = if training && ratio > 0. {
        Tensor::zeros(x.kind, x.shape.clone())?
    } else {
        x.clone()
    };
    let mut mask = Tensor::zeros(if version < 10 { x.kind } else { 9 }, x.shape.clone())?;
    for i in 0..x.size() {
        let keep = !training || ratio == 0. || rng.uniform() >= ratio;
        mask.set(i, Number::U(keep as u64));
        if training && ratio > 0. {
            y.set(
                i,
                Number::F(if keep {
                    x.get(i).f() / (1. - ratio)
                } else {
                    0.
                }),
            );
        }
    }
    Ok(if nout == 1 { vec![y] } else { vec![y, mask] })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn philox_published_zero_counter_vector_and_streams() {
        let mut r = Random::new(0, 0);
        assert_eq!(
            [r.word(), r.word(), r.word(), r.word()],
            [0x6627e8d5, 0xe169c58d, 0xbc57ac4c, 0x9b00dbd8]
        );
        let mut a = Random::new(7, 8);
        let mut b = Random::new(7, 8);
        let mut c = Random::new(7, 9);
        for _ in 0..101 {
            let v = a.uniform();
            assert_eq!(v, b.uniform());
            assert!(v >= 0. && v < 1.);
            assert_ne!(v, c.uniform());
        }
    }
}
