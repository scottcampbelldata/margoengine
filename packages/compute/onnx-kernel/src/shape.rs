use crate::attrs::{input, optional, same_type, Attrs};
use crate::tensor::{axis, broadcast, broadcast_index, product, strides, Number, Result, Tensor};

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "Identity"
            | "Reshape"
            | "Flatten"
            | "Transpose"
            | "Squeeze"
            | "Unsqueeze"
            | "Shape"
            | "Size"
            | "Expand"
            | "Tile"
            | "Concat"
            | "Constant"
            | "ConstantOfShape"
    )
}
fn shape_values(t: &Tensor) -> Result<Vec<usize>> {
    if t.kind != 7 || t.shape.len() != 1 {
        return Err(
            "shape input must be a one-dimensional int64 tensor; supply int64 dimensions".into(),
        );
    }
    t.ints()?
        .into_iter()
        .map(|n| {
            if n < 0 || n > i32::MAX as i64 {
                Err("shape dimensions must be in 0..2147483647; use valid dimensions".into())
            } else {
                Ok(n as usize)
            }
        })
        .collect()
}
fn axes(inputs: &[Option<Tensor>], attrs: &Attrs) -> Result<Option<Vec<i64>>> {
    if let Some(t) = optional(inputs, 1) {
        if t.kind != 7 || t.shape.len() != 1 {
            return Err(
                "axes input must be a one-dimensional int64 tensor; supply int64 axes".into(),
            );
        }
        Ok(Some(t.ints()?))
    } else {
        attrs.ints("axes")
    }
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], attrs: &Attrs) -> Result<Vec<Tensor>> {
    if op == "Constant" {
        let names = [
            "value",
            "sparse_value",
            "value_float",
            "value_int",
            "value_floats",
            "value_ints",
            "value_string",
            "value_strings",
        ];
        let present: Vec<_> = names.iter().filter(|&&n| attrs.has(n)).copied().collect();
        if present.len() != 1 {
            return Err(
                "Constant needs exactly one value attribute; supply one typed constant value"
                    .into(),
            );
        }
        let value = match present[0] {
            "value" | "sparse_value" => attrs
                .tensor(present[0])?
                .ok_or("Constant tensor is absent; provide its value")?
                .clone(),
            "value_float" => {
                let mut t = Tensor::zeros(1, vec![])?;
                t.set(0, Number::F(attrs.float("value_float", 0.)?));
                t
            }
            "value_int" => {
                let mut t = Tensor::zeros(7, vec![])?;
                t.set(0, Number::I(attrs.int("value_int", 0)?));
                t
            }
            "value_floats" => {
                let values = attrs.floats("value_floats")?.unwrap();
                let mut t = Tensor::zeros(1, vec![values.len()])?;
                for (i, &v) in values.iter().enumerate() {
                    t.set(i, Number::F(v));
                }
                t
            }
            "value_ints" => Tensor::vector_i64(&attrs.ints("value_ints")?.unwrap())?,
            "value_string" => Tensor::text(
                vec![],
                vec![attrs.string("value_string", "")?.as_bytes().to_vec()],
            )?,
            "value_strings" => {
                let s = attrs.strings("value_strings")?.unwrap();
                Tensor::text(
                    vec![s.len()],
                    s.iter().map(|s| s.as_bytes().to_vec()).collect(),
                )?
            }
            _ => unreachable!(),
        };
        return Ok(vec![value]);
    }
    let x = input(inputs, 0)?;
    Ok(vec![match op {
        "Identity" => x.clone(),
        "Reshape" => {
            let s = input(inputs, 1)?;
            if s.kind != 7 || s.shape.len() != 1 {
                return Err(
                    "Reshape shape must be a one-dimensional int64 tensor; supply valid dimensions"
                        .into(),
                );
            }
            let given = s.ints()?;
            let allowzero = attrs.flag("allowzero", false)?;
            let mut shape = Vec::with_capacity(given.len());
            let mut infer = None;
            for (i, &d) in given.iter().enumerate() {
                if d < -1 || d > i32::MAX as i64 {
                    return Err(
                        "Reshape dimensions must be >=0 or one -1; supply a valid shape".into(),
                    );
                }
                if d == -1 {
                    if infer.replace(i).is_some() {
                        return Err(
                            "Reshape permits only one inferred dimension; use one -1".into()
                        );
                    }
                    shape.push(1);
                } else if d == 0 && !allowzero {
                    shape.push(*x.shape.get(i).ok_or(
                        "Reshape zero cannot copy an absent dimension; use an explicit dimension",
                    )?);
                } else {
                    shape.push(d as usize);
                }
            }
            if let Some(i) = infer {
                if shape.contains(&0) {
                    return Err("Reshape inferred dimension is ambiguous with a zero factor; supply explicit dimensions".into());
                }
                if x.size() == 0 {
                    shape[i] = 0;
                } else {
                    let size = product(&shape)?;
                    if x.size() % size != 0 {
                        return Err("Reshape inferred dimension is ambiguous or nonintegral; supply explicit compatible dimensions".into());
                    }
                    shape[i] = x.size() / size;
                }
            }
            x.reshape(shape)?
        }
        "Flatten" => {
            let a = attrs.int("axis", 1)?;
            let a = if a < 0 { a + x.shape.len() as i64 } else { a };
            if a < 0 || a > x.shape.len() as i64 {
                return Err("Flatten axis must be in [-rank,rank]; choose a valid axis".into());
            }
            x.reshape(vec![
                product(&x.shape[..a as usize])?,
                product(&x.shape[a as usize..])?,
            ])?
        }
        "Transpose" => {
            let perm = attrs
                .ints("perm")?
                .unwrap_or_else(|| (0..x.shape.len() as i64).rev().collect());
            if perm.len() != x.shape.len()
                || perm.iter().any(|&a| a < 0 || a >= x.shape.len() as i64)
            {
                return Err(
                    "Transpose perm must list each axis exactly once; supply a permutation".into(),
                );
            }
            let mut seen = vec![false; perm.len()];
            for &a in &perm {
                if seen[a as usize] {
                    return Err("Transpose perm repeats an axis; supply a permutation".into());
                }
                seen[a as usize] = true;
            }
            let shape: Vec<_> = perm.iter().map(|&a| x.shape[a as usize]).collect();
            let steps = strides(&x.shape);
            let mut out = Tensor::zeros(x.kind, shape.clone())?;
            for i in 0..out.size() {
                let mut rem = i;
                let mut at = 0;
                for k in (0..shape.len()).rev() {
                    at += (rem % shape[k]) * steps[perm[k] as usize];
                    rem /= shape[k];
                }
                out.copy_element(i, x, at);
            }
            out
        }
        "Squeeze" => {
            let list = axes(inputs, attrs)?;
            let mut remove = vec![false; x.shape.len()];
            if let Some(list) = list {
                for a in list {
                    let a = axis(a, x.shape.len())?;
                    if remove[a] || x.shape[a] != 1 {
                        return Err("Squeeze axes must be unique singleton dimensions; choose axes of size one".into());
                    }
                    remove[a] = true;
                }
            } else {
                for (i, &d) in x.shape.iter().enumerate() {
                    remove[i] = d == 1;
                }
            }
            x.reshape(
                x.shape
                    .iter()
                    .enumerate()
                    .filter_map(|(i, &d)| if remove[i] { None } else { Some(d) })
                    .collect(),
            )?
        }
        "Unsqueeze" => {
            let list = axes(inputs, attrs)?
                .ok_or("Unsqueeze needs axes; supply an axes tensor or attribute")?;
            let rank = x.shape.len() + list.len();
            let mut insert = vec![false; rank];
            for a in list {
                let a = axis(a, rank)?;
                if insert[a] {
                    return Err("Unsqueeze axes repeat; choose distinct output axes".into());
                }
                insert[a] = true;
            }
            let mut old = x.shape.iter();
            x.reshape(
                insert
                    .iter()
                    .map(|&v| if v { 1 } else { *old.next().unwrap() })
                    .collect(),
            )?
        }
        "Shape" => {
            let rank = x.shape.len() as i64;
            let bound = |n: i64| {
                if n < 0 {
                    n.saturating_add(rank).clamp(0, rank)
                } else {
                    n.clamp(0, rank)
                }
            };
            let start = bound(attrs.int("start", 0)?);
            let end = bound(attrs.int("end", rank)?).max(start);
            Tensor::vector_i64(
                &x.shape[start as usize..end as usize]
                    .iter()
                    .map(|&d| d as i64)
                    .collect::<Vec<_>>(),
            )?
        }
        "Size" => {
            let mut t = Tensor::zeros(7, vec![])?;
            t.set(0, Number::I(x.size() as i64));
            t
        }
        "Expand" => {
            let requested = shape_values(input(inputs, 1)?)?;
            let shape = broadcast(&x.shape, &requested)?;
            let mut out = Tensor::zeros(x.kind, shape.clone())?;
            for i in 0..out.size() {
                out.copy_element(i, x, broadcast_index(i, &shape, &x.shape));
            }
            out
        }
        "Tile" => {
            let repeats = shape_values(input(inputs, 1)?)?;
            if repeats.len() != x.shape.len() {
                return Err(
                    "Tile repeats length must equal input rank; supply one repeat per axis".into(),
                );
            }
            let shape = x
                .shape
                .iter()
                .zip(&repeats)
                .map(|(&a, &b)| {
                    a.checked_mul(b)
                        .ok_or("Tile dimensions overflow; use fewer repeats".into())
                })
                .collect::<Result<Vec<_>>>()?;
            let mut out = Tensor::zeros(x.kind, shape.clone())?;
            let steps = strides(&x.shape);
            for i in 0..out.size() {
                let mut rem = i;
                let mut at = 0;
                for k in (0..shape.len()).rev() {
                    at += (rem % shape[k] % x.shape[k]) * steps[k];
                    rem /= shape[k];
                }
                out.copy_element(i, x, at);
            }
            out
        }
        "Concat" => {
            let a = axis(attrs.int("axis", 0)?, x.shape.len())?;
            let mut shape = x.shape.clone();
            shape[a] = 0;
            let mut tensors = Vec::new();
            for i in 0..inputs.len() {
                let t = input(inputs, i)?;
                same_type(x, t)?;
                if t.shape.len() != shape.len()
                    || t.shape
                        .iter()
                        .enumerate()
                        .any(|(k, &d)| k != a && d != x.shape[k])
                {
                    return Err(
                        "Concat dimensions outside axis must match; reshape compatible inputs"
                            .into(),
                    );
                }
                shape[a] = shape[a]
                    .checked_add(t.shape[a])
                    .ok_or("Concat axis overflows; use smaller inputs")?;
                tensors.push(t);
            }
            let mut out = Tensor::zeros(x.kind, shape.clone())?;
            if out.size() == 0 {
                return Ok(vec![out]);
            }
            let inner = product(&x.shape[a + 1..])?;
            let outer = product(&x.shape[..a])?;
            for o in 0..outer {
                let mut at = o * shape[a] * inner;
                for t in &tensors {
                    let n = t.shape[a] * inner;
                    for j in 0..n {
                        out.copy_element(at, t, o * n + j);
                        at += 1;
                    }
                }
            }
            out
        }
        "ConstantOfShape" => {
            let shape = shape_values(x)?;
            let fill = attrs.tensor("value")?;
            let kind = fill.map_or(1, |t| t.kind);
            if let Some(t) = fill {
                if t.size() != 1 {
                    return Err(
                        "ConstantOfShape value must have one element; supply a one-element tensor"
                            .into(),
                    );
                }
            }
            let mut out = Tensor::zeros(kind, shape)?;
            if let Some(t) = fill {
                for i in 0..out.size() {
                    out.copy_element(i, t, 0);
                }
            }
            out
        }
        _ => {
            return Err(format!(
                "unknown tensor-shape operator {op}; use a supported ONNX operator"
            ))
        }
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use crate::wire::Json;
    #[test]
    fn empty_outputs_do_no_work_even_with_large_metadata_factors() {
        let store = Store::new();
        let attrs = Attrs {
            entries: &[],
            store: &store,
        };
        let x = Tensor::zeros(1, vec![2_000_000_000, 0]).unwrap();
        assert_eq!(
            execute("Flatten", &[Some(x)], &attrs).unwrap()[0].shape,
            [2_000_000_000, 0]
        );
        let x = Tensor::zeros(1, vec![0]).unwrap();
        let shape = Tensor::vector_i64(&[-1, 2_000_000_000, 2_000_000_000]).unwrap();
        assert_eq!(
            execute("Reshape", &[Some(x), Some(shape)], &attrs).unwrap()[0].shape,
            [0, 2_000_000_000, 2_000_000_000]
        );
    }
    fn attr(name: &str, kind: usize, value: Json) -> Json {
        Json::object([
            ("name", Json::s(name)),
            ("kind", Json::n(kind)),
            ("value", value),
        ])
    }
    #[test]
    fn int64_transpose_and_reshape_preserve_exact_values() {
        let s = Store::new();
        let mut x = Tensor::vector_i64(&[9007199254740993, 2, 3, 4, 5, 6]).unwrap();
        x = x.reshape(vec![2, 3]).unwrap();
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let out = execute("Transpose", &[Some(x)], &a).unwrap();
        assert_eq!(out[0].shape, [3, 2]);
        assert_eq!(
            (0..6).map(|i| out[0].get(i).i()).collect::<Vec<_>>(),
            [9007199254740993, 4, 2, 5, 3, 6]
        );
    }
    #[test]
    fn scalar_empty_and_inferred_reshape_cases() {
        let s = Store::new();
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        let x = Tensor::zeros(1, vec![0, 3]).unwrap();
        let shape = Tensor::vector_i64(&[0, -1]).unwrap();
        assert!(execute("Reshape", &[Some(x.clone()), Some(shape)], &a).is_err());
        let shape = Tensor::vector_i64(&[-1, 3]).unwrap();
        assert_eq!(
            execute("Reshape", &[Some(x), Some(shape)], &a).unwrap()[0].shape,
            [0, 3]
        );
        let x = Tensor::zeros(1, vec![]).unwrap();
        assert_eq!(execute("Shape", &[Some(x)], &a).unwrap()[0].shape, [0]);
    }
    #[test]
    fn squeeze_distinguishes_omitted_and_empty_axes() {
        let s = Store::new();
        let x = Tensor::zeros(1, vec![1, 2, 1]).unwrap();
        let a = Attrs {
            entries: &[],
            store: &s,
        };
        assert_eq!(
            execute("Squeeze", &[Some(x.clone())], &a).unwrap()[0].shape,
            [2]
        );
        let attrs = vec![attr("axes", 7, Json::Array(vec![]))];
        let a = Attrs {
            entries: &attrs,
            store: &s,
        };
        assert_eq!(
            execute("Squeeze", &[Some(x)], &a).unwrap()[0].shape,
            [1, 2, 1]
        );
    }
}
