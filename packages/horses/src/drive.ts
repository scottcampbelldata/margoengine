import { cos, hypot, sin } from '@margoengine/math/pinned';
import type { HorseBody } from './anatomy.js';
import { GRAVITY } from './gaits.js';

type Ground = (x: number, z: number) => number;
type Footprint = Pick<HorseBody, 'bodyLength' | 'chestWidth' | 'hipWidth'>;

export interface HorseSurface {
  /** Mean support height, m. */
  readonly height: number;
  /** Change in height over forward distance. */
  readonly forward: number;
  /** Change in height over rightward distance. */
  readonly right: number;
}

export const LEVEL_SURFACE: HorseSurface = { height: 0, forward: 0, right: 0 };

/** Samples each side of the hind and fore support footprint independently. */
export function horseSurface(
  body: Footprint,
  ground: Ground | undefined,
  x: number,
  z: number,
  heading: number,
): HorseSurface {
  if (!ground) return LEVEL_SURFACE;
  const s = sin(heading);
  const c = cos(heading);
  const fore = 0.4 * body.bodyLength;
  const hind = -fore;
  const foreWidth = 0.5 * body.chestWidth;
  const hindWidth = 0.5 * body.hipWidth;
  const sample = (side: number, along: number) => ground(x + side * c + along * s, z - side * s + along * c);
  const leftFore = sample(-foreWidth, fore);
  const rightFore = sample(foreWidth, fore);
  const leftHind = sample(-hindWidth, hind);
  const rightHind = sample(hindWidth, hind);
  if (![leftFore, rightFore, leftHind, rightHind].every(Number.isFinite))
    throw new RangeError('Provide a finite ground elevation in metres at every hoof sample.');
  return {
    height: (leftFore + rightFore + leftHind + rightHind) / 4,
    forward: (leftFore + rightFore - leftHind - rightHind) / (2 * (fore - hind)),
    right: (rightFore - leftFore + rightHind - leftHind) / (2 * (foreWidth + hindWidth)),
  };
}

interface HorseDriveState {
  readonly speed: number;
  readonly sidewaysSpeed: number;
  readonly heading: number;
}

interface HorseDrive {
  readonly strength: number;
  readonly mass: number;
  readonly grip: number;
  readonly turnRate: number;
}

interface HorseCommand {
  readonly speed: number;
  readonly heading: number;
}

function clamp(value: number, magnitude: number): number {
  return Math.max(-magnitude, Math.min(magnitude, value));
}

const TAU = 2 * Math.PI;

/** A reduced traction-circle drive for a horse's authored controller. All accelerations are SI. */
export function advanceHorseDrive(
  state: HorseDriveState,
  command: HorseCommand,
  surface: HorseSurface,
  drive: HorseDrive,
  dt: number,
) {
  const normalGravity = GRAVITY / hypot(1, surface.forward, surface.right);
  const uphill = normalGravity * surface.forward;
  const across = normalGravity * surface.right;
  const acceleration = drive.strength / drive.mass;
  // Equal commanded propulsive power on both grades. Its flat work per metre is
  // the nominal drive force; the grade adds the component of body weight uphill.
  const slopeCost = Math.max(0, uphill);
  const target = slopeCost === 0 ? command.speed : command.speed * (acceleration / (acceleration + slopeCost));
  const grip = drive.grip * normalGravity;
  const alongForce = clamp(clamp((target - state.speed) / dt + uphill, acceleration), grip);
  const sideGrip = Math.sqrt(Math.max(0, grip * grip - alongForce * alongForce));
  const speed = Math.max(0, state.speed + (alongForce - uphill) * dt);
  const request = command.heading - state.heading;
  const turn = clamp(request - TAU * Math.floor((request + Math.PI) / TAU), drive.turnRate * dt);
  const averageSpeed = (state.speed + speed) / 2;
  const steering = (averageSpeed * turn) / dt;
  const acrossForce = clamp(steering + across - state.sidewaysSpeed / dt, sideGrip);
  const availableTurn = acrossForce - across;
  const yaw = averageSpeed > 0 ? clamp((availableTurn * dt) / averageSpeed, Math.abs(turn)) : drive.grip > 0 ? turn : 0;
  const alignedYaw = yaw * turn > 0 ? yaw : 0;
  const lateralAcceleration = (averageSpeed * alignedYaw) / dt;
  return {
    speed,
    heading: state.heading + alignedYaw,
    sidewaysSpeed: state.sidewaysSpeed + (availableTurn - lateralAcceleration) * dt,
    lateralAcceleration,
    normalGravity,
    slipping: Math.abs(steering + across - state.sidewaysSpeed / dt) > sideGrip,
  };
}
