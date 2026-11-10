//! Clean-room UASTC HDR 6x6i and ASTC HDR, from their published specifications.
mod astc;
mod intermediate;
mod ise;
mod tables;
#[cfg(target_arch = "wasm32")]
mod wasm;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Truncated,
    Invalid,
    Limit,
}
pub type Result<T> = std::result::Result<T, Error>;

/// Return standard ASTC HDR 6x6 blocks from an intermediate image stream.
pub fn transcode(data: &[u8], width: usize, height: usize) -> Result<Vec<u8>> {
    intermediate::decode(data, width, height)
}
/// Decode every ASTC block, clipping the padded right and bottom texels.
pub fn decode(data: &[u8], width: usize, height: usize) -> Result<Vec<u16>> {
    decode_mode(data, width, height, false)
}
pub fn decode_mode(data: &[u8], width: usize, height: usize, shared: bool) -> Result<Vec<u16>> {
    if width == 0 || height == 0 || width.checked_mul(height).is_none_or(|v| v > 67_108_864) {
        return Err(Error::Limit);
    }
    let columns = width.div_ceil(6);
    let rows = height.div_ceil(6);
    if data.len() != columns * rows * 16 {
        return Err(Error::Invalid);
    }
    let channels = if shared { 2 } else { 4 };
    let mut out = vec![0; width * height * channels];
    for (i, bytes) in data.chunks_exact(16).enumerate() {
        let pixels = astc::pixels(&astc::unpack(bytes)?, shared)?;
        for y in 0..6 {
            let py = i / columns * 6 + y;
            if py >= height {
                break;
            }
            for x in 0..6 {
                let px = i % columns * 6 + x;
                if px >= width {
                    break;
                }
                out[(py * width + px) * channels..(py * width + px + 1) * channels]
                    .copy_from_slice(&pixels[(y * 6 + x) * channels..(y * 6 + x + 1) * channels]);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_intermediate_modes_pack_and_unpack() {
        for (i, m) in tables::MODES.iter().enumerate() {
            let dual = m[0] != 0;
            let (w, h) = if !dual && m[3] == 2 && m[4] == 2 {
                (4, 4)
            } else {
                (m[3], m[4])
            };
            let count = if m[1] == 7 { 4 } else { 6 };
            let block = astc::Block {
                width: w,
                height: h,
                weight_levels: m[8],
                dual,
                channel: m[9],
                partitions: m[2],
                seed: 0,
                modes: vec![m[1]; m[2]],
                endpoint_levels: m[7],
                endpoints: vec![0; count * m[2]],
                weights: vec![0; w * h * if dual { 2 } else { 1 }],
                solid: None,
            };
            let bytes = astc::pack(&block).unwrap_or_else(|e| panic!("mode {i}: {e:?}"));
            let decoded = astc::unpack(&bytes).unwrap();
            assert_eq!(decoded.endpoints, block.endpoints);
            assert_eq!(decoded.weights, block.weights);
            assert_eq!(astc::pixels(&decoded, false).unwrap().len(), 144);
        }
    }
}
