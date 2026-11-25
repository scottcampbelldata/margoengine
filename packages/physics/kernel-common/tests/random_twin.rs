// The TypeScript twin of the generator (`RandomStream` in packages/physics/src/world/random.ts) and this crate's `Random`
// give the same words: both are pinned to the vectors in random-vectors.txt, which packages/physics/tests/world-random.test.js
// reads too.
use margoengine_physics_kernel_common::random::Random;

#[test]
fn the_typescript_twin_and_rust_give_the_same_words() {
    let text = include_str!("random-vectors.txt");
    let mut checked = 0;
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
        let f: Vec<&str> = line.split_whitespace().collect();
        let seed: u64 = f[0].parse().unwrap();
        let solver: u16 = f[1].parse().unwrap();
        let tick: u64 = f[2].parse().unwrap();
        let element: u32 = f[3].parse().unwrap();
        let stream: u16 = f[4].parse().unwrap();
        let want: Vec<u32> = f[5..9].iter().map(|w| u32::from_str_radix(w, 16).unwrap()).collect();
        assert_eq!(Random::new(seed, solver, tick, element).block(stream).to_vec(), want, "{line}");
        checked += 1;
    }
    assert_eq!(checked, 6);
}
