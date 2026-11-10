//! HEIF item composition and encoded RGB output. ICC and CICP are retained, not silently discarded.
use crate::container::{File, Property};
use crate::decode::{self, Decoded};
use crate::restore_filter::ImagePlane;
use crate::sequence::Color;
use crate::{Error, Result};

pub struct Image {
    pub width: usize,
    pub height: usize,
    /// Straight alpha RGBA, normalized to 0..65535, retaining source encoded transfer values.
    pub rgba: Vec<u16>,
    pub depth: u32,
    pub color: Color,
    pub icc: Vec<u8>,
    raster: Option<Raster>,
}
struct Raster {
    width: usize,
    height: usize,
    color: Color,
    planes: Vec<ImagePlane>,
}
#[derive(Clone, Copy)]
pub struct Limits {
    pub pixels: u64,
    pub memory: usize,
}
impl Limits {
    fn dimensions(&self, w: usize, h: usize) -> Result<usize> {
        let n = w.checked_mul(h).ok_or(Error::Limit)?;
        if w == 0
            || h == 0
            || n as u64 > self.pixels
            || n.checked_mul(8).is_none_or(|v| v > self.memory)
        {
            return Err(Error::Limit);
        }
        Ok(n)
    }
}
pub fn decode(bytes: &[u8], limits: Limits) -> Result<Image> {
    if bytes.len() > limits.memory / 2 {
        return Err(Error::Limit);
    }
    let file = File::parse(bytes)?;
    let mut budget = limits.memory - bytes.len();
    let mut image = item(&file, file.primary, limits, &mut Vec::new(), &mut budget)?;
    image.raster = None;
    if let Some(alpha_id) = file.alpha(file.primary)? {
        let alpha = item(&file, alpha_id, limits, &mut Vec::new(), &mut budget)?;
        if !alpha.color.monochrome || !alpha.color.full_range {
            return Err(Error::Invalid);
        }
        if alpha.width != image.width || alpha.height != image.height {
            return Err(Error::Invalid);
        }
        let premultiplied = file.items[&file.primary]
            .references
            .get(b"prem")
            .is_some_and(|ids| ids.as_slice() == [alpha_id]);
        for (pixel, a) in image
            .rgba
            .chunks_exact_mut(4)
            .zip(alpha.rgba.chunks_exact(4))
        {
            pixel[3] = a[0];
            if premultiplied {
                for c in &mut pixel[..3] {
                    *c = if a[0] == 0 {
                        0
                    } else {
                        ((*c as u64 * 65535 + a[0] as u64 / 2) / a[0] as u64).min(65535) as u16
                    };
                }
            }
        }
    }
    Ok(image)
}
fn item(
    file: &File<'_>,
    id: u32,
    limits: Limits,
    path: &mut Vec<u32>,
    budget: &mut usize,
) -> Result<Image> {
    if path.len() >= 32 || path.contains(&id) {
        return Err(Error::Invalid);
    }
    path.push(id);
    let properties = file.item_properties(id)?;
    let info = file.items.get(&id).ok_or(Error::Invalid)?;
    let bytes = file.item_data(id, (*budget).min(limits.memory / 2))?;
    let mut image = match &info.kind {
        b"av01" => {
            // Scratch arrays include padded block state and both filter generations.
            // Bound them before Reconstruction allocates, independently of output dimensions.
            let scratch_pixels = (*budget / 128) as u64;
            let decoded = decode::bounded_obus(&bytes, limits.pixels.min(scratch_pixels), *budget)?;
            validate(&decoded, &properties)?;
            let n = limits.dimensions(
                decoded.frame.upscaled_width as usize,
                decoded.frame.height as usize,
            )?;
            *budget = budget.checked_sub(n * 8).ok_or(Error::Limit)?;
            let mut image = rgb(&decoded, &properties)?;
            image.raster = Some(Raster {
                width: image.width,
                height: image.height,
                color: image.color.clone(),
                planes: decoded.planes,
            });
            image
        }
        b"iden" => {
            let refs = info.references.get(b"dimg").ok_or(Error::Invalid)?;
            if refs.len() != 1 || !bytes.is_empty() {
                return Err(Error::Invalid);
            }
            item(file, refs[0], limits, path, budget)?
        }
        b"grid" => {
            if bytes.len() < 8 || bytes[0] != 0 || bytes[1] & !1 != 0 {
                return Err(Error::Invalid);
            }
            let rows = bytes[2] as usize + 1;
            let cols = bytes[3] as usize + 1;
            let unit = if bytes[1] & 1 != 0 { 4 } else { 2 };
            if bytes.len() != 4 + 2 * unit {
                return Err(Error::Invalid);
            }
            let uint = |at: usize| {
                bytes[at..at + unit]
                    .iter()
                    .fold(0usize, |n, b| n * 256 + *b as usize)
            };
            let width = uint(4);
            let height = uint(4 + unit);
            let n = limits.dimensions(width, height)?;
            *budget = budget.checked_sub(n * 8).ok_or(Error::Limit)?;
            let refs = info.references.get(b"dimg").ok_or(Error::Invalid)?;
            if refs.len() != rows * cols {
                return Err(Error::Invalid);
            }
            let mut result: Option<Image> = None;
            let mut cell = [0; 2];
            for (index, &child) in refs.iter().enumerate() {
                // AVIF forbids transforms within a grid's derivation chain.
                if file.item_properties(child)?.iter().any(|p| {
                    matches!(
                        p,
                        Property::Rotation(_) | Property::Mirror(_) | Property::Aperture(_)
                    )
                }) {
                    return Err(Error::Invalid);
                }
                let before = *budget;
                let mut tile = item(file, child, limits, path, budget)?;
                *budget = before; // The tile is consumed immediately and dropped before the next one.
                if result.is_none() {
                    cell = [tile.width, tile.height];
                    if width > cols * cell[0]
                        || height > rows * cell[1]
                        || width <= (cols - 1) * cell[0]
                        || height <= (rows - 1) * cell[1]
                    {
                        return Err(Error::Invalid);
                    }
                    let mut planes = Vec::new();
                    for p in 0..if tile.color.monochrome { 1 } else { 3 } {
                        let sx = usize::from(p > 0 && tile.color.sub_x);
                        let sy = usize::from(p > 0 && tile.color.sub_y);
                        if (cols > 1 && cell[0] % (1 << sx) != 0)
                            || (rows > 1 && cell[1] % (1 << sy) != 0)
                        {
                            return Err(Error::Invalid);
                        }
                        let w = width.div_ceil(1 << sx);
                        let h = height.div_ceil(1 << sy);
                        *budget = budget.checked_sub(w * h * 2).ok_or(Error::Limit)?;
                        planes.push(ImagePlane {
                            width: w,
                            height: h,
                            data: vec![0; w * h],
                        });
                    }
                    result = Some(Image {
                        width,
                        height,
                        rgba: Vec::new(),
                        depth: tile.depth,
                        color: tile.color.clone(),
                        icc: tile.icc.clone(),
                        raster: Some(Raster {
                            width,
                            height,
                            color: tile.color.clone(),
                            planes,
                        }),
                    });
                }
                let out = result.as_mut().ok_or(Error::Invalid)?;
                if [tile.width, tile.height] != cell
                    || tile.depth != out.depth
                    || tile.color != out.color
                    || tile.icc != out.icc
                {
                    return Err(Error::Invalid);
                }
                let ox = index % cols * cell[0];
                let oy = index / cols * cell[1];
                let source = tile.raster.take().ok_or(Error::Invalid)?;
                let target = out.raster.as_mut().ok_or(Error::Invalid)?;
                for (p, plane) in source.planes.iter().enumerate() {
                    let sx = usize::from(p > 0 && out.color.sub_x);
                    let sy = usize::from(p > 0 && out.color.sub_y);
                    let target = &mut target.planes[p];
                    let x = ox >> sx;
                    let y = oy >> sy;
                    let count = plane.width.min(target.width - x);
                    for row in 0..plane.height.min(target.height - y) {
                        target.data
                            [(y + row) * target.width + x..(y + row) * target.width + x + count]
                            .copy_from_slice(
                                &plane.data[row * plane.width..row * plane.width + count],
                            );
                    }
                }
            }
            let mut result = result.ok_or(Error::Invalid)?;
            let raster = result.raster.take().ok_or(Error::Invalid)?;
            let mut converted = rgb_planes(
                raster.width,
                raster.height,
                &raster.color,
                &raster.planes,
                &properties,
            )?;
            converted.icc = result.icc;
            converted.raster = Some(Raster {
                color: converted.color.clone(),
                ..raster
            });
            converted
        }
        _ => return Err(Error::Unsupported),
    };
    let spatial: Vec<_> = properties
        .iter()
        .filter_map(|p| {
            if let Property::Spatial { width, height } = p {
                Some((*width as usize, *height as usize))
            } else {
                None
            }
        })
        .collect();
    if spatial.len() != 1 || spatial[0] != (image.width, image.height) {
        return Err(Error::Invalid);
    }
    for property in properties {
        match property {
            Property::Aperture(values) => {
                crop(&mut image, values)?;
                image.raster = None;
            }
            Property::Rotation(angle) => {
                rotate(&mut image, *angle);
                image.raster = None;
            }
            Property::Mirror(axis) => {
                mirror(&mut image, *axis);
                image.raster = None;
            }
            Property::Icc(data) => image.icc = data.to_vec(),
            Property::OperatingPoint(point) if *point != 0 => return Err(Error::Unsupported),
            Property::Layer(layer) if *layer != 0 && *layer != 65535 => {
                return Err(Error::Unsupported);
            }
            _ => {}
        }
    }
    path.pop();
    Ok(image)
}
fn validate(decoded: &Decoded, properties: &[&Property<'_>]) -> Result<()> {
    let seq = &decoded.sequence;
    let configs: Vec<_> = properties
        .iter()
        .filter_map(|p| {
            if let Property::Config(bytes) = p {
                Some(*bytes)
            } else {
                None
            }
        })
        .collect();
    if configs.len() != 1 {
        return Err(Error::Invalid);
    }
    let config = configs[0];
    let op = &seq.operating_points[0];
    let flags = (u8::from(op.tier) << 7)
        | (u8::from(seq.color.depth > 8) << 6)
        | (u8::from(seq.color.depth == 12) << 5)
        | (u8::from(seq.color.monochrome) << 4)
        | (u8::from(seq.color.sub_x) << 3)
        | (u8::from(seq.color.sub_y) << 2)
        | seq.color.position as u8;
    if config[1] != ((seq.profile << 5) | op.level) as u8 || config[2] != flags {
        return Err(Error::Invalid);
    }
    if config.len() > 4 {
        for obu in crate::obu::Obus::new(&config[4..]) {
            let obu = obu?;
            if obu.kind == 1 {
                let other = crate::sequence::Sequence::parse(obu.payload)?;
                if other != *seq {
                    return Err(Error::Invalid);
                }
            } else if obu.kind != 5 && obu.kind != 15 {
                return Err(Error::Invalid);
            }
        }
    }
    for property in properties {
        if let Property::Pixels(bits) = property {
            if bits.len() != if seq.color.monochrome { 1 } else { 3 }
                || bits.iter().any(|b| *b as u32 != seq.color.depth)
            {
                return Err(Error::Invalid);
            }
        }
    }
    Ok(())
}
fn rgb(decoded: &Decoded, properties: &[&Property<'_>]) -> Result<Image> {
    rgb_planes(
        decoded.frame.upscaled_width as usize,
        decoded.frame.height as usize,
        &decoded.sequence.color,
        &decoded.planes,
        properties,
    )
}
fn rgb_planes(
    width: usize,
    height: usize,
    source_color: &Color,
    planes: &[ImagePlane],
    properties: &[&Property<'_>],
) -> Result<Image> {
    let mut color = source_color.clone();
    for p in properties {
        if let Property::Color {
            primaries,
            transfer,
            matrix,
            full_range,
        } = p
        {
            color.primaries = *primaries as u32;
            color.transfer = *transfer as u32;
            color.matrix = *matrix as u32;
            color.full_range = *full_range;
        }
    }
    let mut rgba = Vec::with_capacity(width * height * 4);
    let scale = (1 << (color.depth - 8)) as f64;
    let maximum = ((1 << color.depth) - 1) as f64;
    let read = |p: usize, x: usize, y: usize| -> f64 {
        let plane = &planes[p];
        if p == 0 {
            return plane.data[y * plane.width + x] as f64;
        }
        // Centered chroma except the explicitly co-sited axes. Clamp only at image edges.
        let fx = if color.sub_x {
            (x as f64 - if color.position == 0 { 0.5 } else { 0.0 }) / 2.0
        } else {
            x as f64
        };
        let fy = if color.sub_y {
            (y as f64 - if color.position == 2 { 0.0 } else { 0.5 }) / 2.0
        } else {
            y as f64
        };
        let fx = fx.clamp(0.0, (plane.width - 1) as f64);
        let fy = fy.clamp(0.0, (plane.height - 1) as f64);
        let ix = fx as usize;
        let iy = fy as usize;
        let dx = fx - ix as f64;
        let dy = fy - iy as f64;
        let at = |xx: usize, yy: usize| {
            plane.data[yy.min(plane.height - 1) * plane.width + xx.min(plane.width - 1)] as f64
        };
        (at(ix, iy) * (1.0 - dx) + at(ix + 1, iy) * dx) * (1.0 - dy)
            + (at(ix, iy + 1) * (1.0 - dx) + at(ix + 1, iy + 1) * dx) * dy
    };
    let (kr, kb) = crate::color::weights(color.matrix, color.primaries)?;
    for y in 0..height {
        for x in 0..width {
            let yy = read(0, x, y);
            let luma = if color.full_range {
                yy / maximum
            } else {
                (yy - 16.0 * scale) / (219.0 * scale)
            };
            let mut rgb = [luma; 3];
            if !color.monochrome {
                let u = read(1, x, y);
                let v = read(2, x, y);
                let denom = if color.full_range {
                    maximum
                } else {
                    (if color.matrix == 8 { 219.0 } else { 224.0 }) * scale
                };
                let cb = (u - 128.0 * scale) / denom;
                let cr = (v - 128.0 * scale) / denom;
                rgb = match color.matrix {
                    0 => {
                        let offset = if color.full_range { 0.0 } else { 16.0 * scale };
                        let range = if color.full_range {
                            maximum
                        } else {
                            219.0 * scale
                        };
                        [
                            (v - offset) / range,
                            (yy - offset) / range,
                            (u - offset) / range,
                        ]
                    }
                    _ => crate::color::convert(luma, cb, cr, color.matrix, color.transfer, kr, kb)?,
                };
            }
            for value in rgb {
                rgba.push((value.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16);
            }
            rgba.push(65535);
        }
    }
    Ok(Image {
        width,
        height,
        rgba,
        depth: color.depth,
        color,
        icc: Vec::new(),
        raster: None,
    })
}
fn crop(image: &mut Image, values: &[u32; 8]) -> Result<()> {
    // Exact rational arithmetic rejects fractional sample boundaries rather than truncating them.
    let integral = |a: i128, b: i128| {
        if b != 0 && a % b == 0 {
            Ok(a / b)
        } else {
            Err(Error::Invalid)
        }
    };
    let w = integral(values[0] as i128, values[1] as i128)?;
    let h = integral(values[2] as i128, values[3] as i128)?;
    let x = integral(
        (image.width as i128 - w) * values[5] as i128 + 2 * values[4] as i32 as i128,
        2 * values[5] as i128,
    )?;
    let y = integral(
        (image.height as i128 - h) * values[7] as i128 + 2 * values[6] as i32 as i128,
        2 * values[7] as i128,
    )?;
    if x < 0
        || y < 0
        || w <= 0
        || h <= 0
        || x + w > image.width as i128
        || y + h > image.height as i128
    {
        return Err(Error::Invalid);
    }
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    for row in y as usize..(y + h) as usize {
        let at = (row * image.width + x as usize) * 4;
        rgba.extend_from_slice(&image.rgba[at..at + w as usize * 4]);
    }
    image.width = w as usize;
    image.height = h as usize;
    image.rgba = rgba;
    Ok(())
}
fn rotate(image: &mut Image, angle: u8) {
    if angle == 0 {
        return;
    }
    let (w, h) = (image.width, image.height);
    let (nw, nh) = if angle & 1 != 0 { (h, w) } else { (w, h) };
    let mut out = vec![0; image.rgba.len()];
    for y in 0..h {
        for x in 0..w {
            let (xx, yy) = match angle {
                1 => (y, w - 1 - x),
                2 => (w - 1 - x, h - 1 - y),
                _ => (h - 1 - y, x),
            };
            out[(yy * nw + xx) * 4..(yy * nw + xx + 1) * 4]
                .copy_from_slice(&image.rgba[(y * w + x) * 4..(y * w + x + 1) * 4]);
        }
    }
    image.width = nw;
    image.height = nh;
    image.rgba = out;
}
fn mirror(image: &mut Image, axis: u8) {
    let (w, h) = (image.width, image.height);
    for y in 0..if axis == 1 { h / 2 } else { h } {
        for x in 0..if axis == 0 { w / 2 } else { w } {
            let other = if axis == 0 {
                y * w + w - 1 - x
            } else {
                (h - 1 - y) * w + x
            };
            for c in 0..4 {
                image.rgba.swap((y * w + x) * 4 + c, other * 4 + c);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chroma_positions_interpolate_each_axis_at_its_declared_location() {
        // AV1 color_config semantics: CSP_VERTICAL is x=0, y=1/2 in luma units.
        // Independent 4x4 10-bit fixture: U varies only in x, V only in y.
        let planes = [
            ImagePlane {
                width: 4,
                height: 4,
                data: vec![512; 16],
            },
            ImagePlane {
                width: 2,
                height: 2,
                data: vec![384, 640, 384, 640],
            },
            ImagePlane {
                width: 2,
                height: 2,
                data: vec![384, 384, 640, 640],
            },
        ];
        // Exact hand-derived bilinear samples, including clamped image edges.
        let centered = [384.0, 448.0, 576.0, 640.0];
        let colocated = [384.0, 512.0, 640.0, 640.0];
        for (position, horizontal, vertical) in [
            (0, centered, centered),
            (1, colocated, centered),
            (2, colocated, colocated),
        ] {
            let color = Color {
                depth: 10,
                monochrome: false,
                primaries: 1,
                transfer: 1,
                matrix: 1,
                full_range: true,
                sub_x: true,
                sub_y: true,
                position,
                separate_uv_delta_q: false,
            };
            let image = rgb_planes(4, 4, &color, &planes, &[]).unwrap();
            for y in 0..4 {
                for x in 0..4 {
                    let luma = 512.0 / 1023.0;
                    let cb = (horizontal[x] - 512.0) / 1023.0;
                    let cr = (vertical[y] - 512.0) / 1023.0;
                    // H.273 BT.709 coefficients, independent of the sampling implementation.
                    let r = luma + 1.5748 * cr;
                    let b = luma + 1.8556 * cb;
                    let g = (luma - 0.2126 * r - 0.0722 * b) / 0.7152;
                    let expected =
                        [r, g, b, 1.0].map(|v: f64| (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16);
                    assert_eq!(
                        &image.rgba[(y * 4 + x) * 4..(y * 4 + x + 1) * 4],
                        &expected,
                        "position {position}, pixel ({x}, {y})"
                    );
                }
            }
        }
    }

    #[test]
    fn real_mono_retains_precision_and_all_items_validate() {
        for (bytes, expected) in [
            (include_bytes!("../tests/fixtures/fox.profile0.8bpc.yuv420.avif").as_slice(), (1204, 800, 8)),
            (include_bytes!("../tests/fixtures/fox.profile2.12bpc.yuv420.monochrome.odd-width.odd-height.avif").as_slice(), (1203, 799, 12)),
        ] {
            let image = decode(bytes, Limits { pixels: 1 << 26, memory: 512 << 20 }).unwrap();
            assert_eq!((image.width, image.height, image.depth), expected);
            assert_eq!(image.rgba.len(), image.width * image.height * 4);
            assert_eq!(decode(bytes, Limits { pixels: 10, memory: 512 << 20 }).err(), Some(Error::Limit));
        }
    }
}
