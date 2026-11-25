// The field registry of a physics world (docs/physics-framework.md, section 4): every quantity that crosses a solver
// boundary, what it is (kind, quantity, SI unit, centring), its one owner, who reads it and who adds to it, and its data at
// the last two coupling ticks it was published at. This is the "privileges" idea of Legion and of render graphs (Bauer et
// al. 2012; O'Donnell 2017) applied to physics fields, as MOOSE (Gaston et al. 2009) and ESMF (Hill et al. 2004) share
// fields between coupled models.
//
// Everything the registry holds lies in regions of the world's memory, so a snapshot, a restore and the state hash take it
// with the solvers' own state:
// - an owner's port is copied, when it is published, into one of two mirror regions of the field, which swap: readers see
//   the value at the coupling tick however often the owner steps after it, and the previous value stays for interpolation;
// - a contributor's port is added, as f64, into a region of its own for the field, so a fast solver's substeps add up in
//   time order;
// - `sum` adds the contributors' regions into the field's sum region by contributor id, then by element, so the sum is the
//   same bits whatever order the solvers ran in and however many threads ran them, and clears them;
// - a small f64 region per field records the tick, rate level and origin cell of the current and previous values.
// Mirrors and contribution regions are made at a field's first publish; the world publishes every solver's ports once
// after `init`, so all of them exist before the first snapshot.
import { MargoError } from '@margoengine/math/errors';
import { type Arena, regionWords } from './memory.js';
import type { Cell, Centring, FieldDescriptor, FieldKind, FieldUse, Port, RateLevel, Region } from './solver.js';

/**
 * The SI unit of each quantity the framework's shared fields use. A field of one of these quantities must be in its unit;
 * any other quantity is taken in the unit its descriptor names.
 */
export const QUANTITY_UNITS: Readonly<Record<string, string>> = {
  acceleration: 'm/s^2',
  angularImpulse: 'N m s',
  angularVelocity: 'rad/s',
  bedElevation: 'm',
  density: 'kg/m^3',
  energy: 'J',
  force: 'N',
  gravity: 'm/s^2',
  heat: 'J',
  heatFlux: 'W/m^2',
  height: 'm',
  impulse: 'N s',
  levelSet: 'm',
  mass: 'kg',
  massSource: 'kg/s',
  momentum: 'kg m/s',
  position: 'm',
  precipitationRate: 'm/s',
  pressure: 'Pa',
  specificHumidity: 'kg/kg',
  temperature: 'K',
  torque: 'N m',
  velocity: 'm/s',
  volume: 'm^3',
  volumeFraction: '1',
};

const KINDS: ReadonlySet<FieldKind> = new Set([
  'uniformGrid',
  'sparseGrid',
  'heightfield',
  'particleSet',
  'meshVertexSet',
  'surfaceSampleSet',
  'bodySet',
  'scalarSeries',
]);
const CENTRINGS: ReadonlySet<Centring> = new Set(['cell', 'face', 'vertex', 'particle']);

/** A port as the registry keeps it: the data (with the origin cell its positions are in) and the rate level its tick counts at. */
export interface PublishedPort {
  readonly port: Port;
  readonly level: RateLevel;
}

/** A field and what the registry knows of it. */
export interface RegisteredField {
  readonly descriptor: FieldDescriptor;
  /** The solver that writes it; undefined while only readers and contributors have declared it. */
  readonly owner: string | undefined;
  /** Solvers that read it, in id order. */
  readonly readers: readonly string[];
  /** Solvers that add to it, in id order. */
  readonly contributors: readonly string[];
  /** The value at the last coupling tick it was published at, and the one before (for interpolation). */
  readonly current: PublishedPort | undefined;
  readonly previous: PublishedPort | undefined;
}

// The meta region of a field: [has, tick, level, cx, cy, cz] for the current and then the previous value, and which mirror
// holds the current one.
const META = 13;
const META_LAYOUT = 1;
const SUM_LAYOUT = 1;
const TOP_LEVEL = 7;

interface Entry {
  readonly descriptor: FieldDescriptor;
  owner: string | undefined;
  readonly readers: Set<string>;
  readonly contributors: Set<string>;
  readonly meta: Region;
  mirrors: readonly [Region, Region] | undefined;
  sum: Region | undefined;
  readonly from: Map<string, Region>;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The fields of one world: declared by the solvers that touch them, one writer each, read in place, added to in a fixed order. */
export class FieldRegistry {
  private readonly arena: Arena;
  private readonly fields = new Map<string, Entry>();

  /** @param arena Where the registry's regions are allocated: the world's memory. */
  constructor(arena: Arena) {
    this.arena = arena;
  }

  /**
   * Records what solver `solver` touches. Every solver that names a field describes it alike; a `write` makes the solver its
   * one owner. All or nothing: a refused declaration changes no field.
   * @throws RangeError for a field with two writers, a field described two ways, a field named twice, an unknown kind,
   * centring or access, or a known quantity in another unit than its SI one.
   */
  declare(solver: string, uses: readonly FieldUse[]): void {
    const seen = new Set<string>();
    for (const use of uses) {
      check(use.field);
      const name = use.field.name,
        entry = this.fields.get(name);
      if (seen.has(name))
        throw new RangeError(`Solver "${solver}" names field "${name}" twice; give each field one access.`);
      seen.add(name);
      if (use.access !== 'read' && use.access !== 'write' && use.access !== 'accumulate')
        throw new RangeError(
          `Solver "${solver}" uses field "${name}" with access "${use.access}"; use read, write or accumulate.`,
        );
      if (entry && !sameField(entry.descriptor, use.field))
        throw new RangeError(
          `Field "${name}" is declared two ways (${describe(entry.descriptor)} against ${describe(use.field)}); every solver must describe a field alike.`,
        );
      if (use.access === 'write' && entry?.owner !== undefined && entry.owner !== solver)
        throw new RangeError(
          `Field "${name}" has two writers, "${entry.owner}" and "${solver}"; one solver owns a field, and others read or accumulate into it.`,
        );
    }
    for (const use of uses) {
      const name = use.field.name;
      let entry = this.fields.get(name);
      if (!entry) {
        const { kind, quantity, unit, centring } = use.field;
        entry = {
          descriptor: { name, kind, quantity, unit, centring },
          owner: undefined,
          readers: new Set(),
          contributors: new Set(),
          meta: this.arena.allocate(`${name}/meta`, META * 8, 'f64', META_LAYOUT),
          mirrors: undefined,
          sum: undefined,
          from: new Map(),
        };
        this.fields.set(name, entry);
      }
      if (use.access === 'write') entry.owner = solver;
      else if (use.access === 'read') entry.readers.add(solver);
      else entry.contributors.add(solver);
    }
  }

  /**
   * Forgets what solver `solver` declared. A field nobody touches any more is dropped; an owner's published values go with
   * it. The regions stay allocated (the world's memory only grows).
   */
  remove(solver: string): void {
    for (const [name, entry] of this.fields) {
      if (entry.owner === solver) {
        entry.owner = undefined;
        this.words(entry.meta).fill(0);
      }
      entry.readers.delete(solver);
      entry.contributors.delete(solver);
      entry.from.delete(solver);
      if (entry.owner === undefined && entry.readers.size === 0 && entry.contributors.size === 0)
        this.fields.delete(name);
    }
  }

  /** The field named `name`, or undefined. */
  field(name: string): RegisteredField | undefined {
    const entry = this.fields.get(name);
    return entry && this.view(entry);
  }

  /** Every field, in name order. */
  list(): RegisteredField[] {
    return this.names().map((name) => this.view(this.fields.get(name)!));
  }

  /** The value of field `name` at its last coupling tick, as readers see it, or undefined before its first publish. */
  port(name: string): Port | undefined {
    return this.field(name)?.current?.port;
  }

  /**
   * Takes a port solver `solver` published, its tick counted at rate level `level` and its positions in origin cell
   * `port.cell` (the world sets it to the solver's cell).
   * An owner's port is copied into the field's next mirror and becomes the current value, the one it replaces the previous;
   * a contributor's port is added, element by element as f64, into its contribution for the next `sum`.
   * @throws RangeError when `solver` neither owns nor contributes to the field, when a port changes its element type,
   * length or layout version from the field's first, or when an owner's port ends before the current one.
   */
  publish(solver: string, port: Port, level: RateLevel): void {
    const { cell } = port;
    const entry = this.fields.get(port.field);
    if (!entry || (entry.owner !== solver && !entry.contributors.has(solver)))
      throw new RangeError(
        `Solver "${solver}" published field "${port.field}", which it neither writes nor accumulates into; declare it first.`,
      );
    const data = regionWords(this.arena.memory, port.region);
    if (entry.owner === solver) {
      if (!entry.mirrors) {
        const { byteLength, type, layout } = port.region;
        entry.mirrors = [
          this.arena.allocate(`${port.field}/a`, byteLength, type, layout),
          this.arena.allocate(`${port.field}/b`, byteLength, type, layout),
        ];
      }
      sameShape(port, entry.mirrors[0]);
      const meta = this.words(entry.meta) as Float64Array;
      // Tick t at level L ends at (t + 1) * 2^(7 - L) ticks of the 7,680 Hz grid: whole numbers, compared exactly.
      if (meta[0] === 1 && (port.tick + 1) * 2 ** (TOP_LEVEL - level) < (meta[1]! + 1) * 2 ** (TOP_LEVEL - meta[2]!))
        throw new RangeError(
          `Field "${port.field}" was published at tick ${port.tick} (level ${level}), before its current tick ${meta[1]} (level ${meta[2]}); publish in time order.`,
        );
      const next = meta[0] === 1 ? 1 - meta[12]! : meta[12]!;
      this.words(entry.mirrors[next]!).set(data);
      meta.copyWithin(6, 0, 6);
      meta.set([1, port.tick, level, cell[0], cell[1], cell[2]], 0);
      meta[12] = next;
      return;
    }
    let mine = entry.from.get(solver);
    if (!mine) {
      mine = this.arena.allocate(`${port.field}/from/${solver}`, data.length * 8, 'f64', SUM_LAYOUT);
      entry.from.set(solver, mine);
    }
    const into = this.words(mine);
    if (into.length !== data.length)
      throw new RangeError(
        `Solver "${solver}" added ${data.length} words to field "${port.field}" after ${into.length} before; keep a contribution's length.`,
      );
    for (let i = 0; i < data.length; i++) into[i]! += data[i]!;
  }

  /**
   * Sums the contributions to field `name` into its sum region, contributor by contributor in id order and each element in
   * index order, so the result is the same bits whatever order the contributors ran in, and clears them. Returns the sum as a
   * port valid at `tick` in origin cell `cell` (the owner's), or undefined when nobody has contributed to the field yet.
   * @throws RangeError when two contributors' lengths differ.
   */
  sum(name: string, tick: number, cell: Cell = [0, 0, 0]): Port | undefined {
    const entry = this.fields.get(name);
    if (!entry || entry.from.size === 0) return undefined;
    const ids = [...entry.from.keys()].sort(byText),
      length = entry.from.get(ids[0]!)!.byteLength;
    for (const id of ids)
      if (entry.from.get(id)!.byteLength !== length)
        throw new RangeError(
          `Contributors "${ids[0]}" and "${id}" add different lengths to field "${name}"; every contribution to a field covers the same elements.`,
        );
    entry.sum ??= this.arena.allocate(`${name}/sum`, length, 'f64', SUM_LAYOUT);
    const out = this.words(entry.sum);
    out.fill(0);
    for (const id of ids) {
      const from = this.words(entry.from.get(id)!);
      for (let i = 0; i < from.length; i++) out[i]! += from[i]!;
      from.fill(0);
    }
    return { field: name, region: entry.sum, tick, cell: [cell[0], cell[1], cell[2]] };
  }

  /**
   * The registry's regions in canonical order (fields by name; per field its meta, mirrors, sum and contributions by
   * contributor id), for the world's snapshot, restore and state hash.
   */
  stateRegions(): Region[] {
    const out: Region[] = [];
    for (const name of this.names()) {
      const e = this.fields.get(name)!;
      out.push(e.meta);
      if (e.mirrors) out.push(e.mirrors[0], e.mirrors[1]);
      if (e.sum) out.push(e.sum);
      for (const id of [...e.from.keys()].sort(byText)) out.push(e.from.get(id)!);
    }
    return out;
  }

  private names(): string[] {
    return [...this.fields.keys()].sort(byText);
  }

  private words(region: Region) {
    return regionWords(this.arena.memory, region);
  }

  private view(e: Entry): RegisteredField {
    const meta = this.words(e.meta) as Float64Array,
      current = meta[12]!,
      at = (offset: number, mirror: number): PublishedPort | undefined =>
        meta[offset] === 1 && e.mirrors
          ? {
              port: {
                field: e.descriptor.name,
                region: e.mirrors[mirror]!,
                tick: meta[offset + 1]!,
                cell: [meta[offset + 3]!, meta[offset + 4]!, meta[offset + 5]!],
              },
              level: meta[offset + 2]! as RateLevel,
            }
          : undefined;
    return {
      descriptor: e.descriptor,
      owner: e.owner,
      readers: [...e.readers].sort(byText),
      contributors: [...e.contributors].sort(byText),
      current: at(0, current),
      previous: at(6, 1 - current),
    };
  }
}

function sameShape(port: Port, mirror: Region): void {
  const r = port.region;
  if (r.type !== mirror.type || r.byteLength !== mirror.byteLength || r.layout !== mirror.layout)
    throw new RangeError(
      `Field "${port.field}" was published as ${r.byteLength} bytes of ${r.type} (layout ${r.layout}) after ${mirror.byteLength} bytes of ${mirror.type} (layout ${mirror.layout}); a port keeps its type, length and layout, so size it to capacity.`,
    );
}

function check(f: FieldDescriptor): void {
  if (!f || typeof f.name !== 'string' || f.name.length === 0)
    throw new RangeError('A field needs a name; pass a non-empty string.');
  if (!KINDS.has(f.kind))
    throw new RangeError(`Field "${f.name}" has kind "${f.kind}"; use one of ${[...KINDS].join(', ')}.`);
  if (!CENTRINGS.has(f.centring))
    throw new RangeError(`Field "${f.name}" has centring "${f.centring}"; use one of ${[...CENTRINGS].join(', ')}.`);
  if (typeof f.unit !== 'string' || f.unit.length === 0)
    throw new RangeError(`Field "${f.name}" has no unit; name its SI unit (for example m, kg, s, K, Pa, N s).`);
  const unit = QUANTITY_UNITS[f.quantity];
  if (unit !== undefined && f.unit !== unit)
    throw new RangeError(`Field "${f.name}" holds ${f.quantity} in "${f.unit}"; ${f.quantity} is in "${unit}" (SI).`);
}

function sameField(a: FieldDescriptor, b: FieldDescriptor): boolean {
  return a.kind === b.kind && a.quantity === b.quantity && a.unit === b.unit && a.centring === b.centring;
}

function describe(f: FieldDescriptor): string {
  return `${f.kind} of ${f.quantity} in ${f.unit} at ${f.centring}`;
}

/**
 * A transfer between representations, owned by the framework rather than by any solver (docs/physics-framework.md, section
 * 4): particle to grid and back (affine particle-in-cell, Jiang et al. 2015), grid to grid (conservative remapping, Jones
 * 1999; Ullrich and Taylor 2015), and mesh loads and motion (Farhat, Lesoinne and Le Tallec 1998). Each lands with the first
 * solver that needs it.
 */
export interface Transfer {
  /** Its name in the world, unique. */
  readonly name: string;
  /** The field it reads and the field it writes. */
  readonly from: string;
  readonly to: string;
  /** Moves `from`'s port onto `to`'s region in `memory`, conserving what the transfer promises (mass, momentum). */
  apply(memory: WebAssembly.Memory, from: Port, to: Region): void;
}

/** The transfers a world knows, by name. */
export class TransferRegistry {
  private readonly transfers = new Map<string, Transfer>();

  /** Adds a transfer. @throws RangeError for a name already taken. */
  register(transfer: Transfer): void {
    if (this.transfers.has(transfer.name))
      throw new RangeError(`A transfer named "${transfer.name}" is already registered; give it its own name.`);
    this.transfers.set(transfer.name, transfer);
  }

  /** The transfer named `name`. @throws MargoError `state` when there is none. */
  get(name: string): Transfer {
    const t = this.transfers.get(name);
    if (!t)
      throw new MargoError('state', `No transfer named "${name}" is registered; register it before a solver uses it.`);
    return t;
  }

  /** The names of every transfer, in order. */
  names(): string[] {
    return [...this.transfers.keys()].sort(byText);
  }
}
