// @margoengine/brep: Margo's own CAD kernel, written from the published standards (ISO 10303-21 for the file,
// ISO 10303-41/42/43 and the AP203/AP214/AP242 schemas for the data), with no third-party CAD code. Stage 1 reads a
// STEP file's structure: products, the assembly tree with placements, B-rep bodies, units and colours. Stages 2 to 4
// evaluate the exact geometry (analytic surfaces and NURBS) and tessellate it (docs/brep-kernel.md).
import { STEPFile, stepText, type STEPHeader } from './step/file.js';
import { readStructure, type STEPStructure, type STEPStructureOptions } from './step/structure.js';
import { Tessellator, type BodyMesh, type TessellationOptions } from './mesh/tessellate.js';
import { satToSTEP } from './sat/read.js';
export { validateSTEP } from './mesh/validate.js';
export type { STEPMeasured, STEPValidationCheck, ValidationOptions } from './mesh/validate.js';
export { satToSTEP } from './sat/read.js';
export type { SATConversion } from './sat/read.js';
export { readXT } from './xt/read.js';
export type { XTFile, XTNode, XTValue } from './xt/read.js';
export { xtToSTEP } from './xt/step.js';
export type { XTConversion } from './xt/step.js';
import { xtToSTEP } from './xt/step.js';

export { STEPFile, Ref, Enum, Typed, DERIVED, stepText } from './step/file.js';
export type { STEPEntity, STEPHeader, STEPValue } from './step/file.js';
export { readStructure } from './step/structure.js';
export type {
  STEPBody,
  STEPColor,
  STEPInstance,
  STEPOccurrence,
  STEPPoint,
  STEPProduct,
  STEPStructure,
  STEPStructureOptions,
  STEPValidationProperty,
} from './step/structure.js';
export { Tessellator } from './mesh/tessellate.js';
export type { BodyMesh, BodyMeshFace, TessellationOptions } from './mesh/tessellate.js';

/** Options of {@link parseSTEP}. */
export type STEPOptions = STEPStructureOptions;

/** A parsed STEP file: its header, structure and entity table. */
export interface STEPModel extends STEPStructure {
  readonly header: STEPHeader;
  /** Every entity instance, parsed on demand (for the geometry stages and for inspection). */
  readonly file: STEPFile;
}

/**
 * Reads a STEP file (ISO 10303-21; AP203, AP214 or AP242) into its products, assembly tree, B-rep bodies, length units
 * and colours, without evaluating geometry. Text or bytes (read as ISO 8859-1, the standard's character set). Throws a
 * TypeError that names the line for a malformed file.
 * @example
 * const model = parseSTEP(await (await fetch('/part.step')).arrayBuffer());
 * for (const instance of model.instances) console.log(model.products[instance.product]?.name, model.bodies[instance.body].faces.length);
 */
export function parseSTEP(input: string | ArrayBuffer | ArrayBufferView, options: STEPOptions = {}): STEPModel {
  const file = new STEPFile(stepText(input));
  return { header: file.header, file, ...readStructure(file, options) };
}

/**
 * Tessellates every body of a parsed STEP file from its exact geometry: one mesh per body (place it with each of the
 * body's `instances`), with exact surface normals, hard B-rep edges and a run of triangles per face. Faces the kernel
 * cannot evaluate are listed in each mesh's `failures`. Throws a RangeError for an option out of range.
 * @example
 * const model = parseSTEP(bytes);
 * const meshes = tessellateSTEP(model, { relativeDeflection: 0.001, angle: 0.5 });
 * for (const instance of model.instances) draw(meshes[instance.body], instance.matrix);
 */
export function tessellateSTEP(model: STEPModel, options: TessellationOptions = {}): BodyMesh[] {
  const tessellator = new Tessellator(model.file, model.faceColors, options);
  return model.bodies.map((body) => tessellator.body(body));
}

/**
 * Reads an ACIS SAT file (as AutoCAD, Inventor, SpaceClaim and others write it, or a DXF 3DSOLID's SAT data) through
 * {@link satToSTEP}, so it meshes with {@link tessellateSTEP} like a STEP file. What the conversion left out comes first
 * in `warnings`. Throws a TypeError for a file it cannot read.
 */
export function parseSAT(input: string | ArrayBuffer | ArrayBufferView, options: STEPOptions = {}): STEPModel {
  const conversion = satToSTEP(input),
    model = parseSTEP(conversion.step, options);
  return { ...model, warnings: [...conversion.warnings, ...model.warnings] };
}

/**
 * Reads a Parasolid transmit file (.x_t text or .x_b neutral binary, as NX, Solid Edge, SolidWorks, Onshape and others
 * write it) through {@link xtToSTEP}, so it meshes with {@link tessellateSTEP} like a STEP file. What the conversion
 * left out comes first in `warnings`. Throws a TypeError for a file it cannot read.
 */
export function parseXT(input: string | ArrayBuffer | ArrayBufferView, options: STEPOptions = {}): STEPModel {
  const conversion = xtToSTEP(input),
    model = parseSTEP(conversion.step, options);
  return { ...model, warnings: [...conversion.warnings, ...model.warnings] };
}

// Modeling (docs/brep-modeling.md): editable bodies with persistent names, construction, validation and export.
export { Body, Coedge, Edge, Face, History, Loop, Shell, Vertex } from './model/topology.js';
export type { HistoryEntry, Name } from './model/topology.js';
export { frameOf, curveEvaluator, surfaceEvaluator } from './model/geometry.js';
export type { CurveDef, Frame, SurfaceDef } from './model/geometry.js';
export { box, cylinder, extrude, sphere, torus } from './model/build.js';
export type { Profile, ProfileSegment } from './model/build.js';
export { validateBody } from './model/validate.js';
export type { ValidityProblem } from './model/validate.js';
export { bodiesToSTEP, meshBodies } from './model/export.js';
export type { BodyMeshes } from './model/export.js';
export { boolean } from './model/boolean.js';
export type { BooleanOperation } from './model/boolean.js';
export { curveSurfaceCrossings, intersectSurfaces, signedDistance } from './model/intersect.js';
export type { SurfaceIntersection } from './model/intersect.js';
export { orient3d } from './geometry/exact.js';
