//! Layout rules found by E26 to E40 in docs/clean-room.md: which positions,
//! orientations and normal data the mesh predictors use, KD values of width 32
//! and the wrap transform. Every input is Margo-crafted; expected output is the
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

#[test]
fn crafted_layouts_match_black_box_outputs_and_rejections() {
    let data = include_bytes!("fixtures/layouts.bin");
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
    assert_eq!((count, accepted, rejected, unsupported), (284, 233, 49, 2));
}
