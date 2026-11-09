// Included inside path_support::tests. These native tests isolate planner storage from solver arithmetic.
// All graph vertices use real current bodies/materials; only the planner's current contact-edge topology changes.
fn planner_storage_fixture(n: usize) -> (World, Vec<u32>, Constraint) {
    let mut w = World::new(crate::world::Settings { sleep: false, ..Default::default() });
    let ground = w.create_body(&crate::world::BodyDef { kind: Kind::Static, ..Default::default() }).unwrap();
    w.create_shape(ground, crate::shape::Core::rect(10.0, 0.5, crate::math::v2(0.0, -0.5), 1.0, 0.0, 0.0).unwrap(), &crate::world::ShapeDef::default()).unwrap();
    for i in 0..n {
        let body = w.create_body(&crate::world::BodyDef { position: crate::math::v2(0.0, 0.5 + i as f32), ..Default::default() }).unwrap();
        w.create_shape(body, crate::shape::Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap(), &crate::world::ShapeDef::default()).unwrap();
    }
    w.step(1.0 / 60.0).unwrap();
    for b in &mut w.bodies { if b.kind == Kind::Dynamic { b.awake = true; } }
    let template = w.scratch.constraints[0];
    assert_eq!(template.count, 2);
    let ids = (0..w.bodies.len() as u32).collect();
    (w, ids, template)
}

fn planner_storage_edges(template: Constraint, edges: &[(usize, usize)]) -> (Vec<Constraint>, Vec<Bounce>) {
    let constraints = edges.iter().map(|&(a,b)| { let mut c=template; c.a=a as u32; c.b=b as u32; c }).collect();
    let bounces = alloc::vec![Bounce { restitution: 0.0, approach: [0.0;2] };edges.len()];
    (constraints,bounces)
}

fn planner_storage_active_paths(plan: &Plan) -> usize { plan.ranges.len() }

fn planner_retained_storage_bytes(w: &Workspace) -> usize {
    // Count every retained backing allocation, including otherwise-inactive planner arrays.
    w.plan.paths.capacity()*core::mem::size_of::<(usize,usize,usize)>()
        +w.plan.ranges.capacity()*core::mem::size_of::<core::ops::Range<usize>>()
        +w.plan.weights.capacity()*core::mem::size_of::<[f64;3]>()
        +w.plan.gaps.capacity()*core::mem::size_of::<[f32;2]>()
        +w.edges.capacity()*core::mem::size_of::<usize>()
        +w.offsets.capacity()*core::mem::size_of::<usize>()
        +w.cursors.capacity()*core::mem::size_of::<usize>()
        +w.dynamic.capacity()*core::mem::size_of::<bool>()
        +w.visited.capacity()*core::mem::size_of::<bool>()
        +w.jointed.capacity()*core::mem::size_of::<bool>()
        +w.todo.capacity()*core::mem::size_of::<usize>()
        +w.members.capacity()*core::mem::size_of::<usize>()
        +w.terminals.capacity()*core::mem::size_of::<(usize,usize,usize)>()
}

fn planner_linear_storage_budget(max_vertices: usize, max_edges: usize) -> usize {
    // Flat field maxima: adjacency<=2E; offsets/cursors<=V+1; paths/gaps<=V+1;
    // ranges/weights/flags/traversal<=V; terminals<=E. Allow Vec doubling plus its small allocation floor.
    // This is an explicit storage budget derived from representation, not a fitted scene/physics threshold.
    let bytes = |len, size| (2*len+8)*size;
    bytes(max_vertices+1,core::mem::size_of::<(usize,usize,usize)>())
        +bytes(max_vertices,core::mem::size_of::<core::ops::Range<usize>>())
        +bytes(max_vertices,core::mem::size_of::<[f64;3]>())
        +bytes(max_vertices+1,core::mem::size_of::<[f32;2]>())
        +bytes(2*max_edges,core::mem::size_of::<usize>())
        +2*bytes(max_vertices+1,core::mem::size_of::<usize>())
        +3*bytes(max_vertices,core::mem::size_of::<bool>())
        +2*bytes(max_vertices,core::mem::size_of::<usize>())
        +bytes(max_edges,core::mem::size_of::<(usize,usize,usize)>())
}

#[test]
fn planner_retained_capacity_stays_linear_when_large_path_ordinals_shift() {
    const N: usize = 64;
    let (w,ids,template)=planner_storage_fixture(N);
    let mut workspace=Workspace::default();
    let mut peak=0;
    for singles in 0..=N/2 {
        // Constant V=N+1 and E=N. The long path migrates from ordinal0 through ordinalN/2.
        let mut edges=Vec::new();
        for body in 1..=singles { edges.push((0,body)); }
        edges.push((0,singles+1));
        for body in singles+2..=N { edges.push((body-1,body)); }
        assert_eq!(edges.len(),N);
        let (constraints,bounces)=planner_storage_edges(template,&edges);
        let plan=plan(&w,&ids,&constraints,&bounces,&mut workspace).unwrap();
        assert_eq!(planner_storage_active_paths(plan),singles+1);
        peak=peak.max(planner_retained_storage_bytes(&workspace));
    }
    let budget=planner_linear_storage_budget(ids.len(),N);
    std::println!("PLANNER_STORAGE shifting_paths V={} E={N} peak_bytes={peak} linear_budget_bytes={budget}",ids.len());
    assert!(peak<=budget,"retained storage accumulated historical per-component maxima: {peak}>{budget}");
}

#[test]
fn planner_retained_capacity_stays_linear_when_high_degree_hub_migrates() {
    const N: usize = 64;
    let (w,ids,template)=planner_storage_fixture(N);
    let mut workspace=Workspace::default();
    let mut peak=0;
    for hub in 1..=N {
        // One static terminal and a current high-degree hub. Constant V/E; each body takes its turn as hub.
        let mut edges=alloc::vec![(0,hub)];
        for body in 1..=N { if body!=hub { edges.push((hub,body)); } }
        assert_eq!(edges.len(),N);
        let (constraints,bounces)=planner_storage_edges(template,&edges);
        assert!(plan(&w,&ids,&constraints,&bounces,&mut workspace).is_none());
        peak=peak.max(planner_retained_storage_bytes(&workspace));
    }
    let budget=planner_linear_storage_budget(ids.len(),N);
    std::println!("PLANNER_STORAGE migrating_hub V={} E={N} peak_bytes={peak} linear_budget_bytes={budget}",ids.len());
    assert!(peak<=budget,"retained storage accumulated historical per-body degree maxima: {peak}>{budget}");
}
