// Four independent polygon pairs in SIMD lanes. SAT and face clipping use the same ordered operations as the
// scalar Quad path in the parent module (Ericson 2005; Catto 2006, cited there). Apart pairs keep its exact distance
// path. No horizontal reductions: a lane's face choices, clipping and output never depend on another pair.
use super::*;
use margoengine_physics_kernel_common::lanes::M4;

#[derive(Clone, Copy)]
struct V {
    x: F4,
    y: F4,
}

impl V {
    #[inline(always)]
    fn add(self, b: Self) -> Self {
        Self {
            x: self.x + b.x,
            y: self.y + b.y,
        }
    }
    #[inline(always)]
    fn sub(self, b: Self) -> Self {
        Self {
            x: self.x - b.x,
            y: self.y - b.y,
        }
    }
    #[inline(always)]
    fn scale(self, s: F4) -> Self {
        Self {
            x: self.x * s,
            y: self.y * s,
        }
    }
    #[inline(always)]
    fn dot(self, b: Self) -> F4 {
        self.x * b.x + self.y * b.y
    }
    #[inline(always)]
    fn select(m: M4, a: Self, b: Self) -> Self {
        Self {
            x: F4::select(m, a.x, b.x),
            y: F4::select(m, a.y, b.y),
        }
    }
    #[inline(always)]
    fn rotate(self, c: F4, s: F4) -> Self {
        Self {
            x: c * self.x - s * self.y,
            y: s * self.x + c * self.y,
        }
    }
}

struct Quads {
    v: [V; 4],
    n: [V; 4],
}

#[inline(always)]
fn gather(values: [V2; 4]) -> V {
    V {
        x: F4::new(values.map(|v| v.x)),
        y: F4::new(values.map(|v| v.y)),
    }
}

#[inline(always)]
fn place_four(cores: [&Core; 4], c: F4, s: F4, p: V) -> Quads {
    Quads {
        // Even identity placement keeps the multiplies and additions: signed zero is part of the contract.
        v: core::array::from_fn(|i| gather(cores.map(|a| a.vertices[i])).rotate(c, s).add(p)),
        n: core::array::from_fn(|i| gather(cores.map(|a| a.normals[i])).rotate(c, s)),
    }
}

#[inline(always)]
fn best(a: &Quads, b: &Quads) -> (F4, F4) {
    let (mut most, mut edge) = (F4::splat(f32::NEG_INFINITY), F4::splat(-1.0));
    for i in 0..4 {
        let mut least = F4::splat(f32::INFINITY);
        for j in 0..4 {
            least = least.pmin(a.n[i].dot(b.v[j].sub(a.v[i])));
        }
        let greater = least.gt(most);
        most = F4::select(greater, least, most);
        edge = F4::select(greater, F4::splat(i as f32), edge);
    }
    (most, edge)
}

#[inline(always)]
fn pick(values: &[V; 4], index: F4) -> V {
    let mut value = values[0];
    for (i, &v) in values.iter().enumerate().skip(1) {
        value = V::select(index.ge(F4::splat(i as f32)), v, value);
    }
    value
}

#[inline(always)]
fn next(index: F4) -> F4 {
    let n = index + F4::splat(1.0);
    F4::select(n.ge(F4::splat(4.0)), F4::splat(0.0), n)
}

// Correctly rounded sqrt, exactly the scalar normalizer's operation on each SIMD target.
#[inline(always)]
fn square_root(v: F4) -> F4 {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;
        let a = v.get();
        let r = f32x4_sqrt(f32x4(a[0], a[1], a[2], a[3]));
        F4::new([
            f32x4_extract_lane::<0>(r),
            f32x4_extract_lane::<1>(r),
            f32x4_extract_lane::<2>(r),
            f32x4_extract_lane::<3>(r),
        ])
    }
    #[cfg(target_arch = "x86_64")]
    {
        use core::arch::x86_64::*;
        let mut a = v.get();
        unsafe { _mm_storeu_ps(a.as_mut_ptr(), _mm_sqrt_ps(_mm_loadu_ps(a.as_ptr()))) };
        F4::new(a)
    }
    #[cfg(not(any(target_arch = "x86_64", all(target_arch = "wasm32", target_feature = "simd128"))))]
    {
        F4::new(v.get().map(crate::math::sqrt))
    }
}

impl Quads {
    // The apart path reads the same placed vertices, normals and SAT results, without repeating that work.
    #[inline(always)]
    fn lane<const L: usize>(&self) -> Quad {
        let vx = self.v.map(|v| v.x.get()[L]);
        let vy = self.v.map(|v| v.y.get()[L]);
        let wx = self.n.map(|v| v.x.get()[L]);
        let wy = self.n.map(|v| v.y.get()[L]);
        Quad {
            x: F4::new(vx),
            y: F4::new(vy),
            nx: F4::new(wx),
            ny: F4::new(wy),
            vx,
            vy,
            wx,
            wy,
        }
    }
}

// Keep the scalar distance/clip branch out of the batched overlap function. It otherwise gets inlined for every
// extracted lane, enlarging the Wasm function and keeping the batch's vectors live across that scalar branch.
#[inline(never)]
fn separated(
    a: &Quad,
    b: &Quad,
    faces: ((f32, usize), (f32, usize)),
    pair: (&Core, Xf, &Core, Xf, Option<bool>),
    speculative: f32,
) -> Manifold {
    decide(
        a,
        b,
        faces,
        pair.0.radius,
        pair.2.radius,
        pair.1,
        speculative,
        pair.4,
        closest_quads,
    )
}

/// Four independent `collide_coherent` calls, with one pair per SIMD lane for overlapping four-cornered polygons.
/// Other shapes and separated cores retain the scalar path; input and output lane order is unchanged.
///
/// ```
/// use margoengine_physics2d_kernel::{
///     manifold::collide_four,
///     math::{V2, Xf, v2},
///     shape::Core,
/// };
/// let square = Core::rect(0.5, 0.5, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
/// let above = Xf { p: v2(0.0, 0.9), ..Xf::IDENTITY };
/// let pair = (&square, Xf::IDENTITY, &square, above, None);
/// let contacts = collide_four([pair; 4], 0.02);
/// assert!(contacts.iter().all(|m| m.count == 2));
/// ```
pub fn collide_four(pairs: [(&Core, Xf, &Core, Xf, Option<bool>); 4], speculative: f32) -> [Manifold; 4] {
    let quad_bits = pairs
        .iter()
        .enumerate()
        .fold(0, |bits, (i, p)| bits | (((p.0.count == 4 && p.2.count == 4) as u32) << i));
    if quad_bits == 0 {
        return pairs.map(|(a, xa, b, xb, last)| collide_coherent(a, xa, b, xb, speculative, last));
    }
    let zero = F4::splat(0.0);
    let one = F4::splat(1.0);
    let c = F4::new(pairs.map(|p| p.1.q.c));
    let s = F4::new(pairs.map(|p| p.1.q.s));
    let world_origin = gather(pairs.map(|p| p.1.p));
    let delta = gather(pairs.map(|p| p.3.p)).sub(world_origin);
    let bc = F4::new(pairs.map(|p| p.3.q.c));
    let bs = F4::new(pairs.map(|p| p.3.q.s));
    // xa.inverse_mul(xb), with its exact scalar multiplication and addition order in every lane.
    let relative_origin = V {
        x: c * delta.x + s * delta.y,
        y: -s * delta.x + c * delta.y,
    };
    let a = place_four(pairs.map(|p| p.0), one, zero, V { x: zero, y: zero });
    let b = place_four(pairs.map(|p| p.2), c * bc + s * bs, c * bs - s * bc, relative_origin);
    let ((da, ea), (db, eb)) = (best(&a, &b), best(&b, &a));
    let (ra, rb) = (F4::new(pairs.map(|p| p.0.radius)), F4::new(pairs.map(|p| p.2.radius)));
    let face = da.pmax(db);
    let valid = M4::from_bits(quad_bits).and(ea.ge(zero)).and(eb.ge(zero));
    let rejected = (face - (ra + rb)).gt(F4::splat(speculative));
    let overlap = valid.and_not(rejected).and(face.le(zero));
    let overlap_bits = overlap.bits();
    let mut out = [Manifold::default(); 4];
    if overlap_bits != 0 {
        let fresh = db.gt(da + F4::splat(FACE_TOLERANCE));
        let diff = db - da;
        let known = M4::from_bits(
            pairs
                .iter()
                .enumerate()
                .fold(0, |bits, (i, p)| bits | ((p.4.is_some() as u32) << i)),
        );
        let last = M4::from_bits(
            pairs
                .iter()
                .enumerate()
                .fold(0, |bits, (i, p)| bits | ((p.4 == Some(true)) as u32) << i),
        );
        let coherent = known
            .and(diff.ge(F4::splat(-FACE_HYSTERESIS)))
            .and(diff.le(F4::splat(FACE_HYSTERESIS)));
        let flip = fresh.and_not(coherent).or(last.and(coherent));
        let edge = F4::select(flip, eb, ea);
        let n = V::select(flip, pick(&b.n, edge), pick(&a.n, edge));
        let owner_v = core::array::from_fn(|i| V::select(flip, b.v[i], a.v[i]));
        let other_v = core::array::from_fn(|i| V::select(flip, a.v[i], b.v[i]));
        let r1 = pick(&owner_v, edge);
        let end = next(edge);
        let r2 = pick(&owner_v, end);
        let (mut least, mut incident) = (F4::splat(f32::INFINITY), zero);
        for j in 0..4 {
            let d = V::select(flip, a.n[j], b.n[j]).dot(n);
            let less = d.lt(least);
            least = F4::select(less, d, least);
            incident = F4::select(less, F4::splat(j as f32), incident);
        }
        let mut p0 = pick(&other_v, incident);
        let end = next(incident);
        let mut p1 = pick(&other_v, end);
        let edge_vector = r2.sub(r1);
        let length = square_root(edge_vector.dot(edge_vector));
        let tangent = V::select(length.gt(zero), edge_vector.scale(one / length), V { x: zero, y: zero });
        let mut alive = overlap;
        for (origin, sign) in [(r1, one), (r2, F4::splat(-1.0))] {
            let d0 = sign * tangent.dot(p0.sub(origin));
            let d1 = sign * tangent.dot(p1.sub(origin));
            let (outside0, outside1) = (d0.lt(zero), d1.lt(zero));
            alive = alive.and_not(outside0.and(outside1));
            if alive.and(outside0.or(outside1)).bits() != 0 {
                let cut = p0.add(p1.sub(p0).scale(d0 / (d0 - d1)));
                p0 = V::select(outside0, cut, p0);
                p1 = V::select(outside1.and_not(outside0), cut, p1);
            }
        }
        let (owner, other) = (F4::select(flip, rb, ra), F4::select(flip, ra, rb));
        let normal = V::select(flip, V { x: -n.x, y: -n.y }, n);
        // A side-plane early return leaves ZERO, which decide still rotates (including its signed zeros).
        let normal = V::select(alive, normal, V { x: zero, y: zero }).rotate(c, s);
        let (nx, ny) = (normal.x.get(), normal.y.get());
        let (edges, incidents, flips) = (edge.get(), incident.get(), flip.bits());
        for lane in 0..4 {
            if overlap_bits >> lane & 1 != 0 {
                out[lane].normal = v2(nx[lane], ny[lane]);
            }
        }
        for (k, p) in [p0, p1].into_iter().enumerate() {
            let depth = n.dot(p.sub(r1));
            let separation = depth - owner - other;
            let keep = alive.and_not(separation.gt(F4::splat(speculative))).bits();
            let point = p
                .add(n.scale(F4::splat(0.5) * (owner - depth - other)))
                .rotate(c, s)
                .add(world_origin);
            let (px, py, sep) = (point.x.get(), point.y.get(), separation.get());
            for lane in 0..4 {
                if keep >> lane & 1 != 0 {
                    let m = &mut out[lane];
                    m.points[m.count] = ManifoldPoint {
                        point: v2(px[lane], py[lane]),
                        separation: sep[lane],
                        id: clip_id(flips >> lane & 1 != 0, edges[lane] as usize, incidents[lane] as usize, k),
                    };
                    m.count += 1;
                }
            }
        }
    }
    let (das, dbs, eas, ebs) = (da.get(), db.get(), ea.get(), eb.get());
    let rejected_bits = rejected.and(valid).bits();
    if overlap_bits | rejected_bits == 15 {
        return out;
    }
    // Fixed lane indices let the SIMD targets extract only the requested pair. A dynamic get would spill every
    // vector to an array; transposing all four pairs would construct unused Quad values for overlapping lanes.
    macro_rules! fallback {
        ($lane:literal) => {
            if (overlap_bits | rejected_bits) >> $lane & 1 == 0 {
                let (ac, xa, bc, xb, last) = pairs[$lane];
                out[$lane] = if valid.bits() >> $lane & 1 != 0 {
                    separated(
                        &a.lane::<$lane>(),
                        &b.lane::<$lane>(),
                        ((das[$lane], eas[$lane] as usize), (dbs[$lane], ebs[$lane] as usize)),
                        pairs[$lane],
                        speculative,
                    )
                } else {
                    collide_coherent(ac, xa, bc, xb, speculative, last)
                };
            }
        };
    }
    fallback!(0);
    fallback!(1);
    fallback!(2);
    fallback!(3);
    out
}
