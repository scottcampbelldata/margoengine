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
export type { XTConversion, XTOptions } from './xt/step.js';
import { xtToSTEP } from './xt/step.js';
import { igesToSTEP } from './iges/step.js';
export { igesToSTEP } from './iges/step.js';
export type { IGESConversion } from './iges/step.js';
export { isIGES, readIGES } from './iges/file.js';
export type { IGESEntity, IGESFile, IGESGlobal, IGESValue } from './iges/file.js';
import type { JTModel } from './jt/read.js';

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

/**
 * Reads an IGES 5.3 file (fixed ASCII format, as most CAD tools export .igs/.iges) through {@link igesToSTEP}, so it
 * meshes with {@link tessellateSTEP} like a STEP file: manifold solid B-rep objects become solids, trimmed and bounded
 * surfaces the faces of a surface model, in millimetres. What the conversion left out comes first in `warnings`.
 * Throws a TypeError for a file it cannot read, or one with no surfaces or solids.
 * @example
 * const model = parseIGES(await (await fetch('/part.igs')).arrayBuffer());
 * const meshes = tessellateSTEP(model);
 */
export function parseIGES(input: string | ArrayBuffer | ArrayBufferView, options: STEPOptions = {}): STEPModel {
  const conversion = igesToSTEP(input),
    model = parseSTEP(conversion.step, options);
  return { ...model, warnings: [...conversion.warnings, ...model.warnings] };
}

// JT (ISO 14306, JT 9.5 and later; licensing in docs/jt-licensing.md).
export { parseJT } from './jt/read.js';
export type { JTInstance, JTModel, JTOptions, JTPart, JTShape } from './jt/read.js';
export type {
  JTAttribute,
  JTLateLoaded,
  JTNode,
  JTNodeKind,
  JTPropertyValue,
  JTSceneGraph,
  JTShapeKind,
} from './jt/lsg.js';
/**
 * Tessellates the exact B-rep of every part of a parsed JT file (see {@link tessellateSTEP}): per part, one mesh per
 * body of its `brep`, or undefined for a part without one. Place each with the part's instances, then the body's own
 * instances within its `brep`. Throws a RangeError for an option out of range.
 * @example
 * const model = parseJT(bytes);
 * const meshes = tessellateJT(model);
 * for (const instance of model.instances) {
 *   const brep = model.parts[instance.part].brep;
 *   for (const placed of brep?.instances ?? []) draw(meshes[instance.part]![placed.body], instance.matrix, placed.matrix);
 * }
 */
export function tessellateJT(model: JTModel, options: TessellationOptions = {}): (BodyMesh[] | undefined)[] {
  return model.parts.map((part) => (part.brep ? tessellateSTEP(part.brep, options) : undefined));
}

// Modeling (docs/brep-modeling.md): editable bodies with persistent names, construction, validation and export.
/** The modeler (B-rep topology, primitives, Booleans, fillets and chamfers, STEP export): see model/index.ts. */
export * as model from './model/index.js';
export { orient3d } from './geometry/exact.js';
