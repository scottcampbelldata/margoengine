// The block solver of a manifold's normal rows (`world.header_mut().block_solver`): the loads that meet every contact's
// conditions at once, in place of sweeps. Proved against what the sweeps give and against the conditions themselves.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn floor(w: &mut World) {
    let body = w.add_body(FIXED).unwrap();
    w.add_collider(body, SHAPE_BOX, [50.0, 0.5, 50.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_v(POSITION_X, body as usize, v3(0.0, -0.5, 0.0));
}
fn block(w: &mut World, half: [f32; 3], at: V3) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, half, [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_v(POSITION_X, body as usize, at);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) & !CAN_SLEEP);
    body
}
fn size(v: V3) -> f32 {
    v.dot(v).sqrt()
}
fn pile(rows: usize, block_solver: bool, steps: usize) -> (World, Vec<(u32, V3)>) {
    let mut w = World::new((rows * (rows + 1) / 2 + 1) as u32, (rows * (rows + 1) / 2 + 1) as u32).unwrap();
    w.header_mut().substeps = 4;
    w.header_mut().iterations = 1;
    w.header_mut().block_solver = block_solver as u32;
    floor(&mut w);
    let mut bodies = vec![];
    for row in 0..rows {
        for i in 0..rows - row {
            let at = v3(i as f32 - (rows - row - 1) as f32 * 0.5, 0.5 + row as f32, 0.0);
            bodies.push((block(&mut w, [0.5, 0.5, 0.5], at), at));
        }
    }
    for _ in 0..steps {
        w.step(DT);
    }
    (w, bodies)
}

#[test]
fn a_box_rests_on_four_points_with_the_load_shared_evenly_and_where_the_sweeps_leave_it() {
    let mut results = vec![];
    for block_solver in [false, true] {
        let mut w = World::new(2, 2).unwrap();
        floor(&mut w);
        w.header_mut().block_solver = block_solver as u32;
        let b = block(&mut w, [0.5, 0.5, 0.5], v3(0.0, 0.5, 0.0));
        for _ in 0..240 {
            w.step(DT);
        }
        let row = (0..w.header().pair_rows as usize).find(|&r| w.uu(PAIR_A, r) != NONE).expect("a pair");
        assert_eq!(w.uu(PAIR_CONTACTS, row), 4);
        let loads: Vec<f32> = (0..4).map(|k| w.s(CONTACT_NORMAL_IMPULSE, row * MANIFOLD + k)).collect();
        let (low, high) = loads.iter().fold((f32::MAX, 0.0f32), |(l, h), &x| (l.min(x), h.max(x)));
        assert!(low > 0.0 && (high - low) < 0.02 * high, "block {block_solver}: loads {loads:?}");
        results.push(w.v(POSITION_X, b as usize));
    }
    // Both put the box where it sags to under its own weight: the same to a tenth of a millimetre.
    assert!(size(results[0].sub(results[1])) < 1e-4, "{:?}", results);
}

#[test]
fn a_pyramid_settles_with_the_block_solver_as_it_does_with_the_sweeps() {
    for block_solver in [false, true] {
        let (w, bodies) = pile(12, block_solver, 1200);
        let fastest = bodies.iter().fold(0.0f32, |m, &(b, _)| m.max(size(w.v(LINEAR_X, b as usize))));
        let moved = bodies.iter().fold(0.0f32, |m, &(b, at)| m.max(size(w.v(POSITION_X, b as usize).sub(at))));
        assert!(fastest < 1e-3 && moved < 0.04, "block {block_solver}: fastest {fastest} m/s, moved {moved} m");
    }
}

#[test]
fn the_block_solver_off_changes_nothing_and_on_changes_the_loads_not_the_rest() {
    // Off is the default: two worlds built alike hash alike. On, the same scene is another world (its loads are exact), and
    // it still stands where it did to a tenth of a millimetre.
    let (a, _) = pile(5, false, 120);
    let (b, _) = pile(5, false, 120);
    assert_eq!(a.hash(), b.hash());
    let (c, bodies) = pile(5, true, 120);
    assert_ne!(a.hash(), c.hash());
    for &(body, _) in &bodies {
        let off = a.v(POSITION_X, body as usize);
        let on = c.v(POSITION_X, body as usize);
        assert!(size(off.sub(on)) < 1e-3, "body {body}: {off:?} against {on:?}");
    }
}

#[cfg(feature = "counts")]
#[test]
fn no_manifold_of_the_standard_scenes_is_left_to_the_sweeps() {
    // For a positive definite matrix the complementarity problem has one answer and the enumeration must find it: a miss is a
    // fault, not a limit. The box on four points, a 12-row pyramid and a 20-row pile of 210 boxes.
    use margoengine_physics_kernel::solver::BLOCK_SOLVES;
    use std::sync::atomic::Ordering::Relaxed;
    for (name, rows, steps) in [("a box", 1, 240), ("a pyramid", 12, 600), ("a pile of 210", 20, 300)] {
        let before = [BLOCK_SOLVES[0].load(Relaxed), BLOCK_SOLVES[1].load(Relaxed)];
        let _ = pile(rows, true, steps);
        let (exact, left) = (BLOCK_SOLVES[0].load(Relaxed) - before[0], BLOCK_SOLVES[1].load(Relaxed) - before[1]);
        assert!(exact > 100 && left == 0, "{name}: {exact} exact, {left} left to the sweeps");
    }
}
