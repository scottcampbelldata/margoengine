use crate::attrs::{floating, input, optional, same_type, Attrs};
use crate::tensor::{elements, product, strides, Number, Result, Tensor};
pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "NonMaxSuppression" | "GridSample" | "AffineGrid" | "RoiAlign" | "MaxRoiPool" | "Col2Im"
    )
}
fn nms(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Tensor> {
    let boxes = input(inputs, 0)?;
    let scores = input(inputs, 1)?;
    if boxes.kind != 1
        || scores.kind != 1
        || boxes.shape.len() != 3
        || scores.shape.len() != 3
        || boxes.shape[2] != 4
        || boxes.shape[0] != scores.shape[0]
        || boxes.shape[1] != scores.shape[2]
    {
        return Err(
            "NonMaxSuppression needs float32 boxes[B,K,4] and scores[B,C,K]; repair input shapes"
                .into(),
        );
    }
    let scalar = |i: usize, kind: u32, default: f64| -> Result<f64> {
        if let Some(t) = optional(inputs, i) {
            if t.kind != kind || !t.shape.is_empty() {
                return Err("NonMaxSuppression optional inputs must have the declared scalar type; repair inputs".into());
            }
            Ok(t.get(0).f())
        } else {
            Ok(default)
        }
    };
    let max = scalar(2, 7, 0.)?;
    let threshold = scalar(3, 1, 0.)?;
    let score_threshold = scalar(4, 1, f64::NEG_INFINITY)?;
    if max < 0. || !(0. ..=1.).contains(&threshold) {
        return Err(
            "NonMaxSuppression requires nonnegative maximum and IoU in [0,1]; repair thresholds"
                .into(),
        );
    }
    let center = a.flag("center_point_box", false)?;
    let count = boxes.shape[1];
    let mut result = Vec::new();
    let rect = |b: usize, i: usize| {
        let at = (b * count + i) * 4;
        let v: Vec<_> = (0..4).map(|j| boxes.get(at + j).f()).collect();
        if center {
            [
                v[0] - v[2] / 2.,
                v[1] - v[3] / 2.,
                v[0] + v[2] / 2.,
                v[1] + v[3] / 2.,
            ]
        } else {
            [
                v[1].min(v[3]),
                v[0].min(v[2]),
                v[1].max(v[3]),
                v[0].max(v[2]),
            ]
        }
    };
    for batch in 0..boxes.shape[0] {
        for class in 0..scores.shape[1] {
            let score = |i: usize| {
                scores
                    .get((batch * scores.shape[1] + class) * count + i)
                    .f()
            };
            let mut order: Vec<_> = (0..count)
                .filter(|&i| score(i) >= score_threshold)
                .collect();
            order.sort_by(|&i, &j| score(j).total_cmp(&score(i)).then(i.cmp(&j)));
            let mut chosen = Vec::new();
            for i in order {
                if chosen.len() >= max as usize {
                    break;
                }
                let r = rect(batch, i);
                let mut suppress = false;
                for &j in &chosen {
                    let s = rect(batch, j);
                    let intersection = (r[2].min(s[2]) - r[0].max(s[0])).max(0.)
                        * (r[3].min(s[3]) - r[1].max(s[1])).max(0.);
                    let union = (r[2] - r[0]) * (r[3] - r[1]) + (s[2] - s[0]) * (s[3] - s[1])
                        - intersection;
                    if union > 0. && intersection / union > threshold {
                        suppress = true;
                        break;
                    }
                }
                if !suppress {
                    chosen.push(i);
                    elements(&[result.len() + 3])?;
                    result.extend([batch as i64, class as i64, i as i64]);
                }
            }
        }
    }
    let n = result.len() / 3;
    Tensor::vector_i64(&result)?.reshape(vec![n, 3])
}
fn grid(inputs: &[Option<Tensor>], a: &Attrs, version: u32) -> Result<Tensor> {
    let x = input(inputs, 0)?;
    let g = input(inputs, 1)?;
    floating(g)?;
    if x.shape.len() < 3 {
        return Err(
            "GridSample input needs batch, channel and spatial dimensions; repair input rank"
                .into(),
        );
    }
    let r = x.shape.len() - 2;
    if g.shape.len() != r + 2 || g.shape[0] != x.shape[0] || g.shape[r + 1] != r {
        return Err("GridSample grid must be [N,spatial...,rank]; repair grid shape".into());
    }
    let mode = a.string("mode", if version < 20 { "bilinear" } else { "linear" })?;
    let mode = match mode {
        "bilinear" => "linear",
        "bicubic" => "cubic",
        v => v,
    };
    if !matches!(mode, "nearest" | "linear" | "cubic") {
        return Err(
            "GridSample mode must be nearest, linear or cubic; choose a supported mode".into(),
        );
    }
    if mode != "nearest" {
        x.numeric()?;
    }
    let padding = a.string("padding_mode", "zeros")?;
    if !matches!(padding, "zeros" | "border" | "reflection") {
        return Err(
            "GridSample padding must be zeros, border or reflection; repair attribute".into(),
        );
    }
    let align = a.flag("align_corners", false)?;
    let spatial = &x.shape[2..];
    let ss = strides(spatial);
    let input_plane = product(spatial)?;
    let out_shape = &g.shape[1..r + 1];
    let plane = product(out_shape)?;
    let mut shape = vec![x.shape[0], x.shape[1]];
    shape.extend(out_shape);
    let mut y = Tensor::zeros(x.kind, shape)?;
    if y.size() == 0 {
        return Ok(y);
    }
    if spatial.contains(&0) {
        return Err(
            "GridSample cannot sample an empty input spatial dimension; provide nonempty data"
                .into(),
        );
    }
    let map = |v: f64, d: usize| -> Option<usize> {
        let n = spatial[d] as f64;
        let v = match padding {
            "border" => v.max(0.).min(n - 1.),
            "reflection" => {
                let low = if align { 0. } else { -0.5 };
                let high = if align { n - 1. } else { n - 0.5 };
                let span = high - low;
                if span == 0. {
                    0.
                } else {
                    let q = (v - low).rem_euclid(2. * span);
                    (low + if q > span { 2. * span - q } else { q })
                        .max(0.)
                        .min(n - 1.)
                }
            }
            _ => v,
        };
        if !v.is_finite() || v < 0. || v >= n {
            None
        } else {
            Some(v as usize)
        }
    };
    for batch in 0..x.shape[0] {
        for p in 0..plane {
            let coords: Vec<_> = (0..r)
                .map(|d| {
                    let v = g.get((batch * plane + p) * r + r - 1 - d).f();
                    let v = if v.is_nan() { -1. } else { v };
                    if align {
                        (v + 1.) * (spatial[d] - 1) as f64 / 2.
                    } else {
                        ((v + 1.) * spatial[d] as f64 - 1.) / 2.
                    }
                })
                .collect();
            if mode == "nearest" {
                let mut offset = Some(0);
                for d in 0..r {
                    offset = offset
                        .and_then(|at| map(coords[d].round_ties_even(), d).map(|v| at + v * ss[d]));
                }
                for c in 0..x.shape[1] {
                    if let Some(at) = offset {
                        y.copy_element(
                            (batch * x.shape[1] + c) * plane + p,
                            x,
                            (batch * x.shape[1] + c) * input_plane + at,
                        );
                    }
                }
            } else {
                let count = if mode == "linear" { 2 } else { 4 };
                let options = vec![count; r];
                let n = elements(&options)?;
                let mut samples = Vec::with_capacity(n);
                for mut j in 0..n {
                    let mut weight = 1.;
                    let mut offset = Some(0);
                    for d in (0..r).rev() {
                        let k = j % count;
                        j /= count;
                        let base = coords[d].floor();
                        let tap = base + k as f64 - if count == 4 { 1. } else { 0. };
                        let delta = coords[d] - tap;
                        weight *= if count == 2 {
                            1. - delta.abs()
                        } else {
                            crate::resize::cubic(delta, -0.75)
                        };
                        offset = offset.and_then(|at| map(tap, d).map(|v| at + v * ss[d]));
                    }
                    if weight != 0. {
                        if let Some(at) = offset {
                            samples.push((at, weight));
                        }
                    }
                }
                for c in 0..x.shape[1] {
                    let base = (batch * x.shape[1] + c) * input_plane;
                    let value = samples
                        .iter()
                        .map(|&(at, w)| x.get(base + at).f() * w)
                        .sum();
                    y.set((batch * x.shape[1] + c) * plane + p, Number::F(value));
                }
            }
        }
    }
    Ok(y)
}
fn affine(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Tensor> {
    let theta = input(inputs, 0)?;
    floating(theta)?;
    let size = input(inputs, 1)?;
    if size.kind != 7 || size.shape.len() != 1 || !matches!(size.size(), 4 | 5) {
        return Err(
            "AffineGrid size must be int64[4] or int64[5]; provide NCHW or NCDHW size".into(),
        );
    }
    let dims = size.ints()?;
    if dims.iter().any(|&n| n < 0 || n > i32::MAX as i64) {
        return Err("AffineGrid dimensions must be valid nonnegative sizes; repair size".into());
    }
    let r = dims.len() - 2;
    if theta.shape != [dims[0] as usize, r, r + 1] {
        return Err("AffineGrid theta must be [N,D,D+1]; repair its shape".into());
    }
    let spatial: Vec<_> = dims[2..].iter().map(|&n| n as usize).collect();
    let ss = strides(&spatial);
    let plane = product(&spatial)?;
    let mut shape = vec![dims[0] as usize];
    shape.extend(&spatial);
    shape.push(r);
    let mut y = Tensor::zeros(theta.kind, shape)?;
    if y.size() == 0 {
        return Ok(y);
    }
    let align = a.flag("align_corners", false)?;
    for batch in 0..dims[0] as usize {
        for p in 0..plane {
            for row in 0..r {
                let base = (batch * r + row) * (r + 1);
                let mut value = theta.get(base + r).f();
                for col in 0..r {
                    let d = r - 1 - col;
                    let n = spatial[d];
                    let v = if n <= 1 {
                        0.
                    } else if align {
                        2. * (p / ss[d] % n) as f64 / (n - 1) as f64 - 1.
                    } else {
                        (2. * (p / ss[d] % n) as f64 + 1.) / n as f64 - 1.
                    };
                    value += theta.get(base + col).f() * v;
                }
                y.set((batch * plane + p) * r + row, Number::F(value));
            }
        }
    }
    Ok(y)
}
fn roi(inputs: &[Option<Tensor>], a: &Attrs, version: u32, max_pool: bool) -> Result<Tensor> {
    let x = input(inputs, 0)?;
    let boxes = input(inputs, 1)?;
    floating(x)?;
    same_type(x, boxes)?;
    if x.shape.len() != 4
        || boxes.shape.len() != 2
        || boxes.shape[1] != if max_pool { 5 } else { 4 }
        || x.shape[2] == 0
        || x.shape[3] == 0
    {
        return Err("ROI requires nonempty NCHW input and ROI rows of length 4 (align) or 5 (pool); repair input shapes".into());
    }
    let (oh, ow) = if max_pool {
        let shape = a
            .ints("pooled_shape")?
            .ok_or("MaxRoiPool pooled_shape is required; provide height,width")?;
        if shape.len() != 2 {
            return Err("MaxRoiPool pooled_shape needs two dimensions; repair attribute".into());
        }
        (shape[0], shape[1])
    } else {
        (a.int("output_height", 1)?, a.int("output_width", 1)?)
    };
    let ratio = a.int("sampling_ratio", 0)?;
    let scale = a.float("spatial_scale", 1.)?;
    let mode = a.string("mode", "avg")?;
    let transform = a.string(
        "coordinate_transformation_mode",
        if version < 16 {
            "output_half_pixel"
        } else {
            "half_pixel"
        },
    )?;
    if oh <= 0
        || ow <= 0
        || ratio < 0
        || !scale.is_finite()
        || !matches!(mode, "avg" | "max")
        || !matches!(transform, "half_pixel" | "output_half_pixel")
    {
        return Err(
            "ROI attributes have invalid sizes, sampling or mode; repair attributes".into(),
        );
    }
    let batches = if max_pool {
        None
    } else {
        let t = input(inputs, 2)?;
        if t.kind != 7 || t.shape != [boxes.shape[0]] {
            return Err("RoiAlign batch_indices must be int64[num_rois]; repair input".into());
        }
        Some(t)
    };
    let (oh, ow) = (oh as usize, ow as usize);
    let (h, w) = (x.shape[2], x.shape[3]);
    let mut y = Tensor::zeros(x.kind, vec![boxes.shape[0], x.shape[1], oh, ow])?;
    if y.size() == 0 {
        return Ok(y);
    }
    let shifted = !max_pool && transform == "half_pixel";
    for r in 0..boxes.shape[0] {
        let at = r * boxes.shape[1];
        let batch = if let Some(b) = batches {
            b.get(r).i()
        } else {
            boxes.get(at).f() as i64
        };
        if batch < 0 || batch as usize >= x.shape[0] {
            return Err("ROI batch index is out of range; repair input".into());
        }
        let base = at + if max_pool { 1 } else { 0 };
        let mut coords = [0.; 4];
        for d in 0..4 {
            coords[d] = boxes.get(base + d).f() * scale;
            if !coords[d].is_finite() {
                return Err("ROI coordinates must be finite; repair boxes".into());
            }
            if max_pool {
                coords[d] = coords[d].round();
            } else if shifted {
                coords[d] -= 0.5;
            }
        }
        let rw = if max_pool {
            (coords[2] - coords[0] + 1.).max(1.)
        } else if shifted {
            coords[2] - coords[0]
        } else {
            (coords[2] - coords[0]).max(1.)
        };
        let rh = if max_pool {
            (coords[3] - coords[1] + 1.).max(1.)
        } else if shifted {
            coords[3] - coords[1]
        } else {
            (coords[3] - coords[1]).max(1.)
        };
        let bh = rh / oh as f64;
        let bw = rw / ow as f64;
        let sy = if ratio > 0 {
            ratio as usize
        } else {
            bh.ceil().max(0.) as usize
        };
        let sx = if ratio > 0 {
            ratio as usize
        } else {
            bw.ceil().max(0.) as usize
        };
        if !max_pool {
            elements(&[sy, sx])?;
        }
        for c in 0..x.shape[1] {
            let plane = (batch as usize * x.shape[1] + c) * h * w;
            let sample = |yy: f64, xx: f64| {
                if yy < -1. || yy > h as f64 || xx < -1. || xx > w as f64 {
                    return 0.;
                }
                let yy = yy.max(0.).min((h - 1) as f64);
                let xx = xx.max(0.).min((w - 1) as f64);
                let y0 = yy.floor() as usize;
                let x0 = xx.floor() as usize;
                let y1 = (y0 + 1).min(h - 1);
                let x1 = (x0 + 1).min(w - 1);
                let fy = yy - y0 as f64;
                let fx = xx - x0 as f64;
                let weighted = [
                    x.get(plane + y0 * w + x0).f() * (1. - fy) * (1. - fx),
                    x.get(plane + y0 * w + x1).f() * (1. - fy) * fx,
                    x.get(plane + y1 * w + x0).f() * fy * (1. - fx),
                    x.get(plane + y1 * w + x1).f() * fy * fx,
                ];
                // Published ONNX mode=max conformance data aggregate weighted corners by max.
                if mode == "max" {
                    weighted.into_iter().fold(f64::NEG_INFINITY, f64::max)
                } else {
                    weighted.iter().sum()
                }
            };
            for row in 0..oh {
                for col in 0..ow {
                    let value = if max_pool {
                        let y0 =
                            (coords[1] + (row as f64 * bh).floor()).clamp(0., h as f64) as usize;
                        let y1 = (coords[1] + ((row + 1) as f64 * bh).ceil()).clamp(0., h as f64)
                            as usize;
                        let x0 =
                            (coords[0] + (col as f64 * bw).floor()).clamp(0., w as f64) as usize;
                        let x1 = (coords[0] + ((col + 1) as f64 * bw).ceil()).clamp(0., w as f64)
                            as usize;
                        let mut v = f64::NEG_INFINITY;
                        for yy in y0..y1 {
                            for xx in x0..x1 {
                                v = crate::element::maximum(
                                    Number::F(v),
                                    x.get(plane + yy * w + xx),
                                )
                                .f();
                            }
                        }
                        if y0 >= y1 || x0 >= x1 {
                            0.
                        } else {
                            v
                        }
                    } else {
                        let mut v = if mode == "max" { f64::NEG_INFINITY } else { 0. };
                        for yy in 0..sy {
                            for xx in 0..sx {
                                let q = sample(
                                    coords[1] + (row as f64 + (yy as f64 + 0.5) / sy as f64) * bh,
                                    coords[0] + (col as f64 + (xx as f64 + 0.5) / sx as f64) * bw,
                                );
                                v = if mode == "max" { v.max(q) } else { v + q };
                            }
                        }
                        if sy == 0 || sx == 0 {
                            0.
                        } else if mode == "max" {
                            v
                        } else {
                            v / (sy * sx) as f64
                        }
                    };
                    y.set(
                        ((r * x.shape[1] + c) * oh + row) * ow + col,
                        Number::F(value),
                    );
                }
            }
        }
    }
    Ok(y)
}
fn col2im(inputs: &[Option<Tensor>], a: &Attrs) -> Result<Tensor> {
    let x = input(inputs, 0)?;
    x.numeric()?;
    let image = input(inputs, 1)?;
    let block = input(inputs, 2)?;
    if x.shape.len() != 3
        || image.kind != 7
        || block.kind != 7
        || image.shape.len() != 1
        || image.shape != block.shape
        || image.size() < 2
    {
        return Err(
            "Col2Im requires [N,C*block,L] data and int64 image/block vectors; repair input shapes"
                .into(),
        );
    }
    let image = image.ints()?;
    let block = block.ints()?;
    let r = image.len();
    if image.iter().any(|&n| n < 0 || n > i32::MAX as i64)
        || block.iter().any(|&n| n <= 0 || n > i32::MAX as i64)
    {
        return Err(
            "Col2Im needs nonnegative image and positive block dimensions; repair shapes".into(),
        );
    }
    let stride = a.ints("strides")?.unwrap_or(vec![1; r]);
    let dilation = a.ints("dilations")?.unwrap_or(vec![1; r]);
    let pads = a.ints("pads")?.unwrap_or(vec![0; r * 2]);
    if stride.len() != r
        || dilation.len() != r
        || pads.len() != r * 2
        || stride.iter().chain(&dilation).any(|&n| n <= 0)
        || pads.iter().any(|&n| n < 0)
    {
        return Err(
            "Col2Im stride/dilation/pad lists have invalid lengths or values; repair attributes"
                .into(),
        );
    }
    let mut blocks = Vec::new();
    for d in 0..r {
        let available = image[d] as i128 + pads[d] as i128 + pads[d + r] as i128
            - dilation[d] as i128 * (block[d] - 1) as i128
            - 1;
        blocks.push(if available < 0 {
            0
        } else {
            usize::try_from(available / stride[d] as i128 + 1)
                .map_err(|_| "Col2Im dimensions overflow; use smaller shapes")?
        });
    }
    let block: Vec<_> = block.iter().map(|&n| n as usize).collect();
    let volume = product(&block)?;
    let count = product(&blocks)?;
    if x.shape[1] % volume != 0 || x.shape[2] != count {
        return Err(
            "Col2Im column dimensions differ from image geometry; repair input shapes".into(),
        );
    }
    let channels = x.shape[1] / volume;
    let image: Vec<_> = image.iter().map(|&n| n as usize).collect();
    let is = strides(&image);
    let bs = strides(&block);
    let ls = strides(&blocks);
    let plane = product(&image)?;
    let mut shape = vec![x.shape[0], channels];
    shape.extend(&image);
    let mut y = Tensor::zeros(x.kind, shape)?;
    if y.size() == 0 {
        return Ok(y);
    }
    for batch in 0..x.shape[0] {
        for c in 0..channels {
            for k in 0..volume {
                for p in 0..count {
                    let mut at = 0;
                    let mut inside = true;
                    for d in 0..r {
                        let coord = (p / ls[d] % blocks[d]) as i128 * stride[d] as i128
                            + (k / bs[d] % block[d]) as i128 * dilation[d] as i128
                            - pads[d] as i128;
                        if coord < 0 || coord >= image[d] as i128 {
                            inside = false;
                            break;
                        }
                        at += coord as usize * is[d];
                    }
                    if inside {
                        let at = (batch * channels + c) * plane + at;
                        let value = x.get(((batch * channels + c) * volume + k) * count + p);
                        y.set(at, y.get(at).add(value));
                    }
                }
            }
        }
    }
    Ok(y)
}
pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    a: &Attrs,
    version: u32,
) -> Result<Vec<Tensor>> {
    Ok(vec![match op {
        "NonMaxSuppression" => nms(inputs, a)?,
        "GridSample" => grid(inputs, a, version)?,
        "AffineGrid" => affine(inputs, a)?,
        "RoiAlign" => roi(inputs, a, version, false)?,
        "MaxRoiPool" => roi(inputs, a, version, true)?,
        "Col2Im" => col2im(inputs, a)?,
        _ => unreachable!(),
    }])
}
