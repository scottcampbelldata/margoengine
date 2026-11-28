// Long chains held to reduced coordinates (src/multibody.rs): the projection onto the joint space stays a projection however
// many links the chain has, and a chain whose joints carry implicit springs (JOINT_ELASTIC) bends as the beam those springs
// make, at any number of links and substeps.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const G: f32 = 9.81;
const RADIUS: f32 = 0.01;
const DENSITY: f32 = 1000.0;
/// Turns a capsule's axis, local +Y, onto world +X.
const ALONG_X: Q = Q { x: 0.0, y: 0.0, z: -core::f32::consts::FRAC_1_SQRT_2, w: core::f32::consts::FRAC_1_SQRT_2 };

/// A 1 m chain of `n` capsules of radius 1 cm from a fixed wall along +X, each on a spherical joint to the one before, held as
/// one multibody with its self contacts off. Returns the links' rows and their joints' rows.
fn chain(w: &mut World, n: usize) -> (Vec<u32>, Vec<usize>) {
    w.header_mut().gravity = [0.0, -G, 0.0];
    let l = 1.0 / n as f32;
    let wall = w.add_body(FIXED).unwrap();
    let (mut rows, mut joints, mut parent) = (Vec::new(), Vec::new(), wall);
    for i in 0..n {
        let b = w.add_body(DYNAMIC).unwrap();
        w.add_collider(b, SHAPE_CAPSULE, [RADIUS, l / 2.0, 0.0], [0.0; 3], [0.0, 0.0, 0.0, 1.0], DENSITY).unwrap();
        w.set_pose(b, v3((i as f32 + 0.5) * l, 0.0, 0.0), ALONG_X, false);
        let j = w.add_joint(parent, b, JOINT_LOCK * 7).unwrap() as usize;
        w.set_s(JOINT_ANCHOR_A_Y, j, if i == 0 { 0.0 } else { l / 2.0 });
        w.set_s(JOINT_ANCHOR_B_Y, j, -l / 2.0);
        for (column, value) in [(MB_ROLE, 2), (MB_ROOT, wall), (MB_NEXT, NONE), (MB_JOINT, j as u32), (MB_PARENT, parent)] {
            w.set_u(column, b as usize, value);
        }
        w.set_u(MB_NEXT, parent as usize, b);
        rows.push(b);
        joints.push(j);
        parent = b;
    }
    for (column, value) in [(MB_ROLE, 1), (MB_ROOT, wall), (MB_JOINT, NONE), (MB_PARENT, NONE), (MB_NO_SELF, 1)] {
        w.set_u(column, wall as usize, value);
    }
    for &b in &rows {
        w.touch_body(b);
    }
    (rows, joints)
}

fn mass(w: &World, b: u32) -> f64 {
    1.0 / w.s(INVERSE_MASS, b as usize) as f64
}

#[test]
fn a_long_slender_chain_falls_with_no_more_energy_than_it_had() {
    // Released level and still, a chain has no more energy to move with than its fall to hanging straight down gives it,
    // E0 - E_min with E_min the height energy of every link hanging below the wall, so a link of mass m never moves faster than
    // sqrt(2 (E0 - E_min) / m). The tree's pass from the last link to the first grew the asymmetry rounding leaves in the
    // links' inertias about 3.5 times a link, the projection put energy in, and a chain of 24 links ran past 10^5 m/s within
    // two seconds; 32 and 64 links were refused as past the numbers.
    for n in [24usize, 64] {
        let mut w = World::new(256, 256).unwrap();
        w.header_mut().substeps = 16;
        let (rows, _) = chain(&mut w, n);
        let l = 1.0 / n as f64;
        let start: f64 = rows.iter().map(|&b| mass(&w, b) * G as f64 * w.v(CENTER_X, b as usize).y as f64).sum();
        let lowest: f64 = rows.iter().enumerate().map(|(i, &b)| -mass(&w, b) * G as f64 * (i as f64 + 0.5) * l).sum();
        let mut nearest = 0.0f64;
        for step in 0..600 {
            w.step(1.0 / 60.0);
            assert_eq!(w.header().lost, NONE, "{n} links: the world stopped at step {step}");
            for &b in &rows {
                let v = w.v(LINEAR_X, b as usize);
                let most = (2.0 * (start - lowest) / mass(&w, b)).sqrt();
                let share = (v.dot(v) as f64).sqrt() / most;
                assert!(share <= 1.0, "{n} links, step {step}: a link at {share:.2} times the speed the fall can give it");
                nearest = nearest.max(share);
            }
        }
        println!("{n} links: nearest the energy bound {nearest:.3}");
    }
}

/// The tip's fall of an `n`-link cantilever of bending stiffness `ei` held by implicit springs, at `substeps`, after 10 s of
/// settling, and the fall at which its chain of springs balances the links' weights: joint j turns by theta_j with
/// k_j theta_j = -M_j, M_j the moment of the weights beyond it about it with the arms the bent chain has, and k_j = EI / l
/// (2 EI / l at the wall, which bends half a link). The balance is found by turning the joints to the moments of the last
/// shape until the shape stops changing, so it holds at any slope, not only the small ones.
fn cantilever(n: usize, substeps: u32, ei: f32) -> (f64, f64) {
    let mut w = World::new(256, 256).unwrap();
    w.header_mut().substeps = substeps;
    let (rows, joints) = chain(&mut w, n);
    let l = 1.0 / n as f32;
    for (i, &j) in joints.iter().enumerate() {
        let k = if i == 0 { 2.0 * ei / l } else { ei / l };
        if i == 0 {
            // The wall's frame stands as the first link does, so the straight rod is the rest.
            w.set_q(JOINT_FRAME_A_X, j, ALONG_X);
        }
        let mut flags = w.uu(JOINT_FLAGS, j);
        for axis in 3..6 {
            flags |= (JOINT_MOTOR_ON | JOINT_MOTOR_FORCE) << axis;
            w.set_s(JOINT_STIFFNESS_0 + axis, j, k);
            w.set_s(JOINT_DAMPING_0 + axis, j, 0.02 * k);
            w.set_s(JOINT_CAP_0 + axis, j, f32::INFINITY);
            w.set_s(JOINT_TARGET_0 + axis, j, 0.0);
            w.set_s(JOINT_SPEED_0 + axis, j, 0.0);
        }
        w.set_u(JOINT_FLAGS, j, flags);
        w.set_u(JOINT_ELASTIC, j, 0b111000);
    }
    // The balance is the rod at rest. A sleeping rod stops where its speed fell under the sleep threshold, short of it (8 links
    // slept 0.57 % short), so these links never sleep.
    for &b in &rows {
        let flags = w.flags(b as usize);
        w.set_u(FLAGS, b as usize, flags & !CAN_SLEEP);
    }
    for _ in 0..600 {
        w.step(1.0 / 60.0);
    }
    let last = *rows.last().unwrap() as usize;
    let tip = w.v(POSITION_X, last).add(w.q(ROTATION_X, last).rotate(v3(0.0, l / 2.0, 0.0)));
    let (l, ei) = (l as f64, ei as f64);
    let weights: Vec<f64> = rows.iter().map(|&b| mass(&w, b) * G as f64).collect();
    let mut turns = vec![0.0f64; n];
    let mut fall = 0.0;
    for _ in 0..200 {
        // The shape the turns give: each link's slope, its joint and its centre.
        let (mut slope, mut at) = (0.0f64, (0.0f64, 0.0f64));
        let (mut joints_at, mut centres) = (Vec::with_capacity(n), Vec::with_capacity(n));
        for &turn in &turns {
            slope += turn;
            joints_at.push(at);
            centres.push(at.0 + 0.5 * l * slope.cos());
            at = (at.0 + l * slope.cos(), at.1 + l * slope.sin());
        }
        fall = -at.1;
        for j in 0..n {
            let moment: f64 = (j..n).map(|i| weights[i] * (centres[i] - joints_at[j].0)).sum();
            let k = if j == 0 { 2.0 * ei / l } else { ei / l };
            turns[j] = -moment / k;
        }
    }
    (-tip.y as f64, fall)
}

#[test]
fn a_chain_of_implicit_springs_bends_as_its_beam_at_any_length_and_substeps() {
    // EI = 7.7 N m^2 for a 1 cm nylon-like rod of capsules: the tip falls about 6 to 7 cm. Motors solved one joint at a time in the
    // joint passes ran away from 16 links on; held in the tree's direct solve each link count and substep count lands where its
    // chain of springs balances the weights. What is left is rounding: the poses are f32, a part in 10^7 of a metre's chain,
    // and the joint rows hold their anchors to the f32 step's slack, so 0.1 % is ten times what any case here shows. The
    // springs once projected all of the passes' speeds and took out the joint rows' push to close their gaps: the tip crept
    // down 5 % in 40 s at 16 substeps, so the run is long enough to see a creep of that size.
    for n in [8usize, 32, 64] {
        for substeps in [4u32, 16] {
            let (tip, springs) = cantilever(n, substeps, 7.7);
            let off = (tip - springs).abs() / springs;
            println!("{n} links, {substeps} substeps: tip falls {tip:.5} m, its springs give {springs:.5} m ({:.4} %)", off * 100.0);
            assert!(off < 1e-3, "{n} links, {substeps} substeps: the tip fell {tip} m where its springs give {springs} m");
        }
    }
}

#[test]
fn a_torque_held_on_a_tree_link_turns_it_at_the_torque_over_its_inertia_and_rotor() {
    // A bob of 1 kg and 0.004 kg m^2 a metre below a fixed pivot, hinged about x as a tree, with no gravity and a torque of 2 N m
    // on it: it turns at 2 t / (I + a), I = 1.004 about the pivot and a its rotor's inertia. The midpoint move of the poses turns
    // the bob back by h^2 / 2 of the torque's whole turn about its own centre, 500 rad/s^2, and leaves the lock projection to
    // close the pivot that opens; the tree's forward kinematics ran between the two, read the bob's turned rotation as the
    // hinge's angle, put its centre where that angle places it and kept the move as speed. The bob then turned the other way at
    // about 250 rad/s^2: -88.8 rad/s after a second, and -87.5 with a rotor of 0.5.
    const HINGE_X: u32 = JOINT_LOCK * 7 | JOINT_LOCK * (6 << 3);
    for armature in [0.0f32, 0.5] {
        let mut w = World::new(16, 16).unwrap();
        w.header_mut().gravity = [0.0, 0.0, 0.0];
        let pivot = w.add_body(FIXED).unwrap();
        let bob = w.add_body(DYNAMIC).unwrap();
        let row = bob as usize;
        w.set_s(INVERSE_MASS, row, 1.0);
        w.set_v(INERTIA_X, row, v3(0.004, 0.004, 0.004));
        w.set_v(INVERSE_INERTIA_X, row, v3(250.0, 250.0, 250.0));
        w.set_pose(bob, v3(0.0, -1.0, 0.0), Q::IDENTITY, false);
        w.set_u(FLAGS, row, w.flags(row) & !CAN_SLEEP);
        let j = w.add_joint(pivot, bob, HINGE_X).unwrap() as usize;
        w.set_v(JOINT_ANCHOR_B_X, j, v3(0.0, 1.0, 0.0));
        w.set_s(JOINT_ARMATURE_3, j, armature);
        for (column, value) in [(MB_ROLE, 2), (MB_ROOT, pivot), (MB_NEXT, NONE), (MB_JOINT, j as u32), (MB_PARENT, pivot)] {
            w.set_u(column, row, value);
        }
        for (column, value) in [(MB_ROLE, 1), (MB_ROOT, pivot), (MB_NEXT, bob), (MB_JOINT, NONE), (MB_PARENT, NONE), (MB_NO_SELF, 1)] {
            w.set_u(column, pivot as usize, value);
        }
        w.touch_body(bob);
        for _ in 0..60 {
            w.set_v(TORQUE_X, row, v3(2.0, 0.0, 0.0));
            w.step(1.0 / 60.0);
        }
        let (spun, expected) = (w.v(ANGULAR_X, row).x, 2.0 / (1.004 + armature));
        // The rotor's case to the JS suite's bar; without one, the bob's own small inertia leaves the midpoint move's turn
        // larger against its free motion, and the projection at the turned pose keeps 1.4e-4 of it (docs/known-bugs.md,
        // KB-PHYS-LOCKTURN1).
        let bar = if armature > 0.0 { 1e-4 } else { 1e-3 };
        assert!((spun / expected - 1.0).abs() < bar, "rotor {armature}: {spun} rad/s against {expected}");
    }
}

/// A chain of `n` bobs of 0.5 kg and radius 2 cm hung 0.1 m apart from a fixed pivot on hinges about x, its coordinates
/// alternating `zig` and -`zig`, as one multibody. Returns the bobs' rows.
fn hinge_chain(w: &mut World, n: usize, zig: f64) -> Vec<u32> {
    const HINGE_X: u32 = JOINT_LOCK * 7 | JOINT_LOCK * (6 << 3);
    w.header_mut().gravity = [0.0, -G, 0.0];
    let pivot = w.add_body(FIXED).unwrap();
    let (mut parent, mut at, mut theta) = (pivot, v3(0.0, 0.0, 0.0), 0.0f64);
    let mut rows = Vec::new();
    for i in 0..n {
        theta += if i % 2 == 1 { zig } else { -zig };
        let turn = Q { x: (theta / 2.0).sin() as f32, y: 0.0, z: 0.0, w: (theta / 2.0).cos() as f32 };
        let place = at.add(turn.rotate(v3(0.0, -0.1, 0.0)));
        let b = w.add_body(DYNAMIC).unwrap();
        let row = b as usize;
        // A solid sphere: 2/5 m r^2.
        w.set_s(INVERSE_MASS, row, 2.0);
        w.set_v(INERTIA_X, row, v3(8e-5, 8e-5, 8e-5));
        w.set_v(INVERSE_INERTIA_X, row, v3(12500.0, 12500.0, 12500.0));
        w.set_pose(b, place, turn, false);
        let j = w.add_joint(parent, b, HINGE_X).unwrap() as usize;
        w.set_v(JOINT_ANCHOR_B_X, j, v3(0.0, 0.1, 0.0));
        for (column, value) in [(MB_ROLE, 2), (MB_ROOT, pivot), (MB_NEXT, NONE), (MB_JOINT, j as u32), (MB_PARENT, parent)] {
            w.set_u(column, row, value);
        }
        w.set_u(MB_NEXT, parent as usize, b);
        rows.push(b);
        (parent, at) = (b, place);
    }
    for (column, value) in [(MB_ROLE, 1), (MB_ROOT, pivot), (MB_JOINT, NONE), (MB_PARENT, NONE), (MB_NO_SELF, 1)] {
        w.set_u(column, pivot as usize, value);
    }
    for &b in &rows {
        w.touch_body(b);
    }
    rows
}

#[test]
fn a_long_path_s_banded_step_is_the_whole_matrix_s() {
    // A path of 64 lock rows or more solves its Newton step on the band of its matrix, O(n w^2), where the QR of the whole matrix
    // is O(n^3): a chain of 200 hinges, a path of 1,000 rows, took 1,607 s for two seconds in the JS suite. Run both ways on
    // shorter paths, every pose comes out the same at f32: the two solves differ only in the rounding of doubles. A hanging
    // chain of hinges comes out the same to the bit for two seconds; a chain of balls released level tumbles, and its rounding
    // grows as a tumble's does (3e-17 m at 8 balls, 0.14 m at 24 after two seconds), so it is compared over its first sixth of a second (5.7e-6 m apart at 24 balls after half a second).
    use margoengine_physics_kernel::joints::BANDED_FROM;
    let run = |banded: bool, hinges: bool, n: usize| -> (Vec<V3>, u32) {
        let steps = if hinges { 120 } else { 10 };
        BANDED_FROM.with(|b| b.set(if banded { 0 } else { usize::MAX }));
        let mut w = World::new(256, 256).unwrap();
        let rows = if hinges { hinge_chain(&mut w, n, 0.02) } else { chain(&mut w, n).0 };
        for _ in 0..steps {
            w.step(1.0 / 60.0);
        }
        BANDED_FROM.with(|b| b.set(margoengine_physics_kernel::joints::BANDED_ROWS));
        (rows.iter().map(|&b| w.v(CENTER_X, b as usize)).collect(), w.hash())
    };
    for (hinges, n) in [(true, 3usize), (true, 12), (true, 40), (false, 8), (false, 24)] {
        let (dense, dense_hash) = run(false, hinges, n);
        let (band, band_hash) = run(true, hinges, n);
        let apart = dense.iter().zip(&band).map(|(a, b)| a.sub(*b)).map(|d| d.dot(d).sqrt()).fold(0.0f32, f32::max);
        assert!(apart < 1e-6, "{n} {}: the banded step moved a link {apart} m from the dense one", if hinges { "hinges" } else { "balls" });
        println!("{n} {}: apart {apart:.1e} m, hashes {dense_hash:x} {band_hash:x}", if hinges { "hinges" } else { "balls" });
    }
}

