use crate::bits::Bits;
use crate::filters;
use crate::frame::Frame;
use crate::obu::Obus;
use crate::reconstruct::Reconstruction;
use crate::restore_filter::{self, ImagePlane};
use crate::sequence::Sequence;
use crate::{Error, Result};

pub struct Decoded {
    pub sequence: Sequence,
    pub frame: Frame,
    pub planes: Vec<ImagePlane>,
    pub tool_counts: [u32; 4],
}
/// Decode a single independently coded AV1 image item. Container display transformations
/// and color conversion are deliberately later stages, so the normative YUV output is testable.
pub fn obus(bytes: &[u8], max_pixels: u64) -> Result<Decoded> {
    bounded_obus(bytes, max_pixels, 1024 << 20)
}
pub fn bounded_obus(bytes: &[u8], max_pixels: u64, memory: usize) -> Result<Decoded> {
    let mut sequence = None;
    let mut frame = None;
    let mut output = None;
    let mut next_tile = 0;
    let mut complete = false;
    let mut header_payload = None;
    for obu in Obus::sample(bytes) {
        let obu = obu?;
        match obu.kind {
            1 => {
                if sequence.is_some() || frame.is_some() {
                    return Err(Error::Invalid);
                }
                sequence = Some(Sequence::parse(obu.payload)?);
            }
            2 => {
                if !obu.payload.is_empty() || (frame.is_some() && !complete) {
                    return Err(Error::Invalid);
                }
            }
            3 | 6 => {
                if frame.is_some() {
                    return Err(Error::Unsupported);
                }
                let seq = sequence.as_ref().ok_or(Error::Invalid)?;
                let mut b = Bits::new(obu.payload);
                let parsed =
                    Frame::parse(&mut b, seq, obu.temporal_id, obu.spatial_id, max_pixels)?;
                let padded = (parsed.width as usize)
                    .div_ceil(128)
                    .checked_mul(128)
                    .and_then(|w| w.checked_mul((parsed.height as usize).div_ceil(128) * 128))
                    .ok_or(Error::Limit)?;
                if padded.checked_mul(128).is_none_or(|n| n > memory) {
                    return Err(Error::Limit);
                }
                let mut reconstructed = Reconstruction::new(seq, &parsed);
                if obu.kind == 3 {
                    header_payload = Some(obu.payload);
                    b.trailing()?;
                } else {
                    b.align()?;
                    for (id, data) in parsed
                        .tiles
                        .group(&obu.payload[b.position() / 8..], next_tile)?
                    {
                        reconstructed.tile(seq, &parsed, id, data)?;
                        next_tile += 1;
                    }
                }
                complete =
                    next_tile == (parsed.tiles.columns.len() - 1) * (parsed.tiles.rows.len() - 1);
                frame = Some(parsed);
                output = Some(reconstructed);
            }
            4 => {
                if complete {
                    return Err(Error::Invalid);
                }
                let seq = sequence.as_ref().ok_or(Error::Invalid)?;
                let parsed = frame.as_ref().ok_or(Error::Invalid)?;
                let reconstructed = output.as_mut().ok_or(Error::Invalid)?;
                for (id, data) in parsed.tiles.group(obu.payload, next_tile)? {
                    reconstructed.tile(seq, parsed, id, data)?;
                    next_tile += 1;
                }
                complete =
                    next_tile == (parsed.tiles.columns.len() - 1) * (parsed.tiles.rows.len() - 1);
            }
            7 => {
                if complete || header_payload != Some(obu.payload) {
                    return Err(Error::Invalid);
                }
            }
            5 | 15 => {} // Descriptive metadata and OBU padding do not alter coded samples.
            8 => return Err(Error::Unsupported),
            _ => {} // Reserved sized OBUs are skipped as required by the specification.
        }
    }
    if !complete {
        return Err(Error::Truncated);
    }
    let seq = sequence.ok_or(Error::Invalid)?;
    let frame = frame.ok_or(Error::Invalid)?;
    let mut output = output.ok_or(Error::Invalid)?;
    filters::deblock(&mut output, &seq, &frame);
    let cdef = filters::cdef(&output, &seq, &frame);
    let before: Vec<Vec<u16>> = output.planes.iter().map(|p| p.data.clone()).collect();
    let before = restore_filter::upscale(&before, &output, &seq, &frame);
    let after = restore_filter::upscale(&cdef, &output, &seq, &frame);
    let mut planes = restore_filter::restore(&before, &after, &output, &seq, &frame);
    crate::grain::apply(&mut planes, &seq.color, &frame.grain);
    let mut tools = [output.tool_counts[0], output.tool_counts[1], 0, 0];
    for p in &output.restoration.planes {
        for unit in &p.units {
            if unit.mode == 1 {
                tools[2] += 1;
            } else if unit.mode == 2 {
                tools[3] += 1;
            }
        }
    }
    Ok(Decoded {
        sequence: seq,
        frame,
        planes,
        tool_counts: tools,
    })
}
