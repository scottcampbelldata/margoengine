// A drivetrain for `Vehicle`: an engine with a torque curve, a clutch, a gearbox and differentials, between the throttle and the torque on
// each driven wheel (Rill, "Road Vehicle Dynamics", CRC 2011, chapters 2 and 3; Milliken and Milliken, "Race Car Vehicle Dynamics", SAE
// 1995, on differentials). The engine turns at the speed of the wheels times the gear while the clutch holds; slipping, it turns by its own
// inertia under its torque less the clutch's. What the gearbox gives goes to the driven wheels through the differentials: an open one splits
// the torque in two, a locked one brings its two sides to one speed, a limited-slip one does so up to a torque it may move.

/** How one differential splits torque between its two outputs. */
export interface DifferentialOptions {
  /** `'open'` (default): half each. `'locked'`: the two sides turn together. `'limitedSlip'`: they turn together within a torque that may move. */
  type?: 'open' | 'locked' | 'limitedSlip';
  /** `limitedSlip`: the torque a differential may move between its sides at no load, N m (default 100). */
  preload?: number;
  /** `limitedSlip`: how much more it may move per N m of input torque (default 0.5). */
  bias?: number;
  /**
   * The share of the torque its first output gets (default 0.5): for a centre differential the first axle's. A locked or limited-slip
   * differential moves torque between its outputs on top of this share, to bring them toward one speed; it has no speed lead of its own.
   */
  split?: number;
}

/** One driven axle: the vehicle's wheel indexes of its two sides. */
export interface AxleOptions {
  wheels: readonly [number, number];
  /** The axle's differential (default open). */
  differential?: DifferentialOptions;
}

/** Options of `new Drivetrain(options)`. Every field but `axles` has a default (a 2 litre petrol engine and a five speed gearbox). */
export interface DrivetrainOptions {
  /** The driven axles: one for two-wheel drive, two for four. */
  axles: readonly AxleOptions[];
  /** The differential between two axles (default open, an even split). */
  center?: DifferentialOptions;
  /** The engine's torque at full throttle against its speed: points `[rpm, N m]`, joined by straight lines and held beyond the ends (default peak 200 N m at 4,000). */
  torqueCurve?: readonly (readonly [number, number])[];
  /** Idle speed, rpm (default 900); the engine does not slow below it with the throttle open. */
  idleRpm?: number;
  /** The speed the engine is held under, rpm (default 6,800: the torque cuts off at it). */
  redlineRpm?: number;
  /** The engine's moment of inertia with the flywheel, kg m squared (default 0.25). */
  engineInertia?: number;
  /** Torque the engine drags with at closed throttle, N m at the redline (default 40, rising with speed). */
  engineBraking?: number;
  /** Forward gear ratios, first to last (default 3.6, 2.2, 1.5, 1.1, 0.85). */
  gears?: readonly number[];
  /** The ratio of the reverse gear, positive (default 3.4). */
  reverse?: number;
  /** The final drive ratio (default 3.7). */
  finalDrive?: number;
  /** Shift by itself (default true): up past `upshiftRpm`, down under `downshiftRpm`. */
  automatic?: boolean;
  /** The speed that makes the automatic gearbox shift up, rpm (default 6,000). */
  upshiftRpm?: number;
  /**
   * The speed under which it shifts down, rpm (default 2,200). The gap is the hysteresis: the engine speed after an upshift,
   * `upshiftRpm` times the ratio of the next gear to this one, must stay above this, or the gearbox would shift up and down.
   * @throws RangeError from the constructor when it would.
   */
  downshiftRpm?: number;
  /** Seconds a gear change takes with the clutch out (default 0.25). */
  shiftTime?: number;
  /** The most torque the clutch may carry, N m (default 1.6 times the engine's peak). */
  clutchTorque?: number;
  /** Losses between the engine and the wheels, from 0 to 1 (default 0.9 of the torque arrives). */
  efficiency?: number;
}

const interpolate = (curve: readonly (readonly [number, number])[], x: number): number => {
  if (x <= curve[0]![0]) return curve[0]![1];
  const last = curve[curve.length - 1]!;
  if (x >= last[0]) return last[1];
  let i = 1;
  while (curve[i]![0] < x) i++;
  const [x0, y0] = curve[i - 1]!,
    [x1, y1] = curve[i]!;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
};

/** What a drivetrain is told each step of the wheels it drives, in the order of `axles`: their spin and moment of inertia. */
export interface DrivenWheel {
  spin: number;
  inertia: number;
}

const RPM = 30 / Math.PI;

/**
 * An engine, clutch, gearbox and differentials. Pass one as a vehicle's `drivetrain` and `setInput({throttle, clutch})` drives it; the
 * vehicle's wheels then take their torque from it, and `engineForce` is no longer used. `gear`, `rpm` and `torque` read its state.
 *
 * While the clutch holds, the engine's flywheel turns with the wheels, so it takes a share of the torque to speed up: a mass of
 * `engineInertia * ratio^2 / radius^2` at the wheels (about 360 kg in first gear on the defaults and 0.35 m wheels, against the car's 1,000).
 * This model does not take it: the engine turns with the wheels but the wheels' spins do not feel its inertia, so a car accelerates in
 * the low gears more than that mass allows (`docs/limits.md`, own physics vehicles). The share between two wheels of an open differential
 * depends on how they move together, and an explicit torque from the last step's acceleration is unstable when the wheels are free.
 */
export class Drivetrain {
  /** The gear: 0 neutral, a positive number a forward gear (1 first), -1 reverse. Set it to shift by hand (with `automatic: false`). */
  gear = 1;
  private spin = 0;
  private shifting = 0;
  private locked = true;
  private throttle = 0;
  private clutchPedal = 0;
  private lastTorque = 0;
  private readonly curve: readonly (readonly [number, number])[];
  private readonly options: Required<Omit<DrivetrainOptions, 'axles' | 'center' | 'torqueCurve'>> & {
    axles: readonly AxleOptions[];
    center: DifferentialOptions;
  };

  constructor(options: DrivetrainOptions) {
    if (!Array.isArray(options?.axles) || options.axles.length < 1 || options.axles.length > 2)
      throw new RangeError('A drivetrain drives one axle or two; pass {axles: [{wheels: [2, 3]}]}.');
    for (const axle of options.axles)
      if (
        !Array.isArray(axle.wheels) ||
        axle.wheels.length !== 2 ||
        axle.wheels.some((w: number) => !Number.isInteger(w) || w < 0)
      )
        throw new RangeError('An axle names the two wheel indexes it drives; pass {wheels: [2, 3]}.');
    this.curve = options.torqueCurve ?? [
      [1000, 120],
      [2500, 170],
      [4000, 200],
      [5500, 185],
      [6800, 150],
    ];
    if (
      this.curve.length < 1 ||
      this.curve.some((p, i) => !(p[0] >= 0 && Number.isFinite(p[1])) || (i > 0 && !(p[0] > this.curve[i - 1]![0])))
    )
      throw new RangeError('A torque curve is points [rpm, N m] with the rpm rising; pass them sorted by rpm, such as [[1000, 120], [4000, 200]].');
    const peak = Math.max(...this.curve.map((p) => p[1]));
    this.options = {
      axles: options.axles,
      center: options.center ?? {},
      idleRpm: options.idleRpm ?? 900,
      redlineRpm: options.redlineRpm ?? 6800,
      engineInertia: options.engineInertia ?? 0.25,
      engineBraking: options.engineBraking ?? 40,
      gears: options.gears ?? [3.6, 2.2, 1.5, 1.1, 0.85],
      reverse: options.reverse ?? 3.4,
      finalDrive: options.finalDrive ?? 3.7,
      automatic: options.automatic ?? true,
      upshiftRpm: options.upshiftRpm ?? 6000,
      downshiftRpm: options.downshiftRpm ?? 2200,
      shiftTime: options.shiftTime ?? 0.25,
      clutchTorque: options.clutchTorque ?? 1.6 * peak,
      efficiency: options.efficiency ?? 0.9,
    };
    const o = this.options;
    for (const [value, name] of [
      [o.idleRpm, 'idleRpm'],
      [o.redlineRpm, 'redlineRpm'],
      [o.engineInertia, 'engineInertia'],
      [o.reverse, 'reverse'],
      [o.finalDrive, 'finalDrive'],
      [o.clutchTorque, 'clutchTorque'],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw new RangeError(`Drivetrain ${name} must be a finite number above 0; got ${value}.`);
    if (!(o.redlineRpm > o.idleRpm)) throw new RangeError('Drivetrain redlineRpm must be above idleRpm.');
    if (!Array.isArray(o.gears) || o.gears.length < 1 || o.gears.some((g) => !(g > 0 && Number.isFinite(g))))
      throw new RangeError('Drivetrain gears are ratios above 0, first gear first; pass them as [3.5, 2.1, 1.4, 1.0], for example.');
    if (!(o.efficiency > 0 && o.efficiency <= 1))
      throw new RangeError('Drivetrain efficiency must be above 0 and at most 1.');
    if (!(o.shiftTime >= 0)) throw new RangeError('Drivetrain shiftTime must be 0 or more seconds.');
    if (!(o.upshiftRpm > 0 && o.downshiftRpm > 0 && Number.isFinite(o.upshiftRpm) && Number.isFinite(o.downshiftRpm)))
      throw new RangeError('Drivetrain upshiftRpm and downshiftRpm must be finite numbers above 0.');
    for (let g = 1; g < o.gears.length; g++)
      if (o.upshiftRpm * (o.gears[g]! / o.gears[g - 1]!) <= o.downshiftRpm)
        throw new RangeError(
          `Drivetrain would shift up from gear ${g} at ${o.upshiftRpm} rpm to ${Math.round(o.upshiftRpm * (o.gears[g]! / o.gears[g - 1]!))} rpm, ` +
            `at or under its downshiftRpm of ${o.downshiftRpm}, and shift back down; raise upshiftRpm's distance from downshiftRpm.`,
        );
    this.spin = (o.idleRpm * Math.PI) / 30;
  }

  /** The engine's speed, rpm. */
  get rpm(): number {
    return this.spin * RPM;
  }
  /** The torque the engine gave last step, N m. */
  get torque(): number {
    return this.lastTorque;
  }
  /** Whether the clutch is holding the engine to the wheels (not slipping, not out). */
  get engaged(): boolean {
    return this.locked && this.shifting === 0;
  }
  /** The overall ratio of the gear now: gearbox times final drive, negative in reverse, 0 in neutral. */
  get ratio(): number {
    return this.ratioOf(this.gear);
  }
  /** The vehicle wheel indexes this drivetrain drives, the first axle's two then the second's. */
  get drivenWheels(): number[] {
    return this.options.axles.flatMap((axle) => [axle.wheels[0], axle.wheels[1]]);
  }
  /** Shifts up one forward gear; from neutral or reverse it goes into first. No effect in the last gear. */
  shiftUp(): void {
    if (this.gear < 1) this.change(1);
    else if (this.gear < this.options.gears.length) this.change(this.gear + 1);
  }
  /** Shifts down one gear, to neutral under first. No effect in neutral or reverse. */
  shiftDown(): void {
    if (this.gear > 0) this.change(this.gear - 1);
  }
  private change(gear: number): void {
    if (gear !== this.gear) {
      this.gear = gear;
      this.shifting = this.options.shiftTime;
    }
  }
  private ratioOf(gear: number): number {
    if (gear === 0) return 0;
    if (gear < 0) return -this.options.reverse * this.options.finalDrive;
    return this.options.gears[Math.min(gear, this.options.gears.length) - 1]! * this.options.finalDrive;
  }

  /** @internal The throttle and clutch pedal for the next step, from 0 to 1 each. */
  pedals(throttle: number, clutch: number): void {
    this.throttle = Math.min(1, Math.max(0, throttle));
    this.clutchPedal = Math.min(1, Math.max(0, clutch));
  }

  /**
   * @internal Advances the engine and clutch over `dt` and returns the torque on each driven wheel, in the order of the axles' wheels (the
   * first axle's two, then the second's). `wheels` is their spin and inertia in the same order.
   */
  step(dt: number, wheels: readonly DrivenWheel[]): number[] {
    const o = this.options,
      torques = wheels.map(() => 0);
    if (this.shifting > 0) this.shifting = Math.max(0, this.shifting - dt);
    const ratio = this.ratioOf(this.gear),
      driven = wheels.reduce((sum, w) => sum + w.spin, 0) / wheels.length,
      shaft = driven * ratio,
      redline = (o.redlineRpm * Math.PI) / 30,
      idle = (o.idleRpm * Math.PI) / 30;
    // The engine's torque at its speed and the throttle: the curve, cut at the redline, dragging when the throttle is closed.
    const engineTorque = (speed: number): number => {
      const rpm = speed * RPM,
        full = rpm >= o.redlineRpm ? 0 : interpolate(this.curve, rpm),
        drag = -o.engineBraking * Math.min(1.5, speed / redline) * (1 - this.throttle);
      return this.throttle * full + drag;
    };
    // The gearbox shifts by itself on the speed the wheels give the engine in this gear (not the engine's own, which a slipping clutch
    // or a gear change leaves far from it): up near the top, down when the engine would be lugging.
    if (o.automatic && this.shifting === 0 && this.gear >= 1) {
      const shaftRpm = Math.abs(shaft) * RPM;
      if (shaftRpm > o.upshiftRpm && this.throttle > 0 && this.gear < o.gears.length) this.shiftUp();
      else if (shaftRpm < o.downshiftRpm && this.gear > 1) this.shiftDown();
    }
    const clutch = (1 - this.clutchPedal) * (this.shifting > 0 ? 0 : 1),
      capacity = o.clutchTorque * clutch;
    let delivered = 0;
    if (this.shifting > 0 && ratio !== 0) {
      // A gear change: the clutch is out and the torque is cut while the synchronisers bring the engine to the speed the new gear asks
      // of it, over what is left of the change, so the clutch meets it at one speed.
      this.locked = false;
      this.spin += (Math.max(idle * 0.9, Math.abs(shaft)) - this.spin) * Math.min(1, dt / Math.max(this.shifting, dt));
    } else if (ratio === 0 || clutch === 0) {
      // Out of gear or out of clutch: the engine turns freely on its own torque.
      this.locked = false;
      this.spin += (dt * (engineTorque(this.spin) - o.engineBraking * 0.2 * (this.spin / redline))) / o.engineInertia;
    } else {
      const demand = engineTorque(Math.abs(shaft) > idle ? Math.abs(shaft) : idle);
      if (this.locked && Math.abs(demand * Math.sign(ratio)) <= capacity && clutch > 0.9) {
        // Held: the engine turns with the wheels (never under idle), and what it gives goes down the line.
        this.spin = Math.min(redline * 1.02, Math.max(idle * 0.9, Math.abs(shaft)));
        delivered = Math.sign(ratio) * demand;
        if (Math.abs(shaft) < idle * 0.9 && this.throttle < 0.05) delivered = 0;
      } else {
        // Slipping: the engine turns on its own, the clutch passes up to its capacity toward the wheels' speed.
        this.locked = false;
        const slip = this.spin - Math.abs(shaft),
          reflected = wheels.reduce((sum, w) => sum + w.inertia, 0) / (ratio * ratio),
          // The torque that would bring the two to one speed in a step, and no more than the clutch holds.
          sync = Math.abs(slip) / (dt * (1 / o.engineInertia + 1 / Math.max(reflected, 1e-3))),
          // A clutch slipping with the engine ahead carries what the engine gives and what its flywheel gives up on the way down to idle,
          // and no more, so the engine is held at idle by it and never runs below; with the wheels ahead it drags the engine along.
          available = Math.max(engineTorque(this.spin), 0) + (o.engineInertia * Math.max(this.spin - idle, 0)) / dt,
          carried = slip > 0 ? Math.min(capacity, sync, available) : -Math.min(capacity, sync);
        this.spin += (dt * (engineTorque(this.spin) - carried)) / o.engineInertia;
        delivered = Math.sign(ratio) * carried;
        if (Math.abs(this.spin - Math.abs(shaft)) < 0.02 * redline && clutch > 0.9) this.locked = true;
      }
    }
    if (this.spin < idle && this.throttle > 0 && !this.locked) this.spin = Math.max(this.spin, idle * 0.95);
    this.lastTorque = engineTorque(this.spin);
    const out = delivered * Math.abs(ratio) * o.efficiency;
    // To the axles by the centre differential, to the wheels by each axle's.
    const axles = o.axles;
    const axleSpin = axles.map((_, a) => (wheels[2 * a]!.spin + wheels[2 * a + 1]!.spin) / 2),
      axleInertia = axles.map((_, a) => wheels[2 * a]!.inertia + wheels[2 * a + 1]!.inertia);
    const toAxles =
      axles.length === 1
        ? [out]
        : split(o.center, out, axleSpin[0]!, axleSpin[1]!, axleInertia[0]!, axleInertia[1]!, dt);
    axles.forEach((axle, a) => {
      const [left, right] = split(
        axle.differential ?? {},
        toAxles[a]!,
        wheels[2 * a]!.spin,
        wheels[2 * a + 1]!.spin,
        wheels[2 * a]!.inertia,
        wheels[2 * a + 1]!.inertia,
        dt,
      );
      torques[2 * a] = left;
      torques[2 * a + 1] = right;
    });
    return torques;
  }
}

/**
 * Splits `torque` between two outputs of speeds `a` and `b` and inertias `ja` and `jb`. Open: by the share. Locked or limited slip: the
 * torque that would bring the two to one speed within the step moves from the faster to the slower, all of it when locked, up to the
 * preload and the bias on the torque when limited.
 */
function split(
  diff: DifferentialOptions,
  torque: number,
  a: number,
  b: number,
  ja: number,
  jb: number,
  dt: number,
): [number, number] {
  const share = diff.split ?? 0.5,
    first = torque * share,
    second = torque - first,
    type = diff.type ?? 'open';
  if (type === 'open') return [first, second];
  // The speed difference after the open split's torques act, and the transfer that cancels it.
  const gap = a + (dt * first) / ja - (b + (dt * second) / jb),
    sync = gap / (dt * (1 / ja + 1 / jb)),
    cap = type === 'locked' ? Infinity : (diff.preload ?? 100) + (diff.bias ?? 0.5) * Math.abs(torque);
  const moved = Math.max(-cap, Math.min(cap, sync));
  return [first - moved, second + moved];
}
