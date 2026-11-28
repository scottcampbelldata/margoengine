// Strike pieces (KB-PHYS-CCDKNOCK1, strike.rs): a spinning steel bar with continuous collision striking a free plate at 300 m/s
// is knocked sideways by the same speed as on a step fine enough to find its points again, and that speed settles as the
// substeps rise; an island with nothing to strike steps bit for bit as before.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

/// The xorshift of `packages/physics/tests/next-ccd.test.js`, in the doubles it draws.
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0 as f64 / 4294967296.0
    }
}

/// Bullet `index` of that test's 200 (seed 9): a 4 x 4 x 12 cm steel bar at 300 m/s, spinning up to 50 rad/s about each axis.
fn bullet(index: usize) -> (V3, V3) {
    let mut next = Rng(9);
    let mut out = (v3(0.0, 0.0, 0.0), v3(0.0, 0.0, 0.0));
    for i in 0..=index {
        let p = [next.next() * 4.0, next.next() * 8.0 - 4.0, next.next() * 8.0 - 4.0];
        let w = [next.next() * 50.0, next.next() * 50.0, next.next() * 50.0];
        if i == index {
            out = (v3(p[0] as f32, p[1] as f32, p[2] as f32), v3(w[0] as f32, w[1] as f32, w[2] as f32));
        }
    }
    out
}

/// The bullet alone with the free plate (2 cm thick at x = 10, 12 m across, 1e7 kg/m3), no gravity, `steps` steps of `dt` at
/// `substeps` substeps: the bullet's sideways speed and spin at the end, the steps' strike events, and how many pieces it took.
fn strike(index: usize, dt: f32, steps: usize, substeps: u32, adaptive: bool) -> (f32, f32, usize) {
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    w.header_mut().substeps = substeps;
    w.header_mut().adaptive_substeps = adaptive as u32;
    let plate = w.add_body(DYNAMIC).unwrap();
    w.add_collider(plate, SHAPE_BOX, [0.01, 6.0, 6.0], [0.0; 3], IDENTITY, 1e7).unwrap();
    w.update_mass(plate);
    w.set_pose(plate, v3(10.0, 0.0, 0.0), Q::IDENTITY, true);
    let (position, spin) = bullet(index);
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, [0.02, 0.02, 0.06], [0.0; 3], IDENTITY, 7800.0).unwrap();
    w.update_mass(body);
    w.set_u(FLAGS, body as usize, w.flags(body as usize) | CCD);
    w.set_pose(body, position, Q::IDENTITY, true);
    w.set_v(LINEAR_X, body as usize, v3(300.0, 0.0, 0.0));
    w.set_v(ANGULAR_X, body as usize, spin);
    let mut started = 0;
    for _ in 0..steps {
        w.step(dt);
        for e in 0..w.header().events as usize {
            if w.uu(EVENTS, 2 * e) & EVENT_STARTED != 0 {
                started += 1;
            }
        }
    }
    let (v, s) = (w.v(LINEAR_X, body as usize), w.v(ANGULAR_X, body as usize));
    (sqrt(v.y * v.y + v.z * v.z), sqrt(s.dot(s)), started)
}

/// The knock on a step fine enough to find the bullet's points again: 1 substep at 1/(60 x 32,768) s, over the same time.
fn fine(index: usize, steps: usize) -> f32 {
    let parts = 32_768;
    strike(index, DT / parts as f32, steps * parts, 1, false).0
}

/// Within 10 percent of `reference`.
fn near(knock: f32, reference: f32) -> bool {
    (knock - reference).abs() <= 0.1 * reference
}

#[test]
fn a_spinning_bar_striking_a_free_plate_is_knocked_as_on_a_fine_step() {
    // Before strike pieces the default step knocked bullets 64, 10, 100 and 150 sideways at 44.3, 0.28, 4.98 and 0.16 m/s
    // against 63.2, 63.1, 72.5 and 61.3 on the fine step.
    for index in [64, 10, 100, 150] {
        let reference = fine(index, 3);
        let (knock, spin, started) = strike(index, DT, 3, 8, true);
        assert!(near(knock, reference), "bullet {index}: knocked at {knock} m/s (spin {spin} rad/s) against {reference} on a fine step");
        // Two touches in three steps, as before strike pieces: the pieces neither lose a strike's event nor add one.
        assert_eq!(started, 2, "bullet {index}: {started} started events");
    }
}

#[test]
fn the_knock_settles_as_the_substeps_rise() {
    // Before: 44.3, 24.7, 10.7 and 17.6 m/s at 8, 16, 32 and 64 substeps, away from the fine step's 63.2.
    let reference = fine(64, 3);
    for substeps in [8, 16, 32, 64] {
        let (knock, _, _) = strike(64, DT, 3, substeps, true);
        assert!(near(knock, reference), "{substeps} substeps: knocked at {knock} m/s against {reference}");
    }
}

/// A cylinder 0.3 m in radius rolling at 30 m/s on a floor, its axis along Z, with or without continuous collision: the
/// poses of 120 steps, as bits.
fn rolling(ccd: bool) -> Vec<[u32; 7]> {
    let mut w = World::new(4, 4).unwrap();
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [100.0, 0.5, 100.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(floor, v3(0.0, -0.5, 0.0), Q::IDENTITY, false);
    let wheel = w.add_body(DYNAMIC).unwrap();
    let half = core::f32::consts::FRAC_1_SQRT_2;
    w.add_collider(wheel, SHAPE_CYLINDER, [0.3, 0.1, 0.0], [0.0; 3], [half, 0.0, 0.0, half], 1000.0).unwrap();
    w.update_mass(wheel);
    w.set_pose(wheel, v3(-50.0, 0.3, 0.0), Q::IDENTITY, true);
    w.set_v(LINEAR_X, wheel as usize, v3(30.0, 0.0, 0.0));
    w.set_v(ANGULAR_X, wheel as usize, v3(0.0, 0.0, -100.0));
    if ccd {
        w.set_u(FLAGS, wheel as usize, w.flags(wheel as usize) | CCD);
    }
    (0..120)
        .map(|_| {
            w.step(DT);
            let (p, q) = (w.v(POSITION_X, wheel as usize), w.q(ROTATION_X, wheel as usize));
            [p.x.to_bits(), p.y.to_bits(), p.z.to_bits(), q.x.to_bits(), q.y.to_bits(), q.z.to_bits(), q.w.to_bits()]
        })
        .collect()
}

#[test]
fn a_rolling_ccd_cylinder_takes_no_strike_piece() {
    // A cylinder turning about its own axis brings no new feature to the floor, so its island steps as one without
    // continuous collision would, bit for bit.
    let (with, without) = (rolling(true), rolling(false));
    assert_eq!(with, without);
    let end = f32::from_bits(with[119][0]);
    assert!(end > -20.0, "the wheel rolled to x = {end}");
}

#[test]
#[ignore]
fn print_the_knocks() {
    for index in [64, 10, 100, 150] {
        let fine = fine(index, 3);
        let at: Vec<String> = [8u32, 16, 32, 64].iter().map(|&n| format!("{:.2}", strike(index, DT, 3, n, true).0)).collect();
        println!("bullet {index}: fine {fine:.2} m/s, default {}", at.join(", "));
    }
}
