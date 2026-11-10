use margoengine_draco::{Error, Limits, decode};

const WIDTHS: [u8; 7] = [1, 16, 17, 31, 64, 127, 255];

fn header(width: u8, encoding: u8) -> Vec<u8> {
    let mut bytes = b"DRACO\x02\x02\x00\x00\x00\x00".to_vec();
    bytes.extend(3_u32.to_le_bytes());
    bytes.extend([
        1,
        1,
        4,
        if encoding == 1 { 1 } else { 9 },
        width,
        0,
        0,
        encoding,
    ]);
    bytes
}

fn sequential(width: u8, encoding: u8) -> (Vec<u8>, Vec<u8>) {
    let mut bytes = header(width, encoding);
    let mut expected = Vec::new();
    if encoding != 0 {
        // Difference prediction, wrap transform, raw one-byte zigzag symbols.
        bytes.extend([0, 1, 0, 1]);
    }
    for row in 0..3 {
        for component in 0..usize::from(width) {
            let value = (component % 11 + 2 * row) as u8;
            if encoding == 0 {
                let value = f32::from(value) + component as f32 * 0.25;
                bytes.extend(value.to_le_bytes());
                expected.extend(value.to_le_bytes());
            } else {
                bytes.push(2 * if row == 0 { value } else { 2 });
                if encoding == 1 {
                    expected.push(value);
                } else {
                    expected.extend((f32::from(value) + component as f32 * 0.25).to_le_bytes());
                }
            }
        }
    }
    if encoding != 0 {
        bytes.extend(0_i32.to_le_bytes());
        bytes.extend(255_i32.to_le_bytes());
    }
    if encoding == 2 {
        for component in 0..usize::from(width) {
            bytes.extend((component as f32 * 0.25).to_le_bytes());
        }
        bytes.extend(255_f32.to_le_bytes());
        bytes.push(8);
    }
    (bytes, expected)
}

fn raw_block(bytes: &mut Vec<u8>, values: &[u8]) {
    let mut packed = Vec::new();
    for chunk in values.chunks(4) {
        let mut word = 0_u32;
        for index in 0..4 {
            word = (word << 8) | u32::from(*chunk.get(index).unwrap_or(&0));
        }
        packed.extend(word.to_le_bytes());
    }
    if packed.is_empty() {
        packed.extend([0; 4]);
    }
    bytes.extend((packed.len() as u32).to_le_bytes());
    bytes.extend(packed);
}

fn kd(width: u8, quantized: bool) -> (Vec<u8>, Vec<u8>) {
    let mut bytes = b"DRACO\x02\x03\x00\x01\x00\x00".to_vec();
    bytes.extend(2_u32.to_le_bytes());
    bytes.extend([1, 1, 4, if quantized { 9 } else { 5 }, width, 0, 0]);
    bytes.push(0); // KD raw level, eight bits per coordinate, two points.
    bytes.extend(8_u32.to_le_bytes());
    bytes.extend(2_u32.to_le_bytes());
    raw_block(&mut bytes, &[]); // No partition counts for a two-point leaf.
    let mut values = Vec::new();
    let mut expected = Vec::new();
    for row in 0..2 {
        // The first axis is 1 modulo the dimensionality.
        for index in 0..usize::from(width) {
            let component = (index + 1) % usize::from(width);
            values.push(((row * 7 + component) % 101) as u8);
        }
        for component in 0..usize::from(width) {
            let value = ((row * 7 + component) % 101) as i32;
            if quantized {
                expected.extend((value as f32 + component as f32 * 0.25).to_le_bytes());
            } else {
                expected.extend((value - component as i32 * 3).to_le_bytes());
            }
        }
    }
    raw_block(&mut bytes, &values);
    raw_block(&mut bytes, &[]); // Unused axis and half-order streams.
    raw_block(&mut bytes, &[]);
    if quantized {
        for component in 0..usize::from(width) {
            bytes.extend((component as f32 * 0.25).to_le_bytes());
        }
        bytes.extend(255_f32.to_le_bytes());
        bytes.push(8);
    } else {
        for component in 0..u32::from(width) {
            let mut symbol = if component == 0 { 0 } else { component * 6 - 1 };
            while symbol >= 128 {
                bytes.push(symbol as u8 | 128);
                symbol >>= 7;
            }
            bytes.push(symbol as u8);
        }
    }
    (bytes, expected)
}

#[test]
fn sequential_raw_integer_and_quantized_attributes_keep_every_component() {
    for width in WIDTHS {
        for encoding in [0, 1, 2] {
            let (bytes, expected) = sequential(width, encoding);
            let geometry = decode(&bytes, Limits::default()).unwrap();
            assert_eq!(geometry.points, 3);
            assert_eq!(geometry.attributes[0].components, width);
            assert_eq!(
                geometry.attributes[0].data, expected,
                "width {width} encoding {encoding}"
            );
        }
    }
}

#[test]
fn kd_signed_and_quantized_minima_keep_every_component() {
    for width in WIDTHS {
        for quantized in [false, true] {
            let (bytes, expected) = kd(width, quantized);
            let geometry = decode(&bytes, Limits::default()).unwrap();
            assert_eq!(geometry.points, 2);
            assert_eq!(geometry.attributes[0].components, width);
            assert_eq!(
                geometry.attributes[0].data, expected,
                "width {width} quantized {quantized}"
            );
        }
    }
}

#[test]
fn wide_inputs_reject_zero_components_truncation_and_output_over_budget() {
    assert_eq!(
        decode(&header(0, 0), Limits::default()).unwrap_err(),
        Error::Invalid
    );
    for (bytes, _) in [
        sequential(255, 0),
        sequential(255, 1),
        sequential(255, 2),
        kd(255, false),
        kd(255, true),
    ] {
        for end in 0..bytes.len() {
            assert!(
                decode(&bytes[..end], Limits::default()).is_err(),
                "prefix {end}"
            );
        }
        assert_eq!(
            decode(
                &bytes,
                Limits {
                    bytes: 1,
                    ..Limits::default()
                }
            )
            .unwrap_err(),
            Error::Limit
        );
    }
}
#[test]
fn retained_width17_matches_the_frozen_public_oracle() {
    let geometry = decode(
        &[
            68, 82, 65, 67, 79, 1, 1, 0, 0, 0, 0, 3, 0, 0, 0, 1, 1, 0, 0, 0, 4, 1, 17, 0, 44, 1, 0,
            3, 10, 17, 24, 2, 9, 16, 23, 1, 8, 15, 22, 0, 7, 14, 21, 28, 6, 13, 20, 27, 5, 12, 19,
            26, 4, 11, 18, 25, 3, 10, 17, 24, 2, 9, 16, 23, 1, 8, 15, 22, 0, 7, 14, 21, 28, 6, 13,
            20, 27, 5,
        ],
        Limits::default(),
    )
    .unwrap();
    assert_eq!(geometry.points, 3);
    let attr = &geometry.attributes[0];
    assert_eq!(attr.components, 17);
    assert_eq!(
        attr.data
            .iter()
            .map(|x| *x as i8 as f32)
            .collect::<Vec<_>>(),
        vec![
            3_f32, 10_f32, 17_f32, 24_f32, 2_f32, 9_f32, 16_f32, 23_f32, 1_f32, 8_f32, 15_f32,
            22_f32, 0_f32, 7_f32, 14_f32, 21_f32, 28_f32, 6_f32, 13_f32, 20_f32, 27_f32, 5_f32,
            12_f32, 19_f32, 26_f32, 4_f32, 11_f32, 18_f32, 25_f32, 3_f32, 10_f32, 17_f32, 24_f32,
            2_f32, 9_f32, 16_f32, 23_f32, 1_f32, 8_f32, 15_f32, 22_f32, 0_f32, 7_f32, 14_f32,
            21_f32, 28_f32, 6_f32, 13_f32, 20_f32, 27_f32, 5_f32
        ]
    );
}
