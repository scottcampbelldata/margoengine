//! Layout rules found by E26 to E40 in docs/clean-room.md: which positions,
//! orientations and normal data the mesh predictors use, KD values of width 32
//! and the wrap transform, and E41's normals outside the octahedron. Every
//! input is Margo-crafted; expected output is the
//! opaque full decoder's public output, or its rejection. The one-triangle
//! normal mode (E35) is not established, so its cases expect `Unsupported`
//! although the opaque decoder accepts them.
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
                if decode(input, Limits::default()) != Err(Error::Unsupported) {
                    failures.push(format!("{name}: must be unsupported"));
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
