// The other players as voxel figures: head, body, two arms and two legs, six rows of one instanced unit box per player
// (DynamicInstances: one draw, no core mesh per limb), eight colours by id, limbs that swing with speed. Name tags are
// HTML labels shown within 24 blocks. Nothing here allocates per frame once a player has a slot.
import { box, type EngineKernel, PbrMaterial } from '@margoengine/core';
import { DynamicInstances } from '@margoengine/culling/dynamic';
import { type Label, LabelRenderer } from '@margoengine/labels';

/** Rows of the instanced box per figure. */
export const PARTS = 6;
/** Floats per row of `DynamicInstances.matrices`: the column-major matrix without its last row. */
const ROW = 12;
/** Name tags show within this many blocks of the eye. */
export const TAG_RANGE = 24;

// Linear rgb of each body colour (eight by id), and of the head and hands.
const COLORS: readonly (readonly [number, number, number])[] = [
    [0.78, 0.1, 0.03],
    [0.03, 0.05, 0.21],
    [0.9, 0.39, 0.01],
    [0.13, 0.33, 0.5],
    [0.39, 0.56, 0.18],
    [0.27, 0.2, 0.51],
    [0.67, 0.06, 0.09],
    [0.05, 0.25, 0.01],
  ],
  SKIN = [0.87, 0.6, 0.45] as const,
  TROUSERS = 0.45; // legs: the body colour scaled by this

// x, pivot y, z of each part in figure space (feet at 0, facing -z); size; what swings it (0 none, else its sign).
// The pivot is the part's top: legs swing at the hip, arms at the shoulder. Order: head, body, arms, legs.
const LAYOUT = [
  { x: 0, y: 1.78, width: 0.42, height: 0.42, depth: 0.42, swing: 0 },
  { x: 0, y: 1.36, width: 0.52, height: 0.6, depth: 0.28, swing: 0 },
  { x: -0.35, y: 1.34, width: 0.18, height: 0.58, depth: 0.22, swing: 1 },
  { x: 0.35, y: 1.34, width: 0.18, height: 0.58, depth: 0.22, swing: -1 },
  { x: -0.13, y: 0.76, width: 0.24, height: 0.76, depth: 0.26, swing: -1 },
  { x: 0.13, y: 0.76, width: 0.24, height: 0.76, depth: 0.26, swing: 1 },
] as const;

/**
 * Writes one figure's {@link PARTS} rows into `out` from row `row`. `swing` is the limb angle in radians. Pure, and it
 * allocates nothing.
 */
export function writeFigure(
  out: Float32Array,
  row: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  swing: number,
): void {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  for (let i = 0; i < PARTS; i++) {
    const part = LAYOUT[i],
      angle = swing * part.swing,
      ca = Math.cos(angle),
      sa = Math.sin(angle),
      half = part.height / 2,
      // The part's centre in figure space: its pivot, then half its height down the swung limb.
      cy = part.y - half * ca,
      cz = -half * sa,
      at = (row + i) * ROW;
    // Yaw * pitch * scale, column by column.
    out[at] = c * part.width;
    out[at + 1] = 0;
    out[at + 2] = -s * part.width;
    out[at + 3] = s * sa * part.height;
    out[at + 4] = ca * part.height;
    out[at + 5] = c * sa * part.height;
    out[at + 6] = s * ca * part.depth;
    out[at + 7] = -sa * part.depth;
    out[at + 8] = c * ca * part.depth;
    out[at + 9] = x + c * part.x + s * cz;
    out[at + 10] = y + cy;
    out[at + 11] = z - s * part.x + c * cz;
  }
}

/** The limb swing for a walking phase and speed in blocks per second: 0 standing, at most 0.8 radians. */
export function limbSwing(phase: number, speed: number): number {
  return Math.sin(phase) * Math.min(0.8, speed * 0.16);
}

/** The heading of a unit quaternion that turns about +y only, radians. */
export function yawOf(q: ArrayLike<number>): number {
  return 2 * Math.atan2(q[1], q[3]);
}

/** What {@link Figures.update} reads of a player: voxel-net's `RemotePlayer`. */
export interface FigurePlayer {
  readonly id: number;
  readonly name: string;
  readonly snapshot: {
    readonly position: ArrayLike<number>;
    readonly rotation: ArrayLike<number>;
    readonly velocity: ArrayLike<number>;
  };
}

/** Options of {@link Figures}. */
export interface FiguresOptions {
  /** Most figures drawn at once; players past it are not drawn. Default 512. */
  capacity?: number;
  /** Most name tags shown at once. Default 32. */
  tags?: number;
  /** Adds the instances to the shadow maps and returns how to remove them; none on the phone tier. */
  castShadows?: (crowd: DynamicInstances) => () => void;
}

interface Tag {
  label: Label;
  element: HTMLElement;
  slot: number;
  // Where the label was last put: Label.setPosition copies its argument, so a still player's tag costs nothing.
  x: number;
  y: number;
  z: number;
}

/** Draws other players as figures with name tags. Call {@link Figures.update} once a frame. */
export class Figures {
  readonly #crowd: DynamicInstances;
  readonly #labels: LabelRenderer;
  readonly #engine: EngineKernel;
  readonly #removeShadows: (() => void) | undefined;
  // By slot: the player's id (-1 free), the frame it was last seen, its walking phase.
  readonly #ids: Int32Array;
  readonly #seen: Uint32Array;
  readonly #phase: Float32Array;
  readonly #tagOf: (Tag | undefined)[];
  readonly #slotOf = new Map<number, number>();
  readonly #free: number[] = [];
  readonly #spareTags: Tag[] = [];
  readonly #position: [number, number, number] = [0, 0, 0];
  #frame = 0;
  #high = 0; // slots at or past this were never used
  #dt = 0;
  #ex = 0;
  #ey = 0;
  #ez = 0;
  #drawn = 0;

  constructor(engine: EngineKernel, options: FiguresOptions = {}) {
    const capacity = options.capacity ?? 512,
      tags = options.tags ?? 32;
    this.#engine = engine;
    this.#crowd = DynamicInstances.attach(engine, {
      geometry: box(1, 1, 1),
      material: new PbrMaterial({ color: '#ffffff', roughness: 0.85 }),
      capacity: capacity * PARTS,
    });
    this.#removeShadows = options.castShadows?.(this.#crowd);
    this.#labels = LabelRenderer.attach(engine, { className: 'tags' });
    this.#ids = new Int32Array(capacity).fill(-1);
    this.#seen = new Uint32Array(capacity);
    this.#phase = new Float32Array(capacity);
    this.#tagOf = new Array(capacity).fill(undefined);
    for (let i = 0; i < capacity * PARTS; i++) this.#crowd.setVisibleAt(this.#crowd.addInstance(), false);
    for (let slot = capacity - 1; slot >= 0; slot--) this.#free.push(slot);
    for (let i = 0; i < tags; i++) {
      const element = document.createElement('div');
      element.className = 'name-tag';
      const label = this.#labels.add(element, {
        position: [0, 0, 0],
        anchor: [0.5, 1],
        distanceScale: { reference: 8, min: 0.6, max: 1.2 },
      });
      label.visible = false;
      this.#spareTags.push({ label, element, slot: -1, x: 0, y: 0, z: 0 });
    }
  }

  /** The instanced boxes (tests read `readCount()`). */
  get crowd(): DynamicInstances {
    return this.#crowd;
  }

  /** Figures drawn this frame (tests and the HUD). */
  get drawn(): number {
    return this.#drawn;
  }

  /** Moves every figure to where the client samples it, adds and removes figures and tags as players come and go. */
  update(players: ReadonlyMap<number, FigurePlayer>, dt: number, eye: ArrayLike<number>): void {
    this.#frame = (this.#frame + 1) >>> 0;
    this.#dt = dt;
    this.#ex = eye[0];
    this.#ey = eye[1];
    this.#ez = eye[2];
    this.#drawn = 0;
    players.forEach(this.#visit);
    for (let slot = 0; slot < this.#high; slot++)
      if (this.#ids[slot] !== -1 && this.#seen[slot] !== this.#frame) this.#release(slot);
    this.#crowd.update(0, this.#high * PARTS);
  }

  dispose(): void {
    this.#removeShadows?.();
    this.#engine.removePlugin(this.#labels.name);
    this.#crowd.dispose();
  }

  readonly #visit = (player: FigurePlayer): void => {
    let slot = this.#slotOf.get(player.id);
    if (slot === undefined) {
      slot = this.#claim(player.id);
      if (slot < 0) return;
    }
    this.#seen[slot] = this.#frame;
    this.#drawn++;
    const { position: p, rotation, velocity: v } = player.snapshot,
      speed = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
    this.#phase[slot] = (this.#phase[slot] + speed * this.#dt * 2.6) % (2 * Math.PI);
    writeFigure(
      this.#crowd.matrices,
      slot * PARTS,
      p[0],
      p[1],
      p[2],
      yawOf(rotation),
      limbSwing(this.#phase[slot], speed),
    );
    this.#placeTag(slot, player, p);
  };

  #placeTag(slot: number, player: FigurePlayer, p: ArrayLike<number>): void {
    const dx = p[0] - this.#ex,
      dy = p[1] - this.#ey,
      dz = p[2] - this.#ez,
      near = dx * dx + dy * dy + dz * dz <= TAG_RANGE * TAG_RANGE && player.name !== '';
    let tag = this.#tagOf[slot];
    if (!near) {
      if (tag) this.#dropTag(slot, tag);
      return;
    }
    if (!tag) {
      tag = this.#spareTags.pop();
      if (!tag) return; // every tag is on a nearer or earlier player
      tag.slot = slot;
      this.#tagOf[slot] = tag;
      tag.label.visible = true;
    }
    // Text, never HTML: the name comes from the network.
    if (tag.element.textContent !== player.name) tag.element.textContent = player.name;
    if (tag.x === p[0] && tag.y === p[1] && tag.z === p[2]) return;
    tag.x = p[0];
    tag.y = p[1];
    tag.z = p[2];
    const at = this.#position;
    at[0] = p[0];
    at[1] = p[1] + 1.95;
    at[2] = p[2];
    tag.label.setPosition(at);
  }

  #dropTag(slot: number, tag: Tag): void {
    tag.label.visible = false;
    tag.slot = -1;
    this.#tagOf[slot] = undefined;
    this.#spareTags.push(tag);
  }

  #claim(id: number): number {
    const slot = this.#free.pop();
    if (slot === undefined) return -1;
    const color = COLORS[((id % COLORS.length) + COLORS.length) % COLORS.length],
      trousers = [color[0] * TROUSERS, color[1] * TROUSERS, color[2] * TROUSERS],
      crowd = this.#crowd,
      row = slot * PARTS;
    crowd.setColorAt(row, SKIN);
    crowd.setColorAt(row + 1, color);
    crowd.setColorAt(row + 2, color);
    crowd.setColorAt(row + 3, color);
    crowd.setColorAt(row + 4, trousers);
    crowd.setColorAt(row + 5, trousers);
    for (let i = 0; i < PARTS; i++) crowd.setVisibleAt(row + i, true);
    this.#ids[slot] = id;
    this.#phase[slot] = 0;
    this.#slotOf.set(id, slot);
    this.#high = Math.max(this.#high, slot + 1);
    return slot;
  }

  #release(slot: number): void {
    for (let i = 0; i < PARTS; i++) this.#crowd.setVisibleAt(slot * PARTS + i, false);
    const tag = this.#tagOf[slot];
    if (tag) this.#dropTag(slot, tag);
    this.#slotOf.delete(this.#ids[slot]);
    this.#ids[slot] = -1;
    this.#free.push(slot);
  }
}
