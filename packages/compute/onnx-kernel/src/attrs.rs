use crate::store::Store;
use crate::tensor::{Result, Tensor};
use crate::wire::Json;

pub struct Attrs<'a> {
    pub entries: &'a [Json],
    pub store: &'a Store,
}
impl<'a> Attrs<'a> {
    pub fn has(&self, name: &str) -> bool {
        self.entries
            .iter()
            .any(|a| a.field("name").and_then(|s| s.string().ok()) == Some(name))
    }
    pub fn value(&self, name: &str, kind: i64) -> Result<Option<&Json>> {
        match self
            .entries
            .iter()
            .find(|a| a.field("name").and_then(|s| s.string().ok()) == Some(name))
        {
            None => Ok(None),
            Some(a) => {
                if a.field("kind")
                    .ok_or("attribute kind is missing; recompile the model")?
                    .integer()?
                    != kind
                {
                    return Err(format!(
                        "attribute {name} has the wrong ONNX type; supply type {kind}"
                    ));
                }
                Ok(a.field("value"))
            }
        }
    }
    pub fn int(&self, name: &str, default: i64) -> Result<i64> {
        self.value(name, 2)?.map_or(Ok(default), Json::integer)
    }
    pub fn flag(&self, name: &str, default: bool) -> Result<bool> {
        let n = self.int(name, default as i64)?;
        if n == 0 || n == 1 {
            Ok(n == 1)
        } else {
            Err(format!(
                "attribute {name} must be 0 or 1; choose a boolean flag"
            ))
        }
    }
    pub fn float(&self, name: &str, default: f64) -> Result<f64> {
        self.value(name, 1)?.map_or(Ok(default), Json::number)
    }
    pub fn string<'b>(&'b self, name: &str, default: &'b str) -> Result<&'b str> {
        self.value(name, 3)?.map_or(Ok(default), Json::string)
    }
    pub fn ints(&self, name: &str) -> Result<Option<Vec<i64>>> {
        self.value(name, 7)?
            .map(|v| v.list()?.iter().map(Json::integer).collect())
            .transpose()
    }
    pub fn floats(&self, name: &str) -> Result<Option<Vec<f64>>> {
        self.value(name, 6)?
            .map(|v| v.list()?.iter().map(Json::number).collect())
            .transpose()
    }
    pub fn strings(&self, name: &str) -> Result<Option<Vec<&str>>> {
        self.value(name, 8)?
            .map(|v| v.list()?.iter().map(Json::string).collect())
            .transpose()
    }
    pub fn tensor(&self, name: &str) -> Result<Option<&Tensor>> {
        let attribute = self
            .entries
            .iter()
            .find(|a| a.field("name").and_then(|s| s.string().ok()) == Some(name));
        let value = if let Some(attribute) = attribute {
            let kind = attribute.field("kind").unwrap().integer()?;
            if kind != 4 && kind != 11 {
                return Err(format!(
                    "attribute {name} must contain a tensor; use tensor or sparse tensor storage"
                ));
            }
            attribute.field("value")
        } else {
            None
        };
        value
            .map(|v| {
                let id = v
                    .field("id")
                    .ok_or("tensor attribute has no storage handle; load its data")?
                    .integer()?;
                self.store.get(id as u32)
            })
            .transpose()
    }
    pub fn known(&self, names: &[&str]) -> Result<()> {
        for attr in self.entries {
            let name = attr.field("name").unwrap().string()?;
            if !names.contains(&name) {
                return Err(format!("unknown operator attribute {name}; use attributes from the selected ONNX opset"));
            }
        }
        Ok(())
    }
}

pub fn input(inputs: &[Option<Tensor>], at: usize) -> Result<&Tensor> {
    inputs
        .get(at)
        .and_then(Option::as_ref)
        .ok_or_else(|| format!("operator input {at} is required; supply that input"))
}
pub fn optional(inputs: &[Option<Tensor>], at: usize) -> Option<&Tensor> {
    inputs.get(at).and_then(Option::as_ref)
}
pub fn floating(t: &Tensor) -> Result<()> {
    if matches!(t.kind, 1 | 10 | 11 | 16) {
        Ok(())
    } else {
        Err(
            "operator requires floating tensors; cast its input to float16, float32 or float64"
                .into(),
        )
    }
}
pub fn same_type(a: &Tensor, b: &Tensor) -> Result<()> {
    if a.kind == b.kind {
        Ok(())
    } else {
        Err("operator input element types differ; cast them to the same ONNX type".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attribute_types_and_exact_large_integers() {
        let store = Store::new();
        let entries = vec![Json::object([
            ("name", Json::s("axis")),
            ("kind", Json::n(2)),
            ("value", Json::s("9007199254740993")),
        ])];
        let a = Attrs {
            entries: &entries,
            store: &store,
        };
        assert_eq!(a.int("axis", 0).unwrap(), 9007199254740993);
        assert!(a.float("axis", 0.).is_err());
        assert!(a.known(&["eps"]).is_err());
        assert_eq!(a.float("eps", 1e-5).unwrap(), 1e-5);
    }
}
