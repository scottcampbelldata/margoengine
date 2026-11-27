// @margoengine/loaders/threemf-evaluate: one call that turns every 3MF shape of a package into triangles. The
// displacement, volumetric, beam lattice and boolean readers run on one reading of the package, in the order their
// results feed each other: displacement meshes are tessellated, level sets meshed, lattices made and clipped, volume
// colours sampled, and boolean shapes evaluated on what came before
// (https://github.com/3MFConsortium/spec_booleans: a base may be any extension's shape).
import { booleanStage } from './threemf-boolean-read.js';
import type { ThreeMFBooleanOptions, ThreeMFBooleanResult } from './threemf-boolean.js';
import { displacementStage } from './threemf-displacement-read.js';
import type { ThreeMFDisplacementOptions, ThreeMFDisplacementResult } from './threemf-displacement.js';
import { lattices } from './threemf-lattice-mesh.js';
import type { ThreeMFBeamLattice } from './threemf-lattice.js';
import { volumetricStage } from './threemf-volumetric-read.js';
import type { ThreeMFVolumetricOptions, ThreeMFVolumetricResult } from './threemf-volumetric.js';
import { read3MF, type ThreeMFExtension, type ThreeMFResult } from './threemf.js';
import type { BinaryInput } from './util.js';

/** Options of {@link parse3MFEvaluated}: those of the readers it joins, each evaluating. */
export interface ThreeMFEvaluateOptions
  extends Omit<ThreeMFDisplacementOptions, 'tessellate'>,
    Omit<ThreeMFVolumetricOptions, 'meshLevelSets'>,
    Omit<ThreeMFBooleanOptions, 'evaluate'> {
  /** Sides of a beam or ball around its axis: 3 to 256, default 16. */
  beamSegments?: number;
}

/** A beam lattice of a mesh object. */
export interface ThreeMFEvaluatedLattice {
  objectId: string;
  modelPath?: string;
  lattice: ThreeMFBeamLattice;
}

/** The result of {@link parse3MFEvaluated}. */
export interface ThreeMFEvaluatedResult
  extends ThreeMFResult,
    Pick<ThreeMFDisplacementResult, 'maps' | 'displacementGroups' | 'meshes'>,
    Pick<ThreeMFVolumetricResult, 'images' | 'functions' | 'volumes' | 'objects'>,
    Pick<ThreeMFBooleanResult, 'shapes'> {
  /** Every beam lattice; its triangles are part of the result's wherever the build places its object. */
  lattices: ThreeMFEvaluatedLattice[];
}

/** One extension that hands every call to each of `parts` in turn. */
function joined(parts: readonly ThreeMFExtension[]): ThreeMFExtension {
  return {
    booleans: true,
    levelSets: true,
    welded: true,
    element(model, name, attributes) {
      for (const part of parts) part.element?.(model, name, attributes);
    },
    field: {
      open(model, name, attributes) {
        for (const part of parts) part.field?.open(model, name, attributes);
      },
      close(model, name) {
        for (const part of parts) part.field?.close(model, name);
      },
    },
    close(model, name) {
      for (const part of parts) part.close?.(model, name);
    },
    instance(...placed) {
      for (const part of parts) part.instance?.(...placed);
    },
    hasGeometry: () => parts.some((part) => part.hasGeometry?.()),
    async ready(read, context) {
      for (const part of parts) await part.ready?.(read, context);
    },
    bucket: () => '',
    corner() {},
    group() {},
  };
}

/**
 * Parses a 3MF package and evaluates every shape in it, whichever extensions it mixes: displacement meshes are
 * tessellated, volumetric level sets meshed, beam lattices and balls made into triangles (clipped by their clipping
 * mesh), volume colours sampled onto the surfaces, and boolean shapes evaluated, their base being any of these. The
 * result holds those surfaces where the build places them, with what each reader returns beside them.
 *
 * A lattice's shells overlap its mesh and each other, which the 3MF positive fill rule reads as one solid; a lattice
 * with a clipping mesh, and a boolean's result, are single surfaces. Clipping and boolean evaluation need the optional
 * `@margoengine/mesh-edit` peer.
 *
 * @throws LoaderError for whatever `parse3MFDisplacement`, `parse3MFVolumetric` and `parse3MFBoolean` refuse, apart
 * from a boolean base of another extension, and for a lattice over `maxTriangles`.
 */
export async function parse3MFEvaluated(
  input: BinaryInput,
  options: ThreeMFEvaluateOptions = {},
): Promise<ThreeMFEvaluatedResult> {
  const displacement = displacementStage(options),
    beams = lattices(options),
    volumetric = volumetricStage(options, beams.add),
    booleans = booleanStage(options, true),
    colours: ThreeMFExtension = {
      // Last: volume colour goes onto the surfaces the steps before have made.
      ready: async (_read, { models }) => volumetric.paint(models),
      bucket: () => '',
      corner() {},
      group() {},
    },
    // `beams.hooks` only notes the colour groups; its triangles are made inside the volumetric step.
    read = await read3MF(
      input,
      options,
      joined([displacement.hooks, beams.hooks, volumetric.hooks, booleans.hooks, colours]),
    );
  return {
    ...read,
    ...displacement.result(),
    ...volumetric.result(),
    shapes: booleans.shapes,
    lattices: beams.result(),
  };
}
