//! Private owned-buffer ABI, not a public TypeScript export.
use crate::{Error, Geometry, Limits, Result};

fn put(out: &mut Vec<u8>, n: u32) {
    out.extend_from_slice(&n.to_le_bytes());
}
fn metadata_size(metadata: &crate::Metadata) -> Result<usize> {
    let mut size = 16_usize
        .checked_add(
            metadata
                .attributes
                .len()
                .checked_mul(8)
                .ok_or(Error::Overflow)?,
        )
        .ok_or(Error::Overflow)?;
    for node in &metadata.nodes {
        size = size.checked_add(8).ok_or(Error::Overflow)?;
        for entry in &node.entries {
            size = size
                .checked_add(8)
                .and_then(|n| n.checked_add(entry.key.len()))
                .and_then(|n| n.checked_add(entry.value.len()))
                .ok_or(Error::Overflow)?;
        }
        for (name, _) in &node.children {
            size = size
                .checked_add(8)
                .and_then(|n| n.checked_add(name.len()))
                .ok_or(Error::Overflow)?;
        }
    }
    Ok(size)
}
fn metadata_buffer(out: &mut Vec<u8>, metadata: crate::Metadata) {
    put(out, 0x4154_454d); // META, private ABI trailer present only with metadata.
    put(out, metadata.nodes.len() as u32);
    put(out, metadata.attributes.len() as u32);
    put(out, metadata.file as u32);
    for (id, root) in metadata.attributes {
        put(out, id);
        put(out, root as u32);
    }
    for node in metadata.nodes {
        put(out, node.entries.len() as u32);
        put(out, node.children.len() as u32);
        for entry in node.entries {
            put(out, entry.key.len() as u32);
            out.extend_from_slice(&entry.key);
            put(out, entry.value.len() as u32);
            out.extend_from_slice(&entry.value);
        }
        for (name, child) in node.children {
            put(out, name.len() as u32);
            out.extend_from_slice(&name);
            put(out, child as u32);
        }
    }
}
// Out of line (KB4824a): its copy loops are optimized apart from the entry point.
#[inline(never)]
fn result_buffer(result: Result<Geometry>) -> Result<Box<[u8]>> {
    let size = match &result {
        Err(_) => 8,
        Ok(g) => {
            let mut n = 24_usize
                .checked_add(g.indices.len().checked_mul(4).ok_or(Error::Overflow)?)
                .ok_or(Error::Overflow)?;
            for a in &g.attributes {
                n = n
                    .checked_add(12)
                    .and_then(|n| n.checked_add(a.data.len()))
                    .ok_or(Error::Overflow)?;
            }
            if let Some(metadata) = &g.metadata {
                n = n
                    .checked_add(metadata_size(metadata)?)
                    .ok_or(Error::Overflow)?;
            }
            n
        }
    };
    let mut out = Vec::new();
    out.try_reserve_exact(size).map_err(|_| Error::Limit)?;
    put(&mut out, size as u32);
    match result {
        Err(e) => put(&mut out, e as u32),
        Ok(g) => {
            put(&mut out, 0);
            put(&mut out, g.points as u32);
            put(&mut out, u32::from(g.mesh));
            put(&mut out, g.indices.len() as u32);
            put(&mut out, g.attributes.len() as u32);
            for index in g.indices {
                put(&mut out, index);
            }
            for a in g.attributes {
                out.extend_from_slice(&[
                    a.semantic,
                    a.data_type,
                    a.components,
                    u8::from(a.normalized),
                ]);
                put(&mut out, a.unique_id);
                put(&mut out, a.data.len() as u32);
                out.extend_from_slice(&a.data);
            }
            if let Some(metadata) = g.metadata {
                metadata_buffer(&mut out, metadata);
            }
        }
    }
    Ok(out.into_boxed_slice())
}

#[unsafe(no_mangle)]
pub extern "C" fn draco_alloc(len: u32) -> u32 {
    if len == 0 || len > 256 * 1024 * 1024 {
        return 0;
    }
    let mut data = Vec::new();
    if data.try_reserve_exact(len as usize).is_err() {
        return 0;
    }
    data.resize(len as usize, 0_u8);
    Box::into_raw(data.into_boxed_slice()) as *mut u8 as u32
}

/// JS owns allocations and passes their exact lengths back once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn draco_free(ptr: u32, len: u32) {
    if ptr != 0 && len != 0 {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
                ptr as *mut u8,
                len as usize,
            )));
        }
    }
}

/// The caller keeps its input allocation alive until this synchronous call ends.
/// Returned storage starts with its total byte length and is freed by draco_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn draco_decode(
    ptr: u32,
    len: u32,
    vertices: u32,
    indices: u32,
    bytes: u32,
    flavor: u32,
) -> u32 {
    let end = ptr.checked_add(len);
    let result = if ptr == 0
        || len == 0
        || len > 256 * 1024 * 1024
        || end.is_none()
        || flavor > 1
        || u64::from(end.unwrap()) > core::arch::wasm32::memory_size(0) as u64 * 65536
    {
        Err(Error::Invalid)
    } else {
        let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
        let decode = if flavor == 1 {
            crate::decode_gltf
        } else {
            crate::decode
        };
        decode(
            input,
            Limits {
                vertices: vertices as usize,
                indices: indices as usize,
                bytes: bytes as usize,
            },
        )
    };
    match result_buffer(result) {
        Ok(out) => Box::into_raw(out) as *mut u8 as u32,
        Err(_) => 0,
    }
}
