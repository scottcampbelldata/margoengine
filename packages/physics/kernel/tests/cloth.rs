// Cloth contacts (kernel-common/src/cloth.rs): vertex against triangle and edge against edge, found before they pass through,
// each against a closed form, then the cases that break continuous tests (Wang et al. 2021: coplanar motion, nearly parallel
// edges, tiny thickness, contact at an end, degenerate triangles) and a brute-force search.
use margoengine_physics_kernel_common::cloth::*;

struct Cloth {
    x0: Vec<f32>,
    x1: Vec<f32>,
    triangles: Vec<u32>,
}

impl Cloth {
    fn new() -> Cloth {
        Cloth { x0: vec![], x1: vec![], triangles: vec![] }
    }
    fn vertex(&mut self, from: [f32; 3], to: [f32; 3]) -> u32 {
        self.x0.extend(from);
        self.x1.extend(to);
        (self.x0.len() / 3 - 1) as u32
    }
    fn triangle(&mut self, a: u32, b: u32, c: u32) {
        self.triangles.extend([a, b, c]);
    }
    fn contacts(&self, thickness: f32) -> Vec<ClothContact> {
        let n = self.triangles.len() / 3;
        let vertices = self.x0.len() / 3;
        let (mut boxes, mut order, mut parent) = (vec![0.0f32; 6 * n], vec![0u32; n], vec![0u32; vertices]);
        let mut out = vec![ClothContact::EMPTY; 4096];
        let found = find_contacts(&self.x0, &self.x1, &self.triangles, thickness, &mut Scratch { boxes: &mut boxes, order: &mut order, parent: &mut parent }, &mut out);
        assert!(!found.overflow);
        out.truncate(found.count);
        out
    }
}

fn near(a: f32, b: f32, tolerance: f32, what: &str) {
    assert!((a - b).abs() <= tolerance, "{what}: {a} is not within {tolerance} of {b}");
}

/// A static triangle on y = 0 (vertices 0, 1, 2) and a far-away second triangle (3, 4, 5) whose first vertex is the point that moves.
fn point_over_triangle(from: [f32; 3], to: [f32; 3]) -> Cloth {
    let mut c = Cloth::new();
    let (a, b, d) = (c.vertex([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]), c.vertex([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]), c.vertex([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]));
    c.triangle(a, b, d);
    let p = c.vertex(from, to);
    let (q, r) = (c.vertex([30.0, 5.0, 30.0], [30.0, 5.0, 30.0]), c.vertex([31.0, 5.0, 30.0], [31.0, 5.0, 30.0]));
    c.triangle(p, q, r);
    c
}

#[test]
fn a_point_within_the_thickness_of_a_triangle_is_a_contact_with_its_weights_and_depth() {
    let c = point_over_triangle([0.5, 0.05, 0.25], [0.5, 0.05, 0.25]);
    let found = c.contacts(0.1);
    let pt: Vec<_> = found.iter().filter(|c| c.kind == POINT_TRIANGLE).collect();
    assert_eq!(pt.len(), 1);
    let contact = pt[0];
    assert_eq!(contact.v, [3, 0, 1, 2]);
    near(contact.depth, 0.05, 1e-6, "depth");
    near(contact.time, 0.0, 0.0, "already close at the start");
    near(contact.normal[1], 1.0, 1e-6, "normal up");
    // Barycentric weights of (0.5, 0.25) on the triangle (0,0), (1,0), (0,1): a = 0.25, b = 0.5, c = 0.25.
    near(contact.w[0], 0.25, 1e-6, "weight a");
    near(contact.w[1], 0.5, 1e-6, "weight b");
    near(contact.w[2], 0.25, 1e-6, "weight c");
    assert!(point_over_triangle([0.5, 0.2, 0.25], [0.5, 0.2, 0.25]).contacts(0.1).iter().all(|c| c.kind != POINT_TRIANGLE), "clear beyond the thickness");
}

#[test]
fn a_point_that_falls_through_a_triangle_in_one_step_is_found_where_it_crosses() {
    // 100 m in one step, from far above to far below: the cubic's root is the crossing.
    let c = point_over_triangle([0.2, 50.0, 0.3], [0.2, -50.0, 0.3]);
    let found = c.contacts(0.01);
    let hit = found.iter().find(|c| c.kind == POINT_TRIANGLE).expect("a contact");
    near(hit.time, 0.5 - 0.0, 1e-3, "time of the crossing");
    near(hit.normal[1], 1.0, 1e-6, "pushed back up, to the side it came from");
    near(hit.w[0], 0.5, 1e-5, "weight a");
    near(hit.w[1], 0.2, 1e-5, "weight b");
    near(hit.w[2], 0.3, 1e-5, "weight c");
    // And one that misses the triangle falls clear of it.
    assert!(point_over_triangle([2.0, 50.0, 2.0], [2.0, -50.0, 2.0]).contacts(0.01).iter().all(|c| c.kind != POINT_TRIANGLE));
    // From below, the other way: pushed back down.
    let up = point_over_triangle([0.2, -50.0, 0.3], [0.2, 50.0, 0.3]).contacts(0.01);
    near(up.iter().find(|c| c.kind == POINT_TRIANGLE).unwrap().normal[1], -1.0, 1e-6, "from below");
}

/// Edge (0, 1) along x at height `y0` to `y1` over edge (3, 4) along z on y = 0; each edge is the base of a triangle.
fn crossing_edges(y0: f32, y1: f32, x: f32) -> Cloth {
    let mut c = Cloth::new();
    let (a, b) = (c.vertex([-1.0 + x, y0, 0.0], [-1.0 + x, y1, 0.0]), c.vertex([1.0 + x, y0, 0.0], [1.0 + x, y1, 0.0]));
    let apex = c.vertex([x, y0, 9.0], [x, y1, 9.0]);
    c.triangle(a, b, apex);
    let (p, q) = (c.vertex([0.0, 0.0, -1.0], [0.0, 0.0, -1.0]), c.vertex([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]));
    let far = c.vertex([-9.0, 0.0, 0.0], [-9.0, 0.0, 0.0]);
    c.triangle(p, q, far);
    c
}

#[test]
fn two_edges_that_pass_through_each_other_in_one_step_are_found_at_the_crossing() {
    let found = crossing_edges(0.5, -0.5, 0.0).contacts(0.001);
    let hit = found.iter().find(|c| c.kind == EDGE_EDGE).expect("an edge pair");
    near(hit.time, 0.5, 2e-3, "time of the crossing");
    near(hit.w[0], 0.5, 1e-5, "along the first edge");
    near(hit.w[1], 0.5, 1e-5, "along the second");
    // The first edge of the contact is pushed to the side it came from: up for the one that started above.
    let up = if hit.v[0] == 0 { 1.0 } else { -1.0 };
    near(hit.normal[1], up, 1e-5, "the first edge is pushed to the side it came from");
    // Passing beside the other edge, past its end, misses.
    assert!(crossing_edges(0.5, -0.5, 3.0).contacts(0.001).iter().all(|c| c.kind != EDGE_EDGE));
}

// The cases of Wang et al. 2021 that earlier methods get wrong, built from their descriptions (the benchmark's own files are
// not in the repository).
#[test]
fn a_point_that_slides_across_a_triangle_in_its_plane_never_has_a_false_root() {
    // Coplanar the whole step: the cubic is zero everywhere. 2 h above, no contact; within h, a contact from the first instant.
    let far = point_over_triangle([-2.0, 0.02, 0.2], [3.0, 0.02, 0.2]).contacts(0.01);
    assert!(far.iter().all(|c| c.kind != POINT_TRIANGLE), "{far:?}");
    // Sliding 0.005 above it, across it: it comes within the thickness 0.01 at x = -sqrt(0.01^2 - 0.005^2) = -0.00866 along the
    // edge, which is (x + 2) / 5 of the way through the step.
    let across = point_over_triangle([-2.0, 0.005, 0.2], [3.0, 0.005, 0.2]).contacts(0.01);
    let hit = across.iter().find(|c| c.kind == POINT_TRIANGLE).expect("it comes within the thickness while it crosses");
    near(hit.time, (2.0 - 0.008_660_25) / 5.0, 2e-3, "when it gets within the thickness");
    let along = point_over_triangle([0.3, 0.005, 0.2], [3.0, 0.005, 0.2]).contacts(0.01);
    assert_eq!(along.iter().filter(|c| c.kind == POINT_TRIANGLE).count(), 1);
    near(along.iter().find(|c| c.kind == POINT_TRIANGLE).unwrap().time, 0.0, 0.0, "close from the start");
}

#[test]
fn nearly_parallel_edges_sliding_past_each_other_only_touch_within_the_thickness() {
    let mut c = Cloth::new();
    // Edge A along z at y = 0.0001 sliding 5 m along z; edge B along z at y = 0.
    let (a, b, apex) = (c.vertex([0.0, 0.0001, -1.0], [0.0, 0.0001, 4.0]), c.vertex([0.0, 0.0001, 1.0], [0.0, 0.0001, 6.0]), c.vertex([5.0, 0.0001, 0.0], [5.0, 0.0001, 5.0]));
    c.triangle(a, b, apex);
    let (p, q, far) = (c.vertex([0.0, 0.0, -1.0], [0.0, 0.0, -1.0]), c.vertex([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]), c.vertex([-5.0, 0.0, 0.0], [-5.0, 0.0, 0.0]));
    c.triangle(p, q, far);
    assert!(c.contacts(0.00001).iter().all(|c| c.kind != EDGE_EDGE), "a gap of 1e-4 beats a thickness of 1e-5");
    assert!(c.contacts(0.001).iter().any(|c| c.kind == EDGE_EDGE), "and is inside one of 1e-3");
}

#[test]
fn a_tiny_thickness_still_stops_a_point_that_crosses_at_a_great_speed() {
    let found = point_over_triangle([0.1, 1000.0, 0.1], [0.1, -1000.0, 0.1]).contacts(1e-7);
    let hit = found.iter().find(|c| c.kind == POINT_TRIANGLE).expect("no tunnelling");
    near(hit.time, 0.5, 1e-4, "time");
}

#[test]
fn a_crossing_at_the_end_of_an_edge_or_the_corner_of_a_triangle_is_not_lost_to_rounding() {
    // The vertex falls onto the triangle's corner a (0, 0, 0), and the other onto the end of the edge.
    let corner = point_over_triangle([0.0, 1.0, 0.0], [0.0, -1.0, 0.0]).contacts(0.001);
    assert!(corner.iter().any(|c| c.kind == POINT_TRIANGLE), "corner");
    let end = crossing_edges(0.5, -0.5, 1.0).contacts(0.001);
    assert!(end.iter().any(|c| c.kind == EDGE_EDGE), "end of the edge: its far end passes the other edge's line at x = 0");
    // The first edge's far end is at x = 2, its near end at x = 0: the crossing is at the near end, parameter 0.
    let hit = end.iter().find(|c| c.kind == EDGE_EDGE).unwrap();
    // The weight along the moving edge (vertices 0 and 1), whichever edge the contact lists first.
    let along = if hit.v[0] == 0 { hit.w[0] } else { hit.w[1] };
    near(along, 0.0, 1e-5, "at the end");
}

#[test]
fn a_degenerate_triangle_gives_no_contact_and_no_nan() {
    let mut c = point_over_triangle([0.2, 0.01, 0.2], [0.2, -0.01, 0.2]);
    // A third triangle of three points on a line.
    let (a, b, d) = (c.vertex([0.0, 0.01, 0.0], [0.0, 0.01, 0.0]), c.vertex([1.0, 0.01, 0.0], [1.0, 0.01, 0.0]), c.vertex([2.0, 0.01, 0.0], [2.0, 0.01, 0.0]));
    c.triangle(a, b, d);
    for contact in c.contacts(0.05) {
        for value in contact.normal.iter().chain(contact.w.iter()).chain([contact.time, contact.depth].iter()) {
            assert!(value.is_finite(), "{contact:?}");
        }
    }
}

#[test]
fn contacts_are_listed_once_sorted_and_grouped_by_the_vertices_they_share() {
    // A vertex over the shared edge of two triangles meets both, and each once; a second, far pair makes its own group.
    let mut c = Cloth::new();
    let (a, b, d, e) = (c.vertex([0.0, 0.0, 0.0], [0.0; 3]), c.vertex([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]), c.vertex([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]), c.vertex([1.0, 0.0, 1.0], [1.0, 0.0, 1.0]));
    c.triangle(a, b, d);
    c.triangle(b, e, d);
    let p = c.vertex([0.5, 0.02, 0.5], [0.5, 0.02, 0.5]);
    let (q, r) = (c.vertex([30.0, 0.0, 0.0], [30.0, 0.0, 0.0]), c.vertex([31.0, 0.0, 0.0], [31.0, 0.0, 0.0]));
    c.triangle(p, q, r);
    // Another pair far away.
    let (f, g, h2, i) = (c.vertex([100.0, 0.0, 0.0], [100.0; 1].iter().copied().chain([0.0, 0.0]).collect::<Vec<_>>().try_into().unwrap()), c.vertex([101.0, 0.0, 0.0], [101.0, 0.0, 0.0]), c.vertex([100.0, 0.0, 1.0], [100.0, 0.0, 1.0]), c.vertex([100.2, 0.02, 0.2], [100.2, 0.02, 0.2]));
    c.triangle(f, g, h2);
    let (j, k) = (c.vertex([130.0, 0.0, 0.0], [130.0, 0.0, 0.0]), c.vertex([131.0, 0.0, 0.0], [131.0, 0.0, 0.0]));
    c.triangle(i, j, k);
    let found = c.contacts(0.05);
    let mut keys: Vec<_> = found.iter().map(|c| (c.kind, c.v)).collect();
    let sorted = keys.clone();
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), found.len(), "no repeats");
    assert_eq!(keys, sorted, "sorted");
    let zones: std::collections::BTreeSet<u32> = found.iter().map(|c| c.zone).collect();
    assert_eq!(zones.len(), 2, "two places, two groups: {found:?}");
    let first: Vec<_> = found.iter().filter(|c| c.v.contains(&p)).collect();
    assert!(first.len() >= 2 && first.iter().all(|c| c.zone == first[0].zone), "the vertex over the shared edge meets both triangles in one group");
}

struct Random(u64);
impl Random {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 / (1u64 << 53) as f64) as f32
    }
}

#[test]
fn the_sweep_finds_what_a_search_of_every_pair_finds_on_random_soups() {
    let mut rng = Random(0x9e37_79b9_7f4a_7c15);
    for case in 0..20 {
        let triangles = 12 + case;
        let mut c = Cloth::new();
        for t in 0..triangles {
            let centre = [rng.next() * 3.0, rng.next() * 3.0, rng.next() * 3.0];
            let mut ids = [0u32; 3];
            for id in ids.iter_mut() {
                let start = [centre[0] + rng.next() * 0.8, centre[1] + rng.next() * 0.8, centre[2] + rng.next() * 0.8];
                let to = [start[0] + (rng.next() - 0.5) * 0.4, start[1] + (rng.next() - 0.5) * 0.4, start[2] + (rng.next() - 0.5) * 0.4];
                *id = c.vertex(start, to);
            }
            let _ = t;
            c.triangle(ids[0], ids[1], ids[2]);
        }
        let h = 0.05;
        let found = c.contacts(h);
        // Brute force over every pair of triangles of the same kind of test, through the same function with a one-pair mesh.
        let mut want = std::collections::BTreeSet::new();
        for i in 0..triangles {
            for j in i + 1..triangles {
                let mut pair = Cloth::new();
                let ids: Vec<u32> = [i, j].iter().flat_map(|&t| (0..3).map(move |k| (t, k))).map(|(t, k)| {
                    let v = c.triangles[3 * t + k] as usize;
                    pair.vertex([c.x0[3 * v], c.x0[3 * v + 1], c.x0[3 * v + 2]], [c.x1[3 * v], c.x1[3 * v + 1], c.x1[3 * v + 2]])
                }).collect();
                pair.triangle(ids[0], ids[1], ids[2]);
                pair.triangle(ids[3], ids[4], ids[5]);
                for contact in pair.contacts(h) {
                    // Back to the vertex numbers of the whole soup.
                    let lift = |local: u32| c.triangles[3 * if local < 3 { i } else { j } + (local % 3) as usize];
                    let mut v = [0u32; 4];
                    for k in 0..4 {
                        v[k] = lift(contact.v[k]);
                    }
                    want.insert((contact.kind, if contact.kind == POINT_TRIANGLE { v } else { canonical(v) }));
                }
            }
        }
        let got: std::collections::BTreeSet<_> = found.iter().map(|c| (c.kind, if c.kind == POINT_TRIANGLE { c.v } else { canonical(c.v) })).collect();
        assert_eq!(got, want, "case {case}");
    }
}

fn canonical(v: [u32; 4]) -> [u32; 4] {
    let edge = |x: u32, y: u32| if x < y { (x, y) } else { (y, x) };
    let (a, b) = (edge(v[0], v[1]), edge(v[2], v[3]));
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    [a.0, a.1, b.0, b.1]
}

#[test]
fn a_cloth_draped_over_a_sphere_has_no_self_contact_and_one_folded_over_itself_has_many() {
    // A 20 by 20 grid of 5 cm squares laid over a sphere of radius 0.4, each vertex a little above its surface.
    let n = 20;
    let mut draped = Cloth::new();
    for cloth in [&mut draped] {
        for j in 0..=n {
            for i in 0..=n {
                let (x, z) = ((i as f32 - 10.0) * 0.05, (j as f32 - 10.0) * 0.05);
                let r2 = x * x + z * z;
                let y = if r2 < 0.16 { (0.16 - r2).sqrt() + 0.004 } else { 0.004 };
                cloth.vertex([x, y, z], [x, y, z]);
            }
        }
        for j in 0..n {
            for i in 0..n {
                let a = (j * (n + 1) + i) as u32;
                let b = a + 1;
                let (c, d) = (a + (n + 1) as u32, a + 1 + (n + 1) as u32);
                cloth.triangle(a, c, b);
                cloth.triangle(b, c, d);
            }
        }
    }
    assert_eq!(draped.contacts(0.002).len(), 0, "a smooth drape has no self contact at a thickness well under its spacing");
    // A fold: a second layer lying 1 cm over the first.
    let mut layered = Cloth::new();
    for layer in 0..2 {
        for j in 0..=3 {
            for i in 0..=3 {
                layered.vertex([i as f32 * 0.05, 0.01 * layer as f32, j as f32 * 0.05], [i as f32 * 0.05, 0.01 * layer as f32, j as f32 * 0.05]);
            }
        }
        let base = layer * 16;
        for j in 0..3u32 {
            for i in 0..3u32 {
                let a = base + j * 4 + i;
                layered.triangle(a, a + 4, a + 1);
                layered.triangle(a + 1, a + 4, a + 5);
            }
        }
    }
    assert!(layered.contacts(0.02).len() > 10, "two layers 1 cm apart touch within a thickness of 2 cm");
    assert_eq!(layered.contacts(0.004).len(), 0, "and do not within 4 mm");
}

// Never miss: for random pairs of moving triangles, whenever a dense sampling of the step finds a point or an edge of one
// within the thickness of the other, the search reports a contact.
fn closest_point_distance(p: [f64; 3], a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let sub = |x: [f64; 3], y: [f64; 3]| [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    let dot = |x: [f64; 3], y: [f64; 3]| x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    let cross = |x: [f64; 3], y: [f64; 3]| [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    let segment = |p: [f64; 3], q: [f64; 3], r: [f64; 3]| {
        let d = sub(r, q);
        let l = dot(d, d);
        let t = if l > 0.0 { (dot(sub(p, q), d) / l).clamp(0.0, 1.0) } else { 0.0 };
        let e = sub(p, [q[0] + d[0] * t, q[1] + d[1] * t, q[2] + d[2] * t]);
        dot(e, e).sqrt()
    };
    let n = cross(sub(b, a), sub(c, a));
    let nn = dot(n, n);
    let mut best = segment(p, a, b).min(segment(p, b, c)).min(segment(p, c, a));
    if nn > 1e-24 {
        let d = dot(sub(p, a), n) / nn.sqrt();
        let q = [p[0] - n[0] * d / nn.sqrt(), p[1] - n[1] * d / nn.sqrt(), p[2] - n[2] * d / nn.sqrt()];
        let inside = [(a, b), (b, c), (c, a)].iter().all(|&(u, v)| dot(cross(sub(v, u), sub(q, u)), n) >= 0.0);
        if inside {
            best = best.min(d.abs());
        }
    }
    best
}

fn segment_distance(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    // Two nested ternary-free scans: fine sampling of one segment against the exact point-segment distance.
    let mut best = f64::MAX;
    for i in 0..=200 {
        let t = i as f64 / 200.0;
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        let e = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
        let l = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
        let u = if l > 0.0 { (((p[0] - c[0]) * e[0] + (p[1] - c[1]) * e[1] + (p[2] - c[2]) * e[2]) / l).clamp(0.0, 1.0) } else { 0.0 };
        let q = [c[0] + e[0] * u, c[1] + e[1] * u, c[2] + e[2] * u];
        best = best.min(((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt());
    }
    best
}

#[test]
fn a_dense_sampling_of_the_step_never_finds_a_close_pair_the_search_missed() {
    let mut rng = Random(0x1234_5678_9abc_def1);
    let h = 0.03f32;
    let (mut close, mut reported) = (0, 0);
    for case in 0..600 {
        let mut c = Cloth::new();
        let mut ids = [[0u32; 3]; 2];
        for tri in ids.iter_mut() {
            let centre = [rng.next(), rng.next(), rng.next()];
            for id in tri.iter_mut() {
                let start = [centre[0] + (rng.next() - 0.5) * 0.6, centre[1] + (rng.next() - 0.5) * 0.6, centre[2] + (rng.next() - 0.5) * 0.6];
                let to = [start[0] + (rng.next() - 0.5) * 1.2, start[1] + (rng.next() - 0.5) * 1.2, start[2] + (rng.next() - 0.5) * 1.2];
                *id = c.vertex(start, to);
            }
        }
        c.triangle(ids[0][0], ids[0][1], ids[0][2]);
        c.triangle(ids[1][0], ids[1][1], ids[1][2]);
        // The smallest distance over 400 sampled times, a point of one against the other triangle and an edge against an edge.
        let at = |v: u32, t: f64| -> [f64; 3] {
            let k = 3 * v as usize;
            [0, 1, 2].map(|a| c.x0[k + a] as f64 + (c.x1[k + a] as f64 - c.x0[k + a] as f64) * t)
        };
        let mut sampled = f64::MAX;
        for step in 0..=400 {
            let t = step as f64 / 400.0;
            for (p, q) in [(0, 1), (1, 0)] {
                for k in 0..3 {
                    sampled = sampled.min(closest_point_distance(at(ids[p][k], t), at(ids[q][0], t), at(ids[q][1], t), at(ids[q][2], t)));
                }
            }
            for i in 0..3 {
                for j in 0..3 {
                    let (a0, a1, b0, b1) = (ids[0][i], ids[0][(i + 1) % 3], ids[1][j], ids[1][(j + 1) % 3]);
                    sampled = sampled.min(segment_distance(at(a0, t), at(a1, t), at(b0, t), at(b1, t)));
                }
            }
        }
        let found = c.contacts(h);
        if sampled <= h as f64 * 0.98 {
            close += 1;
            assert!(!found.is_empty(), "case {case}: a pair within {sampled} of each other was missed");
        }
        if !found.is_empty() {
            reported += 1;
        }
    }
    assert!(close > 20, "the cases include close pairs: {close}");
    assert!(reported >= close, "{reported} of {close}");
}
