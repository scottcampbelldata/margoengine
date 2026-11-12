//! Clean-room Draco encoder, built from published format equations.
mod entropy;
mod prediction;
mod sequential;
mod topology;

#[derive(Clone, Debug)]
pub struct Attribute {
    pub kind: u8,
    pub data_type: u8,
    pub width: usize,
    pub normalized: bool,
    pub bits: u8,
    pub grid: Option<(Vec<f32>, f32)>,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Mesh {
    pub points: usize,
    pub indices: Vec<u32>,
    pub attributes: Vec<Attribute>,
    pub encode_speed: u8,
    pub decode_speed: u8,
}

/// Bytes of packed input one encode may take (src/draco-native-encode.ts holds the same value).
pub const INPUT_LIMIT: usize = 280 * 1024 * 1024;

/// The 64-bit FNV-1a hash of point `point`'s bytes across every attribute.
fn row_hash(mesh: &Mesh, strides: &[usize], point: usize) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for (a, &stride) in mesh.attributes.iter().zip(strides) {
        for &byte in &a.bytes[point * stride..(point + 1) * stride] {
            hash = (hash ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    hash
}

/// Merges points whose bytes match in every attribute, in index order. The table holds one u32 per slot and compares
/// rows in place: a map keyed by a copy of each row took about 80 bytes per point (KB0035).
fn compact(mesh: &Mesh) -> Mesh {
    let strides: Vec<usize> = mesh
        .attributes
        .iter()
        .map(|a| a.width * scalar_size(a.data_type).unwrap())
        .collect();
    let same = |p: usize, q: usize| {
        mesh.attributes
            .iter()
            .zip(&strides)
            .all(|(a, &s)| a.bytes[p * s..(p + 1) * s] == a.bytes[q * s..(q + 1) * s])
    };
    let slots = (mesh.points * 2).next_power_of_two().max(2);
    let mut table = vec![u32::MAX; slots];
    let mut point_map = vec![u32::MAX; mesh.points];
    let mut sequence: Vec<u32> = Vec::new();
    let indices = mesh
        .indices
        .iter()
        .map(|&point| {
            let point = point as usize;
            if point_map[point] != u32::MAX {
                return point_map[point];
            }
            let mut slot = row_hash(mesh, &strides, point) as usize & (slots - 1);
            let id = loop {
                let held = table[slot];
                if held == u32::MAX {
                    let id = sequence.len() as u32;
                    table[slot] = id;
                    sequence.push(point as u32);
                    break id;
                }
                if same(sequence[held as usize] as usize, point) {
                    break held;
                }
                slot = (slot + 1) & (slots - 1);
            };
            point_map[point] = id;
            id
        })
        .collect();
    drop((table, point_map));
    let attributes = mesh
        .attributes
        .iter()
        .zip(&strides)
        .map(|(a, &stride)| {
            let mut bytes = Vec::with_capacity(sequence.len() * stride);
            for &point in &sequence {
                let point = point as usize;
                bytes.extend(&a.bytes[point * stride..(point + 1) * stride]);
            }
            Attribute {
                kind: a.kind,
                data_type: a.data_type,
                width: a.width,
                normalized: a.normalized,
                bits: a.bits,
                grid: a.grid.clone(),
                bytes,
            }
        })
        .collect();
    Mesh {
        points: sequence.len(),
        indices,
        attributes,
        encode_speed: mesh.encode_speed,
        decode_speed: mesh.decode_speed,
    }
}

pub struct Encoded {
    pub data: Vec<u8>,
    pub points: usize,
    pub faces: usize,
}

pub fn encode(mesh: &Mesh) -> Result<Vec<u8>, &'static str> {
    Ok(encode_result(mesh)?.data)
}

fn encode_result(mesh: &Mesh) -> Result<Encoded, &'static str> {
    encode_compacted(validated_compact(mesh)?)
}

/// The checked mesh with its equal points merged.
fn validated_compact(mesh: &Mesh) -> Result<Mesh, &'static str> {
    if mesh.points == 0 || mesh.indices.is_empty() || mesh.indices.len() % 3 != 0 {
        return Err("a nonempty triangle mesh is required");
    }
    if mesh.indices.iter().any(|&i| i as usize >= mesh.points) {
        return Err("index outside point range");
    }
    if mesh.attributes.is_empty() || mesh.attributes.len() > 255 {
        return Err("invalid attribute count");
    }
    for attribute in &mesh.attributes {
        let size = scalar_size(attribute.data_type).ok_or("unsupported scalar type")?;
        if attribute.width == 0
            || attribute.width > 4
            || attribute.bytes.len() != mesh.points * attribute.width * size
        {
            return Err("invalid attribute dimensions");
        }
        if attribute.bits > 30 || (attribute.kind == 1 && attribute.bits == 1) {
            return Err("invalid quantization bits");
        }
        if attribute.data_type == 9
            && attribute
                .bytes
                .chunks_exact(4)
                .any(|b| !f32::from_le_bytes(b.try_into().unwrap()).is_finite())
        {
            return Err("nonfinite attribute");
        }
    }
    Ok(compact(mesh))
}

/// Encodes a mesh that `compact` already merged.
fn encode_compacted(mesh: Mesh) -> Result<Encoded, &'static str> {
    let sequential = sequential::encode(&mesh)?;
    let faces = mesh.indices.len() / 3;
    if mesh.encode_speed == 10 || mesh.decode_speed == 10 {
        return Ok(Encoded {
            data: sequential,
            points: mesh.points,
            faces,
        });
    }
    // Each candidate's topology is dropped once encoded, so only one is held at a time (KB0035).
    let mut result = {
        let topology = topology::plan(&mesh)?;
        let edgebreaker = sequential::encode_edgebreaker(&mesh, &topology)?;
        if edgebreaker.len() < sequential.len() {
            Encoded {
                data: edgebreaker,
                points: topology.points,
                faces,
            }
        } else {
            Encoded {
                data: sequential,
                points: mesh.points,
                faces,
            }
        }
    };
    if mesh.attributes.iter().any(|a| a.kind == 0) {
        let grouped = topology::plan_groups(&mesh)?;
        let data = sequential::encode_grouped(&mesh, &grouped)?;
        if data.len() < result.data.len() {
            result = Encoded {
                data,
                points: grouped.topology.points,
                faces,
            };
        }
        if mesh.encode_speed.max(mesh.decode_speed) < 8 {
            let degree = topology::with_prediction_degree(grouped)?;
            let data = sequential::encode_grouped(&mesh, &degree)?;
            if data.len() < result.data.len() {
                result = Encoded {
                    data,
                    points: degree.topology.points,
                    faces,
                };
            }
            drop(degree);
            for seed in topology::seed_candidates(&mesh).into_iter().skip(1) {
                let grouped = topology::plan_groups_seed(&mesh, seed)?;
                let data = sequential::encode_grouped(&mesh, &grouped)?;
                if data.len() < result.data.len() {
                    result = Encoded {
                        data,
                        points: grouped.topology.points,
                        faces,
                    };
                }
            }
        }
    }
    Ok(result)
}

fn scalar_size(kind: u8) -> Option<usize> {
    match kind {
        1 | 2 => Some(1),
        3 | 4 => Some(2),
        5 | 6 | 9 => Some(4),
        _ => None,
    }
}

/// Original packet ABI: header points/indices/attributes/speeds, indices, then
/// kind/type/width/normalized/bits/grid flag and packed scalar bytes per attribute.
pub fn encode_packet(packet: &[u8]) -> Result<Vec<u8>, &'static str> {
    Ok(encode_packet_result(packet)?.data)
}

fn encode_packet_result(packet: &[u8]) -> Result<Encoded, &'static str> {
    encode_owned(parse_packet(packet)?)
}

/// The mesh a packet holds, copied out of it.
fn parse_packet(packet: &[u8]) -> Result<Mesh, &'static str> {
    struct Reader<'a> {
        bytes: &'a [u8],
        offset: usize,
    }
    impl<'a> Reader<'a> {
        fn bytes(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
            let end = self.offset.checked_add(n).ok_or("packet overflow")?;
            let bytes = self.bytes.get(self.offset..end).ok_or("truncated packet")?;
            self.offset = end;
            Ok(bytes)
        }
        fn u32(&mut self) -> Result<u32, &'static str> {
            Ok(u32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
        }
        fn float(&mut self) -> Result<f32, &'static str> {
            Ok(f32::from_bits(self.u32()?))
        }
    }
    let mut reader = Reader {
        bytes: packet,
        offset: 0,
    };
    let points = reader.u32()? as usize;
    let count = reader.u32()? as usize;
    let num_attributes = reader.u32()? as usize;
    let speeds = reader.u32()?;
    if points > 16777216 || count > 50331648 || num_attributes > 255 {
        return Err("packet exceeds limits");
    }
    let indices = reader
        .bytes(count.checked_mul(4).ok_or("packet overflow")?)?
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let mut attributes = Vec::with_capacity(num_attributes);
    for _ in 0..num_attributes {
        let info = reader.bytes(8)?;
        let (kind, data_type, width, normalized, bits, grid_flag) = (
            info[0],
            info[1],
            info[2] as usize,
            info[3] != 0,
            info[4],
            info[5],
        );
        let size = scalar_size(data_type).ok_or("unsupported scalar type")?;
        if width == 0 || width > 4 {
            return Err("invalid width");
        }
        let grid = if grid_flag != 0 {
            let mut origin = Vec::with_capacity(width);
            for _ in 0..width {
                origin.push(reader.float()?);
            }
            Some((origin, reader.float()?))
        } else {
            None
        };
        let length = points
            .checked_mul(width)
            .and_then(|n| n.checked_mul(size))
            .ok_or("packet overflow")?;
        attributes.push(Attribute {
            kind,
            data_type,
            width,
            normalized,
            bits,
            grid,
            bytes: reader.bytes(length)?.to_vec(),
        });
    }
    if reader.offset != packet.len() {
        return Err("trailing packet bytes");
    }
    Ok(Mesh {
        points,
        indices,
        attributes,
        encode_speed: speeds as u8,
        decode_speed: (speeds >> 8) as u8,
    })
}

/// Encodes a mesh it owns: its copy goes once merged, so it is not held beside the merged mesh (KB0035).
fn encode_owned(mesh: Mesh) -> Result<Encoded, &'static str> {
    let compacted = validated_compact(&mesh)?;
    drop(mesh);
    encode_compacted(compacted)
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::alloc::{alloc, dealloc, Layout};
    use std::sync::Mutex;
    static OUTPUT: Mutex<super::Encoded> = Mutex::new(super::Encoded {
        data: Vec::new(),
        points: 0,
        faces: 0,
    });
    #[no_mangle]
    pub extern "C" fn encoder_alloc(length: usize) -> *mut u8 {
        if length == 0 || length > super::INPUT_LIMIT {
            return std::ptr::null_mut();
        }
        unsafe { alloc(Layout::from_size_align(length, 8).unwrap()) }
    }
    #[no_mangle]
    pub unsafe extern "C" fn encoder_free(pointer: *mut u8, length: usize) {
        if !pointer.is_null() && length > 0 {
            dealloc(pointer, Layout::from_size_align(length, 8).unwrap());
        }
    }
    /// Encodes the packet at `pointer`, which `encoder_alloc` gave, and frees it once read (the caller does not):
    /// the packet is not held while the mesh encodes (KB0035).
    #[no_mangle]
    pub unsafe extern "C" fn encoder_encode(pointer: *mut u8, length: usize) -> u32 {
        let mut output = OUTPUT.lock().unwrap();
        output.data.clear();
        output.points = 0;
        output.faces = 0;
        let mesh = super::parse_packet(std::slice::from_raw_parts(pointer, length));
        encoder_free(pointer, length);
        match mesh.and_then(super::encode_owned) {
            Ok(encoded) => {
                *output = encoded;
                0
            }
            Err("attribute range not representable") => 2,
            Err(_) => 1,
        }
    }
    #[no_mangle]
    pub extern "C" fn encoder_output_pointer() -> *const u8 {
        OUTPUT.lock().unwrap().data.as_ptr()
    }
    #[no_mangle]
    pub extern "C" fn encoder_output_length() -> usize {
        OUTPUT.lock().unwrap().data.len()
    }
    #[no_mangle]
    pub extern "C" fn encoder_output_points() -> usize {
        OUTPUT.lock().unwrap().points
    }
    #[no_mangle]
    pub extern "C" fn encoder_output_faces() -> usize {
        OUTPUT.lock().unwrap().faces
    }
    #[no_mangle]
    pub extern "C" fn encoder_clear() {
        OUTPUT.lock().unwrap().data = Vec::new();
    }
}
