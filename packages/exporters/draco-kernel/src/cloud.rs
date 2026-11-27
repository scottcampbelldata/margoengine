//! Point cloud streams (bitstream 2.3), written clean room from the Draco Bitstream Specification, version 2.2
//! (Galligan and others, Google, https://google.github.io/draco/spec/): "DecodeSequentialPointCloud" order for the
//! sequential method, and the KD-tree method after Devillers and Gandoin, "Geometric compression for interactive
//! transmission", IEEE Visualization 2000, https://doi.org/10.1109/VISUAL.2000.885711 (a point set is coded by how
//! many points fall in each half of its cell).
use crate::{entropy::varint, sequential, topology, Attribute, Mesh};

/// A KD-tree bit stream: values packed from the high bit of little-endian 32-bit words, behind its byte length.
#[derive(Default)]
struct Bits {
    words: Vec<u32>,
    used: u32,
}

impl Bits {
    fn put(&mut self, value: u32, width: u32) {
        let mut left = width;
        while left > 0 {
            if self.used == 0 {
                self.words.push(0);
            }
            let free = 32 - self.used;
            let take = left.min(free);
            let part = (value >> (left - take)) & (u32::MAX >> (32 - take));
            *self.words.last_mut().unwrap() |= part << (free - take);
            self.used = (self.used + take) % 32;
            left -= take;
        }
    }
    /// A stream holds at least one word.
    fn write(&self, out: &mut Vec<u8>) {
        let words = self.words.len().max(1);
        out.extend((words as u32 * 4).to_le_bytes());
        for i in 0..words {
            out.extend(self.words.get(i).copied().unwrap_or(0).to_le_bytes());
        }
    }
}

/// The attributes as unsigned KD-tree dimensions, one row a point, with the transforms that give the values back.
struct Table {
    dimensions: usize,
    values: Vec<u32>,
    /// Quantization transforms of the float attributes, then the minima of the signed ones.
    transforms: Vec<u8>,
}

/// None when an attribute cannot be a dimension: an unquantized float, or int32 values wider than int32::MAX.
fn table(mesh: &Mesh) -> Result<Option<Table>, &'static str> {
    let dimensions: usize = mesh.attributes.iter().map(|a| a.width).sum();
    let mut values = vec![0u32; mesh.points * dimensions];
    let mut floats = Vec::new();
    let mut signed = Vec::new();
    let mut offset = 0;
    for attribute in &mesh.attributes {
        let float = attribute.data_type == 9;
        if float && attribute.bits == 0 {
            return Ok(None);
        }
        // Normals take the plain grid here: the KD-tree method has no octahedron transform.
        let plain;
        let source = if float && attribute.kind == 1 {
            plain = Attribute {
                kind: 4,
                ..attribute.clone()
            };
            &plain
        } else {
            attribute
        };
        let portable = sequential::portable(source)?;
        let width = attribute.width;
        let mut minima = vec![0i32; width];
        if matches!(attribute.data_type, 1 | 3 | 5) {
            minima.fill(i32::MAX);
            for (i, &v) in portable.values.iter().enumerate() {
                minima[i % width] = minima[i % width].min(v);
            }
            for &m in &minima {
                varint(&mut signed, u64::from(((m << 1) ^ (m >> 31)) as u32));
            }
        } else if float {
            floats.extend(&portable.transform);
        }
        for (i, &v) in portable.values.iter().enumerate() {
            let value = (v as u32).wrapping_sub(minima[i % width] as u32);
            if attribute.data_type == 5 && value > i32::MAX as u32 {
                return Ok(None);
            }
            values[i / width * dimensions + offset + i % width] = value;
        }
        offset += width;
    }
    floats.extend(signed);
    Ok(Some(Table {
        dimensions,
        values,
        transforms: floats,
    }))
}

/// A split whose second (lower) half is still to be written.
struct Frame {
    start: usize,
    low: usize,
    axis: usize,
    width: u32,
    pending: bool,
}

/// The axis of a node of at least 64 points: of the first 16 dimensions with bits left, the one whose next bit
/// splits the node most unevenly, so leading zeros go while there are few nodes to pay for them.
fn uneven(table: &Table, node: &[u32], widths: &[u32]) -> usize {
    let d = table.dimensions;
    let (mut best, mut most) = (0, None);
    for axis in 0..d.min(16) {
        if widths[axis] == 0 {
            continue;
        }
        let shift = widths[axis] - 1;
        let upper: usize = node
            .iter()
            .map(|&p| (table.values[p as usize * d + axis] >> shift & 1) as usize)
            .sum();
        let uneven = (2 * upper).abs_diff(node.len());
        if most.is_none_or(|m| uneven > m) {
            (best, most) = (axis, Some(uneven));
        }
    }
    best
}

/// The tree: each node's smaller-half count in binary ANS coded bit planes, leaves of at most two points. Up to 16
/// dimensions it is level 6, which chooses axes; wider points take level 4, which takes them in turn.
fn tree(out: &mut Vec<u8>, table: &Table, points: usize) {
    let d = table.dimensions;
    let bits = 32
        - table
            .values
            .iter()
            .fold(0, |all, &v| all | v)
            .leading_zeros();
    let chosen = d <= 16;
    out.push(if chosen { 6 } else { 4 });
    out.extend(bits.to_le_bytes());
    out.extend((points as u32).to_le_bytes());
    let mut numbers = vec![Vec::new(); 33];
    let (mut remaining, mut axes, mut halves) = (Bits::default(), Bits::default(), Bits::default());
    let mut order: Vec<u32> = (0..points as u32).collect();
    let mut widths = vec![bits; d];
    let mut stack: Vec<Frame> = Vec::new();
    let (mut start, mut n, mut last) = (0, points, 0);
    loop {
        if n != 0 {
            let axis = if !chosen {
                (last + 1) % d
            } else if n >= 64 {
                let axis = uneven(table, &order[start..start + n], &widths);
                axes.put(axis as u32, 4);
                axis
            } else {
                // The widest dimension, the first of equals.
                (1..d).fold(0, |best, i| if widths[i] > widths[best] { i } else { best })
            };
            let exhausted = widths.iter().all(|&w| w == 0);
            if exhausted || n <= 2 {
                if !exhausted {
                    for &point in &order[start..start + n] {
                        for j in 0..d {
                            let k = (axis + j) % d;
                            remaining.put(table.values[point as usize * d + k], widths[k]);
                        }
                    }
                }
            } else if widths[axis] == 0 {
                last = axis;
                continue;
            } else {
                let shift = widths[axis] - 1;
                let upper = |point: u32| table.values[point as usize * d + axis] >> shift & 1 != 0;
                // Partition the node: the points of the lower half first.
                let node = &mut order[start..start + n];
                let mut low = 0;
                for i in 0..node.len() {
                    if !upper(node[i]) {
                        node.swap(i, low);
                        low += 1;
                    }
                }
                let high = n - low;
                let width = (usize::BITS - 1 - n.leading_zeros()) as usize;
                let number = n / 2 - low.min(high);
                for (i, plane) in numbers[..width].iter_mut().enumerate() {
                    plane.push(number >> (width - 1 - i) & 1 != 0);
                }
                if low != high {
                    halves.put(u32::from(low < high), 1);
                }
                stack.push(Frame {
                    start,
                    low,
                    axis,
                    width: widths[axis],
                    pending: true,
                });
                widths[axis] = shift;
                start += low;
                n = high;
                last = axis;
                continue;
            }
        }
        loop {
            let Some(mut frame) = stack.pop() else {
                for plane in &numbers {
                    out.extend(topology::binary(plane));
                }
                remaining.write(out);
                axes.write(out);
                halves.write(out);
                return;
            };
            let axis = frame.axis;
            widths[axis] = frame.width;
            if frame.pending {
                frame.pending = false;
                widths[axis] -= 1;
                (start, n, last) = (frame.start, frame.low, axis);
                stack.push(frame);
                break;
            }
        }
    }
}

fn kd(mesh: &Mesh, table: &Table) -> Vec<u8> {
    let mut out = b"DRACO\x02\x03\x00\x01\x00\x00".to_vec();
    out.extend((mesh.points as u32).to_le_bytes());
    out.push(1);
    varint(&mut out, mesh.attributes.len() as u64);
    for (id, a) in mesh.attributes.iter().enumerate() {
        out.extend([a.kind, a.data_type, a.width as u8, u8::from(a.normalized)]);
        varint(&mut out, id as u64);
    }
    tree(&mut out, table, mesh.points);
    out.extend(&table.transforms);
    out
}

/// Encodes a point cloud: no point is merged or dropped. Speed 10 keeps the points in order (sequential); below it
/// the smaller of the sequential and KD-tree streams is returned.
pub fn encode(mesh: &Mesh) -> Result<Vec<u8>, &'static str> {
    if mesh.points == 0 || !mesh.indices.is_empty() {
        return Err("a nonempty point cloud without indices is required");
    }
    crate::validate_attributes(mesh)?;
    let sequential = sequential::encode_points(mesh)?;
    if mesh.encode_speed == 10 || mesh.decode_speed == 10 {
        return Ok(sequential);
    }
    Ok(match table(mesh)? {
        Some(table) => {
            let tree = kd(mesh, &table);
            if tree.len() < sequential.len() {
                tree
            } else {
                sequential
            }
        }
        None => sequential,
    })
}
