//! Historical texture-coordinate predictor 3 (streams 1.0 to 1.2) and the bit
//! stream and wrap rules found with it (E23/E24 in docs/clean-room.md). Every
//! input is Margo-crafted; expected bytes are the opaque full decoder's public
//! output, or its rejection.
use margoengine_draco::{Limits, decode};

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
fn historical_predictor_3_matches_black_box_outputs_and_rejections() {
    let data = include_bytes!("fixtures/legacy-uv.bin");
    let mut at = 0;
    let count = num(data, &mut at);
    assert_eq!(count, 258);
    let (mut accepted, mut rejected) = (0, 0);
    for _ in 0..count {
        let name = std::str::from_utf8(blob(data, &mut at)).unwrap();
        let input = blob(data, &mut at);
        if num(data, &mut at) == 0 {
            assert!(
                decode(input, Limits::default()).is_err(),
                "{name} must reject"
            );
            rejected += 1;
            continue;
        }
        let attributes = blob(data, &mut at);
        let indices = blob(data, &mut at);
        let g = decode(input, Limits::default()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let got: Vec<u8> = g
            .attributes
            .iter()
            .flat_map(|a| a.data.iter().copied())
            .collect();
        assert_eq!(got, attributes, "{name}");
        let got: Vec<u8> = g.indices.iter().flat_map(|i| i.to_le_bytes()).collect();
        assert_eq!(got, indices, "{name}");
        // No strict prefix of an accepted stream decodes.
        for end in 0..input.len() {
            assert!(
                decode(&input[..end], Limits::default()).is_err(),
                "{name} prefix {end}"
            );
        }
        accepted += 1;
    }
    assert_eq!(at, data.len());
    assert_eq!((accepted, rejected), (237, 21));
}
