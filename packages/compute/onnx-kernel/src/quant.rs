//! ONNX quantized operators, written from the operator specifications at
//! https://onnx.ai/onnx/operators/ (QuantizeLinear, DequantizeLinear,
//! DynamicQuantizeLinear, ConvInteger, MatMulInteger, QLinearConv and
//! QLinearMatMul). Affine quantization follows Jacob et al., "Quantization and
//! Training of Neural Networks for Efficient Integer-Arithmetic-Only
//! Inference", 2018 (https://arxiv.org/abs/1712.05877); requantization here is
//! carried in f64, which holds every int32 accumulator exactly.
use crate::attrs::{input, optional, Attrs};
use crate::lowfloat::{self, Round};
use crate::tensor::{
    axis, broadcast_index, half, is_float, strides, to_bfloat, to_half, Number, Result, Tensor,
};
use std::sync::Arc;

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "QuantizeLinear"
            | "DequantizeLinear"
            | "DynamicQuantizeLinear"
            | "ConvInteger"
            | "MatMulInteger"
            | "QLinearConv"
            | "QLinearMatMul"
    )
}

pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs, version: u32) -> Result<Vec<Tensor>> {
    match op {
        "QuantizeLinear" => quantize(inputs, a, version),
        "DequantizeLinear" => dequantize(inputs, a, version),
        "DynamicQuantizeLinear" => dynamic(inputs),
        "ConvInteger" => conv_integer(inputs, a),
        "QLinearConv" => qlinear_conv(inputs, a),
        "MatMulInteger" => matmul_integer(inputs),
        _ => qlinear_matmul(inputs, version),
    }
}

/// Saturation range of an integer storage type.
fn range(kind: u32) -> Option<(f64, f64)> {
    Some(match kind {
        2 => (0., 255.),
        3 => (-128., 127.),
        4 => (0., 65535.),
        5 => (-32768., 32767.),
        21 => (0., 15.),
        22 => (-8., 7.),
        25 => (0., 3.),
        26 => (-2., 1.),
        _ => return None,
    })
}

/// Round to nearest even in one of the floating precisions.
fn rounded(kind: u32, x: f64) -> f64 {
    match kind {
        1 => x as f32 as f64,
        10 => half(to_half(x)),
        16 => f32::from_bits((to_bfloat(x) as u32) << 16) as f64,
        _ => x,
    }
}

/// Integer value minus zero point stays exact; floats subtract as written.
fn centered(value: Number, zero: Option<Number>) -> f64 {
    match zero {
        None => value.f(),
        Some(z) => value.f() - z.f(),
    }
}

/// How one scale or zero-point tensor covers its quantized tensor.
enum Layout {
    Scalar,
    Axis { stride: usize, size: usize },
    Blocked { axis: usize, block: usize },
}

fn layout(x: &Tensor, scale: &Tensor, a: &Attrs, version: u32) -> Result<Layout> {
    let block = a.int("block_size", 0)?;
    if block < 0 {
        return Err("block_size must be nonnegative; use 0 for per-tensor or per-axis".into());
    }
    if block > 0 {
        let d = axis(a.int("axis", 1)?, x.shape.len())?;
        let blocked = x.shape.len() == scale.shape.len()
            && x.shape.iter().zip(&scale.shape).enumerate().all(|(k, (&n, &s))| {
                if k == d {
                    s == n.div_ceil(block as usize)
                } else {
                    s == n
                }
            });
        if !blocked {
            return Err("blocked quantization needs a scale shaped like the input with ceil(size/block_size) on the axis".into());
        }
        return Ok(Layout::Blocked {
            axis: d,
            block: block as usize,
        });
    }
    if scale.shape.is_empty() || (scale.shape.len() == 1 && scale.shape[0] == 1) {
        return Ok(Layout::Scalar);
    }
    if scale.shape.len() != 1 || version < 13 {
        return Err("quantization scale must be a scalar, or from opset 13 a vector along axis".into());
    }
    let d = axis(a.int("axis", 1)?, x.shape.len())?;
    if scale.shape[0] != x.shape[d] {
        return Err("per-axis quantization scale length differs from the axis size; repair the scale".into());
    }
    Ok(Layout::Axis {
        stride: strides(&x.shape)[d],
        size: x.shape[d],
    })
}

impl Layout {
    fn at(&self, i: usize, shape: &[usize]) -> usize {
        match *self {
            Layout::Scalar => 0,
            Layout::Axis { stride, size } => i / stride % size,
            Layout::Blocked { axis, block } => {
                // Row-major position in the scale tensor, whose axis is divided into blocks.
                let (mut rest, mut at, mut step) = (i, 0, 1);
                for k in (0..shape.len()).rev() {
                    let c = rest % shape[k];
                    rest /= shape[k];
                    let (c, n) = if k == axis {
                        (c / block, shape[k].div_ceil(block))
                    } else {
                        (c, shape[k])
                    };
                    at += c * step;
                    step *= n;
                }
                at
            }
        }
    }
}

fn scale_kind(t: &Tensor, version: u32) -> Result<()> {
    let allowed = match t.kind {
        1 => true,
        10 | 16 => version >= 19,
        6 => version >= 19,
        24 => version >= 24,
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("quantization scale type is not allowed at this opset; use float, or float16/bfloat16 from opset 19".into())
    }
}

/// Storage types QuantizeLinear may write and DequantizeLinear may read.
fn quantized_kind(kind: u32, version: u32) -> bool {
    match kind {
        2 | 3 => true,
        17..=20 => version >= 19,
        4 | 5 | 21 | 22 => version >= 21,
        23 => version >= 23,
        27 | 28 => version >= 28,
        25 | 26 => version >= 25,
        _ => false,
    }
}

fn quantize(inputs: &[Option<Tensor>], a: &Attrs, version: u32) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let scale = input(inputs, 1)?;
    let zero = optional(inputs, 2);
    let source = matches!(x.kind, 1 | 6) || (version >= 19 && matches!(x.kind, 10 | 16));
    if !source {
        return Err("QuantizeLinear input must be float or int32, or float16/bfloat16 from opset 19".into());
    }
    scale_kind(scale, version)?;
    let requested = a.int("output_dtype", 0)?;
    let kind = match (requested, zero) {
        (0, Some(z)) => z.kind,
        (0, None) => 2,
        (k, z) => {
            let k = u32::try_from(k).map_err(|_| "output_dtype is not a tensor type")?;
            if z.is_some_and(|z| z.kind != k) {
                return Err("QuantizeLinear zero point type differs from output_dtype; use one type".into());
            }
            k
        }
    };
    if !quantized_kind(kind, version) {
        return Err("QuantizeLinear output type is not allowed at this opset; export a newer opset".into());
    }
    if zero.is_some_and(|z| z.shape != scale.shape) {
        return Err("QuantizeLinear zero point shape differs from the scale; supply matching shapes".into());
    }
    let precision = match a.int("precision", 0)? {
        0 if is_float(scale.kind) && scale.kind != 24 => scale.kind,
        0 => 1,
        k @ (1 | 10 | 16) => k as u32,
        _ => return Err("QuantizeLinear precision must be float, float16 or bfloat16".into()),
    };
    let saturate = a.flag("saturate", true)?;
    let map = layout(x, scale, a, version)?;
    let mut y = Tensor::zeros(kind, x.shape.clone())?;
    let bounds = range(kind);
    for i in 0..y.size() {
        let k = map.at(i, &x.shape);
        let q = rounded(
            precision,
            rounded(precision, x.get(i).f()) / rounded(precision, scale.get(k).f()),
        );
        let z = zero.map_or(0., |z| z.get(k).f());
        match bounds {
            Some((low, high)) => {
                // NaN has no integer value; it takes the zero point.
                let v = if q.is_nan() { z } else { q.round_ties_even() + z };
                y.set(i, Number::I(v.clamp(low, high) as i64));
            }
            None => {
                let code = lowfloat::encode(kind, q + z, saturate, Round::Up);
                if matches!(kind, 23 | 27 | 28) {
                    y.set(i, Number::F(lowfloat::decode(kind, code)));
                } else {
                    Arc::make_mut(&mut y.data)[i] = code;
                }
            }
        }
    }
    Ok(vec![y])
}

fn dequantize(inputs: &[Option<Tensor>], a: &Attrs, version: u32) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let scale = input(inputs, 1)?;
    let zero = optional(inputs, 2);
    if !(x.kind == 6 || quantized_kind(x.kind, version)) {
        return Err("DequantizeLinear input type is not allowed at this opset; export a newer opset".into());
    }
    scale_kind(scale, version)?;
    if zero.is_some_and(|z| z.kind != x.kind || z.shape != scale.shape) {
        return Err("DequantizeLinear zero point must match the input type and the scale shape".into());
    }
    if x.kind == 6 && zero.is_some_and(|z| (0..z.size()).any(|i| z.get(i).i() != 0)) {
        return Err("DequantizeLinear int32 input takes only a zero zero point; remove it".into());
    }
    let kind = match a.int("output_dtype", 0)? {
        0 if version < 19 => 1,
        0 if matches!(scale.kind, 1 | 10 | 16) => scale.kind,
        k @ (1 | 10 | 16) => k as u32,
        _ => return Err("DequantizeLinear output must be float, float16 or bfloat16; set output_dtype".into()),
    };
    let map = layout(x, scale, a, version)?;
    let mut y = Tensor::zeros(kind, x.shape.clone())?;
    for i in 0..y.size() {
        let k = map.at(i, &x.shape);
        let v = rounded(kind, centered(x.get(i), zero.map(|z| z.get(k))));
        y.set(i, Number::F(v * rounded(kind, scale.get(k).f())));
    }
    Ok(vec![y])
}

fn dynamic(inputs: &[Option<Tensor>]) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    if x.kind != 1 {
        return Err("DynamicQuantizeLinear input must be float32; Cast it first".into());
    }
    let (mut low, mut high) = (0f32, 0f32);
    for i in 0..x.size() {
        let v = x.get(i).f() as f32;
        low = low.min(v);
        high = high.max(v);
    }
    let mut scale = (high - low) / 255.;
    if scale == 0. || !scale.is_finite() {
        scale = 1.;
    }
    let zero = (-low / scale).round_ties_even().clamp(0., 255.);
    let mut y = Tensor::zeros(2, x.shape.clone())?;
    for i in 0..y.size() {
        let q = (x.get(i).f() as f32 / scale).round_ties_even() + zero;
        y.set(i, Number::U(q.clamp(0., 255.) as u64));
    }
    let mut s = Tensor::zeros(1, vec![])?;
    s.set(0, Number::F(scale as f64));
    let mut z = Tensor::zeros(2, vec![])?;
    z.set(0, Number::U(zero as u64));
    Ok(vec![y, s, z])
}

fn byte_integer(t: &Tensor) -> Result<()> {
    if matches!(t.kind, 2 | 3) {
        Ok(())
    } else {
        Err("quantized convolution and integer MatMul inputs must be int8 or uint8".into())
    }
}

fn matching_zero<'a>(zero: Option<&'a Tensor>, of: &Tensor) -> Result<Option<&'a Tensor>> {
    if zero.is_some_and(|z| z.kind != of.kind) {
        return Err("zero point type differs from its tensor; use the same type".into());
    }
    Ok(zero)
}

/// Per output channel value: one shared element, or one per weight channel.
fn channel(t: &Tensor, channels: usize, c: usize) -> Result<Number> {
    if t.size() == 1 && t.shape.len() <= 1 {
        Ok(t.get(0))
    } else if t.shape == [channels] {
        Ok(t.get(c))
    } else {
        Err("convolution weight scale and zero point must be a scalar or one per output channel".into())
    }
}

fn scalar(t: &Tensor, what: &str) -> Result<f64> {
    if t.size() == 1 && t.shape.len() <= 1 {
        Ok(t.get(0).f())
    } else {
        Err(format!("{what} must be a scalar; supply one value"))
    }
}

/// Exact integer convolution accumulators in float64 storage.
fn accumulate(
    x: &Tensor,
    x_zero: Option<&Tensor>,
    w: &Tensor,
    w_zero: Option<&Tensor>,
    a: &Attrs,
) -> Result<Tensor> {
    byte_integer(x)?;
    byte_integer(w)?;
    if w.shape.is_empty() {
        return Err("convolution weights need M,C and kernel axes".into());
    }
    let zx = matching_zero(x_zero, x)?
        .map(|z| scalar(z, "input zero point"))
        .transpose()?
        .unwrap_or(0.);
    let mut left = Tensor::zeros(11, x.shape.clone())?;
    for i in 0..x.size() {
        left.set(i, Number::F(x.get(i).f() - zx));
    }
    let channels = w.shape[0];
    let per = w.size() / channels.max(1);
    let mut right = Tensor::zeros(11, w.shape.clone())?;
    let zw = matching_zero(w_zero, w)?;
    for i in 0..w.size() {
        let z = match zw {
            None => 0.,
            Some(z) => channel(z, channels, i / per)?.f(),
        };
        right.set(i, Number::F(w.get(i).f() - z));
    }
    crate::spatial::execute("Conv", &[Some(left), Some(right)], a, 1).map(|mut v| v.remove(0))
}

fn int32(value: f64) -> Result<i64> {
    if value < i32::MIN as f64 || value > i32::MAX as f64 {
        Err("quantized accumulator overflows int32; reduce the kernel or the quantized range".into())
    } else {
        Ok(value as i64)
    }
}

fn conv_integer(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let sum = accumulate(
        input(inputs, 0)?,
        optional(inputs, 2),
        input(inputs, 1)?,
        optional(inputs, 3),
        a,
    )?;
    let mut y = Tensor::zeros(6, sum.shape.clone())?;
    for i in 0..y.size() {
        y.set(i, Number::I(int32(sum.get(i).f())?));
    }
    Ok(vec![y])
}

fn qlinear_conv(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let mut required = Vec::with_capacity(8);
    for i in 0..8 {
        required.push(input(inputs, i)?);
    }
    let [x, xs, xz, w, ws, wz, ys, yz] = required[..] else {
        unreachable!("eight inputs were collected")
    };
    byte_integer(yz)?;
    for s in [xs, ws, ys] {
        if s.kind != 1 {
            return Err("QLinearConv scales must be float32".into());
        }
    }
    let x_scale = scalar(xs, "x_scale")?;
    let y_scale = scalar(ys, "y_scale")?;
    let y_zero = scalar(yz, "y_zero_point")?;
    let sum = accumulate(x, Some(xz), w, Some(wz), a)?;
    let channels = sum.shape[1];
    let bias = optional(inputs, 8);
    if bias.is_some_and(|b| b.kind != 6 || b.shape != [channels]) {
        return Err("QLinearConv bias must be int32 with one value per output channel".into());
    }
    let multipliers = (0..channels)
        .map(|c| Ok(x_scale * channel(ws, channels, c)?.f() / y_scale))
        .collect::<Result<Vec<_>>>()?;
    let per = sum.size() / (sum.shape[0] * channels).max(1);
    let (low, high) = range(yz.kind).ok_or("QLinearConv output must be int8 or uint8")?;
    let mut y = Tensor::zeros(yz.kind, sum.shape.clone())?;
    for i in 0..y.size() {
        let c = i / per % channels;
        let total = int32(sum.get(i).f() + bias.map_or(0., |b| b.get(c).f()))? as f64;
        let q = (total * multipliers[c]).round_ties_even() + y_zero;
        y.set(i, Number::I(q.clamp(low, high) as i64));
    }
    Ok(vec![y])
}

/// Which matrix axis a per-line quantization parameter follows.
#[derive(Clone, Copy, PartialEq)]
enum Line {
    Row,
    Column,
}

/// Element index of a scale or zero point for position `i` of a matrix tensor:
/// scalar, one per row or column of a 2-D matrix, or a full-rank shape that is
/// 1 along the other matrix axis.
fn line_index(p: &Tensor, shape: &[usize], i: usize, line: Option<Line>) -> Result<usize> {
    if p.size() == 1 && p.shape.len() <= shape.len() {
        return Ok(0);
    }
    let r = shape.len();
    if r == 2 && p.shape.len() == 1 {
        if line == Some(Line::Row) && p.shape[0] == shape[0] {
            return Ok(i / shape[1].max(1));
        }
        if line == Some(Line::Column) && p.shape[0] == shape[1] {
            return Ok(i % shape[1].max(1));
        }
    }
    if r >= 2 && p.shape.len() == r {
        let along = |k: usize| match line {
            Some(Line::Row) => k != r - 1 || p.shape[k] == 1,
            Some(Line::Column) => k != r - 2 || p.shape[k] == 1,
            None => true,
        };
        if p.shape.iter().zip(shape).enumerate().all(|(k, (&s, &n))| (s == n || s == 1) && along(k)) {
            return Ok(broadcast_index(i, shape, &p.shape));
        }
    }
    Err("matrix quantization parameters must be a scalar, per row for the left operand or per column for the right".into())
}

/// A matrix minus its zero point (and times its scale) as float64.
fn matrix(t: &Tensor, zero: Option<&Tensor>, scale: Option<&Tensor>, line: Line) -> Result<Tensor> {
    let zero = matching_zero(zero, t)?;
    let line = if t.shape.len() < 2 { None } else { Some(line) };
    let mut y = Tensor::zeros(11, t.shape.clone())?;
    for i in 0..t.size() {
        let z = match zero {
            None => None,
            Some(z) => Some(z.get(line_index(z, &t.shape, i, line)?)),
        };
        let mut v = centered(t.get(i), z);
        if let Some(s) = scale {
            v *= s.get(line_index(s, &t.shape, i, line)?).f();
        }
        y.set(i, Number::F(v));
    }
    Ok(y)
}

fn matmul_integer(inputs: &[Option<Tensor>]) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let w = input(inputs, 1)?;
    byte_integer(x)?;
    byte_integer(w)?;
    let left = matrix(x, optional(inputs, 2), None, Line::Row)?;
    let right = matrix(w, optional(inputs, 3), None, Line::Column)?;
    let sum = crate::linear::matmul(&left, &right)?;
    let mut y = Tensor::zeros(6, sum.shape.clone())?;
    for i in 0..y.size() {
        y.set(i, Number::I(int32(sum.get(i).f())?));
    }
    Ok(vec![y])
}

fn qlinear_matmul(inputs: &[Option<Tensor>], version: u32) -> Result<Vec<Tensor>> {
    let mut required = Vec::with_capacity(8);
    for i in 0..8 {
        required.push(input(inputs, i)?);
    }
    let [x, xs, xz, w, ws, wz, ys, yz] = required[..] else {
        unreachable!("eight inputs were collected")
    };
    for t in [x, w, yz] {
        if !(matches!(t.kind, 2 | 3) || (version >= 21 && matches!(t.kind, 17..=20))) {
            return Err("QLinearMatMul values must be int8 or uint8, or 8-bit floats from opset 21".into());
        }
    }
    for s in [xs, ws, ys] {
        if !(s.kind == 1 || (version >= 21 && matches!(s.kind, 10 | 16))) {
            return Err("QLinearMatMul scales must be float, or float16/bfloat16 from opset 21".into());
        }
    }
    // Per-row and per-column scales factor out of each inner product, so they apply before it.
    let left = matrix(x, Some(xz), Some(xs), Line::Row)?;
    let right = matrix(w, Some(wz), Some(ws), Line::Column)?;
    let sum = crate::linear::matmul(&left, &right)?;
    let mut y = Tensor::zeros(yz.kind, sum.shape.clone())?;
    for i in 0..y.size() {
        let k = output_index(ys, &sum.shape, i)?;
        let z = yz.get(output_index(yz, &sum.shape, i)?).f();
        let q = sum.get(i).f() / ys.get(k).f();
        match range(yz.kind) {
            Some((low, high)) => {
                let v = if q.is_nan() { z } else { q.round_ties_even() + z };
                y.set(i, Number::I(v.clamp(low, high) as i64));
            }
            None => Arc::make_mut(&mut y.data)[i] = lowfloat::encode(yz.kind, q + z, true, Round::Up),
        }
    }
    Ok(vec![y])
}

fn output_index(p: &Tensor, shape: &[usize], i: usize) -> Result<usize> {
    line_index(p, shape, i, Some(Line::Row))
        .or_else(|_| line_index(p, shape, i, Some(Line::Column)))
}
