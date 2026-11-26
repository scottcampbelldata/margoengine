import { MargoError } from '@margoengine/math/errors';
import type { PhysicsBody } from './body.js';
import { checkVec, rotateVec, type Vec3 } from './math.js';
import type { CellMaterial, SoftBodies, SoftBody, SoftBodyDesc } from './soft.js';
import type { SolverHost, StepContext } from './world/solver.js';
import { BODIES_FIELD, BODY_WORDS } from './world/solvers/rigid.js';
import { SoftSolver, type SoftSolverParams } from './world/solvers/soft.js';

/** One tissue vertex coupled to a fixed or kinematic skeletal body. */
export interface TissueBoneBinding {
  readonly tissue: SoftBody;
  readonly particle: number;
  /** Fixed or kinematic bone proxy published by the world's rigid solver. */
  readonly bone: PhysicsBody;
  /** Attachment position relative to the bone origin, in metres. */
  readonly localPoint: Vec3;
  /** If supplied, the particle can slide tangentially on a compliant bone-local plane. */
  readonly sliding?: {
    readonly localNormal: Vec3;
    /** Normal stiffness in N/m. */
    readonly stiffness: number;
    /** Normal damping in N·s/m. Defaults to local critical damping. */
    readonly damping?: number;
  };
}

export interface TissueSolverParams extends SoftSolverParams {
  readonly bindings: readonly TissueBoneBinding[];
  /** Length of a PhysicsWorld origin cell, in metres. Defaults to 4096. */
  readonly cellSize?: number;
}

export type TissueLayer = 'muscle' | 'fat' | 'skin';

export interface TissueLayers {
  /** One anatomical label for each tetrahedron in the description. */
  readonly cells: readonly TissueLayer[];
  /** Passive material for each label present in cells. */
  readonly materials: Readonly<Partial<Record<TissueLayer, CellMaterial>>>;
}

/** Create one conforming tetrahedral body with separate muscle, fat and skin materials. */
export function createLayeredTissue(soft: SoftBodies, desc: SoftBodyDesc, layers: TissueLayers): SoftBody {
  if (!layers || !Array.isArray(layers.cells) || !layers.materials)
    throw new MargoError('state', 'Layered tissue needs cell labels and materials. Supply one label and its material.');
  const materials = Array.from(layers.cells, (layer: TissueLayer) => {
    const material = layer === 'muscle' || layer === 'fat' || layer === 'skin' ? layers.materials[layer] : undefined;
    if (!material)
      throw new MargoError('state', 'A tissue cell lacks a layer material. Supply its muscle, fat or skin material.');
    return material;
  });
  return soft.create(desc.setCellMaterials(materials));
}

type Binding = Omit<TissueBoneBinding, 'sliding'> & {
  readonly sliding?: { readonly localNormal: Vec3; readonly stiffness: number; readonly damping: number };
};

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaled = (a: Vec3, value: number): Vec3 => [a[0] * value, a[1] * value, a[2] * value];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const read = (words: Float32Array, at: number): Vec3 => [words[at]!, words[at + 1]!, words[at + 2]!];

function validateBinding(binding: TissueBoneBinding, soft: SoftBodies, rows: number): Binding {
  const { tissue, particle, bone, localPoint, sliding } = binding;
  if (!tissue?.belongsTo(soft) || tissue.numCells() === 0)
    throw new MargoError(
      'state',
      'Tissue binding needs a live tetrahedral body in its SoftBodies. Create the body in the supplied soft world.',
    );
  if (!Number.isSafeInteger(particle) || particle < 0 || particle >= tissue.particles)
    throw new MargoError('state', 'Tissue binding needs an existing particle index. Choose a particle in the body.');
  if (!bone?.valid || bone.type === 'dynamic' || bone.row >= rows || !soft.ownsTissueBone(bone))
    throw new MargoError(
      'state',
      'Tissue binding needs a fixed or kinematic bone in the same physics world. Add a bone to the supplied rigid physics.',
    );
  checkVec(localPoint, 'Tissue bone position');
  const base = { tissue, particle, bone, localPoint: [...localPoint] as Vec3 };
  if (!sliding) return base;
  checkVec(sliding.localNormal, 'Tissue sliding normal');
  const normal = Math.sqrt(dot(sliding.localNormal, sliding.localNormal));
  const { stiffness } = sliding;
  const damping = sliding.damping ?? 2 * Math.sqrt(tissue.masses[particle]! * stiffness);
  if (
    !(
      normal > 0 &&
      Number.isFinite(normal) &&
      stiffness > 0 &&
      Number.isFinite(stiffness) &&
      damping >= 0 &&
      Number.isFinite(damping)
    )
  )
    throw new MargoError(
      'state',
      'Tissue sliding needs a nonzero normal, positive stiffness and nonnegative damping. Set finite local plane values.',
    );
  return { ...base, sliding: { localNormal: scaled(sliding.localNormal, 1 / normal), stiffness, damping } };
}

/** A soft solver with kinematic tissue insertions and normal-only sliding skin attachments. */
export class TissueSolver extends SoftSolver {
  private bindings: readonly Binding[] = [];
  private memory: WebAssembly.Memory | null = null;
  private cellSize = 4096;

  constructor(id = 'tissue') {
    super(id);
  }

  override init(host: SolverHost, params: TissueSolverParams): void {
    if (!params?.soft || !Array.isArray(params.bindings))
      throw new MargoError('state', 'Tissue needs SoftBodies and a list of bindings. Supply both to the solver.');
    const cellSize = params.cellSize ?? 4096;
    if (!(cellSize > 0 && Number.isFinite(cellSize)))
      throw new MargoError(
        'state',
        'The tissue origin cell needs a finite positive width. Use the world cell size in metres.',
      );
    const rows = host.bodyRows();
    const bindings = params.bindings.map((binding) => validateBinding(binding, params.soft, rows));
    const particles = new Map<SoftBody, Set<number>>();
    for (const { tissue, particle } of bindings) {
      const seen = particles.get(tissue) ?? new Set<number>();
      if (seen.has(particle))
        throw new MargoError(
          'state',
          'A tissue particle can bind to one bone. Give each binding a different particle.',
        );
      seen.add(particle);
      particles.set(tissue, seen);
    }
    super.init(host, params);
    for (const { tissue, particle, sliding } of bindings) tissue.setParticlePinned(particle, !sliding);
    this.bindings = bindings;
    this.memory = host.memory;
    this.cellSize = cellSize;
  }

  override step(context: StepContext, dt: number): void {
    const port = context.inputs.get(BODIES_FIELD.name);
    if (this.bindings.length && (!port || port.region.type !== 'f32' || port.region.layout !== 2 || !this.memory))
      throw new MargoError(
        'state',
        'Tissue needs the layout-2 bodies port from RigidSolver. Add the rigid solver to the same world.',
      );
    if (port && this.memory) {
      const { region } = port;
      const words = new Float32Array((region.memory ?? this.memory).buffer, region.byteOffset, region.byteLength / 4);
      const offset = scaled(sub(port.cell, context.cell), this.cellSize);
      for (const { tissue, bone } of this.bindings) {
        if (!tissue.valid) continue;
        const at = bone.row * BODY_WORDS;
        if (!bone.valid || bone.type === 'dynamic' || words[at + 23] !== 0)
          throw new MargoError(
            'state',
            'Tissue bones must remain fixed or kinematic. Rebuild the tissue solver with its current skeletal bodies.',
          );
      }
      for (const binding of this.bindings) this.applyBinding(binding, words, offset, dt);
    }
    super.step(context, dt);
  }

  private applyBinding(binding: Binding, words: Float32Array, offset: Vec3, dt: number): void {
    const { tissue, particle, bone, localPoint, sliding } = binding;
    if (!tissue.valid) return;
    const at = bone.row * BODY_WORDS;
    const rotation = [words[at + 3]!, words[at + 4]!, words[at + 5]!, words[at + 6]!];
    if (!(rotation.some((value) => value !== 0) && rotation.every(Number.isFinite)))
      throw new MargoError(
        'state',
        'Tissue bone has no valid rotation in the bodies field. Publish the attached rigid world before tissue steps.',
      );
    const anchor = add(read(words, at), rotateVec(rotation, localPoint));
    const position = add(anchor, offset);
    if (!sliding) {
      tissue.setParticleKinematicTarget(particle, position);
      return;
    }
    const normal = rotateVec(rotation, sliding.localNormal);
    const current = tissue.particlePosition(particle);
    const center = add(read(words, at + 7), offset);
    const velocity = add(read(words, at + 10), cross(read(words, at + 13), sub(current, center)));
    const distance = dot(normal, sub(current, position));
    const speed = dot(normal, sub(tissue.particleVelocity(particle), velocity));
    const rate = sliding.damping + dt * sliding.stiffness;
    // Backward Euler on the normal spring and dashpot, with the target moving at its published velocity.
    const impulse =
      (-dt * (sliding.stiffness * distance + rate * speed)) / (1 + (dt * rate) / tissue.masses[particle]!);
    tissue.applyParticleImpulse(particle, scaled(normal, impulse));
  }
}
