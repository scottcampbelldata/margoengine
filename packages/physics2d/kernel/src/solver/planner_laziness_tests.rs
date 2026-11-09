use super::*;
use crate::{math::v2, shape::Core, world::{BodyDef, Contact, ShapeDef}};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Trace { events: Vec<(u8,usize,usize)>, domain: Vec<(usize,usize)> }
std::thread_local! { static TRACE: core::cell::RefCell<Option<Trace>> = const {core::cell::RefCell::new(None)}; }
pub(super) fn record_event(kind:u8, body:usize, edge:usize) {
    TRACE.with(|t| {if let Some(t)=t.borrow_mut().as_mut() {t.events.push((kind,body,edge));}});
}
pub(super) fn record_domain(body:usize, edge:usize) {
    TRACE.with(|t| {if let Some(t)=t.borrow_mut().as_mut() {t.domain.push((body,edge));}});
}
fn capture<T>(f:impl FnOnce()->T)->(T,Trace) {
    TRACE.with(|t| {assert!(t.borrow().is_none());*t.borrow_mut()=Some(Trace::default());});
    let answer=f();
    let trace=TRACE.with(|t|t.borrow_mut().take().unwrap());
    (answer,trace)
}
#[derive(Debug,PartialEq,Eq)]
struct PlanBits { paths:Vec<(usize,usize,usize)>, ranges:Vec<core::ops::Range<usize>>, weights:Vec<[u64;3]>, gaps:Vec<[u32;2]> }
fn plan_bits(p:&Plan)->PlanBits {PlanBits{paths:p.paths.clone(),ranges:p.ranges.clone(),weights:p.weights.iter().map(|v|v.map(f64::to_bits)).collect(),gaps:p.gaps.iter().map(|v|v.map(f32::to_bits)).collect()}}
fn compare(w:&World,ids:&[u32],cs:&[Constraint],bs:&[Bounce],old:&mut Workspace,new:&mut Workspace)->(Trace,Trace,usize) {
    let (expected,eager)=capture(||eager_plan(w,ids,cs,bs,old).map(|p|plan_bits(p)));
    let (actual,lazy)=capture(||plan(w,ids,cs,bs,new).map(|p|plan_bits(p)));
    assert_eq!(actual,expected,"Plan bits");
    assert_eq!(plan_bits(&new.plan),plan_bits(&old.plan),"all retained Plan logical bits, including rejected builds");
    assert_eq!(lazy.events,eager.events,"complete seed/body/edge/terminal traversal");
    let mut remaining=eager.domain.iter();
    for x in &lazy.domain {assert!(remaining.any(|v|v==x),"lazy predicate trace must be an eager subsequence");}
    assert!(lazy.domain.len()<=eager.domain.len());
    assert_eq!(new.edges,old.edges);assert_eq!(new.offsets,old.offsets);assert_eq!(new.cursors,old.cursors);
    assert_eq!(new.dynamic,old.dynamic);assert_eq!(new.visited,old.visited);assert_eq!(new.jointed,old.jointed);
    assert_eq!(new.todo,old.todo);assert_eq!(new.members,old.members);assert_eq!(new.terminals,old.terminals);
    (eager,lazy,actual.as_ref().map_or(0,|p|p.ranges.len()))
}

// Structural fixtures keep real public ownership/metrics and valid current contact indices/counts.
fn graph(n:usize,edges:&[(usize,usize)])->(World,Vec<u32>,Vec<Constraint>,Vec<Bounce>) {
    let mut w=World::default();
    let mut ids=Vec::new();
    for i in 0..=n {
        let id=w.create_body(&BodyDef{kind:if i==0 {Kind::Static}else{Kind::Dynamic},position:v2(i as f32*3.0,0.5),..Default::default()}).unwrap();
        w.create_shape(id,Core::rect(0.5,0.5,V2::ZERO,1.0,0.0,0.0).unwrap(),&ShapeDef::default()).unwrap();ids.push(id);
    }
    let mut cs=Vec::new();let mut bs=Vec::new();
    for &(a,b) in edges {
        let ci=w.contacts.len();
        w.contacts.push(Contact{a:a as u32,b:b as u32,manifold:Default::default(),normal_impulse:[0.0;2],tangent_impulse:[0.0;2]});
        cs.push(Constraint{contact:ci as u32,a:a as u32,b:b as u32,inv_mass_a:w.bodies[a].inv_mass,inv_i_a:w.bodies[a].inv_inertia,inv_mass_b:w.bodies[b].inv_mass,inv_i_b:w.bodies[b].inv_inertia,normal:v2(0.0,1.0),friction:0.5,k:[2.5,-0.5,2.5],points:[super::super::Point::default();2],count:2,block:true,eighth:false,pushed:0});
        bs.push(Bounce{restitution:0.0,approach:[0.0;2]});
    }
    (w,ids,cs,bs)
}

#[test]
fn lazy_eligibility_keeps_complete_traversal_and_disconnected_valid_paths() {
    let scenarios=[
        ("path",3,vec![(0,1),(1,2),(2,3)],1),
        ("early-branch",3,vec![(0,1),(1,2),(1,3)],0),
        ("late-branch",5,vec![(0,1),(1,2),(2,3),(3,4),(3,5)],0),
        ("cycle",3,vec![(1,2),(2,3),(3,1)],0),
        ("two-terminals",2,vec![(0,1),(1,2),(0,2)],0),
        ("branch-plus-valid-shared-ground",5,vec![(0,1),(1,2),(1,3),(0,4),(4,5)],1),
    ];
    let mut skipped=0;
    for (name,n,edges,expected) in scenarios {
        for reverse in [false,true] {
            let mut edges=edges.clone();if reverse {edges.reverse();}
            let (w,ids,cs,bs)=graph(n,&edges);
            let (e,l,count)=compare(&w,&ids,&cs,&bs,&mut Workspace::default(),&mut Workspace::default());
            assert_eq!(count,expected,"{name}, reverse{reverse}");
            skipped+=e.domain.len()-l.domain.len();
            if name=="path" {assert_eq!(l.domain,e.domain);}
            if name=="early-branch" {assert!(e.domain.len()>0);assert_eq!(l.domain.len(),0);}
        }
    }
    assert!(skipped>0);
}

#[test]
fn lazy_eligibility_matches_eager_across_first_late_and_retained_domain_changes() {
    use crate::joint::{JointDef,JointKind};
    let (mut w,ids,cs,mut bs)=graph(5,&[(0,1),(1,2),(2,3),(0,4),(4,5)]);
    let (mut old,mut new)=(Workspace::default(),Workspace::default());
    let mut skipped=0;
    for mode in 0..10 {
        w.joints.clear();for s in &mut w.shapes {s.restitution=0.0;}
        for b in &mut bs {b.approach=[0.0;2];}
        w.bodies[0].kind=Kind::Static;w.bodies[3].awake=true;w.settings.contact_max_push=3.0;
        match mode {
            1|2=>{w.create_joint(&JointDef{kind:JointKind::Rope{length:20.0},a:0,b:if mode==1 {1}else{3},anchor_a:V2::ZERO,anchor_b:V2::ZERO,collide:true}).unwrap();},
            3=>w.shapes[1].restitution=0.2,
            4=>w.shapes[3].restitution=0.2,
            5=>bs[0].approach=[0.001;2],
            6=>bs[2].approach=[0.001;2],
            7=>w.bodies[0].kind=Kind::Kinematic,
            8=>w.settings.contact_max_push=0.0,
            _=>{},
        }
        let (e,l,count)=compare(&w,&ids,&cs,&bs,&mut old,&mut new);
        assert_eq!(count,if mode==0||mode==9 {2}else if mode==7||mode==8 {0}else{1},"mode{mode}");
        skipped+=e.domain.len()-l.domain.len();
    }
    assert!(skipped>0);
}

#[path = "../../tests/support/bits_scenes.rs"]
mod scenes;
#[test]
fn unchanged_pyramid_window_reports_actual_avoided_eligibility_evaluations() {
    let mut w=scenes::pyramid(100);
    let (mut old,mut new)=(Workspace::default(),Workspace::default());
    let (mut eager_total,mut lazy_total,mut edges_total)=(0usize,0usize,0usize);
    for frame in 0..100 {
        w.step(scenes::DT).unwrap();
        if frame<60 {continue;}
        let s=&w.scratch;
        let (e,l,count)=compare(&w,&s.ids,&s.constraints,&s.bounces,&mut old,&mut new);
        assert_eq!(count,0);assert_eq!(w.counts.awake_bodies,5050);
        assert_eq!(w.counts.constraints,14950);assert_eq!(w.counts.block,119600);
        assert_eq!(w.counts.sequential,0);assert_eq!(w.counts.colours,8);assert_eq!(w.counts.overflow,0);
        let traversed=e.events.iter().filter(|e|e.0==2).count();
        println!("PLANNER_LAZY_COUNT frame={} eager={} lazy={} avoided={} dfs_edges={}",frame,e.domain.len(),l.domain.len(),e.domain.len()-l.domain.len(),traversed);
        eager_total+=e.domain.len();lazy_total+=l.domain.len();edges_total+=traversed;
        if let (Some(p),Some(q))=(eager_plan(&w,&s.ids,&s.constraints,&s.bounces,&mut old),plan(&w,&s.ids,&s.constraints,&s.bounces,&mut new)) {
            p.snapshot(&s.bodies,&s.constraints);q.snapshot(&s.bodies,&s.constraints);assert_eq!(plan_bits(q),plan_bits(p));
        }
    }
    assert!(eager_total>lazy_total);
    println!("PLANNER_LAZY_TOTAL eager={eager_total} lazy={lazy_total} avoided={} dfs_edges={edges_total}",eager_total-lazy_total);
}

// Verbatim immutable eager planner, with the same cfg(test) trace hooks.
fn eager_plan<'a>(
    world: &World,
    ids: &[u32],
    constraints: &[Constraint],
    bounces: &[Bounce],
    workspace: &'a mut Workspace,
) -> Option<&'a mut Plan> {
    let Workspace { plan, edges, offsets, cursors, dynamic, visited, jointed, todo, members, terminals } = workspace;
    plan.paths.clear();
    plan.ranges.clear();
    plan.gaps.clear();
    if !(world.settings.contact_max_push > 0.0 && world.settings.contact_max_push.is_finite()) {
        return None;
    }
    dynamic.clear();
    dynamic.extend(ids
        .iter()
        .map(|&id| {
            world.bodies[id as usize].kind == Kind::Dynamic && world.bodies[id as usize].awake
        })
    );
    offsets.clear();
    offsets.resize(ids.len() + 1, 0);
    for c in constraints {
        if dynamic[c.a as usize] {
            offsets[c.a as usize + 1] += 1;
        }
        if dynamic[c.b as usize] {
            offsets[c.b as usize + 1] += 1;
        }
    }
    for i in 1..offsets.len() {
        offsets[i] += offsets[i - 1];
    }
    edges.clear();
    edges.resize(offsets[ids.len()], 0);
    cursors.clear();
    cursors.extend_from_slice(&offsets[..ids.len()]);
    for (ci, c) in constraints.iter().enumerate() {
        for body in [c.a as usize, c.b as usize] {
            if dynamic[body] {
                edges[cursors[body]] = ci;
                cursors[body] += 1;
            }
        }
    }
    let adjacent = |body: usize| &edges[offsets[body]..offsets[body + 1]];
    visited.resize(ids.len(), false);
    visited.fill(false);
    jointed.resize(world.bodies.len(), false);
    jointed.fill(false);
    for j in &world.joints {
        jointed[j.def.a as usize] = true;
        jointed[j.def.b as usize] = true;
    }
    for seed in 0..ids.len() {
        if visited[seed] || !dynamic[seed] || adjacent(seed).is_empty() {
            continue;
        }
        todo.clear();
        todo.push(seed);
        members.clear();
        terminals.clear();
        let mut valid = true;
        visited[seed] = true;
        #[cfg(test)] record_event(0, seed, 0);
        while let Some(body) = todo.pop() {
            members.push(body);
            #[cfg(test)] record_event(1, body, 0);
            valid &= adjacent(body).len() <= 2;
            let id = ids[body];
            valid &= !jointed[id as usize];
            valid &= adjacent(body)
                .iter()
                .all(|&ci| {
                    #[cfg(test)] record_domain(body, ci);
                    fixed_domain(world, &constraints[ci], &bounces[ci])
                });
            for &ci in adjacent(body) {
                #[cfg(test)] record_event(2, body, ci);
                let c = &constraints[ci];
                let other = if c.a as usize == body {
                    c.b as usize
                } else {
                    c.a as usize
                };
                if !dynamic[other] {
                    valid &= world.bodies[ids[other] as usize].kind == Kind::Static;
                    terminals.push((ci, body, other));
                    #[cfg(test)] record_event(3, body, ci);
                } else if !visited[other] {
                    visited[other] = true;
                    todo.push(other);
                }
            }
        }
        if !valid || terminals.len() != 1 {
            continue;
        }
        let (mut ci, mut body, mut parent) = terminals[0];
        let begin = plan.paths.len();
        loop {
            plan.paths.push((ci, body, parent));
            let next = adjacent(body).iter().copied().find(|&edge| edge != ci);
            let Some(next) = next else {
                break;
            };
            let c = &constraints[next];
            let other = if c.a as usize == body {
                c.b as usize
            } else {
                c.a as usize
            };
            parent = body;
            body = other;
            ci = next;
            if plan.paths.len() - begin > members.len() {
                valid = false;
                break;
            }
        }
        if valid && plan.paths.len() - begin == members.len() {
            plan.ranges.push(begin..plan.paths.len());
        } else {
            plan.paths.truncate(begin);
        }
    }
    if plan.ranges.is_empty() {
        return None;
    }
    plan.weights.clear();
    plan.weights.extend(ids
        .iter()
        .map(|&id| {
            let b = &world.bodies[id as usize];
            if b.kind == Kind::Dynamic && b.awake {
                [b.inv_mass as f64, b.inv_mass as f64, b.inv_inertia as f64]
            } else {
                [0.0; 3]
            }
        })
    );

    plan.gaps.resize(plan.paths.len(), [0.0; 2]);
    Some(plan)
}
