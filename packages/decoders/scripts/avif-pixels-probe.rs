//! Development-only binary for a platform-decoder comparison. Never runtime code.
#[path = "../native/avif/src/lib.rs"]
mod implementation;
pub use implementation::*;
use std::{env, fs, path::PathBuf};

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    assert_eq!(args.len(), 2, "Pass an AVIF fixture and its output prefix");
    let input = fs::read(&args[0]).unwrap();
    let prefix = PathBuf::from(&args[1]);
    let file = container::File::parse(&input).unwrap();
    let bytes = file.item_data(file.primary, input.len()).unwrap();
    fs::write(prefix.with_extension("obu"), &bytes).unwrap();
    let seq = obu::Obus::new(&bytes).map(|o| o.unwrap()).find(|o| o.kind == 1).unwrap();
    let seq = sequence::Sequence::parse(seq.payload).unwrap();
    let codec = format!("av01.{}.{:02}{}.{:02}.{}.{}{}{}.{:02}.{:02}.{:02}.{}", seq.profile, seq.operating_points[0].level,
        if seq.operating_points[0].tier { "H" } else { "M" }, seq.color.depth,
        u8::from(seq.color.monochrome), u8::from(seq.color.sub_x), u8::from(seq.color.sub_y), seq.color.position,
        seq.color.primaries, seq.color.transfer, seq.color.matrix, u8::from(seq.color.full_range));
    let decoded = decode::obus(&bytes, 1 << 26).unwrap();
    println!("palette/copy/Wiener/SGR counts: {:?}", decoded.tool_counts);
    fs::write(prefix.with_extension("frame.txt"), format!("{:#?}\n", decoded.frame)).unwrap();
    let mut pixels = Vec::new();
    for plane in &decoded.planes {
        for sample in &plane.data {
            if seq.color.depth == 8 { pixels.push(*sample as u8); }
            else { pixels.extend_from_slice(&sample.to_le_bytes()); }
        }
    }
    fs::write(prefix.with_extension("margo.yuv"), &pixels).unwrap();
    let metadata = format!("{{\"codec\":\"{}\",\"width\":{},\"height\":{},\"depth\":{},\"monochrome\":{},\"subX\":{},\"subY\":{},\"tools\":{:?},\"superres\":{},\"grain\":{},\"tiles\":{},\"qmatrix\":{}}}\n",
        codec, decoded.frame.upscaled_width, decoded.frame.height, seq.color.depth, seq.color.monochrome, seq.color.sub_x, seq.color.sub_y,
        decoded.tool_counts, decoded.frame.superres_denom, decoded.frame.grain.apply,
        (decoded.frame.tiles.columns.len()-1)*(decoded.frame.tiles.rows.len()-1), decoded.frame.qmatrix.is_some());
    fs::write(prefix.with_extension("json"), metadata).unwrap();
}
