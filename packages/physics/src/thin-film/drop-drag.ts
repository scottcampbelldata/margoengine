import { exp, ln, pow } from '@margoengine/math/pinned';
import { airViscosity, dragIntegrals, dragRate } from '../airborne/environment.js';

const MIN_TERMINAL_DIAMETER = 0.000019;
const WAKE_TRANSITION = 0.00107;
export const MAX_FLIGHT_DIAMETER = 0.007;

function cube(value: number): number {
  return value * value * value;
}

function steadyWakeRe(d: number, davies: number): number {
  const x = ln(davies * d * d * d);
  const y =
    -3.18657 +
    x *
      (0.992696 + x * (-0.00153193 + x * (-0.000987059 + x * (-0.000578878 + x * (0.0000855176 - x * 0.00000327815)))));
  return exp(y);
}

function unsteadyWakeRe(d: number, bond: number, property: number): number {
  const x = ln(bond * d * d * property);
  const y = -5.00015 + x * (5.23778 + x * (-2.04914 + x * (0.475294 + x * (-0.0542819 + x * 0.00238449))));
  return property * exp(y);
}

/** Water–air resistance, including deformed falling drops in the Beard diameter range. */
export class DropDrag {
  readonly buoyancy: number;
  private readonly viscosity: number;
  private readonly davies: number;
  private readonly bond: number;
  private readonly property: number;
  private readonly reMin: number;
  private readonly reTransition: number;
  private readonly reMax: number;

  constructor(
    private readonly g: number,
    private readonly water: number,
    private readonly air: number,
    private readonly temperature: number,
    surfaceTension: number,
  ) {
    this.buoyancy = 1 - air / water;
    this.viscosity = airViscosity(temperature);
    const viscositySquared = this.viscosity * this.viscosity;
    const densityGravity = (water - air) * g;
    this.davies = (4 * air * densityGravity) / (3 * viscositySquared);
    this.bond = (4 * densityGravity) / (3 * surfaceTension);
    this.property =
      densityGravity > 0
        ? pow((cube(surfaceTension) * air * air) / (viscositySquared * viscositySquared * densityGravity), 1 / 6)
        : 0;
    this.reMin = this.davies > 0 ? steadyWakeRe(MIN_TERMINAL_DIAMETER, this.davies) : 0;
    this.reTransition = this.property > 0 ? unsteadyWakeRe(WAKE_TRANSITION, this.bond, this.property) : 0;
    this.reMax = this.property > 0 ? unsteadyWakeRe(MAX_FLIGHT_DIAMETER, this.bond, this.property) : 0;
  }

  rate(diameter: number, speed: number): number {
    if (this.air === 0) return 0;
    const re = (this.air * diameter * speed) / this.viscosity;
    if (this.g === 0 || re < this.reMin)
      return dragRate(diameter, this.water, this.air, this.viscosity, speed, false, this.temperature);

    // Wang–Pruppacher: use the drag of a terminal drop at the actual instantaneous
    // Reynolds number. Substitute its terminal force balance into the actual drag.
    if (re > this.reMax) {
      const maxSpeed = (this.viscosity * this.reMax) / (this.air * diameter);
      return (this.g * this.buoyancy * cube(MAX_FLIGHT_DIAMETER / diameter) * speed) / (maxSpeed * maxSpeed);
    }
    const small = re <= this.reTransition;
    let low = small ? MIN_TERMINAL_DIAMETER : WAKE_TRANSITION;
    let high = small ? WAKE_TRANSITION : MAX_FLIGHT_DIAMETER;
    for (let i = 0; i < 24; i++) {
      const mid = 0.5 * (low + high);
      const terminal = small ? steadyWakeRe(mid, this.davies) : unsteadyWakeRe(mid, this.bond, this.property);
      if (terminal < re) low = mid;
      else high = mid;
    }
    const equivalent = 0.5 * (low + high);
    return (this.g * this.buoyancy * cube(equivalent / diameter)) / speed;
  }
}

type Vec3 = readonly [number, number, number];

export function midpointDropDrag(
  drop: Float64Array,
  at: number,
  dt: number,
  diameter: number,
  gravity: Vec3,
  air: Vec3,
  drag: DropDrag,
): number {
  const u = drop[at + 3]! - air[0];
  const v = drop[at + 4]! - air[1];
  const w = drop[at + 5]! - air[2];
  const speed = Math.sqrt(u * u + v * v + w * w);
  const [decay, exposure] = dragIntegrals(drag.rate(diameter, speed), 0.5 * dt);
  const midX = decay * u + exposure * gravity[0] * drag.buoyancy;
  const midY = decay * v + exposure * gravity[1] * drag.buoyancy;
  const midZ = decay * w + exposure * gravity[2] * drag.buoyancy;
  const midSpeed = Math.sqrt(midX * midX + midY * midY + midZ * midZ);
  return drag.rate(diameter, midSpeed);
}

export function advanceDrop(
  drop: Float64Array,
  at: number,
  dt: number,
  gravity: Vec3,
  air: Vec3,
  buoyancy: number,
  rate: number,
): void {
  const [velocityDrag, velocityTime, positionTime] = dragIntegrals(rate, dt);
  for (let axis = 0; axis < 3; axis++) {
    const wind = air[axis]!;
    const g = gravity[axis]! * buoyancy;
    const relative = drop[at + 3 + axis]! - wind;
    drop[at + axis]! += wind * dt + relative * velocityTime + g * positionTime;
    drop[at + 3 + axis] = wind + relative * velocityDrag + g * velocityTime;
  }
}
