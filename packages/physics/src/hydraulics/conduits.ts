// Closed conduits for the hydraulics entry (HYDRO-07): friction, losses, pipes, orifices, basins that equalise
// through an opening, Venturi meters, siphons and the water-hammer relations. Clean room, from the published sources:
// - C. F. Colebrook, "Turbulent flow in pipes, with particular reference to the transition region between the smooth
//   and rough pipe laws", J. Inst. Civil Eng. 11, 133-156 (1939);
// - S. E. Haaland, "Simple and explicit formulas for the friction factor in turbulent pipe flow", J. Fluids Eng.
//   105(1), 89-90 (1983);
// - S. W. Churchill, "Friction-factor equation spans all fluid-flow regimes", Chemical Engineering 84(24), 91-92 (1977);
// - ISO 5167-4:2003, "Measurement of fluid flow by means of pressure differential devices, part 4: Venturi tubes"
//   (discharge coefficients 0.995 machined, 0.984 as-cast, 0.985 rough-welded convergent);
// - N. Joukowsky, "Über den hydraulischen Stoss in Wasserleitungsröhren" (1898; trans. O. Simin, Proc. AWWA 24, 1904);
// - E. B. Wylie and V. L. Streeter, "Fluid Transients in Systems", Prentice Hall (1993), chapter 2 (wave speed in thin
//   elastic pipes with the three restraint cases);
// - F. M. White, "Fluid Mechanics", 7th ed., McGraw-Hill (2011), sections 3.5 (Bernoulli), 6.6-6.9 (pipe flow and
//   minor losses) and 6.12 (flow meters), for the energy equation the solvers below close.
import { MargoError } from '@margoengine/math/errors';
import { ln, pow } from '@margoengine/math/pinned';
import { circleArea, finite, GRAVITY, type Liquid, LN10, nonNegative, positive, WATER, ATMOSPHERE } from './fluid.js';

/** Friction-factor law for {@link darcyFriction}. */
export type FrictionLaw = 'churchill' | 'colebrook' | 'haaland';

/** Reynolds number of a pipe flow: speed × diameter / kinematic viscosity. */
export function reynoldsNumber(speed: number, diameter: number, liquid: Liquid = WATER): number {
  return (Math.abs(finite('speed', speed)) * positive('diameter', diameter)) / liquid.kinematicViscosity;
}

const log10 = (x: number): number => ln(x) / LN10;

function haalandX(reynolds: number, relativeRoughness: number): number {
  return -1.8 * log10(pow(relativeRoughness / 3.7, 1.11) + 6.9 / reynolds);
}

/**
 * Darcy-Weisbach friction factor f for a full circular pipe.
 * - `'churchill'` (default): one smooth law across laminar, transitional and turbulent flow (Churchill 1977).
 * - `'colebrook'`: 64/Re below Re 2000, the Colebrook (1939) equation solved by Newton's method above.
 * - `'haaland'`: 64/Re below Re 2000, Haaland's (1983) explicit fit to Colebrook (within about 1.5 percent) above.
 * Returns 0 for Re 0 (no flow, no friction term).
 */
export function darcyFriction(reynolds: number, relativeRoughness = 0, law: FrictionLaw = 'churchill'): number {
  nonNegative('reynolds', reynolds);
  nonNegative('relativeRoughness', relativeRoughness);
  if (reynolds === 0) return 0;
  // Deep in the laminar range Churchill's terms overflow a double while the law equals 64/Re to 1 part in 10^9.
  if (law === 'churchill' && reynolds < 10) return 64 / reynolds;
  if (law === 'churchill') {
    const a = pow(2.457 * ln(1 / (pow(7 / reynolds, 0.9) + 0.27 * relativeRoughness)), 16);
    const b = pow(37530 / reynolds, 16);
    return 8 * pow(pow(8 / reynolds, 12) + pow(a + b, -1.5), 1 / 12);
  }
  if (law !== 'colebrook' && law !== 'haaland')
    throw new RangeError(`Friction law '${String(law)}' is unknown; use 'churchill', 'colebrook' or 'haaland'.`);
  if (reynolds < 2000) return 64 / reynolds;
  let x = haalandX(reynolds, relativeRoughness);
  if (law === 'haaland') return 1 / (x * x);
  const k = relativeRoughness / 3.7,
    c = 2.51 / reynolds;
  for (let i = 0; i < 50; i++) {
    const inner = k + c * x;
    const g = x + 2 * log10(inner);
    const dx = g / (1 + (2 * c) / (LN10 * inner));
    x -= dx;
    if (Math.abs(dx) <= 1e-15 * x) return 1 / (x * x);
  }
  throw new MargoError('failed', `Colebrook did not converge at Re ${reynolds}; check the roughness and Reynolds number.`);
}

/** A circular pipe run: friction over its length plus lumped fittings. */
export interface PipeRun {
  /** Inside diameter, m. */
  readonly diameter: number;
  /** Length along the axis, m. Default 0 (fittings only). */
  readonly length?: number;
  /** Absolute wall roughness, m. Default 0 (hydraulically smooth; drawn copper or glass is about 1.5e-6). */
  readonly roughness?: number;
  /** Sum of the fitting loss coefficients K (entrance, bends, valves), each on the velocity head. Default 0. */
  readonly minorLoss?: number;
  /** Friction law. Default `'churchill'`. */
  readonly friction?: FrictionLaw;
  /** A fixed Darcy friction factor in place of the law (for a hand calculation or a test). */
  readonly frictionFactor?: number;
  /** The liquid. Default water at 20 °C. */
  readonly liquid?: Liquid;
  /** Gravity magnitude, m/s². Default 9.81. */
  readonly gravity?: number;
}

/** Losses along a {@link PipeRun} at one mean speed. */
export interface PipeLoss {
  readonly reynolds: number;
  /** Darcy friction factor used. */
  readonly frictionFactor: number;
  /** Friction plus fitting head loss, m of liquid. */
  readonly headLoss: number;
  /** The same loss as a pressure, Pa. */
  readonly pressureLoss: number;
  /** Velocity head v²/2g, m. */
  readonly velocityHead: number;
}

/** Head lost along a pipe run at mean speed `speed` (m/s): (fL/D + ΣK) v²/2g, the Darcy-Weisbach equation. */
export function pipeLoss(run: PipeRun, speed: number): PipeLoss {
  const liquid = run.liquid ?? WATER,
    g = positive('gravity', run.gravity ?? GRAVITY),
    d = positive('diameter', run.diameter),
    length = nonNegative('length', run.length ?? 0),
    minor = nonNegative('minorLoss', run.minorLoss ?? 0);
  const reynolds = reynoldsNumber(speed, d, liquid);
  const f =
    run.frictionFactor !== undefined
      ? nonNegative('frictionFactor', run.frictionFactor)
      : darcyFriction(reynolds, nonNegative('roughness', run.roughness ?? 0) / d, run.friction);
  const velocityHead = (speed * speed) / (2 * g);
  const headLoss = ((f * length) / d + minor) * velocityHead;
  return { reynolds, frictionFactor: f, headLoss, pressureLoss: headLoss * liquid.density * g, velocityHead };
}

/** Steady flow through a pipe run driven by a head. */
export interface PipeFlow extends PipeLoss {
  /** Mean speed, m/s. */
  readonly speed: number;
  /** Volume flow, m³/s. */
  readonly flow: number;
  /** Driving head, m. */
  readonly head: number;
}

/**
 * Steady flow through one pipe run between two free surfaces `head` metres apart: the energy equation
 * head = (exitLoss + fL/D + ΣK) v²/2g, solved for v by bisection to the last bit. `exitLoss` is 1 for a free jet or a
 * submerged exit (the leaving velocity head is lost either way). A negative head runs the flow backwards.
 */
export function pipeFlow(run: PipeRun & { readonly head: number; readonly exitLoss?: number }): PipeFlow {
  const head = finite('head', run.head),
    exitLoss = nonNegative('exitLoss', run.exitLoss ?? 1),
    g = positive('gravity', run.gravity ?? GRAVITY),
    sign = Math.sign(head),
    h = Math.abs(head);
  const total = (v: number): number => exitLoss * ((v * v) / (2 * g)) + pipeLoss(run, v).headLoss;
  let speed = 0;
  if (h > 0) {
    let low = 0,
      high = 1;
    while (total(high) < h) {
      high *= 2;
      if (!Number.isFinite(high) || high > 1e9)
        throw new MargoError('failed', 'Pipe flow has no finite speed; give the run a length, an exit loss or a fitting loss.');
    }
    for (let i = 0; i < 200 && high - low > 1e-15 * high; i++) {
      const mid = 0.5 * (low + high);
      if (total(mid) < h) low = mid;
      else high = mid;
    }
    speed = 0.5 * (low + high);
  }
  const loss = pipeLoss(run, speed);
  return { ...loss, speed: sign * speed, flow: sign * speed * circleArea(run.diameter), head };
}

/** Flow through a sharp-edged orifice or a valve opening. */
export interface OrificeInput {
  /** Opening area, m². */
  readonly area: number;
  /** Head difference across the opening, m (negative reverses the flow). Give this or `pressureDifference`. */
  readonly head?: number;
  /** Pressure difference across the opening, Pa. */
  readonly pressureDifference?: number;
  /** Discharge coefficient Cd. Default 0.61, a sharp-edged round orifice (White 2011, section 6.12). */
  readonly dischargeCoefficient?: number;
  readonly liquid?: Liquid;
  readonly gravity?: number;
}

/** Discharge through an orifice: Q = Cd A √(2 g h) (Torricelli with a discharge coefficient). */
export interface OrificeFlow {
  /** Volume flow, m³/s, signed with the head. */
  readonly flow: number;
  /** Ideal jet speed √(2 g h), m/s (Torricelli), signed with the head. */
  readonly idealSpeed: number;
  /** Head used, m. */
  readonly head: number;
}

/** Torricelli efflux through an opening: Q = Cd A √(2 g h). */
export function orificeFlow(input: OrificeInput): OrificeFlow {
  const liquid = input.liquid ?? WATER,
    g = positive('gravity', input.gravity ?? GRAVITY),
    area = nonNegative('area', input.area),
    cd = positive('dischargeCoefficient', input.dischargeCoefficient ?? 0.61);
  const head =
    input.head !== undefined
      ? finite('head', input.head)
      : finite('pressureDifference', input.pressureDifference ?? Number.NaN) / (liquid.density * g);
  const idealSpeed = Math.sign(head) * Math.sqrt(2 * g * Math.abs(head));
  return { flow: cd * area * idealSpeed, idealSpeed, head };
}

/**
 * The orifice conductance Cd A √(2/ρ) in m³/s per √Pa, so that Q = conductance × √Δp. Lumped models such as
 * {@link HydraulicRam} take their valves in this form.
 */
export function orificeConductance(area: number, dischargeCoefficient = 0.61, liquid: Liquid = WATER): number {
  return nonNegative('area', area) * positive('dischargeCoefficient', dischargeCoefficient) * Math.sqrt(2 / liquid.density);
}

/** Two basins joined by an opening below both surfaces, such as a lock chamber and its river through a sluice. */
export interface EqualizeInput {
  /** Plan area of the basin whose level is followed, m². */
  readonly area: number;
  /** Its initial surface level, m. */
  readonly level: number;
  /** The other basin's initial level, m. */
  readonly otherLevel: number;
  /** The other basin's plan area, m². Default infinite (a river or sea that does not move). */
  readonly otherArea?: number;
  /** Opening area, m². */
  readonly openingArea: number;
  /** Discharge coefficient of the opening. Default 0.61. */
  readonly dischargeCoefficient?: number;
  /** Time since the opening opened, s. */
  readonly time: number;
  readonly gravity?: number;
}

/** State of two equalising basins at one time. */
export interface Equalization {
  /** The followed basin's level, m. */
  readonly level: number;
  /** The other basin's level, m. */
  readonly otherLevel: number;
  /** Flow into the followed basin, m³/s (negative while it drains). */
  readonly flow: number;
  /** Volume moved into the followed basin since the opening opened, m³ (negative while it drains). */
  readonly volume: number;
  /** Time from opening to equal levels, s. */
  readonly duration: number;
}

/**
 * Two basins equalising through an opening, in closed form. With D the level difference, quasi-steady orifice flow
 * gives dD/dt = -Cd a √(2 g D) (1/A₁ + 1/A₂), so √D falls linearly: √D(t) = √D₀ - Cd a √(2g) (1/A₁ + 1/A₂) t / 2.
 */
export function equalize(input: EqualizeInput): Equalization {
  const g = positive('gravity', input.gravity ?? GRAVITY),
    area = positive('area', input.area),
    otherArea = input.otherArea === undefined || input.otherArea === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : positive('otherArea', input.otherArea),
    opening = nonNegative('openingArea', input.openingArea),
    cd = positive('dischargeCoefficient', input.dischargeCoefficient ?? 0.61),
    level = finite('level', input.level),
    other = finite('otherLevel', input.otherLevel),
    time = Math.max(0, finite('time', input.time));
  const difference = other - level,
    sign = Math.sign(difference),
    d0 = Math.abs(difference),
    inverse = 1 / area + (Number.isFinite(otherArea) ? 1 / otherArea : 0),
    rate = cd * opening * Math.sqrt(2 * g) * 0.5 * inverse;
  const duration = d0 === 0 ? 0 : rate > 0 ? Math.sqrt(d0) / rate : Number.POSITIVE_INFINITY;
  const root = Math.max(0, Math.sqrt(d0) - rate * time),
    remaining = root * root,
    moved = (d0 - remaining) / inverse;
  return {
    level: level + (sign * moved) / area,
    otherLevel: Number.isFinite(otherArea) ? other - (sign * moved) / otherArea : other,
    flow: sign * cd * opening * Math.sqrt(2 * g) * root,
    volume: sign * moved,
    duration,
  };
}

/** A Venturi tube between an inlet section and its throat. */
export interface VenturiInput {
  /** Inlet (upstream tapping) diameter, m. */
  readonly inletDiameter: number;
  /** Throat diameter, m. */
  readonly throatDiameter: number;
  /**
   * Discharge coefficient C. Default 0.995, the ISO 5167-4 value for a machined convergent (0.984 as-cast, 0.985
   * rough-welded sheet iron); 1 gives ideal Bernoulli.
   */
  readonly dischargeCoefficient?: number;
  readonly liquid?: Liquid;
  readonly gravity?: number;
}

/** Venturi readings at one flow. */
export interface VenturiReading {
  /** Volume flow, m³/s. */
  readonly flow: number;
  /** Mean speed at the inlet section, m/s. */
  readonly inletSpeed: number;
  /** Mean speed at the throat, m/s. */
  readonly throatSpeed: number;
  /** Inlet minus throat pressure, Pa. */
  readonly pressureDrop: number;
  /** The drop as a column of the liquid, m (what a piezometer pair shows). */
  readonly dropHead: number;
  /** Diameter ratio β = d/D. */
  readonly beta: number;
}

function venturiSetup(input: VenturiInput) {
  const big = positive('inletDiameter', input.inletDiameter),
    small = positive('throatDiameter', input.throatDiameter);
  if (small >= big) throw new RangeError(`Venturi throat ${small} m must be narrower than its inlet ${big} m.`);
  const beta = small / big,
    cd = positive('dischargeCoefficient', input.dischargeCoefficient ?? 0.995);
  return {
    beta,
    cd,
    inletArea: circleArea(big),
    throatArea: circleArea(small),
    liquid: input.liquid ?? WATER,
    g: positive('gravity', input.gravity ?? GRAVITY),
  };
}

function reading(s: ReturnType<typeof venturiSetup>, flow: number, drop: number): VenturiReading {
  return {
    flow,
    inletSpeed: flow / s.inletArea,
    throatSpeed: flow / s.throatArea,
    pressureDrop: drop,
    dropHead: drop / (s.liquid.density * s.g),
    beta: s.beta,
  };
}

/** Pressure drop across a Venturi at a known flow: Δp = (ρ/2)(1 - β⁴)(Q / (C A_t))² (ISO 5167-1 and 5167-4). */
export function venturi(input: VenturiInput & { readonly flow: number }): VenturiReading {
  const s = venturiSetup(input),
    q = finite('flow', input.flow),
    ideal = q / (s.cd * s.throatArea);
  return reading(s, q, 0.5 * s.liquid.density * (1 - s.beta * s.beta * s.beta * s.beta) * ideal * Math.abs(ideal));
}

/** The flow a Venturi meter reads from its pressure drop: Q = C A_t √(2 Δp / (ρ (1 - β⁴))). */
export function venturiFlow(input: VenturiInput & { readonly pressureDrop: number }): VenturiReading {
  const s = venturiSetup(input),
    dp = finite('pressureDrop', input.pressureDrop),
    b4 = s.beta * s.beta * s.beta * s.beta;
  const q = Math.sign(dp) * s.cd * s.throatArea * Math.sqrt((2 * Math.abs(dp)) / (s.liquid.density * (1 - b4)));
  return reading(s, q, dp);
}

/** Positions of a marked parcel carried by plug flow along a conduit whose area changes with x. */
export interface PlugTracer {
  /** Volume between `start` and `end`, m³. */
  readonly volume: number;
  /** The axial position of a parcel that has moved `passed` m³ from `start` (clamped to the conduit). */
  positionAt(passed: number): number;
  /** The volume between `start` and `x`, m³. */
  volumeTo(x: number): number;
}

/**
 * A plug-flow tracer: continuity makes a parcel's axial speed Q / A(x), so the volume behind it is the integral of
 * A(x) dx. The integral is tabulated with the trapezoid rule over `steps` panels and inverted exactly on each panel's
 * linear area profile.
 */
export function plugTracer(areaAt: (x: number) => number, start: number, end: number, steps = 640): PlugTracer {
  finite('start', start);
  finite('end', end);
  if (!(end > start)) throw new RangeError(`Tracer end ${end} must lie beyond its start ${start}.`);
  if (!Number.isInteger(steps) || steps < 1) throw new RangeError(`Tracer steps must be a positive integer; got ${steps}.`);
  const dx = (end - start) / steps,
    area = new Float64Array(steps + 1),
    table = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) area[i] = positive('area', areaAt(start + i * dx));
  for (let i = 1; i <= steps; i++) table[i] = table[i - 1]! + 0.5 * dx * (area[i - 1]! + area[i]!);
  const volume = table[steps]!;
  return {
    volume,
    positionAt(passed) {
      const target = Math.max(0, Math.min(volume, finite('passed', passed)));
      let left = 0,
        right = steps;
      while (right - left > 1) {
        const mid = (left + right) >> 1;
        if (table[mid]! <= target) left = mid;
        else right = mid;
      }
      const scaled = (target - table[left]!) / dx,
        a = area[left]!,
        delta = area[right]! - a;
      return start + dx * (left + (2 * scaled) / (a + Math.sqrt(a * a + 2 * delta * scaled)));
    },
    volumeTo(x) {
      const at = Math.max(0, Math.min(steps, (finite('x', x) - start) / dx)),
        i = Math.min(steps - 1, Math.floor(at)),
        f = at - i,
        a = area[i]!,
        b = a + (area[i + 1]! - a) * f;
      return table[i]! + 0.5 * f * dx * (a + b);
    },
  };
}

/** A primed siphon between two free surfaces. */
export interface SiphonInput extends PipeRun {
  /** Height of the supply surface above the outlet (or the receiving surface for a submerged outlet), m. */
  readonly drop: number;
  /** Height of the crown's centreline above the supply surface, m. */
  readonly crownRise: number;
  /** Pipe length from the inlet to the crown, m. Default half of `length`. */
  readonly crownLength?: number;
  /** Fitting losses between the inlet and the crown (entrance, bends). Default half of `minorLoss`. */
  readonly crownMinorLoss?: number;
  /** Atmospheric pressure on both surfaces, Pa. Default 101325. */
  readonly atmosphere?: number;
}

/** Steady state of a siphon. */
export interface Siphon extends PipeFlow {
  /** Gauge pressure at the crown, Pa (negative: below atmospheric). */
  readonly crownPressure: number;
  /** Absolute pressure at the crown, Pa. */
  readonly crownAbsolutePressure: number;
  /** True when the crown falls to the liquid's vapour pressure: the column breaks and this flow is not reached. */
  readonly cavitates: boolean;
  /** The highest crown rise above the supply that keeps the crown above vapour pressure at this flow, m. */
  readonly crownLimit: number;
}

/**
 * A primed siphon: the energy equation from the supply surface to the outlet sets the flow ({@link pipeFlow}), and the
 * same equation to the crown sets its pressure, p_c = p_a - ρ g (z_c + (1 + ΣK_c + f L_c/D) v²/2g). The siphon limit
 * is the crown rise that brings p_c to the vapour pressure; at zero flow it is (p_a - p_v)/(ρ g), about 10.1 m for
 * water at 20 °C.
 */
export function siphon(input: SiphonInput): Siphon {
  const liquid = input.liquid ?? WATER,
    g = positive('gravity', input.gravity ?? GRAVITY),
    atmosphere = positive('atmosphere', input.atmosphere ?? ATMOSPHERE),
    rise = finite('crownRise', input.crownRise);
  const flow = pipeFlow({ ...input, head: Math.max(0, finite('drop', input.drop)), exitLoss: 1 });
  const toCrown = pipeLoss(
    {
      ...input,
      length: nonNegative('crownLength', input.crownLength ?? 0.5 * (input.length ?? 0)),
      minorLoss: nonNegative('crownMinorLoss', input.crownMinorLoss ?? 0.5 * (input.minorLoss ?? 0)),
    },
    flow.speed,
  );
  const crownHead = toCrown.velocityHead + toCrown.headLoss,
    weight = liquid.density * g,
    crownPressure = -weight * (rise + crownHead);
  return {
    ...flow,
    crownPressure,
    crownAbsolutePressure: atmosphere + crownPressure,
    cavitates: atmosphere + crownPressure <= liquid.vaporPressure,
    crownLimit: (atmosphere - liquid.vaporPressure) / weight - crownHead,
  };
}

/** Restraint of a pipe against axial stress, for {@link pipeWaveSpeed} (Wylie and Streeter 1993, section 2.6). */
export type PipeRestraint = 'expansion-joints' | 'anchored' | 'anchored-upstream';

/** A thin-walled elastic pipe full of liquid. */
export interface ElasticPipe {
  readonly diameter: number;
  /** Wall thickness, m. */
  readonly wallThickness: number;
  /** Wall Young's modulus, Pa (steel about 207e9, PVC about 3e9). */
  readonly youngsModulus: number;
  /** Wall Poisson ratio. Default 0.3. */
  readonly poissonRatio?: number;
  /** Axial restraint. Default `'expansion-joints'`. */
  readonly restraint?: PipeRestraint;
  readonly liquid?: Liquid;
}

/**
 * Pressure-wave speed in a liquid-filled elastic pipe: a = √((K/ρ) / (1 + c K D / (E e))), with c = 1 for expansion
 * joints throughout, 1 - ν² for a pipe anchored throughout and 1 - ν/2 for one anchored at its upstream end only.
 */
export function pipeWaveSpeed(pipe: ElasticPipe): number {
  const liquid = pipe.liquid ?? WATER,
    nu = finite('poissonRatio', pipe.poissonRatio ?? 0.3),
    restraint = pipe.restraint ?? 'expansion-joints';
  const c =
    restraint === 'expansion-joints' ? 1 : restraint === 'anchored' ? 1 - nu * nu : restraint === 'anchored-upstream' ? 1 - nu / 2 : NaN;
  if (Number.isNaN(c))
    throw new RangeError(`Pipe restraint '${String(restraint)}' is unknown; use 'expansion-joints', 'anchored' or 'anchored-upstream'.`);
  const k = liquid.bulkModulus,
    ratio = (c * k * positive('diameter', pipe.diameter)) / (positive('youngsModulus', pipe.youngsModulus) * positive('wallThickness', pipe.wallThickness));
  return Math.sqrt(k / liquid.density / (1 + ratio));
}

/**
 * Joukowsky's water-hammer surge: Δp = ρ a Δv for a valve closed faster than the pipe's round trip 2L/a.
 * Returns the pressure rise in Pa for a speed change `velocityChange` (m/s) at wave speed `waveSpeed` (m/s).
 */
export function joukowsky(waveSpeed: number, velocityChange: number, liquid: Liquid = WATER): number {
  return liquid.density * positive('waveSpeed', waveSpeed) * finite('velocityChange', velocityChange);
}

/** A vertical free jet after falling `fall` m from a nozzle where it moved at `speed` m/s. */
export interface FallenJet {
  /** Speed after the fall, √(v₀² + 2 g h), m/s. */
  readonly speed: number;
  /** Cross-section area over the nozzle's, v₀ / v (continuity); the radius scales by its square root. */
  readonly areaRatio: number;
}

/** A falling jet speeds up under gravity and, by continuity, narrows (Bernoulli along the free jet in air). */
export function jetAfterFall(speed: number, fall: number, gravity = GRAVITY): FallenJet {
  const v0 = nonNegative('speed', speed),
    v = Math.sqrt(v0 * v0 + 2 * positive('gravity', gravity) * nonNegative('fall', fall));
  return { speed: v, areaRatio: v > 0 ? v0 / v : 1 };
}

/** Free-surface liquid jet: the point a parcel reaches `time` seconds after leaving `origin` at `velocity`. */
export function jetPoint(
  origin: readonly [number, number, number],
  velocity: readonly [number, number, number],
  time: number,
  gravity = GRAVITY,
): [number, number, number] {
  return [
    origin[0] + velocity[0] * time,
    origin[1] + velocity[1] * time - 0.5 * gravity * time * time,
    origin[2] + velocity[2] * time,
  ];
}

