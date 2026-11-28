// Gas leaving a soft shell through a hole (SOFT-06): the isentropic flow of an ideal gas through an orifice, taken down by a
// discharge coefficient, and the thrust of its jet; the shell's gas stays at one temperature (src/volume.rs).
//
// Through an orifice of area A from p0 inside to pa outside, with r = pa / p0 and r* = (2 / (gamma + 1))^(gamma / (gamma - 1))
// the critical ratio (0.528 for air), the mass flow is Cd A p0 sqrt(2 gamma / ((gamma - 1) R T)) sqrt(r^(2/gamma) -
// r^((gamma+1)/gamma)) while r > r*, and once choked Cd A p0 sqrt(gamma / (R T)) (2 / (gamma + 1))^((gamma+1) / (2 (gamma-1)))
// (Ascher H. Shapiro, "The Dynamics and Thermodynamics of Compressible Fluid Flow", vol. 1, Ronald Press 1953, ch. 4; John D.
// Anderson, "Modern Compressible Flow", 3rd ed., McGraw-Hill 2003, ch. 5). The jet leaves the throat at
// u = sqrt(2 gamma / (gamma - 1) R T (1 - r_t^((gamma-1)/gamma))), r_t = max(r, r*), at the throat pressure r_t p0, so it
// pushes the shell back by mdot u + (r_t p0 - pa) Cd A. The default discharge coefficient, 0.61, is the free jet from a
// sharp-edged hole in a thin wall: Kirchhoff's free-streamline contraction pi / (pi + 2) = 0.611 (G. Kirchhoff, "Zur Theorie
// freier Fluessigkeitsstrahlen", J. reine angew. Math. 70, 1869), against the 0.596 the Reader-Harris/Gallagher equation of
// ISO 5167-2:2003 gives an orifice plate as its diameter ratio and the Reynolds number's inverse go to 0.

/** A hole in a soft shell that holds a gas (see {@link SoftBody.openVent}). */
export interface SoftVentOptions {
  /** The particle the hole is at: the jet leaves along the surface's outward normal there. */
  readonly particle: number;
  /** The hole's area in m². */
  readonly area: number;
  /** The share of the ideal flow that passes (default 0.61, a sharp-edged hole in a thin wall), above 0 and at most 1. */
  readonly dischargeCoefficient?: number;
  /** The gas's specific gas constant in J/(kg K) (default 287.05, dry air). */
  readonly gasConstant?: number;
  /** The gas's temperature in K (default 293.15). */
  readonly temperature?: number;
  /** The gas's ratio of specific heats (default 1.4, air), above 1. */
  readonly heatCapacityRatio?: number;
}

/** A vent's settings, all resolved. */
export interface SoftVent {
  readonly particle: number;
  readonly area: number;
  readonly dischargeCoefficient: number;
  readonly gasConstant: number;
  readonly temperature: number;
  readonly heatCapacityRatio: number;
}

/** The mass flow in kg/s out through a vent from `inside` to `outside` (Pa, absolute); 0 when the gas would flow in. */
export function ventFlow(vent: SoftVent, inside: number, outside: number): number {
  if (!(inside > outside)) return 0;
  const g = vent.heatCapacityRatio,
    rt = vent.gasConstant * vent.temperature,
    critical = (2 / (g + 1)) ** (g / (g - 1)),
    ratio = outside / inside,
    open = vent.dischargeCoefficient * vent.area * inside;
  if (ratio <= critical) return open * Math.sqrt(g / rt) * (2 / (g + 1)) ** ((g + 1) / (2 * (g - 1)));
  return open * Math.sqrt(((2 * g) / ((g - 1) * rt)) * (ratio ** (2 / g) - ratio ** ((g + 1) / g)));
}

/** The jet's push back on the shell in N, at a given flow, from `inside` to `outside`. */
export function ventThrust(vent: SoftVent, inside: number, outside: number, flow: number): number {
  if (!(inside > outside) || !(flow > 0)) return 0;
  const g = vent.heatCapacityRatio,
    throat = Math.max(outside / inside, (2 / (g + 1)) ** (g / (g - 1))),
    speed = Math.sqrt(((2 * g) / (g - 1)) * vent.gasConstant * vent.temperature * (1 - throat ** ((g - 1) / g)));
  return flow * speed + (throat * inside - outside) * vent.dischargeCoefficient * vent.area;
}

/**
 * The gas left after `dt` seconds of every vent at volume `volume` (held over the step), as its p V in Pa m³, and the mass
 * that left through each vent (kg). The gas is isothermal at the vents' temperature, so p V falls by R T per kilogram:
 * dp/dt = -(R T / V) sum mdot(p), integrated by the classic fourth-order Runge-Kutta rule in `pieces` parts. The pressure
 * never falls below the air outside.
 */
export function ventStep(
  vents: readonly SoftVent[],
  product: number,
  volume: number,
  outside: number,
  dt: number,
  pieces = 8,
): { product: number; mass: number[] } {
  const rate = (p: number): number => {
    let sum = 0;
    for (const vent of vents) sum += vent.gasConstant * vent.temperature * ventFlow(vent, p, outside);
    return -sum / volume;
  };
  let p = product / volume;
  const start = p,
    h = dt / pieces;
  for (let k = 0; k < pieces && p > outside; k++) {
    const k1 = rate(p),
      k2 = rate(p + (h / 2) * k1),
      k3 = rate(p + (h / 2) * k2),
      k4 = rate(p + h * k3);
    p = Math.max(outside, p + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4));
  }
  // What left is shared among the vents by their flows at the step's mean pressure.
  const mean = (start + p) / 2,
    flows = vents.map((vent) => ventFlow(vent, mean, outside)),
    total = flows.reduce((a, b) => a + b, 0),
    gone = vents.length ? ((start - p) * volume) / (vents[0]!.gasConstant * vents[0]!.temperature) : 0;
  return { product: p * volume, mass: flows.map((f) => (total > 0 ? (gone * f) / total : 0)) };
}
