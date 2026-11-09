// Four independent polygon pairs in SIMD lanes. SAT and face clipping use the same ordered operations as the
// scalar Quad path in the parent module (Ericson 2005; Catto 2006, cited there). Apart pairs keep its exact decision:
// a proven preferred-face certificate or the complete distance path. No lane's output depends on another pair.
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

// Restricted support-point SAT. This is a certificate over current placed values, not constructor metadata:
// Core's arrays are public and may have changed. All eight axes remain; uncertified lanes keep the old scans.
#[inline(always)]
fn grid(a: &Quads) -> M4 {
    let mut valid = a.v[0].x.eq(a.v[3].x).and(a.v[1].x.eq(a.v[2].x))
        .and(a.v[0].y.eq(a.v[1].y)).and(a.v[2].y.eq(a.v[3].y))
        .and(a.v[0].x.lt(a.v[1].x)).and(a.v[0].y.lt(a.v[3].y));
    // Canonical outward normals are certified from the current public arrays, including their magnitudes.
    for (i, [x, y]) in [[0.0, -1.0], [1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]].into_iter().enumerate() {
        valid = valid.and(a.n[i].x.eq(F4::splat(x))).and(a.n[i].y.eq(F4::splat(y)));
    }
    valid
}


/// Created only by this module from the current grid+safe SAT certificate.
/// Fields are private: public Core data cannot forge a scan bypass.
#[derive(Clone, Copy)]
pub(super) struct DistanceMetadata {
    magnitude: f32,
}
impl DistanceMetadata {
    pub(super) fn magnitude(self) -> f32 { self.magnitude }
}

struct SatCertificate {
    valid: M4,
    magnitude: F4,
}
impl SatCertificate {
    fn metadata<const L: usize>(&self) -> Option<DistanceMetadata> {
        let magnitude = self.magnitude.get()[L];
        if self.valid.bits() >> L & 1 != 0 && magnitude >= 1.0 && magnitude <= 1_048_576.0 {
            Some(DistanceMetadata { magnitude })
        } else { None }
    }
}

#[inline(always)]
fn safe(a: &Quads, b: &Quads) -> (M4, F4) {
    // A successful squared-length comparison rejects NaN/infinity/overflow as well as overly large finite data.
    // |coordinate| <= 2^60 and |normal component| <= 2 imply |difference| <= 2^61, |product| <= 2^62,
    // |sum| <= 2^63. Every original projection operation is therefore finite. Larger data retain the old path.
    let coordinate_squared = F4::splat(f32::from_bits(0x7b80_0000)); // 2^120
    let normal_squared = F4::splat(4.0);
    let mut valid = M4::from_bits(15);
    let mut magnitude = F4::splat(1.0);
    for vertex in [a.v[0], a.v[2], b.v[0], b.v[1], b.v[2], b.v[3]] {
        let squared = vertex.dot(vertex);
        valid = valid.and(squared.le(coordinate_squared));
        // For representable |x|>=1, RN(x*x)>=|x| by monotonicity;
        // RN(nonnegative square sum) cannot be lower. Below1, the floor1 wins.
        magnitude = magnitude.pmax(squared);
    }
    // A normals are exact unit axes by grid(); only B needs the range guard.
    for normal in b.n {
        valid = valid.and(normal.dot(normal).le(normal_squared));
    }
    (valid, magnitude)
}

#[inline(always)]
fn restricted(a: &Quads, b: &Quads) -> ((F4, F4), (F4, F4), SatCertificate) {
    let mut certified = grid(a);
    if certified.bits() == 0 { return (best(a, b), best(b, a), SatCertificate { valid: certified, magnitude: F4::splat(1.0) }); }
    let (safe_mask, magnitude) = safe(a, b);
    certified = certified.and(safe_mask);
    if certified.bits() == 0 { return (best(a, b), best(b, a), SatCertificate { valid: certified, magnitude }); }
    let zero = F4::splat(0.0);
    let (mut lo, mut hi) = (b.v[0], b.v[0]);
    for vertex in &b.v[1..] {
        lo = V { x: lo.x.pmin(vertex.x), y: lo.y.pmin(vertex.y) };
        hi = V { x: hi.x.pmax(vertex.x), y: hi.y.pmax(vertex.y) };
    }
    let (mut da, mut ea, mut db, mut eb) = (F4::splat(f32::NEG_INFINITY), F4::splat(-1.0), F4::splat(f32::NEG_INFINITY), F4::splat(-1.0));
    let support_b = [V { x: lo.x, y: hi.y }, lo, lo, V { x: hi.x, y: lo.y }];
    for i in 0..4 {
        // A's canonical normals fix the B coordinate extreme without per-face sign selections. The matching B coordinate extreme is the same numeric minimum;
        // the unused coordinate multiplies zero. Both coordinate differences are finite by the certificate.
        let vertex_b = support_b[i];
        let minimum_a = a.n[i].dot(vertex_b.sub(a.v[i]));
        let greater_a = minimum_a.gt(da);
        da = F4::select(greater_a, minimum_a, da);
        ea = F4::select(greater_a, F4::splat(i as f32), ea);

        // Every combination of the grid's coordinate extremes is an actual corner. Fixed-sign multiplication and
        // correctly rounded subtraction/addition are monotone, so evaluating this original dot gives the old minimum.
        // Coordinate equality may differ only in +/-0 bits between equal grid corners; SAT values are only compared.
        let vertex_a = V { x: F4::select(b.n[i].x.ge(zero), a.v[0].x, a.v[1].x), y: F4::select(b.n[i].y.ge(zero), a.v[0].y, a.v[3].y) };
        let minimum_b = b.n[i].dot(vertex_a.sub(b.v[i]));
        let greater_b = minimum_b.gt(db);
        db = F4::select(greater_b, minimum_b, db);
        eb = F4::select(greater_b, F4::splat(i as f32), eb);
    }
    if certified.bits() == 15 { return ((da, ea), (db, eb), SatCertificate { valid: certified, magnitude }); }
    let ((old_da, old_ea), (old_db, old_eb)) = (best(a, b), best(b, a));
    ((F4::select(certified, da, old_da), F4::select(certified, ea, old_ea)), (F4::select(certified, db, old_db), F4::select(certified, eb, old_eb)), SatCertificate { valid: certified, magnitude })
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

fn finite_lanes(value: F4, active: M4) -> Result<(), PhysicsError> {
    let finite = value.ge(F4::splat(-f32::MAX)).and(value.le(F4::splat(f32::MAX)));
    if active.and_not(finite).bits() != 0 { Err(PhysicsError::ArithmeticOverflow) } else { Ok(()) }
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
    metadata: Option<DistanceMetadata>,
) -> Result<Manifold, PhysicsError> {
    face_distance::decide_quads_with_metadata(
        a,
        b,
        faces,
        pair.0.radius,
        pair.2.radius,
        pair.1,
        speculative,
        pair.4,
        metadata,
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
/// let contacts = collide_four([pair; 4], 0.02).unwrap();
/// assert!(contacts.iter().all(|m| m.count == 2));
/// ```
pub fn collide_four(pairs: [(&Core, Xf, &Core, Xf, Option<bool>); 4], speculative: f32) -> Result<[Manifold; 4], PhysicsError> {
    for &(a, xa, b, xb, _) in &pairs { validate_collision_inputs(a, xa, b, xb, speculative)?; }
    collide_four_trusted(pairs, speculative)
}

pub(crate) fn collide_four_trusted(pairs: [(&Core, Xf, &Core, Xf, Option<bool>); 4], speculative: f32) -> Result<[Manifold; 4], PhysicsError> {
    let quad_bits = pairs
        .iter()
        .enumerate()
        .fold(0, |bits, (i, p)| bits | (((p.0.count == 4 && p.2.count == 4) as u32) << i));
    if quad_bits == 0 {
        let [a, b, c, d] = pairs.map(|(a, xa, b, xb, last)| collide_coherent_trusted(a, xa, b, xb, speculative, last));
        return Ok([a?, b?, c?, d?]);
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
    let ((da, ea), (db, eb), certificate) = restricted(&a, &b);
    // The selected float edge is used as an index only when both SAT scans produced a real finite face.
    // NaN compares produce the old -1 sentinel; overflowing projections can leave infinite separations.
    for lane in 0..4 {
        if quad_bits >> lane & 1 != 0
            && (!da.get()[lane].is_finite() || !db.get()[lane].is_finite()
                || !(0.0..4.0).contains(&ea.get()[lane]) || !(0.0..4.0).contains(&eb.get()[lane])) {
            return Err(PhysicsError::ArithmeticOverflow);
        }
    }
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
        finite_lanes(length, overlap)?;
        let tangent = V::select(length.gt(zero), edge_vector.scale(one / length), V { x: zero, y: zero });
        let mut alive = overlap;
        for (origin, sign) in [(r1, one), (r2, F4::splat(-1.0))] {
            let d0 = sign * tangent.dot(p0.sub(origin));
            let d1 = sign * tangent.dot(p1.sub(origin));
            finite_lanes(d0, alive)?;
            finite_lanes(d1, alive)?;
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
        for manifold in &out { checked_manifold(*manifold)?; }
        return Ok(out);
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
                        certificate.metadata::<$lane>(),
                    )?
                } else {
                    collide_coherent_trusted(ac, xa, bc, xb, speculative, last)?
                };
            }
        };
    }
    fallback!(0);
    fallback!(1);
    fallback!(2);
    fallback!(3);
    for manifold in &out { checked_manifold(*manifold)?; }
    Ok(out)
}

#[cfg(test)]
mod axis_tests {
    use super::*;

    #[test]
    fn rectangle_certificate_uses_current_data_and_guards_oversized_or_nonfinite_inputs() {
        let core = Core::rect(0.5, 0.75, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
        let zero = F4::splat(0.0);
        let one = F4::splat(1.0);
        let mut a = place_four([&core; 4], one, zero, V { x: zero, y: zero });
        let mut b = place_four([&core; 4], F4::new([1.0, 0.6, -1.0, 0.8]), F4::new([0.0, 0.8, -0.0, -0.6]), V { x: F4::new([0.0, 0.03, 2.0, -0.05]), y: F4::new([1.5, 0.9, -0.0, 0.5]) });
        assert_eq!(grid(&a).and(safe(&a, &b).0).bits(), 15);
        let verify = |a: &Quads, b: &Quads| {
            let ((da, ea), (db, eb), _) = restricted(a, b);
            let ((old_da, old_ea), (old_db, old_eb)) = (best(a, b), best(b, a));
            // SAT callers compare face values; +/-0 are equal there. Every face index must be identical.
            assert_eq!(da.get(), old_da.get()); assert_eq!(db.get(), old_db.get());
            assert_eq!(ea.get().map(f32::to_bits), old_ea.get().map(f32::to_bits));
            assert_eq!(eb.get().map(f32::to_bits), old_eb.get().map(f32::to_bits));
        };
        verify(&a, &b);
        let mut magnitude = a.n[0].y.get(); magnitude[0] = -0.75; a.n[0].y = F4::new(magnitude);
        assert_eq!(grid(&a).and(safe(&a, &b).0).bits(), 14, "axis-normal magnitude mutation must invalidate the certificate");
        verify(&a, &b);
        magnitude[0] = -1.0; a.n[0].y = F4::new(magnitude);
        let mut changed = a.v[1].y.get(); changed[2] += 0.0001; a.v[1].y = F4::new(changed);
        let mut huge = b.v[0].x.get(); huge[3] = 1e30; b.v[0].x = F4::new(huge);
        assert_eq!(grid(&a).and(safe(&a, &b).0).bits(), 3);
        verify(&a, &b);
        let mut changed = a.n[0].x.get(); changed[0] = 0.001; a.n[0].x = F4::new(changed);
        let mut nan = b.n[1].x.get(); nan[1] = f32::NAN; b.n[1].x = F4::new(nan);
        assert_eq!(grid(&a).and(safe(&a, &b).0).bits(), 0);
        verify(&a, &b);
    }
}


#[cfg(test)]
mod metadata_tests {
    use super::*;
    #[test]
    fn current_sat_metadata_bounds_coordinates_and_preserves_the_old_sat_range() {
        let core = Core::rect(0.5, 0.75, V2::ZERO, 1.0, 0.0, 0.0).unwrap();
        let zero = F4::splat(0.0);
        let one = F4::splat(1.0);
        let a = place_four([&core; 4], one, zero, V { x: zero, y: zero });
        let b = place_four([&core; 4], one, zero, V { x: F4::new([0.0, 2.0, 2_000.0, 1.0e12]), y: F4::new([1.52, 0.0, 0.0, 0.0]) });
        let (_, _, certificate) = restricted(&a, &b);
        assert_eq!(certificate.valid.bits(), 15, "distance metadata must not shrink the original2^120 SAT range");
        for lane in 0..4 {
            let magnitude = certificate.magnitude.get()[lane];
            for vertex in [a.v[0], a.v[1], a.v[2], a.v[3], b.v[0], b.v[1], b.v[2], b.v[3]] {
                assert!(vertex.x.get()[lane].abs() <= magnitude && vertex.y.get()[lane].abs() <= magnitude);
            }
        }
        assert!(certificate.metadata::<0>().is_some());
        assert!(certificate.metadata::<1>().is_some());
        assert!(certificate.metadata::<2>().is_none());
        assert!(certificate.metadata::<3>().is_none());
        let mut mutated = a;
        let mut normal = mutated.n[0].y.get(); normal[0] = -0.75; mutated.n[0].y = F4::new(normal);
        let (_, _, changed) = restricted(&mutated, &b);
        assert!(changed.metadata::<0>().is_none(), "current public normal mutation invalidates private metadata");
    }
}
