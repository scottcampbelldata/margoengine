// Long chains held to reduced coordinates (src/multibody.rs): the projection onto the joint space stays a projection however
// many links the chain has.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const G: f32 = 9.81;
const RADIUS: f32 = 0.01;
const DENSITY: f32 = 1000.0;
/// Turns a capsule's axis, local +Y, onto world +X.
const ALONG_X: Q = Q { x: 0.0, y: 0.0, z: -core::f32::consts::FRAC_1_SQRT_2, w: core::f32::consts::FRAC_1_SQRT_2 };

/// A 1 m chain of `n` capsules of radius 1 cm from a fixed wall along +X, each on a spherical joint to the one before, held as
/// one multibody with its self contacts off. Returns the links' rows.
fn chain(w: &mut World, n: usize) -> Vec<u32> {
    w.header_mut().gravity = [0.0, -G, 0.0];
    let l = 1.0 / n as f32;
    let wall = w.add_body(FIXED).unwrap();
    let (mut rows, mut parent) = (Vec::new(), wall);
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
        parent = b;
    }
    for (column, value) in [(MB_ROLE, 1), (MB_ROOT, wall), (MB_JOINT, NONE), (MB_PARENT, NONE), (MB_NO_SELF, 1)] {
        w.set_u(column, wall as usize, value);
    }
    for &b in &rows {
        w.touch_body(b);
    }
    rows
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
        let rows = chain(&mut w, n);
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
