/// <reference lib="esnext.disposable" preserve="true" />
// One debug view for a physics world (`@margoengine/physics/debug-view`): the world's own debug lines (colliders, joints,
// contacts, boxes, axes, solver contacts, pseudo-normals) and any number of other sources that give line segments (a
// character controller, a ragdoll, a breakable, water, a flock), merged into one buffer and drawn as one segment line of
// `@margoengine/lines`, which it loads only when attached. Our own design; no engine's source was read.
import type { EngineKernel, EnginePlugin } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { sceneScope } from '../../shared/scene-scope.js';
import type { DebugLines, DebugRenderOptions } from './debug.js';
import type { Physics } from './physics.js';

/** Anything that gives debug line segments: an object with `debugRender()`, or a function returning the lines. */
export type DebugSource = { debugRender(): DebugLines } | (() => DebugLines);

/** Where the view sends its lines each frame instead of `@margoengine/lines` (a custom renderer, a WebGL2 preview, a test). */
export interface DebugLineSink {
  /** Takes the merged lines of the frame: `vertices` x, y, z per vertex, two vertices a segment, `colors` r, g, b, a per vertex. */
  update(lines: DebugLines): void;
}

/** Options of {@link PhysicsDebugView}; every field has a default. */
export interface PhysicsDebugViewOptions {
  /** Draw at all (default true). Also a live field of the view. */
  enabled?: boolean;
  /** What of the world to draw, as `physics.debugRender(options)` takes it, or false for none of it (default `{}`: colliders, joints and contacts). */
  world?: DebugRenderOptions | false;
  /** A cross at each dynamic body's centre of mass (default false). */
  centerOfMass?: boolean;
  /** Plugin name, unique in the scene (default `'physics-debug-view'`). */
  name?: string;
  /** Line width in CSS pixels (default 1.5). */
  width?: number;
  /** Draw over the scene, without the depth test (default false). */
  onTop?: boolean;
  /** Send the lines here each frame and load no `@margoengine/lines` (default none). */
  sink?: DebugLineSink;
}

const HELP = 'See https://margoengine.com/errors#physics-debug-view';
const fail = (message: string, code: 'state' | 'unsupported' | 'disposed' | 'attached' = 'unsupported') =>
  new MargoError(code, `${message} ${HELP}`);
const EMPTY: DebugLines = { vertices: new Float32Array(0), colors: new Float32Array(0) };
const GOLD = [1, 0.85, 0.2, 1] as const;

/** Joins line buffers into one, in order. */
function merge(chunks: readonly DebugLines[]): DebugLines {
  let v = 0,
    c = 0;
  for (const chunk of chunks) {
    v += chunk.vertices.length;
    c += chunk.colors.length;
  }
  const vertices = new Float32Array(v),
    colors = new Float32Array(c);
  v = c = 0;
  for (const chunk of chunks) {
    vertices.set(chunk.vertices, v);
    colors.set(chunk.colors, c);
    v += chunk.vertices.length;
    c += chunk.colors.length;
  }
  return { vertices, colors };
}

interface LineLike {
  visible: boolean;
  setPositions(positions: ArrayLike<number>, colors?: ArrayLike<number> | null): unknown;
}
interface LinesHost extends EnginePlugin {
  add(line: LineLike): unknown;
  remove(line: LineLike): unknown;
}

/**
 * The shared debug view of a physics world. `await PhysicsDebugView.attach(engine, physics)` draws the world's colliders,
 * joints and contacts every frame after the step; `add(source)` draws any other source of debug lines with them (a
 * `CharacterController`, a `DynamicCharacter`, a `Ragdoll`, or any `{debugRender()}`). `new PhysicsDebugView(physics)`
 * without an engine gives the same lines from `collect()`, for a test or your own renderer.
 */
export class PhysicsDebugView implements EnginePlugin {
  /** Plugin name in the scene. */
  readonly name: string;
  /** Updated after the plugins that are not late, and after `Physics` when attached after it, so it shows this frame's step. */
  readonly late = true;
  /** Draw at all. Off, the line is hidden and nothing is collected. */
  enabled: boolean;
  /** What of the world to draw (`physics.debugRender` options), or false for none of it. */
  world: DebugRenderOptions | false;
  /** A cross at each dynamic body's centre of mass. */
  centerOfMass: boolean;
  private readonly sources = new Set<DebugSource>();
  private readonly sink: DebugLineSink | null;
  private line: LineLike | null = null;
  private host: LinesHost | null = null;
  private ownsHost = false;
  private engine: EngineKernel | null = null;
  private last: DebugLines = EMPTY;
  private disposed = false;

  /**
   * A view of `physics` that is not drawn: `collect()` gives its lines. Use {@link PhysicsDebugView.attach} to draw it.
   * @throws MargoError (`state`) when `physics` is disposed; (`unsupported`) for a width that is not a positive number.
   */
  constructor(
    readonly physics: Physics,
    options: PhysicsDebugViewOptions = {},
  ) {
    if (typeof physics?.debugRender !== 'function')
      throw fail('PhysicsDebugView needs a Physics world: new PhysicsDebugView(physics).');
    if (physics.isDisposed)
      throw fail('PhysicsDebugView was given a disposed Physics world; pass a live one.', 'state');
    this.name = options.name ?? 'physics-debug-view';
    if (typeof this.name !== 'string' || !this.name)
      throw fail('PhysicsDebugView name must be a non-empty string; leave it out for the default.');
    const width = options.width ?? 1.5;
    if (!(width > 0) || !Number.isFinite(width))
      throw fail(`PhysicsDebugView width must be a positive number of CSS pixels (got ${width}).`);
    this.width = width;
    this.onTop = options.onTop ?? false;
    this.enabled = options.enabled ?? true;
    this.world = options.world ?? {};
    this.centerOfMass = options.centerOfMass ?? false;
    this.sink = options.sink ?? null;
  }
  private readonly width: number;
  private readonly onTop: boolean;

  /**
   * Draws `physics` in the scene it is attached to: loads `@margoengine/lines` (unless `sink` is given), adds one segment
   * line to the scene's `Lines` plugin (creating it when there is none) and attaches the view as a plugin after `Physics`.
   * @throws MargoError (`state`) when `physics` is not attached to `engine`; (`attached`) when the scene already has a plugin of
   * this name; the import's own error when `@margoengine/lines` cannot be loaded.
   */
  static async attach(
    engine: EngineKernel,
    physics: Physics,
    options: PhysicsDebugViewOptions = {},
  ): Promise<PhysicsDebugView> {
    const view = new PhysicsDebugView(physics, options),
      scene = engine?.sceneOf?.(physics);
    if (!scene)
      throw fail(
        'PhysicsDebugView.attach needs the engine Physics is attached to: new Physics(engine), then attach(engine, physics).',
        'state',
      );
    if (scene.plugins.has(view.name))
      throw fail(`The scene already has a plugin named "${view.name}"; dispose it or pass another name.`, 'attached');
    const lines = view.sink ? null : await import('@margoengine/lines');
    if (physics.isDisposed)
      throw fail('Physics was disposed while the debug view loaded; attach to a live world.', 'state');
    sceneScope(engine, scene).run(() => {
      if (lines) {
        const existing = scene.plugins.get('lines');
        view.host = existing instanceof lines.Lines ? existing : null;
        if (!view.host) {
          view.host = lines.Lines.attach(engine);
          view.ownsHost = true;
        }
        view.line = new lines.Line({ mode: 'segments', width: view.width, onTop: view.onTop, visible: false });
        view.host.add(view.line);
      }
      engine.use(view);
    });
    return view;
  }

  /** Draws `source` with the world from now on. Returns a function that stops drawing it. */
  add(source: DebugSource): () => void {
    this.live();
    if (typeof source !== 'function' && typeof source?.debugRender !== 'function')
      throw fail('A debug source is an object with debugRender() or a function returning {vertices, colors}.');
    this.sources.add(source);
    return () => void this.sources.delete(source);
  }

  /** The lines of the last `collect()` (or frame). */
  get latest(): DebugLines {
    return this.last;
  }

  /** Collects the world's lines and every source's, merged in that order. Empty while not `enabled`. */
  collect(): DebugLines {
    this.live();
    if (!this.enabled || this.physics.isDisposed) return (this.last = EMPTY);
    const chunks: DebugLines[] = [];
    if (this.world) chunks.push(this.physics.debugRender(this.world));
    if (this.centerOfMass) {
      const vertices: number[] = [];
      for (const body of this.physics.getBodies())
        if (body.valid && body.type === 'dynamic') {
          const [x, y, z] = body.worldCenterOfMass;
          vertices.push(x - 0.08, y, z, x + 0.08, y, z, x, y - 0.08, z, x, y + 0.08, z, x, y, z - 0.08, x, y, z + 0.08);
        }
      const colors = new Float32Array((vertices.length / 3) * 4);
      for (let i = 0; i < colors.length; i += 4) colors.set(GOLD, i);
      chunks.push({ vertices: new Float32Array(vertices), colors });
    }
    for (const source of this.sources) chunks.push(typeof source === 'function' ? source() : source.debugRender());
    return (this.last = merge(chunks));
  }

  /** @internal Engine plugin hook. */
  setup(engine: EngineKernel): void {
    this.live();
    this.engine = engine;
  }

  /** @internal Each frame, after the step: collects and draws. */
  onPreUpdate(): void {
    if (this.disposed) return;
    const lines = this.collect();
    this.sink?.update(lines);
    if (this.line) {
      this.line.visible = lines.vertices.length > 0;
      if (this.line.visible) this.line.setPositions(lines.vertices, lines.colors);
    }
  }

  private live(): void {
    if (this.disposed) throw fail('PhysicsDebugView is disposed; attach a new one.', 'disposed');
  }

  /** Removes its line (and the `Lines` plugin when it made it) and leaves its scene. Safe to call twice; `using` works. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sources.clear();
    if (this.line) this.host?.remove(this.line);
    const engine = this.engine;
    if (engine) {
      if (this.ownsHost && this.host) engine.sceneOf(this.host)?.removePlugin(this.host.name);
      engine.sceneOf(this)?.removePlugin(this.name);
    }
    this.line = this.host = this.engine = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
