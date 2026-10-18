# Where OpenCascade still leads (roadmap, to address later)

Noted 2026-10-17 from Scott's review. Each item is where OpenCascade (OCCT) is still ahead of `@margoengine/brep`, with
where Margo stands today and what matching it would take. Goal (Scott): match or beat OCCT on all of it.

## 1. Freeform NURBS-to-NURBS surface intersection

OCCT's biggest lead: 30 years of edge cases on arbitrary high-degree rational B-spline surfaces (marching, adaptive
subdivision, inflection points, singularities, high-order contact).

Margo today: Booleans intersect planes, cylinders, cones, spheres and tori exactly (closed forms for the analytic and
coaxial pairs, traced curves for the rest; `model/intersect.ts`, `model/march.ts`). Spline surfaces throw a RangeError.
Tangential contact inside both faces (two equal cylinders at right angles) throws; at a shared corner it is handled.

To match:
- signed distance and gradient for spline surfaces (closest-point projection with good seeds), so the tracer and
  the crossing search take them;
- seeds by subdivision with bounding boxes of both control nets (not iso-lines only), so small loops are not missed;
- singular points (tangent contact, branch points) located exactly and the branches through them traced;
- high-order contact and coincident freeform patches detected before marching.

## 2. Advanced blending

OCCT has variable-radius fillets along 3D curves, rolling-ball blends where the radius exceeds the adjoining face's
width (face-swallowing, setback corners), and G2/G3 (curvature-continuous) blend transitions.

Margo today: constant-radius fillets and chamfers on straight edges between planar faces, convex or concave, with
mitred corners where two blended edges meet and sphere corners where three meet at right angles (`model/blend.ts`).
Circular edges (hole and boss rims) are next, then edges on curved faces.

To match:
- rolling-ball blends on any pair of faces: the spine as the intersection of the two offset surfaces (traced), the
  blend surface as a swept circle (a spline), contact curves on both faces;
- variable radius along the spine; chord-length and setback options;
- vertex blends for any number of edges and radii (n-sided patches), and setbacks;
- face swallowing: a blend wider than a neighbouring face removes that face and continues on the next;
- G2/G3 blends (curvature-continuous cross-sections) as an option.

## 3. Healing and defeaturing

OCCT's `ShapeFix` takes broken, non-manifold IGES/STEP from sketchy exporters and stitches, snaps or re-approximates
it into solid shells.

Margo today: the reader tolerates a lot (missing placements, seams, poles, older SAT/XT forms) and meshes what it can,
reporting failed faces; the corpus has 0 failed faces on the 44 original files. It does not repair topology.

To match:
- sewing faces into shells by matching edges within a tolerance; closing small gaps;
- re-fitting p-curves and edges that do not lie on their surfaces; removing slivers and tiny edges;
- making shells closed and consistently oriented, then solids; reporting what was changed;
- defeaturing: removing holes, fillets and chamfers by face selection (the inverse of the operations above).
