use crate::attrs::{input, Attrs};
use crate::tensor::{Number, Result, Tensor};
pub fn supports(op: &str) -> bool {
    matches!(op, "Cast" | "CastLike")
}
pub fn execute(op: &str, inputs: &[Option<Tensor>], a: &Attrs) -> Result<Vec<Tensor>> {
    let x = input(inputs, 0)?;
    let kind = if op == "CastLike" {
        input(inputs, 1)?.kind
    } else {
        let to = a.int("to", 0)?;
        if to <= 0 || to > u32::MAX as i64 {
            return Err(
                "Cast requires a supported TensorProto type in to; supply the destination type"
                    .into(),
            );
        }
        to as u32
    };
    crate::tensor::width(kind)?;
    if x.kind == kind {
        return Ok(vec![x.clone()]);
    }
    if kind == 8 {
        let strings = (0..x.size())
            .map(|i| {
                let v = x.get(i);
                match v {
                    Number::I(n) => n.to_string(),
                    Number::U(n) => n.to_string(),
                    Number::F(n) => {
                        if n.is_nan() {
                            "NaN".into()
                        } else if n == f64::INFINITY {
                            "INF".into()
                        } else if n == f64::NEG_INFINITY {
                            "-INF".into()
                        } else if x.kind == 1 {
                            (n as f32).to_string()
                        } else {
                            n.to_string()
                        }
                    }
                }
                .into_bytes()
            })
            .collect();
        return Ok(vec![Tensor::text(x.shape.clone(), strings)?]);
    }
    let mut y = Tensor::zeros(kind, x.shape.clone())?;
    for i in 0..x.size() {
        let v = if x.kind == 8 {
            let s = std::str::from_utf8(&x.strings.as_ref().unwrap()[i])
                .map_err(|_| "Cast string is not UTF-8; supply a numeric string")?
                .trim();
            let lower = s.to_ascii_lowercase();
            if matches!(kind, 3 | 5 | 6 | 7 | 22) {
                Number::I(s.parse::<i64>().map_err(|_|"Cast integer string is invalid or out of range; supply a representable decimal integer")?)
            } else if matches!(kind, 2 | 4 | 12 | 13 | 21) {
                Number::U(s.parse::<u64>().map_err(|_|"Cast unsigned string is invalid or out of range; supply a representable decimal integer")?)
            } else {
                let n=match lower.as_str(){"inf"|"+inf"=>f64::INFINITY,"-inf"=>f64::NEG_INFINITY,"nan"|"+nan"|"-nan"=>f64::NAN,_=>s.parse::<f64>().map_err(|_|"Cast float string is invalid; supply a decimal/scientific number or INF/NaN")?};
                Number::F(n)
            }
        } else {
            x.get(i)
        };
        y.set(i, v);
    }
    Ok(vec![y])
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{store::Store, wire::Json};
    fn attrs(to: u32) -> Vec<Json> {
        vec![Json::object([
            ("name", Json::s("to")),
            ("kind", Json::n(2)),
            ("value", Json::s(to.to_string())),
        ])]
    }
    #[test]
    fn exact_strings_wrap_and_bool_nan() {
        let s = Store::new();
        let t = Tensor::vector_i64(&[9007199254740993, -1]).unwrap();
        let e = attrs(8);
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        let y = execute("Cast", &[Some(t.clone())], &a).unwrap();
        assert_eq!(*y[0].strings.as_ref().unwrap()[0], b"9007199254740993"[..]);
        let e = attrs(7);
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        assert_eq!(
            execute("Cast", &[Some(y[0].clone())], &a).unwrap()[0]
                .ints()
                .unwrap(),
            vec![9007199254740993, -1]
        );
        let e = attrs(2);
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        let y = execute("Cast", &[Some(t)], &a).unwrap();
        assert_eq!(y[0].get(1).u(), 255);
        let mut t = Tensor::zeros(11, vec![3]).unwrap();
        t.set(0, Number::F(f64::NAN));
        t.set(1, Number::F(-0.));
        t.set(2, Number::F(f64::NEG_INFINITY));
        let e = attrs(9);
        let a = Attrs {
            entries: &e,
            store: &s,
        };
        assert_eq!(
            *execute("Cast", &[Some(t)], &a).unwrap()[0].data,
            vec![1, 0, 1]
        );
    }
}
