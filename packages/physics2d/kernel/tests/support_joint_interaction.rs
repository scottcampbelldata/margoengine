//! A disconnected joint cannot change immutable approach evidence in another contact component.
use margoengine_physics2d_kernel::{
    math::{Rot, V2, v2},
    shape::Core,
    world::{BodyDef, Kind, Settings, ShapeDef, World},
};

const DT: f32 = 1.0 / 60.0;

fn settings(lanes: bool) -> Settings {
    Settings {
        contact_lanes: lanes,
        sleep: false,
        ..Default::default()
    }
}

fn box_at(w: &mut World, at: V2, q: Rot, density: f32, fixed: bool) -> u32 {
    let id = w
        .create_body(&BodyDef {
            position: at,
            rotation: q,
            fixed_rotation: fixed,
            ..Default::default()
        })
        .unwrap();
    w.create_shape(
        id,
        Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(),
        &ShapeDef {
            density,
            ..Default::default()
        },
    )
    .unwrap();
    id
}

fn column(lanes: bool, reverse_bodies: bool, reverse_shapes: bool) -> (World, [u32; 4]) {
    let mut w = World::new(settings(lanes));
    let mut ids = [0; 5];
    for order in 0..5 {
        let i = if reverse_bodies { 4 - order } else { order };
        ids[i] = w
            .create_body(&BodyDef {
                kind: if i == 0 { Kind::Static } else { Kind::Dynamic },
                position: if i == 0 {
                    V2::ZERO
                } else {
                    v2(0.0, i as f32 - 0.5)
                },
                ..Default::default()
            })
            .unwrap();
    }
    for order in 0..5 {
        let i = if reverse_shapes { 4 - order } else { order };
        let core = if i == 0 {
            Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0)
        } else {
            Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0)
        }
        .unwrap();
        w.create_shape(
            ids[i],
            core,
            &ShapeDef {
                density: if i == 4 { 1000.0 } else { 1.0 },
                ..Default::default()
            },
        )
        .unwrap();
    }
    (w, [ids[1], ids[2], ids[3], ids[4]])
}

/// Rebuild private proxies from the same public state. The NCP control has nonzero restitution, which excludes
/// equilibrium stabilization, and MAX threshold, which suppresses every finite impact response. Thus its normal
/// and friction equations are unchanged; this is an explicit diagnostic control, not a production solver switch.
fn copy_public(source: &World, ncp_control: bool) -> World {
    let mut config = source.settings;
    if ncp_control {
        config.restitution_threshold = f32::MAX;
    }
    let mut w = World::new(config);
    for b in &source.bodies {
        w.create_body(&BodyDef {
            kind: b.kind,
            position: b.xf.p,
            rotation: b.xf.q,
            ..Default::default()
        })
        .unwrap();
    }
    for shape in &source.shapes {
        w.create_shape(
            shape.body,
            shape.core,
            &ShapeDef {
                density: shape.density,
                friction: shape.friction,
                restitution: if ncp_control { 1.0 } else { shape.restitution },
            },
        )
        .unwrap();
    }
    w.bodies = source.bodies.clone();
    w.shapes = source.shapes.clone();
    if ncp_control {
        for shape in &mut w.shapes {
            shape.restitution = 1.0;
        }
    }
    w.contacts = source.contacts.clone();
    w.joints = source.joints.clone();
    w.steps = source.steps;
    w
}

fn state(w: &World) -> Vec<u64> {
    let c = &w.counts;
    let mut out = vec![
        w.steps,
        c.compared,
        c.pairs,
        c.manifolds,
        c.cold_points,
        c.constraints,
        c.block,
        c.sequential,
        c.colours,
        c.overflow,
        c.islands,
        c.awake_bodies,
    ];
    for b in &w.bodies {
        out.push(u64::from(b.awake));
        out.extend(b.exact_center.map(f64::to_bits));
        out.extend(
            [
                b.sleep_time,
                b.center.x,
                b.center.y,
                b.local_center.x,
                b.local_center.y,
                b.xf.p.x,
                b.xf.p.y,
                b.xf.q.c,
                b.xf.q.s,
                b.linear_velocity.x,
                b.linear_velocity.y,
                b.angular_velocity,
            ]
            .map(|v| v.to_bits() as u64),
        );
    }
    for c in &w.contacts {
        out.extend([c.a as u64, c.b as u64, c.manifold.count as u64]);
        out.extend([c.manifold.normal.x, c.manifold.normal.y].map(|v| v.to_bits() as u64));
        for p in &c.manifold.points {
            out.extend([p.point.x, p.point.y, p.separation].map(|v| v.to_bits() as u64));
            out.push(p.id as u64);
        }
        out.extend(
            c.normal_impulse
                .into_iter()
                .chain(c.tangent_impulse)
                .map(|v| v.to_bits() as u64),
        );
    }
    out
}

fn ordinary_ncp_step(subject: &mut World, label: &str) {
    let mut control = copy_public(subject, true);
    subject.step(DT).unwrap();
    control.step(DT).unwrap();
    assert_eq!(
        state(subject),
        state(&control),
        "{label}: unsupported domain changed ordinary NCP behavior"
    );
}

#[test]
fn an_unrelated_joint_cannot_erase_original_separation_evidence() {
    use margoengine_physics2d_kernel::joint::{JointDef, JointKind};
    for lanes in [false, true] {
        for settled_steps in [0, 1, 120] {
            let (mut base, ids) = column(lanes, false, false);
            for _ in 0..settled_steps {
                base.step(DT).unwrap();
            }
            let a = box_at(&mut base, v2(30.0, 4.0), Rot::IDENTITY, 1.0, false);
            let b = box_at(&mut base, v2(32.0, 4.0), Rot::IDENTITY, 1.0, false);
            base.create_joint(&JointDef {
                kind: JointKind::Rope { length: 2.0 },
                a,
                b,
                anchor_a: V2::ZERO,
                anchor_b: V2::ZERO,
                collide: false,
            })
            .unwrap();
            let kick = 0.001;
            assert!(kick < base.settings.gravity.y.abs() * DT / base.settings.substeps as f32);
            for &id in &ids {
                base.bodies[id as usize].linear_velocity.y = kick;
            }
            // Both variants rebuild proxies after adding the disconnected bodies; otherwise the comparison counter
            // legitimately differs between an incremental broadphase and a newly built diagnostic control.
            let mut subject = copy_public(&base, false);
            ordinary_ncp_step(
                &mut subject,
                &format!(
                    "disconnected joint and kick<gravity*h, lanes={lanes}, settled_steps={settled_steps}"
                ),
            );
        }
    }
}
