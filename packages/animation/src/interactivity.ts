// KHR_interactivity on a rendered model. @margoengine/gltf-pro/interactivity holds the graph and the object model; this entry
// reaches the engine: it ticks the graph with the frame loop, writes properties to the live model, plays the file's
// animations and turns pointer input into select and hover events. It lives here because this package already sees gltf-pro.
import { MargoError } from '@margoengine/math/errors';
import { screenToWorld } from '@margoengine/math/project';
import { rotationToQuaternion } from '@margoengine/math/quat';
import { Ray } from '@margoengine/math/ray';
import { Vector3 } from '@margoengine/math/vector3';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf-pro';
import type { GLTFPhysics } from '@margoengine/gltf-pro/physics';
import {
  loadBehaviorGraph,
  type ActiveCamera,
  type BehaviorGraph,
  type BehaviorGraphOptions,
  type GraphPhysics,
  type GraphValue,
} from '@margoengine/gltf-pro/interactivity';
import { Animation } from './index.js';
import { pointerChannels, pointerWriter } from './pointer.js';
import { sampleTrackInto, type Interpolation } from './sampling.js';

/** Options of {@link GLTFInteractivity}. */
export interface GLTFInteractivityOptions extends Pick<BehaviorGraphOptions, 'log' | 'maxActivations' | 'maxEventsPerTick'> {
  /** Runs the file's `rigid_body/*` operations and trigger events. Default: they do nothing. */
  physics?: GLTFPhysics;
  /** Reports the viewer's camera under `activeCamera`. Default true; false reads as NaN, for privacy. */
  shareCamera?: boolean;
  /**
   * Turns pointer input on the canvas into select and hover events. Default true, for a graph with such events; it attaches
   * `Picking` of `@margoengine/selection`, loaded on first use, unless the engine has a picker. It stays attached afterwards.
   */
  pointer?: boolean;
}

/** Samples one flattened animation channel, for `sample` of `loadBehaviorGraph`. */
export function sampleChannel(
  channel: { times: Float32Array; values: Float32Array; width: number; interpolation: Interpolation },
  time: number,
): number[] {
  const { times, values, width, interpolation } = channel;
  return Array.from(sampleTrackInto(times, values, width, time, interpolation, width === 4 && interpolation !== 'STEP'));
}

interface Hit {
  node: number;
  distance: number;
  point: number[];
}
type Point = { x: number; y: number; z: number };
const between = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Vertex `i` of a picking snapshot in world space. Its vertices hold 20 floats, position first. */
function worldVertex(vertices: Float32Array, i: number, m: ArrayLike<number>): Point {
  const x = vertices[i * 20],
    y = vertices[i * 20 + 1],
    z = vertices[i * 20 + 2];
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12],
    y: m[1] * x + m[5] * y + m[9] * z + m[13],
    z: m[2] * x + m[6] * y + m[10] * z + m[14],
  };
}

let serial = 0;
const flags = /\/extensions\/KHR_node_(selectability|hoverability)\//;
const physicsPointer = /KHR_physics_rigid_bodies/;

/**
 * Runs the behaviour graph a model's file carries. The graph starts on the next frame, plays the file's animations itself,
 * so do not also play them with `Animation`, and clicks and hovers on the canvas reach its `event/onSelect`,
 * `event/onHoverIn` and `event/onHoverOut` nodes. A file the specification rejects leaves `graph` undefined and says why in
 * `rejected`; the model still draws.
 *
 * @example
 * const model = await loadGLTF(engine, '/product.glb');
 * const behaviour = GLTFInteractivity.attach(model);
 * behaviour.graph?.on('checkout', ({variant}) => console.log(variant));
 */
export class GLTFInteractivity implements EnginePlugin {
  readonly name = 'gltf-interactivity:' + serial++;
  /** The running graph; undefined when the file has none or it was rejected. */
  readonly graph?: BehaviorGraph;
  /** Why the file's graph must not run, when it was rejected. */
  readonly rejected?: string;
  /** Properties the graph wrote that it can read back but that change nothing on screen, one line each. */
  readonly notes: string[] = [];
  private readonly model: PBRModel;
  private readonly options: GLTFInteractivityOptions;
  private readonly writers = new Map<string, ((value: ArrayLike<number>) => void) | undefined>();
  private readonly nodeOf = new Map<unknown, number>();
  private readonly removers: (() => void)[] = [];
  private engine?: Engine;
  private press?: { x: number; y: number };
  private moved?: { x: number; y: number };
  private picking = false;
  private disposed = false;
  private picker?: Promise<unknown>;

  /** Runs the graph of `model` on the engine that loaded it. */
  static attach(model: PBRModel, options: GLTFInteractivityOptions = {}): GLTFInteractivity {
    const behaviour = new GLTFInteractivity(model, options);
    model.root.engine.use(behaviour);
    return behaviour;
  }

  constructor(model: PBRModel, options: GLTFInteractivityOptions = {}) {
    this.model = model;
    this.options = options;
    const { physics } = options,
      loaded = loadBehaviorGraph(model.asset, {
        ...options,
        sample: sampleChannel,
        physics: physics && graphPhysics(physics),
        live: (pointer, value) => this.write(pointer, value),
        camera: () => (options.shareCamera === false ? undefined : this.camera()),
      });
    this.graph = loaded.graph;
    this.rejected = loaded.rejected;
    model.nodes.forEach((node, i) => this.nodeOf.set(node, i));
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'GLTFInteractivity is disposed; create a new graph before attaching');
    this.engine = engine;
    const { graph } = this,
      doc = this.model.asset.doc as Record<string, any>;
    if (!graph) return;
    // Skins and morph targets deform through Animation, which reads the node and weight values the graph writes.
    if (doc.skins?.length || doc.meshes?.some((m: any) => m.primitives?.some((p: any) => p.targets?.length)))
      Animation.attach(this.model, { pointers: pointerChannels, loop: false }).playing = false;
    if (this.options.physics)
      this.removers.push(
        this.options.physics.onTrigger(({ entered, nodeIndex, colliderNodeIndex, motionNodeIndex }) =>
          graph.trigger(entered ? 'event/rigid_body_triggerEntered' : 'event/rigid_body_triggerExited', nodeIndex, colliderNodeIndex, motionNodeIndex),
        ),
      );
    if (this.options.pointer !== false) this.listen(engine, graph);
  }

  private listen(engine: Engine, graph: BehaviorGraph): void {
    const { canvas } = engine,
      selects = graph.handles('event/onSelect'),
      hovers = graph.handles('event/onHoverIn') || graph.handles('event/onHoverOut');
    if ((selects || hovers) && ![...engine.plugins.values()].some((plugin) => plugin.onPick))
      this.picker = import('@margoengine/selection').then(
        ({ Picking }) => Picking.forEngine(engine) ?? Picking.attach(engine, { capture: false }),
        () => {
          throw new MargoError('unsupported', 'Clicks on a behaviour graph need @margoengine/selection; install it, or pass pointer: false');
        },
      );
    const at = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void) => {
      canvas.addEventListener(type, listener);
      this.removers.push(() => canvas.removeEventListener(type, listener));
    };
    if (selects) {
      on('pointerdown', (event) => (this.press = at(event)));
      on('pointerup', (event) => {
        const point = at(event),
          from = this.press;
        this.press = undefined;
        // A drag moves the camera; only a press that stayed put selects.
        if (from && Math.hypot(point.x - from.x, point.y - from.y) <= 4) void this.select(point);
      });
    }
    if (hovers) {
      on('pointermove', (event) => (this.moved = at(event)));
      on('pointerleave', () => {
        this.moved = undefined;
        graph.hover(undefined);
      });
    }
  }
  private async nodeAt({ x, y }: { x: number; y: number }): Promise<number | undefined> {
    await this.picker;
    const mesh = await this.engine!.pick(x, y);
    return mesh ? this.nodeOf.get(mesh) : undefined;
  }
  /** What the ray through a canvas point crosses on this model, nearest first. Read on a click, so skins are in their pose. */
  private async trace({ x, y }: { x: number; y: number }): Promise<Hit[]> {
    const { camera, canvas } = this.engine!,
      width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height,
      at = (depth: number) => screenToWorld(x, y, depth, camera, width, height, new Vector3())!,
      [ex, ey, ez] = camera.position,
      eye = { x: ex, y: ey, z: ez },
      // Two depths give the line; which is nearer depends on the camera's depth convention.
      [near, far] = [at(0.25), at(0.75)].sort((a, b) => between(a, eye) - between(b, eye)),
      ray = new Ray(near, far.clone().sub(near).normalize()),
      crossing = new Vector3(),
      hits: Hit[] = [];
    for (const { vertices, indices, matrix, nodeIndex } of await this.model.readPickingGeometry()) {
      if (nodeIndex === undefined) continue;
      let distance = Infinity,
        point: number[] = [];
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = worldVertex(vertices, indices[i], matrix),
          b = worldVertex(vertices, indices[i + 1], matrix),
          c = worldVertex(vertices, indices[i + 2], matrix);
        if (!ray.intersectTriangle(a, b, c, false, crossing)) continue;
        const along = between(crossing, near);
        if (along < distance) {
          distance = along;
          point = [crossing.x, crossing.y, crossing.z];
        }
      }
      if (distance < Infinity) hits.push({ node: nodeIndex, distance, point });
    }
    return hits.sort((a, b) => a.distance - b.distance);
  }
  private async select(point: { x: number; y: number }): Promise<void> {
    const node = await this.nodeAt(point);
    if (node === undefined || this.model.disposed) return;
    const origin = [...this.engine!.camera.position],
      hits = await this.trace(point);
    if (this.model.disposed) return;
    // The picker saw this model first; an unselectable node lets the ray on to what is behind it.
    for (const hit of hits) if (this.graph?.select(hit.node, { point: hit.point, origin })) return;
    if (!hits.length) this.graph?.select(node, { origin });
  }
  private async hover(point: { x: number; y: number }): Promise<void> {
    this.picking = true;
    const node = await this.nodeAt(point);
    this.picking = false;
    if (!this.model.disposed) this.graph?.hover(node);
  }

  onPreUpdate(delta: number): void {
    if (this.model.disposed) {
      this.dispose();
      return;
    }
    if (this.moved && !this.picking) {
      const point = this.moved;
      this.moved = undefined;
      void this.hover(point);
    }
    this.graph?.tick(delta);
  }

  private write(pointer: string, value: GraphValue): void {
    if (flags.test(pointer)) return;
    const numbers = typeof value === 'boolean' ? [value ? 1 : 0] : typeof value === 'number' ? [value] : (value as number[]);
    if (physicsPointer.test(pointer)) {
      this.options.physics?.setPointer(pointer, numbers.length === 1 ? numbers[0] : numbers);
      return;
    }
    if (!this.writers.has(pointer)) {
      const writer = pointerWriter(this.model, pointer);
      this.writers.set(pointer, writer);
      if (!writer) this.notes.push(`${pointer} has no effect on the rendered model`);
    }
    this.writers.get(pointer)?.(numbers);
  }

  private camera(): ActiveCamera | undefined {
    const engine = this.engine;
    if (!engine) return undefined;
    const { position, target, up, fov, near, far } = engine.camera,
      unit = (v: number[]) => {
        const length = Math.hypot(...v);
        return v.map((x) => x / length);
      },
      cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
      // A glTF camera looks down its own -Z.
      z = unit(position.map((p, i) => p - target[i])),
      x = unit(cross([...up], z)),
      y = cross(z, x);
    return {
      position: [...position],
      rotation: rotationToQuaternion([...x, 0, ...y, 0, ...z], [0, 0, 0, 0]),
      perspective: {
        aspectRatio: engine.canvas.width / engine.canvas.height,
        yfov: (fov * Math.PI) / 180,
        znear: near,
        zfar: far,
      },
    };
  }

  /** Stops the graph and the input, and leaves the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.removers.splice(0)) remove();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

function graphPhysics(world: GLTFPhysics): GraphPhysics {
  const vec3 = (v: number[]) => v as [number, number, number];
  return {
    applyImpulse(nodeIndex, linear, angular) {
      world.bodyOf(nodeIndex)?.applyImpulse(vec3(linear)).applyTorqueImpulse(vec3(angular));
    },
    applyPointImpulse(nodeIndex, impulse, position) {
      world.bodyOf(nodeIndex)?.applyImpulse(vec3(impulse), vec3(position));
    },
    rayCast(start, end) {
      const direction = end.map((e, i) => e - start[i]),
        length = Math.hypot(...direction);
      if (!length) return undefined;
      const hit = world.physics.raycast(start as [number, number, number], direction as [number, number, number], { maxDistance: length });
      if (!hit) return undefined;
      const nodeIndex = [...world.bodies].find(([, body]) => body === hit.body)?.[0] ?? -1;
      return { nodeIndex, fraction: hit.distance / length, normal: [...hit.normal] };
    },
  };
}
