//! Independent integration checks of support-domain transitions. Unsupported domains must take ordinary NCP.
//! Perturbed 1000:1 columns have no new stability bar here: separating/unstable cases compare one step to NCP.
use margoengine_physics2d_kernel::{
    error::PhysicsError,
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

fn floor(w: &mut World, q: Rot) -> u32 {
    let id = w
        .create_body(&BodyDef {
            kind: Kind::Static,
            rotation: q,
            ..Default::default()
        })
        .unwrap();
    w.create_shape(
        id,
        Core::rect(10.0, 0.5, v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(),
        &ShapeDef::default(),
    )
    .unwrap();
    id
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

fn center_of_mass_y(w: &World) -> f64 {
    let mass: f64 = w
        .bodies
        .iter()
        .filter(|b| b.kind == Kind::Dynamic)
        .map(|b| b.mass as f64)
        .sum();
    w.bodies
        .iter()
        .filter(|b| b.kind == Kind::Dynamic)
        .map(|b| b.mass as f64 * b.exact_center[1])
        .sum::<f64>()
        / mass
}

#[test]
fn separating_kicks_including_less_than_one_gravity_substep_take_ordinary_ncp() {
    for lanes in [false, true] {
        let (mut base, ids) = column(lanes, false, false);
        for _ in 0..120 {
            base.step(DT).unwrap();
        }
        for kick in [0.001, 0.1, 1.0] {
            assert!(
                kick != 0.001
                    || kick < base.settings.gravity.y.abs() * DT / base.settings.substeps as f32
            );
            let mut subject = copy_public(&base, false);
            for &id in &ids {
                subject.bodies[id as usize].linear_velocity.y = kick;
            }
            let before = center_of_mass_y(&subject);
            ordinary_ncp_step(&mut subject, &format!("kick={kick}, lanes={lanes}"));
            if kick > subject.settings.gravity.y.abs() * DT {
                assert!(
                    center_of_mass_y(&subject) > before,
                    "an outgoing kick was erased"
                );
            }
        }
    }
}

#[test]
fn unsupported_slope_torque_fixed_rotation_and_one_point_contacts_take_ordinary_ncp() {
    for lanes in [false, true] {
        let q = Rot {
            c: 0.2f32.cos(),
            s: 0.2f32.sin(),
        };
        let mut slope = World::new(settings(lanes));
        floor(&mut slope, q);
        box_at(&mut slope, q.apply(v2(0.0, 0.5)), q, 1.0, false);
        ordinary_ncp_step(
            &mut slope,
            "gravity is not supported by the tilted normal alone",
        );

        let mut torque = World::new(settings(lanes));
        floor(&mut torque, Rot::IDENTITY);
        box_at(&mut torque, v2(0.0, 0.5), Rot::IDENTITY, 1.0, false);
        box_at(&mut torque, v2(0.75, 1.5), Rot::IDENTITY, 1000.0, false);
        ordinary_ncp_step(
            &mut torque,
            "eccentric load needs a negative normal or an unsupported torque",
        );

        let mut fixed = World::new(settings(lanes));
        floor(&mut fixed, Rot::IDENTITY);
        box_at(&mut fixed, v2(0.0, 0.5), Rot::IDENTITY, 1.0, true);
        ordinary_ncp_step(&mut fixed, "fixed rotation leaves redundant two-point rows");

        let mut corner = World::new(settings(lanes));
        floor(&mut corner, Rot::IDENTITY);
        box_at(
            &mut corner,
            v2(0.0, 0.54),
            Rot {
                c: 0.1f32.cos(),
                s: 0.1f32.sin(),
            },
            1.0,
            false,
        );
        ordinary_ncp_step(
            &mut corner,
            "one off-center support point cannot balance gravity's wrench",
        );
        assert!(
            corner.contacts.iter().any(|c| c.manifold.count == 1),
            "the fixture must actually exercise a one-point contact"
        );
    }
}

#[test]
fn reversing_gravity_releases_the_supported_column_without_stale_tension() {
    for lanes in [false, true] {
        let (mut base, _) = column(lanes, false, false);
        for _ in 0..120 {
            base.step(DT).unwrap();
        }
        let mut subject = copy_public(&base, false);
        subject.settings.gravity.y = 9.81;
        let before = center_of_mass_y(&subject);
        ordinary_ncp_step(
            &mut subject,
            "reversed gravity requires tensile support and must decline",
        );
        assert!(center_of_mass_y(&subject) > before);
    }
}

fn expected_drop(top_gravity_scale: f64) -> f64 {
    let force = 1000.0 * top_gravity_scale;
    let omega = 2.0 * std::f64::consts::PI * 60.0;
    [
        (force + 3.0, 2.5),
        (force + 2.0, 5.0),
        (force + 1.0, 5.0),
        (force, 2.5 * 1.001),
    ]
    .into_iter()
    .map(|(load, k)| load * 9.81 * k / (2.0 * omega * omega))
    .sum()
}

#[test]
fn unperturbed_columns_retain_existing_normalized_bars_after_creation_reorders_and_load_changes() {
    for lanes in [false, true] {
        for reverse_bodies in [false, true] {
            for reverse_shapes in [false, true] {
                let (mut w, ids) = column(lanes, reverse_bodies, reverse_shapes);
                let mut at_one = [V2::ZERO; 4];
                for step in 0..600 {
                    w.step(DT).unwrap();
                    if step == 59 {
                        at_one = ids.map(|id| w.bodies[id as usize].xf.p);
                    }
                }
                let drop = 3.5 - w.bodies[ids[3] as usize].exact_center[1];
                let expected = expected_drop(1.0);
                let creep = ids
                    .into_iter()
                    .zip(at_one)
                    .map(|(id, p)| w.bodies[id as usize].xf.p.sub(p).length())
                    .fold(0.0, f32::max);
                println!(
                    "order lanes={lanes} bodies={reverse_bodies} shapes={reverse_shapes}: sag={drop}, expected={expected}, creep={creep}"
                );
                assert!((drop - expected).abs() < 0.03 * expected);
                assert!(w.bodies[ids[3] as usize].exact_center[0].abs() < 1e-4 && creep < 0.01);
                w.bodies[ids[3] as usize].gravity_scale = 0.5;
                for _ in 0..600 {
                    w.step(DT).unwrap();
                }
                let drop = 3.5 - w.bodies[ids[3] as usize].exact_center[1];
                let expected = expected_drop(0.5);
                assert!(
                    (drop - expected).abs() < 0.03 * expected,
                    "load transition: sag={drop}, expected={expected}"
                );
            }
        }
    }
}

#[test]
fn impact_restitution_keeps_the_existing_rebound_bar_in_both_lane_modes() {
    for lanes in [false, true] {
        let mut w = World::new(settings(lanes));
        floor(&mut w, Rot::IDENTITY);
        let id = w
            .create_body(&BodyDef {
                position: v2(0.0, 2.25),
                ..Default::default()
            })
            .unwrap();
        w.create_shape(
            id,
            Core::circle(V2::ZERO, 0.25).unwrap(),
            &ShapeDef {
                restitution: 0.8,
                ..Default::default()
            },
        )
        .unwrap();
        let (mut hit, mut peak) = (false, 0.0f32);
        for _ in 0..240 {
            w.step(DT).unwrap();
            if !hit && w.bodies[id as usize].linear_velocity.y > 0.0 {
                hit = true;
            }
            if hit {
                peak = peak.max(w.bodies[id as usize].xf.p.y - 0.25);
            }
        }
        let ratio = peak / 2.0;
        println!("impact lanes={lanes}: rebound fraction={ratio}");
        assert!(
            ratio >= 0.55 && ratio <= 0.75,
            "the unchanged existing restitution bar failed: {ratio}"
        );
    }
}

#[test]
fn representable_extreme_masses_and_friction_step_and_unrepresentable_mass_is_coded() {
    for lanes in [false, true] {
        for density in [2.0f32.powi(-40), 2.0f32.powi(40)] {
            for friction in [0.0, 1.0e20, f32::MAX] {
                let mut w = World::new(settings(lanes));
                let ground = floor(&mut w, Rot::IDENTITY);
                let id = box_at(&mut w, v2(0.0, 0.5), Rot::IDENTITY, density, false);
                for shape in &mut w.shapes {
                    shape.friction = friction;
                }
                for _ in 0..60 {
                    w.step(DT).unwrap();
                }
                assert!(
                    w.bodies[id as usize]
                        .exact_center
                        .into_iter()
                        .all(f64::is_finite)
                );
                assert!(w.contacts.iter().all(|c| {
                    c.normal_impulse[..c.manifold.count]
                        .iter()
                        .all(|&v| v >= 0.0 && v.is_finite())
                }));
                assert_eq!(w.bodies[ground as usize].kind, Kind::Static);
            }
        }
        let mut w = World::new(settings(lanes));
        let id = w
            .create_body(&BodyDef {
                fixed_rotation: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            w.create_shape(
                id,
                Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(),
                &ShapeDef {
                    density: f32::MAX,
                    ..Default::default()
                }
            ),
            Err(PhysicsError::ArithmeticOverflow)
        );
        assert!(w.shapes.is_empty());
    }
}
