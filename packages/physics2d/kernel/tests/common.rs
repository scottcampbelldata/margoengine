// The shared kernel parts (packages/physics/kernel-common) against brute force: sweep and prune finds exactly the
// overlapping pairs of random boxes in 2 and 3 dimensions as they move, are added and removed; the union-find islands
// are the connected components a graph search finds; the colouring never puts two constraints that write one body in one
// colour and visits in the order it promises; four lanes give each lane the scalar operation's bits.
use margoengine_physics_kernel_common::broad::{Bounds, SweepPrune};
use margoengine_physics_kernel_common::colour::{COLOURS, Colouring, NONE, float_key};
use margoengine_physics_kernel_common::lanes::{F4, M4};
use margoengine_physics_kernel_common::island::{UnionFind, sleep_tick};

struct Random(u64);
impl Random {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}

fn random_box<const N: usize>(random: &mut Random, spread: [f32; N]) -> Bounds<N> {
    let mut b = Bounds { min: [0.0; N], max: [0.0; N] };
    for k in 0..N {
        let c = random.range(-spread[k], spread[k]);
        let half = random.range(0.05, 1.5);
        b.min[k] = c - half;
        b.max[k] = c + half;
    }
    b
}

fn brute<const N: usize>(boxes: &[Option<Bounds<N>>]) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for i in 0..boxes.len() {
        for j in i + 1..boxes.len() {
            if let (Some(a), Some(b)) = (&boxes[i], &boxes[j]) {
                if a.overlaps(b) {
                    out.push((i as u32, j as u32));
                }
            }
        }
    }
    out
}

fn sweep_matches_brute_force<const N: usize>(spread: [f32; N], seed: u64) {
    let mut random = Random(seed);
    let mut sap = SweepPrune::<N>::new();
    let margin = 0.1;
    let mut fat: Vec<Option<Bounds<N>>> = Vec::new();
    let mut tight: Vec<Option<Bounds<N>>> = Vec::new();
    for key in 0..300u32 {
        let b = random_box(&mut random, spread);
        sap.place(key, &b, margin);
        tight.push(Some(b));
        fat.push(Some(b.grown(margin)));
    }
    let mut pairs = Vec::new();
    let mut axes = std::collections::BTreeSet::new();
    for round in 0..40 {
        // Move most boxes a little and some far, drop a few and bring a few back.
        for key in 0..300usize {
            let roll = random.next();
            if roll < 0.03 {
                sap.remove(key as u32);
                tight[key] = None;
                fat[key] = None;
            } else if roll < 0.06 || tight[key].is_none() {
                let b = random_box(&mut random, spread);
                sap.place(key as u32, &b, margin);
                if fat[key].is_none_or(|f| !f.contains(&b)) {
                    fat[key] = Some(b.grown(margin));
                }
                tight[key] = Some(b);
            } else if let Some(mut b) = tight[key] {
                let step = if roll < 0.5 { 0.05 } else { 0.4 };
                for k in 0..N {
                    let d = random.range(-step, step);
                    b.min[k] += d;
                    b.max[k] += d;
                }
                sap.place(key as u32, &b, margin);
                if !fat[key].unwrap().contains(&b) {
                    fat[key] = Some(b.grown(margin));
                }
                tight[key] = Some(b);
            }
        }
        sap.pairs(&mut pairs, |_, _| true);
        assert_eq!(pairs, brute(&fat), "N = {N}, round {round}");
        axes.insert(sap.axis());
        // A filter drops exactly what it refuses.
        sap.pairs(&mut pairs, |a, b| (a + b) % 3 != 0);
        let kept: Vec<(u32, u32)> = brute(&fat).into_iter().filter(|(a, b)| (a + b) % 3 != 0).collect();
        assert_eq!(pairs, kept);
        // Queries agree with brute force too.
        let q = random_box(&mut random, spread);
        let mut found = Vec::new();
        sap.query(&q, &mut found);
        let expect: Vec<u32> = (0..300u32).filter(|&k| fat[k as usize].is_some_and(|f| f.overlaps(&q))).collect();
        assert_eq!(found, expect);
    }
    // The sweep runs along the axis of widest spread.
    let widest = (0..N).fold(0, |best, k| if spread[k] > spread[best] { k } else { best });
    assert_eq!(axes.into_iter().collect::<Vec<_>>(), vec![widest]);
}

#[test]
fn sweep_and_prune_finds_every_overlapping_pair_in_two_dimensions() {
    sweep_matches_brute_force::<2>([10.0, 30.0], 1);
    sweep_matches_brute_force::<2>([30.0, 10.0], 2);
}

#[test]
fn sweep_and_prune_finds_every_overlapping_pair_in_three_dimensions() {
    sweep_matches_brute_force::<3>([8.0, 8.0, 25.0], 3);
}

#[test]
fn a_fat_box_keeps_still_while_its_shape_stays_inside() {
    let mut sap = SweepPrune::<2>::new();
    let b = Bounds { min: [0.0, 0.0], max: [1.0, 1.0] };
    assert!(sap.place(7, &b, 0.1));
    let nudged = Bounds { min: [0.05, 0.0], max: [1.05, 1.0] };
    assert!(!sap.place(7, &nudged, 0.1));
    assert_eq!(sap.refits, 0);
    let out = Bounds { min: [0.2, 0.0], max: [1.2, 1.0] };
    assert!(sap.place(7, &out, 0.1));
    assert_eq!(sap.refits, 1);
    assert_eq!(sap.fat(7).unwrap(), &out.grown(0.1));
}

#[test]
fn islands_are_the_connected_components() {
    let mut random = Random(9);
    let n = 500usize;
    let mut uf = UnionFind::new();
    uf.reset(n);
    let mut adjacency = vec![Vec::new(); n];
    for _ in 0..350 {
        let (a, b) = ((random.next() * n as f32) as usize % n, (random.next() * n as f32) as usize % n);
        uf.union(a as u32, b as u32);
        adjacency[a].push(b);
        adjacency[b].push(a);
    }
    let mut island = Vec::new();
    let count = uf.islands(&mut island);
    // Components by depth-first search, numbered in order of their lowest element.
    let mut component = vec![usize::MAX; n];
    let mut next = 0;
    for start in 0..n {
        if component[start] != usize::MAX {
            continue;
        }
        let mut stack = vec![start];
        component[start] = next;
        while let Some(x) = stack.pop() {
            for &y in &adjacency[x] {
                if component[y] == usize::MAX {
                    component[y] = next;
                    stack.push(y);
                }
            }
        }
        next += 1;
    }
    assert_eq!(count, next);
    for x in 0..n {
        assert_eq!(island[x] as usize, component[x]);
    }
}

#[test]
fn a_sleep_timer_adds_up_while_slow_and_restarts_when_fast() {
    let t = sleep_tick(0.0, 0.01, 0.05, 0.25);
    let t = sleep_tick(t, 0.04, 0.05, 0.25);
    assert_eq!(t, 0.5);
    assert_eq!(sleep_tick(t, 0.06, 0.05, 0.25), 0.0);
}

#[test]
fn no_colour_holds_two_constraints_that_write_one_body() {
    let mut random = Random(7);
    let mut colouring = Colouring::default();
    for round in 0..20 {
        let bodies = 1 + round * 37;
        let count = 3 * bodies;
        let pick = |random: &mut Random| {
            let x = (random.next() * (bodies as f32 + 2.0)) as u32;
            if x >= bodies as u32 { NONE } else { x }
        };
        // A constraint joins two different bodies.
        let writes: Vec<[u32; 2]> = (0..count)
            .map(|_| {
                let (a, b) = (pick(&mut random), pick(&mut random));
                [a, if a == b { NONE } else { b }]
            })
            .collect();
        let keys: Vec<u32> = (0..count).map(|_| float_key(random.range(-50.0, 50.0))).collect();
        colouring.build(bodies, &writes, &keys);
        // Every constraint once.
        let mut seen = vec![false; count];
        for &i in &colouring.order {
            assert!(!seen[i as usize]);
            seen[i as usize] = true;
        }
        assert!(seen.iter().all(|&s| s));
        for k in 0..COLOURS {
            let visit = &colouring.order[colouring.starts[k] as usize..colouring.starts[k + 1] as usize];
            let mut taken = vec![false; bodies];
            for &i in visit {
                for x in writes[i as usize] {
                    if x != NONE {
                        assert!(!taken[x as usize], "round {round}: body {x} written twice in visit {k}");
                        taken[x as usize] = true;
                    }
                }
            }
            // Key order inside a colour, constraint order among equal keys.
            for pair in visit.windows(2) {
                let (a, b) = (pair[0] as usize, pair[1] as usize);
                assert!(keys[a] < keys[b] || (keys[a] == keys[b] && a < b));
            }
        }
    }
}

#[test]
fn constraints_on_one_body_fill_the_colours_then_the_overflow_and_the_last_colour_comes_first() {
    // Twenty constraints all writing body 0: one a colour, the first sixteen by key, the last four in the overflow.
    let writes = vec![[0u32, NONE]; 20];
    let keys: Vec<u32> = (0..20).map(|i| float_key(-(i as f32))).collect();
    let mut colouring = Colouring::default();
    colouring.build(1, &writes, &keys);
    assert_eq!(colouring.used(), 16);
    assert_eq!(colouring.overflow(), 4);
    // Lowest key first: constraint 19 takes colour 0, 4 colour 15, and colour 15 is visited first.
    assert_eq!(colouring.order[..16], (4..20).collect::<Vec<u32>>()[..]);
    assert_eq!(colouring.order[16..], [3, 2, 1, 0]);
    // A constraint that writes nothing (both bodies only read) never blocks and goes to colour 0, visited last.
    let mut colouring = Colouring::default();
    colouring.build(2, &[[0, 1], [NONE, NONE], [1, NONE]], &[float_key(0.0); 3]);
    assert_eq!(colouring.used(), 2);
    assert_eq!(colouring.order, [2, 0, 1]);
    assert!(float_key(-1.0) < float_key(-0.5) && float_key(-0.5) < float_key(0.0) && float_key(0.0) < float_key(2.0));
}

#[test]
fn four_lanes_give_each_lane_the_scalar_bits() {
    let mut random = Random(11);
    let pick = |random: &mut Random| {
        let specials = [0.0, -0.0, 1.0, -1.0, f32::MIN_POSITIVE, 1e-30, 3.0e38, f32::INFINITY, f32::NAN];
        if random.next() < 0.3 { specials[(random.next() * specials.len() as f32) as usize % specials.len()] } else { random.range(-1e3, 1e3) }
    };
    let same = |a: [f32; 4], b: [f32; 4]| a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits() || (x.is_nan() && y.is_nan()));
    for _ in 0..2000 {
        let x = [0; 4].map(|_| pick(&mut random));
        let y = [0; 4].map(|_| pick(&mut random));
        let (a, b) = (F4::new(x), F4::new(y));
        let each = |f: fn(f32, f32) -> f32| [0, 1, 2, 3].map(|k| f(x[k], y[k]));
        assert!(same((a + b).get(), each(|p, q| p + q)));
        assert!(same((a - b).get(), each(|p, q| p - q)));
        assert!(same((a * b).get(), each(|p, q| p * q)));
        assert!(same((a / b).get(), each(|p, q| p / q)));
        assert!(same((-a).get(), [0, 1, 2, 3].map(|k| -x[k])));
        let bits = |f: fn(f32, f32) -> bool| (0..4).map(|k| (f(x[k], y[k]) as u32) << k).sum::<u32>();
        assert_eq!(a.lt(b).bits(), bits(|p, q| p < q));
        assert_eq!(a.le(b).bits(), bits(|p, q| p <= q));
        assert_eq!(a.gt(b).bits(), bits(|p, q| p > q));
        assert_eq!(a.ge(b).bits(), bits(|p, q| p >= q));
        // A compare and a select: the larger as `if p > q { p } else { q }` gives it, zeros and NaN included.
        assert!(same(F4::select(a.gt(b), a, b).get(), each(|p, q| if p > q { p } else { q })));
    }
    for m in 0..16 {
        assert_eq!(M4::from_bits(m).bits(), m);
        for n in 0..16 {
            assert_eq!(M4::from_bits(m).and(M4::from_bits(n)).bits(), m & n);
            assert_eq!(M4::from_bits(m).or(M4::from_bits(n)).bits(), m | n);
            assert_eq!(M4::from_bits(m).and_not(M4::from_bits(n)).bits(), m & !n);
        }
    }
}

#[test]
fn lane_equality_matches_ieee_f32_for_signed_zero_nan_and_infinity() {
    let values = [0.0, -0.0, 1.0, -1.0, f32::INFINITY, f32::NEG_INFINITY, f32::from_bits(0x7fc0_1234), f32::from_bits(0x7fa0_5678), f32::from_bits(1), f32::MAX];
    for a in values { for b in values {
        let x = [a, b, a, b]; let y = [b, a, a, b];
        let expected = (0..4).fold(0, |bits, lane| bits | ((x[lane] == y[lane]) as u32) << lane);
        assert_eq!(F4::new(x).eq(F4::new(y)).bits(), expected);
    } }
}
