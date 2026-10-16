import { mapArmControl, nearestArmControlParameter, type ArmControl } from './arm-controls';

type Point = [number, number, number];
const home = mapArmControl('side', 0.5),
  knots: Record<ArmControl, readonly number[]> = {
    side: [0, 0.5, 0.75, 0.88, 1],
    height: [0, 0.5, 0.82, 1],
    nearFar: [0, 0.25, 0.5, 1],
  };
function routeKnots(control: ArmControl): readonly number[] {
  const track = knots[control];
  if (!Array.isArray(track)) throw new RangeError('Unknown arm control');
  return track;
}

function scenePoint(point: ArrayLike<number>): void {
  if (
    !point ||
    point.length !== 3 ||
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    !Number.isFinite(point[2]) ||
    !Number.isFinite(Math.fround(point[0])) ||
    !Number.isFinite(Math.fround(point[1])) ||
    !Number.isFinite(Math.fround(point[2]))
  )
    throw new RangeError('Arm route requires a finite scene point');
}

/** Authored control paths meet at Home; the target filter must not cut across their bends. */
export class ArmControlRoute {
  readonly position: Point = [home[0], home[1], home[2]];
  active = false;
  settled = true;
  private currentControl: ArmControl = 'side';
  private readonly waypoints = new Float64Array(24);
  private readonly controls: ArmControl[] = new Array(8).fill('side');
  private readonly scratch: Point = [0, 0, 0];
  private count = 0;
  private cursor = 0;

  request(control: ArmControl, parameter: number, accepted: ArrayLike<number>): this {
    routeKnots(control);
    if (!Number.isFinite(parameter)) throw new RangeError('Arm control parameter must be finite');
    scenePoint(accepted);
    // A preset/free drag can leave any of the authored tracks. Start with the
    // nearest track, then return through its own knots before changing tracks.
    let current = this.currentControl;
    if (!this.active) {
      let distance = Infinity;
      for (const candidate of ['side', 'height', 'nearFar'] as const) {
        const t = nearestArmControlParameter(candidate, accepted);
        mapArmControl(candidate, t, this.scratch);
        const dx = this.scratch[0] - accepted[0],
          dy = this.scratch[1] - accepted[1],
          dz = this.scratch[2] - accepted[2],
          squared = dx * dx + dy * dy + dz * dz;
        if (squared < distance) {
          distance = squared;
          current = candidate;
        }
      }
    }
    const from = nearestArmControlParameter(current, accepted),
      to = Math.max(0, Math.min(1, parameter));
    this.count = this.cursor = 0;
    if (current !== control) {
      this.appendLeg(current, from, 0.5);
      this.appendLeg(control, 0.5, to);
    } else this.appendLeg(control, from, to);
    this.currentControl = current;
    this.active = true;
    this.settled = false;
    this.copyWaypoint();
    return this;
  }

  /** Advance only on a real solve, after the accepted orb reaches the waypoint. */
  update(accepted: ArrayLike<number>, dt: number, reachedTarget: ArrayLike<number> = this.position): Point {
    scenePoint(accepted);
    scenePoint(reachedTarget);
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('Arm route dt must be finite and nonnegative');
    if (!this.active || dt === 0) return this.position;
    // A demo workspace conditioner may move a raw waypoint. Measure arrival
    // against that conditioned point without replacing the authored route.
    const dx = accepted[0] - reachedTarget[0],
      dy = accepted[1] - reachedTarget[1],
      dz = accepted[2] - reachedTarget[2];
    this.settled = false;
    if (dx * dx + dy * dy + dz * dz <= 0.002 * 0.002) {
      if (this.cursor < this.count - 1) {
        this.cursor++;
        this.currentControl = this.controls[this.cursor];
        this.copyWaypoint();
      } else this.settled = true;
    }
    return this.position;
  }

  release(): void {
    this.active = false;
    this.settled = true;
  }

  private appendLeg(control: ArmControl, from: number, to: number): void {
    const track = routeKnots(control);
    if (to > from) {
      for (let i = 0; i < track.length; i++) if (track[i] > from && track[i] < to) this.append(control, track[i]);
    } else {
      for (let i = track.length - 1; i >= 0; i--) if (track[i] < from && track[i] > to) this.append(control, track[i]);
    }
    this.append(control, to);
  }

  private append(control: ArmControl, parameter: number): void {
    mapArmControl(control, parameter, this.scratch);
    const offset = this.count * 3;
    for (let i = 0; i < 3; i++) this.waypoints[offset + i] = this.scratch[i];
    this.controls[this.count++] = control;
  }

  private copyWaypoint(): void {
    const offset = this.cursor * 3;
    for (let i = 0; i < 3; i++) this.position[i] = this.waypoints[offset + i];
  }
}
