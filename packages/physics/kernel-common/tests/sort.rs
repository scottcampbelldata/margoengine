// The radix sort against the standard sort: the same order, ties by id, and no dependence on the order the entries arrive in.
use margoengine_physics_kernel_common::sort::{entry, radix_sort, split};

fn stream(seed: u64) -> impl FnMut() -> u32 {
    let mut s = seed;
    move || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (s >> 32) as u32
    }
}

#[test]
fn sorts_by_key_then_id_as_the_standard_sort_does() {
    let mut next = stream(1);
    for count in [0usize, 1, 2, 17, 1000, 5000] {
        // Few distinct keys, so many ties; and some keys that need all four bytes.
        let entries: Vec<u64> = (0..count as u32).map(|id| entry(if id % 3 == 0 { next() % 7 } else { next() }, id)).collect();
        let mut expected = entries.clone();
        expected.sort();
        let (mut got, mut spare) = (entries, Vec::new());
        radix_sort(&mut got, &mut spare);
        assert_eq!(got, expected);
    }
}

#[test]
fn the_order_is_the_same_whatever_order_the_entries_arrive_in() {
    let mut next = stream(2);
    let entries: Vec<u64> = (0..2000u32).map(|id| entry(next() % 50, id)).collect();
    let (mut forward, mut backward, mut spare) = (entries.clone(), entries.iter().rev().copied().collect::<Vec<_>>(), Vec::new());
    radix_sort(&mut forward, &mut spare);
    radix_sort(&mut backward, &mut spare);
    assert_eq!(forward, backward, "distinct ids make the order total");
    assert!(forward.windows(2).all(|w| split(w[0]) < split(w[1])));
}
