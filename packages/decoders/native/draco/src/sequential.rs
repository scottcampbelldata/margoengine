use crate::{Budget, Error, Limits, Result, cursor::Cursor, entropy};

#[derive(Debug, PartialEq, Eq)]
pub struct Attribute {
    pub semantic: u8,
    pub data_type: u8,
    pub components: u8,
    pub normalized: bool,
    pub unique_id: u32,
    pub data: Vec<u8>,
    encoding: u8,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Geometry {
    pub points: usize,
    pub mesh: bool,
    pub indices: Vec<u32>,
    pub attributes: Vec<Attribute>,
    pub metadata: Option<crate::Metadata>,
}
enum Format {
    Raw,
    Integer,
    Quantized { minima: Vec<f32>, factor: f32 },
    Normal(u8),
}
fn read_format(c: &mut Cursor, attr: &Attribute, budget: &mut Budget) -> Result<Format> {
    Ok(match attr.encoding {
        0 => Format::Raw,
        1 => {
            if attr.data_type > 6 {
                return Err(Error::Invalid);
            }
            Format::Integer
        }
        2 => {
            if attr.data_type != 9 {
                return Err(Error::Invalid);
            }
            let mut minima = budget.vector(usize::from(attr.components), 0_f32)?;
            for min in &mut minima[..usize::from(attr.components)] {
                *min = c.float()?;
            }
            let range = c.float()?;
            let bits = c.byte()?;
            if !(1..=30).contains(&bits)
                || !range.is_finite()
                || range < 0.0
                || minima.iter().any(|f| !f.is_finite())
            {
                return Err(Error::Invalid);
            }
            Format::Quantized {
                minima,
                factor: range / ((1_u32 << bits) - 1) as f32,
            }
        }
        3 => {
            if attr.components != 3 || attr.data_type != 9 {
                return Err(Error::Invalid);
            }
            Format::Normal(c.byte()?)
        }
        _ => return Err(Error::Invalid),
    })
}
struct PortableGroup {
    first: usize,
    last: usize,
    sequence: Option<crate::traversal::Sequence>,
}
pub(crate) fn scalar_bytes(ty: u8) -> Result<usize> {
    match ty {
        1 | 2 | 11 => Ok(1),
        3 | 4 => Ok(2),
        5 | 6 | 9 => Ok(4),
        7 | 8 | 10 => Ok(8),
        _ => Err(Error::Invalid),
    }
}
pub(crate) fn descriptor(c: &mut Cursor) -> Result<Attribute> {
    let semantic = c.byte()?;
    let data_type = c.byte()?;
    let components = c.byte()?;
    let normalized = c.byte()?;
    let unique_id = if c.version < 0x200 {
        c.le(2)?
    } else {
        c.count()? as u32
    };
    if semantic > 4 || components == 0 || normalized > 1 {
        return Err(Error::Invalid);
    }
    scalar_bytes(data_type)?;
    Ok(Attribute {
        semantic,
        data_type,
        components,
        normalized: normalized != 0,
        unique_id,
        data: Vec::new(),
        encoding: 0,
    })
}
pub fn decode(bytes: &[u8], limits: Limits) -> Result<Geometry> {
    decode_flavor(bytes, limits, false)
}

/// Preserve the shipped glTF build's observed predictor-2 fallback.
/// All other framing and reconstruction is shared with the full decoder.
pub fn decode_gltf(bytes: &[u8], limits: Limits) -> Result<Geometry> {
    decode_flavor(bytes, limits, true)
}

fn decode_flavor(bytes: &[u8], limits: Limits, gltf_compat: bool) -> Result<Geometry> {
    if bytes.len() > 256 * 1024 * 1024 {
        return Err(Error::Limit);
    }
    let mut c = Cursor::new(bytes);
    if c.take(5)? != b"DRACO" {
        return Err(Error::Header);
    }
    let major = c.byte()?;
    let minor = c.byte()?;
    let kind = c.byte()?;
    let method = c.byte()?;
    let flags = c.le(2)?;
    if kind > 1 {
        return Err(Error::Header);
    }
    if !((major == 1 && minor <= 2) || (major == 2 && minor <= if kind == 0 { 3 } else { 2 })) {
        return Err(Error::Unsupported);
    }
    c.version = u16::from(major) * 256 + u16::from(minor);
    if flags & !32768 != 0 {
        return Err(Error::Invalid);
    }
    let mut budget = Budget::new(256 * 1024 * 1024);
    let metadata = if flags & 32768 != 0 {
        Some(crate::Metadata::read(&mut c, &mut budget)?)
    } else {
        None
    };
    let mesh = kind == 1;
    if !mesh && method == 1 {
        let mut geometry = crate::kd::decode(&mut c, limits, &mut budget)?;
        geometry.metadata = metadata;
        return Ok(geometry);
    }
    let mut topology = if mesh && method == 1 {
        Some(crate::edgebreaker::decode(&mut c, limits, &mut budget)?)
    } else if method == 0 {
        None
    } else {
        return Err(Error::Unsupported);
    };
    let mapping = if let Some(topo) = &mut topology {
        Some(topo.mapping(&mut budget)?)
    } else {
        None
    };
    let faces = if let Some(topo) = &topology {
        topo.corners.len() / 3
    } else if mesh {
        if c.version < 0x202 {
            c.le(4)? as usize
        } else {
            c.count()?
        }
    } else {
        0
    };
    // E14: point-cloud sequential counts are fixed UI32, not varUI32.
    let points = if let Some(mapping) = &mapping {
        mapping.points
    } else if mesh {
        if c.version < 0x202 {
            c.le(4)? as usize
        } else {
            c.count()?
        }
    } else {
        c.le(4)? as usize
    };
    if points > limits.vertices.min(16_777_216) {
        return Err(Error::Limit);
    }
    let nindices = faces.checked_mul(3).ok_or(Error::Overflow)?;
    if nindices > limits.indices {
        return Err(Error::Limit);
    }
    let mut indices = budget.vector(nindices, 0_u32)?;
    budget.steps(nindices)?;
    if let Some(mapping) = &mapping {
        for (out, &index) in indices.iter_mut().zip(&mapping.corner_to_point) {
            *out = u32::try_from(index).map_err(|_| Error::Overflow)?;
        }
    } else if mesh {
        match c.byte()? {
            0 => {
                let symbols = entropy::symbols(&mut c, nindices, 1, &mut budget)?;
                let mut previous = 0_i64;
                for (dst, symbol) in indices.iter_mut().zip(symbols) {
                    let magnitude = i64::from(symbol >> 1);
                    previous += if symbol & 1 == 1 {
                        -magnitude
                    } else {
                        magnitude
                    };
                    *dst = u32::try_from(previous).map_err(|_| Error::Invalid)?;
                }
            }
            1 => {
                for dst in &mut indices {
                    *dst = if points < 256 {
                        c.le(1)?
                    } else if points < 65536 {
                        c.le(2)?
                    } else if points < 1 << 21 {
                        c.count()? as u32
                    } else {
                        c.le(4)?
                    };
                }
            }
            _ => return Err(Error::Invalid),
        }
        if indices.iter().any(|v| *v as usize >= points) {
            return Err(Error::Invalid);
        }
    }
    let groups = usize::from(c.byte()?);
    let mut group_info = budget.vector(groups, crate::traversal::Group::default())?;
    if topology.is_some() {
        for group in &mut group_info {
            group.data_id = c.byte()?;
            group.corner = match c.byte()? {
                0 => false,
                1 => true,
                _ => return Err(Error::Invalid),
            };
            group.degree = match if c.version < 0x102 { 0 } else { c.byte()? } {
                0 => false,
                1 => true,
                _ => return Err(Error::Invalid),
            };
        }
    }
    let mut attributes = Vec::new();
    let mut unique_ids = Vec::new();
    let mut ranges = budget.vector(groups, (0_usize, 0_usize))?;
    for range in &mut ranges {
        let n = if c.version < 0x200 {
            c.le(4)? as usize
        } else {
            c.count()?
        };
        if n > (c.data.len() - c.at) / 6 {
            return Err(Error::Truncated);
        }
        budget.charge(n, std::mem::size_of::<Attribute>())?;
        budget.charge(n, 4)?;
        unique_ids.try_reserve_exact(n).map_err(|_| Error::Limit)?;
        attributes.try_reserve_exact(n).map_err(|_| Error::Limit)?;
        let first = attributes.len();
        for _ in 0..n {
            let attribute = descriptor(&mut c)?;
            unique_ids.push(attribute.unique_id);
            attributes.push(attribute);
        }
        for attr in &mut attributes[first..] {
            attr.encoding = c.byte()?;
            if attr.encoding > 3 {
                return Err(Error::Invalid);
            }
        }
        *range = (first, first + n);
    }
    budget.steps(
        unique_ids
            .len()
            .saturating_mul(unique_ids.len().max(1).ilog2() as usize + 1),
    )?;
    unique_ids.sort_unstable();
    if c.version >= 0x200 && unique_ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Error::Invalid);
    }
    let mut output_bytes = nindices
        .checked_mul(if points < 65536 { 2 } else { 4 })
        .ok_or(Error::Overflow)?;
    let mut integers = Vec::new();
    let mut formats = Vec::new();
    for _ in &attributes {
        integers.push(None);
        formats.push(Format::Raw);
    }
    let mut portable_groups = Vec::new();
    for (group, (first, last)) in ranges.into_iter().enumerate() {
        let sequence = if let (Some(topo), Some(mapping)) = (&topology, &mapping) {
            Some(crate::traversal::sequence(
                topo,
                mapping,
                group_info[group],
                &mut budget,
            )?)
        } else {
            None
        };
        let entries = sequence.as_ref().map_or(points, |s| s.entry_corner.len());
        for (index, attr) in attributes.iter_mut().enumerate().take(last).skip(first) {
            let components = usize::from(attr.components);
            let n = points.checked_mul(components).ok_or(Error::Overflow)?;
            output_bytes = output_bytes
                .checked_add(
                    n.checked_mul(scalar_bytes(attr.data_type)?)
                        .ok_or(Error::Overflow)?,
                )
                .ok_or(Error::Overflow)?;
            if output_bytes > limits.bytes.min(256 * 1024 * 1024) {
                return Err(Error::Limit);
            }
            if attr.encoding == 0 {
                let nbytes = entries
                    .checked_mul(components)
                    .ok_or(Error::Overflow)?
                    .checked_mul(scalar_bytes(attr.data_type)?)
                    .ok_or(Error::Overflow)?;
                let source = c.take(nbytes)?;
                attr.data = budget.vector(nbytes, 0_u8)?;
                attr.data.copy_from_slice(source);
            } else {
                let components = if attr.encoding == 3 { 2 } else { components };
                let n = entries.checked_mul(components).ok_or(Error::Overflow)?;
                integers[index] = Some(crate::integer::Integer::read(
                    &mut c,
                    n,
                    components,
                    &mut budget,
                    gltf_compat,
                    |c, budget| {
                        formats[index] = read_format(c, attr, budget)?;
                        Ok(())
                    },
                )?);
            }
        }
        for (index, attr) in attributes.iter().enumerate().take(last).skip(first) {
            if c.version >= 0x200 || attr.encoding == 0 {
                formats[index] = read_format(&mut c, attr, &mut budget)?;
            }
        }
        portable_groups.push(PortableGroup {
            first,
            last,
            sequence,
        });
    }
    // All framing is parsed before reconstruction. Parent position attributes
    // can therefore precede or follow their dependents, in any decoder group.
    let mut parent = None;
    for positions_first in [true, false] {
        for (group_id, group) in portable_groups.iter().enumerate() {
            let predictor = if let (Some(topology), Some(mapping), Some(sequence)) =
                (&topology, &mapping, &group.sequence)
            {
                Some(crate::prediction::Mesh {
                    topology,
                    mapping,
                    sequence,
                    group: group_info[group_id],
                })
            } else {
                None
            };
            for index in group.first..group.last {
                let attr = &attributes[index];
                if (attr.semantic == 0) != positions_first {
                    continue;
                }
                let Some(integer) = &mut integers[index] else {
                    continue;
                };
                let components = if attr.encoding == 3 {
                    2
                } else {
                    usize::from(attr.components)
                };
                integer.reconstruct(
                    components,
                    predictor.as_ref(),
                    parent.as_deref(),
                    &mut budget,
                )?;
                if positions_first && components == 3 && parent.is_none() {
                    let mut values =
                        budget.vector(points.checked_mul(3).ok_or(Error::Overflow)?, 0_i32)?;
                    for point in 0..points {
                        let entry = group
                            .sequence
                            .as_ref()
                            .map_or(point, |s| s.point_entry[point]);
                        values[point * 3..point * 3 + 3]
                            .copy_from_slice(&integer.values[entry * 3..entry * 3 + 3]);
                    }
                    parent = Some(values);
                }
            }
        }
    }
    // Prediction is finished. Release connectivity and the portable parent
    // before allocating the final attribute arrays and their point ordering.
    drop(parent);
    drop(topology);
    drop(mapping);
    drop(group_info);
    for group in portable_groups {
        for index in group.first..group.last {
            let attr = &mut attributes[index];
            let entries = group
                .sequence
                .as_ref()
                .map_or(points, |s| s.entry_corner.len());
            if let Some(integer) = integers[index].take() {
                let values = integer.values;
                match &formats[index] {
                    Format::Raw => return Err(Error::Invalid),
                    Format::Integer => {
                        let width = scalar_bytes(attr.data_type)?;
                        attr.data = budget.vector(
                            values.len().checked_mul(width).ok_or(Error::Overflow)?,
                            0_u8,
                        )?;
                        for (chunk, value) in attr.data.chunks_exact_mut(width).zip(values) {
                            chunk.copy_from_slice(&value.to_le_bytes()[..width]);
                        }
                    }
                    Format::Quantized { minima, factor } => {
                        attr.data = budget
                            .vector(values.len().checked_mul(4).ok_or(Error::Overflow)?, 0_u8)?;
                        for (i, (chunk, value)) in attr
                            .data
                            .as_chunks_mut::<4>()
                            .0
                            .iter_mut()
                            .zip(values)
                            .enumerate()
                        {
                            let scaled = value as f32 * factor;
                            let final_value = scaled + minima[i % usize::from(attr.components)];
                            chunk.copy_from_slice(&final_value.to_le_bytes());
                        }
                    }
                    Format::Normal(bits) => {
                        attr.data =
                            budget.vector(entries.checked_mul(12).ok_or(Error::Overflow)?, 0_u8)?;
                        for (dst, pair) in attr
                            .data
                            .as_chunks_mut::<12>()
                            .0
                            .iter_mut()
                            .zip(values.as_chunks::<2>().0)
                        {
                            let vector = crate::normal::unit(pair[0], pair[1], *bits)?;
                            for (chunk, f) in dst.as_chunks_mut::<4>().0.iter_mut().zip(vector) {
                                chunk.copy_from_slice(&f.to_le_bytes());
                            }
                        }
                    }
                }
            }
            if let Some(sequence) = &group.sequence {
                let stride = scalar_bytes(attr.data_type)?
                    .checked_mul(usize::from(attr.components))
                    .ok_or(Error::Overflow)?;
                let mut data =
                    budget.vector(points.checked_mul(stride).ok_or(Error::Overflow)?, 0_u8)?;
                for (point, &entry) in sequence.point_entry.iter().enumerate() {
                    data[point * stride..(point + 1) * stride]
                        .copy_from_slice(&attr.data[entry * stride..(entry + 1) * stride]);
                }
                attr.data = data;
            }
        }
    }
    Ok(Geometry {
        points,
        mesh,
        indices,
        attributes,
        metadata,
    })
}
