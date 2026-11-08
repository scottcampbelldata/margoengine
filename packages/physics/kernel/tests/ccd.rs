// Continuous collision: fast bodies with CCD on never end a step past a thin wall, a mesh or a height field; with it off
// the same shots pass, so the scenes can fail; a slow CCD body moves bit-equal to one without it; CCD_ACTIVE says which
// bodies the pass checked.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.next()
    }
}

/// A wall 2 cm thick across x = 10, as a box, a two-triangle mesh or a flat height field stood on end.
fn wall(w: &mut World, kind: u32) {
    let body = w.add_body(FIXED).unwrap();
    match kind {
        0 => {
            w.add_collider(body, SHAPE_BOX, [0.01, 6.0, 6.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        }
        1 => {
            let vertices = [v3(0.0, -6.0, -6.0), v3(0.0, 6.0, -6.0), v3(0.0, 6.0, 6.0), v3(0.0, -6.0, 6.0)];
            let triangles = [[0u32, 1, 2], [0, 2, 3]];
            assert!(w.begin_mesh(4, 2));
            let [_, v0, t0, _, _] = w.header().mesh_rows;
            for (i, &p) in vertices.iter().enumerate() {
                w.set_v(MESH_VERTEX_X, v0 as usize + i, p);
            }
            for (i, t) in triangles.iter().enumerate() {
                let at = t0 as usize + i;
                w.set_u(TRIANGLE_A, at, t[0]);
                w.set_u(TRIANGLE_B, at, t[1]);
                w.set_u(TRIANGLE_C, at, t[2]);
                for k in 0..3 {
                    w.set_u(TRIANGLE_ACROSS_0 + k, at, NONE);
                }
            }
            let mesh = w.end_mesh(4, 2, 0);
            assert!(mesh >= 0);
            w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        }
        _ => {
            // A flat height field of 4 by 4 cells over 12 m, its up axis turned from y to -x.
            assert!(w.begin_mesh(25, 0));
            let v0 = w.header().mesh_rows[1] as usize;
            for c in 0..5 {
                for r in 0..5 {
                    w.set_v(MESH_VERTEX_X, v0 + r + 5 * c, v3(-6.0 + 3.0 * c as f32, 0.0, -6.0 + 3.0 * r as f32));
                }
            }
            let mesh = w.end_grid(4, 4, 0);
            assert!(mesh >= 0);
            let s = core::f32::consts::FRAC_1_SQRT_2;
            w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], [0.0, 0.0, s, s], 0.0).unwrap();
        }
    }
    w.set_pose(body, v3(10.0, 0.0, 0.0), Q::IDENTITY, false);
}

/// Shoots `count` bullets of `shape` at 300 m/s, turning fast, from x 0 to 4 at the wall; how many end past it.
fn shoot(kind: u32, shape: u32, ccd: bool, count: usize) -> usize {
    let mut w = World::new(count as u32 + 1, count as u32 + 1).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    wall(&mut w, kind);
    let mut rng = Rng(5);
    let size = match shape {
        SHAPE_BALL => [0.02, 0.0, 0.0],
        SHAPE_CAPSULE => [0.02, 0.05, 0.0],
        _ => [0.02, 0.02, 0.06],
    };
    let mut bodies = Vec::new();
    for _ in 0..count {
        let body = w.add_body(DYNAMIC).unwrap();
        w.add_collider(body, shape, size, [0.0; 3], IDENTITY, 7800.0).unwrap();
        let turn = Q::from_rotation_vector(v3(rng.range(-3.0, 3.0), rng.range(-3.0, 3.0), rng.range(-3.0, 3.0)));
        w.set_pose(body, v3(rng.range(0.0, 4.0), rng.range(-4.0, 4.0), rng.range(-4.0, 4.0)), turn, true);
        w.set_v(LINEAR_X, body as usize, v3(300.0, rng.range(-15.0, 15.0), rng.range(-15.0, 15.0)));
        w.set_v(ANGULAR_X, body as usize, v3(rng.range(0.0, 50.0), rng.range(0.0, 50.0), rng.range(0.0, 50.0)));
        if ccd {
            w.set_u(FLAGS, body as usize, w.flags(body as usize) | CCD);
        }
        w.update_mass(body);
        bodies.push(body as usize);
    }
    // A bullet passes when a step takes its centre across x = 10 inside the wall's 12 m square (one that flies round the
    // edge, after a knock from another bullet, does not count).
    let mut past = vec![false; count];
    let mut was: Vec<V3> = bodies.iter().map(|&b| w.v(POSITION_X, b)).collect();
    for _ in 0..30 {
        w.step(DT);
        for (i, &b) in bodies.iter().enumerate() {
            let now = w.v(POSITION_X, b);
            if was[i].x < 10.0 && now.x >= 10.0 {
                let at = was[i].add(now.sub(was[i]).scale((10.0 - was[i].x) / (now.x - was[i].x)));
                past[i] |= at.y.abs() < 6.0 && at.z.abs() < 6.0;
            }
            was[i] = now;
        }
    }
    past.iter().filter(|&&p| p).count()
}

#[test]
fn a_thousand_bullets_at_300_m_s_never_pass_a_thin_wall() {
    for kind in 0..3 {
        for shape in [SHAPE_BALL, SHAPE_BOX, SHAPE_CAPSULE] {
            assert_eq!(shoot(kind, shape, true, 1000), 0, "wall {kind}, shape {shape}");
        }
    }
}

#[test]
fn without_ccd_the_same_bullets_pass() {
    // The scene can fail: speculative contacts alone let some through.
    let passed: usize = (0..3).map(|kind| shoot(kind, SHAPE_BOX, false, 1000)).sum();
    assert!(passed > 0, "no bullet passed without CCD, so the CCD test proves nothing");
}

#[test]
fn a_slow_ccd_body_moves_bit_equal_to_one_without() {
    let run = |ccd: bool| {
        let mut w = World::new(4, 4).unwrap();
        let floor = w.add_body(FIXED).unwrap();
        w.add_collider(floor, SHAPE_BOX, [50.0, 0.5, 50.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_pose(floor, v3(0.0, -0.5, 0.0), Q::IDENTITY, false);
        let body = w.add_body(DYNAMIC).unwrap();
        w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, 1.0).unwrap();
        w.update_mass(body);
        w.set_pose(body, v3(0.0, 2.0, 0.0), Q::from_rotation_vector(v3(0.3, 0.2, 0.1)), true);
        w.set_v(LINEAR_X, body as usize, v3(2.0, 0.0, 0.0));
        if ccd {
            w.set_u(FLAGS, body as usize, w.flags(body as usize) | CCD);
        }
        let mut poses = Vec::new();
        for _ in 0..240 {
            w.step(DT);
            let (p, q) = (w.v(POSITION_X, body as usize), w.q(ROTATION_X, body as usize));
            poses.push([p.x.to_bits(), p.y.to_bits(), p.z.to_bits(), q.x.to_bits(), q.y.to_bits(), q.z.to_bits(), q.w.to_bits()]);
            if ccd {
                assert_eq!(w.flags(body as usize) & CCD_ACTIVE, 0, "a body moving less than its thickness is not checked");
            }
        }
        poses
    };
    assert_eq!(run(true), run(false));
}

#[test]
fn ccd_active_marks_the_bodies_the_pass_checked() {
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    wall(&mut w, 0);
    let fast = w.add_body(DYNAMIC).unwrap();
    w.add_collider(fast, SHAPE_BALL, [0.05, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_u(FLAGS, fast as usize, w.flags(fast as usize) | CCD);
    w.update_mass(fast);
    w.set_v(LINEAR_X, fast as usize, v3(300.0, 0.0, 0.0));
    w.step(DT);
    assert_ne!(w.flags(fast as usize) & CCD_ACTIVE, 0);
    w.set_v(LINEAR_X, fast as usize, v3(0.0, 0.0, 0.0));
    w.step(DT);
    assert_eq!(w.flags(fast as usize) & CCD_ACTIVE, 0);
}

#[test]
fn a_ccd_ball_stops_at_the_wall_short_of_it_by_no_more_than_the_touch() {
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    wall(&mut w, 0);
    let ball = w.add_body(DYNAMIC).unwrap();
    w.add_collider(ball, SHAPE_BALL, [0.05, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
    w.set_u(FLAGS, ball as usize, w.flags(ball as usize) | CCD);
    w.set_pose(ball, v3(6.0, 0.0, 0.0), Q::IDENTITY, true);
    w.update_mass(ball);
    w.set_v(LINEAR_X, ball as usize, v3(300.0, 0.0, 0.0));
    w.step(DT);
    // The wall's face is at x 9.99, the ball's centre stops 0.05 before it, less at most the sweep's touch of 1e-3.
    let x = w.v(POSITION_X, ball as usize).x;
    assert!(x <= 9.94 + 1e-5 && x >= 9.94 - 1.5e-3, "{x}");
}



/// Regression: a body the sweep had put back within the touch of a wall was put back to the start of every later step,
/// frozen, while the wall moved on through it, since the sweep read that touch as a new one at time 0. A part already
/// touching at the start is the contacts' to hold, as one overlapping is.
#[test]
fn a_ccd_bullet_stopped_on_a_moving_wall_is_carried_by_it() {
    let mut w = World::new(4, 4).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let wall = w.add_body(KINEMATIC_VELOCITY).unwrap();
    w.add_collider(wall, SHAPE_BOX, [0.01, 6.0, 6.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(wall, v3(10.0, 0.0, 0.0), Q::IDENTITY, false);
    w.set_v(LINEAR_X, wall as usize, v3(-20.0, 0.0, 0.0));
    let bullet = w.add_body(DYNAMIC).unwrap();
    w.add_collider(bullet, SHAPE_BOX, [0.02, 0.02, 0.06], [0.0; 3], IDENTITY, 7800.0).unwrap();
    w.set_pose(bullet, v3(0.5, 0.0, 0.0), Q::IDENTITY, true);
    w.set_v(LINEAR_X, bullet as usize, v3(300.0, 0.0, 0.0));
    w.set_u(FLAGS, bullet as usize, w.flags(bullet as usize) | CCD);
    w.update_mass(bullet);
    for step in 0..20 {
        w.step(DT);
        let (x, face) = (w.v(POSITION_X, bullet as usize).x, w.v(POSITION_X, wall as usize).x - 0.01);
        assert!(x < face, "step {step}: the bullet at {x} is past the wall's face at {face}");
    }
}

/// Regression: a fast CCD ball sliding on a floor touches it at the start of every step; the sweep froze it there.
/// Touching only the floor, it moves the same bits as without CCD.
#[test]
fn a_fast_ccd_ball_on_a_floor_moves_as_without_ccd() {
    let run = |ccd: bool| {
        let mut w = World::new(4, 4).unwrap();
        let floor = w.add_body(FIXED).unwrap();
        w.add_collider(floor, SHAPE_BOX, [500.0, 0.5, 500.0], [0.0; 3], IDENTITY, 0.0).unwrap();
        w.set_pose(floor, v3(0.0, -0.5, 0.0), Q::IDENTITY, false);
        let ball = w.add_body(DYNAMIC).unwrap();
        w.add_collider(ball, SHAPE_BALL, [0.05, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
        w.update_mass(ball);
        w.set_pose(ball, v3(0.0, 0.05, 0.0), Q::IDENTITY, true);
        w.set_v(LINEAR_X, ball as usize, v3(60.0, 0.0, 0.0));
        if ccd {
            w.set_u(FLAGS, ball as usize, w.flags(ball as usize) | CCD);
        }
        let mut xs = Vec::new();
        for _ in 0..60 {
            w.step(DT);
            xs.push(w.v(POSITION_X, ball as usize).x.to_bits());
            if ccd {
                assert_ne!(w.flags(ball as usize) & CCD_ACTIVE, 0, "the ball moves a metre a step, so the sweep checks it");
            }
        }
        xs
    };
    let (with, without) = (run(true), run(false));
    assert!(f32::from_bits(without[59]) > 30.0, "the ball should slide on");
    assert_eq!(with, without);
}

/// Regression: a CCD body was put back to its first touch while the moving body it met went on to the step's end, so it
/// ended the step inside it, past its middle when the wall moved faster than the bullet is thick, and was pushed out on
/// the far side. It now rides with what it met for the rest of the step.
#[test]
fn spinning_ccd_bullets_never_end_past_a_wall_that_comes_at_them() {
    let mut w = World::new(202, 202).unwrap();
    w.header_mut().gravity = [0.0, 0.0, 0.0];
    let wall = w.add_body(KINEMATIC_VELOCITY).unwrap();
    w.add_collider(wall, SHAPE_BOX, [0.01, 6.0, 6.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(wall, v3(10.0, 0.0, 0.0), Q::IDENTITY, false);
    w.set_v(LINEAR_X, wall as usize, v3(-20.0, 0.0, 0.0));
    let mut rng = Rng(9);
    let mut bullets = Vec::new();
    for _ in 0..200 {
        let bullet = w.add_body(DYNAMIC).unwrap();
        w.add_collider(bullet, SHAPE_BOX, [0.02, 0.02, 0.06], [0.0; 3], IDENTITY, 7800.0).unwrap();
        w.set_pose(bullet, v3(rng.range(0.0, 4.0), rng.range(-4.0, 4.0), rng.range(-4.0, 4.0)), Q::IDENTITY, true);
        w.set_v(LINEAR_X, bullet as usize, v3(300.0, 0.0, 0.0));
        w.set_v(ANGULAR_X, bullet as usize, v3(rng.range(0.0, 50.0), rng.range(0.0, 50.0), rng.range(0.0, 50.0)));
        w.set_u(FLAGS, bullet as usize, w.flags(bullet as usize) | CCD);
        w.update_mass(bullet);
        bullets.push(bullet as usize);
    }
    for step in 0..20 {
        w.step(DT);
        let middle = w.v(POSITION_X, wall as usize).x;
        for (i, &b) in bullets.iter().enumerate() {
            let x = w.v(POSITION_X, b).x;
            assert!(x < middle, "step {step}: bullet {i} at {x} is past the wall's middle at {middle}");
        }
    }
}
