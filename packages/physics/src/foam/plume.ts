// The bubble plume of air escaping a flooding or sinking hull under water, and the boil it makes where it reaches the
// surface (SEA-10 to SEA-13).
//
// The plume: the integral (top-hat) model of a round bubble plume in still, unstratified water (Morton, Taylor and Turner,
// "Turbulent gravitational convection from maintained and instantaneous sources", Proc. R. Soc. A 234, 1956; for bubbles,
// McDougall 1978, Milgram 1983 and Socolofsky, Bhaumik and Seol 2008, as Dissanayake, Gros and Socolofsky review them,
// "Integral models for bubble, droplet, and multiphase plume dynamics in stratification and crossflow", Environ. Fluid
// Mech. 18, 2018). Going up from the source, z the height above it, with the plume's volume flux Q = pi b^2 u and its
// kinematic momentum flux M = pi b^2 u^2:
//     dQ/dz = 2 pi alpha b u              (entrainment, alpha 0.055: Socolofsky et al.'s inner bubble plume)
//     dM/dz = g Q_g(z) / (u + u_s)         (the bubbles' buoyancy: the gas in a metre of plume, rising at u + u_s)
// with Q_g the gas's volume flux at the local pressure (it expands as it rises, isothermally) and u_s the bubbles' slip,
// 0.23 m/s for millimetre air bubbles (Wuest, Brooks and Imboden 1992, as Einarsrud and Brevik restate it). It starts at
// the breach's size with the inner plume's Froude number 1.6 (Socolofsky et al. 2008) and is stepped by RK4.
//
// The boil: Fannelop and Sjoen's surface flow ("Hydrodynamics of underwater blowouts", AIAA 1980), as Milgram and
// Burgess restate and test it ("Measurements of the surface flow above round bubble plumes", Applied Ocean Research 6,
// 1984): from r_i = 2 b, b the plume's radius where it reaches the surface, a radial current V(r) exp(-z^2 / h(r)^2) that
// keeps its momentum flux and entrains beta V a unit area,
//     V(r) = V_i [1 + (2 beta r_i / (sqrt(pi) h_i)) ((r / r_i)^2 - 1)]^(-1/2),   h(r) = h_i (r_i / r) [same bracket],
// with its mass and momentum fluxes at r_i those of the plume (V_i = sqrt(2) u, h_i = Q / (pi^(3/2) V_i r_i)) and beta
// 0.061, Milgram and Burgess's mean over their and Fannelop and Sjoen's measurements (it rises with the gas rate and falls
// with depth).

import { pow } from '@margoengine/math/pinned';

/** Socolofsky et al.'s (2008) entrainment coefficient of a bubble plume's inner plume (top-hat). */
export const PLUME_ENTRAINMENT = 0.055;
/** Millimetre air bubbles' slip velocity in water, m/s (Wuest et al. 1992). */
export const BUBBLE_SLIP = 0.23;
/** Milgram and Burgess's (1984) mean entrainment coefficient of the surface flow. */
export const SURFACE_ENTRAINMENT = 0.061;

/** Where a bubble plume reaches the surface: its radius (m), its speed (m/s) and its volume flux (m^3/s). */
export interface SurfacingPlume {
  readonly radius: number;
  readonly speed: number;
  readonly flux: number;
}

/** Settings of {@link bubblePlume}; each has a default. */
export interface BubblePlumeOptions {
  /** The plume's radius at its source, m (default 0.05). */
  readonly source?: number;
  /** Entrainment coefficient (default {@link PLUME_ENTRAINMENT}). */
  readonly entrainment?: number;
  /** Bubble slip velocity, m/s (default {@link BUBBLE_SLIP}). */
  readonly slip?: number;
  /** Whether the gas expands as it rises (default true); the atmosphere's pressure, Pa, and the water's density. */
  readonly expands?: boolean;
  readonly atmosphere?: number;
  readonly density?: number;
  /** Gravity, m/s^2 (default 9.81). */
  readonly g?: number;
  /** RK4 steps from the source up (default 400). */
  readonly steps?: number;
  /** Called at each step's end with the height above the source, the plume's radius and its speed (for tests). */
  readonly visit?: (z: number, radius: number, speed: number) => void;
}

/**
 * The plume of `gas` m^3/s of air (at the atmosphere's pressure) let out `depth` m under the surface, where it reaches the
 * surface.
 */
export function bubblePlume(depth: number, gas: number, options: BubblePlumeOptions = {}): SurfacingPlume {
  const {
    source = 0.05,
    entrainment: alpha = PLUME_ENTRAINMENT,
    slip = BUBBLE_SLIP,
    expands = true,
    atmosphere = 101325,
    density = 1025,
    g = 9.81,
    steps = 400,
    visit,
  } = options;
  if (!(depth > 0 && gas > 0 && source > 0 && alpha > 0 && slip >= 0 && g > 0 && Number.isFinite(depth + gas)))
    throw new RangeError(
      `A bubble plume needs a depth, a gas rate, a source radius, an entrainment and gravity above 0 and a slip of 0 or more (got depth ${depth} m, gas ${gas} m^3/s).`,
    );
  // The gas's volume flux at height z above the source (its pressure falls as it rises).
  const gasAt = (z: number) =>
    expands ? (gas * atmosphere) / (atmosphere + density * g * Math.max(0, depth - z)) : gas;
  // The start: radius `source`, speed with the inner plume's Froude number 1.6 against the gas's reduced gravity there.
  let u = 0.5;
  for (let k = 0; k < 40; k++) {
    const voids = gasAt(0) / (Math.PI * source * source * (u + slip));
    u = 1.6 * Math.sqrt(g * voids * source);
  }
  let q = Math.PI * source * source * u,
    m = q * u;
  const rate = (z: number, qq: number, mm: number): [number, number] => {
    const uu = mm / qq,
      b = Math.sqrt(qq / (Math.PI * uu));
    return [2 * Math.PI * alpha * b * uu, (g * gasAt(z)) / (uu + slip)];
  };
  const h = depth / steps;
  for (let i = 0; i < steps; i++) {
    const z = i * h,
      [a1, b1] = rate(z, q, m),
      [a2, b2] = rate(z + h / 2, q + (h / 2) * a1, m + (h / 2) * b1),
      [a3, b3] = rate(z + h / 2, q + (h / 2) * a2, m + (h / 2) * b2),
      [a4, b4] = rate(z + h, q + h * a3, m + h * b3);
    q += (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
    m += (h / 6) * (b1 + 2 * b2 + 2 * b3 + b4);
    if (visit) {
      const speed = m / q;
      visit(z + h, Math.sqrt(q / (Math.PI * speed)), speed);
    }
  }
  const speed = m / q;
  return { radius: Math.sqrt(q / (Math.PI * speed)), speed, flux: q };
}

/**
 * The surface current of a bubble plume's boil at `r` m from its centre, m/s, and the depth of the moving layer, m
 * (Fannelop and Sjoen): from twice the plume's radius out; inside it, the speed there.
 */
export function surfaceCurrent(
  plume: SurfacingPlume,
  r: number,
  beta = SURFACE_ENTRAINMENT,
): { readonly speed: number; readonly depth: number } {
  const ri = 2 * plume.radius,
    vi = Math.SQRT2 * plume.speed,
    hi = plume.flux / (pow(Math.PI, 1.5) * vi * ri),
    x = r > ri ? r / ri : 1,
    bracket = 1 + ((2 * beta * ri) / (Math.sqrt(Math.PI) * hi)) * (x * x - 1);
  return { speed: vi / Math.sqrt(bracket), depth: (hi / x) * bracket };
}
