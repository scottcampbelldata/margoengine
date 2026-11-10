use crate::attrs::{input, optional, Attrs};
use crate::tensor::{axis, elements, product, Number, Result, Tensor};
use std::collections::HashSet;
pub fn supports(op: &str) -> bool {
    matches!(op, "Resize" | "Upsample")
}
pub(crate) fn cubic(x: f64, a: f64) -> f64 {
    let x = x.abs();
    if x <= 1. {
        (a + 2.) * x * x * x - (a + 3.) * x * x + 1.
    } else if x < 2. {
        a * x * x * x - 5. * a * x * x + 8. * a * x - 4. * a
    } else {
        0.
    }
}
pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    a: &Attrs,
    version: u32,
) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let rank = x.shape.len();
    let axes = a.ints("axes")?.unwrap_or((0..rank as i64).collect());
    let axes = axes
        .iter()
        .map(|&d| axis(d, rank))
        .collect::<Result<Vec<_>>>()?;
    let mut seen = HashSet::new();
    if axes.iter().any(|&d| !seen.insert(d)) {
        return Err("Resize axes must be unique; remove repeated axes".into());
    }
    let legacy = op == "Upsample" || version == 10;
    let scales_input = optional(inputs, if legacy { 1 } else { 2 }).filter(|t| t.size() != 0);
    let sizes_input = if legacy {
        None
    } else {
        optional(inputs, 3).filter(|t| t.size() != 0)
    };
    let legacy_scales = if op == "Upsample" && version < 9 {
        if version < 7 {
            if rank != 4 {
                return Err("Upsample-1 needs rank-four NCHW input; supply an image tensor".into());
            }
            Some(vec![
                1.,
                1.,
                a.float("height_scale", 1.)?,
                a.float("width_scale", 1.)?,
            ])
        } else {
            a.floats("scales")?
        }
    } else {
        None
    };
    if (scales_input.is_some() || legacy_scales.is_some()) == sizes_input.is_some() {
        return Err("Resize needs exactly one nonempty scales or sizes input; supply one output-size definition".into());
    }
    let mut dims = x.shape.clone();
    let mut scales = vec![1.; rank];
    if let Some(sizes) = sizes_input {
        if sizes.kind != 7 || sizes.shape != [axes.len()] {
            return Err("Resize sizes must be int64 [number of axes]; provide valid sizes".into());
        }
        for (i, &d) in axes.iter().enumerate() {
            let n = sizes.get(i).i();
            if n < 0 || n > i32::MAX as i64 {
                return Err(
                    "Resize sizes must be nonnegative supported dimensions; supply valid sizes"
                        .into(),
                );
            }
            dims[d] = n as usize;
            scales[d] = if x.shape[d] == 0 {
                1.
            } else {
                n as f64 / x.shape[d] as f64
            };
        }
        let policy = a.string("keep_aspect_ratio_policy", "stretch")?;
        if policy != "stretch" {
            if !matches!(policy, "not_larger" | "not_smaller") {
                return Err("Resize aspect policy must be stretch/not_larger/not_smaller; choose a valid policy".into());
            }
            let common = axes
                .iter()
                .map(|&d| scales[d])
                .reduce(|a, b| {
                    if policy == "not_larger" {
                        a.min(b)
                    } else {
                        a.max(b)
                    }
                })
                .unwrap_or(1.);
            for &d in &axes {
                dims[d] = (common * x.shape[d] as f64).round() as usize;
                scales[d] = if x.shape[d] == 0 {
                    1.
                } else {
                    dims[d] as f64 / x.shape[d] as f64
                };
            }
        }
    } else {
        let values = if let Some(v) = legacy_scales {
            v
        } else {
            let s = scales_input.unwrap();
            if s.kind != 1 || s.shape != [axes.len()] {
                return Err(
                    "Resize scales must be float32 [number of axes]; provide positive scales"
                        .into(),
                );
            }
            (0..s.size()).map(|i| s.get(i).f()).collect()
        };
        if values.len() != axes.len() {
            return Err(
                "Upsample scales count must match input rank; provide one scale per axis".into(),
            );
        }
        for (i, &d) in axes.iter().enumerate() {
            let scale = values[i];
            let size = (x.shape[d] as f64 * scale).floor();
            if !scale.is_finite() || scale <= 0. || !size.is_finite() || size > i32::MAX as f64 {
                return Err("Resize scale must be finite, positive and produce supported dimensions; repair scales".into());
            }
            dims[d] = size as usize;
            scales[d] = scale;
        }
    }
    elements(&dims)?;
    let mode = a.string("mode", "nearest")?;
    if !matches!(mode, "nearest" | "linear" | "cubic") {
        return Err(
            "Resize mode must be nearest/linear/cubic; select a valid interpolation".into(),
        );
    }
    if mode != "nearest" {
        x.numeric()?;
    }
    let transform = a.string(
        "coordinate_transformation_mode",
        if legacy { "asymmetric" } else { "half_pixel" },
    )?;
    if !matches!(
        transform,
        "half_pixel"
            | "half_pixel_symmetric"
            | "pytorch_half_pixel"
            | "align_corners"
            | "asymmetric"
            | "tf_crop_and_resize"
            | "tf_half_pixel_for_nn"
    ) {
        return Err(
            "Resize coordinate transform is unknown; use an ONNX coordinate transformation mode"
                .into(),
        );
    }
    let nearest = a.string(
        "nearest_mode",
        if legacy {
            "floor"
        } else {
            "round_prefer_floor"
        },
    )?;
    if !matches!(
        nearest,
        "floor" | "ceil" | "round_prefer_floor" | "round_prefer_ceil"
    ) {
        return Err("Resize nearest_mode is unknown; choose a documented rounding mode".into());
    }
    let antialias = a.flag("antialias", false)?;
    let exclude = a.flag("exclude_outside", false)?;
    let coeff = a.float("cubic_coeff_a", -0.75)?;
    if !coeff.is_finite() {
        return Err("cubic_coeff_a must be finite; choose a valid cubic coefficient".into());
    }
    let extrapolate = a.float("extrapolation_value", 0.)?;
    let roi = if !legacy {
        optional(inputs, 1).filter(|t| t.size() != 0)
    } else {
        None
    };
    if let Some(t) = roi {
        if !matches!(t.kind, 1 | 10 | 11) || t.shape != [axes.len() * 2] {
            return Err(
                "Resize roi must be a floating vector with start/end per resized axis; repair roi"
                    .into(),
            );
        }
    }
    if elements(&dims)? == 0 {
        return Ok(vec![Tensor::zeros(x.kind, dims)?]);
    }
    for &d in &axes {
        if x.shape[d] == 0 {
            return Err("Resize cannot sample a nonempty output from an empty axis; choose zero output size".into());
        }
    }
    let mut current = x.clone();
    if mode != "nearest" {
        let mut f = Tensor::zeros(11, x.shape.clone())?;
        for i in 0..x.size() {
            f.set(i, x.get(i));
        }
        current = f;
    }
    for (i, &d) in axes.iter().enumerate() {
        let source = x.shape[d];
        let target = dims[d];
        let scale = scales[d];
        let start = roi.map_or(0., |t| t.get(i).f());
        let end = roi.map_or(1., |t| t.get(i + axes.len()).f());
        if !start.is_finite() || !end.is_finite() {
            return Err(
                "Resize roi coordinates must be finite; supply valid normalized coordinates".into(),
            );
        }
        let mut shape = current.shape.clone();
        shape[d] = target;
        let mut output = Tensor::zeros(current.kind, shape)?;
        let inner = product(&current.shape[d + 1..])?;
        let outer = product(&current.shape[..d])?;
        for q in 0..target {
            let pos = match transform {
                "half_pixel" => (q as f64 + 0.5) / scale - 0.5,
                "half_pixel_symmetric" => {
                    source as f64 / 2. * (1. - target as f64 / (source as f64 * scale))
                        + (q as f64 + 0.5) / scale
                        - 0.5
                }
                "pytorch_half_pixel" => {
                    if target > 1 {
                        (q as f64 + 0.5) / scale - 0.5
                    } else {
                        0.
                    }
                }
                "align_corners" => {
                    if target > 1 {
                        q as f64 * (source - 1) as f64 / (target - 1) as f64
                    } else {
                        0.
                    }
                }
                "asymmetric" => q as f64 / scale,
                "tf_half_pixel_for_nn" => (q as f64 + 0.5) / scale,
                _ => {
                    if target > 1 {
                        start * (source - 1) as f64
                            + q as f64 * (end - start) * (source - 1) as f64 / (target - 1) as f64
                    } else {
                        0.5 * (start + end) * (source - 1) as f64
                    }
                }
            };
            let outside =
                transform == "tf_crop_and_resize" && (pos < 0. || pos > (source - 1) as f64);
            if outside && x.kind == 8 {
                return Err("numeric crop extrapolation has no string representation in this tensor profile; keep the string ROI in range".into());
            }
            let weights: Vec<(usize, f64)> = if outside {
                vec![]
            } else if mode == "nearest" {
                let at = match nearest {
                    "floor" => pos.floor(),
                    "ceil" => pos.ceil(),
                    "round_prefer_floor" => (pos - 0.5).ceil(),
                    _ => (pos + 0.5).floor(),
                };
                vec![(at.clamp(0., (source - 1) as f64) as usize, 1.)]
            } else {
                let widen = if antialias { (1. / scale).max(1.) } else { 1. };
                let radius = if mode == "linear" { widen } else { 2. * widen };
                let low = (pos - radius).floor() as i64;
                let high = (pos + radius).ceil() as i64;
                let mut weights = Vec::new();
                let mut total = 0.;
                for at in low..=high {
                    if exclude && (at < 0 || at >= source as i64) {
                        continue;
                    }
                    let distance = (pos - at as f64) / widen;
                    let weight = if mode == "linear" {
                        (1. - distance.abs()).max(0.)
                    } else {
                        cubic(distance, coeff)
                    };
                    if weight == 0. {
                        continue;
                    }
                    weights.push((at.clamp(0, source as i64 - 1) as usize, weight));
                    total += weight;
                }
                if total == 0. {
                    return Err(
                        "Resize interpolation has no contributing samples; repair roi/scales"
                            .into(),
                    );
                }
                for (_, weight) in &mut weights {
                    *weight /= total;
                }
                weights
            };
            for p in 0..outer {
                for j in 0..inner {
                    let at = (p * target + q) * inner + j;
                    if outside {
                        output.set(at, Number::F(extrapolate));
                    } else if mode == "nearest" {
                        output.copy_element(at, &current, (p * source + weights[0].0) * inner + j);
                    } else {
                        let mut sum = 0.;
                        for &(sample, weight) in &weights {
                            sum += current.get((p * source + sample) * inner + j).f() * weight;
                        }
                        output.set(at, Number::F(sum));
                    }
                }
            }
        }
        current = output;
    }
    if current.kind != x.kind {
        let mut output = Tensor::zeros(x.kind, dims)?;
        for i in 0..output.size() {
            output.set(i, current.get(i));
        }
        current = output;
    }
    Ok(vec![current])
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    fn attr(name: &str, kind: usize, value: Json) -> Json {
        Json::object([
            ("name", Json::s(name)),
            ("kind", Json::n(kind)),
            ("value", value),
        ])
    }
    #[test]
    fn linear_half_pixel_and_align_corners() {
        let s = Store::new();
        let x = Tensor::raw(
            11,
            vec![2],
            [0f64, 4.].iter().flat_map(|v| v.to_le_bytes()).collect(),
        )
        .unwrap();
        let size = Tensor::vector_i64(&[4]).unwrap();
        let mut e = vec![attr("mode", 3, Json::s("linear"))];
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        let y = execute(
            "Resize",
            &[Some(x.clone()), None, None, Some(size.clone())],
            &a,
            19,
        )
        .unwrap();
        assert_eq!(
            (0..4).map(|i| y[0].get(i).f()).collect::<Vec<_>>(),
            vec![0., 1., 3., 4.]
        );
        e.push(attr(
            "coordinate_transformation_mode",
            3,
            Json::s("align_corners"),
        ));
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        let y = execute("Resize", &[Some(x), None, None, Some(size)], &a, 19).unwrap();
        assert!((y[0].get(1).f() - 4. / 3.).abs() < 1e-15);
    }
    #[test]
    fn nearest_preserves_integer64_and_empty_shapes() {
        let s = Store::new();
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let x = Tensor::vector_i64(&[9007199254740993, 7]).unwrap();
        let y = execute(
            "Resize",
            &[
                Some(x.clone()),
                None,
                None,
                Some(Tensor::vector_i64(&[4]).unwrap()),
            ],
            &a,
            19,
        )
        .unwrap();
        assert_eq!(
            y[0].ints().unwrap(),
            vec![9007199254740993, 9007199254740993, 7, 7]
        );
        let y = execute(
            "Resize",
            &[Some(x), None, None, Some(Tensor::vector_i64(&[0]).unwrap())],
            &a,
            19,
        )
        .unwrap();
        assert_eq!(y[0].shape, vec![0]);
    }
    #[test]
    fn antialias_preserves_constants_and_crop_extrapolates() {
        let s = Store::new();
        let mut x = Tensor::zeros(1, vec![8]).unwrap();
        for i in 0..8 {
            x.set(i, Number::F(3.));
        }
        let e = vec![
            attr("mode", 3, Json::s("cubic")),
            attr("antialias", 2, Json::s("1")),
        ];
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        let y = execute(
            "Resize",
            &[Some(x), None, None, Some(Tensor::vector_i64(&[3]).unwrap())],
            &a,
            19,
        )
        .unwrap();
        assert!((0..3).all(|i| (y[0].get(i).f() - 3.).abs() < 1e-6));
    }
}
