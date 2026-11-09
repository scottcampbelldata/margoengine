//! E15: KD-tree rules established by recorded crafted black-box outputs.
//! No implementation source was used. See docs/clean-room.md and the ledger.
use crate::{
    Budget, Error, Geometry, Limits, Result,
    cursor::Cursor,
    edgebreaker::Binary,
    sequential::{descriptor, scalar_bytes},
};

struct Raw<'a> {
    data: &'a [u8],
    at: usize,
}
impl<'a> Raw<'a> {
    fn new(c: &mut Cursor<'a>) -> Result<Self> {
        let size = c.le(4)? as usize;
        let data = c.take(size)?;
        if size == 0 {
            return Err(Error::Invalid);
        }
        Ok(Self { data, at: 0 })
    }
    fn read(&mut self, width: u32) -> Result<u32> {
        if width > 32 {
            return Err(Error::Invalid);
        }
        let end = self.at.checked_add(width as usize).ok_or(Error::Overflow)?;
        if end > self.data.len().checked_mul(8).ok_or(Error::Overflow)? {
            return Err(Error::Truncated);
        }
        let mut left = width;
        let mut value = 0_u64;
        while left > 0 {
            let start = self.at / 32 * 4;
            let word = self.data.get(start..start + 4).ok_or(Error::Truncated)?;
            let word = u32::from_le_bytes(word.try_into().map_err(|_| Error::Invalid)?);
            let offset = self.at as u32 % 32;
            let take = left.min(32 - offset);
            value = (value << take)
                | u64::from((word >> (32 - offset - take)) & (u32::MAX >> (32 - take)));
            self.at += take as usize;
            left -= take;
        }
        Ok(value as u32)
    }
}
enum Numbers<'a> {
    Raw(Raw<'a>),
    Binary(Binary<'a>),
    Folded(Vec<Binary<'a>>),
}
impl<'a> Numbers<'a> {
    fn new(c: &mut Cursor<'a>, level: u8, budget: &mut Budget) -> Result<Self> {
        Ok(if level < 2 {
            Self::Raw(Raw::new(c)?)
        } else if level < 4 {
            Self::Binary(Binary::read(c)?)
        } else {
            budget.charge(33, std::mem::size_of::<Binary>())?;
            let mut planes = Vec::new();
            planes.try_reserve_exact(33).map_err(|_| Error::Limit)?;
            for _ in 0..33 {
                planes.push(Binary::read(c)?);
            }
            Self::Folded(planes)
        })
    }
    fn read(&mut self, width: u32) -> Result<u32> {
        match self {
            Self::Raw(raw) => raw.read(width),
            Self::Binary(binary) => {
                let mut n = 0;
                for _ in 0..width {
                    n = (n << 1) | u32::from(binary.bit()?);
                }
                Ok(n)
            }
            Self::Folded(planes) => {
                let mut n = 0;
                for binary in &mut planes[..width as usize] {
                    n = (n << 1) | u32::from(binary.bit()?);
                }
                Ok(n)
            }
        }
    }
}
#[derive(Clone, Copy)]
struct Frame {
    low: usize,
    axis: usize,
    base: u32,
    width: u32,
    pending: bool,
}
#[derive(Clone)]
enum Transform {
    Unsigned,
    Signed([i32; 16]),
    Quantized([f32; 16], f32),
}

fn tree(c: &mut Cursor, points: usize, dimensions: usize, budget: &mut Budget) -> Result<Vec<u32>> {
    let level = c.byte()?;
    if level > 6 {
        return Err(Error::Unsupported);
    }
    let bits = c.le(4)?;
    if bits > 32 {
        return Err(Error::Invalid);
    }
    if c.le(4)? as usize != points {
        return Err(Error::Invalid);
    }
    if points == 0 {
        return Ok(Vec::new());
    }
    if dimensions == 0 {
        return Err(Error::Invalid);
    }
    let mut numbers = Numbers::new(c, level, budget)?;
    let mut remaining = Raw::new(c)?;
    let mut axes = Raw::new(c)?;
    let mut halves = Raw::new(c)?;
    let mut base = budget.vector(dimensions, 0_u32)?;
    let mut widths = budget.vector(dimensions, bits)?;
    let count = points.checked_mul(dimensions).ok_or(Error::Overflow)?;
    let mut values = budget.vector(count, 0_u32)?;
    let max_depth = dimensions
        .checked_mul(bits as usize)
        .ok_or(Error::Overflow)?;
    budget.charge(max_depth, std::mem::size_of::<Frame>())?;
    let mut stack = Vec::<Frame>::new();
    stack
        .try_reserve_exact(max_depth)
        .map_err(|_| Error::Limit)?;
    let mut n = points;
    let mut last = 0;
    let mut output = 0;
    loop {
        budget.steps(dimensions)?;
        if n != 0 {
            let axis = if level < 6 {
                (last + 1) % dimensions
            } else if n >= 64 {
                axes.read(4)? as usize
            } else {
                let mut best = 0;
                for i in 1..dimensions {
                    if widths[i] > widths[best] {
                        best = i;
                    }
                }
                best
            };
            if axis >= dimensions {
                return Err(Error::Invalid);
            }
            let exhausted = widths.iter().all(|&width| width == 0);
            if exhausted || n <= 2 {
                budget.steps(n.checked_mul(dimensions).ok_or(Error::Overflow)?)?;
                for _ in 0..n {
                    for j in 0..dimensions {
                        let k = (axis + j) % dimensions;
                        values[output + k] = base[k]
                            .checked_add(if exhausted {
                                0
                            } else {
                                remaining.read(widths[k])?
                            })
                            .ok_or(Error::Overflow)?;
                    }
                    output = output.checked_add(dimensions).ok_or(Error::Overflow)?;
                }
            } else if widths[axis] == 0 {
                last = axis;
                continue;
            } else {
                let width = usize::BITS - n.leading_zeros() - 1;
                let small = (n / 2)
                    .checked_sub(numbers.read(width)? as usize)
                    .ok_or(Error::Invalid)?;
                let (mut low, mut high) = (n - small, small);
                if low != high && halves.read(1)? != 0 {
                    std::mem::swap(&mut low, &mut high);
                }
                if stack.len() >= max_depth {
                    return Err(Error::Invalid);
                }
                stack.push(Frame {
                    low,
                    axis,
                    base: base[axis],
                    width: widths[axis],
                    pending: true,
                });
                widths[axis] -= 1;
                base[axis] = base[axis]
                    .checked_add(1_u32 << widths[axis])
                    .ok_or(Error::Overflow)?;
                n = high;
                last = axis;
                continue;
            }
        }
        loop {
            let Some(mut frame) = stack.pop() else {
                if output != count {
                    return Err(Error::Invalid);
                }
                return Ok(values);
            };
            base[frame.axis] = frame.base;
            widths[frame.axis] = frame.width;
            if frame.pending {
                frame.pending = false;
                widths[frame.axis] -= 1;
                n = frame.low;
                last = frame.axis;
                stack.push(frame);
                break;
            }
        }
    }
}

pub(crate) fn decode(c: &mut Cursor, limits: Limits, budget: &mut Budget) -> Result<Geometry> {
    if c.version != 0x203 {
        return Err(Error::Unsupported);
    }
    let points = c.le(4)? as usize;
    if points > limits.vertices {
        return Err(Error::Limit);
    }
    if c.byte()? != 1 {
        return Err(Error::Unsupported);
    }
    let count = c.count()?;
    if count > (c.data.len() - c.at) / 5 {
        return Err(Error::Truncated);
    }
    budget.charge(count, std::mem::size_of::<crate::Attribute>())?;
    let mut attributes = Vec::new();
    attributes
        .try_reserve_exact(count)
        .map_err(|_| Error::Limit)?;
    let mut dimensions = 0_usize;
    let mut output_bytes = 0_usize;
    for _ in 0..count {
        let attr = descriptor(c)?;
        if ![1, 2, 3, 4, 5, 6, 9].contains(&attr.data_type) {
            return Err(Error::Unsupported);
        }
        dimensions = dimensions
            .checked_add(usize::from(attr.components))
            .ok_or(Error::Overflow)?;
        let size = points
            .checked_mul(usize::from(attr.components))
            .and_then(|n| n.checked_mul(scalar_bytes(attr.data_type).ok()?))
            .ok_or(Error::Overflow)?;
        output_bytes = output_bytes.checked_add(size).ok_or(Error::Overflow)?;
        if output_bytes > limits.bytes {
            return Err(Error::Limit);
        }
        attributes.push(attr);
    }
    let mut ids = budget.vector(count, 0_u32)?;
    for (id, attr) in ids.iter_mut().zip(&attributes) {
        *id = attr.unique_id;
    }
    budget.steps(count.saturating_mul(count.max(1).ilog2() as usize + 1))?;
    ids.sort_unstable();
    if ids.windows(2).any(|p| p[0] == p[1]) {
        return Err(Error::Invalid);
    }
    let values = tree(c, points, dimensions, budget)?;
    let mut transforms = budget.vector(count, Transform::Unsigned)?;
    // E15 mixed-type canaries: all floating transforms precede all signed minima.
    for (attr, transform) in attributes.iter().zip(&mut transforms) {
        let components = usize::from(attr.components);
        if attr.data_type == 9 {
            let mut minima = [0_f32; 16];
            for min in &mut minima[..components] {
                *min = c.float()?;
            }
            let range = c.float()?;
            let bits = c.byte()?;
            if !(1..=30).contains(&bits)
                || range < 0.0
                || !range.is_finite()
                || minima.iter().any(|v| !v.is_finite())
            {
                return Err(Error::Invalid);
            }
            *transform = Transform::Quantized(minima, range / ((1_u32 << bits) - 1) as f32);
        }
    }
    for (attr, transform) in attributes.iter().zip(&mut transforms) {
        if [1, 3, 5].contains(&attr.data_type) {
            let mut minima = [0_i32; 16];
            for min in &mut minima[..usize::from(attr.components)] {
                let symbol = c.count()? as u32;
                *min = ((symbol >> 1) as i32) ^ -((symbol & 1) as i32);
            }
            *transform = Transform::Signed(minima);
        }
    }
    let mut offset = 0;
    for (attr, transform) in attributes.iter_mut().zip(transforms) {
        let components = usize::from(attr.components);
        let width = scalar_bytes(attr.data_type)?;
        let size = points
            .checked_mul(components)
            .and_then(|n| n.checked_mul(width))
            .ok_or(Error::Overflow)?;
        attr.data = budget.vector(size, 0_u8)?;
        budget.steps(points.checked_mul(components).ok_or(Error::Overflow)?)?;
        for (point, row) in attr.data.chunks_exact_mut(components * width).enumerate() {
            for (k, chunk) in row.chunks_exact_mut(width).enumerate() {
                let value = values[point * dimensions + offset + k];
                match &transform {
                    Transform::Quantized(minima, factor) => {
                        let scaled = value as f32 * factor;
                        chunk.copy_from_slice(&(scaled + minima[k]).to_le_bytes());
                    }
                    Transform::Signed(minima) => chunk.copy_from_slice(
                        &value.wrapping_add(minima[k] as u32).to_le_bytes()[..width],
                    ),
                    Transform::Unsigned => chunk.copy_from_slice(&value.to_le_bytes()[..width]),
                }
            }
        }
        offset += components;
    }
    Ok(Geometry {
        points,
        mesh: false,
        indices: Vec::new(),
        attributes,
        metadata: None,
    })
}
