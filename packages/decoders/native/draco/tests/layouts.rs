//! Layout rules found by E26 to E40 in docs/clean-room.md: which positions,
//! orientations and normal data the mesh predictors use, KD values of width 32
//! and the wrap transform, and E41's normals outside the octahedron. Every
//! input is Margo-crafted; expected output is the
//! opaque full decoder's public output, or its rejection. Status 2 marks a
//! stream the opaque decoder accepts and Margo refuses as `Unsupported`. The
//! two one-triangle normal cases of E35 decode since E67; normal-mode0.bin
//! holds their outputs.
use margoengine_draco::{Error, Limits, decode};

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

/// Decodes every case of a retained fixture and compares; returns the counts of
/// all, accepted, rejected and Margo-only refused cases.
fn check(data: &[u8]) -> (u32, u32, u32, u32) {
    let mut at = 0;
    let count = num(data, &mut at);
    let (mut accepted, mut rejected, mut unsupported) = (0, 0, 0);
    let mut failures = Vec::new();
    for _ in 0..count {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        match num(data, &mut at) {
            0 => {
                if decode(input, Limits::default()).is_ok() {
                    failures.push(format!("{name}: must reject"));
                }
                rejected += 1;
            }
            2 => {
                let decodes = name.starts_with("E35 one-triangle");
                if (decode(input, Limits::default()) == Err(Error::Unsupported)) == decodes {
                    failures.push(format!("{name}: unsupported must be {}", !decodes));
                }
                unsupported += 1;
            }
            _ => {
                let points = num(data, &mut at) as usize;
                let attributes = blob(data, &mut at);
                let indices = blob(data, &mut at);
                accepted += 1;
                match decode(input, Limits::default()) {
                    Err(e) => failures.push(format!("{name}: {e:?}")),
                    Ok(g) => {
                        let values: Vec<u8> = g
                            .attributes
                            .iter()
                            .flat_map(|a| a.data.iter().copied())
                            .collect();
                        let order: Vec<u8> =
                            g.indices.iter().flat_map(|i| i.to_le_bytes()).collect();
                        if g.points != points || values != attributes || order != indices {
                            failures.push(format!("{name}: output differs"));
                        }
                    }
                }
                // No strict prefix of an accepted stream decodes. The wrap
                // and KD cases (E38 to E40) may carry unread trailing bytes.
                if name < "E38" {
                    for end in 0..input.len() {
                        assert!(
                            decode(&input[..end], Limits::default()).is_err(),
                            "{name} prefix {end}"
                        );
                    }
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures: {failures:#?}",
        failures.len()
    );
    assert_eq!(at, data.len());
    (count, accepted, rejected, unsupported)
}

#[test]
fn crafted_layouts_match_black_box_outputs_and_rejections() {
    let counts = check(include_bytes!("fixtures/layouts.bin"));
    assert_eq!(counts, (284, 233, 49, 2));
}

/// E41: normals outside the stored octahedron, unpredicted symbols at every
/// quantization and byte width, and predicted mesh normals whose transform
/// maximum is wider than the stored width.
#[test]
fn normals_outside_the_octahedron_match_black_box_outputs() {
    let counts = check(include_bytes!("fixtures/octahedron.bin"));
    assert_eq!(counts, (186, 186, 0, 0));
}

/// E42: predictor 6 on positions near the int32 and uint32 limits, where the
/// int64 normal and its absolute sum wrap.
#[test]
fn normals_past_int64_match_black_box_outputs() {
    let counts = check(include_bytes!("fixtures/normal-wide.bin"));
    assert_eq!(counts, (290, 290, 0, 0));
}

/// E43 and E44: the EdgeBreaker header's vertex and split counts are upper
/// bounds, accepted and refused at the same values as the opaque decoder.
#[test]
fn header_counts_match_black_box_bounds() {
    let counts = check(include_bytes!("fixtures/header-counts.bin"));
    assert_eq!(counts, (279, 138, 141, 0));
}

/// E45 to E47: a KD level 6 axis with no bits left, reads past the end of the
/// number, axis and half streams, and streams that are not whole words.
#[test]
fn kd_stream_ends_match_black_box_outputs_and_rejections() {
    let counts = check(include_bytes!("fixtures/kd-streams.bin"));
    assert_eq!(counts, (134, 80, 54, 0));
}

/// E50 to E57: damaged streams. Start faces per symbol, vertices merged by
/// splits, split events, sequential point and connectivity rules, empty
/// decoders, attribute-free clouds, short symbol streams, and Margo's refusal
/// of indices past the point count (docs/limits.md).
#[test]
fn damaged_streams_match_black_box_outputs_and_rejections() {
    let counts = check(include_bytes!("fixtures/damaged.bin"));
    assert_eq!(counts, (589, 304, 285, 0));
}

/// E48 and E49: only the metadata flag bit is read, from version 1.3, and one
/// metadata node's children have distinct names.
#[test]
fn metadata_headers_match_black_box_outputs_and_rejections() {
    let counts = check(include_bytes!("fixtures/metadata-header.bin"));
    assert_eq!(counts, (101, 46, 55, 0));
}

#[test]
fn several_kd_decoders_and_repeated_ids_match_black_box_outputs() {
    let counts = check(include_bytes!("fixtures/kd-decoders.bin"));
    assert_eq!(counts, (95, 89, 6, 0));
}

#[test]
fn version_13_and_normalized_bytes_match_black_box_outputs() {
    let counts = check(include_bytes!("fixtures/version13.bin"));
    assert_eq!(counts, (123, 99, 24, 0));
}

#[test]
fn unreached_vertices_match_black_box_outputs() {
    let counts = check(include_bytes!("fixtures/unreached.bin"));
    assert_eq!(counts, (122, 122, 0, 0));
}

#[test]
fn decoder_header_and_predictor_bytes_match_black_box_outputs() {
    let counts = check(include_bytes!("fixtures/headers.bin"));
    assert_eq!(counts, (365, 122, 243, 0));
}

/// E67: predictor 6 mode 0 (before 2.2) adds the first triangle's normal once
/// for every triangle around the vertex; streams whose product leaves int32
/// stay `Unsupported`.
#[test]
fn one_triangle_normal_mode_matches_black_box_outputs() {
    let counts = check(include_bytes!("fixtures/normal-mode0.bin"));
    assert_eq!(counts, (178, 162, 0, 16));
}

// E66: the opaque glTF build reads predictor 3 of a current stream as the
// difference predictor.
#[test]
fn gltf_flavor_reads_current_predictor_3_as_difference() {
    let data = include_bytes!("fixtures/headers.bin");
    let input = |wanted: &str| {
        let mut at = 0;
        for _ in 0..num(data, &mut at) {
            let name = blob(data, &mut at);
            let input = blob(data, &mut at);
            if name == wanted.as_bytes() {
                return input;
            }
            if num(data, &mut at) == 1 {
                num(data, &mut at);
                blob(data, &mut at);
                blob(data, &mut at);
            }
        }
        panic!("{wanted} is not in the fixture")
    };
    let three = input("E65 seed 9 predictor at 68 method 3");
    let zero = input("E65 seed 9 predictor at 68 method 0");
    assert_eq!(decode(three, Limits::default()), Err(Error::Unsupported));
    let values = |bytes| {
        let g = margoengine_draco::decode_gltf(bytes, Limits::default()).unwrap();
        (
            g.indices,
            g.attributes.into_iter().map(|a| a.data).collect::<Vec<_>>(),
        )
    };
    assert_eq!(values(three), values(zero));
}
