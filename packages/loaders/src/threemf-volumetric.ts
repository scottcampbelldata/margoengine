// Reads the 3MF Consortium's Volumetric and Implicit Extensions (https://github.com/3MFConsortium/spec_volumetric):
// image stacks, functions, volume data and level set objects, beside the meshes the core reader gives.
import { read3MF, type ThreeMFOptions, type ThreeMFResult } from './threemf.js';
import { volumetricStage } from './threemf-volumetric-read.js';
import type { BinaryInput } from './util.js';

/** A volumetric function's data type. */
export type ThreeMFPortType = 'scalar' | 'vector' | 'matrix' | 'resourceid';

/** A function's output sampled over an object. */
export interface ThreeMFSampledField {
  functionId: string;
  channel: string;
  /** Twelve numbers as a 3MF transform writes them, from object to function coordinates; absent for the identity. */
  transform?: number[];
  /** In model units; 0 gives no hint. */
  minFeatureSize: number;
  /** The value where the function is undefined. */
  fallback: number;
}

/** What every resource says: its id, which is unique in its model part, and that part when it is not the root. */
export interface ThreeMFResource {
  id: string;
  modelPath?: string;
}

/** A voxel grid of PNG sheets. */
export interface ThreeMFImage3D extends ThreeMFResource {
  name?: string;
  rows: number;
  columns: number;
  sheets: { path: string; data: Uint8Array }[];
}

/** An input or output of a function or node. */
export interface ThreeMFPort {
  name: string;
  type: ThreeMFPortType;
  /** What an input or a function's output reads, as `node.output` or `inputs.name`. */
  ref?: string;
}

/** One native node of an implicit function. */
export interface ThreeMFFunctionNode {
  id: string;
  op: string;
  name?: string;
  /** The node's attributes as written, such as a constant's `value` or a matrix's `matrix`. */
  attributes: Record<string, string>;
  inputs: ThreeMFPort[];
  outputs: ThreeMFPort[];
}

/** A function that samples an image stack. */
export interface ThreeMFImageSampler extends ThreeMFResource {
  kind: 'image';
  name?: string;
  imageId: string;
  filter: 'linear' | 'nearest';
  /** The tile styles of `u`, `v` and `w`. */
  tile: [string, string, string];
  offset: number;
  scale: number;
}

/** A graph of native nodes, each reading only the inputs and the nodes before it. */
export interface ThreeMFImplicit extends ThreeMFResource {
  kind: 'implicit';
  name?: string;
  inputs: ThreeMFPort[];
  nodes: ThreeMFFunctionNode[];
  outputs: ThreeMFPort[];
}

/** What fills a volume. */
export interface ThreeMFVolumeData extends ThreeMFResource {
  color?: ThreeMFSampledField;
  /** One mapping for each base of the `basematerials` group, in its order. */
  composite?: { baseMaterialId: string; mappings: ThreeMFSampledField[] };
  properties: (ThreeMFSampledField & { name: string; namespace: string; required: boolean })[];
}

/** An object with volume data or a level set shape. */
export interface ThreeMFVolumetricObject {
  objectId: string;
  modelPath?: string;
  /** The volume data of its mesh or level set. */
  volumeId?: string;
  levelSet?: ThreeMFSampledField & {
    /** The mesh object that bounds the evaluation. */
    meshId: string;
    boundingBoxOnly: boolean;
    /** That mesh, in its own coordinates. */
    domain: { positions: Float32Array; indices: Uint32Array };
    /** The grid spacing the level set was meshed at, in the object's units. */
    cellSize?: number;
    /** The grid is too coarse for `minFeatureSize`: smaller features may be missing. */
    unresolved?: boolean;
  };
  /** The longest triangle side its volume colour was sampled at, in the object's units. */
  colorSpacing?: number;
  /** The spacing is too coarse for the colour's `minfeaturesize`: smaller features may be missing. */
  colorUnresolved?: boolean;
  /**
   * Each place the build puts the object: twelve numbers as a 3MF transform writes them, from the object's coordinates
   * to the result's units.
   */
  instances: Float64Array[];
}

/** Options of {@link parse3MFVolumetric}. */
export interface ThreeMFVolumetricOptions extends ThreeMFOptions {
  /** Evaluate each built level set and add its surface to the result. Default true. */
  meshLevelSets?: boolean;
  /**
   * Grid cells along the longest side of a level set's domain: 2 to 512, default 64. A `minfeaturesize` in the file
   * asks for more, up to 512. The spacing is rounded down to a power of two.
   */
  levelSetResolution?: number;
  /** Sample each built shape's volume colour onto its triangles. Default true. */
  sampleColors?: boolean;
  /**
   * Colour samples along the longest side of a shape: 1 to 512, default 32. Triangles are split until no side is
   * longer than that spacing; a `minfeaturesize` in the file asks for more, up to 512.
   */
  colorResolution?: number;
}

/** The result of {@link parse3MFVolumetric}. */
export interface ThreeMFVolumetricResult extends ThreeMFResult {
  images: ThreeMFImage3D[];
  functions: (ThreeMFImageSampler | ThreeMFImplicit)[];
  volumes: ThreeMFVolumeData[];
  /** The built objects that have a level set or volume data. */
  objects: ThreeMFVolumetricObject[];
}

/**
 * Parses a 3MF package with the volumetric and implicit extensions. Each built level set is evaluated inside its domain
 * mesh (or that mesh's box) and its surface joins the result's triangles, in object coordinates placed by the build.
 * A built shape whose volume data has a colour takes it on its surface: its triangles are split to the sample spacing
 * and the colour function is read at their corners, except where the file gives a surface property of its own. The
 * volumetric resources and the built objects that use them are returned beside them. Composites and properties of
 * volume data are returned as data only.
 *
 * @throws LoaderError for a reference to a resource the package does not define, a graph that reads a later node, an
 * output of another type or itself, a sheet part that is missing, a level set or colour sampling over `maxTriangles`,
 * a level set with a node that is not evaluated, and what `parse3MF` throws.
 */
export async function parse3MFVolumetric(
  input: BinaryInput,
  options: ThreeMFVolumetricOptions = {},
): Promise<ThreeMFVolumetricResult> {
  const stage = volumetricStage(options),
    read = await read3MF(input, options, {
      ...stage.hooks,
      async ready(bytes, context) {
        await stage.hooks.ready!(bytes, context);
        stage.paint(context.models);
      },
    });
  return { ...read, ...stage.result() };
}
