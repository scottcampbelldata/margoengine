// ai.onnx.ml numerical preprocessing. Schemas, not another runtime's implementation,
// define the output dtypes, rank conventions and attribute defaults.
use crate::attrs::{input, same_type, Attrs};
use crate::tensor::{elements, Number, Result, Tensor};
use std::collections::HashMap;

pub fn supports(op: &str) -> bool {
    matches!(
        op,
        "ArrayFeatureExtractor"
            | "Binarizer"
            | "CategoryMapper"
            | "FeatureVectorizer"
            | "Imputer"
            | "LabelEncoder"
            | "Normalizer"
            | "OneHotEncoder"
            | "Scaler"
    )
}
pub fn validate(op: &str, version: u32, n: usize, nout: usize, a: &Attrs) -> Result<()> {
    if !(1..=5).contains(&version) {
        return Err("ai.onnx.ml opset must be 1..5; choose a supported ML opset".into());
    }
    let (lo, hi) = match op {
        "ArrayFeatureExtractor" => (2, 2),
        "FeatureVectorizer" => (1, usize::MAX),
        _ => (1, 1),
    };
    if n < lo || n > hi || nout != 1 {
        return Err(format!(
            "ai.onnx.ml {op} has invalid input/output arity; repair the node"
        ));
    }
    let attrs: &[&str] = match op {
        "ArrayFeatureExtractor" => &[],
        "Binarizer" => &["threshold"],
        "CategoryMapper" => &[
            "cats_int64s",
            "cats_strings",
            "default_int64",
            "default_string",
        ],
        "FeatureVectorizer" => &["inputdimensions"],
        "Imputer" => &[
            "imputed_value_floats",
            "imputed_value_int64s",
            "replaced_value_float",
            "replaced_value_int64",
        ],
        "LabelEncoder" if version == 1 => &["classes_strings", "default_int64", "default_string"],
        "LabelEncoder" if version < 4 => &[
            "keys_floats",
            "keys_int64s",
            "keys_strings",
            "values_floats",
            "values_int64s",
            "values_strings",
            "default_float",
            "default_int64",
            "default_string",
        ],
        "LabelEncoder" => &[
            "keys_floats",
            "keys_int64s",
            "keys_strings",
            "keys_tensor",
            "values_floats",
            "values_int64s",
            "values_strings",
            "values_tensor",
            "default_float",
            "default_int64",
            "default_string",
            "default_tensor",
        ],
        "Normalizer" => &["norm"],
        "OneHotEncoder" => &["cats_int64s", "cats_strings", "zeros"],
        "Scaler" => &["offset", "scale"],
        _ => return Err("unknown ML operator; select an implemented operator".into()),
    };
    a.known(attrs)
}
#[derive(Hash, PartialEq, Eq)]
enum Key {
    String(Vec<u8>),
    Integer(i64),
    Float(u64),
}
fn key(x: &Tensor, i: usize, version: u32) -> Key {
    if let Some(s) = &x.strings {
        return Key::String(s[i].clone());
    }
    if matches!(x.kind, 1 | 11) {
        let n = x.get(i).f();
        let bits = if version >= 4 && n.is_nan() {
            f64::NAN.to_bits()
        } else if version >= 4 && n == 0. {
            0
        } else {
            n.to_bits()
        };
        return Key::Float(bits);
    }
    Key::Integer(x.get(i).i())
}
fn attribute_tensor(a: &Attrs, prefix: &str) -> Result<Tensor> {
    let names = ["floats", "int64s", "strings", "tensor"];
    let present: Vec<_> = names
        .iter()
        .map(|s| format!("{prefix}_{s}"))
        .filter(|s| a.has(s))
        .collect();
    if present.len() != 1 {
        return Err(format!(
            "LabelEncoder requires exactly one {prefix}_ attribute; repair its attributes"
        ));
    }
    let name = &present[0];
    if name.ends_with("tensor") {
        let t = a.tensor(name)?.unwrap();
        if t.shape.len() != 1 {
            return Err(
                "LabelEncoder keys/values tensors must be one-dimensional; repair attributes"
                    .into(),
            );
        }
        return Ok(t.clone());
    }
    if name.ends_with("strings") {
        return Tensor::text(
            vec![a.strings(name)?.unwrap().len()],
            a.strings(name)?
                .unwrap()
                .iter()
                .map(|s| s.as_bytes().to_vec())
                .collect(),
        );
    }
    if name.ends_with("int64s") {
        return Tensor::vector_i64(&a.ints(name)?.unwrap());
    }
    let values = a.floats(name)?.unwrap();
    let mut t = Tensor::zeros(1, vec![values.len()])?;
    for (i, &v) in values.iter().enumerate() {
        t.set(i, Number::F(v));
    }
    Ok(t)
}
fn label(x: &Tensor, a: &Attrs, version: u32) -> Result<Tensor> {
    if version == 1 {
        let strings = a
            .strings("classes_strings")?
            .ok_or("LabelEncoder-1 requires classes_strings; supply class labels")?;
        return category(
            x,
            a,
            &(0..strings.len() as i64).collect::<Vec<_>>(),
            &strings,
        );
    }
    let keys = attribute_tensor(a, "keys")?;
    let values = attribute_tensor(a, "values")?;
    same_type(x, &keys)?;
    if keys.size() != values.size() {
        return Err("LabelEncoder keys and values have different lengths; repair mapping".into());
    }
    let mut map = HashMap::new();
    for i in 0..keys.size() {
        map.insert(key(&keys, i, version), i);
    }
    let default = if let Some(t) = a.tensor("default_tensor")? {
        same_type(&values, t)?;
        if t.size() != 1 {
            return Err(
                "LabelEncoder default_tensor must have one element; repair attribute".into(),
            );
        }
        t.clone()
    } else if values.kind == 8 {
        Tensor::text(
            vec![],
            vec![a.string("default_string", "_Unused")?.as_bytes().to_vec()],
        )?
    } else {
        let mut d = Tensor::zeros(values.kind, vec![])?;
        d.set(
            0,
            if matches!(values.kind, 1 | 11) {
                Number::F(a.float("default_float", -0.)?)
            } else {
                Number::I(a.int("default_int64", -1)?)
            },
        );
        d
    };
    let mut y = Tensor::zeros(values.kind, x.shape.clone())?;
    for i in 0..x.size() {
        if let Some(&j) = map.get(&key(x, i, version)) {
            y.copy_element(i, &values, j);
        } else {
            y.copy_element(i, &default, 0);
        }
    }
    Ok(y)
}
fn category(x: &Tensor, a: &Attrs, ints: &[i64], strings: &[&str]) -> Result<Tensor> {
    if ints.len() != strings.len() || a.has("default_string") && a.has("default_int64") {
        return Err(
            "CategoryMapper needs equal category lists and at most one default; repair attributes"
                .into(),
        );
    }
    if x.kind == 8 {
        let mut map = HashMap::new();
        for (i, &s) in strings.iter().enumerate() {
            map.insert(s.as_bytes(), ints[i]);
        }
        let mut y = Tensor::zeros(7, x.shape.clone())?;
        for (i, s) in x.strings.as_ref().unwrap().iter().enumerate() {
            y.set(
                i,
                Number::I(
                    map.get(s.as_slice())
                        .copied()
                        .unwrap_or(a.int("default_int64", -1)?),
                ),
            );
        }
        Ok(y)
    } else if x.kind == 7 {
        let mut map = HashMap::new();
        for (i, &n) in ints.iter().enumerate() {
            map.insert(n, strings[i]);
        }
        Tensor::text(
            x.shape.clone(),
            (0..x.size())
                .map(|i| {
                    Ok(map
                        .get(&x.get(i).i())
                        .copied()
                        .unwrap_or(a.string("default_string", "_Unused")?)
                        .as_bytes()
                        .to_vec())
                })
                .collect::<Result<Vec<_>>>()?,
        )
    } else {
        Err("CategoryMapper requires string or int64 input; repair dtype".into())
    }
}
pub fn execute(
    op: &str,
    inputs: &[Option<Tensor>],
    a: &Attrs,
    version: u32,
) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    if op == "LabelEncoder" {
        return Ok(vec![label(x, a, version)?]);
    }
    if op == "CategoryMapper" {
        return Ok(vec![category(
            x,
            a,
            &a.ints("cats_int64s")?.unwrap_or_default(),
            &a.strings("cats_strings")?.unwrap_or_default(),
        )?]);
    }
    if op == "ArrayFeatureExtractor" {
        if x.shape.is_empty() {
            return Err("ArrayFeatureExtractor input must have positive rank; repair shape".into());
        }
        let index = input(inputs, 1)?;
        if index.kind != 7 {
            return Err("ArrayFeatureExtractor indices must be int64; repair dtype".into());
        }
        let width = *x.shape.last().unwrap();
        let mut shape = x.shape.clone();
        *shape.last_mut().unwrap() = index.size();
        if shape.len() == 1 {
            shape.insert(0, 1);
        }
        let mut y = Tensor::zeros(x.kind, shape)?;
        let indices = index.ints()?;
        if indices.iter().any(|&n| n < 0 || n as usize >= width) {
            return Err(
                "ArrayFeatureExtractor index is outside the last axis; supply valid indices".into(),
            );
        }
        if width > 0 {
            for row in 0..x.size() / width {
                for (j, &k) in indices.iter().enumerate() {
                    y.copy_element(row * indices.len() + j, x, row * width + k as usize);
                }
            }
        }
        return Ok(vec![y]);
    }
    if op == "OneHotEncoder" {
        let ints = a.ints("cats_int64s")?;
        let strings = a.strings("cats_strings")?;
        if ints.is_some() == strings.is_some() || (x.kind == 8) != strings.is_some() {
            return Err("OneHotEncoder requires exactly one category list matching the input dtype; repair categories".into());
        }
        let count = ints
            .as_ref()
            .map_or_else(|| strings.as_ref().unwrap().len(), Vec::len);
        let mut shape = x.shape.clone();
        shape.push(count);
        let mut y = Tensor::zeros(1, shape)?;
        let zeros = a.flag("zeros", true)?;
        let map: HashMap<_, _> = if let Some(ints) = ints {
            ints.iter()
                .enumerate()
                .map(|(j, &n)| (Key::Integer(n), j))
                .collect()
        } else {
            strings
                .unwrap()
                .iter()
                .enumerate()
                .map(|(j, s)| (Key::String(s.as_bytes().to_vec()), j))
                .collect()
        };
        for i in 0..x.size() {
            let k = if x.kind == 8 {
                key(x, i, version)
            } else {
                Key::Integer(x.get(i).i())
            };
            if let Some(&j) = map.get(&k) {
                y.set(i * count + j, Number::U(1));
            } else if !zeros {
                return Err(
                    "OneHotEncoder category is absent and zeros=0; repair input or vocabulary"
                        .into(),
                );
            }
        }
        return Ok(vec![y]);
    }
    if op == "FeatureVectorizer" {
        let dims = a
            .ints("inputdimensions")?
            .ok_or("FeatureVectorizer requires inputdimensions; specify feature counts")?;
        if dims.len() != inputs.len() || dims.iter().any(|&d| d < 0 || d > i32::MAX as i64) {
            return Err(
                "FeatureVectorizer needs one nonnegative width per input; repair attributes".into(),
            );
        }
        let rows = if x.shape.len() == 1 {
            1
        } else {
            *x.shape.first().unwrap_or(&0)
        };
        let width = dims.iter().try_fold(0usize, |n, &d| {
            n.checked_add(d as usize)
                .ok_or("FeatureVectorizer output width overflow; use smaller dimensions")
        })?;
        elements(&[width])?;
        let mut y = Tensor::zeros(1, vec![rows, width])?;
        let mut start = 0;
        for (j, &dim) in dims.iter().enumerate() {
            let t = input(inputs, j)?;
            same_type(x, t)?;
            t.numeric()?;
            if !matches!(t.shape.len(), 1 | 2)
                || (t.shape.len() == 2 && t.shape[0] != rows)
                || (t.shape.len() == 1 && rows != 1)
            {
                return Err("FeatureVectorizer inputs must have equal batch sizes and rank one or two; repair inputs".into());
            }
            let n = *t.shape.last().unwrap();
            if n > dim as usize {
                return Err("FeatureVectorizer input exceeds its declared feature width; repair inputdimensions".into());
            }
            if n == 0 {
                start += dim as usize;
                continue;
            }
            for row in 0..rows {
                for c in 0..n {
                    y.set(row * width + start + c, t.get(row * n + c));
                }
            }
            start += dim as usize;
        }
        return Ok(vec![y]);
    }
    if !matches!(x.kind, 1 | 6 | 7 | 11) {
        return Err(
            "ML preprocessing input must be float32/float64/int32/int64; repair dtype".into(),
        );
    }
    let features = x.shape.last().copied().unwrap_or(1);
    if op == "Imputer" {
        let integral = matches!(x.kind, 6 | 7);
        let floats = a.floats("imputed_value_floats")?;
        let ints = a.ints("imputed_value_int64s")?;
        if floats.is_some() == ints.is_some() || integral != ints.is_some() {
            return Err("Imputer requires exactly one replacement list matching input dtype; repair attributes".into());
        }
        let values: Vec<_> = if let Some(values) = ints {
            values.into_iter().map(Number::I).collect()
        } else {
            floats.unwrap().into_iter().map(Number::F).collect()
        };
        if x.kind == 6
            && values
                .iter()
                .any(|v| v.i() < i32::MIN as i64 || v.i() > i32::MAX as i64)
        {
            return Err(
                "Imputer replacement does not fit int32; choose a representable value".into(),
            );
        }
        if values.len() != 1 && values.len() != features {
            return Err(
                "Imputer replacement count must be one or the feature width; repair attributes"
                    .into(),
            );
        }
        let replaced = if integral {
            Number::I(a.int("replaced_value_int64", 0)?)
        } else {
            Number::F(a.float("replaced_value_float", 0.)?)
        };
        let mut y = x.clone();
        for i in 0..x.size() {
            let v = x.get(i);
            if v.cmp(replaced) == Some(std::cmp::Ordering::Equal)
                || v.f().is_nan() && replaced.f().is_nan()
            {
                y.set(i, values[if values.len() == 1 { 0 } else { i % features }]);
            }
        }
        return Ok(vec![y]);
    }
    let mut y = Tensor::zeros(if op == "Binarizer" { x.kind } else { 1 }, x.shape.clone())?;
    if op == "Normalizer" {
        if !matches!(x.shape.len(), 1 | 2) {
            return Err("Normalizer input must have rank one or two; repair shape".into());
        }
        let norm = a.string("norm", "MAX")?;
        if !matches!(norm, "MAX" | "L1" | "L2") {
            return Err("Normalizer norm must be MAX/L1/L2; repair attribute".into());
        }
        if features > 0 {
            for row in 0..x.size() / features {
                let mut scale = if norm == "MAX" { f64::NEG_INFINITY } else { 0. };
                for c in 0..features {
                    let v = x.get(row * features + c).f();
                    scale = match norm {
                        "MAX" => scale.max(v),
                        "L1" => scale + v.abs(),
                        _ => scale.hypot(v),
                    };
                }
                for c in 0..features {
                    let v = x.get(row * features + c).f();
                    y.set(
                        row * features + c,
                        Number::F(if scale == 0. { v } else { v / scale }),
                    );
                }
            }
        }
    } else if op == "Scaler" {
        let offset = a.floats("offset")?.unwrap_or(vec![0.]);
        let scale = a.floats("scale")?.unwrap_or(vec![1.]);
        if offset.len() != scale.len() || (offset.len() != 1 && offset.len() != features) {
            return Err("Scaler offset/scale lengths must match and be one or the feature width; repair attributes".into());
        }
        for i in 0..x.size() {
            let j = if scale.len() == 1 { 0 } else { i % features };
            y.set(i, Number::F((x.get(i).f() - offset[j]) * scale[j]));
        }
    } else {
        let threshold = a.float("threshold", 0.)?;
        for i in 0..x.size() {
            let greater = if x.kind == 7 {
                if threshold.is_nan() || threshold >= 9223372036854775808. {
                    false
                } else if threshold < -9223372036854775808. {
                    true
                } else {
                    x.get(i).i() > threshold.floor() as i64
                }
            } else {
                x.get(i).f() > threshold
            };
            y.set(i, Number::U(greater as u64));
        }
    }
    Ok(vec![y])
}
