use crate::{
    entropy::{symbols, varint},
    Attribute, Mesh,
};

struct Portable {
    decoder: u8,
    width: usize,
    values: Vec<i32>,
    transform: Vec<u8>,
}

fn float_values(attribute: &Attribute) -> Vec<f32> {
    attribute
        .bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

fn portable(attribute: &Attribute) -> Result<Portable, &'static str> {
    if attribute.data_type != 9 {
        let values = match attribute.data_type {
            1 => attribute.bytes.iter().map(|&n| n as i8 as i32).collect(),
            2 => attribute.bytes.iter().map(|&n| n as i32).collect(),
            3 => attribute
                .bytes
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes(b.try_into().unwrap()) as i32)
                .collect(),
            4 => attribute
                .bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes(b.try_into().unwrap()) as i32)
                .collect(),
            5 | 6 => attribute
                .bytes
                .chunks_exact(4)
                .map(|b| i32::from_le_bytes(b.try_into().unwrap()))
                .collect(),
            _ => return Err("unsupported integer type"),
        };
        return Ok(Portable {
            decoder: 1,
            width: attribute.width,
            values,
            transform: Vec::new(),
        });
    }
    if attribute.bits == 0 {
        return Ok(Portable {
            decoder: 0,
            width: attribute.width,
            values: Vec::new(),
            transform: Vec::new(),
        });
    }
    let floats = float_values(attribute);
    if attribute.kind == 1 && attribute.width == 3 {
        let maximum = (1u32 << attribute.bits) - 2;
        let center = (maximum / 2) as f64;
        let mut values = Vec::with_capacity(floats.len() / 3 * 2);
        for normal in floats.chunks_exact(3) {
            let sum = normal.iter().map(|&v| (v as f64).abs()).sum::<f64>();
            let v = if sum == 0.0 {
                [1.0, 0.0, 0.0]
            } else {
                [
                    normal[0] as f64 / sum,
                    normal[1] as f64 / sum,
                    normal[2] as f64 / sum,
                ]
            };
            let mut y = v[1];
            let mut z = v[2];
            if v[0] < 0.0 {
                y = (1.0 - v[2].abs()) * if y < 0.0 { -1.0 } else { 1.0 };
                z = (1.0 - v[1].abs()) * if z < 0.0 { -1.0 } else { 1.0 };
            }
            let s = ((y + 1.0) * center).floor() as i32;
            let t = ((z + 1.0) * center).floor() as i32;
            let mut best = [s, t];
            let mut best_error = f64::INFINITY;
            // Select the closest reconstructed direction on the surrounding octahedral lattice.
            // The scoring uses the format's float32 reconstruction, including its folds.
            for ds in -1..=2 {
                for dt in -1..=2 {
                    let candidate = [
                        (s + ds).clamp(0, maximum as i32),
                        (t + dt).clamp(0, maximum as i32),
                    ];
                    let scale = 2.0f32 / maximum as f32;
                    let mut y = candidate[0] as f32 * scale - 1.0;
                    let mut z = candidate[1] as f32 * scale - 1.0;
                    let x = (1.0 - y.abs()) - z.abs();
                    if x < 0.0 {
                        let old_y = y;
                        y = if y < 0.0 {
                            z.abs() - 1.0
                        } else {
                            1.0 - z.abs()
                        };
                        z = if z < 0.0 {
                            old_y.abs() - 1.0
                        } else {
                            1.0 - old_y.abs()
                        };
                    }
                    let inverse = 1.0 / ((x * x + y * y) + z * z).sqrt();
                    let decoded = [x * inverse, y * inverse, z * inverse];
                    let error = decoded
                        .iter()
                        .zip(normal)
                        .map(|(&a, &b)| (a as f64 - b as f64).powi(2))
                        .sum();
                    if error < best_error {
                        best_error = error;
                        best = candidate;
                    }
                }
            }
            values.extend(crate::prediction::canonical(best, maximum as i32));
        }
        return Ok(Portable {
            decoder: 3,
            width: 2,
            values,
            transform: vec![attribute.bits],
        });
    }
    let (origin, range) = if let Some(grid) = &attribute.grid {
        if grid.0.len() != attribute.width
            || !grid.1.is_finite()
            || grid.1 <= 0.0
            || grid.0.iter().any(|v| !v.is_finite())
        {
            return Err("invalid quantization grid");
        }
        grid.clone()
    } else {
        let mut min = vec![f32::INFINITY; attribute.width];
        let mut max = vec![f32::NEG_INFINITY; attribute.width];
        for (i, &v) in floats.iter().enumerate() {
            let c = i % attribute.width;
            min[c] = min[c].min(v);
            max[c] = max[c].max(v);
        }
        let range = max
            .iter()
            .zip(&min)
            .map(|(max, min)| max - min)
            .fold(0.0f32, f32::max);
        (min, if range == 0.0 { 1.0 } else { range })
    };
    let maximum = ((1u32 << attribute.bits) - 1) as f32;
    let inverse = maximum / range;
    // The stream stores a float32 range and decoders reconstruct with a float32 step.
    // Refuse a nonrepresentable transform before float-to-integer saturation can corrupt it.
    if !range.is_finite() || !inverse.is_finite() || !(range * inverse).is_finite()
        || range / maximum == 0.0
    {
        return Err("attribute range not representable");
    }
    let values = floats
        .iter()
        .enumerate()
        .map(|(i, &v)| (((v - origin[i % attribute.width]) * inverse) + 0.5).floor() as i32)
        .collect();
    let mut transform = Vec::new();
    for min in origin {
        transform.extend(min.to_le_bytes());
    }
    transform.extend(range.to_le_bytes());
    transform.push(attribute.bits);
    Ok(Portable {
        decoder: 2,
        width: attribute.width,
        values,
        transform,
    })
}

fn integer_payload(
    values: &[i32],
    width: usize,
    normal_bits: Option<u8>,
    predictor: Option<&crate::prediction::MeshPredictor>,
    kind: u8,
    positions: Option<&[[i32; 3]]>,
    speed: u8,
) -> Vec<u8> {
    let mut out;
    if let Some(bits) = normal_bits {
        // NONE with ordinary zigzag symbols is independent of a normal predictor.
        out = vec![254, 1];
        let symbols: Vec<u32> = values
            .iter()
            .map(|&v| ((v as u32) << 1) ^ ((v >> 31) as u32))
            .collect();
        out.extend(symbols::encode(&symbols, width));
        let mut candidate = vec![0, 3, 1];
        let corrections: Vec<u32> = values
            .chunks_exact(2)
            .enumerate()
            .flat_map(|(i, row)| {
                let prediction = if i == 0 {
                    [0, 0]
                } else {
                    [values[(i - 1) * 2], values[(i - 1) * 2 + 1]]
                };
                crate::prediction::normal([row[0], row[1]], prediction, bits)
            })
            .collect();
        candidate.extend(symbols::encode(&corrections, 2));
        candidate.extend(((1i32 << bits) - 1).to_le_bytes());
        candidate.extend(((1i32 << (bits - 1)) - 1).to_le_bytes());
        if candidate.len() < out.len() {
            out = candidate;
        }
        if let (Some(predictor), Some(positions)) = (predictor.filter(|_| speed < 8), positions) {
            if let Some(candidate) = predictor.normal_candidate(values, positions, bits) {
                if candidate.len() < out.len() {
                    out = candidate;
                }
            }
        }
    } else {
        let min = values.iter().copied().min().unwrap_or(0);
        let max = values.iter().copied().max().unwrap_or(0);
        let plain: Vec<u32> = values
            .iter()
            .map(|&v| ((v as u32) << 1) ^ ((v >> 31) as u32))
            .collect();
        let mut none = vec![254, 1];
        none.extend(symbols(&plain, width));
        // A signed wrap transform cannot express a range wider than INT32_MAX.
        // NONE retains all 32 bits and needs no range arithmetic in either decoder.
        if max as i64 - min as i64 >= i32::MAX as i64 {
            return none;
        }
        let mut corrections = Vec::with_capacity(values.len());
        for (i, &value) in values.iter().enumerate() {
            let prediction = if i < width { 0 } else { values[i - width] };
            corrections.push(crate::prediction::wrap(value, prediction, min, max));
        }
        out = vec![0, 1, 1];
        out.extend(symbols(&corrections, width));
        out.extend(min.to_le_bytes());
        out.extend(max.to_le_bytes());
        if let Some(predictor) = predictor {
            for candidate in predictor.integer_candidates(values, width, min, max, speed < 8) {
                if candidate.len() < out.len() {
                    out = candidate;
                }
            }
            if kind == 3 && width == 2 && speed < 8 {
                if let Some(positions) = positions {
                    if let Some(candidate) = predictor.uv_candidate(values, positions, min, max) {
                        if candidate.len() < out.len() {
                            out = candidate;
                        }
                    }
                }
            }
        }
        if none.len() < out.len() {
            out = none;
        }
    }
    out
}

// Keep calls to the symbol coder unambiguous next to local symbol arrays.
mod symbols {
    pub fn encode(values: &[u32], width: usize) -> Vec<u8> {
        crate::entropy::symbols(values, width)
    }
}

pub fn encode(mesh: &Mesh) -> Result<Vec<u8>, &'static str> {
    let mut out = b"DRACO\x02\x02\x01\x00\x00\x00".to_vec();
    varint(&mut out, (mesh.indices.len() / 3) as u64);
    varint(&mut out, mesh.points as u64);
    let mut deltas = Vec::with_capacity(mesh.indices.len());
    let mut last = 0i64;
    for &index in &mesh.indices {
        let delta = index as i64 - last;
        deltas.push(((delta.unsigned_abs() as u32) << 1) | u32::from(delta < 0));
        last = index as i64;
    }
    let compressed = symbols(&deltas, 1);
    let mut raw = Vec::new();
    for &index in &mesh.indices {
        if mesh.points < 256 {
            raw.push(index as u8);
        } else if mesh.points < 65536 {
            raw.extend((index as u16).to_le_bytes());
        } else if mesh.points < 1 << 21 {
            varint(&mut raw, index as u64);
        } else {
            raw.extend(index.to_le_bytes());
        }
    }
    if compressed.len() < raw.len() {
        out.push(0);
        out.extend(compressed);
    } else {
        out.push(1);
        out.extend(raw);
    }
    attributes(
        &mut out,
        &mesh.attributes,
        None,
        None,
        mesh.encode_speed.max(mesh.decode_speed),
    )?;
    Ok(out)
}

pub fn encode_edgebreaker(
    mesh: &Mesh,
    topology: &crate::topology::Topology,
) -> Result<Vec<u8>, &'static str> {
    let mut out = b"DRACO\x02\x02\x01\x01\x00\x00".to_vec();
    out.extend(&topology.connectivity);
    let mut reordered = mesh.attributes.clone();
    for attribute in &mut reordered {
        let stride = attribute.width * crate::scalar_size(attribute.data_type).unwrap();
        let mut bytes = Vec::with_capacity(topology.points * stride);
        for &vertex in &topology.attribute_sequence {
            bytes
                .extend(&attribute.bytes[vertex as usize * stride..(vertex as usize + 1) * stride]);
        }
        attribute.bytes = bytes;
    }
    let positions = mesh
        .attributes
        .iter()
        .find(|a| a.kind == 0 && a.width == 3)
        .map(portable)
        .transpose()?
        .filter(|p| !p.values.is_empty())
        .map(|p| {
            topology
                .reordered_indices
                .iter()
                .map(|&v| {
                    let at = v as usize * 3;
                    [p.values[at], p.values[at + 1], p.values[at + 2]]
                })
                .collect::<Vec<_>>()
        });
    attributes(
        &mut out,
        &reordered,
        Some(topology),
        positions.as_deref(),
        mesh.encode_speed.max(mesh.decode_speed),
    )?;
    Ok(out)
}

pub fn encode_grouped(
    mesh: &Mesh,
    grouped: &crate::topology::GroupedTopology,
) -> Result<Vec<u8>, &'static str> {
    let mut out = b"DRACO\x02\x02\x01\x01\x00\x00".to_vec();
    out.extend(&grouped.topology.connectivity);
    let positions = mesh
        .attributes
        .iter()
        .find(|a| a.kind == 0 && a.width == 3)
        .map(portable)
        .transpose()?
        .filter(|p| !p.values.is_empty())
        .map(|p| {
            grouped
                .topology
                .reordered_indices
                .iter()
                .map(|&v| {
                    let at = v as usize * 3;
                    [p.values[at], p.values[at + 1], p.values[at + 2]]
                })
                .collect::<Vec<_>>()
        });
    let mut sets = Vec::new();
    for group in &grouped.groups {
        let mut order = group.attributes.clone();
        order.sort_by_key(|&i| if mesh.attributes[i].kind == 0 { 0 } else { 1 });
        let mut originals = Vec::new();
        for &id in &order {
            let mut attribute = mesh.attributes[id].clone();
            let stride = attribute.width * crate::scalar_size(attribute.data_type).unwrap();
            let mut bytes = Vec::with_capacity(group.topology.points * stride);
            for &v in &group.topology.attribute_sequence {
                bytes.extend(&attribute.bytes[v as usize * stride..(v as usize + 1) * stride]);
            }
            attribute.bytes = bytes;
            originals.push(attribute);
        }
        let portable = originals
            .iter()
            .map(portable)
            .collect::<Result<Vec<_>, _>>()?;
        sets.push((order, originals, portable));
    }
    out.push(sets.len() as u8);
    for i in 0..sets.len() {
        out.extend(if i == 0 {
            [255, 0, grouped.groups[i].topology.traversal_method]
        } else {
            [
                (i - 1) as u8,
                1,
                grouped.groups[i].topology.traversal_method,
            ]
        });
    }
    for (order, originals, portable) in &sets {
        varint(&mut out, originals.len() as u64);
        for (&id, a) in order.iter().zip(originals) {
            out.extend([a.kind, a.data_type, a.width as u8, u8::from(a.normalized)]);
            varint(&mut out, id as u64);
        }
        for p in portable {
            out.push(p.decoder);
        }
    }
    for ((_, originals, portable), group) in sets.into_iter().zip(&grouped.groups) {
        let predictor = crate::prediction::MeshPredictor::new(&group.topology);
        for (a, p) in originals.iter().zip(&portable) {
            if p.decoder == 0 {
                out.extend(&a.bytes);
            } else {
                out.extend(integer_payload(
                    &p.values,
                    p.width,
                    if p.decoder == 3 { Some(a.bits) } else { None },
                    Some(&predictor),
                    a.kind,
                    positions.as_deref(),
                    mesh.encode_speed.max(mesh.decode_speed),
                ));
            }
        }
        for p in portable {
            out.extend(p.transform);
        }
    }
    Ok(out)
}

fn attributes(
    out: &mut Vec<u8>,
    originals: &[Attribute],
    topology: Option<&crate::topology::Topology>,
    positions: Option<&[[i32; 3]]>,
    speed: u8,
) -> Result<(), &'static str> {
    let mut order: Vec<usize> = (0..originals.len()).collect();
    order.sort_by_key(|&i| if originals[i].kind == 0 { 0 } else { 1 });
    let attributes = order
        .iter()
        .map(|&i| portable(&originals[i]))
        .collect::<Result<Vec<_>, _>>()?;
    out.push(1);
    if let Some(topology) = topology {
        out.extend([255, 0, topology.traversal_method]);
    }
    varint(out, attributes.len() as u64);
    for &id in &order {
        let attribute = &originals[id];
        out.extend([
            attribute.kind,
            attribute.data_type,
            attribute.width as u8,
            u8::from(attribute.normalized),
        ]);
        varint(out, id as u64);
    }
    for attribute in &attributes {
        out.push(attribute.decoder);
    }
    let predictor = topology.map(crate::prediction::MeshPredictor::new);
    for (&id, attribute) in order.iter().zip(&attributes) {
        let original = &originals[id];
        if attribute.decoder == 0 {
            out.extend(&original.bytes);
        } else {
            out.extend(integer_payload(
                &attribute.values,
                attribute.width,
                if attribute.decoder == 3 {
                    Some(original.bits)
                } else {
                    None
                },
                predictor.as_ref(),
                original.kind,
                positions,
                speed,
            ));
        }
    }
    for attribute in attributes {
        out.extend(attribute.transform);
    }
    Ok(())
}
