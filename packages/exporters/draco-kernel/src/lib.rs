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

fn compact(mesh: &Mesh) -> Mesh {
    let mut unique = std::collections::HashMap::<Vec<u8>, u32>::new();
    let mut point_map = vec![u32::MAX; mesh.points];
    let mut sequence = Vec::new();
    let strides: Vec<usize> = mesh
        .attributes
        .iter()
        .map(|a| a.width * scalar_size(a.data_type).unwrap())
        .collect();
    let row_bytes: usize = strides.iter().sum();
    let mut key = Vec::with_capacity(row_bytes);
    let indices = mesh
        .indices
        .iter()
        .map(|&point| {
            let point = point as usize;
            if point_map[point] != u32::MAX {
                return point_map[point];
            }
            key.clear();
            for (a, &stride) in mesh.attributes.iter().zip(&strides) {
                key.extend(&a.bytes[point * stride..(point + 1) * stride]);
            }
            let id = if let Some(&id) = unique.get(&key) {
                id
            } else {
                let id = sequence.len() as u32;
                unique.insert(key.clone(), id);
                sequence.push(point);
                id
            };
            point_map[point] = id;
            id
        })
        .collect();
    let mut attributes = mesh.attributes.clone();
    for (a, &stride) in attributes.iter_mut().zip(&strides) {
        let mut bytes = Vec::with_capacity(sequence.len() * stride);
        for &point in &sequence {
            bytes.extend(&a.bytes[point * stride..(point + 1) * stride]);
        }
        a.bytes = bytes;
    }
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
    let mesh = compact(mesh);
    let sequential = sequential::encode(&mesh)?;
    let faces = mesh.indices.len() / 3;
    if mesh.encode_speed == 10 || mesh.decode_speed == 10 {
        return Ok(Encoded {
            data: sequential,
            points: mesh.points,
            faces,
        });
    }
    let topology = topology::plan(&mesh)?;
    let edgebreaker = sequential::encode_edgebreaker(&mesh, &topology)?;
    let mut result = if edgebreaker.len() < sequential.len() {
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
            for seed in topology::seed_candidates(&mesh).into_iter().skip(1) {
                let grouped = topology::plan_groups_seed(&mesh, seed)?;
                let data = sequential::encode_grouped(&mesh, &grouped)?;
                if data.len() < result.data.len() {
                    result = Encoded { data, points: grouped.topology.points, faces };
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
    encode_result(&Mesh {
        points,
        indices,
        attributes,
        encode_speed: speeds as u8,
        decode_speed: (speeds >> 8) as u8,
    })
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
        if length == 0 || length > 268435456 {
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
    #[no_mangle]
    pub unsafe extern "C" fn encoder_encode(pointer: *const u8, length: usize) -> u32 {
        let mut output = OUTPUT.lock().unwrap();
        output.data.clear();
        output.points = 0;
        output.faces = 0;
        match super::encode_packet_result(std::slice::from_raw_parts(pointer, length)) {
            Ok(encoded) => {
                *output = encoded;
                0
            }
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
