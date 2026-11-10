//! Development-only file probe; no production external decoder dependency.
#[path = "../native/avif/src/lib.rs"]
mod implementation;
pub use implementation::*;
use std::{env, fs, path::PathBuf};
fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    assert_eq!(args.len(), 2);
    let bytes = fs::read(&args[0]).unwrap();
    let prefix = PathBuf::from(&args[1]);
    let image = image::decode(&bytes, image::Limits { pixels: 1 << 26, memory: 1024 << 20 }).unwrap();
    fs::write(prefix.with_extension("rgba16"), image.rgba.into_iter().flat_map(u16::to_le_bytes).collect::<Vec<_>>()).unwrap();
    fs::write(prefix.with_extension("image.json"), format!("{{\"width\":{},\"height\":{},\"depth\":{},\"icc\":{}}}", image.width, image.height, image.depth, image.icc.len())).unwrap();
}
