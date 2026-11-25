// A soft body's triangle or particle that touches a closed, oriented mesh at no distance is pushed out along the surface's
// own normal there, never into the mesh or along it. Two
// halves of a cut body meet like this: each one's cut face lies on the other's, and the faces next to the cut meet the
// other half's edges along a line. The manifold has no side to go by there; the angle-weighted pseudonormal of the feature
// met (Baerentzen and Aanaes 2005) gives it.
use margoengine_physics_kernel::face::{FACE_K, FaceContact};
use margoengine_physics_kernel::layout::*;
use margoengine_physics_kernel::math::*;
use margoengine_physics_kernel::world::{NONE, World};
use std::collections::HashMap;

const DT: f32 = 1.0 / 60.0;

/// The triangle across each edge, by corner positions.
fn across(vertices: &[V3], triangles: &[[u32; 3]]) -> Vec<[u32; 3]> {
    let key = |i: u32| {
        let p = vertices[i as usize];
        (p.x.to_bits(), p.y.to_bits(), p.z.to_bits())
    };
    let mut edges: HashMap<_, Vec<(usize, usize)>> = HashMap::new();
    for (t, tri) in triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (key(tri[k]), key(tri[(k + 1) % 3]));
            edges.entry(if a < b { (a, b) } else { (b, a) }).or_default().push((t, k));
        }
    }
    let mut out = vec![[NONE; 3]; triangles.len()];
    for list in edges.values() {
        if list.len() == 2 {
            out[list[0].0][list[0].1] = list[1].0 as u32;
            out[list[1].0][list[1].1] = list[0].0 as u32;
        }
    }
    out
}

/// A closed box of `low` to `high`, each side two triangles wound outward, as an oriented mesh collider of a fixed body.
fn oriented_box(w: &mut World, low: V3, high: V3) -> usize {
    let corner = |i: usize| v3(if i & 1 == 0 { low.x } else { high.x }, if i & 2 == 0 { low.y } else { high.y }, if i & 4 == 0 { low.z } else { high.z });
    let vertices: Vec<V3> = (0..8).map(corner).collect();
    let centre = low.add(high).scale(0.5);
    let mut triangles = Vec::new();
    for [a, b, c, d] in [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]] {
        for mut t in [[a, b, c], [a, c, d]] {
            let (p, q, r) = (vertices[t[0] as usize], vertices[t[1] as usize], vertices[t[2] as usize]);
            if q.sub(p).cross(r.sub(p)).dot(p.sub(centre)) < 0.0 {
                t.swap(1, 2);
            }
            triangles.push(t);
        }
    }
    assert!(w.begin_mesh(8, 12));
    let [_, v0, t0, _, _] = w.header().mesh_rows;
    for (i, &p) in vertices.iter().enumerate() {
        w.set_v(MESH_VERTEX_X, v0 as usize + i, p);
    }
    let links = across(&vertices, &triangles);
    for (i, tri) in triangles.iter().enumerate() {
        let at = t0 as usize + i;
        w.set_u(TRIANGLE_A, at, tri[0]);
        w.set_u(TRIANGLE_B, at, tri[1]);
        w.set_u(TRIANGLE_C, at, tri[2]);
        for k in 0..3 {
            w.set_u(TRIANGLE_ACROSS_0 + k, at, links[i][k]);
        }
    }
    let mesh = w.end_mesh(8, 12, MESH_FIX_EDGES | MESH_ORIENTED);
    assert!(mesh >= 0);
    let body = w.add_body(FIXED).unwrap();
    let collider = w.add_collider(body, SHAPE_TRIMESH, [mesh as f32, 0.0, 0.0], [0.0; 3], [0.0, 0.0, 0.0, 1.0], 0.0).unwrap();
    w.step(DT);
    collider as usize
}

/// The angle-weighted pseudonormal of a box's face, edge or corner from its faces' normals: the box's angles are all right
/// angles, so it is their sum, made a unit.
fn unit(outs: &[V3]) -> V3 {
    let sum = outs.iter().fold(v3(0.0, 0.0, 0.0), |s, &o| s.add(o));
    sum.scale(1.0 / sqrt(sum.dot(sum)))
}

/// Every contact of a still triangle with the collider, with its normal checked against what points out of the box there.
fn contacts(w: &World, c: usize, tri: [V3; 3], thickness: f32) -> Vec<FaceContact> {
    let mut out = [FaceContact::NONE; FACE_K];
    let count = w.probe_face(c, tri, tri, thickness, 0.01, DT, &mut out);
    out[..count].to_vec()
}

#[test]
fn a_triangle_touching_an_oriented_mesh_at_no_distance_is_pushed_out_of_it() {
    let mut w = World::new(8, 8).unwrap();
    // The half of a cut cube at x >= 0; the other half's faces lie at x <= 0.
    let c = oriented_box(&mut w, v3(0.0, 0.6, -0.2), v3(0.4, 1.0, 0.2));
    let thickness = 0.02;
    // Each case: the other half's triangle, and the normals of the box's faces where it touches; the normal there is their
    // angle-weighted pseudonormal, which lies in the cone of normals out of the box at that face, edge or corner.
    let cases: [(&str, [V3; 3], &[V3]); 3] = [
        // Its cut face, lying on the box's cut face (x = 0), wound the other way: out of the box is -x.
        ("cut face on cut face", [v3(0.0, 0.7, -0.1), v3(0.0, 0.7, 0.1), v3(0.0, 0.9, -0.1)], &[v3(-1.0, 0.0, 0.0)]),
        // Its top face, level with the box's top (y = 1) and meeting it along the box's top edge at x = 0.
        ("top face along the top edge", [v3(-0.1, 1.0, -0.1), v3(0.0, 1.0, 0.1), v3(0.0, 1.0, -0.1)], &[v3(-1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0)]),
        // A face touching only the box's corner at (0, 1, -0.2).
        ("a face at a corner", [v3(-0.1, 1.0, -0.3), v3(0.0, 1.0, -0.2), v3(-0.1, 1.0, -0.2)], &[v3(-1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, -1.0)]),
    ];
    for (name, tri, outs) in cases {
        let found = contacts(&w, c, tri, thickness);
        assert!(!found.is_empty(), "{name}: the triangle touches the box");
        let pseudo = unit(outs);
        for contact in found {
            let n = contact.normal;
            assert!(n.dot(pseudo) >= 1.0 - 1e-4, "{name}: the normal {n:?} is not the surface's own there, {pseudo:?}");
            assert!(contact.depth <= thickness * (1.0 + 1e-4), "{name}: the push {} is at most the thickness", contact.depth);
        }
    }
}

#[test]
fn a_particle_on_an_oriented_mesh_is_pushed_out_of_it() {
    let mut w = World::new(8, 8).unwrap();
    let c = oriented_box(&mut w, v3(0.0, 0.6, -0.2), v3(0.4, 1.0, 0.2));
    let radius = 0.025;
    // The other half's corners: on the box's cut face, on its top edge and at its corner, each still or falling.
    let cases: [(&str, V3, &[V3]); 3] = [
        ("on the cut face", v3(0.0, 0.8, 0.0), &[v3(-1.0, 0.0, 0.0)]),
        ("on the top edge", v3(0.0, 1.0, 0.0), &[v3(-1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0)]),
        ("at the corner", v3(0.0, 1.0, -0.2), &[v3(-1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0), v3(0.0, 0.0, -1.0)]),
    ];
    for (name, p, outs) in cases {
        for fall in [0.0, 0.01] {
            let to = p.sub(v3(0.0, fall, 0.0));
            let contact = w.probe_collider(c, p, to, radius, 0.01, DT).unwrap_or_else(|| panic!("{name}: the particle touches the box"));
            let pseudo = unit(outs);
            assert!(contact.normal.dot(pseudo) >= 1.0 - 1e-4, "{name}, falling {fall}: the normal {:?} is not the surface's own there, {pseudo:?}", contact.normal);
        }
    }
}
