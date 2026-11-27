// Reads the elements of a 3MF beam lattice (https://github.com/3MFConsortium/spec_beamlattice, chapter 2), for the
// lattice entry and for the readers that evaluate one.
import { LoaderError } from './types.js';
import type { ThreeMFBall, ThreeMFBeam, ThreeMFBeamLattice } from './threemf-lattice.js';

const F = '3MF';

export const attribute = (a: Record<string, string>, name: string): string | undefined =>
  a[name] ?? Object.entries(a).find(([key]) => key.endsWith(':' + name))?.[1];
export function number(value: string | undefined, name: string, fallback?: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (n === undefined || !Number.isFinite(n)) throw new LoaderError(F, 'syntax', `${name} must be a finite number`);
  return n;
}
export function index(value: string | undefined, name: string): number {
  const n = number(value, name);
  if (!Number.isSafeInteger(n) || n < 0 || n >= 2147483648)
    throw new LoaderError(F, 'range', `${name} must be a nonnegative 31-bit index`);
  return n;
}
function positive(value: string | undefined, name: string, fallback?: number): number {
  const n = number(value, name, fallback);
  if (n <= 0) throw new LoaderError(F, 'range', `${name} must be positive`);
  return n;
}
export function choice<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!values.includes(value as T)) throw new LoaderError(F, 'range', `expected ${values.join(', ')}; got ${value}`);
  return value as T;
}
const cap = (value: string | undefined): ThreeMFBeam['cap1'] =>
  choice(value, ['sphere', 'hemisphere', 'butt'], 'sphere');

/** The lattices of one package, element by element, under one count of beams, balls and set references. */
export function beamReader(maxBeams: number) {
  let beams = 0,
    balls = 0,
    references = 0;
  interface Open {
    lattice: ThreeMFBeamLattice;
    set?: { name?: string; identifier?: string; beams: number[]; balls: number[] };
  }
  const open = new WeakMap<object, Open>();
  return {
    /** A `<beamlattice>` of the mesh object `owner` is reading; `pid` and `property` are the object's own. */
    begin(owner: object, a: Record<string, string>, pid?: string, property?: number): ThreeMFBeamLattice {
      const lattice: ThreeMFBeamLattice = {
        radius: positive(a.radius, 'radius'),
        minLength: positive(a.minlength, 'minlength'),
        cap: cap(a.cap),
        ballMode: choice(attribute(a, 'ballmode'), ['none', 'mixed', 'all'], 'none'),
        clippingMode: choice(a.clippingmode, ['none', 'inside', 'outside'], 'none'),
        clippingMesh: a.clippingmesh,
        representationMesh: a.representationmesh,
        pid: a.pid ?? pid,
        property: a.pindex === undefined ? property : index(a.pindex, 'pindex'),
        beams: [],
        balls: [],
        sets: [],
        activeBeams: new Uint32Array(),
        effectiveBalls: [],
      };
      const radius = attribute(a, 'ballradius');
      if (radius !== undefined) lattice.ballRadius = positive(radius, 'ballradius');
      if (lattice.ballMode !== 'none' && lattice.ballRadius === undefined)
        throw new LoaderError(F, 'syntax', 'ballmode needs ballradius');
      open.set(owner, { lattice });
      return lattice;
    },
    /** One element inside a lattice; other names are left alone. */
    element(owner: object, name: string, a: Record<string, string>): void {
      const state = open.get(owner),
        l = state?.lattice;
      if (name === 'beam') {
        if (!l) throw new LoaderError(F, 'syntax', 'beam outside beamlattice');
        if (++beams > maxBeams) throw new LoaderError(F, 'limit', 'beam count exceeds maxBeams');
        if (a.r2 !== undefined && a.r1 === undefined) throw new LoaderError(F, 'syntax', 'r2 requires r1');
        const r1 = positive(a.r1, 'r1', l.radius);
        l.beams.push({
          v1: index(a.v1, 'v1'),
          v2: index(a.v2, 'v2'),
          r1,
          r2: positive(a.r2, 'r2', r1),
          cap1: a.cap1 === undefined ? l.cap : cap(a.cap1),
          cap2: a.cap2 === undefined ? l.cap : cap(a.cap2),
          pid: a.pid ?? l.pid,
          p1: a.p1 === undefined ? l.property : index(a.p1, 'p1'),
          p2: a.p2 === undefined ? l.property : index(a.p2, 'p2'),
        });
      } else if (name === 'ball') {
        if (!l) throw new LoaderError(F, 'syntax', 'ball outside beamlattice');
        if (++balls > maxBeams) throw new LoaderError(F, 'limit', 'ball count exceeds maxBeams');
        l.balls.push({
          vertex: index(a.vindex, 'vindex'),
          radius: positive(a.r, 'ball radius', l.ballRadius),
          pid: a.pid ?? l.pid,
          property: a.p === undefined ? l.property : index(a.p, 'ball property'),
        });
      } else if (name === 'beamset') {
        if (!state || state.set) throw new LoaderError(F, 'syntax', 'invalid beamset nesting');
        state.set = { name: a.name, identifier: a.identifier, beams: [], balls: [] };
      } else if ((name === 'ref' || name === 'ballref') && state?.set) {
        if (++references > maxBeams * 2)
          throw new LoaderError(F, 'limit', 'beamset references exceed the native primitive budget');
        state.set[name === 'ref' ? 'beams' : 'balls'].push(index(a.index, name === 'ref' ? 'beam ref' : 'ball ref'));
      }
    },
    close(owner: object, name: string): void {
      const state = open.get(owner);
      if (!state) return;
      if (name === 'beamlattice') open.delete(owner);
      else if (name === 'beamset' && state.set) {
        state.lattice.sets.push({
          ...state.set,
          beams: Uint32Array.from(state.set.beams),
          balls: Uint32Array.from(state.set.balls),
        });
        state.set = undefined;
      }
    },
  };
}

/**
 * Checks a finished lattice against its mesh's vertices and fills `activeBeams` and `effectiveBalls`: beams shorter
 * than `minlength` are ignored, and the ball mode decides which beam ends get a ball. `property` checks a property
 * reference.
 */
export function finishLattice(
  l: ThreeMFBeamLattice,
  vertices: ArrayLike<number>,
  property: (pid: string | undefined, p: number | undefined) => void,
): void {
  if (!l.beams.length) throw new LoaderError(F, 'syntax', 'beamlattice requires at least one beam');
  const pointCount = vertices.length / 3,
    active: number[] = [],
    ends = new Set<number>();
  l.beams.forEach((beam, i) => {
    if (beam.v1 === beam.v2 || beam.v1 >= pointCount || beam.v2 >= pointCount)
      throw new LoaderError(F, 'range', 'invalid beam endpoints');
    property(beam.pid, beam.p1);
    property(beam.pid, beam.p2);
    const a = beam.v1 * 3,
      b = beam.v2 * 3;
    if (
      Math.hypot(vertices[a] - vertices[b], vertices[a + 1] - vertices[b + 1], vertices[a + 2] - vertices[b + 2]) >=
      l.minLength
    ) {
      active.push(i);
      ends.add(beam.v1);
      ends.add(beam.v2);
    }
  });
  l.activeBeams = Uint32Array.from(active);
  const explicit = new Map<number, ThreeMFBall>();
  for (const ball of l.balls) {
    if (ball.vertex >= pointCount || explicit.has(ball.vertex))
      throw new LoaderError(F, 'range', 'invalid or repeated ball vertex');
    property(ball.pid, ball.property);
    explicit.set(ball.vertex, ball);
  }
  l.effectiveBalls = [];
  if (l.ballMode !== 'none')
    for (const vertex of ends) {
      const ball = explicit.get(vertex);
      if (ball) l.effectiveBalls.push({ ...ball });
      else if (l.ballMode === 'all')
        l.effectiveBalls.push({ vertex, radius: l.ballRadius!, pid: l.pid, property: l.property });
    }
}
