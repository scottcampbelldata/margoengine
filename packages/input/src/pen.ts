import type { ControlHost } from './motion.js';

/** One reading of the pen. */
export interface PenSample {
  /** Position in CSS pixels, relative to the viewport. */
  x: number;
  y: number;
  /** Tip pressure, 0 to 1, after `curve`. 0 while hovering. */
  pressure: number;
  /** Lean toward the right and toward the user, in degrees, -90 to 90. */
  tiltX: number;
  tiltY: number;
  /** Radians above the surface: pi / 2 upright, 0 lying flat. */
  altitude: number;
  /** Radians around the surface from the positive x axis, clockwise on screen, 0 to 2 pi. */
  azimuth: number;
  /** Turn about the pen's own axis in degrees, 0 to 359. */
  twist: number;
  /** Barrel wheel or finger pressure, -1 to 1, on the pens that have one. */
  tangential: number;
  /** True while the tip or the eraser touches. */
  down: boolean;
  /** True while the barrel button is held. */
  barrel: boolean;
  /** True while the pen is turned over to its eraser. */
  eraser: boolean;
  /** Event time in milliseconds, on the clock of `performance.now`. */
  time: number;
}

/** Options for {@link Pen}. */
export interface PenOptions {
  /** Shapes pressure, from 0 to 1 and back into 0 to 1, for a softer or firmer feel. Default none. */
  curve?: (pressure: number) => number;
  /** Most samples kept between {@link Pen.take} calls; the oldest go first. Default 4096. */
  maxSamples?: number;
}

const HALF_PI = Math.PI / 2,
  TURN = Math.PI * 2,
  RAD = Math.PI / 180;

/** Altitude and azimuth from tilt, by the conversion in the Pointer Events specification. */
function anglesFromTilt(tiltX: number, tiltY: number): [altitude: number, azimuth: number] {
  if (Math.abs(tiltX) >= 90 || Math.abs(tiltY) >= 90) {
    // Off-axis flat tilts do not identify an azimuth; use Pointer Events' zero fallback.
    if (tiltX !== 0 && tiltY !== 0) return [0, 0];
    const azimuth = Math.atan2(
      Math.abs(tiltY) >= 90 ? Math.sign(tiltY) : 0,
      Math.abs(tiltX) >= 90 ? Math.sign(tiltX) : 0,
    );
    return [0, azimuth < 0 ? azimuth + TURN : azimuth];
  }
  const x = Math.tan(tiltX * RAD),
    y = Math.tan(tiltY * RAD),
    length = Math.hypot(x, y);
  if (!length) return [HALF_PI, 0];
  const azimuth = Math.atan2(y, x);
  return [Math.atan2(1, length), azimuth < 0 ? azimuth + TURN : azimuth];
}

/**
 * Tilt from altitude and azimuth, the same conversion the other way. A pen lying flat (altitude 0) takes the
 * specification's exact quadrant values: 90 degrees toward each axis the azimuth leans to, 0 on the other axis when
 * the azimuth is exactly on one axis (cos(pi / 2) is not exactly 0 in floating point).
 */
function tiltFromAngles(altitude: number, azimuth: number): [tiltX: number, tiltY: number] {
  if (altitude === 0) {
    const a = azimuth >= TURN ? azimuth - TURN : azimuth,
      down = (3 * Math.PI) / 2,
      x = a === HALF_PI || a === down ? 0 : a < HALF_PI || a > down ? 90 : -90,
      y = a === 0 || a === Math.PI ? 0 : a < Math.PI ? 90 : -90;
    return [x, y];
  }
  const reach = 1 / Math.tan(altitude);
  return [Math.atan(Math.cos(azimuth) * reach) / RAD, Math.atan(Math.sin(azimuth) * reach) / RAD];
}

/**
 * Pen pressure and tilt, as action values and as a full-rate sample stream for painting and sculpting. Mouse and touch
 * are ignored. Attach it to an `Input` and bind actions to `{ type: 'control', id: 'pen', axis: 'pressure' }`, and
 * likewise `tiltX`, `tiltY` (-1 to 1), `altitude` (0 flat to 1 upright), `azimuth` and `twist` (share of a full turn,
 * 0 to 1), `tangential` (-1 to 1), `down`, `barrel`, `eraser` and `hover` (0 or 1).
 *
 * ```ts
 * const pen = new Pen(canvas);
 * pen.attach(input);
 * pen.update(); // once per tick, before input.update()
 * input.update();
 * for (const sample of pen.take()) brush(sample.x, sample.y, sample.pressure);
 * ```
 *
 * Set `touch-action: none` on the element so the browser does not claim the stroke.
 */
export class Pen {
  /** The latest reading, or undefined before the pen has been seen. */
  latest: PenSample | undefined;
  /** True while the pen is within reach of the element, touching or hovering. */
  inRange = false;
  private readonly element: EventTarget;
  private readonly curve: ((pressure: number) => number) | undefined;
  private readonly maxSamples: number;
  private readonly hosts = new Map<ControlHost, { id: string; values: Record<string, number> }>();
  private samples: PenSample[] = [];
  /** Touched since the last update, so a dab between two updates still counts for one update. */
  private dabbed = false;
  private disposed = false;
  /** @throws RangeError for a `maxSamples` that is not an integer >= 1. */
  constructor(element: EventTarget, { curve, maxSamples = 4096 }: PenOptions = {}) {
    if (!Number.isInteger(maxSamples) || maxSamples < 1)
      throw new RangeError('Pen maxSamples must be an integer of at least 1');
    if (curve !== undefined && typeof curve !== 'function') throw new TypeError('Pen curve must be a function');
    this.element = element;
    this.curve = curve;
    this.maxSamples = maxSamples;
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) element.addEventListener(type, this.onPointer);
    element.addEventListener('pointercancel', this.onEnd);
    element.addEventListener('pointerleave', this.onLeave);
  }
  /** Publish to `input` as control `id`, for `{ type: 'control', id, axis }` bindings. Default id `'pen'`. */
  attach(input: ControlHost, id = 'pen'): void {
    this.detach(input);
    this.hosts.set(input, { id, values: input.control(id) });
  }
  /** Stop publishing to `input` and remove the control. */
  detach(input: ControlHost): void {
    const host = this.hosts.get(input);
    if (host) input.removeControl(host.id);
    this.hosts.delete(input);
  }
  /** Publish the latest reading to every attached `Input`. Call once per tick, before `input.update()`. */
  update(): void {
    const sample = this.latest,
      live = this.inRange ? sample : undefined,
      down = !!live?.down || this.dabbed;
    this.dabbed = false;
    for (const { values } of this.hosts.values()) {
      values.pressure = live?.pressure ?? 0;
      values.tiltX = (live?.tiltX ?? 0) / 90;
      values.tiltY = (live?.tiltY ?? 0) / 90;
      values.altitude = live ? live.altitude / HALF_PI : 0;
      values.azimuth = (live?.azimuth ?? 0) / TURN;
      values.twist = (live?.twist ?? 0) / 360;
      values.tangential = live?.tangential ?? 0;
      values.down = +down;
      values.barrel = +!!live?.barrel;
      values.eraser = +!!live?.eraser;
      values.hover = +(this.inRange && !live?.down);
    }
  }
  /**
   * Every reading since the last call, oldest first, at the pen's own rate: the browser's coalesced events are
   * unpacked, so a stroke keeps the points between two frames. A sample with `down` false after true ends a stroke.
   */
  take(): PenSample[] {
    const samples = this.samples;
    this.samples = [];
    return samples;
  }
  /** Stop listening and remove the controls. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const type of ['pointerdown', 'pointermove', 'pointerup'])
      this.element.removeEventListener(type, this.onPointer);
    this.element.removeEventListener('pointercancel', this.onEnd);
    this.element.removeEventListener('pointerleave', this.onLeave);
    for (const input of [...this.hosts.keys()]) this.detach(input);
    this.inRange = false;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private push(sample: PenSample): void {
    this.latest = sample;
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
  private read(e: PointerEvent): PenSample {
    let tiltX = e.tiltX || 0,
      tiltY = e.tiltY || 0,
      altitude = e.altitudeAngle,
      azimuth = e.azimuthAngle;
    if (altitude === undefined || azimuth === undefined) [altitude, azimuth] = anglesFromTilt(tiltX, tiltY);
    else if (!tiltX && !tiltY) [tiltX, tiltY] = tiltFromAngles(altitude, azimuth);
    const raw = Math.max(0, Math.min(1, e.pressure || 0)),
      shaped = raw > 0 && this.curve ? this.curve(raw) : raw,
      eraser = !!(e.buttons & 32) || e.button === 5;
    return {
      x: e.clientX,
      y: e.clientY,
      pressure: Number.isFinite(shaped) ? Math.max(0, Math.min(1, shaped)) : raw,
      tiltX,
      tiltY,
      altitude,
      azimuth,
      twist: e.twist || 0,
      tangential: e.tangentialPressure || 0,
      down: !!(e.buttons & 33),
      barrel: !!(e.buttons & 2),
      eraser,
      time: e.timeStamp,
    };
  }
  private readonly onPointer = (event: Event): void => {
    const e = event as PointerEvent;
    if (e.pointerType !== 'pen') return;
    this.inRange = true;
    if (e.type === 'pointerdown') (e.target as Partial<Element> | null)?.setPointerCapture?.(e.pointerId);
    // pointerup stands alone: its coalesced list, where a browser gives one, is the same event.
    const batch = e.type === 'pointermove' ? e.getCoalescedEvents?.() : undefined;
    for (const part of batch?.length ? batch : [e]) this.push(this.read(part));
    if (this.latest?.down) this.dabbed = true;
  };
  private readonly onEnd = (event: Event): void => {
    const e = event as PointerEvent;
    if (e.pointerType !== 'pen') return;
    if (this.latest?.down) this.push({ ...this.latest, pressure: 0, down: false, barrel: false, tangential: 0 });
    this.inRange = false;
  };
  private readonly onLeave = (event: Event): void => {
    if ((event as PointerEvent).pointerType === 'pen' && !this.latest?.down) this.inRange = false;
  };
}
