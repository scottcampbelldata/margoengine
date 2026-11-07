// @margoengine/gltf-pro/interactivity: KHR_interactivity (ratified by the Khronos Group; specification read at commit
// a7963af6dc of 2026-10-19), with KHR_node_selectability and KHR_node_hoverability. Runs the behaviour graph a file carries,
// so clicks, animations and material changes authored in the file work with no code of the app's.
import { BehaviorGraph, GraphRejected, compileInteractivity, type BehaviorGraphOptions, type GraphPhysics, type SelectInfo } from './interactivity-graph.js';
import { ObjectModel, type ActiveCamera } from './interactivity-model.js';
import type { GraphRef, GraphValue } from './interactivity-ops.js';
import type { GLTFAsset } from './index.js';

export { BehaviorGraph };
export type { ActiveCamera, BehaviorGraphOptions, GraphPhysics, GraphRef, GraphValue, SelectInfo };

/** The extensions a graph sees as enabled, beyond those of the materials and lights gltf-pro reads. */
const extensions = ['KHR_interactivity', 'KHR_node_selectability', 'KHR_node_hoverability', 'KHR_node_visibility', 'KHR_physics_rigid_bodies'];

// What the loaders read, each by name, so an unknown extension in a file never reads as enabled.
const read =
  /^KHR_(materials_(anisotropy|clearcoat|dispersion|emissive_strength|ior|iridescence|sheen|specular|transmission|unlit|variants|volume|volume_scatter)|texture_transform|lights_punctual|animation_pointer|mesh_quantization)$/;

/** Options of {@link loadBehaviorGraph}. */
export interface LoadBehaviorGraphOptions extends BehaviorGraphOptions {
  /** Receives each written property, to reach something rendered. */
  live?: (pointer: string, value: GraphValue) => void;
  /** The camera the viewer shows; absent, `activeCamera` reads as NaN. */
  camera?: () => ActiveCamera | undefined;
  /** Extensions to report as supported, beyond the ones this entry knows. Default none. */
  supported?: readonly string[];
}
/** The behaviour graph of a file, or why it has none. */
export interface LoadedBehaviorGraph {
  /** The running graph; undefined when the file has none or it was rejected. */
  graph?: BehaviorGraph;
  /** Why the file's graph must not run, when it was rejected. */
  rejected?: string;
}

/**
 * Reads the selected behaviour graph of an asset without an engine: time moves only through `graph.tick`. A graph the
 * specification rejects does not throw, as the file stays a valid model: it comes back as `rejected`. `sample` plays
 * animations: `sampleChannel` of `@margoengine/animation/interactivity`, which also runs a graph on a rendered model.
 *
 * @example
 * const {graph, rejected} = loadBehaviorGraph(asset);
 * graph?.on('checkout', ({variant}) => console.log(variant));
 * graph?.tick(1 / 60);
 */
export function loadBehaviorGraph(asset: GLTFAsset, options: LoadBehaviorGraphOptions = {}): LoadedBehaviorGraph {
  const doc = asset.doc as Record<string, any>;
  if (doc.extensions?.KHR_interactivity === undefined) return {};
  const supported = [...extensions, ...(options.supported ?? [])],
    model = new ObjectModel(doc, {
      accessor: (index, type) => asset.accessor(index, type),
      live: options.live,
      camera: options.camera,
      supports: (name) => supported.includes(name) || read.test(name),
    });
  try {
    const compiled = compileInteractivity(doc, model, supported);
    if (!compiled) return {};
    return { graph: new BehaviorGraph(compiled, model, options) };
  } catch (error) {
    if (error instanceof GraphRejected) return { rejected: error.message };
    throw error;
  }
}
