//! The native world.rs 1:100 and 1:1000 acceptance fixtures, also inside shipped Wasm.
//! These are check-only scenes: the pinned hash scenes and benchmark workloads are unchanged.
use margoengine_physics2d_kernel::{
    error::PhysicsError,
    math::{V2, v2},
    shape::Core,
    world::{BodyDef, Kind, ShapeDef, World},
};

const DT: f32 = 1.0 / 60.0;

pub(super) struct Metrics {
    pub(super) drop: f64,
    pub(super) expected: f64,
    pub(super) top_x: f64,
    pub(super) creep: f32,
    pub(super) asleep_at: Option<f32>,
}

impl Metrics {
    pub(super) fn passes(&self) -> bool {
        (self.drop - self.expected).abs() < 0.03 * self.expected
            && self.top_x.abs() < 1e-4
            && self.creep < 0.01
            && self.asleep_at.is_some()
    }
}

pub(super) fn run(payload: f32, contact_lanes: bool) -> Result<Metrics, PhysicsError> {
    let mut world = World::default();
    world.settings.contact_lanes = contact_lanes;
    let ground = world.create_body(&BodyDef {
        kind: Kind::Static,
        position: V2::ZERO,
        ..Default::default()
    })?;
    world.create_shape(
        ground,
        Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0)?,
        &ShapeDef::default(),
    )?;
    let mut boxes = [0; 4];
    for (i, id) in boxes.iter_mut().enumerate() {
        *id = world.create_body(&BodyDef {
            position: v2(0.0, 0.5 + i as f32),
            ..Default::default()
        })?;
        world.create_shape(
            *id,
            Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0)?,
            &ShapeDef {
                density: if i == 3 { payload } else { 1.0 },
                friction: 0.6,
                restitution: 0.0,
            },
        )?;
    }
    let mut at_one = boxes.map(|b| world.bodies[b as usize].xf.p);
    let mut asleep_at = None;
    // Keep the native fixture's f32 division and truncation (599 steps), not a rounded 600-step substitute.
    let steps = (10.0 / DT) as usize;
    for step in 0..steps {
        if step == 60 {
            at_one = boxes.map(|b| world.bodies[b as usize].xf.p);
        }
        world.step(DT)?;
        if asleep_at.is_none() && boxes.iter().all(|&b| !world.bodies[b as usize].awake) {
            asleep_at = Some((step + 1) as f32 * DT);
        }
        for &b in &boxes {
            let p = world.bodies[b as usize].xf.p;
            if !(p.x.is_finite() && p.y.is_finite()) {
                return Err(PhysicsError::ArithmeticOverflow);
            }
        }
    }
    let creep = boxes
        .iter()
        .zip(&at_one)
        .map(|(&b, s)| world.bodies[b as usize].xf.p.sub(*s).length())
        .fold(0.0, f32::max);
    let omega = 2.0 * core::f64::consts::PI * 60.0;
    let k = |inv_a: f64, inv_b: f64| inv_a + inv_b + 0.25 * 6.0 * (inv_a + inv_b);
    let column = match payload {
        100.0 => [
            (103.0, k(1.0, 0.0)),
            (102.0, k(1.0, 1.0)),
            (101.0, k(1.0, 1.0)),
            (100.0, k(1.0, 0.01)),
        ],
        1000.0 => [
            (1003.0, k(1.0, 0.0)),
            (1002.0, k(1.0, 1.0)),
            (1001.0, k(1.0, 1.0)),
            (1000.0, k(1.0, 0.001)),
        ],
        _ => return Err(PhysicsError::InvalidParameter),
    };
    let expected: f64 = column
        .iter()
        .map(|(load, k_ii)| load * 9.81 * k_ii / (2.0 * omega * omega))
        .sum();
    let top = &world.bodies[boxes[3] as usize];
    Ok(Metrics {
        drop: 3.5 - top.exact_center[1],
        expected,
        top_x: top.exact_center[0],
        creep,
        asleep_at,
    })
}

pub(super) fn check() -> bool {
    for contact_lanes in [false, true] {
        for payload in [100.0, 1000.0] {
            match run(payload, contact_lanes) {
                Ok(metrics) if metrics.passes() => (),
                _ => return false,
            }
        }
    }
    true
}
