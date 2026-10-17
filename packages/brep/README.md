# @margoengine/brep

Margo's own CAD kernel, written from the published standards (ISO 10303-21 for the file, ISO 10303-41/42/43 and the
AP203, AP214 and AP242 schemas for the data) with no third-party CAD code. It is replacing OpenCascade in stages
(`docs/brep-kernel.md`): stage 1, in this release, reads a STEP file's structure; exact geometry, edge discretization
and face tessellation follow.

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
  tessellated bodies, with their faces and distinct edges, and a census of surface and edge-curve types.
- **Units:** each body's length unit in metres (SI prefixes and conversion-based units such as inches); placements are
  converted to metres.
- **Colours:** `STYLED_ITEM` and `OVER_RIDING_STYLED_ITEM` down to `COLOUR_RGB` or a pre-defined colour, with
  `SURFACE_STYLE_TRANSPARENT` as alpha; body colours, and face colours that differ.

## Errors and limits

A malformed file throws a `TypeError` that names the line. `maxInstances` (default 1,000,000) bounds the placed bodies
of an assembly; a larger one throws a `RangeError` that names the option. Links, placements and styles the reader
cannot use are skipped with a message in `model.warnings` (at most 100).
