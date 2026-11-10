use std::{env, fs};
fn main() {
    let args: Vec<_> = env::args().collect();
    let packet = fs::read(&args[1]).expect("read input packet");
    let encoded = margo_draco_encoder::encode_packet(&packet).expect("encode packet");
    fs::write(&args[2], encoded).expect("write stream");
}
