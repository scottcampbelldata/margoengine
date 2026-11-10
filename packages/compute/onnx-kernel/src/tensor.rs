// ONNX's normative tensor type/row-major storage specification, implemented here
// without generated bindings or an external numeric/runtime dependency.
use std::sync::Arc;

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_ELEMENTS: usize = 16_777_216;

#[derive(Clone, Copy, Debug)]
pub enum Number {
    F(f64),
    I(i64),
    U(u64),
}
impl Number {
    pub fn f(self) -> f64 {
        match self {
            Self::F(x) => x,
            Self::I(x) => x as f64,
            Self::U(x) => x as f64,
        }
    }
    pub fn i(self) -> i64 {
        match self {
            Self::F(x) => x as i64,
            Self::I(x) => x,
            Self::U(x) => x as i64,
        }
    }
    pub fn u(self) -> u64 {
        match self {
            Self::F(x) => x as u64,
            Self::I(x) => x as u64,
            Self::U(x) => x,
        }
    }
    pub fn nonzero(self) -> bool {
        match self {
            Self::F(x) => x != 0.,
            Self::I(x) => x != 0,
            Self::U(x) => x != 0,
        }
    }
    pub fn add(self, b: Self) -> Self {
        match self {
            Self::I(x) => Self::I(x.wrapping_add(b.i())),
            Self::U(x) => Self::U(x.wrapping_add(b.u())),
            Self::F(x) => Self::F(x + b.f()),
        }
    }
    pub fn sub(self, b: Self) -> Self {
        match self {
            Self::I(x) => Self::I(x.wrapping_sub(b.i())),
            Self::U(x) => Self::U(x.wrapping_sub(b.u())),
            Self::F(x) => Self::F(x - b.f()),
        }
    }
    pub fn mul(self, b: Self) -> Self {
        match self {
            Self::I(x) => Self::I(x.wrapping_mul(b.i())),
            Self::U(x) => Self::U(x.wrapping_mul(b.u())),
            Self::F(x) => Self::F(x * b.f()),
        }
    }
    pub fn cmp(self, b: Self) -> Option<std::cmp::Ordering> {
        match self {
            Self::I(x) => Some(x.cmp(&b.i())),
            Self::U(x) => Some(x.cmp(&b.u())),
            Self::F(x) => x.partial_cmp(&b.f()),
        }
    }
}

pub fn elements(shape: &[usize]) -> Result<usize> {
    if shape.iter().any(|&d| d > i32::MAX as usize) {
        return Err("tensor dimensions exceed 2147483647; use supported dimensions".into());
    }
    let size = product(shape)?;
    if size > MAX_ELEMENTS {
        return Err(format!(
            "tensor has {size} elements, over {MAX_ELEMENTS}; use smaller inputs"
        ));
    }
    Ok(size)
}
pub fn product(shape: &[usize]) -> Result<usize> {
    if shape.contains(&0) {
        return Ok(0);
    }
    let mut size = 1usize;
    for &d in shape {
        size = size
            .checked_mul(d)
            .ok_or("tensor dimensions overflow; use smaller dimensions")?;
    }
    Ok(size)
}
pub fn width(kind: u32) -> Result<usize> {
    match kind {1|6|12=>Ok(4),2|3|9=>Ok(1),4|5|10|16=>Ok(2),7|11|13=>Ok(8),21|22=>Ok(0),8=>Ok(1),_=>Err(format!("tensor element type {kind} is not in the supported ONNX numeric/string profile; cast it to a supported type"))}
}
pub fn byte_len(kind: u32, n: usize) -> Result<usize> {
    let w = width(kind)?;
    Ok(if w == 0 { n.div_ceil(2) } else { n * w })
}

#[derive(Clone, Debug)]
pub struct Tensor {
    pub kind: u32,
    pub shape: Vec<usize>,
    pub data: Arc<Vec<u8>>,
    pub strings: Option<Arc<Vec<Vec<u8>>>>,
}
impl Tensor {
    pub fn raw(kind: u32, shape: Vec<usize>, data: Vec<u8>) -> Result<Self> {
        let n = elements(&shape)?;
        if kind == 8 {
            return Err("string tensors need length-delimited strings; use string storage".into());
        }
        let expected = byte_len(kind, n)?;
        if data.len() != expected {
            return Err(format!(
                "tensor data has {} bytes, expected {expected}; check the tensor shape/type",
                data.len()
            ));
        }
        if kind == 9 && data.iter().any(|&v| v > 1) {
            return Err(
                "bool tensor raw storage must contain only 0 or 1; repair the boolean payload"
                    .into(),
            );
        }
        Ok(Self {
            kind,
            shape,
            data: Arc::new(data),
            strings: None,
        })
    }
    pub fn text(shape: Vec<usize>, values: Vec<Vec<u8>>) -> Result<Self> {
        if values.len() != elements(&shape)? {
            return Err(
                "string tensor data count differs from its shape; supply one string per element"
                    .into(),
            );
        }
        Ok(Self {
            kind: 8,
            shape,
            data: Arc::new(vec![]),
            strings: Some(Arc::new(values)),
        })
    }
    pub fn zeros(kind: u32, shape: Vec<usize>) -> Result<Self> {
        let n = elements(&shape)?;
        if kind == 8 {
            Self::text(shape, vec![vec![]; n])
        } else {
            Self::raw(kind, shape, vec![0; byte_len(kind, n)?])
        }
    }
    pub fn size(&self) -> usize {
        if self.shape.contains(&0) {
            0
        } else {
            self.shape.iter().product()
        }
    }
    pub fn bytes(&self) -> usize {
        self.data.len()
            + self
                .strings
                .as_ref()
                .map_or(0, |s| s.iter().map(Vec::len).sum())
    }
    pub fn reshape(&self, shape: Vec<usize>) -> Result<Self> {
        if elements(&shape)? != self.size() {
            return Err("reshape changes tensor element count; supply a compatible shape".into());
        }
        let mut t = self.clone();
        t.shape = shape;
        Ok(t)
    }
    pub fn get(&self, i: usize) -> Number {
        let d = &self.data;
        match self.kind {
            1 => Number::F(f32::from_le_bytes(d[i * 4..i * 4 + 4].try_into().unwrap()) as f64),
            2 => Number::U(d[i] as u64),
            3 => Number::I(d[i] as i8 as i64),
            4 => Number::U(u16::from_le_bytes(d[i * 2..i * 2 + 2].try_into().unwrap()) as u64),
            5 => Number::I(i16::from_le_bytes(d[i * 2..i * 2 + 2].try_into().unwrap()) as i64),
            6 => Number::I(i32::from_le_bytes(d[i * 4..i * 4 + 4].try_into().unwrap()) as i64),
            7 => Number::I(i64::from_le_bytes(d[i * 8..i * 8 + 8].try_into().unwrap())),
            9 => Number::U((d[i] != 0) as u64),
            10 => Number::F(half(u16::from_le_bytes(
                d[i * 2..i * 2 + 2].try_into().unwrap(),
            ))),
            11 => Number::F(f64::from_le_bytes(d[i * 8..i * 8 + 8].try_into().unwrap())),
            12 => Number::U(u32::from_le_bytes(d[i * 4..i * 4 + 4].try_into().unwrap()) as u64),
            13 => Number::U(u64::from_le_bytes(d[i * 8..i * 8 + 8].try_into().unwrap())),
            16 => Number::F(f32::from_bits(
                (u16::from_le_bytes(d[i * 2..i * 2 + 2].try_into().unwrap()) as u32) << 16,
            ) as f64),
            21 => Number::U(((d[i / 2] >> ((i % 2) * 4)) & 15) as u64),
            22 => Number::I(((((d[i / 2] >> ((i % 2) * 4)) & 15) as i8) << 4 >> 4) as i64),
            _ => unreachable!("numeric access of a validated string tensor"),
        }
    }
    pub fn set(&mut self, i: usize, x: Number) {
        let d = Arc::make_mut(&mut self.data);
        match self.kind {
            1 => d[i * 4..i * 4 + 4].copy_from_slice(&(x.f() as f32).to_le_bytes()),
            2 | 3 => d[i] = x.i() as u8,
            4 | 5 => d[i * 2..i * 2 + 2].copy_from_slice(&(x.i() as u16).to_le_bytes()),
            6 => d[i * 4..i * 4 + 4].copy_from_slice(&(x.i() as i32).to_le_bytes()),
            7 => d[i * 8..i * 8 + 8].copy_from_slice(&x.i().to_le_bytes()),
            9 => d[i] = x.nonzero() as u8,
            10 => d[i * 2..i * 2 + 2].copy_from_slice(&to_half(x.f()).to_le_bytes()),
            11 => d[i * 8..i * 8 + 8].copy_from_slice(&x.f().to_le_bytes()),
            12 => d[i * 4..i * 4 + 4].copy_from_slice(&(x.u() as u32).to_le_bytes()),
            13 => d[i * 8..i * 8 + 8].copy_from_slice(&x.u().to_le_bytes()),
            16 => d[i * 2..i * 2 + 2].copy_from_slice(&to_bfloat(x.f()).to_le_bytes()),
            21 | 22 => {
                let shift = (i % 2) * 4;
                d[i / 2] = (d[i / 2] & !(15 << shift)) | ((x.i() as u8 & 15) << shift);
            }
            _ => unreachable!("numeric write to a validated string tensor"),
        }
    }
    pub fn copy_element(&mut self, to: usize, source: &Self, from: usize) {
        if self.kind == 8 {
            Arc::make_mut(self.strings.as_mut().unwrap())[to] =
                source.strings.as_ref().unwrap()[from].clone();
        } else if self.kind == source.kind && !matches!(self.kind, 21 | 22) {
            let w = width(self.kind).unwrap();
            Arc::make_mut(&mut self.data)[to * w..(to + 1) * w]
                .copy_from_slice(&source.data[from * w..(from + 1) * w]);
        } else {
            self.set(to, source.get(from));
        }
    }
    pub fn vector_i64(values: &[i64]) -> Result<Self> {
        let mut t = Self::zeros(7, vec![values.len()])?;
        for (i, &x) in values.iter().enumerate() {
            t.set(i, Number::I(x));
        }
        Ok(t)
    }
    pub fn numeric(&self) -> Result<()> {
        if self.kind == 8 {
            Err("operator needs a numeric tensor; cast string values first".into())
        } else {
            Ok(())
        }
    }
    pub fn ints(&self) -> Result<Vec<i64>> {
        if !matches!(self.kind, 6 | 7 | 12 | 13) {
            return Err("shape/index input must be an integer tensor; use Cast".into());
        }
        Ok((0..self.size()).map(|i| self.get(i).i()).collect())
    }
}

pub fn half(bits: u16) -> f64 {
    let sign = if bits & 0x8000 != 0 { -1. } else { 1. };
    let e = (bits >> 10) & 31;
    let m = bits & 1023;
    if e == 31 {
        return if m == 0 {
            sign * f64::INFINITY
        } else {
            f64::NAN
        };
    }
    sign * if e == 0 {
        (m as f64) * 2f64.powi(-24)
    } else {
        (1. + m as f64 / 1024.) * 2f64.powi(e as i32 - 15)
    }
}
fn encode_float(x: f64, mant: u32, bias: i32) -> u16 {
    let sign = if x.is_sign_negative() { 0x8000 } else { 0 };
    let a = x.abs();
    let exp_bits = 15 - mant;
    let max_exp = (1u32 << exp_bits) - 1;
    if a.is_nan() {
        return sign | ((max_exp << mant) as u16) | (1u16 << (mant - 1));
    }
    if a.is_infinite() {
        return sign | ((max_exp << mant) as u16);
    }
    if a == 0. {
        return sign;
    }
    let e = a.log2().floor() as i32;
    if e < 1 - bias {
        let m = (a * 2f64.powi(bias - 1 + mant as i32)).round_ties_even();
        return sign | m as u16;
    }
    if e + bias >= max_exp as i32 {
        return sign | ((max_exp << mant) as u16);
    }
    let m = ((a / 2f64.powi(e) - 1.) * ((1u32 << mant) as f64)).round_ties_even() as u32;
    sign | (((e + bias) as u32 * (1u32 << mant) + m) as u16)
}
pub fn to_half(x: f64) -> u16 {
    encode_float(x, 10, 15)
}
pub fn to_bfloat(x: f64) -> u16 {
    encode_float(x, 7, 127)
}

pub fn strides(shape: &[usize]) -> Vec<usize> {
    let mut out = vec![1; shape.len()];
    let mut s = 1usize;
    for k in (0..shape.len()).rev() {
        out[k] = s;
        s = s.saturating_mul(shape[k]);
    }
    out
}
pub fn axis(axis: i64, rank: usize) -> Result<usize> {
    let a = if axis < 0 { axis + rank as i64 } else { axis };
    if a < 0 || a >= rank as i64 {
        Err(format!(
            "axis {axis} is outside rank {rank}; choose a valid axis"
        ))
    } else {
        Ok(a as usize)
    }
}
pub fn broadcast(a: &[usize], b: &[usize]) -> Result<Vec<usize>> {
    let rank = a.len().max(b.len());
    let mut s = vec![1; rank];
    for k in 0..rank {
        let x = if k + a.len() >= rank {
            a[k + a.len() - rank]
        } else {
            1
        };
        let y = if k + b.len() >= rank {
            b[k + b.len() - rank]
        } else {
            1
        };
        if x != y && x != 1 && y != 1 {
            return Err("input dimensions cannot broadcast; use equal dimensions or 1".into());
        }
        s[k] = if x == 1 { y } else { x };
    }
    elements(&s)?;
    Ok(s)
}
pub fn broadcast_index(mut i: usize, shape: &[usize], own: &[usize]) -> usize {
    let rank = shape.len();
    let mut at = 0;
    let mut step = 1;
    for k in (0..rank).rev() {
        let c = i % shape[k];
        i /= shape[k];
        if k + own.len() >= rank {
            let d = own[k + own.len() - rank];
            if d != 1 {
                at += c * step;
            }
            step *= d;
        }
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_integer_storage() {
        assert!(Tensor::raw(9, vec![1], vec![2]).is_err());
        for kind in [7, 13] {
            let mut t = Tensor::zeros(kind, vec![3]).unwrap();
            for (i, x) in [0, 9007199254740993u64, u64::MAX].iter().enumerate() {
                t.set(i, Number::U(*x));
                assert_eq!(t.get(i).u(), *x);
            }
        }
    }
    #[test]
    fn all_half_roundtrips() {
        for bits in 0..=65535u16 {
            let v = half(bits);
            if !v.is_nan() {
                assert_eq!(to_half(v), bits);
            }
        }
        assert_eq!(to_half(65519.), 0x7bff);
        assert_eq!(to_half(65520.), 0x7c00);
        assert_eq!(to_half(2f64.powi(-25)), 0);
        assert_eq!(to_half(2f64.powi(-25) + 2f64.powi(-70)), 1);
    }
    #[test]
    fn packed_signed_nibbles() {
        let mut t = Tensor::zeros(22, vec![5]).unwrap();
        for (i, x) in [-8, -1, 0, 3, 7].iter().enumerate() {
            t.set(i, Number::I(*x));
        }
        assert_eq!(&*t.data, &[0xf8, 0x30, 0x07]);
        assert_eq!(
            (0..5).map(|i| t.get(i).i()).collect::<Vec<_>>(),
            [-8, -1, 0, 3, 7]
        );
    }
}
