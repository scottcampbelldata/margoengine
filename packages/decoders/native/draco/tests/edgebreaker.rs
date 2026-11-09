use margoengine_draco::{Limits, decode};

// A standard E triangle and the independently framed valence E triangle from E8.
fn seeds() -> [Vec<u8>; 2] {
    [
        b"DRACO\x02\x02\x01\x01\x00\x00\x00\x03\x01\x00\x01\x00\x00\x01\x07\x80\x02\x80\x50\x00".to_vec(),
        b"DRACO\x02\x02\x01\x01\x00\x00\x02\x03\x01\x00\x01\x00\x00\x80\x02\x80\x50\x00\x00\x00\x00\x00\x00\x00".to_vec(),
    ]
}
#[test]
fn edgebreaker_prefixes_and_corruption_are_bounded_and_deterministic() {
    let seeds = seeds();
    for seed in &seeds {
        let geometry = decode(seed, Limits::default()).expect("independent oracle triangle");
        assert_eq!(geometry.indices, [0, 1, 2]);
        for end in 0..seed.len() {
            assert!(
                decode(&seed[..end], Limits::default()).is_err(),
                "prefix {end}"
            );
        }
    }
    let mut random = 0xc4258ef1_u32;
    for case in 0..16384 {
        let mut bytes = seeds[case % 2].clone();
        for _ in 0..1 + case % 6 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            let at = random as usize % bytes.len();
            bytes[at] ^= (random >> 24) as u8;
        }
        if case % 3 == 0 {
            bytes.truncate((random as usize % (bytes.len() - 1)) + 1);
        }
        assert_eq!(
            decode(&bytes, Limits::default()),
            decode(&bytes, Limits::default()),
            "mutation {case}"
        );
    }
}
