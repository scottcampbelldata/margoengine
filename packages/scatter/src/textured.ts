/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { PBRModel, PBRPrimitive, PBRRenderState } from '@margoengine/gltf-pro/model';
import { PBRInstances } from '@margoengine/gltf-pro/instancing';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';

interface Part {
  primitive: PBRPrimitive;
  original?: PBRInstances;
  rows: PBRInstances;
  relative: Float64Array;
  inverse: Float64Array;
  copies: number;
}
const owners = new WeakSet<PBRModel>();
let serial = 0;

/**
 * Copies a whole glTF plant in model-root space, retaining its node hierarchy, textures, normal maps, material
 * extensions and MASK shadow casters. MASK beauty passes use alpha-to-coverage on multisampled targets; single-sample
 * colour and shadow maps use the authored cutoff. The existing PBR renderer owns every draw and device restoration.
 * Dispose this attachment to restore the model's original instances and material states; the model remains caller-owned.
 */
export class TexturedScatter implements EnginePlugin {
  readonly name = 'scatter:textured:' + ++serial;
  readonly model: PBRModel;
  readonly count: number;
  disposed = false;
  private readonly engine: Engine;
  private readonly parts: Part[] = [];
  private readonly matrices: Float32Array;
  private readonly states = new Map<PBRPrimitive['material'], { before?: PBRRenderState; after: PBRRenderState }>();

  /**
   * Attach with {@link TexturedScatter.attach}; matrices are affine column-major placements relative to model.root.
   * @throws RangeError for malformed, singular, non-f32 matrices or more than 1,000,000 expanded instances per node.
   * @throws MargoError for a disposed model or one already owned by another TexturedScatter.
   */
  constructor(engine: EngineKernel, model: PBRModel, transforms: Float32Array) {
    this.engine = engineRuntime(engine);
    this.model = model;
    if (model.root.engine !== this.engine)
      throw new TypeError('Use a model loaded into the same engine as the textured scatter.');
    if (model.disposed || owners.has(model))
      throw new MargoError(
        'failed',
        'Use a live model without another TexturedScatter; dispose its attachment first. See https://margoengine.com/errors#failed',
      );
    if (!(transforms instanceof Float32Array) || transforms.length % 16 || transforms.length > 16_000_000)
      throw new RangeError('Pass a Float32Array of 16-float affine placements, at most 1000000 instances.');
    this.count = transforms.length / 16;
    this.matrices = transforms.slice();
    // Validate all placements before changing the model or allocating expanded instance sets.
    const check = new PBRInstances(1);
    for (let i = 0; i < this.count; i++) this.validate(i, transforms.subarray(i * 16, i * 16 + 16), check);
    this.engine.store.tick(false);
    const rootInverse = invertMatrix(model.root.matrix);
    if (!rootInverse) throw new RangeError('Use an invertible model root before attaching textured scatter.');
    try {
      for (const primitive of model.primitives) {
        const original = primitive.instances,
          copies = original?.count ?? 1;
        const relative = multiplyMatrices(rootInverse, primitive.node.matrix),
          inverse = invertMatrix(relative);
        if (!inverse) throw new RangeError('Use invertible plant node transforms before attaching textured scatter.');
        const rows = new PBRInstances(Math.max(1, this.count * copies));
        rows.count = this.count * copies;
        this.parts.push({ primitive, original, copies, rows, relative, inverse });
      }
      for (let i = 0; i < this.count; i++) this.write(i);
      for (const part of this.parts) {
        const material = part.primitive.material;
        if (material.settings[0] === 1 && !this.states.has(material)) {
          const before = material.renderState,
            after = { ...before, alphaToCoverage: true };
          this.states.set(material, { before, after });
        }
      }
      for (const part of this.parts) part.primitive.instances = part.rows;
      for (const [material, state] of this.states) material.renderState = state.after;
      owners.add(model);
    } catch (error) {
      for (const part of this.parts) part.rows.dispose();
      throw error;
    }
  }

  /** Installs the attachment in the engine so engine disposal also releases its instance buffers. */
  static attach(engine: EngineKernel, model: PBRModel, transforms: Float32Array): TexturedScatter {
    const scatter = new TexturedScatter(engine, model, transforms);
    engineRuntime(engine).use(scatter);
    return scatter;
  }

  /** The model owns rendering; setup only checks that this attachment stays on its original engine. */
  setup(engine: Engine): void {
    if (engine !== this.engine || this.disposed)
      throw new MargoError(
        'failed',
        'Use the original live engine for textured scatter; see https://margoengine.com/errors#failed',
      );
  }

  private validate(index: number, matrix: ArrayLike<number>, check = new PBRInstances(1)): void {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        'Create a new TexturedScatter after disposal; see https://margoengine.com/errors#disposed',
      );
    if (!Number.isInteger(index) || index < 0 || index >= this.count)
      throw new RangeError('Use a placement index from 0 to count - 1.');
    check.setMatrixAt(0, matrix);
    if (!invertMatrix(check.data.subarray(0, 16))) throw new RangeError('Use a nonsingular affine scatter placement.');
  }

  /** Changes one whole-plant placement, updating every primitive and preserving embedded glTF instances. */
  setMatrixAt(index: number, matrix: ArrayLike<number>): this {
    this.validate(index, matrix);
    this.matrices.set(Array.from(matrix), index * 16);
    this.write(index);
    return this;
  }

  /** Returns a copy of one placement in model-root space. */
  getMatrixAt(index: number): Float32Array {
    if (!Number.isInteger(index) || index < 0 || index >= this.count)
      throw new RangeError('Use a placement index from 0 to count - 1.');
    return this.matrices.slice(index * 16, index * 16 + 16);
  }

  private write(index: number): void {
    const placement = this.matrices.subarray(index * 16, index * 16 + 16);
    for (const p of this.parts) {
      // N * (S^-1 * T * S) = root * T * S. A multi-node plant keeps its authored offsets under every placement.
      const left = multiplyMatrices(p.inverse, placement),
        local = multiplyMatrices(left, p.relative);
      // Affine conjugation has the exact last row (0,0,0,1). General 4x4 inversion can round its 1 a few ulps away.
      local[3] = local[7] = local[11] = 0;
      local[15] = 1;
      for (let j = 0; j < p.copies; j++) {
        const at = index * p.copies + j;
        p.rows.setMatrixAt(at, p.original ? multiplyMatrices(local, p.original.getMatrixAt(j)) : local);
        if (p.original) p.rows.data.set(p.original.data.subarray(j * 24 + 16, j * 24 + 24), at * 24 + 16);
      }
    }
  }

  /** Restores the original model without disposing its meshes, textures or original instance sets. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.removePlugin(this.name);
    for (const p of this.parts) {
      if (p.primitive.instances === p.rows) p.primitive.instances = p.original;
      p.rows.dispose();
    }
    for (const [material, state] of this.states)
      if (material.renderState === state.after) material.renderState = state.before;
    owners.delete(this.model);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
