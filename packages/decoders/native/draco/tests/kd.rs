use margoengine_draco::{Geometry, Limits, decode};

fn num(data: &[u8], at: &mut usize) -> u32 {
    let n = u32::from_le_bytes(data[*at..*at + 4].try_into().unwrap());
    *at += 4;
    n
}
fn blob<'a>(data: &'a [u8], at: &mut usize) -> &'a [u8] {
    let n = num(data, at) as usize;
    let out = &data[*at..*at + n];
    *at += n;
    out
}
fn exact(geometry: Geometry, expected: &[u8], name: &str) {
    let mut at = 0;
    assert_eq!(num(expected, &mut at) as usize, expected.len());
    assert_eq!(num(expected, &mut at), 0);
    assert_eq!(geometry.points, num(expected, &mut at) as usize, "{name}");
    assert!(!geometry.mesh);
    assert_eq!(num(expected, &mut at), 0);
    assert!(geometry.indices.is_empty());
    assert_eq!(num(expected, &mut at), 0);
    assert_eq!(
        geometry.attributes.len(),
        num(expected, &mut at) as usize,
        "{name}"
    );
    for a in geometry.attributes {
        assert_eq!(
            [
                a.semantic,
                a.data_type,
                a.components,
                u8::from(a.normalized)
            ],
            expected[at..at + 4],
            "{name}"
        );
        at += 4;
        assert_eq!(a.unique_id, num(expected, &mut at), "{name}");
        assert_eq!(a.data, blob(expected, &mut at), "{name}");
    }
    assert_eq!(at, expected.len());
}

#[test]
fn kd_black_box_coordinates_types_and_order_are_exact() {
    let data = include_bytes!("fixtures/kd.bin");
    let mut at = 0;
    assert_eq!(num(data, &mut at), 369);
    for _ in 0..369 {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        let expected = blob(data, &mut at);
        exact(
            decode(input, Limits::default()).unwrap_or_else(|e| panic!("{name}: {e:?}")),
            expected,
            name,
        );
        if name.ends_with("pc_kd_color.drc")
            || name == "kd-transform-order-floats-first"
            || [
                "kd-buffers-level0-raw-n3-bits4",
                "kd-buffers-level2-ans-n3-bits4",
                "kd-buffers-level6-ans33-n3-bits4",
            ]
            .contains(&name)
        {
            for end in 0..input.len() {
                assert!(
                    decode(&input[..end], Limits::default()).is_err(),
                    "{name}: accepted prefix {end}"
                );
            }
        }
    }
    assert_eq!(at, data.len());
}

#[test]
fn kd_mutations_are_bounded_coded_and_deterministic() {
    let data = include_bytes!("fixtures/kd.bin");
    let mut at = 4;
    let mut seeds = Vec::new();
    for _ in 0..369 {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        blob(data, &mut at);
        if [
            "kd-buffers-level0-raw-n3-bits4",
            "kd-buffers-level2-ans-n3-bits4",
            "kd-buffers-level6-ans33-n3-bits4",
            "kd-transform-order-floats-first",
        ]
        .contains(&name)
        {
            seeds.push(input);
        }
    }
    assert_eq!(seeds.len(), 4);
    let limits = Limits {
        vertices: 8192,
        indices: 24576,
        bytes: 2 * 1024 * 1024,
    };
    let mut random = 0xe613ab25_u32;
    for case in 0..4096 {
        let mut input = seeds[case % seeds.len()].to_vec();
        for _ in 0..1 + case % 7 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let index = random as usize % input.len();
            input[index] ^= (random >> 24) as u8;
        }
        assert_eq!(
            decode(&input, limits),
            decode(&input, limits),
            "mutation {case}"
        );
    }
}
