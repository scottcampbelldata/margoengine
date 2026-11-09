use margoengine_draco::{Attribute, Error, Limits, decode};

fn u32_at(data: &[u8], at: &mut usize) -> u32 {
    let value = u32::from_le_bytes(data[*at..*at + 4].try_into().unwrap());
    *at += 4;
    value
}
fn blob<'a>(data: &'a [u8], at: &mut usize) -> &'a [u8] {
    let n = u32_at(data, at) as usize;
    let out = &data[*at..*at + n];
    *at += n;
    out
}
fn floats(attr: &Attribute) -> Vec<u8> {
    let width = match attr.data_type {
        1 | 2 | 11 => 1,
        3 | 4 => 2,
        5 | 6 | 9 => 4,
        7 | 8 | 10 => 8,
        _ => panic!("invalid type"),
    };
    attr.data
        .chunks_exact(width)
        .flat_map(|b| {
            let mut v = match attr.data_type {
                1 => (b[0] as i8) as f32,
                2 | 11 => b[0] as f32,
                3 => i16::from_le_bytes(b.try_into().unwrap()) as f32,
                4 => u16::from_le_bytes(b.try_into().unwrap()) as f32,
                5 => i32::from_le_bytes(b.try_into().unwrap()) as f32,
                6 => u32::from_le_bytes(b.try_into().unwrap()) as f32,
                9 => f32::from_le_bytes(b.try_into().unwrap()),
                10 => f64::from_le_bytes(b.try_into().unwrap()) as f32,
                _ => panic!("not in established oracle corpus"),
            };
            if attr.normalized {
                let maximum = match attr.data_type {
                    1 => Some(127_f32),
                    2 => Some(255_f32),
                    3 => Some(32767_f32),
                    4 => Some(65535_f32),
                    5 => Some(2147483647_f32),
                    6 => Some(4294967295_f32),
                    _ => None,
                };
                if let Some(maximum) = maximum {
                    v = (v / maximum).max(-1.0);
                }
            }
            v.to_le_bytes()
        })
        .collect()
}

#[test]
fn established_black_box_rules_are_byte_exact() {
    let data = include_bytes!("fixtures/established.bin");
    let mut at = 0;
    let count = u32_at(data, &mut at);
    assert!(count >= 70);
    for case in 0..count {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        let geometry = decode(input, Limits::default())
            .unwrap_or_else(|e| panic!("case {case} {name}: {e:?}"));
        assert_eq!(geometry.points, u32_at(data, &mut at) as usize, "{name}");
        let nindices = u32_at(data, &mut at) as usize;
        let indices: Vec<_> = (0..nindices).map(|_| u32_at(data, &mut at)).collect();
        assert_eq!(geometry.indices, indices, "{name}");
        let attrs = u32_at(data, &mut at) as usize;
        assert_eq!(geometry.attributes.len(), attrs, "{name}");
        for attr in &geometry.attributes {
            let metadata = blob(data, &mut at);
            assert_eq!(
                [
                    attr.semantic,
                    attr.data_type,
                    attr.components,
                    u8::from(attr.normalized)
                ],
                metadata[..4],
                "{name}"
            );
            assert_eq!(attr.unique_id.to_le_bytes(), metadata[4..], "{name}");
            assert_eq!(floats(attr), blob(data, &mut at), "{name}");
        }
        // Every strict prefix of a whole file must report a structured error.
        for end in 0..input.len() {
            assert!(
                decode(&input[..end], Limits::default()).is_err(),
                "{name} accepted truncated prefix {end}"
            );
        }
    }
    assert_eq!(at, data.len());
}

fn triangle() -> Vec<u8> {
    let mut b =
        b"DRACO\x02\x02\x01\x00\x00\x00\x01\x03\x01\x00\x01\x02\x01\x01\x00\x09\x01\x00\x00\x00"
            .to_vec();
    for f in [2_f32, -7.25, 91.5] {
        b.extend(f.to_le_bytes());
    }
    b
}
#[test]
fn output_limits_and_indices_validate_before_allocation() {
    assert_eq!(
        decode(
            &triangle(),
            Limits {
                vertices: 2,
                ..Limits::default()
            }
        )
        .unwrap_err(),
        Error::Limit
    );
    assert_eq!(
        decode(
            &triangle(),
            Limits {
                indices: 2,
                ..Limits::default()
            }
        )
        .unwrap_err(),
        Error::Limit
    );
    assert_eq!(
        decode(
            &triangle(),
            Limits {
                bytes: 17,
                ..Limits::default()
            }
        )
        .unwrap_err(),
        Error::Limit
    );
    let mut b = triangle();
    b[16] = 3;
    assert_eq!(decode(&b, Limits::default()).unwrap_err(), Error::Invalid);
}

#[test]
fn duplicate_ids_are_refused_across_attribute_groups() {
    let seed = triangle();
    let mut b = seed[..17].to_vec();
    b.push(2); // Two decoder groups, each with one attribute of unique ID zero.
    for _ in 0..2 {
        b.extend_from_slice(&[1, 0, 9, 1, 0, 0, 0]);
    }
    for _ in 0..6 {
        b.extend_from_slice(&1_f32.to_le_bytes());
    }
    assert_eq!(decode(&b, Limits::default()).unwrap_err(), Error::Invalid);
}
#[test]
fn malformed_streams_never_panic_and_repeat_deterministically() {
    let seed = triangle();
    let mut random = 0x84716239_u32;
    for case in 0..4096 {
        let mut b = seed.clone();
        for _ in 0..1 + case % 4 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let index = random as usize % b.len();
            b[index] ^= (random >> 24) as u8;
        }
        let limits = Limits {
            vertices: 1024,
            indices: 3072,
            bytes: 64 * 1024,
        };
        let first = decode(&b, limits);
        let second = decode(&b, limits);
        assert_eq!(first, second, "mutation {case}");
    }
}
