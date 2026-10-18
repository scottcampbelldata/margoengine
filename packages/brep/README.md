# @margoengine/brep

Margo's own CAD kernel, written from the published standards (ISO 10303-21 for the file, ISO 10303-41/42/43 and the
AP203, AP214 and AP242 schemas for the data) with no third-party CAD code. It is replacing OpenCascade in stages
(`docs/brep-kernel.md`): it reads a STEP file's structure (stage 1), evaluates its exact geometry (stage 2) and
tessellates it, one discretization per edge shared by both faces (stage 3) and a constrained Delaunay triangulation per
face (stage 4).

```sh
npm install @margoengine/brep@1.0.0
```

```ts
import { parseSTEP } from '@margoengine/brep';

const model = parseSTEP(await (await fetch('/assembly.step')).arrayBuffer());
console.log(model.header.schema, model.products.map((p) => p.name));
for (const instance of model.instances) {
  const body = model.bodies[instance.body];
  // instance.matrix: column-major, body coordinates in metres (times body.unit) to the model's world, in metres.
  console.log(model.products[instance.product]?.name, body.kind, body.faces.length, body.color);
}
```

To mesh the bodies:

```ts
import { parseSTEP, tessellateSTEP } from '@margoengine/brep';

const model = parseSTEP(bytes);
const meshes = tessellateSTEP(model, { relativeDeflection: 0.001, angle: 0.5 });
for (const instance of model.instances) {
  const mesh = meshes[instance.body];
  // mesh.positions (body units; times mesh.unit for metres), mesh.normals, mesh.indices; mesh.faces[i] is a run of
  // indices with the face's own colour; mesh.failures lists faces the kernel could not mesh.
  draw(mesh, instance.matrix);
}
```

To check the meshes against what the file says about itself (many AP242 and AP203 files state their volume, area,
centre, bounding box or facet count as CAx-IF validation properties):

```ts
import { parseSTEP, tessellateSTEP, validateSTEP } from '@margoengine/brep';

const model = parseSTEP(bytes);
for (const check of validateSTEP(model, tessellateSTEP(model)))
  if (!check.ok) console.warn(check.property.label, check.differences, check.note);
```

## What stage 1 reads

- **The file:** one pass indexes every entity instance of the DATA sections; parameters are parsed only when used, so
  a 10 MB file is not turned into millions of objects to read its structure. Text escapes (`''`, `\S\`, `\X\`, `\X2\`,
  `\X4\`) are decoded; bytes are read as ISO 8859-1, the standard's character set. `STEPFile` exposes the table:
  `get(id)`, `ids(type)` (complex instances listed under each partial type), `args(id, type)`, `census()`.
- **Products:** every `PRODUCT_DEFINITION` with its product's name and id (part number).
- **Assemblies:** `NEXT_ASSEMBLY_USAGE_OCCURRENCE` links placed by `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION` through
  an `ITEM_DEFINED_TRANSFORMATION` (or a Cartesian transformation operator), whichever way round the exporter wrote
  the two representations, and `MAPPED_ITEM` copies. A component an assembly link already places is not placed again
  by a mapped copy of it.
- **Bodies:** `MANIFOLD_SOLID_BREP`, `BREP_WITH_VOIDS`, `FACETED_BREP`, `SHELL_BASED_SURFACE_MODEL` and the AP242
  tessellated bodies (`TESSELLATED_SOLID`, `TESSELLATED_SHELL`, triangulated faces and surface sets, with triangle
  lists, strips and fans through `pnindex`, and the file's normals), with their faces and distinct edges, and a
  census of surface and edge-curve types.
- **Units:** each body's length unit in metres (SI prefixes and conversion-based units such as inches); placements are
  converted to metres.
- **Occurrences:** every placed product (a root, or a component where an assembly places it), with its parent and its
  frame in metres; each instance names its occurrence.
- **Validation properties:** `PROPERTY_DEFINITION`s tagged geometric or tessellated validation property, of a
  product or of a shape aspect that names bodies (`GEOMETRIC_ITEM_SPECIFIC_USAGE`, or a shape representation of the
  aspect): volume, area, centre point, bounding box and number of facets, in metres, with the measure items' own
  derived units. Values for independent surfaces are kept apart; independent points and curves, and the zero values
  some exporters write as placeholders, are left out. `validateSTEP` measures the meshes in each property's frame;
  a product's values cover its components' solids, its area may count surface bodies too (exporters differ), and a
  tessellated property is checked against the tessellated bodies.
- **Colours:** `STYLED_ITEM` and `OVER_RIDING_STYLED_ITEM` down to `COLOUR_RGB` or a pre-defined colour, with
  `SURFACE_STYLE_TRANSPARENT` as alpha; body colours, and face colours that differ.

## Geometry and tessellation (stages 2 to 4)

- **Curves:** line, circle, ellipse, polyline, B-spline and rational B-spline (simple or complex instances), through
  surface, seam, intersection and trimmed curves. A clamped B-spline that ends where it starts is treated as closed
  even when the file does not mark it so.
- **Surfaces:** plane, cylinder, cone, sphere, torus (and degenerate torus), surface of revolution, surface of linear
  extrusion, B-spline and rational B-spline, offset and rectangular trimmed surfaces. Each evaluates points and first
  derivatives (The NURBS Book's algorithms for splines) and inverts a point to its (u, v): closed form for the
  analytic surfaces, Gauss-Newton from the nearest of a grid of samples for splines.
- **Edges:** each edge is discretized once, between its exact vertices, by chord deflection and angle; every face
  that uses it uses the same points, so the mesh has no cracks.
- **Faces:** bounds are mapped into the surface's (u, v), unwrapped across seams; a pole or apex becomes a line of the
  domain; bounds that wrap round a surface are cut at a seam (a band) or closed at the pole (a cap); a face with no
  bounds covers its whole closed surface. The domain is triangulated with an exact-predicate constrained Delaunay
  triangulation (Shewchuk's robust predicates, Sloan's constraint recovery) over interior points spaced by curvature,
  then refined where an edge midpoint or a triangle centre strays from the surface by more than the deflection or
  neighbouring normals turn by more than the angle. Normals are the exact surface normals, flipped with the face.
- **Options:** `relativeDeflection` (default 0.001 of each body's bounding-box diagonal) or `deflection` in metres,
  `angle` (default 0.5 radians), `interiorDeflection` and `interiorAngle` for face interiors, `minSize`, and
  `maxFaceVertices` (default 50,000).

## Errors and limits

A malformed file throws a `TypeError` that names the line. `maxInstances` (default 1,000,000) bounds the placed bodies
of an assembly; a larger one throws a `RangeError` that names the option. Links, placements and styles the reader
cannot use are skipped with a message in `model.warnings` (at most 100). A face whose surface, curve or bounds the
kernel cannot resolve is left out of its body's mesh and listed in `mesh.failures` with the reason; the rest of the body
still meshes. Tessellation options out of range throw a `RangeError` that names the option.
