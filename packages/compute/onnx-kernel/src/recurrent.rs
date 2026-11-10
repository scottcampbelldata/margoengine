use crate::attrs::{floating, input, optional, same_type, Attrs};
use crate::tensor::{half, to_bfloat, to_half, Number, Result, Tensor};
pub fn supports(op: &str) -> bool {
    matches!(op, "RNN" | "LSTM" | "GRU")
}
fn round(kind: u32, v: f64) -> f64 {
    match kind {
        1 => v as f32 as f64,
        10 => half(to_half(v)),
        16 => f32::from_bits((to_bfloat(v) as u32) << 16) as f64,
        _ => v,
    }
}
fn activation(name: &str, x: f64, alpha: Option<f64>, beta: Option<f64>) -> Result<f64> {
    Ok(match name {
        "Relu" => {
            if x.is_nan() {
                x
            } else {
                x.max(0.)
            }
        }
        "Tanh" => x.tanh(),
        "Sigmoid" => {
            if x >= 0. {
                1. / (1. + (-x).exp())
            } else {
                let e = x.exp();
                e / (1. + e)
            }
        }
        "Affine" => alpha.unwrap_or(1.) * x + beta.unwrap_or(0.),
        "LeakyRelu" => {
            if x >= 0. {
                x
            } else {
                alpha.unwrap_or(0.01) * x
            }
        }
        "ThresholdedRelu" => {
            if x >= alpha.unwrap_or(1.) {
                x
            } else {
                0.
            }
        }
        "ScaledTanh" => alpha.unwrap_or(1.) * (beta.unwrap_or(1.) * x).tanh(),
        "HardSigmoid" => (alpha.unwrap_or(0.2) * x + beta.unwrap_or(0.5)).clamp(0., 1.),
        "Elu" => {
            if x >= 0. {
                x
            } else {
                alpha.unwrap_or(1.) * x.exp_m1()
            }
        }
        "Softsign" => x / (1. + x.abs()),
        "Softplus" => x.max(0.) + (-x.abs()).exp().ln_1p(),
        _ => {
            return Err(format!(
                "unknown recurrent activation {name}; select an ONNX recurrent activation"
            ))
        }
    })
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    floating(x)?;
    let w = input(inputs, 1)?;
    let r = input(inputs, 2)?;
    same_type(x, w)?;
    same_type(x, r)?;
    if x.shape.len() != 3 {
        return Err(
            "recurrent input X must have rank three; supply sequence/batch/features".into(),
        );
    }
    let layout = a.flag("layout", false)?;
    let time = x.shape[if layout { 1 } else { 0 }];
    let batch = x.shape[if layout { 0 } else { 1 }];
    let features = x.shape[2];
    let h = a.int("hidden_size", 0)?;
    if h <= 0 || h > i32::MAX as i64 {
        return Err(
            "hidden_size must be a positive integer; supply the recurrent state width".into(),
        );
    }
    let h = h as usize;
    let direction = a.string("direction", "forward")?;
    if !matches!(direction, "forward" | "reverse" | "bidirectional") {
        return Err(
            "recurrent direction must be forward/reverse/bidirectional; choose a valid direction"
                .into(),
        );
    }
    let dirs = if direction == "bidirectional" { 2 } else { 1 };
    let gates = if op == "LSTM" {
        4
    } else if op == "GRU" {
        3
    } else {
        1
    };
    if w.shape != [dirs, gates * h, features] || r.shape != [dirs, gates * h, h] {
        return Err(
            "recurrent W/R shapes differ from direction, gates or hidden_size; repair the weights"
                .into(),
        );
    }
    let bias = optional(inputs, 3);
    let lengths = optional(inputs, 4);
    let initial_h = optional(inputs, 5);
    let initial_c = if op == "LSTM" {
        optional(inputs, 6)
    } else {
        None
    };
    let peepholes = if op == "LSTM" {
        optional(inputs, 7)
    } else {
        None
    };
    let state_shape = if layout {
        vec![batch, dirs, h]
    } else {
        vec![dirs, batch, h]
    };
    for (t, shape) in [
        (bias, vec![dirs, 2 * gates * h]),
        (initial_h, state_shape.clone()),
        (initial_c, state_shape.clone()),
        (peepholes, vec![dirs, 3 * h]),
    ] {
        if let Some(t) = t {
            same_type(x, t)?;
            if t.shape != shape {
                return Err("recurrent optional tensor shape differs from its declared layout; repair bias/state/peepholes".into());
            }
        }
    }
    let lens = if let Some(t) = lengths {
        if t.kind != 6 || t.shape != [batch] {
            return Err(
                "sequence_lens must be int32 [batch]; supply valid sequence lengths".into(),
            );
        }
        (0..batch)
            .map(|i| {
                let n = t.get(i).i();
                if n < 0 || n as usize > time {
                    Err("sequence length is outside 0..time; repair sequence_lens".into())
                } else {
                    Ok(n as usize)
                }
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![time; batch]
    };
    let act_per = if op == "LSTM" {
        3
    } else if op == "GRU" {
        2
    } else {
        1
    };
    let defaults = if op == "LSTM" {
        vec!["Sigmoid", "Tanh", "Tanh"]
    } else if op == "GRU" {
        vec!["Sigmoid", "Tanh"]
    } else {
        vec!["Tanh"]
    };
    let acts = a
        .strings("activations")?
        .unwrap_or_else(|| (0..dirs).flat_map(|_| defaults.clone()).collect());
    if acts.len() != dirs * act_per {
        return Err(
            "activations must contain one full activation list per direction; repair activations"
                .into(),
        );
    }
    let alphas = a.floats("activation_alpha")?.unwrap_or_default();
    let betas = a.floats("activation_beta")?.unwrap_or_default();
    if alphas.len() > acts.len() || betas.len() > acts.len() {
        return Err(
            "activation parameter lists exceed activation count; repair activation_alpha/beta"
                .into(),
        );
    }
    for name in &acts {
        activation(name, 0., None, None)?;
    }
    let clip = a.float("clip", f64::INFINITY)?;
    if clip.is_nan() || clip < 0. {
        return Err("recurrent clip must be nonnegative; choose a valid clipping threshold".into());
    }
    let coupled = a.flag("input_forget", false)?;
    let reset_after = a.flag("linear_before_reset", false)?;
    let mut y = Tensor::zeros(
        x.kind,
        if layout {
            vec![batch, time, dirs, h]
        } else {
            vec![time, dirs, batch, h]
        },
    )?;
    let mut yh = Tensor::zeros(x.kind, state_shape.clone())?;
    let mut yc = Tensor::zeros(x.kind, state_shape)?;
    let state_index = |b: usize, d: usize, j: usize| {
        if layout {
            (b * dirs + d) * h + j
        } else {
            (d * batch + b) * h + j
        }
    };
    for d in 0..dirs {
        let reverse = direction == "reverse" || (direction == "bidirectional" && d == 1);
        let activate = |slot: usize, v: f64| {
            activation(
                acts[d * act_per + slot],
                v.clamp(-clip, clip),
                alphas.get(d * act_per + slot).copied(),
                betas.get(d * act_per + slot).copied(),
            )
        };
        for b in 0..batch {
            let mut hidden = (0..h)
                .map(|j| initial_h.map_or(0., |t| t.get(state_index(b, d, j)).f()))
                .collect::<Vec<_>>();
            let mut cell = (0..h)
                .map(|j| initial_c.map_or(0., |t| t.get(state_index(b, d, j)).f()))
                .collect::<Vec<_>>();
            for step in 0..lens[b] {
                let t = if reverse { lens[b] - 1 - step } else { step };
                let xp = if layout {
                    (b * time + t) * features
                } else {
                    (t * batch + b) * features
                };
                let mut projected = vec![0.; gates * h];
                let mut recurrent = vec![0.; gates * h];
                for gate in 0..gates {
                    for j in 0..h {
                        let row = (d * gates + gate) * h + j;
                        let mut sum =
                            bias.map_or(0., |v| v.get(d * 2 * gates * h + gate * h + j).f());
                        for i in 0..features {
                            sum += x.get(xp + i).f() * w.get(row * features + i).f();
                        }
                        projected[gate * h + j] = sum;
                        let mut sum = bias.map_or(0., |v| {
                            v.get(d * 2 * gates * h + gates * h + gate * h + j).f()
                        });
                        for i in 0..h {
                            sum += hidden[i] * r.get(row * h + i).f();
                        }
                        recurrent[gate * h + j] = sum;
                    }
                }
                let mut next = vec![0.; h];
                if op == "RNN" {
                    for j in 0..h {
                        next[j] = round(x.kind, activate(0, projected[j] + recurrent[j])?);
                    }
                } else if op == "LSTM" {
                    for j in 0..h {
                        let peephole = |gate: usize| {
                            peepholes.map_or(0., |v| v.get((d * 3 + gate) * h + j).f())
                        };
                        let i = activate(0, projected[j] + recurrent[j] + peephole(0) * cell[j])?;
                        let f = if coupled {
                            1. - i
                        } else {
                            activate(
                                0,
                                projected[2 * h + j] + recurrent[2 * h + j] + peephole(2) * cell[j],
                            )?
                        };
                        let candidate = activate(1, projected[3 * h + j] + recurrent[3 * h + j])?;
                        cell[j] = round(x.kind, f * cell[j] + i * candidate);
                        let o = activate(
                            0,
                            projected[h + j] + recurrent[h + j] + peephole(1) * cell[j],
                        )?;
                        next[j] = round(x.kind, o * activate(2, cell[j])?);
                    }
                } else {
                    let reset = (0..h)
                        .map(|j| activate(0, projected[h + j] + recurrent[h + j]))
                        .collect::<Result<Vec<_>>>()?;
                    for j in 0..h {
                        let z = activate(0, projected[j] + recurrent[j])?;
                        let recurrent = if reset_after {
                            reset[j] * recurrent[2 * h + j]
                        } else {
                            let row = (d * gates + 2) * h + j;
                            let mut sum = bias.map_or(0., |v| {
                                v.get(d * 2 * gates * h + gates * h + 2 * h + j).f()
                            });
                            for i in 0..h {
                                sum += reset[i] * hidden[i] * r.get(row * h + i).f();
                            }
                            sum
                        };
                        let candidate = activate(1, projected[2 * h + j] + recurrent)?;
                        next[j] = round(x.kind, (1. - z) * candidate + z * hidden[j]);
                    }
                }
                hidden = next;
                for j in 0..h {
                    let at = if layout {
                        ((b * time + t) * dirs + d) * h + j
                    } else {
                        ((t * dirs + d) * batch + b) * h + j
                    };
                    y.set(at, Number::F(hidden[j]));
                }
            }
            for j in 0..h {
                yh.set(state_index(b, d, j), Number::F(hidden[j]));
                yc.set(state_index(b, d, j), Number::F(cell[j]));
            }
        }
    }
    Ok(if op == "LSTM" {
        vec![y, yh, yc]
    } else {
        vec![y, yh]
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    fn t(shape: Vec<usize>, v: &[f64]) -> Tensor {
        Tensor::raw(11, shape, v.iter().flat_map(|v| v.to_le_bytes()).collect()).unwrap()
    }
    fn int(name: &str, n: i64) -> Json {
        Json::object([
            ("name", Json::s(name)),
            ("kind", Json::n(2)),
            ("value", Json::s(n.to_string())),
        ])
    }
    #[test]
    fn lstm_gate_order_and_optional_peepholes() {
        let s = Store::new();
        let e = vec![int("hidden_size", 1)];
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        let y = execute(
            "LSTM",
            &[
                Some(t(vec![1, 1, 1], &[2.])),
                Some(t(vec![1, 4, 1], &[0., 0., 0., 1.])),
                Some(t(vec![1, 4, 1], &[0.; 4])),
            ],
            &a,
        )
        .unwrap();
        let cell = 0.5 * 2f64.tanh();
        assert!((y[2].get(0).f() - cell).abs() < 1e-15);
        assert!((y[1].get(0).f() - 0.5 * cell.tanh()).abs() < 1e-15);
    }
    #[test]
    fn reverse_layout_zero_length_retains_initial_hidden() {
        let s = Store::new();
        let mut e = vec![int("hidden_size", 1), int("layout", 1)];
        e.push(Json::object([
            ("name", Json::s("direction")),
            ("kind", Json::n(3)),
            ("value", Json::s("reverse")),
        ]));
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        let lengths = Tensor::raw(
            6,
            vec![2],
            [2i32, 0].iter().flat_map(|v| v.to_le_bytes()).collect(),
        )
        .unwrap();
        let y = execute(
            "RNN",
            &[
                Some(t(vec![2, 2, 1], &[1., 2., 9., 10.])),
                Some(t(vec![1, 1, 1], &[1.])),
                Some(t(vec![1, 1, 1], &[0.])),
                None,
                Some(lengths),
                Some(t(vec![2, 1, 1], &[0., 7.])),
            ],
            &a,
        )
        .unwrap();
        assert_eq!(y[0].shape, vec![2, 2, 1, 1]);
        assert!((y[0].get(0).f() - 1f64.tanh()).abs() < 1e-15);
        assert!((y[0].get(1).f() - 2f64.tanh()).abs() < 1e-15);
        assert_eq!(y[0].get(2).f(), 0.);
        assert_eq!(y[1].get(1).f(), 7.);
    }
}
