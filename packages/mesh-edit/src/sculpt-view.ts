// @margoengine/mesh-edit/sculpt-view: draws a sculpt session with gltf-pro and keeps it up to date. Each frame uploads only
// the vertices the brush changed; triangles changing (dynamic topology, or an undo of it) rewrite the whole mesh.
import type { Engine, EnginePlugin } from '@margoengine/core';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import type { MeshSculptSession, SculptDrawing } from './sculpt.js';

/** Options for {@link SculptView}. */
export interface SculptViewOptions {
  /** A glTF material for the surface. Default a matte clay. */
  material?: Record<string, unknown>;
}

const CLAY = { pbrMetallicRoughness: { baseColorFactor: [0.72, 0.66, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.6 } };

let serial = 0;

/**
 * Draws a {@link MeshSculptSession} and follows it every frame.
 *
 * ```ts
 * const view = SculptView.attach(engine, session);
 * view.model.root.setPosition([0, 1, 0]);
 * ```
 */
export class SculptView implements EnginePlugin {
  readonly name = 'sculpt-view:' + serial++;
  /** The mesh being drawn. The view owns it: dispose the view, not the model. */
  readonly model: PBRModel;
  /** Vertices uploaded by ranges, and whole-mesh rewrites, since the view was made. */
  readonly stats = { uploadedVertices: 0, rewrites: 0 };

  #drawing: SculptDrawing;
  #disposed = false;

  /** Draws `session` in `engine`. @throws RangeError when the mesh is over gltf-pro's 1,000,000 vertices per primitive. */
  static attach(engine: Engine, session: MeshSculptSession, options: SculptViewOptions = {}): SculptView {
    return new this(engine, session, options);
  }

  constructor(engine: Engine, session: MeshSculptSession, options: SculptViewOptions = {}) {
    this.#drawing = session.drawing();
    this.#drawing.update();
    const { vertices, indices } = this.#drawing;
    this.model = new PBRModel(
      engine,
      new GLTFAsset(
        {
          asset: { version: '2.0' },
          materials: [options.material ?? CLAY],
          meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
          nodes: [{ mesh: 0 }],
        },
        [],
      ),
      [],
      [[{ vertices, indices }]],
    );
    engine.use(this.model);
    engine.use(this);
  }

  setup(): void {}

  /** Uploads what changed. The engine calls this before each frame; call it yourself to upload sooner. */
  onPreUpdate(): void {
    if (this.#disposed) return;
    const change = this.#drawing.update(),
      { vertices, indices } = this.#drawing,
      geometry = [{ vertices, indices }];
    if (change === 'all') {
      this.model.writeGeometry(geometry);
      this.stats.rewrites++;
      return;
    }
    for (const range of change) {
      this.model.writeGeometry(geometry, range);
      this.stats.uploadedVertices += range.count;
    }
  }

  /** Removes the mesh from the scene. The session stays usable. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.model.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
