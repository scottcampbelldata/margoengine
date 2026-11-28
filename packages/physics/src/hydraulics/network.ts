// Steady pipe networks for the hydraulics entry (HYDRO-07): reservoirs (fixed heads), junctions with demands, and
// links that are pipes, valves or orifices, or pumps. Solved by the global gradient algorithm of
// E. Todini and S. Pilati, "A gradient algorithm for the analysis of pipe networks", in Computer Applications in Water
// Supply, vol. 1, Research Studies Press, 1-20 (1988): Newton's method on link flows and junction heads together,
// with the link flows eliminated so each step solves one symmetric positive-definite system in the junction heads
// (here by dense Cholesky factorisation, which is exact for the network sizes a scene holds). Friction follows the
// Darcy-Weisbach law of conduits.ts, re-evaluated at every Newton step. Clean room from the paper's equations.
import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';
import { darcyFriction, type FrictionLaw } from './conduits.js';
import { circleArea, finite, GRAVITY, type Liquid, nonNegative, positive, WATER } from './fluid.js';

/** A node of a {@link PipeNetwork}. */
export type NetworkNode =
  /** A reservoir or tank surface: its head is fixed, m. */
  | { readonly id: string; readonly kind: 'reservoir'; readonly head: number }
  /** A junction at `elevation` m drawing `demand` m³/s out of the network (negative injects). */
  | { readonly id: string; readonly kind?: 'junction'; readonly elevation?: number; readonly demand?: number };

/** A link of a {@link PipeNetwork}, positive flow from `from` to `to`. */
export type NetworkLink =
  | {
      readonly id: string;
      readonly kind?: 'pipe';
      readonly from: string;
      readonly to: string;
      readonly length: number;
      readonly diameter: number;
      /** Absolute roughness, m. Default 0. */
      readonly roughness?: number;
      /** Fitting losses on the velocity head. Default 0. */
      readonly minorLoss?: number;
      /** A fixed Darcy friction factor in place of the law. */
      readonly frictionFactor?: number;
    }
  | {
      /** A valve or orifice: Δh = Q|Q| / (2 g (Cd a)²). An opening of 0 closes the link. */
      readonly id: string;
      readonly kind: 'valve';
      readonly from: string;
      readonly to: string;
      readonly area: number;
      readonly dischargeCoefficient?: number;
    }
  | {
      /** A pump adding head h₀ - r Q^n for forward flow (no reverse flow). */
      readonly id: string;
      readonly kind: 'pump';
      readonly from: string;
      readonly to: string;
      /** Shut-off head h₀, m. */
      readonly shutoffHead: number;
      /** Curve coefficient r, m per (m³/s)^n. */
      readonly coefficient: number;
      /** Curve exponent n. Default 2. */
      readonly exponent?: number;
    };

/** A pipe network to solve. */
export interface PipeNetwork {
  readonly nodes: readonly NetworkNode[];
  readonly links: readonly NetworkLink[];
  readonly liquid?: Liquid;
  readonly gravity?: number;
  /** Friction law for pipes without a fixed factor. Default `'churchill'`. */
  readonly friction?: FrictionLaw;
}

/** Options for {@link solveNetwork}. */
export interface NetworkSolveOptions {
  /** Stop when every flow changes by less than this, m³/s, and continuity holds to it. Default 1e-12. */
  readonly tolerance?: number;
  /** Newton iterations before giving up. Default 100. */
  readonly maxIterations?: number;
}

/** A solved network. */
export interface NetworkSolution {
  /** Head at every node, m (fixed at reservoirs). */
  readonly heads: Readonly<Record<string, number>>;
  /** Pressure head (head minus elevation) at every junction, m. */
  readonly pressureHeads: Readonly<Record<string, number>>;
  /** Flow in every link, m³/s, positive from `from` to `to`. */
  readonly flows: Readonly<Record<string, number>>;
  /** Mean speed in every pipe, m/s. */
  readonly speeds: Readonly<Record<string, number>>;
  /** Head lost (positive) or added by a pump (negative) along every link, m. */
  readonly headLosses: Readonly<Record<string, number>>;
  readonly iterations: number;
  /** Largest continuity error at a junction, m³/s. */
  readonly continuityError: number;
}

const MIN_GRADIENT = 1e-9;

/** Solves a steady pipe network by the global gradient algorithm (Todini and Pilati 1988). */
export function solveNetwork(network: PipeNetwork, options: NetworkSolveOptions = {}): NetworkSolution {
  const liquid = network.liquid ?? WATER,
    g = positive('gravity', network.gravity ?? GRAVITY),
    tolerance = positive('tolerance', options.tolerance ?? 1e-12),
    maxIterations = positive('maxIterations', options.maxIterations ?? 100);
  const index = new Map<string, number>(),
    fixed: number[] = [],
    unknown: number[] = [];
  network.nodes.forEach((node, i) => {
    if (typeof node.id !== 'string' || index.has(node.id))
      throw new RangeError(`Network node ids must be unique strings; '${String(node.id)}' repeats or is missing.`);
    index.set(node.id, i);
    if (node.kind === 'reservoir') fixed.push(i);
    else if (node.kind === undefined || node.kind === 'junction') unknown.push(i);
    else
      throw new RangeError(
        `Network node '${node.id}' has unknown kind '${String((node as { kind: unknown }).kind)}'; use 'reservoir' or 'junction'.`,
      );
  });
  if (fixed.length === 0) throw new RangeError('A pipe network needs at least one reservoir to fix its heads.');
  const n = network.nodes.length,
    row = new Int32Array(n).fill(-1);
  unknown.forEach((node, k) => (row[node] = k));
  const head = new Float64Array(n),
    demand = new Float64Array(n);
  for (const i of fixed) head[i] = finite('reservoir head', (network.nodes[i] as { head: number }).head);
  let start = 0;
  for (const i of fixed) start = Math.max(start, head[i]!);
  for (const i of unknown) {
    const node = network.nodes[i] as { elevation?: number; demand?: number };
    demand[i] = finite('demand', node.demand ?? 0);
    head[i] = start;
  }
  const links = network.links,
    m = links.length,
    from = new Int32Array(m),
    to = new Int32Array(m),
    flow = new Float64Array(m);
  links.forEach((link, l) => {
    const a = index.get(link.from),
      b = index.get(link.to);
    if (a === undefined || b === undefined)
      throw new RangeError(`Network link '${link.id}' joins an unknown node; check its from and to ids.`);
    from[l] = a;
    to[l] = b;
    if (link.kind === 'pump') {
      positive('shutoffHead', link.shutoffHead);
      nonNegative('coefficient', link.coefficient);
      flow[l] = 1e-3;
    } else if (link.kind === 'valve') {
      nonNegative('area', link.area);
      flow[l] = 1e-4;
    } else if (link.kind === undefined || link.kind === 'pipe') {
      positive('length', link.length);
      positive('diameter', link.diameter);
      flow[l] = 1e-3 * circleArea(link.diameter);
    } else
      throw new RangeError(
        `Network link '${link.id}' has unknown kind '${String((link as { kind: unknown }).kind)}'; use 'pipe', 'valve' or 'pump'.`,
      );
  });

  // Head loss along link l at flow q and its derivative dh/dq (Newton's linearisation, kept positive).
  const loss = (l: number, q: number): [number, number] => {
    const link = links[l]!;
    if (link.kind === 'pump') {
      const nexp = positive('exponent', link.exponent ?? 2),
        forward = Math.max(q, 0);
      const gain = link.shutoffHead - link.coefficient * (forward > 0 ? pow(forward, nexp) : 0);
      const slope = Math.max(MIN_GRADIENT, link.coefficient * nexp * (forward > 0 ? pow(forward, nexp - 1) : 0));
      return [-gain, slope];
    }
    if (link.kind === 'valve') {
      const ca = (link.dischargeCoefficient ?? 0.61) * link.area;
      const r = 1 / (2 * g * ca * ca);
      return [r * q * Math.abs(q), Math.max(MIN_GRADIENT, 2 * r * Math.abs(q))];
    }
    const area = circleArea(link.diameter),
      speed = Math.abs(q) / area,
      re = (speed * link.diameter) / liquid.kinematicViscosity,
      f =
        link.frictionFactor ??
        darcyFriction(re, nonNegative('roughness', link.roughness ?? 0) / link.diameter, network.friction);
    const r =
      ((f * link.length) / link.diameter + nonNegative('minorLoss', link.minorLoss ?? 0)) / (2 * g * area * area);
    // Laminar flow: f = 64/Re makes the friction part linear in q; its derivative is then r|q| rather than 2r|q|.
    const laminar = link.frictionFactor === undefined && re > 0 && re < 2000 && network.friction !== 'churchill';
    return [r * q * Math.abs(q), Math.max(MIN_GRADIENT, (laminar ? 1 : 2) * r * Math.abs(q))];
  };

  const size = unknown.length,
    matrix = new Float64Array(size * size),
    rhs = new Float64Array(size),
    lossNow = new Float64Array(m),
    gradient = new Float64Array(m),
    closed = new Uint8Array(m);
  let iterations = 0,
    continuity = Number.POSITIVE_INFINITY;
  for (; iterations < maxIterations; iterations++) {
    matrix.fill(0);
    rhs.fill(0);
    for (let l = 0; l < m; l++) {
      const link = links[l]!;
      // A shut valve carries nothing; a pump's built-in check valve shuts when the head against it passes shut-off.
      closed[l] =
        link.kind === 'valve'
          ? +((link.dischargeCoefficient ?? 0.61) * link.area === 0)
          : link.kind === 'pump'
            ? +(head[to[l]!]! - head[from[l]!]! > link.shutoffHead || flow[l]! < 0)
            : 0;
      if (closed[l]) {
        flow[l] = 0;
        continue;
      }
      const [h, d] = loss(l, flow[l]!);
      lossNow[l] = h;
      gradient[l] = d;
    }
    // Newton on h_l(q) = H_from - H_to: q_new = q - (h_l - (H_from,new - H_to,new)) / h_l'(q).
    for (const i of unknown) rhs[row[i]!] = -demand[i]!;
    for (let l = 0; l < m; l++) {
      if (closed[l]) continue;
      const a = from[l]!,
        b = to[l]!,
        w = 1 / gradient[l]!,
        base = flow[l]! - w * lossNow[l]!;
      const ra = row[a]!,
        rb = row[b]!;
      // The new flow is base + w (H_a - H_b). Continuity (outflow - inflow + demand = 0) at each junction then reads
      // S H = -demand - outgoing bases + incoming bases, with the reservoir heads moved to the right-hand side.
      if (ra >= 0) {
        rhs[ra] -= base;
        matrix[ra * size + ra] += w;
        if (rb >= 0) matrix[ra * size + rb] -= w;
        else rhs[ra] += w * head[b]!;
      }
      if (rb >= 0) {
        rhs[rb] += base;
        matrix[rb * size + rb] += w;
        if (ra >= 0) matrix[rb * size + ra] -= w;
        else rhs[rb] += w * head[a]!;
      }
    }
    // The system is S H_new = rhs (S symmetric positive definite): solve by Cholesky.
    const heads = cholesky(matrix, rhs, size);
    let change = 0;
    for (const i of unknown) head[i] = heads[row[i]!]!;
    for (let l = 0; l < m; l++) {
      if (closed[l]) continue;
      const a = from[l]!,
        b = to[l]!,
        w = 1 / gradient[l]!,
        next = flow[l]! - w * (lossNow[l]! - (head[a]! - head[b]!));
      change = Math.max(change, Math.abs(next - flow[l]!));
      flow[l] = next;
    }
    continuity = 0;
    const net = new Float64Array(n);
    for (let l = 0; l < m; l++) {
      net[from[l]!] -= flow[l]!;
      net[to[l]!] += flow[l]!;
    }
    for (const i of unknown) continuity = Math.max(continuity, Math.abs(net[i]! - demand[i]!));
    if (change <= tolerance && continuity <= tolerance * Math.max(1, m)) {
      iterations++;
      break;
    }
  }
  if (iterations >= maxIterations && continuity > tolerance * Math.max(1, m))
    throw new MargoError(
      'failed',
      `The pipe network did not converge in ${maxIterations} iterations; check it is connected.`,
    );
  const heads: Record<string, number> = {},
    pressureHeads: Record<string, number> = {},
    flows: Record<string, number> = {},
    speeds: Record<string, number> = {},
    headLosses: Record<string, number> = {};
  network.nodes.forEach((node, i) => {
    heads[node.id] = head[i]!;
    if (node.kind !== 'reservoir') pressureHeads[node.id] = head[i]! - (node.elevation ?? 0);
  });
  links.forEach((link, l) => {
    flows[link.id] = flow[l]!;
    headLosses[link.id] = head[from[l]!]! - head[to[l]!]!;
    if (link.kind === undefined || link.kind === 'pipe') speeds[link.id] = flow[l]! / circleArea(link.diameter);
  });
  return { heads, pressureHeads, flows, speeds, headLosses, iterations, continuityError: continuity };
}

function cholesky(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const l = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let d = a[j * n + j]!;
    for (let k = 0; k < j; k++) d -= l[j * n + k]! * l[j * n + k]!;
    if (!(d > 0))
      throw new MargoError(
        'failed',
        'A pipe network junction is not connected to any reservoir; every junction must connect to one through links.',
      );
    const root = Math.sqrt(d);
    l[j * n + j] = root;
    for (let i = j + 1; i < n; i++) {
      let s = a[i * n + j]!;
      for (let k = 0; k < j; k++) s -= l[i * n + k]! * l[j * n + k]!;
      l[i * n + j] = s / root;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= l[i * n + k]! * y[k]!;
    y[i] = s / l[i * n + i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= l[k * n + i]! * y[k]!;
    y[i] = s / l[i * n + i]!;
  }
  return y;
}
