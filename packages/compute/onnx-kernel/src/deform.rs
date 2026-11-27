//! ONNX DeformConv (https://onnx.ai/onnx/operators/onnx__DeformConv.html): Dai et al., "Deformable Convolutional
//! Networks", 2017 (https://arxiv.org/abs/1703.06211), and the modulation mask of Zhu et al., "Deformable
//! ConvNets v2", 2018 (https://arxiv.org/abs/1811.11168). Offsets list each kernel position's displacement in
//! spatial axis order; samples are multilinear, and anything outside the input reads zero.
use crate::attrs::{input, optional, same_type, Attrs};
use crate::tensor::{product, strides, Number, Result, Tensor};

pub fn supports(op: &str) -> bool {
    op == "DeformConv"
}

fn list(a: &Attrs, name: &str, n: usize, default: i64, least: i64) -> Result<Vec<usize>> {
    let v = a.ints(name)?.unwrap_or_else(|| vec![default; n]);
    if v.len() != n || v.iter().any(|&v| v < least || v > i32::MAX as i64) {
        return Err(format!("DeformConv {name} must have {n} integers of at least {least}"));
    }
    Ok(v.into_iter().map(|v| v as usize).collect())
}

pub fn execute(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let w = input(inputs, 1)?;
    let offset = input(inputs, 2)?;
    let bias = optional(inputs, 3);
    let mask = optional(inputs, 4);
    if !matches!(x.kind, 1 | 10 | 11 | 16) {
        return Err("DeformConv needs float16, bfloat16, float or double tensors".into());
    }
    for t in [Some(w), Some(offset), bias, mask].into_iter().flatten() {
        same_type(x, t)?;
    }
    if x.shape.len() < 3 || w.shape.len() != x.shape.len() {
        return Err("DeformConv needs N,C,spatial input and weights of the same rank".into());
    }
    let rank = x.shape.len() - 2;
    let spatial = &x.shape[2..];
    let kernel = &w.shape[2..];
    if let Some(k) = a.ints("kernel_shape")? {
        if k.len() != rank || k.iter().zip(kernel).any(|(&a, &b)| a != b as i64) {
            return Err("DeformConv kernel_shape differs from its weights".into());
        }
    }
    let stride = list(a, "strides", rank, 1, 1)?;
    let dilation = list(a, "dilations", rank, 1, 1)?;
    let pads = list(a, "pads", rank * 2, 0, 0)?;
    let (n, channels, outputs) = (x.shape[0], x.shape[1], w.shape[0]);
    let group = a.int("group", 1)?;
    let offset_group = a.int("offset_group", 1)?;
    if group <= 0 || offset_group <= 0 {
        return Err("DeformConv group and offset_group must be positive".into());
    }
    let (group, offset_group) = (group as usize, offset_group as usize);
    let per = w.shape[1];
    if channels % group != 0 || outputs % group != 0 || per != channels / group || channels % offset_group != 0 {
        return Err("DeformConv channels must divide by group and offset_group and match the weights".into());
    }
    let points = product(kernel)?;
    if points == 0 {
        return Err("DeformConv kernel dimensions must be positive".into());
    }
    let mut output = Vec::with_capacity(rank);
    for d in 0..rank {
        let reach = dilation[d] as i128 * (kernel[d] as i128 - 1) + 1;
        let space = spatial[d] as i128 + (pads[d] + pads[rank + d]) as i128 - reach;
        let size = space.div_euclid(stride[d] as i128) + 1;
        output.push(size.max(0) as usize);
    }
    let shape_of = |lead: usize| -> Vec<usize> {
        let mut s = vec![n, lead];
        s.extend(&output);
        s
    };
    if offset.shape != shape_of(offset_group * points * rank) {
        return Err("DeformConv offset shape must be N, offset_group*kernel*rank, then the output size".into());
    }
    if mask.is_some_and(|m| m.shape != shape_of(offset_group * points)) {
        return Err("DeformConv mask shape must be N, offset_group*kernel, then the output size".into());
    }
    if bias.is_some_and(|b| b.shape != [outputs]) {
        return Err("DeformConv bias needs one value per output channel".into());
    }
    let mut y = Tensor::zeros(x.kind, shape_of(outputs))?;
    if y.size() == 0 {
        return Ok(vec![y]);
    }
    let area = product(&output)?;
    let space = product(spatial)?;
    let input_step = strides(spatial);
    let kernel_step = strides(kernel);
    let output_step = strides(&output);
    let mut position = vec![0f64; rank];
    for batch in 0..n {
        for out in 0..outputs {
            let g = out / (outputs / group);
            for at in 0..area {
                let mut sum = bias.map_or(0., |b| b.get(out).f());
                for ic in 0..per {
                    let channel = g * per + ic;
                    let set = channel / (channels / offset_group);
                    for k in 0..points {
                        let m = mask.map_or(1., |m| {
                            m.get((batch * offset_group * points + set * points + k) * area + at).f()
                        });
                        let weight = w.get((out * per + ic) * points + k).f();
                        let first = (batch * offset_group * points * rank + (set * points + k) * rank) * area + at;
                        for d in 0..rank {
                            let o = at / output_step[d] % output[d];
                            let kp = k / kernel_step[d] % kernel[d];
                            position[d] = (o * stride[d] + kp * dilation[d]) as f64 - pads[d] as f64
                                + offset.get(first + d * area).f();
                        }
                        let base = (batch * channels + channel) * space;
                        let mut value = 0.;
                        // The 2^rank grid points around the position, weighted by their distance along each axis.
                        'corner: for corner in 0..1usize << rank {
                            let (mut share, mut index) = (1., 0);
                            for d in 0..rank {
                                let low = position[d].floor();
                                let fraction = position[d] - low;
                                let upper = corner >> d & 1 == 1;
                                let part = if upper { fraction } else { 1. - fraction };
                                if part == 0. {
                                    continue 'corner;
                                }
                                let c = low + if upper { 1. } else { 0. };
                                if !(c >= 0. && c < spatial[d] as f64) {
                                    continue 'corner;
                                }
                                share *= part;
                                index += c as usize * input_step[d];
                            }
                            value += share * x.get(base + index).f();
                        }
                        // A position that is not a number poisons the sum, as arithmetic on it would.
                        if position.iter().any(|p| p.is_nan()) {
                            value = f64::NAN;
                        }
                        sum += value * weight * m;
                    }
                }
                y.set((batch * outputs + out) * area + at, Number::F(sum));
            }
        }
    }
    Ok(vec![y])
}
