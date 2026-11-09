use margoengine_draco::{Geometry, Limits, decode, decode_gltf};

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
fn exact(g: Geometry, expected: &[u8], name: &str) {
    let mut at = 0;
    assert_eq!(num(expected, &mut at) as usize, expected.len());
    assert_eq!(num(expected, &mut at), 0);
    assert_eq!(g.points, num(expected, &mut at) as usize, "{name}");
    assert_eq!(u32::from(g.mesh), num(expected, &mut at), "{name}");
    let indices = num(expected, &mut at) as usize;
    let attributes = num(expected, &mut at) as usize;
    assert_eq!(g.indices.len(), indices, "{name}");
    for index in g.indices {
        assert_eq!(index, num(expected, &mut at), "{name}");
    }
    assert_eq!(g.attributes.len(), attributes, "{name}");
    for a in g.attributes {
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
fn multi_parallelogram_black_box_bytes_and_strict_prefixes() {
    let data = include_bytes!("fixtures/multi.bin");
    let mut at = 0;
    let count = num(data, &mut at);
    assert_eq!(count, 289);
    for _ in 0..count {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        let expected = blob(data, &mut at);
        exact(
            decode(input, Limits::default()).unwrap_or_else(|e| panic!("{name}: {e:?}")),
            expected,
            name,
        );
        for end in 0..input.len() {
            assert!(
                decode(&input[..end], Limits::default()).is_err(),
                "{name}: prefix {end}"
            );
        }
    }
    assert_eq!(at, data.len());
}

#[test]
fn full_and_gltf_flavors_preserve_their_distinct_opaque_outputs() {
    let data = include_bytes!("fixtures/flavor.bin");
    let mut at = 0;
    let count = num(data, &mut at);
    assert_eq!(count, 214);
    let mut distinct = 0;
    for _ in 0..count {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        let full = blob(data, &mut at);
        let gltf = blob(data, &mut at);
        distinct += usize::from(full != gltf);
        exact(decode(input, Limits::default()).unwrap(), full, name);
        exact(decode_gltf(input, Limits::default()).unwrap(), gltf, name);
        for end in 0..input.len() {
            assert!(
                decode_gltf(&input[..end], Limits::default()).is_err(),
                "{name}/{end}"
            );
        }
    }
    assert!(distinct >= 128);
    assert_eq!(at, data.len());
}

#[test]
fn predictive_edgebreaker_fallbacks_degrees_versions_and_strict_prefixes() {
    let data = include_bytes!("fixtures/predictive.bin");
    let mut at = 0;
    let count = num(data, &mut at);
    assert_eq!(count, 2160);
    for _ in 0..count {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        let expected = blob(data, &mut at);
        for decode in [decode, decode_gltf] {
            exact(
                decode(input, Limits::default()).unwrap_or_else(|e| panic!("{name}: {e:?}")),
                expected,
                name,
            );
        }
        for end in 0..input.len() {
            assert!(
                decode(&input[..end], Limits::default()).is_err(),
                "{name}: prefix {end}"
            );
        }
    }
    assert_eq!(at, data.len());
}
