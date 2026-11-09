use super::*;
use crate::math::Rot;
use crate::shape::MAX_VERTICES;

// Verbatim old public calculation from own immutable fc88da420, including validation/error order.
fn original_bounds(core: &Core, xf: Xf) -> Result<Bounds<2>, PhysicsError> {
    validate_collision_core(core)?;
    validate_collision_pose(xf)?;
    let first = xf.apply(core.vertices[0]);
    let (mut lo, mut hi) = (first, first);
    for i in 1..core.count {
        let p = xf.apply(core.vertices[i]);
        lo = v2(lo.x.min(p.x), lo.y.min(p.y));
        hi = v2(hi.x.max(p.x), hi.y.max(p.y));
    }
    let r = core.radius;
    let bounds = Bounds { min: [lo.x - r, lo.y - r], max: [hi.x + r, hi.y + r] };
    if bounds.min.into_iter().chain(bounds.max).any(|v| !v.is_finite()) { return Err(PhysicsError::ArithmeticOverflow); }
    Ok(bounds)
}

fn bounds_bits(result: Result<Bounds<2>, PhysicsError>) -> Result<[u32; 4], PhysicsError> {
    result.map(|b| [b.min[0].to_bits(), b.min[1].to_bits(), b.max[0].to_bits(), b.max[1].to_bits()])
}

#[test]
fn validated_bounds_keep_every_old_result_bit_across_counts_and_finite_extremes() {
    let tiny=f32::from_bits(1);
    let poses=[Xf::IDENTITY,
        Xf {p:v2(-0.0,0.0),q:Rot{c:0.0,s:-0.0}},
        Xf {p:v2(3.25,-7.5),q:Rot{c:0.6,s:0.8}},
        Xf {p:v2(1e20,-1e20),q:Rot{c:-0.8,s:0.6}},
        Xf {p:v2(f32::MAX,f32::MAX),q:Rot::IDENTITY},
        Xf {p:v2(tiny,-tiny),q:Rot{c:f32::MAX,s:-f32::MAX}},
    ];
    let mut finite=0;
    let mut overflow=0;
    for count in 1..=MAX_VERTICES {
        for radius in [0.0,-0.0,tiny,0.25,f32::MAX] {
            for pattern in 0..4 {
                let mut core=Core::circle(V2::ZERO,radius).unwrap();
                core.count=count;
                for i in 0..count {
                    core.vertices[i]=match pattern {
                        0=>v2(if i%2==0 {-0.0}else{0.0},if i%3==0 {0.0}else{-0.0}),
                        1=>v2(i as f32-0.5,0.5-i as f32*0.25),
                        2=>v2(if i%2==0 {f32::MAX}else{-f32::MAX},if i%3==0 {f32::MAX}else{-f32::MAX}),
                        _=>v2(tiny*i as f32,-tiny*i as f32),
                    };
                    core.normals[i]=v2(0.6,0.8);
                }
                // Unused public slots are outside the validated/derived domain on both paths.
                for i in count..MAX_VERTICES { core.vertices[i]=v2(f32::NAN,f32::INFINITY); }
                for xf in poses {
                    validate_collision_core(&core).unwrap();
                    validate_collision_pose(xf).unwrap();
                    let expected=bounds_bits(original_bounds(&core,xf));
                    assert_eq!(bounds_bits(bounds_of(&core,xf)),expected);
                    assert_eq!(bounds_bits(bounds_from_validated(&core,xf)),expected);
                    match expected {Ok(_)=>finite+=1,Err(PhysicsError::ArithmeticOverflow)=>overflow+=1,Err(e)=>panic!("unexpected {e:?}")}
                }
            }
        }
    }
    assert!(finite>100 && overflow>100,"nonvacuous derived outcomes {finite}/{overflow}");
    let circle=Core::circle(v2(1.0,-2.0),0.25).unwrap();
    let got=bounds_of(&circle,Xf{p:v2(3.0,4.0),q:Rot::IDENTITY}).unwrap();
    assert_eq!(got.min,[3.75,1.75]);
    assert_eq!(got.max,[4.25,2.25]);
}

fn one_shape_world() -> World {
    let mut w=World::default();
    let body=w.create_body(&BodyDef{position:v2(0.0,1.0),..Default::default()}).unwrap();
    w.create_shape(body,Core::rect(0.5,0.5,V2::ZERO,1.0,0.0,0.0).unwrap(),&ShapeDef::default()).unwrap();
    w
}

#[test]
fn public_bounds_and_step_still_refuse_mutated_inputs_before_trusted_refit() {
    for case in 0..8 {
        let mut w=one_shape_world();
        let expected=match case {
            0=>{w.shapes[0].core.count=0;PhysicsError::InvalidCore},
            1=>{w.shapes[0].core.count=MAX_VERTICES+1;PhysicsError::InvalidCore},
            2=>{w.shapes[0].core.radius=-1.0;PhysicsError::InvalidCore},
            3=>{w.shapes[0].core.radius=f32::NAN;PhysicsError::NotFinite},
            4=>{w.shapes[0].core.vertices[0].x=f32::NAN;PhysicsError::NotFinite},
            5=>{w.shapes[0].core.normals[0].y=f32::INFINITY;PhysicsError::NotFinite},
            6=>{w.bodies[0].xf.p.x=f32::NAN;PhysicsError::NotFinite},
            _=>{w.bodies[0].xf.q.s=f32::INFINITY;PhysicsError::NotFinite},
        };
        assert_eq!(bounds_bits(bounds_of(&w.shapes[0].core,w.bodies[0].xf)),Err(expected));
        let steps=w.steps;
        assert_eq!(w.step(1.0/60.0),Err(expected),"case{case}");
        assert_eq!(w.steps,steps,"preflight must fail before frame publication");
    }
    // Public error precedence remains core before pose, even when both are malformed.
    let mut core=Core::circle(V2::ZERO,0.0).unwrap();core.count=0;
    assert_eq!(bounds_bits(bounds_of(&core,Xf{p:v2(f32::NAN,0.0),q:Rot::IDENTITY})),Err(PhysicsError::InvalidCore));
}

#[test]
fn trusted_refit_keeps_derived_overflow_visible_after_finite_input_preflight() {
    let mut w=one_shape_world();
    w.bodies[0].xf.p=v2(f32::MAX,f32::MAX);
    for vertex in &mut w.shapes[0].core.vertices[..4] { *vertex=v2(f32::MAX,f32::MAX); }
    validate_shape(&w.shapes[0]).unwrap();
    validate_collision_pose(w.bodies[0].xf).unwrap();
    validate_body_state(&w.bodies[0]).unwrap();
    assert_eq!(bounds_bits(bounds_of(&w.shapes[0].core,w.bodies[0].xf)),Err(PhysicsError::ArithmeticOverflow));
    assert_eq!(bounds_bits(bounds_from_validated(&w.shapes[0].core,w.bodies[0].xf)),Err(PhysicsError::ArithmeticOverflow));
    assert_eq!(w.step(1.0/60.0),Err(PhysicsError::ArithmeticOverflow));
}
