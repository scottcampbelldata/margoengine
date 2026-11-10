use crate::attrs::{input, Attrs};
use crate::tensor::{broadcast, broadcast_index, elements, Number, Result, Tensor};
pub fn supports(op: &str) -> bool {
    matches!(op, "StringConcat" | "StringSplit")
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let strings = x
        .strings
        .as_ref()
        .ok_or("string operator needs UTF-8 string tensors; repair dtype")?;
    if op == "StringConcat" {
        let y = input(inputs, 1)?;
        let right = y
            .strings
            .as_ref()
            .ok_or("StringConcat needs string inputs; repair dtype")?;
        let shape = broadcast(&x.shape, &y.shape)?;
        let n = elements(&shape)?;
        let values = (0..n)
            .map(|i| {
                let mut s = strings[broadcast_index(i, &shape, &x.shape)].clone();
                s.extend(&right[broadcast_index(i, &shape, &y.shape)]);
                s
            })
            .collect();
        return Ok(vec![Tensor::text(shape, values)?]);
    }
    let delimiter = a.string("delimiter", "")?;
    let max = a.int("maxsplit", -1)?;
    if a.has("maxsplit") && max < 0 {
        return Err(
            "StringSplit maxsplit must be nonnegative when supplied; repair attribute".into(),
        );
    }
    let max = if max < 0 { usize::MAX } else { max as usize };
    let mut rows = Vec::new();
    let mut width = 0;
    let mut counts = Tensor::zeros(7, x.shape.clone())?;
    for (i, s) in strings.iter().enumerate() {
        let s =
            std::str::from_utf8(s).map_err(|_| "StringSplit requires valid UTF-8; repair input")?;
        let row: Vec<Vec<u8>> = if delimiter.is_empty() {
            // ONNX removes leading and trailing whitespace even when maxsplit leaves a suffix.
            let mut rest = s.trim_matches(char::is_whitespace);
            let mut values = Vec::new();
            let mut splits = 0;
            while !rest.is_empty() {
                if splits == max {
                    values.push(rest.as_bytes().to_vec());
                    break;
                }
                if let Some((at, ch)) = rest.char_indices().find(|(_, c)| c.is_whitespace()) {
                    values.push(rest[..at].as_bytes().to_vec());
                    rest = rest[at + ch.len_utf8()..].trim_start_matches(char::is_whitespace);
                    splits += 1;
                } else {
                    values.push(rest.as_bytes().to_vec());
                    break;
                }
            }
            values
        } else {
            let mut values = Vec::new();
            let mut rest = s;
            let mut splits = 0;
            while splits < max {
                if let Some(at) = rest.find(delimiter) {
                    values.push(rest[..at].as_bytes().to_vec());
                    rest = &rest[at + delimiter.len()..];
                    splits += 1;
                } else {
                    break;
                }
            }
            values.push(rest.as_bytes().to_vec());
            values
        };
        width = width.max(row.len());
        counts.set(i, Number::I(row.len() as i64));
        rows.push(row);
    }
    let mut shape = x.shape.clone();
    if x.size() > 0 {
        shape.push(width);
    }
    elements(&shape)?;
    let mut values = Vec::new();
    for mut row in rows {
        row.resize(width, vec![]);
        values.extend(row);
    }
    Ok(vec![Tensor::text(shape, values)?, counts])
}
