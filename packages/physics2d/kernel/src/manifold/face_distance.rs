// Exact logical certificate. See docs/architecture/physics2d-manifold-proof.md for the independent absolute-error audit.
use super::*;

#[cfg(test)]
use core::cell::Cell;
#[cfg(test)]
std::thread_local! {
    static ATTEMPTS: Cell<u64> = const { Cell::new(0) };
    static HITS: Cell<u64> = const { Cell::new(0) };
}

/// Current data, not constructor metadata: A must actually be an axis rectangle.
fn canonical(a: &Quad) -> bool {
    if !(a.vx[0] == a.vx[3] && a.vx[1] == a.vx[2]
        && a.vy[0] == a.vy[1] && a.vy[2] == a.vy[3]
        && a.vx[0] < a.vx[1] && a.vy[0] < a.vy[3]) { return false; }
    for (i, [x, y]) in [[0.0, -1.0], [1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]].into_iter().enumerate() {
        if a.wx[i] != x || a.wy[i] != y { return false; }
    }
    true
}

/// Exactly one of the old32 candidate arithmetic paths, including its zero-span select.
#[inline(always)]
fn candidate(vertex: V2, start: V2, end: V2) -> f32 {
    let edge = end.sub(start);
    let span = edge.length_squared();
    let t = (vertex.sub(start).dot(edge) / span).clamp(0.0, 1.0);
    let t = if span > 0.0 { t } else { 0.0 };
    let offset = vertex.sub(start.add(edge.scale(t)));
    crate::math::sqrt(offset.length_squared())
}

/// L <= old closest_quads distance <= U, for current finite placed data only.
fn bounds(a: &Quad, b: &Quad, face_a: (f32, usize)) -> Option<(f32, f32)> {
    if !canonical(a) || !(face_a.0 > 0.0 && face_a.0.is_finite()) || face_a.1 >= 4 { return None; }
    let mut magnitude = 1.0f32;
    for quad in [a, b] {
        for i in 0..4 {
            for coordinate in [quad.vx[i], quad.vy[i]] {
                if !(coordinate.abs() <= 1_048_576.0) { return None; }
                magnitude = magnitude.max(coordinate.abs());
            }
            // Invalid public normal arrays retain the original complete decision.
            if !(quad.wx[i].abs() <= 2.0 && quad.wy[i].abs() <= 2.0) { return None; }
        }
    }
    distance_bounds(a, b, face_a, magnitude)
}

fn distance_bounds(a: &Quad, b: &Quad, face_a: (f32, usize), magnitude: f32) -> Option<(f32, f32)> {
    let normal = a.normal(face_a.1);
    let projection = |i: usize| if normal.x == 0.0 { normal.y * b.vy[i] } else { normal.x * b.vx[i] };
    // Two actual B vertices with least support projection, stable on ties.
    let (mut first, mut second) = (0usize, 1usize);
    if projection(second) < projection(first) { core::mem::swap(&mut first, &mut second); }
    for i in 2..4 {
        if projection(i) < projection(first) { second = first; first = i; }
        else if projection(i) < projection(second) { second = i; }
    }
    let (start, end) = a.edge(face_a.1);
    let upper = candidate(b.vertex(first), start, end).min(candidate(b.vertex(second), start, end));
    // 256uM is an exact power-of-two scale. Even upward rounding of this
    // subtraction leaves >=231uM spare beyond the audited22uM old-distance loss.
    let error = magnitude * (1.0 / 65_536.0);
    let lower = face_a.0 - error;
    if lower.is_finite() && upper.is_finite() { Some((lower, upper)) } else { None }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn decide_quads(a: &Quad, b: &Quad, faces: ((f32, usize), (f32, usize)), ar: f32, br: f32, xa: Xf, speculative: f32, last: Option<bool>) -> Result<Manifold, PhysicsError> {
    decide_quads_with_metadata(a, b, faces, ar, br, xa, speculative, last, None)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn decide_quads_with_metadata(a: &Quad, b: &Quad, faces: ((f32, usize), (f32, usize)), ar: f32, br: f32, xa: Xf, speculative: f32, last: Option<bool>, metadata: Option<four::DistanceMetadata>) -> Result<Manifold, PhysicsError> {
    let (face_a, face_b) = faces;
    let radii = ar + br;
    validate_faces(a, b, faces, radii, speculative)?;
    // Exactly the old first rejection, before attempting any certificate.
    if face_a.0.max(face_b.0) - radii > speculative { return Ok(Manifold::default()); }
    #[cfg(test)]
    ATTEMPTS.with(|count| count.set(count.get() + 1));
    if ar >= 0.0 && br >= 0.0 && ar.is_finite() && br.is_finite() && radii.is_finite()
        && speculative.is_finite() && face_b.0.is_finite()
        && let Some((lower, upper)) = match metadata {
            Some(proof) if face_a.0 > 0.0 && face_a.0.is_finite() && face_a.1 < 4 => distance_bounds(a, b, face_a, proof.magnitude()),
            Some(_) => None,
            None => bounds(a, b, face_a),
        }
    {
        let fresh = face_b.0 > face_a.0 + FACE_TOLERANCE;
        let flip = match last {
            Some(f) if (face_b.0 - face_a.0).abs() <= FACE_HYSTERESIS => f,
            _ => fresh,
        };
        let reference = if flip { face_b } else { face_a };
        if reference.1 < 4 && upper - radii <= speculative && reference.0 >= upper - FACE_TOLERANCE {
            let (owner, other, owner_radius, other_radius) = if flip { (b, a, br, ar) } else { (a, b, ar, br) };
            let mut clipped = Manifold::default();
            clip(&mut clipped, owner, other, reference.1, flip, owner_radius, other_radius, speculative)?;
            let least = clipped.points[..clipped.count].iter().map(|point| point.separation).fold(f32::INFINITY, f32::min);
            if least <= lower - radii + FACE_TOLERANCE {
                // The old preferred face necessarily succeeds for every d in[L,U].
                // Perform its unchanged final transforms; never try alternate/fresh early.
                clipped.normal = xa.q.apply(clipped.normal);
                for i in 0..clipped.count { clipped.points[i].point = xa.apply(clipped.points[i].point); }
                if clipped.count > 0 && clipped.normal.x.is_finite() && clipped.normal.y.is_finite()
                    && clipped.points[..clipped.count].iter().all(|point| point.point.x.is_finite() && point.point.y.is_finite() && point.separation.is_finite())
                {
                    #[cfg(test)]
                    HITS.with(|count| count.set(count.get() + 1));
                    return Ok(clipped);
                }
            }
        }
    }
    // No guessed distance, modified normal, alternate reference, or altered fallback.
    decide(a, b, faces, ar, br, xa, speculative, last, closest_quads)
}

#[cfg(test)]
#[path = "../../tests/support/bits_scenes.rs"]
mod profile_scenes;

#[cfg(test)]
mod tests {
    use super::*;

    fn bits(m: &Manifold) -> [u32; 11] {
        let mut out = [0; 11];
        out[..3].copy_from_slice(&[m.count as u32, m.normal.x.to_bits(), m.normal.y.to_bits()]);
        for (i, p) in m.points.iter().enumerate() { out[3 + i * 4..7 + i * 4].copy_from_slice(&[p.point.x.to_bits(), p.point.y.to_bits(), p.separation.to_bits(), p.id]); }
        out
    }

    fn verify(a: &Quad, b: &Quad) {
        let faces = (best_face_quads(a, b), best_face_quads(b, a));
        if let Some((lower, upper)) = bounds(a, b, faces.0) {
            let old = closest_quads(a, b).unwrap().0;
            assert!(lower <= old && old <= upper, "L={lower:?} d={old:?} U={upper:?}");
        }
        for last in [None, Some(false), Some(true)] {
            for speculative in [0.0, 0.02, 0.5] {
                let old = decide(a, b, faces, 0.01, 0.02, Xf::IDENTITY, speculative, last, closest_quads).unwrap();
                let got = decide_quads(a, b, faces, 0.01, 0.02, Xf::IDENTITY, speculative, last).unwrap();
                assert_eq!(bits(&got), bits(&old));
            }
        }
    }

    #[test]
    fn audited_interval_contains_old_distances_including_tiny_edges_and_mutated_data() {
        let square = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
        let a = place_quad(&square, Xf::IDENTITY);
        for gap in [f32::from_bits(1), f32::MIN_POSITIVE, 0.000_01, 0.02, 0.5, 100.0] {
            let b = place_quad(&square, Xf { p: v2(0.03, 1.0 + gap), ..Xf::IDENTITY });
            verify(&a, &b);
        }
        for tiny in [f32::from_bits(1), f32::MIN_POSITIVE, 1.0e-23, 1.0e-20] {
            let mut core = square;
            for point in &mut core.vertices[..4] { point.x *= tiny; point.y *= tiny; }
            let b = place_quad(&core, Xf { p: v2(0.0, 0.51), ..Xf::IDENTITY });
            verify(&a, &b);
            let small_a = place_quad(&core, Xf::IDENTITY);
            verify(&small_a, &place_quad(&square, Xf { p: v2(0.0, 0.51), ..Xf::IDENTITY }));
        }
        let mut invalid = square;
        invalid.normals[0].y = -0.75;
        assert!(bounds(&place_quad(&invalid, Xf::IDENTITY), &a, (0.02, 2)).is_none());
        invalid = square; invalid.vertices[1].y = 0.01;
        assert!(bounds(&place_quad(&invalid, Xf::IDENTITY), &a, (0.02, 2)).is_none());
        let huge = place_quad(&square, Xf { p: v2(2_097_152.0, 0.0), ..Xf::IDENTITY });
        assert!(bounds(&a, &huge, (0.02, 1)).is_none());
        let mut bad = square; bad.normals[1].x = f32::NAN;
        assert!(bounds(&a, &place_quad(&bad, Xf::IDENTITY), (0.02, 2)).is_none());
    }

    #[test]
    fn count_actual_interval_hits_at_steps_sixty_through_ninety_nine() {
        let mut world = profile_scenes::pyramid(100);
        let (mut attempts, mut hits) = (0u64, 0u64);
        for step in 0..100 {
            ATTEMPTS.with(|count| count.set(0)); HITS.with(|count| count.set(0));
            world.step(profile_scenes::DT).unwrap();
            if step >= 60 {
                let a = ATTEMPTS.with(Cell::get);
                let h = HITS.with(Cell::get);
                std::println!("FACE_INTERVAL step={step} apart_quad_calls={a} certified_clips={h}");
                attempts += a; hits += h;
            }
        }
        std::println!("FACE_INTERVAL_TOTAL frames=40 apart_quad_calls={attempts} certified_clips={hits} full32_candidate_paths_avoided={hits}");
        assert!(32 * hits > 2 * attempts, "the whole-window lower bound on removed distance-candidate work must be positive");
    }
}
