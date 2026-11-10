/** What {@link Gyro.attach} writes to: an `Input`, or anything with the same two methods. */
export interface ControlHost {
  control(id: string): Record<string, number>;
  removeControl(id: string): void;
}

/** Options for {@link Gyro}. */
export interface GyroOptions {
  /** Where `devicemotion` and `deviceorientation` arrive. Default `window`. */
  target?: EventTarget;
  /** Turn rate in degrees per second that reads as 1 on the `yaw`, `pitch` and `roll` actions. Default 180. */
  maxRate?: number;
  /** Tilt from the neutral position in degrees that reads as 1 on the `steer` action. Default 45. */
  maxTilt?: number;
  /** Turn rates under this many degrees per second read 0, so a resting hand does not drift the aim. Default 1. */
  deadzone?: number;
  /** Screen rotation in degrees, 0, 90, 180 or 270. Default `screen.orientation.angle`. */
  screenAngle?: () => number;
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
}

const RAD = Math.PI / 180;
/** Longest step in seconds one sensor event integrates, so a gap in events cannot jump the aim. */
const MAX_STEP = 0.1;
/** Below this length the world's up lies along the screen normal: the device is flat and has no steering angle. */
const FLAT = 0.2;
const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * The device's gyroscope and tilt as aim and steering, in the screen's frame, so landscape and portrait read alike.
 * Read `yaw` and `pitch` for aiming: the radians turned since the last update, which add straight onto a camera. Or
 * attach it to an `Input` and bind actions to `{ type: 'control', id: 'gyro', axis: 'yaw' }`, and likewise `pitch`,
 * `roll` and `steer`, where rates read as a share of `maxRate`.
 *
 * ```ts
 * const gyro = new Gyro();
 * button.onclick = () => Gyro.requestPermission(); // iOS asks only from a tap
 * gyro.attach(input);
 * gyro.update(); // once per tick, before input.update()
 * input.update();
 * ```
 */
export class Gyro {
  /** Radians turned since the last update, positive to the right. */
  yaw = 0;
  /** Radians turned since the last update, positive upward. */
  pitch = 0;
  /** Radians turned since the last update, positive clockwise as the player sees the screen. */
  roll = 0;
  /** Tilt like a steering wheel, -1 to 1, positive clockwise. Reads 0 while the device lies flat. */
  steer = 0;
  /** False ignores the sensors and reads 0, for aiming only while a button is held. Default true. */
  enabled = true;
  /** True once the device has sent a real gyroscope reading. Desktops send events with none, or no events. */
  available = false;
  private readonly target: EventTarget;
  private readonly maxRate: number;
  private readonly maxTilt: number;
  private readonly deadzone: number;
  private readonly screenAngle: () => number;
  private readonly now: () => number;
  private readonly hosts = new Map<ControlHost, { id: string; values: Record<string, number> }>();
  private readonly bias = { alpha: 0, beta: 0, gamma: 0 };
  private calibration: { alpha: number; beta: number; gamma: number; count: number } | undefined;
  private pending = { yaw: 0, pitch: 0, roll: 0 };
  private neutral = 0;
  private tilt = 0;
  private lastEvent: number | undefined;
  private lastUpdate: number;
  private disposed = false;
  /** @throws RangeError for a `maxRate` or `maxTilt` not above 0, or a `deadzone` below 0. */
  constructor({
    target = window,
    maxRate = 180,
    maxTilt = 45,
    deadzone = 1,
    screenAngle = () => globalThis.screen?.orientation?.angle ?? 0,
    now = () => performance.now(),
  }: GyroOptions = {}) {
    if (!(maxRate > 0) || !(maxTilt > 0) || !(deadzone >= 0) || !Number.isFinite(maxRate + maxTilt + deadzone))
      throw new RangeError('Invalid Gyro options; maxRate and maxTilt are above 0 and deadzone is at least 0');
    this.target = target;
    this.maxRate = maxRate;
    this.maxTilt = maxTilt * RAD;
    this.deadzone = deadzone;
    this.screenAngle = screenAngle;
    this.now = now;
    this.lastUpdate = now();
    target.addEventListener('devicemotion', this.onMotion);
    target.addEventListener('deviceorientation', this.onOrientation);
  }
  /** Whether this browser has motion events at all. A device can still lack the sensor: see {@link Gyro.available}. */
  static supported(): boolean {
    return typeof globalThis.DeviceMotionEvent === 'function';
  }
  /**
   * Ask for the sensors where the browser needs it (iOS Safari), which it allows only from a tap or click. Resolves
   * true when allowed or when no permission is needed, and false when refused or unsupported.
   */
  static async requestPermission(): Promise<boolean> {
    type Asks = { requestPermission?: () => Promise<string> };
    const motion = globalThis.DeviceMotionEvent as unknown as Asks | undefined,
      orientation = globalThis.DeviceOrientationEvent as unknown as Asks | undefined;
    if (!motion) return false;
    const answers = await Promise.all([motion.requestPermission?.(), orientation?.requestPermission?.()]);
    return answers.every((answer) => answer === undefined || answer === 'granted');
  }
  /** Publish to `input` as control `id`, for `{ type: 'control', id, axis }` bindings. Default id `'gyro'`. */
  attach(input: ControlHost, id = 'gyro'): void {
    this.detach(input);
    this.hosts.set(input, { id, values: input.control(id) });
  }
  /** Stop publishing to `input` and remove the control. */
  detach(input: ControlHost): void {
    const host = this.hosts.get(input);
    if (host) input.removeControl(host.id);
    this.hosts.delete(input);
  }
  /** Take the turns since the last update into `yaw`, `pitch` and `roll`, and publish. Call once per tick. */
  update(): void {
    const now = this.now(),
      elapsed = (now - this.lastUpdate) / 1000,
      { yaw, pitch, roll } = this.pending;
    this.lastUpdate = now;
    this.pending = { yaw: 0, pitch: 0, roll: 0 };
    this.yaw = yaw;
    this.pitch = pitch;
    this.roll = roll;
    this.steer = this.enabled ? clamp(wrap(this.tilt - this.neutral) / this.maxTilt) : 0;
    const scale = elapsed > 0 ? 1 / (elapsed * this.maxRate * RAD) : 0;
    for (const { values } of this.hosts.values()) {
      values.yaw = clamp(yaw * scale);
      values.pitch = clamp(pitch * scale);
      values.roll = clamp(roll * scale);
      values.steer = this.steer;
    }
  }
  /** Take the device's present tilt as straight ahead for `steer`. */
  recenter(): void {
    this.neutral = this.tilt;
  }
  /**
   * Measure the gyroscope's resting error over `duration` milliseconds (default 1000) and subtract it from now on. The
   * device should lie still. Resolves false, changing nothing, when no reading arrived.
   * @throws DOMException `AbortError` when `signal` aborts.
   * @throws RangeError for a `duration` below 0.
   */
  calibrate({ duration = 1000, signal }: { duration?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!(duration >= 0)) return reject(new RangeError('Gyro calibrate duration must be in milliseconds, at least 0'));
      if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      const sum = (this.calibration = { alpha: 0, beta: 0, gamma: 0, count: 0 });
      const abort = () => {
        clearTimeout(timer);
        if (this.calibration === sum) this.calibration = undefined;
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        if (this.calibration !== sum) return resolve(false);
        this.calibration = undefined;
        if (!sum.count) return resolve(false);
        this.bias.alpha += sum.alpha / sum.count;
        this.bias.beta += sum.beta / sum.count;
        this.bias.gamma += sum.gamma / sum.count;
        resolve(true);
      }, duration);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  /** Stop listening and remove the controls. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target.removeEventListener('devicemotion', this.onMotion);
    this.target.removeEventListener('deviceorientation', this.onOrientation);
    for (const input of [...this.hosts.keys()]) this.detach(input);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private readonly onMotion = (event: Event): void => {
    const rate = (event as DeviceMotionEvent).rotationRate,
      now = this.now(),
      last = this.lastEvent;
    this.lastEvent = now;
    if (!rate || (rate.alpha === null && rate.beta === null && rate.gamma === null)) return;
    this.available = true;
    const raw = { alpha: rate.alpha ?? 0, beta: rate.beta ?? 0, gamma: rate.gamma ?? 0 };
    if (this.calibration) {
      this.calibration.alpha += raw.alpha;
      this.calibration.beta += raw.beta;
      this.calibration.gamma += raw.gamma;
      this.calibration.count++;
    }
    if (!this.enabled) return;
    const step = last === undefined ? 1 / 60 : Math.min((now - last) / 1000, MAX_STEP),
      angle = this.screenAngle() * RAD,
      sin = Math.sin(angle),
      cos = Math.cos(angle),
      // Device Orientation (W3C CRD 2026-10-26) 6.3.2: rotationRate alpha, beta and gamma are the rates about the
      // device's x, y and z axes, unlike the Euler angles of deviceorientation (alpha about z, beta x, gamma y).
      rx = raw.alpha - this.bias.alpha,
      ry = raw.beta - this.bias.beta,
      rz = raw.gamma - this.bias.gamma;
    // Device axes: x to the right of the natural screen, y up it, z out of it, right handed. The screen's right is
    // cos x - sin y and its up is sin x + cos y.
    this.pending.yaw -= this.gated(sin * rx + cos * ry) * step * RAD;
    this.pending.pitch += this.gated(cos * rx - sin * ry) * step * RAD;
    this.pending.roll -= this.gated(rz) * step * RAD;
  };
  private readonly onOrientation = (event: Event): void => {
    const { beta, gamma } = event as DeviceOrientationEvent;
    if (beta === null || gamma === null || beta === undefined || gamma === undefined) return;
    // The world's up in device axes, from the Z-X'-Y'' angles of the Device Orientation specification.
    const b = beta * RAD,
      g = gamma * RAD,
      x = -Math.cos(b) * Math.sin(g),
      y = Math.sin(b),
      angle = this.screenAngle() * RAD,
      right = Math.cos(angle) * x - Math.sin(angle) * y,
      up = Math.sin(angle) * x + Math.cos(angle) * y;
    // Turning the device clockwise turns the world's up the other way on screen.
    this.tilt = Math.hypot(right, up) < FLAT ? this.neutral : -Math.atan2(right, up);
  };
  private gated(rate: number): number {
    return Math.abs(rate) < this.deadzone ? 0 : rate;
  }
}
