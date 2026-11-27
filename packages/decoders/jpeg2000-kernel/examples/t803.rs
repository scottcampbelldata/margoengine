//! The decoder tests of Rec. ITU-T T.803 (11/2002) | ISO/IEC 15444-4: every codestream of the compliance set decoded
//! and compared with its reference component, against the peak and mean squared error of Tables C.1, C.4, C.6 and C.7.
//! The set is not redistributed. Unpack T-REC-T.803-200211.zip (itu.int) outside the repository and run, in this crate:
//!   cargo run --release --example t803 -- <folder holding J2KP4files>
//! It prints one line a reference file and exits non-zero when any of them is out of its bounds or cannot be decoded.
use margoengine_jpeg2000::decode::{Options, Plane, decode};
use std::path::Path;

/// (codestream, reference file, resolution levels dropped, component, peak, mean squared error).
type Row = (&'static str, &'static str, u32, usize, i64, f64);

/// Class 0 decodes the first component only, with no component transform (B.2.5).
#[rustfmt::skip]
const CLASS0: &[Row] = &[
    // Table C.1.
    ("p0_01", "c0p0_01", 0, 0, 0, 0.0), ("p0_02", "c0p0_02", 0, 0, 0, 0.0),
    ("p0_03", "c0p0_03r0", 0, 0, 0, 0.0), ("p0_03", "c0p0_03r1", 1, 0, 0, 0.0),
    ("p0_04", "c0p0_04", 3, 0, 33, 55.8), ("p0_05", "c0p0_05", 3, 0, 54, 68.0),
    ("p0_06", "c0p0_06", 3, 0, 109, 743.0), ("p0_07", "c0p0_07", 0, 0, 10, 0.34),
    ("p0_08", "c0p0_08", 5, 0, 7, 6.72), ("p0_09", "c0p0_09", 2, 0, 4, 1.47),
    ("p0_10", "c0p0_10", 0, 0, 10, 2.84), ("p0_11", "c0p0_11", 0, 0, 0, 0.0),
    ("p0_12", "c0p0_12", 0, 0, 0, 0.0), ("p0_13", "c0p0_13", 0, 0, 0, 0.0),
    ("p0_14", "c0p0_14", 2, 0, 0, 0.0), ("p0_15", "c0p0_15r0", 0, 0, 0, 0.0),
    ("p0_15", "c0p0_15r1", 1, 0, 0, 0.0), ("p0_16", "c0p0_16", 0, 0, 0, 0.0),
    // Table C.4.
    ("p1_01", "c0p1_01", 0, 0, 0, 0.0), ("p1_02", "c0p1_02", 3, 0, 35, 74.0),
    ("p1_03", "c0p1_03", 3, 0, 28, 18.8), ("p1_04", "c0p1_04r0", 0, 0, 2, 0.550),
    ("p1_04", "c0p1_04r3", 3, 0, 128, 2042.0), ("p1_05", "c0p1_05", 4, 0, 128, 16384.0),
    ("p1_06", "c0p1_06", 1, 0, 128, 16384.0), ("p1_07", "c0p1_07", 0, 0, 0, 0.0),
];

/// Class 1 decodes every component listed, transforms included.
#[rustfmt::skip]
const CLASS1: &[Row] = &[
    // Table C.6.
    ("p0_01", "c1p0_01-0", 0, 0, 0, 0.0), ("p0_02", "c1p0_02-0", 0, 0, 0, 0.0),
    ("p0_03", "c1p0_03-0", 0, 0, 0, 0.0), ("p0_04", "c1p0_04-0", 0, 0, 5, 0.776),
    ("p0_04", "c1p0_04-1", 0, 1, 4, 0.626), ("p0_04", "c1p0_04-2", 0, 2, 6, 1.070),
    ("p0_05", "c1p0_05-0", 0, 0, 2, 0.302), ("p0_05", "c1p0_05-1", 0, 1, 2, 0.307),
    ("p0_05", "c1p0_05-2", 0, 2, 2, 0.269), ("p0_05", "c1p0_05-3", 0, 3, 0, 0.0),
    ("p0_06", "c1p0_06-0", 0, 0, 635, 11287.0), ("p0_06", "c1p0_06-1", 0, 1, 403, 6124.0),
    ("p0_06", "c1p0_06-2", 0, 2, 378, 3968.0), ("p0_06", "c1p0_06-3", 0, 3, 0, 0.0),
    ("p0_07", "c1p0_07-0", 0, 0, 0, 0.0), ("p0_07", "c1p0_07-1", 0, 1, 0, 0.0),
    ("p0_07", "c1p0_07-2", 0, 2, 0, 0.0), ("p0_08", "c1p0_08-0", 1, 0, 0, 0.0),
    ("p0_08", "c1p0_08-1", 1, 1, 0, 0.0), ("p0_08", "c1p0_08-2", 1, 2, 0, 0.0),
    ("p0_09", "c1p0_09-0", 0, 0, 0, 0.0), ("p0_10", "c1p0_10-0", 0, 0, 0, 0.0),
    ("p0_10", "c1p0_10-1", 0, 1, 0, 0.0), ("p0_10", "c1p0_10-2", 0, 2, 0, 0.0),
    ("p0_11", "c1p0_11-0", 0, 0, 0, 0.0), ("p0_12", "c1p0_12-0", 0, 0, 0, 0.0),
    ("p0_13", "c1p0_13-0", 0, 0, 0, 0.0), ("p0_13", "c1p0_13-1", 0, 1, 0, 0.0),
    ("p0_13", "c1p0_13-2", 0, 2, 0, 0.0), ("p0_13", "c1p0_13-3", 0, 3, 0, 0.0),
    ("p0_14", "c1p0_14-0", 0, 0, 0, 0.0), ("p0_14", "c1p0_14-1", 0, 1, 0, 0.0),
    ("p0_14", "c1p0_14-2", 0, 2, 0, 0.0), ("p0_15", "c1p0_15-0", 0, 0, 0, 0.0),
    ("p0_16", "c1p0_16-0", 0, 0, 0, 0.0),
    // Table C.7.
    ("p1_01", "c1p1_01-0", 0, 0, 0, 0.0), ("p1_02", "c1p1_02-0", 0, 0, 5, 0.765),
    ("p1_02", "c1p1_02-1", 0, 1, 4, 0.616), ("p1_02", "c1p1_02-2", 0, 2, 6, 1.051),
    ("p1_03", "c1p1_03-0", 0, 0, 2, 0.300), ("p1_03", "c1p1_03-1", 0, 1, 2, 0.210),
    ("p1_03", "c1p1_03-2", 0, 2, 1, 0.200), ("p1_03", "c1p1_03-3", 0, 3, 0, 0.0),
    ("p1_04", "c1p1_04-0", 0, 0, 624, 3080.0), ("p1_05", "c1p1_05-0", 0, 0, 40, 8.458),
    ("p1_05", "c1p1_05-1", 0, 1, 40, 9.716), ("p1_05", "c1p1_05-2", 0, 2, 40, 10.154),
    ("p1_06", "c1p1_06-0", 0, 0, 2, 0.600), ("p1_06", "c1p1_06-1", 0, 1, 2, 0.600),
    ("p1_06", "c1p1_06-2", 0, 2, 2, 0.600), ("p1_07", "c1p1_07-0", 0, 0, 0, 0.0),
    ("p1_07", "c1p1_07-1", 0, 1, 0, 0.0),
];

/// A reference component (B.2.6): "PG", the byte order, the sign and depth, the width and height, then the samples in
/// whole bytes, sign extended.
struct Reference {
    depth: u32,
    width: usize,
    height: usize,
    samples: Vec<i64>,
}

fn pgx(data: &[u8]) -> Option<Reference> {
    let end = data.iter().position(|&b| b == b'\n')?;
    let head = std::str::from_utf8(&data[..end]).ok()?;
    let signed = head.contains('-');
    let head = head.replace(['+', '-'], " ");
    let words: Vec<&str> = head.split_whitespace().collect();
    let big = *words.get(1)? == "ML";
    let numbers: Vec<usize> = words[2..].iter().filter_map(|w| w.parse().ok()).collect();
    let [depth, width, height] = numbers[..] else { return None };
    let bytes = depth.div_ceil(8);
    let body = data.get(end + 1..end + 1 + width * height * bytes)?;
    let samples = body
        .chunks_exact(bytes)
        .map(|c| {
            let fold = |a: i64, &b: &u8| (a << 8) | b as i64;
            let v = if big { c.iter().fold(0, fold) } else { c.iter().rev().fold(0, fold) };
            if signed && v >= 1 << (8 * bytes - 1) { v - (1 << (8 * bytes)) } else { v }
        })
        .collect();
    Some(Reference { depth: depth as u32, width, height, samples })
}

/// The peak and mean squared error over the reference's rectangle: the decoded plane shifted down to the reference's
/// depth, as a Class 0 test of a deeper component asks (B.2.3.1.5), and cropped to it (B.2.3.1.7).
fn errors(plane: &Plane, reference: &Reference) -> Result<(i64, f64), String> {
    let &Reference { depth, width, height, ref samples } = reference;
    let shift = plane.precision.saturating_sub(depth);
    let (w, h) = (plane.width as usize, plane.height as usize);
    if w < width || h < height {
        return Err(format!("decoded {w} x {h}, reference {width} x {height}"));
    }
    let (mut peak, mut sum) = (0i64, 0f64);
    for y in 0..height {
        for x in 0..width {
            let d = (((plane.data[y * w + x] as i64) >> shift) - samples[y * width + x]).abs();
            peak = peak.max(d);
            sum += (d * d) as f64;
        }
    }
    Ok((peak, sum / (width * height) as f64))
}

fn main() {
    let root = std::env::args().nth(1).expect("usage: cargo run --release --example t803 -- <folder holding J2KP4files>");
    let root = Path::new(&root).join("J2KP4files");
    let read = |p: &Path| std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let mut failed = 0;
    for (class, rows) in [(0, CLASS0), (1, CLASS1)] {
        for &(stream, name, reduce, component, peak, mse) in rows {
            let profile = &stream[1..2];
            let data = read(&root.join(format!("codestreams_profile{profile}/{stream}.j2k")));
            let reference = read(&root.join(format!("reference_class{class}_profile{profile}/{name}.pgx")));
            let reference = pgx(&reference).expect("reference header");
            let options =
                Options { reduce, component_transform: class == 1, max_pixels: 1 << 26, ..Options::default() };
            let outcome = decode(&data, &options)
                .map_err(|e| format!("{e:?}"))
                .and_then(|image| errors(&image.components[component], &reference));
            let line = match outcome {
                Ok((p, m)) if p <= peak && m <= mse => format!("pass  peak {p}/{peak}  mse {m:.3}/{mse}"),
                Ok((p, m)) => {
                    failed += 1;
                    format!("FAIL  peak {p}/{peak}  mse {m:.3}/{mse}")
                }
                Err(e) => {
                    failed += 1;
                    format!("FAIL  {e}")
                }
            };
            println!("class {class}  {name:<10} {line}");
        }
    }
    println!("{failed} of {} reference components out of bounds", CLASS0.len() + CLASS1.len());
    std::process::exit((failed > 0) as i32);
}
