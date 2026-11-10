// Protocol Buffers wire-format specification (protobuf.dev), implemented clean room.
// The ONNX IR uses no groups; unknown groups still skip correctly for forward compatibility.
use crate::tensor::Result;

#[derive(Clone, Copy, Debug)]
pub enum Value<'a> {
    Var(u64),
    Fixed32(u32),
    Fixed64(u64),
    Bytes(&'a [u8]),
}
#[derive(Clone, Copy, Debug)]
pub struct Field<'a> {
    pub tag: u32,
    pub value: Value<'a>,
}
#[derive(Debug)]
pub struct Message<'a> {
    pub fields: Vec<Field<'a>>,
}
pub fn varint(bytes: &[u8], at: &mut usize) -> Result<u64> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let b = *bytes
            .get(*at)
            .ok_or("truncated protobuf varint; supply a complete ONNX file")?;
        *at += 1;
        if shift == 63 && b > 1 {
            return Err("protobuf varint exceeds 64 bits; supply a valid ONNX file".into());
        }
        value |= ((b & 127) as u64) << shift;
        if b & 128 == 0 {
            return Ok(value);
        }
    }
    Err("unterminated protobuf varint; supply a valid ONNX file".into())
}
fn take<'a>(bytes: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8]> {
    let end = at
        .checked_add(n)
        .filter(|&end| end <= bytes.len())
        .ok_or("protobuf field exceeds its message; supply a complete ONNX file")?;
    let out = &bytes[*at..end];
    *at = end;
    Ok(out)
}
fn skip_group(bytes: &[u8], at: &mut usize, tag: u32, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err("protobuf groups exceed depth 64; simplify the model".into());
    }
    loop {
        let key = varint(bytes, at)?;
        let child = (key >> 3) as u32;
        let wire = key & 7;
        if child == 0 || key >> 3 > 0x1fffffff {
            return Err("protobuf field tag is invalid; supply a valid model".into());
        }
        match wire {
            0 => {
                varint(bytes, at)?;
            }
            1 => {
                take(bytes, at, 8)?;
            }
            2 => {
                let n = varint(bytes, at)?;
                if n > usize::MAX as u64 {
                    return Err("protobuf length exceeds address space; use a smaller model".into());
                }
                take(bytes, at, n as usize)?;
            }
            3 => skip_group(bytes, at, child, depth + 1)?,
            4 => {
                if child != tag {
                    return Err(
                        "protobuf group end tag does not match; supply a valid model".into(),
                    );
                }
                return Ok(());
            }
            5 => {
                take(bytes, at, 4)?;
            }
            _ => return Err("protobuf wire type is invalid; supply a valid model".into()),
        }
    }
}
impl<'a> Message<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self> {
        let mut at = 0;
        let mut fields = Vec::new();
        while at < bytes.len() {
            if fields.len() >= 1_000_000 {
                return Err(
                    "protobuf message exceeds one million fields; simplify the model".into(),
                );
            }
            let key = varint(bytes, &mut at)?;
            if key >> 3 == 0 || key >> 3 > 0x1fffffff {
                return Err("protobuf field tag is invalid; supply a valid model".into());
            }
            let tag = (key >> 3) as u32;
            let value = match key & 7 {
                0 => Value::Var(varint(bytes, &mut at)?),
                1 => Value::Fixed64(u64::from_le_bytes(
                    take(bytes, &mut at, 8)?.try_into().unwrap(),
                )),
                2 => {
                    let n = varint(bytes, &mut at)?;
                    if n > usize::MAX as u64 {
                        return Err(
                            "protobuf length exceeds address space; use a smaller model".into()
                        );
                    }
                    Value::Bytes(take(bytes, &mut at, n as usize)?)
                }
                3 => {
                    skip_group(bytes, &mut at, tag, 1)?;
                    continue;
                }
                5 => Value::Fixed32(u32::from_le_bytes(
                    take(bytes, &mut at, 4)?.try_into().unwrap(),
                )),
                _ => return Err("unexpected protobuf wire type; supply a valid ONNX file".into()),
            };
            fields.push(Field { tag, value });
        }
        Ok(Self { fields })
    }
    pub fn has(&self, tag: u32) -> bool {
        self.fields.iter().any(|f| f.tag == tag)
    }
    pub fn get(&self, tag: u32) -> Option<Value<'a>> {
        self.fields
            .iter()
            .rev()
            .find(|f| f.tag == tag)
            .map(|f| f.value)
    }
    pub fn all(&self, tag: u32) -> impl Iterator<Item = Value<'a>> + '_ {
        self.fields
            .iter()
            .filter(move |f| f.tag == tag)
            .map(|f| f.value)
    }
    pub fn uint(&self, tag: u32, default: u64) -> Result<u64> {
        match self.get(tag) {
            None => Ok(default),
            Some(Value::Var(v)) => Ok(v),
            _ => Err(format!(
                "protobuf field {tag} must be a varint; supply a valid model"
            )),
        }
    }
    pub fn bytes(&self, tag: u32) -> Result<Option<&'a [u8]>> {
        match self.get(tag) {
            None => Ok(None),
            Some(Value::Bytes(v)) => Ok(Some(v)),
            _ => Err(format!(
                "protobuf field {tag} must be length-delimited; supply a valid model"
            )),
        }
    }
    pub fn string(&self, tag: u32) -> Result<String> {
        match self.bytes(tag)? {
            None => Ok(String::new()),
            Some(v) => Ok(text(v)?.to_string()),
        }
    }
    pub fn strings(&self, tag: u32) -> Result<Vec<String>> {
        self.all(tag)
            .map(|v| match v {
                Value::Bytes(b) => Ok(text(b)?.to_string()),
                _ => Err(format!(
                    "protobuf field {tag} must contain strings; supply a valid model"
                )),
            })
            .collect()
    }
    pub fn integers(&self, tag: u32) -> Result<Vec<u64>> {
        let mut out = Vec::new();
        for v in self.all(tag) {
            match v {
                Value::Var(v) => out.push(v),
                Value::Bytes(bytes) => {
                    let mut at = 0;
                    while at < bytes.len() {
                        out.push(varint(bytes, &mut at)?);
                    }
                }
                _ => {
                    return Err(format!(
                        "protobuf field {tag} must contain integers; supply a valid model"
                    ))
                }
            }
        }
        Ok(out)
    }
    pub fn fixed(&self, tag: u32, wide: bool) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        for v in self.all(tag) {
            match v {
                Value::Bytes(b) => {
                    if b.len() % if wide { 8 } else { 4 } != 0 {
                        return Err(
                            "packed fixed-width field has a partial element; supply a valid model"
                                .into(),
                        );
                    }
                    out.extend_from_slice(b);
                }
                Value::Fixed32(v) if !wide => out.extend_from_slice(&v.to_le_bytes()),
                Value::Fixed64(v) if wide => out.extend_from_slice(&v.to_le_bytes()),
                _ => {
                    return Err(format!(
                        "protobuf field {tag} has the wrong floating width; supply a valid model"
                    ))
                }
            }
        }
        Ok(out)
    }
    pub fn messages(&self, tag: u32) -> Result<Vec<&'a [u8]>> {
        self.all(tag)
            .map(|v| match v {
                Value::Bytes(b) => Ok(b),
                _ => Err(format!(
                    "protobuf field {tag} must contain messages; supply a valid model"
                )),
            })
            .collect()
    }
}
pub fn text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| "ONNX text is not UTF-8; supply a valid model".into())
}

#[derive(Clone, Debug)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}
impl Json {
    pub fn field(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(v) => v.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn string(&self) -> Result<&str> {
        match self {
            Self::Str(v) => Ok(v),
            _ => Err("operator attribute must be a string; check its ONNX type".into()),
        }
    }
    pub fn list(&self) -> Result<&[Self]> {
        match self {
            Self::Array(v) => Ok(v),
            _ => Err("operator attribute must be a list; check its ONNX type".into()),
        }
    }
    pub fn integer(&self) -> Result<i64> {
        match self {
            Self::Str(v) => v
                .parse()
                .map_err(|_| "integer attribute is outside int64; use an integer value".into()),
            Self::Num(v) if v.is_finite() && v.fract() == 0. && v.abs() <= 9007199254740991. => {
                Ok(*v as i64)
            }
            _ => Err("operator attribute must be an integer; check its ONNX type".into()),
        }
    }
    pub fn number(&self) -> Result<f64> {
        match self {
            Self::Num(v) => Ok(*v),
            Self::Str(v) => match v.as_str() {
                "NaN" => Ok(f64::NAN),
                "Infinity" => Ok(f64::INFINITY),
                "-Infinity" => Ok(f64::NEG_INFINITY),
                _ => v
                    .parse()
                    .map_err(|_| "operator attribute must be numeric; check its ONNX type".into()),
            },
            _ => Err("operator attribute must be numeric; check its ONNX type".into()),
        }
    }
    pub fn s(s: impl Into<String>) -> Self {
        Self::Str(s.into())
    }
    pub fn n(n: usize) -> Self {
        Self::Num(n as f64)
    }
    pub fn object(items: impl IntoIterator<Item = (&'static str, Json)>) -> Self {
        Self::Object(items.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }
    pub fn strings(items: impl IntoIterator<Item = String>) -> Self {
        Self::Array(items.into_iter().map(Self::Str).collect())
    }
    pub fn encode(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }
    fn write(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
            Self::Num(n) => {
                if n.is_finite() {
                    out.push_str(&n.to_string());
                } else {
                    quote(
                        out,
                        if n.is_nan() {
                            "NaN"
                        } else if n.is_sign_negative() {
                            "-Infinity"
                        } else {
                            "Infinity"
                        },
                    );
                }
            }
            Self::Str(s) => quote(out, s),
            Self::Array(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            Self::Object(a) => {
                out.push('{');
                for (i, (k, v)) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    quote(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}
fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 32 => out.push_str(&format!("\\u{:04x}", c as u32)),
            _ => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_and_signed_varints() {
        let negative = [255, 255, 255, 255, 255, 255, 255, 255, 255, 1];
        assert_eq!(varint(&negative, &mut 0).unwrap() as i64, -1);
        assert!(varint(&[255; 10], &mut 0).is_err());
        assert!(Message::parse(&[10, 3, 1, 2]).is_err());
        assert!(Message::parse(&[0]).is_err());
    }
    #[test]
    fn packed_unpacked_and_unknown_group() {
        let m = Message::parse(&[8, 1, 10, 2, 2, 3, 19, 8, 6, 20, 8, 4]).unwrap();
        assert_eq!(m.integers(1).unwrap(), [1, 2, 3, 4]);
        assert_eq!(m.uint(1, 0).unwrap(), 4);
        assert!(Message::parse(&[19, 28]).is_err());
    }
    #[test]
    fn json_preserves_integers_as_text_and_escapes() {
        let j = Json::object([
            ("i", Json::s("9007199254740993")),
            ("s", Json::s("a\n\u{1}\"\\é")),
        ]);
        assert_eq!(
            j.encode(),
            "{\"i\":\"9007199254740993\",\"s\":\"a\\n\\u0001\\\"\\\\é\"}"
        );
    }
}
