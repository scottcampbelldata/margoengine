import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { Cell, FieldDescriptor } from '../world/solver.js';

/** Both parcel fields use layout-1 f64 rows. */
export const DFSPH_PARCEL_LAYOUT = 1;

/** Each row is [ticket, particleRow, x, y, z, volume, momentumX, momentumY, momentumZ]. */
export const DFSPH_PARCEL_WORDS = 9;

/** One world-clock request and receipt channel for conservative liquid parcels. */
export interface DfsphParcelFields {
  /** The surface/parcel owner authorizes one operation per positive ticket. */
  readonly requests: FieldDescriptor;
  /** Each ticket is answered with the actual signed volume and momentum. Zero volume means refused. */
  readonly receipts: FieldDescriptor;
}

export function parcelFields(id: string): DfsphParcelFields {
  const make = (suffix: string): FieldDescriptor =>
    Object.freeze({
      name: id + ':parcel-' + suffix,
      kind: 'scalarSeries',
      quantity: 'liquidParcel',
      unit: 'index, index, m, m³, kg m/s',
      centring: 'cell',
    });
  return Object.freeze({ requests: make('requests'), receipts: make('receipts') });
}

type Parcel = {
  readonly ticket: number;
  readonly index: number;
  readonly position: Vec3;
  readonly volume: number;
  readonly velocity: Vec3;
};

export function getParcels(
  data: Float64Array,
  volume: number,
  mass: number,
  shift: Cell,
  lastTicket: number,
): Parcel[] {
  const requests: Parcel[] = [];
  const tickets = new Set<number>();
  const targets = new Set<number>();
  for (let at = 0; at < data.length; at += DFSPH_PARCEL_WORDS) {
    const ticket = data[at]!;
    if (ticket === 0 || (Number.isSafeInteger(ticket) && ticket > 0 && ticket <= lastTicket)) continue;
    const index = data[at + 1]!;
    const size = data[at + 5]!;
    if (!Number.isSafeInteger(ticket) || ticket <= 0 || tickets.has(ticket))
      throw new MargoError(
        'state',
        'Invalid liquid parcel ticket. Provide one unique positive safe integer per request.',
      );
    if (!Number.isFinite(size) || Math.abs(size) !== volume)
      throw new MargoError('state', 'The parcel has the wrong volume. Provide one whole DFSPH particle per row.');
    if (size > 0 ? index !== -1 : !Number.isSafeInteger(index) || index < 0 || targets.has(index))
      throw new MargoError('state', 'Invalid liquid parcel row. Use -1 to emit or address each active row once.');
    tickets.add(ticket);
    if (size < 0) targets.add(index);
    const position: Vec3 = [data[at + 2]! + shift[0], data[at + 3]! + shift[1], data[at + 4]! + shift[2]];
    const momentum: Vec3 = [data[at + 6]!, data[at + 7]!, data[at + 8]!];
    const velocity: Vec3 = [momentum[0] / mass, momentum[1] / mass, momentum[2] / mass];
    if (
      size > 0 &&
      (!position.every(Number.isFinite) || !velocity.every((v) => Number.isFinite(v) && Number.isFinite(mass * v)))
    )
      throw new MargoError('state', 'A liquid parcel cannot be represented. Provide finite position and momentum.');
    requests.push({ ticket, index, position, volume: size, velocity });
  }
  return requests.sort((a, b) => a.ticket - b.ticket);
}

/** Whole-particle movements occur at the same clock boundary on both tickets. */
export function exchangeParcels(
  points: Float64Array,
  work: Float64Array,
  count: number,
  capacity: number,
  pointWords: number,
  workWords: number,
  mass: number,
  requests: readonly Parcel[],
  receipts: Float64Array,
): number {
  const departures: number[] = [];
  const completed = new Float64Array(requests.length * DFSPH_PARCEL_WORDS);
  for (const [i, packet] of requests.entries()) {
    const at = i * DFSPH_PARCEL_WORDS;
    completed[at] = packet.ticket;
    completed[at + 1] = -1;
    if (packet.volume > 0 || packet.index >= count) continue;
    const from = packet.index * pointWords;
    completed.set(points.subarray(from, from + 3), at + 2);
    completed[at + 5] = packet.volume;
    for (let axis = 0; axis < 3; axis++) {
      const impulse = -mass * points[from + 3 + axis]!;
      if (!Number.isFinite(impulse))
        throw new MargoError(
          'state',
          'Outgoing liquid parcel momentum overflows. Use smaller particle masses or velocities.',
        );
      completed[at + 6 + axis] = impulse;
    }
    departures.push(packet.index);
  }
  // Removing highest indices first leaves every remaining departure at its
  // original index. Other rows may move and bring their warm-start state along.
  for (const index of departures.sort((a, b) => b - a)) {
    const last = --count;
    if (index !== last) {
      points.copyWithin(index * pointWords, last * pointWords, (last + 1) * pointWords);
      work.copyWithin(index * workWords, last * workWords, (last + 1) * workWords);
    }
    points.fill(0, last * pointWords, (last + 1) * pointWords);
    work.fill(0, last * workWords, (last + 1) * workWords);
  }
  for (const [i, packet] of requests.entries()) {
    if (packet.volume < 0 || count === capacity) continue;
    const at = i * DFSPH_PARCEL_WORDS;
    const to = count * pointWords;
    points.set(packet.position, to);
    points.set(packet.velocity, to + 3);
    points[to + 6] = 0; // Density is evaluated by the native step.
    points[to + 7] = mass;
    completed[at + 1] = count++;
    completed.set(packet.position, at + 2);
    completed[at + 5] = packet.volume;
    for (let axis = 0; axis < 3; axis++) completed[at + 6 + axis] = mass * packet.velocity[axis]!;
  }
  receipts.fill(0);
  receipts.set(completed);
  return count;
}
