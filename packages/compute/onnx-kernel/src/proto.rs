// Field numbers come from the normative ONNX IR protobuf schema, not generated
// bindings or another runtime. Numeric payload decoding stays in this feature's Wasm.
use crate::store::Store;
use crate::tensor::{byte_len, elements, width, Number, Result, Tensor};
use crate::wire::{text, Json, Message, Value};
use std::collections::HashSet;

pub struct Parser<'a> {
    pub store: &'a mut Store,
    nodes: usize,
    legacy: bool,
}
impl<'a> Parser<'a> {
    pub fn new(store: &'a mut Store) -> Self {
        Self {
            store,
            nodes: 0,
            legacy: false,
        }
    }
    fn depth(depth: usize) -> Result<()> {
        if depth > 64 {
            Err("ONNX nesting exceeds 64 levels; simplify nested graphs or types".into())
        } else {
            Ok(())
        }
    }
    pub fn model(&mut self, bytes: &[u8]) -> Result<Json> {
        if bytes.len() > 536_870_912 {
            return Err("ONNX file exceeds 512 MiB; use external tensor data".into());
        }
        let p = Message::parse(bytes)?;
        let ir = p.uint(1, 0)?;
        if ir == 0 || ir > 13 {
            return Err(format!("ONNX IR version {ir} is not a released version supported by this importer; export IR 1..13"));
        }
        self.legacy = ir == 1;
        let imports = self.opsets(&p, 8)?;
        if ir >= 3 && p.messages(8)?.is_empty() {
            return Err(
                "ONNX model has no opset imports; export a model with versioned operator sets"
                    .into(),
            );
        }
        let graph = self.graph(
            p.bytes(7)?
                .ok_or("ONNX model has no graph; supply an inference model")?,
            0,
        )?;
        let functions = p
            .messages(25)?
            .into_iter()
            .map(|f| self.function(f, 0))
            .collect::<Result<Vec<_>>>()?;
        Ok(Json::object([
            ("irVersion", Json::n(ir as usize)),
            ("opsets", imports),
            ("producer", Json::s(p.string(2)?)),
            ("producerVersion", Json::s(p.string(3)?)),
            ("domain", Json::s(p.string(4)?)),
            ("version", Json::s((p.uint(5, 0)? as i64).to_string())),
            ("description", Json::s(p.string(6)?)),
            ("metadata", self.pairs(&p, 14)?),
            ("graph", graph),
            ("functions", Json::Array(functions)),
        ]))
    }
    fn pairs(&self, p: &Message, tag: u32) -> Result<Json> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for bytes in p.messages(tag)? {
            let m = Message::parse(bytes)?;
            let key = m.string(1)?;
            if !seen.insert(key.clone()) {
                return Err(format!("ONNX metadata key {key} repeats; use unique keys"));
            }
            out.push((key, Json::s(m.string(2)?)));
        }
        Ok(Json::Object(out))
    }
    fn opsets(&self, p: &Message, tag: u32) -> Result<Json> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for bytes in p.messages(tag)? {
            let m = Message::parse(bytes)?;
            let raw = m.string(1)?;
            let d = if raw == "ai.onnx" { String::new() } else { raw };
            let v = m.uint(2, 0)?;
            if v == 0 || v > i32::MAX as u64 || !seen.insert(d.clone()) {
                return Err("ONNX opset imports need unique domains and positive versions; repair the model imports".into());
            }
            out.push((d, Json::n(v as usize)));
        }
        Ok(Json::Object(out))
    }
    fn function(&mut self, bytes: &[u8], depth: usize) -> Result<Json> {
        Self::depth(depth)?;
        let p = Message::parse(bytes)?;
        let name = p.string(1)?;
        if name.is_empty() {
            return Err("ONNX function has no name; name each model-local function".into());
        }
        let attrs = p
            .messages(11)?
            .into_iter()
            .map(|b| self.attribute(b, depth))
            .collect::<Result<Vec<_>>>()?;
        let nodes = p
            .messages(7)?
            .into_iter()
            .map(|b| self.node(b, depth))
            .collect::<Result<Vec<_>>>()?;
        let default_set = self.store.attributes(attrs.clone());
        Ok(Json::object([
            ("name", Json::s(name)),
            ("domain", Json::s(p.string(10)?)),
            ("overload", Json::s(p.string(13)?)),
            ("inputs", Json::strings(p.strings(4)?)),
            ("outputs", Json::strings(p.strings(5)?)),
            ("requiredAttributes", Json::strings(p.strings(6)?)),
            ("defaults", Json::Array(attrs)),
            ("defaultSet", Json::n(default_set)),
            ("opsets", self.opsets(&p, 9)?),
            ("nodes", Json::Array(nodes)),
        ]))
    }
    fn graph(&mut self, bytes: &[u8], depth: usize) -> Result<Json> {
        Self::depth(depth)?;
        let p = Message::parse(bytes)?;
        let nodes = p
            .messages(1)?
            .into_iter()
            .map(|b| self.node(b, depth))
            .collect::<Result<Vec<_>>>()?;
        let mut initializers = p
            .messages(5)?
            .into_iter()
            .map(|b| self.tensor(b))
            .collect::<Result<Vec<_>>>()?;
        for b in p.messages(15)? {
            initializers.push(self.sparse(b)?);
        }
        let inputs = p
            .messages(11)?
            .into_iter()
            .map(|b| self.value_info(b, depth))
            .collect::<Result<Vec<_>>>()?;
        let outputs = p
            .messages(12)?
            .into_iter()
            .map(|b| self.value_info(b, depth))
            .collect::<Result<Vec<_>>>()?;
        Ok(Json::object([
            ("name", Json::s(p.string(2)?)),
            ("nodes", Json::Array(nodes)),
            ("initializers", Json::Array(initializers)),
            ("inputs", Json::Array(inputs)),
            ("outputs", Json::Array(outputs)),
            ("metadata", self.pairs(&p, 16)?),
        ]))
    }
    fn node(&mut self, bytes: &[u8], depth: usize) -> Result<Json> {
        self.nodes += 1;
        if self.nodes > 100_000 {
            return Err(
                "ONNX model exceeds 100000 nodes across graphs/functions; split the model".into(),
            );
        }
        let p = Message::parse(bytes)?;
        let op = p.string(4)?;
        if op.is_empty() {
            return Err("ONNX node has no operator type; export a valid inference graph".into());
        }
        let mut seen = HashSet::new();
        let mut attrs = Vec::new();
        for b in p.messages(5)? {
            let name = Message::parse(b)?.string(1)?;
            if !seen.insert(name) {
                return Err(
                    "ONNX node repeats an attribute name; use unique attribute names".into(),
                );
            }
            attrs.push(self.attribute(b, depth)?);
        }
        let domain = p.string(7)?;
        let attribute_set = self.store.attributes(attrs.clone());
        let kernel_index = self.store.node(op.clone(), domain.clone());
        Ok(Json::object([
            ("name", Json::s(p.string(3)?)),
            ("op", Json::s(op)),
            ("domain", Json::s(domain)),
            ("overload", Json::s(p.string(8)?)),
            ("inputs", Json::strings(p.strings(1)?)),
            ("outputs", Json::strings(p.strings(2)?)),
            ("attributes", Json::Array(attrs)),
            ("attributeSet", Json::n(attribute_set)),
            ("kernelIndex", Json::n(kernel_index)),
        ]))
    }
    fn value_info(&self, bytes: &[u8], depth: usize) -> Result<Json> {
        let p = Message::parse(bytes)?;
        let name = p.string(1)?;
        if name.is_empty() {
            return Err("ONNX value information has an empty name; name graph values".into());
        }
        let kind = match p.bytes(2)? {
            Some(b) => self.type_info(b, depth)?,
            None => Json::Null,
        };
        Ok(Json::object([("name", Json::s(name)), ("type", kind)]))
    }
    fn type_info(&self, bytes: &[u8], depth: usize) -> Result<Json> {
        Self::depth(depth)?;
        let p = Message::parse(bytes)?;
        let field = p
            .fields
            .iter()
            .rev()
            .find(|f| matches!(f.tag, 1 | 4 | 5 | 7 | 8 | 9))
            .ok_or("ONNX type has no value type; supply a tensor/sequence/map/optional type")?;
        let Value::Bytes(bytes) = field.value else {
            return Err("ONNX value type is not a message; repair its type information".into());
        };
        let m = Message::parse(bytes)?;
        match field.tag {
            1|8=>{let kind=m.uint(1,0)?;width(kind as u32)?;let shape=if let Some(b)=m.bytes(2)?{let dims=Message::parse(b)?;let mut out=Vec::new();for b in dims.messages(1)?{let d=Message::parse(b)?;let latest=d.fields.iter().rev().find(|f|matches!(f.tag,1|2));out.push(match latest{Some(f)if f.tag==1=>{let n=d.uint(1,0)? as i64;if n<0||n>i32::MAX as i64{return Err("static tensor dimension is outside 0..2147483647; use a supported dimension".into());}Json::Num(n as f64)},Some(_)=>Json::s(d.string(2)?),None=>Json::Null});}Json::Array(out)}else{Json::Null};Ok(Json::object([("tag",Json::s(if field.tag==1{"tensor"}else{"sparse"})),("kind",Json::n(kind as usize)),("shape",shape)]))},
            4|9=>{let child=m.bytes(1)?.ok_or("ONNX container has no element type; specify its element type")?;Ok(Json::object([("tag",Json::s(if field.tag==4{"sequence"}else{"optional"})),("element",self.type_info(child,depth+1)?)]))},
            5=>{let kind=m.uint(1,0)?;if !matches!(kind,6|7|8|12|13){return Err("ONNX map key type must be an integer or string; use a supported map key".into());}let child=m.bytes(2)?.ok_or("ONNX map has no value type; specify its value type")?;Ok(Json::object([("tag",Json::s("map")),("keyKind",Json::n(kind as usize)),("element",self.type_info(child,depth+1)?)]))},
            _=>Err("opaque ONNX values have no portable inference representation; use an explicit tensor/sequence/map type".into()),
        }
    }
    fn attribute(&mut self, bytes: &[u8], depth: usize) -> Result<Json> {
        Self::depth(depth)?;
        let p = Message::parse(bytes)?;
        let name = p.string(1)?;
        if name.is_empty() {
            return Err("ONNX attribute has no name; name each node attribute".into());
        }
        let reference = p.string(21)?;
        let mut kind = p.uint(20, 0)?;
        if kind == 0 && self.legacy {
            for (tag, k) in [
                (2, 1),
                (3, 2),
                (4, 3),
                (5, 4),
                (6, 5),
                (7, 6),
                (8, 7),
                (9, 8),
                (10, 9),
                (11, 10),
            ] {
                if p.has(tag) {
                    kind = k;
                    break;
                }
            }
        }
        if !(1..=14).contains(&kind) {
            return Err(format!(
                "ONNX attribute {name} has invalid type {kind}; export a typed attribute"
            ));
        }
        let value = if !reference.is_empty() {
            Json::Null
        } else {
            match kind {
                1 => match p.get(2) {
                    None => Json::Num(0.),
                    Some(Value::Fixed32(v)) => Json::Num(f32::from_bits(v) as f64),
                    _ => {
                        return Err(
                            "ONNX float attribute has invalid wire storage; repair the model"
                                .into(),
                        )
                    }
                },
                2 => Json::s((p.uint(3, 0)? as i64).to_string()),
                3 => Json::s(text(p.bytes(4)?.unwrap_or(&[]))?),
                4 => self.tensor(
                    p.bytes(5)?
                        .ok_or("ONNX tensor attribute has no tensor; supply its value")?,
                )?,
                5 => self.graph(
                    p.bytes(6)?
                        .ok_or("ONNX graph attribute has no graph; supply its value")?,
                    depth + 1,
                )?,
                6 => Json::Array(
                    p.fixed(7, false)?
                        .chunks_exact(4)
                        .map(|v| Json::Num(f32::from_le_bytes(v.try_into().unwrap()) as f64))
                        .collect(),
                ),
                7 => Json::Array(
                    p.integers(8)?
                        .iter()
                        .map(|&v| Json::s((v as i64).to_string()))
                        .collect(),
                ),
                8 => Json::strings(p.strings(9)?),
                9 => Json::Array(
                    p.messages(10)?
                        .into_iter()
                        .map(|b| self.tensor(b))
                        .collect::<Result<Vec<_>>>()?,
                ),
                10 => Json::Array(
                    p.messages(11)?
                        .into_iter()
                        .map(|b| self.graph(b, depth + 1))
                        .collect::<Result<Vec<_>>>()?,
                ),
                11 => self.sparse(
                    p.bytes(22)?
                        .ok_or("ONNX sparse attribute has no tensor; supply its value")?,
                )?,
                12 => Json::Array(
                    p.messages(23)?
                        .into_iter()
                        .map(|b| self.sparse(b))
                        .collect::<Result<Vec<_>>>()?,
                ),
                13 => self.type_info(
                    p.bytes(14)?
                        .ok_or("ONNX type attribute has no type; supply its value")?,
                    depth + 1,
                )?,
                14 => Json::Array(
                    p.messages(15)?
                        .into_iter()
                        .map(|b| self.type_info(b, depth + 1))
                        .collect::<Result<Vec<_>>>()?,
                ),
                _ => unreachable!(),
            }
        };
        Ok(Json::object([
            ("name", Json::s(name)),
            ("kind", Json::n(kind as usize)),
            ("reference", Json::s(reference)),
            ("value", value),
        ]))
    }
    fn dimensions(&self, p: &Message, tag: u32) -> Result<Vec<usize>> {
        p.integers(tag)?
            .into_iter()
            .map(|v| {
                if v > i32::MAX as u64 {
                    Err(
                        "ONNX tensor dimension is outside 0..2147483647; use a supported size"
                            .into(),
                    )
                } else {
                    Ok(v as usize)
                }
            })
            .collect()
    }
    fn tensor(&mut self, bytes: &[u8]) -> Result<Json> {
        let p = Message::parse(bytes)?;
        let kind = p.uint(2, 0)? as u32;
        width(kind)?;
        let shape = self.dimensions(&p, 1)?;
        let size = elements(&shape)?;
        let name = p.string(8)?;
        if p.has(3) {
            return Err("segmented ONNX TensorProto data is not a complete initializer; export raw/external tensor data".into());
        }
        let external = self.pairs(&p, 13)?;
        let location = p.uint(14, 0)?;
        if location > 1 {
            return Err(
                "ONNX tensor has an unknown data location; use raw or external data".into(),
            );
        }
        let id = if location == 1 {
            if p.has(9) || (4..=7).any(|t| p.has(t)) || p.has(10) || p.has(11) {
                return Err(
                    "external ONNX tensor also has inline data; use one storage location".into(),
                );
            }
            if kind == 8 {
                return Err(
                    "external string tensors have no raw-data representation; use string_data"
                        .into(),
                );
            }
            self.store.insert(Tensor {
                kind,
                shape: shape.clone(),
                data: std::sync::Arc::new(Vec::new()),
                strings: None,
            })?
        } else {
            if let Json::Object(pairs) = &external {
                if !pairs.is_empty() {
                    return Err("ONNX external_data requires EXTERNAL data_location; repair the tensor metadata".into());
                }
            }
            let t = if kind == 8 {
                if [4, 5, 7, 9, 10, 11].iter().any(|&tag| p.has(tag)) {
                    return Err(
                        "ONNX strings must use string_data, not raw_data; export string storage"
                            .into(),
                    );
                }
                let strings = p
                    .messages(6)?
                    .into_iter()
                    .map(|b| {
                        text(b)?;
                        Ok(b.to_vec())
                    })
                    .collect::<Result<Vec<_>>>()?;
                Tensor::text(shape.clone(), strings)?
            } else if let Some(raw) = p.bytes(9)? {
                if (4..=7).any(|t| p.has(t)) || p.has(10) || p.has(11) {
                    return Err(
                        "ONNX tensor mixes raw and typed payloads; use one data representation"
                            .into(),
                    );
                }
                Tensor::raw(kind, shape.clone(), raw.to_vec())?
            } else {
                let field = match kind {
                    1 => 4,
                    11 => 10,
                    7 => 7,
                    12 | 13 => 11,
                    _ => 5,
                };
                for tag in [4, 5, 6, 7, 10, 11] {
                    if tag != field && p.has(tag) {
                        return Err("ONNX tensor payload field disagrees with data_type; export the matching typed payload".into());
                    }
                }
                if kind == 1 || kind == 11 {
                    Tensor::raw(kind, shape.clone(), p.fixed(field, kind == 11)?)?
                } else {
                    let values = p.integers(field)?;
                    if kind == 21 || kind == 22 {
                        if values.len() != size.div_ceil(2) || values.iter().any(|v| *v > 255) {
                            return Err("ONNX 4-bit typed data needs packed byte pairs; pack two nibbles per value".into());
                        }
                        Tensor::raw(
                            kind,
                            shape.clone(),
                            values.iter().map(|&v| v as u8).collect(),
                        )?
                    } else {
                        if values.len() != size {
                            return Err(format!("ONNX tensor {name} has {} values, expected {size}; check its shape",values.len()));
                        }
                        let mut tensor = Tensor::zeros(kind, shape.clone())?;
                        for (i, &v) in values.iter().enumerate() {
                            if kind == 10 || kind == 16 {
                                if v > 65535 {
                                    return Err("16-bit floating typed storage must contain unsigned bit patterns; export valid float bits".into());
                                }
                                std::sync::Arc::make_mut(&mut tensor.data)[2 * i..2 * i + 2]
                                    .copy_from_slice(&(v as u16).to_le_bytes());
                            } else {
                                tensor.set(
                                    i,
                                    if matches!(kind, 2 | 4 | 9 | 12 | 13) {
                                        Number::U(v)
                                    } else if kind == 7 {
                                        Number::I(v as i64)
                                    } else {
                                        Number::I(v as u32 as i32 as i64)
                                    },
                                );
                            }
                        }
                        tensor
                    }
                }
            };
            self.store.insert(t)?
        };
        Ok(Json::object([
            ("name", Json::s(name)),
            ("kind", Json::n(kind as usize)),
            (
                "shape",
                Json::Array(shape.iter().map(|&n| Json::n(n)).collect()),
            ),
            ("id", Json::n(id as usize)),
            ("external", external),
            ("externalStorage", Json::Bool(location == 1)),
            (
                "bytes",
                Json::n(if kind == 8 { 0 } else { byte_len(kind, size)? }),
            ),
        ]))
    }
    fn sparse(&mut self, bytes: &[u8]) -> Result<Json> {
        let p = Message::parse(bytes)?;
        let shape = self.dimensions(&p, 3)?;
        elements(&shape)?;
        let values = self.tensor(
            p.bytes(1)?
                .ok_or("ONNX sparse tensor has no values; supply sparse values")?,
        )?;
        let indices = self.tensor(
            p.bytes(2)?
                .ok_or("ONNX sparse tensor has no indices; supply sparse indices")?,
        )?;
        let (name, kind) = if let Json::Object(fields) = &values {
            (
                fields.iter().find(|(k, _)| k == "name").unwrap().1.clone(),
                fields.iter().find(|(k, _)| k == "kind").unwrap().1.clone(),
            )
        } else {
            unreachable!()
        };
        let kind_number = kind.integer()? as u32;
        let id = self.store.insert(Tensor {
            kind: kind_number,
            shape: shape.clone(),
            data: std::sync::Arc::new(Vec::new()),
            strings: None,
        })?;
        Ok(Json::object([
            ("name", name),
            ("kind", kind),
            (
                "shape",
                Json::Array(shape.iter().map(|&n| Json::n(n)).collect()),
            ),
            ("id", Json::n(id as usize)),
            ("sparseValues", values),
            ("sparseIndices", indices),
        ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn var(mut n: u64) -> Vec<u8> {
        let mut v = vec![];
        while n >= 128 {
            v.push(n as u8 | 128);
            n >>= 7;
        }
        v.push(n as u8);
        v
    }
    fn vi(tag: u32, n: u64) -> Vec<u8> {
        [var((tag as u64) << 3), var(n)].concat()
    }
    fn bytes(tag: u32, b: &[u8]) -> Vec<u8> {
        [var((tag as u64) << 3 | 2), var(b.len() as u64), b.to_vec()].concat()
    }
    #[test]
    fn int64_initializers_preserve_bits_and_unknown_fields_skip() {
        let mut s = Store::new();
        let payload = [
            vi(2, 7),
            bytes(1, &var(2)),
            bytes(7, &[var(9007199254740993), var(u64::MAX)].concat()),
            bytes(8, b"big"),
        ]
        .concat();
        let graph = [bytes(2, b"g"), bytes(5, &payload)].concat();
        let model = [
            vi(1, 8),
            bytes(7, &graph),
            bytes(8, &vi(2, 18)),
            vi(100, 19),
        ]
        .concat();
        let json = Parser::new(&mut s).model(&model).unwrap().encode();
        assert!(json.contains("\"irVersion\":8"));
        let t = s.get(1).unwrap();
        assert_eq!(t.get(0).i(), 9007199254740993);
        assert_eq!(t.get(1).i(), -1);
    }
    #[test]
    fn raw_shape_mismatch_and_missing_graph_reject() {
        let mut s = Store::new();
        let mut p = Parser::new(&mut s);
        assert!(p.model(&vi(1, 8)).is_err());
        let tensor = [vi(2, 1), bytes(1, &var(2)), bytes(9, &1f32.to_le_bytes())].concat();
        assert!(p.tensor(&tensor).is_err());
    }
    #[test]
    fn symbolic_scalar_and_unknown_rank_are_distinct() {
        let s = &mut Store::new();
        let p = Parser::new(s);
        let scalar = bytes(1, &[vi(1, 1), bytes(2, &[])].concat());
        let unknown = bytes(1, &vi(1, 1));
        let symbolic = bytes(
            1,
            &[vi(1, 1), bytes(2, &bytes(1, &bytes(2, b"batch")))].concat(),
        );
        assert!(p
            .type_info(&scalar, 0)
            .unwrap()
            .encode()
            .contains("\"shape\":[]"));
        assert!(p
            .type_info(&unknown, 0)
            .unwrap()
            .encode()
            .contains("\"shape\":null"));
        assert!(p
            .type_info(&symbolic, 0)
            .unwrap()
            .encode()
            .contains("\"batch\""));
    }
}
