// The harness bars of physics-refs that more than one pair decides, natively, at the defaults (8 substeps of 2 passes)
// and at equal cost (4 of 1): the scenes of js/margo-next/margo3d.mjs, through the kernel's own calls. Native and Wasm agree
// bit for bit, so these are the harness's numbers. `cargo run --release --example bars`.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const DT: f32 = 1.0 / 60.0;

fn world(bodies: u32, equal: bool) -> World {
    let mut w = World::new(bodies, bodies).unwrap();
    w.header_mut().gravity = [0.0, -9.81, 0.0];
    if equal {
        w.header_mut().substeps = 4;
        w.header_mut().iterations = 1;
    }
    let floor = w.add_body(FIXED).unwrap();
    w.add_collider(floor, SHAPE_BOX, [500.0, 0.5, 500.0], [0.0; 3], IDENTITY, 0.0).unwrap();
    w.set_pose(floor, v3(0.0, -0.5, 0.0), Q::IDENTITY, false);
    w
}
fn cube(w: &mut World, at: V3, density: f32) -> u32 {
    let body = w.add_body(DYNAMIC).unwrap();
    w.add_collider(body, SHAPE_BOX, [0.5, 0.5, 0.5], [0.0; 3], IDENTITY, density).unwrap();
    w.set_pose(body, at, Q::IDENTITY, false);
    body
}
fn size(v: V3) -> f32 {
    sqrt(v.dot(v))
}

fn main() {
    for equal in [false, true] {
        let label = if equal { "equal 4x1" } else { "defaults 8x2" };
        // Ball of r 0.5 dropped from 1 m, restitution 0.5 on both colliders, 10 s: the first peaks against e^2 h.
        {
            let mut w = world(2, equal);
            w.set_s(COLLIDER_RESTITUTION, 0, 0.5);
            let body = w.add_body(DYNAMIC).unwrap();
            let ball = w.add_collider(body, SHAPE_BALL, [0.5, 0.0, 0.0], [0.0; 3], IDENTITY, 1.0).unwrap();
            w.set_s(COLLIDER_RESTITUTION, ball as usize, 0.5);
            w.set_pose(body, v3(0.0, 1.5, 0.0), Q::IDENTITY, false);
            let (mut last, mut peaks) = (0.0f32, vec![]);
            for _ in 0..600 {
                w.step(DT);
                let v = w.v(LINEAR_X, body as usize).y;
                if last > 0.0 && v <= 0.0 {
                    peaks.push(w.v(POSITION_X, body as usize).y - 0.5);
                }
                last = v;
            }
            println!("{label} bounce: peaks {:?} (0.25, 0.0625, 0.015625)", &peaks[..peaks.len().min(3)]);
        }
        if std::env::args().any(|a| a == "bounce") {
            continue;
        }
        // Pyramid of 20 rows, touching side by side, 30 s.
        let rows = 20;
        let mut w = world(rows * (rows + 1) / 2 + 1, equal);
        let mut bodies = vec![];
        for row in 0..rows {
            for i in 0..rows - row {
                let at = v3(i as f32 - (rows - row - 1) as f32 * 0.5, 0.5 + row as f32, 0.0);
                bodies.push((cube(&mut w, at, 1.0), at));
            }
        }
        let mut asleep = None;
        for step in 0..1800 {
            w.step(DT);
            if asleep.is_none() && w.header().awake == 0 {
                asleep = Some((step + 1) as f32 * DT);
            }
        }
        let (top, start) = *bodies.last().unwrap();
        let lowest = bodies[..20].iter().fold(f32::INFINITY, |m, &(b, _)| m.min(w.v(POSITION_X, b as usize).y - 0.5));
        let fastest = bodies.iter().fold(0.0f32, |m, &(b, _)| m.max(size(w.v(LINEAR_X, b as usize))));
        let moved = bodies.iter().fold(0.0f32, |m, &(b, at)| m.max(size(w.v(POSITION_X, b as usize).sub(at))));
        println!(
            "{label} pyramid: sink {:.3} mm, top moved {:.2} mm, any box moved {:.2} mm, fastest {:.4} m/s, asleep at {:?} s",
            -lowest * 1e3,
            size(w.v(POSITION_X, top as usize).sub(start)) * 1e3,
            moved * 1e3,
            fastest,
            asleep
        );
        // Heavy cube on a light one, 10 s.
        for ratio in [100.0f32, 1000.0] {
            let mut w = world(3, equal);
            let light = cube(&mut w, v3(0.0, 0.5, 0.0), 1.0);
            let heavy = cube(&mut w, v3(0.0, 1.5, 0.0), ratio);
            for _ in 0..600 {
                w.step(DT);
            }
            let (top, bottom) = (w.v(POSITION_X, heavy as usize), w.v(POSITION_X, light as usize));
            println!(
                "{label} heavy on light 1:{ratio}: sag {:.2} mm, drift top {:.3} mm, bottom {:.3} mm",
                (1.5 - top.y) * 1e3,
                (top.x * top.x + top.z * top.z).sqrt() * 1e3,
                (bottom.x * bottom.x + bottom.z * bottom.z).sqrt() * 1e3
            );
        }
    }
}
