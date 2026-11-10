/// <reference lib="esnext.disposable" preserve="true" />
import { MargoError } from '@margoengine/math/errors';
import { NodeEditor, type GraphLayout, type EditorOperation } from './editor.js';
import { compileSurfaceGraph, parseSurfaceGraph, serializeSurfaceGraph, type SurfaceGraph } from './graph.js';
import { NodePass, inputColor, inputDepth } from './post.js';
import { ComputePass, StorageBuffer, globalId, localId, workgroupId } from './compute.js';
import { ComputeTexture } from './compute-texture.js';
import { ComputeVolume } from './compute-volume.js';
import { vec3, vec4, screenUV, screenCoordinate, resolution, time, type Node } from './node.js';

/** Resource names are saved; the application supplies their live objects again on load. */
export type PassGraphResources = Readonly<Record<string, StorageBuffer | ComputeTexture | ComputeVolume>>;
/** A saved post effect or procedural compute graph, including its authoring layout. */
export interface PassGraph {
  version: 1;
  kind: 'post' | 'compute';
  graph: SurfaceGraph;
  layout?: GraphLayout;
  /** Post colour space, default ldr. */
  colorSpace?: 'hdr' | 'ldr';
  /** Compute dispatch shape and resource names. Required for compute. */
  compute?: { size: [number, number, number]; target: string; source?: string };
}
const defaults = (): PassGraph => ({
  version: 1,
  kind: 'post',
  graph: {
    version: 1,
    nodes: [{ id: 'screen', op: 'color', inputs: [] }],
    outputs: { color: 'screen' },
    fallback: { color: [0, 0, 0], emissive: [0, 0, 0], roughness: 0.5, metalness: 0, opacity: 1 },
  },
});
const inputNames = ['position', 'worldPosition', 'normal', 'worldNormal', 'color', 'uv'] as const;
const name = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const bounded = (json: string) => {
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > 131072)
    throw new RangeError('Use a pass graph JSON document of at most 131072 bytes');
};
/** Parse and validate a bounded, independent pass document without GPU handles or executable source. */
export function parsePassGraph(json: string): PassGraph {
  bounded(json);
  const doc: PassGraph = JSON.parse(json);
  if (!doc || doc.version !== 1 || (doc.kind !== 'post' && doc.kind !== 'compute'))
    throw new TypeError('Use a version 1 post or compute pass graph');
  if (doc.colorSpace !== undefined && doc.colorSpace !== 'hdr' && doc.colorSpace !== 'ldr')
    throw new TypeError('Use hdr or ldr colorSpace');
  const graph = parseSurfaceGraph(serializeSurfaceGraph(doc.graph));
  if (Object.keys(graph.outputs).some((slot) => slot !== 'color' && slot !== 'opacity'))
    throw new TypeError('Pass graphs use color and opacity outputs only; remove material slots');
  const layout: GraphLayout = {};
  if (doc.layout !== undefined) {
    if (
      !doc.layout ||
      typeof doc.layout !== 'object' ||
      Array.isArray(doc.layout) ||
      Object.keys(doc.layout).length > 129
    )
      throw new TypeError('Use at most 129 layout positions');
    for (const [id, at] of Object.entries(doc.layout)) {
      if (
        (id !== 'output' && !graph.nodes.some((n) => n.id === id)) ||
        !Array.isArray(at) ||
        at.length !== 2 ||
        !at.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6)
      )
        throw new TypeError('Use finite layout positions for existing nodes, within one million pixels');
      layout[id] = [at[0], at[1]];
    }
  }
  if (doc.kind === 'post') {
    if (doc.compute !== undefined) throw new TypeError('Remove compute settings from a post graph');
    return { version: 1, kind: 'post', graph, layout, colorSpace: doc.colorSpace ?? 'ldr' };
  }
  const c = doc.compute;
  if (
    !c ||
    !Array.isArray(c.size) ||
    c.size.length !== 3 ||
    !c.size.every((n) => Number.isInteger(n) && n > 0 && n <= 65535) ||
    c.size.reduce((a, b) => a * b, 1) > 0xffffffff ||
    !name(c.target) ||
    (c.source !== undefined && !name(c.source))
  )
    throw new TypeError(
      'Use a compute size of three positive integers up to 65535, at most 4294967295 invocations, and named target/source resources',
    );
  return {
    version: 1,
    kind: 'compute',
    graph,
    layout,
    compute: { size: [...c.size], target: c.target, ...(c.source ? { source: c.source } : {}) },
  };
}
/** Stable JSON for a graph and layout, ready for local files or application storage. */
export function serializePassGraph(doc: PassGraph): string {
  return JSON.stringify(parsePassGraph(JSON.stringify(doc)));
}
const resource = (resources: PassGraphResources, id: string, count: number) => {
  const r = Object.hasOwn(resources, id) ? resources[id] : undefined;
  if (!(r instanceof StorageBuffer || r instanceof ComputeTexture || r instanceof ComputeVolume))
    throw new TypeError(`Provide the pass graph resource '${id}'`);
  if (
    r instanceof StorageBuffer ? r.type !== 'vec4f' || r.count < count : /[us]int$/.test(r.format) || r.pixels < count
  )
    throw new TypeError(`Use a float texture or vec4f buffer '${id}' large enough for ${count} invocations`);
  return r;
};
const read = (r: StorageBuffer | ComputeTexture | ComputeVolume, i: Node<'u32'>): Node<'vec4f'> =>
  (r instanceof StorageBuffer ? r.element(i) : r.load(r.coord(i) as never)) as Node<'vec4f'>;
/** Compile the saved graph to a native pass. Resources are borrowed; disposing the pass leaves them alive. */
export function compilePassGraph(value: PassGraph, resources: PassGraphResources = {}): NodePass | ComputePass {
  const doc = parsePassGraph(serializePassGraph(value));
  if (doc.kind === 'post') {
    const slots = compileSurfaceGraph(doc.graph, {
      position: vec3(screenCoordinate, 0),
      worldPosition: vec3(resolution, 1),
      normal: vec3(inputDepth()),
      worldNormal: vec3(time),
      color: inputColor().rgb,
      uv: vec3(screenUV, 0),
    });
    return new NodePass(vec4(slots.colorNode?.rgb ?? vec3(0), slots.opacityNode ?? inputColor().a), {
      kind: doc.colorSpace,
    });
  }
  const c = doc.compute!,
    count = c.size.reduce((a, b) => a * b, 1),
    target = resource(resources, c.target, count),
    source = c.source ? resource(resources, c.source, count) : undefined;
  return new ComputePass(c.size, (i) => {
    const slots = compileSurfaceGraph(doc.graph, {
      position: globalId.toFloat(),
      worldPosition: workgroupId.toFloat(),
      normal: localId.toFloat(),
      worldNormal: vec3(time),
      color: source ? read(source, i).rgb : vec3(0),
      uv: globalId
        .toFloat()
        .add(0.5)
        .div(vec3(...c.size)) as Node<'vec3f'>,
    });
    const value = vec4(slots.colorNode?.rgb ?? vec3(0), slots.opacityNode ?? (source ? read(source, i).a : 1));
    if (target instanceof StorageBuffer) return target.store(i, value);
    return target.store(target.coord(i) as never, value);
  });
}
/** Options for the shared NodeEditor canvas in post/compute mode. */
export interface PassNodeEditorOptions {
  /** Initial document; default a post graph that copies screen colour. */
  document?: PassGraph;
  /** Named, borrowed sources and targets, default none. */
  resources?: PassGraphResources;
  /** Default false. */
  readOnly?: boolean;
  /** Dispose the editor when aborted. */
  signal?: AbortSignal;
}
const palette = (kind: PassGraph['kind']): EditorOperation[] => {
  const labels =
    kind === 'post'
      ? ['Pixel position', 'Resolution', 'Scene depth', 'Time', 'Screen colour', 'Screen UV']
      : ['Invocation position', 'Workgroup position', 'Local position', 'Time', 'Source value', 'Normalized position'];
  return inputNames.map((op, i) => ({
    op,
    label: labels[i],
    group: 'Input',
    description: labels[i] + ' as a three-component value.',
  }));
};
/** Post and procedural compute authoring using NodeEditor's wiring, palette, undo, layout and code preview. */
export class PassNodeEditor {
  private view!: NodeEditor;
  private doc: PassGraph;
  private readonly resources: PassGraphResources;
  private readonly listeners = new Set<(doc: PassGraph) => void>();
  private stopped = false;
  private stop?: () => void;
  private abort?: () => void;
  constructor(
    private readonly parent: HTMLElement,
    private readonly options: PassNodeEditorOptions = {},
  ) {
    this.doc = parsePassGraph(serializePassGraph(options.document ?? defaults()));
    this.resources = options.resources ?? {};
    this.mount();
    if (options.signal) {
      const dispose = () => this.dispose();
      options.signal.addEventListener('abort', dispose, { once: true });
      this.abort = () => options.signal!.removeEventListener('abort', dispose);
      if (options.signal.aborted) this.dispose();
    }
  }
  private live(): void {
    if (this.stopped) throw new MargoError('disposed', 'Create a new PassNodeEditor after disposal');
  }
  private mount(): void {
    const settings = this.doc;
    compilePassGraph(settings, this.resources).dispose();
    this.view = new NodeEditor(this.parent, {
      graph: settings.graph,
      layout: settings.layout,
      readOnly: this.options.readOnly,
      presentation: {
        title: settings.kind === 'post' ? 'Post output' : 'Compute output',
        fallback: false,
        operations: palette(settings.kind),
        outputs: [
          { slot: 'color', label: 'Colour', type: 'vec3f' },
          { slot: 'opacity', label: 'Alpha', type: 'f32' },
        ],
        code: (graph) => {
          const pass = compilePassGraph({ ...settings, graph }, this.resources);
          return pass instanceof NodePass ? pass.code() : pass.code;
        },
      },
    });
    this.stop = this.view.onGraph(() => {
      for (const listener of this.listeners) listener(this.document);
    });
  }
  /** The existing canvas and model, including keyboard shortcuts and undo/redo. */
  get editor(): NodeEditor {
    this.live();
    return this.view;
  }
  /** Independent validated document with the current layout. */
  get document(): PassGraph {
    this.live();
    return parsePassGraph(serializePassGraph({ ...this.doc, graph: this.view.graph, layout: this.view.layout }));
  }
  /** Save graph, pass settings and positions; contains names rather than GPU handles. */
  save(): string {
    return serializePassGraph(this.document);
  }
  /** Validate and replace the document; failed loads keep the existing canvas and pass. */
  load(value: string | PassGraph): void {
    this.live();
    if (this.options.readOnly)
      throw new MargoError('state', 'Create an editable PassNodeEditor to load another document');
    const next = typeof value === 'string' ? parsePassGraph(value) : parsePassGraph(serializePassGraph(value));
    compilePassGraph(next, this.resources).dispose();
    this.stop?.();
    this.view.dispose();
    this.doc = next;
    this.mount();
  }
  /** Called immediately and on valid graph edits, for live pass replacement; moves do not recompile. */
  onGraph(listener: (doc: PassGraph) => void): () => void {
    this.live();
    this.listeners.add(listener);
    listener(this.document);
    return () => this.listeners.delete(listener);
  }
  /** Build a pass from the current valid document; the caller owns that pass. */
  compile(): NodePass | ComputePass {
    return compilePassGraph(this.document, this.resources);
  }
  /** Remove the canvas and listeners; borrowed GPU resources stay alive. */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort?.();
    this.stop?.();
    this.view.dispose();
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
