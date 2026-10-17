// @margoengine/brep: Margo's own CAD kernel, written from the published standards (ISO 10303-21 for the file,
// ISO 10303-41/42/43 and the AP203/AP214/AP242 schemas for the data), with no third-party CAD code. Stage 1 reads a
// STEP file's structure: products, the assembly tree with placements, B-rep bodies, units and colours. Exact geometry
// and tessellation follow (docs/brep-kernel.md).
import { STEPFile, stepText, type STEPHeader } from './step/file.js';
import { readStructure, type STEPStructure, type STEPStructureOptions } from './step/structure.js';

export { STEPFile, Ref, Enum, Typed, DERIVED, stepText } from './step/file.js';
export type { Entity, STEPHeader, Value } from './step/file.js';
export { readStructure } from './step/structure.js';
export type {
  STEPBody,
  STEPColor,
  STEPInstance,
  STEPProduct,
  STEPStructure,
  STEPStructureOptions,
} from './step/structure.js';

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
