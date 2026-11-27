use crate::{Budget, Error, Limits, Result, cursor::Cursor, entropy, prediction::Positions};

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
/// Final scalar bytes of a reconstructed integer-coded attribute, in entry
/// order: truncated to the declared width, dequantized or unfolded.
fn converted(
    format: &Format,
    attr: &Attribute,
    values: &[i32],
    entries: usize,
    budget: &mut Budget,
) -> Result<Vec<u8>> {
    let mut data;
    match format {
        Format::Raw => return Err(Error::Invalid),
        Format::Integer => {
            let width = scalar_bytes(attr.data_type)?;
            data = budget.vector(
                values.len().checked_mul(width).ok_or(Error::Overflow)?,
                0_u8,
            )?;
            integer_bytes(&mut data, values, width);
        }
        Format::Quantized { minima, factor } => {
            data = budget.vector(values.len().checked_mul(4).ok_or(Error::Overflow)?, 0_u8)?;
            quantized_bytes(
                &mut data,
                values,
                minima,
                *factor,
                usize::from(attr.components),
            );
        }
        Format::Normal(bits) => {
            data = budget.vector(entries.checked_mul(12).ok_or(Error::Overflow)?, 0_u8)?;
            normal_bytes(&mut data, values, *bits)?;
        }
    }
    Ok(data)
}
/// Positions per point that a predictor of a stream before 2.0 reads at
/// attribute `user`. E26/E27: the first position attribute in file order
/// supplies them and must have three components. Its final output scalars are
/// converted, so integer and quantized positions give their output values.
/// When it does not precede `user` it is not available yet and every position
/// is zero. E33: a scalar `convert` refuses leaves it and the rest of its
/// point zero.
#[allow(clippy::too_many_arguments)]
fn legacy_positions<T: Clone + Default>(
    attributes: &[Attribute],
    groups: &[PortableGroup],
    integers: &[Option<crate::integer::Integer>],
    formats: &[Format],
    user: usize,
    points: usize,
    budget: &mut Budget,
    convert: fn(u8, u64) -> Option<T>,
) -> Result<Vec<T>> {
    let index = position_attribute(attributes)?;
    let attr = &attributes[index];
    let count = points.checked_mul(3).ok_or(Error::Overflow)?;
    let mut values = budget.vector(count, T::default())?;
    if index >= user {
        return Ok(values);
    }
    let group = groups
        .iter()
        .find(|g| (g.first..g.last).contains(&index))
        .ok_or(Error::Invalid)?;
    let width = scalar_bytes(attr.data_type)?;
    let output = match &integers[index] {
        Some(integer) => {
            let entries = group
                .sequence
                .as_ref()
                .map_or(points, |s| s.entry_corner.len());
            Some(converted(
                &formats[index],
                attr,
                &integer.values,
                entries,
                budget,
            )?)
        }
        None => None,
    };
    let data = output.as_ref().unwrap_or(&attr.data);
    for (point, row) in values.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        let entry = group
            .sequence
            .as_ref()
            .map_or(point, |s| s.point_entry[point]);
        for (c, value) in row.iter_mut().enumerate() {
            let at = (entry * 3 + c) * width;
            let mut scalar = [0_u8; 8];
            scalar[..width].copy_from_slice(data.get(at..at + width).ok_or(Error::Invalid)?);
            let Some(next) = convert(attr.data_type, u64::from_le_bytes(scalar)) else {
                break;
            };
            *value = next;
        }
    }
    Ok(values)
}
/// E27/E34: the attribute whose values predictors read as positions is the
/// first position attribute in file order, three components wide.
fn position_attribute(attributes: &[Attribute]) -> Result<usize> {
    let index = attributes
        .iter()
        .position(|a| a.semantic == 0)
        .ok_or(Error::Invalid)?;
    if attributes[index].components != 3 {
        return Err(Error::Invalid);
    }
    Ok(index)
}
/// E26/E30: predictor 3 reads each scalar as float32; any nonzero bool is one.
fn scalar_float(data_type: u8, bits: u64) -> Option<f32> {
    Some(match data_type {
        8 => bits as f32,
        9 => f32::from_bits(bits as u32),
        10 => f64::from_bits(bits) as f32,
        11 => f32::from(u8::from(bits != 0)),
        _ => scalar_integer(data_type, bits)? as f32,
    })
}
/// E33: predictor 5 before 2.0 reads each scalar as int64, truncating floats.
/// A bool keeps its byte. Values outside int64, NaN included, are refused.
fn scalar_integer(data_type: u8, bits: u64) -> Option<i64> {
    Some(match data_type {
        1 => i64::from(bits as u8 as i8),
        2 | 11 => i64::from(bits as u8),
        3 => i64::from(bits as u16 as i16),
        4 => i64::from(bits as u16),
        5 => i64::from(bits as u32 as i32),
        6 => i64::from(bits as u32),
        7 => bits as i64,
        8 => i64::try_from(bits).ok()?,
        9 | 10 => {
            let value = if data_type == 9 {
                f64::from(f32::from_bits(bits as u32))
            } else {
                f64::from_bits(bits)
            };
            let limit = 9_223_372_036_854_775_808.0;
            if !(-limit..limit).contains(&value) {
                return None;
            }
            value as i64
        }
        _ => return None,
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
    // E60: unique ids are u16 only before 1.3.
    let unique_id = if c.version < 0x103 {
        c.le(2)?
    } else {
        c.count()? as u32
    };
    // E61: any nonzero normalized byte is true.
    if semantic > 4 || components == 0 {
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
    if !((major == 1 && minor <= 3) || (major == 2 && minor <= if kind == 0 { 3 } else { 2 })) {
        return Err(Error::Unsupported);
    }
    c.version = u16::from(major) * 256 + u16::from(minor);
    let mut budget = Budget::new(crate::WORKSPACE_LIMIT);
    // E48: only the metadata bit of the flags is read, and only from 1.3.
    let metadata = if c.version >= 0x103 && flags & 32768 != 0 {
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
    // E53: a sequential mesh holds at most three points per face.
    if mesh && mapping.is_none() && points > faces.saturating_mul(3) {
        return Err(Error::Invalid);
    }
    let nindices = faces.checked_mul(3).ok_or(Error::Overflow)?;
    if nindices > limits.indices {
        return Err(Error::Limit);
    }
    let mut indices = budget.vector(nindices, 0_u32)?;
    budget.steps(nindices)?;
    if let Some(mapping) = &mapping {
        corner_indices(&mut indices, &mapping.corner_to_point)?;
    } else if mesh {
        // E54: connectivity byte 0 is entropy coded, any other value raw.
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
            _ => {
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
    // E28: a mesh decoder may name each connectivity (255 or an attribute
    // index) only once.
    if topology.is_some() {
        let mut named = [false; 256];
        for group in &group_info {
            if std::mem::replace(&mut named[usize::from(group.data_id)], true) {
                return Err(Error::Invalid);
            }
        }
    }
    let mut attributes = Vec::new();
    let mut ranges = budget.vector(groups, (0_usize, 0_usize))?;
    for range in &mut ranges {
        let n = if c.version < 0x200 {
            c.le(4)? as usize
        } else {
            c.count()?
        };
        // E55: a file may hold no attribute decoder, but a decoder holds at
        // least one attribute.
        if n == 0 {
            return Err(Error::Invalid);
        }
        if n > (c.data.len() - c.at) / 6 {
            return Err(Error::Truncated);
        }
        budget.charge(n, std::mem::size_of::<Attribute>())?;
        attributes.try_reserve_exact(n).map_err(|_| Error::Limit)?;
        let first = attributes.len();
        // E59: unique ids may repeat, within a decoder and across them.
        for _ in 0..n {
            attributes.push(descriptor(&mut c)?);
        }
        for attr in &mut attributes[first..] {
            attr.encoding = c.byte()?;
            if attr.encoding > 3 {
                return Err(Error::Invalid);
            }
        }
        *range = (first, first + n);
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
            if output_bytes > limits.bytes.min(crate::OUTPUT_LIMIT) {
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
                    nindices,
                    attr.encoding == 3,
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
    // All framing is parsed before reconstruction, which runs in file order.
    // `parent` holds the portable positions of streams from 2.0.
    let mut parent: Option<(usize, Vec<i32>)> = None;
    // Positions of older streams, rebuilt once if the position attribute
    // lies between two of its users (E27).
    let mut legacy_float: Option<(bool, Vec<f32>)> = None;
    let mut legacy_integer: Option<(bool, Vec<i64>)> = None;
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
            let Some(integer) = &integers[index] else {
                continue;
            };
            let positions = match integer.positions() {
                None => None,
                Some(float) if c.version < 0x200 => {
                    let before = position_attribute(&attributes)? < index;
                    if float {
                        if legacy_float.as_ref().is_none_or(|p| p.0 != before) {
                            let values = legacy_positions(
                                &attributes,
                                &portable_groups,
                                &integers,
                                &formats,
                                index,
                                points,
                                &mut budget,
                                scalar_float,
                            )?;
                            legacy_float = Some((before, values));
                        }
                        legacy_float.as_ref().map(|p| Positions::Float(&p.1))
                    } else {
                        if legacy_integer.as_ref().is_none_or(|p| p.0 != before) {
                            let values = legacy_positions(
                                &attributes,
                                &portable_groups,
                                &integers,
                                &formats,
                                index,
                                points,
                                &mut budget,
                                scalar_integer,
                            )?;
                            legacy_integer = Some((before, values));
                        }
                        legacy_integer.as_ref().map(|p| Positions::Wide(&p.1))
                    }
                }
                Some(_) => {
                    // E34: from 2.0 the position attribute must already be
                    // decoded, as three portable integers per entry.
                    let at = position_attribute(&attributes)?;
                    if at >= index || attributes[at].encoding == 3 {
                        return Err(Error::Invalid);
                    }
                    if parent.is_none() {
                        let source = integers[at].as_ref().ok_or(Error::Invalid)?;
                        let sequence = portable_groups
                            .iter()
                            .find(|g| (g.first..g.last).contains(&at))
                            .and_then(|g| g.sequence.as_ref());
                        let count = points.checked_mul(3).ok_or(Error::Overflow)?;
                        let mut values = budget.vector(count, 0_i32)?;
                        parent_positions(&mut values, &source.values, sequence);
                        parent = Some((at, values));
                    }
                    parent.as_ref().map(|p| Positions::Portable(&p.1))
                }
            };
            let components = if attributes[index].encoding == 3 {
                2
            } else {
                usize::from(attributes[index].components)
            };
            integers[index]
                .as_mut()
                .ok_or(Error::Invalid)?
                .reconstruct(components, predictor.as_ref(), positions, &mut budget)?;
        }
    }
    // Prediction is finished. Release connectivity and the portable parent
    // before allocating the final attribute arrays and their point ordering.
    drop(parent);
    drop(legacy_float);
    drop(legacy_integer);
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
                attr.data =
                    converted(&formats[index], attr, &integer.values, entries, &mut budget)?;
            }
            if let Some(sequence) = &group.sequence {
                let stride = scalar_bytes(attr.data_type)?
                    .checked_mul(usize::from(attr.components))
                    .ok_or(Error::Overflow)?;
                let mut data =
                    budget.vector(points.checked_mul(stride).ok_or(Error::Overflow)?, 0_u8)?;
                point_order(&mut data, &attr.data, &sequence.point_entry, stride);
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

// Per-point loops of `decode_flavor` run as separate functions (KB4824a): an
// engine optimizing one hot loop does not also compile the whole decoder.
#[inline(never)]
fn corner_indices(indices: &mut [u32], corner_to_point: &[usize]) -> Result<()> {
    for (out, &index) in indices.iter_mut().zip(corner_to_point) {
        *out = u32::try_from(index).map_err(|_| Error::Overflow)?;
    }
    Ok(())
}
#[inline(never)]
fn parent_positions(
    values: &mut [i32],
    source: &[i32],
    sequence: Option<&crate::traversal::Sequence>,
) {
    for point in 0..values.len() / 3 {
        let entry = sequence.map_or(point, |s| s.point_entry[point]);
        values[point * 3..point * 3 + 3].copy_from_slice(&source[entry * 3..entry * 3 + 3]);
    }
}
#[inline(never)]
fn integer_bytes(data: &mut [u8], values: &[i32], width: usize) {
    for (chunk, value) in data.chunks_exact_mut(width).zip(values) {
        chunk.copy_from_slice(&value.to_le_bytes()[..width]);
    }
}
#[inline(never)]
fn quantized_bytes(
    data: &mut [u8],
    values: &[i32],
    minima: &[f32],
    factor: f32,
    components: usize,
) {
    for (i, (chunk, &value)) in data
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(values)
        .enumerate()
    {
        let scaled = value as f32 * factor;
        let final_value = scaled + minima[i % components];
        chunk.copy_from_slice(&final_value.to_le_bytes());
    }
}
#[inline(never)]
fn normal_bytes(data: &mut [u8], values: &[i32], bits: u8) -> Result<()> {
    for (dst, pair) in data
        .as_chunks_mut::<12>()
        .0
        .iter_mut()
        .zip(values.as_chunks::<2>().0)
    {
        let vector = crate::normal::unit(pair[0], pair[1], bits)?;
        for (chunk, f) in dst.as_chunks_mut::<4>().0.iter_mut().zip(vector) {
            chunk.copy_from_slice(&f.to_le_bytes());
        }
    }
    Ok(())
}
#[inline(never)]
fn point_order(data: &mut [u8], source: &[u8], point_entry: &[usize], stride: usize) {
    for (point, &entry) in point_entry.iter().enumerate() {
        data[point * stride..(point + 1) * stride]
            .copy_from_slice(&source[entry * stride..(entry + 1) * stride]);
    }
}
