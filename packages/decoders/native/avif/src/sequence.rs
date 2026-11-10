use crate::bits::Bits;
use crate::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Color {
    pub depth: u32,
    pub monochrome: bool,
    pub primaries: u32,
    pub transfer: u32,
    pub matrix: u32,
    pub full_range: bool,
    pub sub_x: bool,
    pub sub_y: bool,
    pub position: u32,
    pub separate_uv_delta_q: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperatingPoint {
    pub idc: u32,
    pub level: u32,
    pub tier: bool,
    pub decoder_model: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sequence {
    pub profile: u32,
    pub still_picture: bool,
    pub reduced: bool,
    pub width_bits: u32,
    pub height_bits: u32,
    pub max_width: u32,
    pub max_height: u32,
    pub frame_id_bits: u32,
    pub delta_frame_id_bits: u32,
    pub superblock_128: bool,
    pub filter_intra: bool,
    pub intra_edge_filter: bool,
    pub screen_content_tools: u32,
    pub integer_mv: u32,
    pub order_hint_bits: u32,
    pub superres: bool,
    pub cdef: bool,
    pub restoration: bool,
    pub color: Color,
    pub film_grain: bool,
    pub equal_picture_interval: bool,
    pub buffer_removal_bits: u32,
    pub frame_presentation_bits: u32,
    pub operating_points: Vec<OperatingPoint>,
}

impl Sequence {
    pub fn parse(data: &[u8]) -> Result<Self> {
        let mut b = Bits::new(data);
        let profile = b.read(3)?;
        if profile > 2 {
            return Err(Error::Invalid);
        }
        let still_picture = b.flag()?;
        let reduced = b.flag()?;
        if reduced && !still_picture {
            return Err(Error::Invalid);
        }
        let mut equal_picture_interval = false;
        let mut buffer_removal_bits = 0;
        let mut frame_presentation_bits = 0;
        let mut operating_points = Vec::new();
        if reduced {
            operating_points.push(OperatingPoint {
                idc: 0,
                level: b.read(5)?,
                tier: false,
                decoder_model: false,
            });
        } else {
            let mut delay_bits = 0;
            if b.flag()? {
                let units = b.read(32)?;
                let scale = b.read(32)?;
                if units == 0 || scale == 0 {
                    return Err(Error::Invalid);
                }
                equal_picture_interval = b.flag()?;
                if equal_picture_interval {
                    b.uvlc()?;
                }
                if b.flag()? {
                    delay_bits = b.read(5)? + 1;
                    if b.read(32)? == 0 {
                        return Err(Error::Invalid);
                    }
                    buffer_removal_bits = b.read(5)? + 1;
                    frame_presentation_bits = b.read(5)? + 1;
                }
            }
            let initial_display_delay = b.flag()?;
            let count = b.read(5)? + 1;
            for _ in 0..count {
                let idc = b.read(12)?;
                let level = b.read(5)?;
                let tier = level > 7 && b.flag()?;
                let decoder_model = delay_bits > 0 && b.flag()?;
                if decoder_model {
                    b.read(delay_bits)?;
                    b.read(delay_bits)?;
                    b.flag()?;
                }
                if initial_display_delay && b.flag()? {
                    b.read(4)?;
                }
                operating_points.push(OperatingPoint {
                    idc,
                    level,
                    tier,
                    decoder_model,
                });
            }
        }
        if operating_points
            .iter()
            .any(|op| op.level > 23 && op.level != 31)
        {
            return Err(Error::Invalid);
        }
        let width_bits = b.read(4)? + 1;
        let height_bits = b.read(4)? + 1;
        let max_width = b.read(width_bits)? + 1;
        let max_height = b.read(height_bits)? + 1;
        let mut frame_id_bits = 0;
        let mut delta_frame_id_bits = 0;
        if !reduced && b.flag()? {
            delta_frame_id_bits = b.read(4)? + 2;
            frame_id_bits = delta_frame_id_bits + b.read(3)? + 1;
            if frame_id_bits > 16 {
                return Err(Error::Invalid);
            }
        }
        let superblock_128 = b.flag()?;
        let filter_intra = b.flag()?;
        let intra_edge_filter = b.flag()?;
        let mut order_hint_bits = 0;
        let mut screen_content_tools = 2;
        let mut integer_mv = 2;
        if !reduced {
            b.read(4)?; // Inter-intra, masked compound, warped motion and dual interpolation.
            let order_hint = b.flag()?;
            if order_hint {
                b.read(2)?; // Joint compound and reference-frame motion vectors.
            }
            if !b.flag()? {
                screen_content_tools = b.read(1)?;
            }
            if screen_content_tools > 0 && !b.flag()? {
                integer_mv = b.read(1)?;
            }
            if order_hint {
                order_hint_bits = b.read(3)? + 1;
            }
        }
        let superres = b.flag()?;
        let cdef = b.flag()?;
        let restoration = b.flag()?;
        let color = Color::parse(&mut b, profile)?;
        let film_grain = b.flag()?;
        b.trailing()?;
        Ok(Self {
            profile,
            still_picture,
            reduced,
            width_bits,
            height_bits,
            max_width,
            max_height,
            frame_id_bits,
            delta_frame_id_bits,
            superblock_128,
            filter_intra,
            intra_edge_filter,
            screen_content_tools,
            integer_mv,
            order_hint_bits,
            superres,
            cdef,
            restoration,
            color,
            film_grain,
            equal_picture_interval,
            buffer_removal_bits,
            frame_presentation_bits,
            operating_points,
        })
    }
}

impl Color {
    fn parse(b: &mut Bits<'_>, profile: u32) -> Result<Self> {
        let high = b.flag()?;
        let depth = if high {
            if profile == 2 && b.flag()? { 12 } else { 10 }
        } else {
            8
        };
        let monochrome = profile != 1 && b.flag()?;
        let (primaries, transfer, matrix) = if b.flag()? {
            (b.read(8)?, b.read(8)?, b.read(8)?)
        } else {
            (2, 2, 2)
        };
        let full_range;
        let sub_x;
        let sub_y;
        let mut position = 0;
        if monochrome {
            full_range = b.flag()?;
            sub_x = true;
            sub_y = true;
        } else if primaries == 1 && transfer == 13 && matrix == 0 {
            full_range = true;
            sub_x = false;
            sub_y = false;
        } else {
            full_range = b.flag()?;
            (sub_x, sub_y) = match profile {
                0 => (true, true),
                1 => (false, false),
                _ if depth == 12 => {
                    let x = b.flag()?;
                    (x, x && b.flag()?)
                }
                _ => (true, false),
            };
            if sub_x && sub_y {
                position = b.read(2)?;
                if position == 3 {
                    return Err(Error::Invalid);
                }
            }
        }
        let separate_uv_delta_q = !monochrome && b.flag()?;
        if matrix == 0 && (sub_x || sub_y) {
            return Err(Error::Invalid);
        }
        Ok(Self {
            depth,
            monochrome,
            primaries,
            transfer,
            matrix,
            full_range,
            sub_x,
            sub_y,
            position,
            separate_uv_delta_q,
        })
    }
}
