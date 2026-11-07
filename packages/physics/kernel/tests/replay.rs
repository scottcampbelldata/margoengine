// The native twin of `kernelScene` in tests/replay-scene.js: the same calls in the same order must give the hashes the Wasm
// build gave, kept in tests/fixtures/replay-hash.json. Bit equality across Node and browsers is proved from the same file.
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::World;

const STEPS: u32 = 10_000;
const EVERY: u32 = 100;
const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const GRAVITY: [[f32; 3]; 4] = [[0.0, -9.81, 0.0], [0.0, 0.0, 0.0], [1.0, -2.0, 0.5], [0.0, 0.0, 0.0]];

struct Stream(u32);
impl Stream {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n
    }
    fn value(&mut self) -> f32 {
        (self.below(2049) as i32 - 1024) as f32 / 256.0
    }
    fn size(&mut self) -> f32 {
        0.25 + self.below(8) as f32 / 8.0
    }
}

/// What `KernelWorld.addBody` does: doubles the rows when they run out.
fn add_body(w: &mut World, kind: u32) -> u32 {
    w.add_body(kind).unwrap_or_else(|| {
        let header = w.header();
        let (bodies, colliders) = (header.capacity[0], header.capacity[1]);
        assert!(w.reserve(bodies * 2, colliders));
        w.add_body(kind).unwrap()
    })
}

/// What `KernelWorld.addCollider` does.
fn add_collider(w: &mut World, body: u32, shape: u32, size: [f32; 3], position: [f32; 3], rotation: [f32; 4], density: f32) {
    if w.add_collider(body, shape, size, position, rotation, density).is_none() {
        let header = w.header();
        let (bodies, colliders) = (header.capacity[0], header.capacity[1]);
        assert!(w.reserve(bodies, colliders * 2));
        w.add_collider(body, shape, size, position, rotation, density).unwrap();
    }
}

const OCTAHEDRON: [[f32; 3]; 6] = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];
const OCTAHEDRON_FACES: [&[u32]; 8] =
    [&[0, 2, 4], &[2, 1, 4], &[1, 3, 4], &[3, 0, 4], &[2, 0, 5], &[1, 2, 5], &[3, 1, 5], &[0, 3, 5]];

fn spawn(w: &mut World, random: &mut Stream, rows: &mut Vec<u32>, hull: f32) {
    let kind = [DYNAMIC, DYNAMIC, DYNAMIC, DYNAMIC, DYNAMIC, FIXED, KINEMATIC_POSITION, KINEMATIC_VELOCITY][random.below(8) as usize];
    let row = add_body(w, kind);
    let density = if kind == DYNAMIC { (1 + random.below(8)) as f32 } else { 0.0 };
    let o = [0.0; 3];
    match random.below(5) {
        0 => {
            let size = [random.size(), 0.0, 0.0];
            add_collider(w, row, SHAPE_BALL, size, o, IDENTITY, density);
        }
        1 => {
            let size = [random.size(), random.size(), random.size()];
            add_collider(w, row, SHAPE_BOX, size, o, IDENTITY, density);
        }
        2 => {
            let size = [random.size(), random.size(), 0.0];
            add_collider(w, row, SHAPE_CAPSULE, size, o, IDENTITY, density);
        }
        3 => add_collider(w, row, SHAPE_HULL, [hull, 0.0, 0.0], o, IDENTITY, density),
        _ => {
            let size = [random.size(), random.size(), random.size()];
            add_collider(w, row, SHAPE_BOX, size, o, IDENTITY, density);
            let size = [random.size(), 0.0, 0.0];
            add_collider(w, row, SHAPE_BALL, size, [1.0, 0.5, 0.0], [0.0, 0.0, 0.6, 0.8], density);
        }
    }
    let at = row as usize;
    let (x, y, z) = (random.value() * 2.0, random.value() * 2.0, random.value() * 2.0);
    let position = v3(x, y, z);
    w.set_v(POSITION_X, at, position);
    w.set_v(TARGET_X, at, position);
    if kind != FIXED && kind != KINEMATIC_POSITION {
        let (x, y, z) = (random.value(), random.value(), random.value());
        w.set_v(LINEAR_X, at, v3(x, y, z));
        let (x, y, z) = (random.value() * 2.0, random.value() * 2.0, random.value() * 2.0);
        w.set_v(ANGULAR_X, at, v3(x, y, z));
    }
    let damping = if random.below(4) == 0 { 0.0 } else { 2.0 };
    w.set_s(LINEAR_DAMPING, at, damping);
    w.set_s(ANGULAR_DAMPING, at, damping);
    w.touch_body(row);
    rows.push(row);
}

fn scene() -> Vec<u32> {
    let mut random = Stream(0x4D41_5247);
    let mut w = World::new(1, 1).unwrap();
    let mut rows = Vec::new();
    let mut hashes = Vec::new();
    let hull = w.add_hull(&OCTAHEDRON, &OCTAHEDRON_FACES) as f32;
    for _ in 0..48 {
        spawn(&mut w, &mut random, &mut rows, hull);
    }
    for i in 0..20usize {
        let a = rows[random.below(rows.len() as u32) as usize];
        let b = rows[random.below(rows.len() as u32) as usize];
        if a == b {
            continue;
        }
        let cone = 7 | JOINT_CONE | JOINT_LIMIT << 4 | JOINT_LIMIT << 3;
        let joint = w.add_joint(a, b, if i < 16 { [7, 7 | (6 << 3), 6 | (7 << 3), 63][i % 4] } else { cone }).unwrap();
        let at = joint as usize;
        w.set_s(JOINT_ANCHOR_A_X, at, random.value() / 4.0);
        w.set_s(JOINT_ANCHOR_A_Y, at, random.value() / 4.0);
        w.set_s(JOINT_ANCHOR_B_Z, at, random.value() / 4.0);
        if i >= 16 {
            w.set_s(JOINT_MIN_3, at, -0.4);
            w.set_s(JOINT_MAX_3, at, 0.4);
            w.set_s(JOINT_MIN_4, at, f32::NEG_INFINITY);
            w.set_s(JOINT_MIN_5, at, 0.3);
            w.set_s(JOINT_MAX_5, at, 0.8);
        } else if i % 4 == 1 {
            let (x, z) = (random.value(), random.value());
            w.set_joint_axis(joint, v3(x, 1.0, z));
            w.set_u(JOINT_FLAGS, at, w.uu(JOINT_FLAGS, at) | JOINT_LIMIT << 3);
            w.set_s(JOINT_MIN_3, at, -1.0);
            w.set_s(JOINT_MAX_3, at, 1.0);
        }
        if i < 16 && i % 8 == 1 {
            w.set_u(JOINT_FLAGS, at, w.uu(JOINT_FLAGS, at) | JOINT_MOTOR_ON << 3);
            w.set_s(JOINT_TARGET_3, at, 0.5);
            w.set_s(JOINT_STIFFNESS_3, at, 50.0);
            w.set_s(JOINT_DAMPING_3, at, 5.0);
            w.set_s(JOINT_CAP_3, at, 100.0);
        }
    }
    for i in 0..STEPS {
        if i % 512 == 0 {
            w.header_mut().gravity = GRAVITY[((i / 512) % 4) as usize];
            for &row in &rows {
                if w.body_alive(row) {
                    w.wake(row);
                }
                w.set_v(FORCE_X, row as usize, v3(0.0, 0.0, 0.0));
                w.set_v(TORQUE_X, row as usize, v3(0.0, 0.0, 0.0));
            }
        }
        if i % 2048 == 0 {
            w.header_mut().substeps = 1 + (i / 2048) % 4;
        }
        if i == 4096 {
            assert!(w.reserve(300, 300));
        }
        if i % 97 == 0 && rows.len() > 8 {
            let at = random.below(rows.len() as u32) as usize;
            assert!(w.remove_body(rows[at]));
            rows.swap_remove(at);
        }
        if i % 101 == 0 && rows.len() < 96 {
            spawn(&mut w, &mut random, &mut rows, hull);
        }
        let pick = rows[random.below(rows.len() as u32) as usize];
        let at = pick as usize;
        if i % 29 == 0 {
            w.wake(pick);
            let x = random.value();
            w.set_s(IMPULSE_X, at, x);
            let y = random.value();
            w.set_s(IMPULSE_Y, at, y);
            let z = random.value();
            w.set_s(ANGULAR_IMPULSE_Z, at, z);
        }
        if i % 41 == 0 {
            w.wake(pick);
            let force = if w.s(FORCE_Y, at) == 0.0 { random.value() } else { 0.0 };
            w.set_s(FORCE_Y, at, force);
            let torque = if w.s(TORQUE_X, at) == 0.0 { random.value() } else { 0.0 };
            w.set_s(TORQUE_X, at, torque);
        }
        if i % 503 == 0 {
            w.request_sleep(pick);
        }
        if i % 509 == 0 {
            let flags = w.flags(at);
            w.set_u(FLAGS, at, if i % 2 == 0 { flags | CAN_SLEEP } else { flags & !CAN_SLEEP });
        }
        if i % 211 == 0 && w.flags(at) & KIND == FIXED {
            let x = random.value();
            w.set_s(POSITION_X, at, x);
            w.touch_body(pick);
        }
        for &row in &rows {
            let at = row as usize;
            let p = w.v(POSITION_X, at);
            if p.x > 16.0 || p.x < -16.0 || p.y > 16.0 || p.y < -16.0 || p.z > 16.0 || p.z < -16.0 {
                let (x, y, z) = (random.value(), random.value(), random.value());
                w.set_v(POSITION_X, at, v3(x, y, z));
                w.set_v(LINEAR_X, at, v3(0.0, 0.0, 0.0));
                w.touch_body(row);
            }
            if w.flags(at) & KIND == KINEMATIC_POSITION {
                let p = w.v(POSITION_X, at);
                w.set_v(TARGET_X, at, v3(p.x + 0.0625, p.y, p.z));
                let turning = i % 64 < 32;
                w.set_s(TARGET_ROTATION_Y, at, if turning { 0.6 } else { 0.0 });
                w.set_s(TARGET_ROTATION_W, at, if turning { 0.8 } else { 1.0 });
            }
        }
        w.step((1.0f64 / 60.0) as f32);
        if (i + 1) % EVERY == 0 {
            hashes.push(w.hash());
        }
    }
    hashes
}

/// The `"kernel"` list of the fixture: a flat array of numbers, read without a JSON library.
fn fixture() -> Vec<u32> {
    let text = include_str!("../../tests/fixtures/replay-hash.json");
    let start = text.find("\"kernel\"").expect("a kernel list");
    let list = &text[start..];
    let list = &list[list.find('[').unwrap() + 1..list.find(']').unwrap()];
    list.split(',').map(|number| number.trim().parse().unwrap()).collect()
}

#[test]
fn native_code_matches_the_wasm_build_bit_for_bit() {
    let hashes = scene();
    assert_eq!(hashes.len() as u32, STEPS / EVERY);
    assert_eq!(hashes, fixture());
}

#[test]
fn two_runs_of_the_scene_are_equal() {
    assert_eq!(scene(), scene());
}
