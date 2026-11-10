use crate::attrs::{floating, input, optional, same_type, Attrs};
use crate::tensor::{product, strides, Number, Result, Tensor};

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "Conv"
            | "ConvTranspose"
            | "AveragePool"
            | "MaxPool"
            | "LpPool"
            | "GlobalAveragePool"
            | "GlobalMaxPool"
            | "GlobalLpPool"
            | "MaxUnpool"
    )
}
fn list(a: &Attrs, name: &str, n: usize, default: i64, positive: bool) -> Result<Vec<i64>> {
    let v = a.ints(name)?.unwrap_or(vec![default; n]);
    if v.len() != n
        || v.iter()
            .any(|&v| v < if positive { 1 } else { 0 } || v > i32::MAX as i64)
    {
        return Err(format!(
            "{name} must have {n} {} integers; repair the spatial attributes",
            if positive { "positive" } else { "nonnegative" }
        ));
    }
    Ok(v)
}
fn coords(flat: usize, dims: &[usize]) -> Vec<usize> {
    let s = strides(dims);
    dims.iter()
        .enumerate()
        .map(|(i, &n)| if n == 0 { 0 } else { flat / s[i] % n })
        .collect()
}
struct Geometry {
    kernel: Vec<usize>,
    stride: Vec<i64>,
    dilation: Vec<i64>,
    before: Vec<i64>,
    output: Vec<usize>,
}
fn geometry(x: &[usize], kernel: &[usize], a: &Attrs, transpose: bool) -> Result<Geometry> {
    let rank = x.len();
    let stride = list(a, "strides", rank, 1, true)?;
    let dilation = list(a, "dilations", rank, 1, true)?;
    let mut pads = list(a, "pads", rank * 2, 0, false)?;
    let extra = list(a, "output_padding", rank, 0, false)?;
    let mode = a.string("auto_pad", "NOTSET")?;
    if !matches!(mode, "NOTSET" | "VALID" | "SAME_UPPER" | "SAME_LOWER") {
        return Err(
            "auto_pad must be NOTSET/VALID/SAME_UPPER/SAME_LOWER; choose a valid mode".into(),
        );
    }
    if a.has("pads") && mode != "NOTSET" {
        return Err(
            "explicit pads and auto_pad cannot be combined; choose one padding mode".into(),
        );
    }
    let requested = a.ints("output_shape")?;
    if let Some(dims) = &requested {
        if !transpose || dims.len() != rank || dims.iter().any(|&n| n < 0 || n > i32::MAX as i64) {
            return Err("output_shape must contain one nonnegative dimension per transposed-convolution spatial axis; repair output_shape".into());
        }
    }
    let ceil = a.flag("ceil_mode", false)?;
    let mut output = Vec::new();
    for d in 0..rank {
        if kernel[d] == 0 {
            return Err(
                "spatial kernel dimensions must be positive; supply a nonempty kernel".into(),
            );
        }
        let extent = (kernel[d] as i128 - 1) * dilation[d] as i128 + 1;
        let size = x[d] as i128;
        let s = stride[d] as i128;
        if transpose && extra[d] >= stride[d].max(dilation[d]) {
            return Err(
                "output_padding must be smaller than stride or dilation; reduce output padding"
                    .into(),
            );
        }
        let n = if transpose {
            let full = s * (size - 1) + extent + extra[d] as i128;
            let desired = requested.as_ref().map(|v| v[d] as i128).or_else(|| {
                if mode.starts_with("SAME") {
                    Some(size * s)
                } else {
                    None
                }
            });
            if let Some(n) = desired {
                let total = full - n;
                if total < 0 || total > i64::MAX as i128 {
                    return Err("requested convolution output needs negative or excessive padding; supply a valid shape".into());
                }
                let first = if mode == "SAME_UPPER" {
                    total / 2
                } else {
                    total - total / 2
                };
                pads[d] = first as i64;
                pads[d + rank] = (total - first) as i64;
                n
            } else {
                full - pads[d] as i128 - pads[d + rank] as i128
            }
        } else {
            if mode == "VALID" {
                pads[d] = 0;
                pads[d + rank] = 0;
            }
            if mode.starts_with("SAME") {
                let n = (size + s - 1) / s;
                let total = ((n - 1) * s + extent - size).max(0);
                let first = if mode == "SAME_LOWER" {
                    total - total / 2
                } else {
                    total / 2
                };
                if total > i64::MAX as i128 {
                    return Err("automatic padding overflow; use smaller dimensions".into());
                }
                pads[d] = first as i64;
                pads[d + rank] = (total - first) as i64;
                n
            } else {
                let numerator = size + pads[d] as i128 + pads[d + rank] as i128 - extent;
                let mut n = if ceil {
                    -(-numerator).div_euclid(s) + 1
                } else {
                    numerator.div_euclid(s) + 1
                };
                if ceil && n > 0 && (n - 1) * s >= size + pads[d] as i128 {
                    n -= 1;
                }
                n.max(0)
            }
        };
        if n < 0 || n > i32::MAX as i128 {
            return Err(
                "spatial output dimension is outside supported range; repair shape/padding".into(),
            );
        }
        output.push(n as usize);
    }
    Ok(Geometry {
        kernel: kernel.to_vec(),
        stride,
        dilation,
        before: pads[..rank].to_vec(),
        output,
    })
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs, nout: usize) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    x.numeric()?;
    if x.shape.len() < 3 {
        return Err("spatial operators need N,C and at least one spatial dimension; supply channels-first input".into());
    }
    let rank = x.shape.len() - 2;
    let spatial = &x.shape[2..];
    let spatial_size = product(spatial)?;
    let n = x.shape[0];
    let cin = x.shape[1];
    if op == "MaxUnpool" {
        let ids = input(inputs, 1)?;
        if ids.kind != 7 || ids.shape != x.shape {
            return Err(
                "MaxUnpool indices must be int64 with the input shape; supply pooling indices"
                    .into(),
            );
        }
        let kernel = list(a, "kernel_shape", rank, 0, true)?
            .iter()
            .map(|&n| n as usize)
            .collect::<Vec<_>>();
        let g = geometry(spatial, &kernel, a, true)?;
        let mut dims = vec![n, cin];
        dims.extend(g.output);
        if let Some(shape) = optional(inputs, 2) {
            if shape.kind != 7 || shape.shape.len() != 1 {
                return Err(
                    "MaxUnpool output_shape must be int64 vector; supply full output dimensions"
                        .into(),
                );
            }
            let v = shape.ints()?;
            if v.len() != rank + 2 || v.iter().any(|&n| n < 0) {
                return Err(
                    "MaxUnpool output shape has invalid rank or dimensions; repair output_shape"
                        .into(),
                );
            }
            dims = v.iter().map(|&n| n as usize).collect();
            if dims[0] != n || dims[1] != cin {
                return Err(
                    "MaxUnpool output batch/channels must match input; repair output_shape".into(),
                );
            }
        }
        let mut y = Tensor::zeros(x.kind, dims)?;
        for i in 0..x.size() {
            let at = ids.get(i).i();
            if at < 0 || at as u64 >= y.size() as u64 {
                return Err(
                    "MaxUnpool index is outside output; supply matching pooling indices".into(),
                );
            }
            y.copy_element(at as usize, x, i);
        }
        return Ok(vec![y]);
    }
    let conv = matches!(op, "Conv" | "ConvTranspose");
    let transpose = op == "ConvTranspose";
    let global = op.starts_with("Global");
    let w = if conv {
        let w = input(inputs, 1)?;
        floating(x)?;
        same_type(x, w)?;
        if w.shape.len() != x.shape.len() {
            return Err("convolution weights and input ranks must match; supply one kernel axis per spatial dimension".into());
        }
        Some(w)
    } else {
        None
    };
    let kernel = if let Some(w) = w {
        let inferred = w.shape[2..].to_vec();
        if let Some(k) = a.ints("kernel_shape")? {
            if k.len() != rank || k.iter().zip(&inferred).any(|(&a, &b)| a != b as i64) {
                return Err(
                    "kernel_shape differs from convolution weights; use matching kernel dimensions"
                        .into(),
                );
            }
        }
        inferred
    } else if global {
        spatial.to_vec()
    } else {
        list(a, "kernel_shape", rank, 0, true)?
            .iter()
            .map(|&n| n as usize)
            .collect()
    };
    let g = if global {
        Geometry {
            kernel: kernel.clone(),
            stride: vec![1; rank],
            dilation: vec![1; rank],
            before: vec![0; rank],
            output: vec![1; rank],
        }
    } else {
        geometry(spatial, &kernel, a, transpose)?
    };
    let groups = a.int("group", 1)?;
    if groups <= 0 || cin % groups as usize != 0 {
        return Err(
            "convolution groups must be positive and divide input channels; repair group".into(),
        );
    }
    let groups = groups as usize;
    let cout = if let Some(w) = w {
        if transpose {
            if w.shape[0] != cin {
                return Err("ConvTranspose weight input channels differ; repair weights".into());
            }
            w.shape[1]
                .checked_mul(groups)
                .ok_or("output channels overflow; use fewer channels")?
        } else {
            if w.shape[1] != cin / groups || w.shape[0] % groups != 0 {
                return Err("Conv weight channels/groups differ from input; repair weights".into());
            }
            w.shape[0]
        }
    } else {
        cin
    };
    let bias = if conv { optional(inputs, 2) } else { None };
    if let Some(b) = bias {
        same_type(x, b)?;
        if b.shape != [cout] {
            return Err(
                "convolution bias must contain one value per output channel; supply channel bias"
                    .into(),
            );
        }
    }
    let mut dims = vec![n, cout];
    dims.extend(&g.output);
    let mut y = Tensor::zeros(x.kind, dims.clone())?;
    let mut indices = if op == "MaxPool" && nout > 1 {
        Some(Tensor::zeros(7, dims)?)
    } else {
        None
    };
    if y.size() == 0 {
        return Ok(if let Some(ids) = indices {
            vec![y, ids]
        } else {
            vec![y]
        });
    }
    let out_size = product(&g.output)?;
    let kernel_size = product(&g.kernel)?;
    let xs = strides(spatial);
    let col_major = a.flag("storage_order", false)?;
    let include_pad = a.flag("count_include_pad", false)?;
    let p = a.int("p", 2)?;
    if matches!(op, "LpPool" | "GlobalLpPool") && p <= 0 {
        return Err("LpPool p must be positive; choose a positive norm".into());
    }
    let maximum = matches!(op, "MaxPool" | "GlobalMaxPool");
    for batch in 0..n {
        for channel in 0..cout {
            for pos in 0..out_size {
                let oc = coords(pos, &g.output);
                let mut sum = 0.;
                let mut best = Number::F(f64::NEG_INFINITY);
                let mut best_index = 0;
                let mut count = 0;
                let icount = if conv { cin / groups } else { 1 };
                for ic in 0..icount {
                    let input_channel = if conv {
                        channel / (cout / groups) * icount + ic
                    } else {
                        channel
                    };
                    for kp in 0..kernel_size {
                        let kc = coords(kp, &kernel);
                        let mut at = 0usize;
                        let mut valid = true;
                        let mut input_coords = Vec::with_capacity(rank);
                        for d in 0..rank {
                            let coordinate = if transpose {
                                let q = oc[d] as i128 + g.before[d] as i128
                                    - kc[d] as i128 * g.dilation[d] as i128;
                                if q.rem_euclid(g.stride[d] as i128) != 0 {
                                    valid = false;
                                }
                                q.div_euclid(g.stride[d] as i128)
                            } else {
                                oc[d] as i128 * g.stride[d] as i128 - g.before[d] as i128
                                    + kc[d] as i128 * g.dilation[d] as i128
                            };
                            if coordinate < 0 || coordinate >= spatial[d] as i128 {
                                valid = false;
                            }
                            let c = coordinate.max(0) as usize;
                            at = at.saturating_add(c.saturating_mul(xs[d]));
                            input_coords.push(c);
                        }
                        if !valid {
                            continue;
                        }
                        let flat = (batch * cin + input_channel) * spatial_size + at;
                        let v = x.get(flat);
                        if let Some(w) = w {
                            let wi = if transpose {
                                ((input_channel * (cout / groups) + channel % (cout / groups))
                                    * kernel_size)
                                    + kp
                            } else {
                                (channel * icount + ic) * kernel_size + kp
                            };
                            sum += v.f() * w.get(wi).f();
                        } else if maximum {
                            if count == 0
                                || v.cmp(best) == Some(std::cmp::Ordering::Greater)
                                || v.f().is_nan()
                            {
                                best = v;
                                best_index = if col_major {
                                    let mut stride = n * cin;
                                    let mut flat = batch + n * channel;
                                    for d in 0..rank {
                                        flat += input_coords[d] * stride;
                                        stride *= spatial[d];
                                    }
                                    flat
                                } else {
                                    flat
                                };
                            }
                        } else if matches!(op, "LpPool" | "GlobalLpPool") {
                            sum += v.f().abs().powf(p as f64);
                        } else {
                            sum += v.f();
                        }
                        count += 1;
                    }
                }
                let at = (batch * cout + channel) * out_size + pos;
                let value = if conv {
                    Number::F(sum + bias.map_or(0., |b| b.get(channel).f()))
                } else if maximum {
                    best
                } else if matches!(op, "LpPool" | "GlobalLpPool") {
                    Number::F(sum.powf(1. / p as f64))
                } else {
                    Number::F(
                        sum / if include_pad {
                            kernel_size as f64
                        } else {
                            count as f64
                        },
                    )
                };
                y.set(at, value);
                if let Some(ids) = &mut indices {
                    ids.set(at, Number::I(best_index as i64));
                }
            }
        }
    }
    Ok(if let Some(ids) = indices {
        vec![y, ids]
    } else {
        vec![y]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    fn ints(name: &str, v: &[i64]) -> Json {
        Json::object([
            ("name", Json::s(name)),
            ("kind", Json::n(7)),
            (
                "value",
                Json::Array(v.iter().map(|v| Json::s(v.to_string())).collect()),
            ),
        ])
    }
    fn tensor(shape: Vec<usize>, values: &[f32]) -> Tensor {
        Tensor::raw(
            1,
            shape,
            values.iter().flat_map(|v| v.to_le_bytes()).collect(),
        )
        .unwrap()
    }
    #[test]
    fn grouped_dilated_conv_and_transposed_output_geometry() {
        let s = Store::new();
        let attrs = vec![
            ints("dilations", &[2]),
            Json::object([
                ("name", Json::s("group")),
                ("kind", Json::n(2)),
                ("value", Json::s("2")),
            ]),
        ];
        let a = Attrs {
            entries: &attrs,
            store: &s,
        };
        let x = tensor(vec![1, 2, 4], &[1., 2., 3., 4., 10., 20., 30., 40.]);
        let w = tensor(vec![2, 1, 2], &[1., 2., 3., 4.]);
        let y = execute("Conv", &[Some(x), Some(w)], &a, 1).unwrap();
        assert_eq!(
            (0..y[0].size())
                .map(|i| y[0].get(i).f())
                .collect::<Vec<_>>(),
            vec![7., 10., 150., 220.]
        );
        let attrs = vec![ints("strides", &[2]), ints("output_padding", &[1])];
        let a = Attrs {
            entries: &attrs,
            store: &s,
        };
        let y = execute(
            "ConvTranspose",
            &[
                Some(tensor(vec![1, 1, 2], &[2., 3.])),
                Some(tensor(vec![1, 1, 2], &[4., 5.])),
            ],
            &a,
            1,
        )
        .unwrap();
        assert_eq!(y[0].shape, vec![1, 1, 5]);
        assert_eq!(
            (0..5).map(|i| y[0].get(i).f()).collect::<Vec<_>>(),
            vec![8., 10., 12., 15., 0.]
        );
    }
    #[test]
    fn ceil_pool_ignores_windows_starting_in_right_padding() {
        let s = Store::new();
        let mut attrs = vec![
            ints("kernel_shape", &[2]),
            ints("strides", &[2]),
            ints("pads", &[0, 2]),
        ];
        attrs.push(Json::object([
            ("name", Json::s("ceil_mode")),
            ("kind", Json::n(2)),
            ("value", Json::s("1")),
        ]));
        let a = Attrs {
            entries: &attrs,
            store: &s,
        };
        let y = execute(
            "MaxPool",
            &[Some(tensor(vec![1, 1, 3], &[1., 4., 2.]))],
            &a,
            2,
        )
        .unwrap();
        assert_eq!(y[0].shape, vec![1, 1, 2]);
        assert_eq!(y[1].ints().unwrap(), vec![1, 2]);
    }
}
