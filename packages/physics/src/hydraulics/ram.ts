// The hydraulic ram as a lumped transient model for the hydraulics entry (HYDRO-07). A rigid drive column with
// inertance I = ρL/A and quadratic resistance feeds one compliant junction (C dp/dt = Q_drive - Q_waste - Q_check); a
// waste poppet trips shut when its flow lifts it, holds, and reopens once the junction pressure has recovered; a check
// valve feeds a polytropic air vessel that delivers up a riser. With C = A L / (ρ a²), the junction's compliance is the
// drive pipe's own, and closing the waste valve faster than the column's LC period gives Joukowsky's surge ρ a Δv
// (the lumped oscillator's amplitude Q √(I/C)). Clean room, from:
// - N. Joukowsky (1898) and E. B. Wylie and V. L. Streeter, "Fluid Transients in Systems" (1993), chapters 1 and 2
//   (rigid-column and lumped-compliance models, wave speed);
// - G. O. Lungudi, S. Cohen, S. Nasraoui, C. Dupont, S. G. Salinas-Rodriguez, M. Kennedy and D. Ferras, "Numerical
//   and experimental analyses of hydraulic rams", J. Hydraulic Research (2024), doi:10.1080/00221686.2024.2401899
//   (the cycle phases: acceleration, waste closure, delivery, recoil);
// - W. J. M. Rankine (1872) and J. F. d'Aubuisson (1840) for the two ram efficiencies reported.
// The integrator is the explicit midpoint rule with every flux of a step taken at its midpoint, so the water balance
// d(C p + V_w)/dt = Q_drive - Q_waste - Q_delivered closes to rounding over a cycle. Transcendentals are pinned.
import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';
import { ATMOSPHERE, circleArea, finite, GRAVITY, type Liquid, nonNegative, positive, WATER } from './fluid.js';

/** Parameters of a lumped hydraulic ram. Conductances are Cd A √(2/ρ) in m³/s per √Pa ({@link orificeConductance}). */
export interface HydraulicRamParams {
  /** Supply surface above the pump, m. */
  readonly supplyHead: number;
  /** Drive pipe length and inside diameter, m. */
  readonly driveLength: number;
  readonly driveDiameter: number;
  /** Quadratic drive-line resistance, Pa s²/m⁶ (Δp = R Q |Q|), lumping friction and fittings. Default 0. */
  readonly driveResistance?: number;
  /**
   * Junction compliance, m³/Pa. Give this or `waveSpeed`; with a wave speed a the compliance is the drive pipe's,
   * A L / (ρ a²).
   */
  readonly compliance?: number;
  readonly waveSpeed?: number;
  /** The waste poppet. */
  readonly waste: {
    /** Fully open conductance, m³/s per √Pa. */
    readonly conductance: number;
    /** Waste flow at which the poppet lifts and starts to close, m³/s. */
    readonly tripFlow: number;
    /** Closing time, s (the opening falls as (1 - t/T)²). */
    readonly closeTime: number;
    /** Least time shut, s. */
    readonly holdTime: number;
    /** Junction gauge pressure below which a held poppet starts to reopen, Pa. */
    readonly reopenPressure: number;
    /** Reopening time, s (linear). */
    readonly reopenTime: number;
  };
  /** Delivery check valve conductance into the air vessel, m³/s per √Pa (no reverse flow). */
  readonly checkConductance: number;
  /** Conductance from the air vessel up the delivery riser, m³/s per √Pa. */
  readonly deliveryConductance: number;
  /** Air vessel: dry volume, m³, and polytropic exponent (1 isothermal, 1.4 adiabatic). Default exponent 1.2. */
  readonly vessel: { readonly volume: number; readonly exponent?: number };
  /** Atmospheric pressure, Pa. Default 101325. */
  readonly atmosphere?: number;
  /** Fixed time step, s. Default 0.00075. */
  readonly step?: number;
  /** Initial state: junction gauge pressure, Pa; drive flow, m³/s; vessel water, m³. Defaults 0, 0, and water at the riser load. */
  readonly initial?: { readonly pressure?: number; readonly driveFlow?: number; readonly vesselWater?: number };
  readonly liquid?: Liquid;
  readonly gravity?: number;
}

/** Waste poppet phase: 0 open, 1 closing, 2 shut, 3 reopening. */
export type RamPhase = 0 | 1 | 2 | 3;

/** One fixed step of a ram. */
export interface RamFrame {
  /** Time since the run or the cycle started, s. */
  readonly time: number;
  /** Junction gauge pressure, Pa. */
  readonly pressure: number;
  /** Drive pipe flow, m³/s. */
  readonly driveFlow: number;
  /** Water in the air vessel, m³, and the air's gauge pressure, Pa. */
  readonly vesselWater: number;
  readonly airPressure: number;
  /** Flow out of the waste valve, through the check valve and up the riser, m³/s. */
  readonly wasteFlow: number;
  readonly checkFlow: number;
  readonly deliveryFlow: number;
  /** Waste valve opening, 0 shut to 1 open. */
  readonly gate: number;
  readonly phase: RamPhase;
}

/** Volumes carried during a run or a cycle, m³. */
export interface RamVolumes {
  readonly drive: number;
  readonly waste: number;
  readonly check: number;
  readonly delivered: number;
}

/** One settled ram cycle. */
export interface RamCycle {
  /** Delivery height above the pump, m. */
  readonly lift: number;
  readonly frames: readonly RamFrame[];
  /** Cycle period, s. */
  readonly period: number;
  readonly volumes: RamVolumes;
  /** Mean flows over the cycle, m³/s. */
  readonly meanDelivery: number;
  readonly meanWaste: number;
  /** d'Aubuisson efficiency, (lift · V_delivered) / (supply head · V_drive). */
  readonly efficiency: number;
  /** Rankine efficiency, V_delivered (lift - supply) / (V_waste · supply). */
  readonly rankineEfficiency: number;
  /** Peak junction gauge pressure in the cycle, Pa. */
  readonly peakPressure: number;
  /** Water stored in the junction and the vessel at the start and end of the cycle, m³ (the balance check). */
  readonly storedStart: number;
  readonly storedEnd: number;
  /** Cycles run before this one settled. */
  readonly cycles: number;
}

/** A run of a ram from its initial state. */
export interface RamRun {
  readonly frames: readonly RamFrame[];
  readonly volumes: RamVolumes;
  readonly peakPressure: number;
}

/** Options for {@link HydraulicRam.settle}. */
export interface RamSettleOptions {
  /** Longest simulated time before giving up, s. Default 64. */
  readonly maxSeconds?: number;
  /** The cycle has settled when the vessel water changes by less than this between cycles, m³. Default 1.5e-8. */
  readonly tolerance?: number;
  /** Least number of full cycles before settling counts. Default 9. */
  readonly minCycles?: number;
  /** Cancels the run; it is checked between cycles. */
  readonly signal?: AbortSignal;
}

/** A lumped hydraulic ram: drive column, waste poppet, junction, check valve, air vessel and riser. */
export class HydraulicRam {
  readonly params: HydraulicRamParams;
  /** Drive inertance ρL/A, kg/m⁴, and junction compliance, m³/Pa. */
  readonly inertance: number;
  readonly compliance: number;
  /** The step used, s. */
  readonly step: number;
  readonly #density: number;
  readonly #gravity: number;
  readonly #atmosphere: number;
  readonly #exponent: number;
  readonly #vessel: number;

  constructor(params: HydraulicRamParams) {
    const liquid = params.liquid ?? WATER;
    this.#density = liquid.density;
    this.#gravity = positive('gravity', params.gravity ?? GRAVITY);
    this.#atmosphere = positive('atmosphere', params.atmosphere ?? ATMOSPHERE);
    positive('supplyHead', params.supplyHead);
    const length = positive('driveLength', params.driveLength),
      area = circleArea(positive('driveDiameter', params.driveDiameter));
    nonNegative('driveResistance', params.driveResistance ?? 0);
    this.inertance = (liquid.density * length) / area;
    if (params.compliance !== undefined) this.compliance = positive('compliance', params.compliance);
    else if (params.waveSpeed !== undefined) {
      const a = positive('waveSpeed', params.waveSpeed);
      this.compliance = (area * length) / (liquid.density * a * a);
    } else throw new RangeError('A hydraulic ram needs a junction compliance or a drive-pipe wave speed.');
    const w = params.waste;
    if (!w) throw new RangeError('A hydraulic ram needs a waste valve.');
    nonNegative('waste.conductance', w.conductance);
    positive('waste.tripFlow', w.tripFlow);
    positive('waste.closeTime', w.closeTime);
    nonNegative('waste.holdTime', w.holdTime);
    finite('waste.reopenPressure', w.reopenPressure);
    positive('waste.reopenTime', w.reopenTime);
    nonNegative('checkConductance', params.checkConductance);
    nonNegative('deliveryConductance', params.deliveryConductance);
    this.#vessel = positive('vessel.volume', params.vessel?.volume ?? Number.NaN);
    this.#exponent = positive('vessel.exponent', params.vessel.exponent ?? 1.2);
    this.step = positive('step', params.step ?? 0.00075);
    this.params = params;
  }

  /** Air gauge pressure with `water` m³ in the vessel: P₀ (V₀ / (V₀ - V_w))^n - P₀. */
  airPressure(water: number): number {
    return this.#atmosphere * (pow(this.#vessel / (this.#vessel - water), this.#exponent) - 1);
  }

  /** Vessel water at an air gauge pressure (the inverse of {@link airPressure}). */
  vesselWaterAt(pressure: number): number {
    return this.#vessel * (1 - pow(this.#atmosphere / (this.#atmosphere + pressure), 1 / this.#exponent));
  }

  /** Runs `seconds` of the ram from its initial state at delivery height `lift` m, keeping every frame. */
  simulate(lift: number, seconds: number): RamRun {
    const frames: RamFrame[] = [];
    const run = this.#run(positive('lift', lift), positive('seconds', seconds), (frame) => {
      frames.push(frame);
      return false;
    });
    return { frames, volumes: run.total, peakPressure: run.peak };
  }

  /**
   * Runs the ram at delivery height `lift` m until its cycle repeats, and returns the last full cycle (its frames start
   * as the waste valve finishes reopening). Throws a MargoError `'failed'` when no cycle settles within `maxSeconds`.
   */
  settle(lift: number, options: RamSettleOptions = {}): RamCycle {
    positive('lift', lift);
    const maxSeconds = positive('maxSeconds', options.maxSeconds ?? 64),
      tolerance = positive('tolerance', options.tolerance ?? 1.5e-8),
      minCycles = nonNegative('minCycles', options.minCycles ?? 9),
      signal = options.signal;
    signal?.throwIfAborted();
    let frames: RamFrame[] = [],
      found: RamCycle | undefined,
      previous: number | undefined,
      cycles = 0,
      start = 0,
      startStored = Number.NaN,
      peak = Number.NEGATIVE_INFINITY;
    const v0: RamVolumes = { drive: 0, waste: 0, check: 0, delivered: 0 };
    let mark = { ...v0 };
    const run = this.#run(lift, maxSeconds, (frame, total, cycleEnd) => {
      if (Number.isNaN(startStored)) startStored = this.#stored(frames.length ? frames[0]! : frame);
      frames.push({ ...frame, time: frame.time - start });
      peak = Math.max(peak, frame.pressure);
      if (!cycleEnd) return false;
      cycles++;
      const volumes = {
        drive: total.drive - mark.drive,
        waste: total.waste - mark.waste,
        check: total.check - mark.check,
        delivered: total.delivered - mark.delivered,
      };
      const period = frames.length * this.step,
        h = this.params.supplyHead;
      if (cycles > 3)
        found = {
          lift,
          frames,
          period,
          volumes,
          meanDelivery: volumes.delivered / period,
          meanWaste: volumes.waste / period,
          efficiency: (lift * volumes.delivered) / (h * volumes.drive),
          rankineEfficiency: (volumes.delivered * (lift - h)) / (volumes.waste * h),
          peakPressure: peak,
          storedStart: startStored,
          storedEnd: this.#stored(frame),
          cycles,
        };
      const settled =
        cycles >= minCycles && previous !== undefined && Math.abs(previous - frame.vesselWater) < tolerance;
      previous = frame.vesselWater;
      frames = [];
      mark = { ...total };
      start = frame.time;
      startStored = this.#stored(frame);
      peak = Number.NEGATIVE_INFINITY;
      if (settled) return true;
      if (signal?.aborted) return true;
      return false;
    });
    signal?.throwIfAborted();
    if (!run.stopped || !found)
      throw new MargoError(
        'failed',
        `No settled ram cycle at a ${lift} m lift within ${maxSeconds} s; check the valve settings.`,
      );
    return found;
  }

  #stored(frame: RamFrame): number {
    return this.compliance * frame.pressure + frame.vesselWater;
  }

  #run(
    lift: number,
    seconds: number,
    visit: (frame: RamFrame, total: RamVolumes, cycleEnd: boolean) => boolean,
  ): { total: RamVolumes; peak: number; stopped: boolean } {
    const p0 = this.params,
      w = p0.waste,
      rho = this.#density,
      g = this.#gravity,
      head = rho * g * lift,
      incoming = rho * g * p0.supplyHead,
      resistance = p0.driveResistance ?? 0,
      inertance = this.inertance,
      compliance = this.compliance,
      step = this.step,
      check = p0.checkConductance,
      delivery = p0.deliveryConductance;
    const flux = (pressure: number, water: number, opening: number) => {
      const air = this.airPressure(water);
      return {
        air,
        waste: w.conductance * opening * Math.sqrt(Math.max(0, pressure)),
        check: check * Math.sqrt(Math.max(0, pressure - air)),
        delivered: delivery * Math.sqrt(Math.max(0, air - head)),
      };
    };
    const shape = (phase: RamPhase, t: number): number => {
      if (phase === 0) return 1;
      if (phase === 1) {
        const s = Math.max(0, 1 - t / w.closeTime);
        return s * s;
      }
      if (phase === 2) return 0;
      return Math.min(1, t / w.reopenTime);
    };
    const gradient = (q: number, p: number): number => (incoming - p - resistance * q * Math.abs(q)) / inertance;
    let p = finite('initial.pressure', p0.initial?.pressure ?? 0),
      q = finite('initial.driveFlow', p0.initial?.driveFlow ?? 0),
      water = p0.initial?.vesselWater ?? this.vesselWaterAt(head),
      phase: RamPhase = 0,
      inPhase = 0,
      peak = p;
    if (!(water >= 0 && water < this.#vessel))
      throw new RangeError(`Initial vessel water ${water} m³ must lie in [0, vessel volume).`);
    const total = { drive: 0, waste: 0, check: 0, delivered: 0 };
    const ticks = Math.floor(seconds / step);
    for (let tick = 0; tick < ticks; tick++) {
      const a = flux(p, water, shape(phase, inPhase));
      const midP = p + ((q - a.waste - a.check) / compliance) * step * 0.5,
        midQ = q + gradient(q, p) * step * 0.5,
        midWater = water + (a.check - a.delivered) * step * 0.5;
      const b = flux(midP, midWater, shape(phase, inPhase + step * 0.5));
      p += ((midQ - b.waste - b.check) / compliance) * step;
      q += gradient(midQ, midP) * step;
      water += (b.check - b.delivered) * step;
      if (!Number.isFinite(p) || !Number.isFinite(q) || !(water < this.#vessel))
        throw new MargoError('failed', 'The ram integration diverged; use a smaller step or a larger compliance.');
      inPhase += step;
      total.drive += midQ * step;
      total.waste += b.waste * step;
      total.check += b.check * step;
      total.delivered += b.delivered * step;
      peak = Math.max(peak, p);
      const gate = shape(phase, inPhase),
        now = flux(p, water, gate);
      const frame: RamFrame = {
        time: (tick + 1) * step,
        pressure: p,
        driveFlow: q,
        vesselWater: water,
        airPressure: now.air,
        wasteFlow: now.waste,
        checkFlow: now.check,
        deliveryFlow: now.delivered,
        gate,
        phase,
      };
      let cycleEnd = false;
      if (phase === 0 && a.waste >= w.tripFlow) {
        phase = 1;
        inPhase = 0;
      } else if (phase === 1 && inPhase >= w.closeTime) {
        phase = 2;
        inPhase = 0;
      } else if (phase === 2 && inPhase >= w.holdTime && p < w.reopenPressure) {
        phase = 3;
        inPhase = 0;
      } else if (phase === 3 && inPhase >= w.reopenTime) {
        phase = 0;
        inPhase = 0;
        cycleEnd = true;
      }
      if (visit(frame, total, cycleEnd)) return { total, peak, stopped: true };
    }
    return { total, peak, stopped: false };
  }
}

/** The frame of a settled cycle at `time` s, wrapping around the period. */
export function ramFrameAt(cycle: RamCycle, time: number): RamFrame {
  const t = ((finite('time', time) % cycle.period) + cycle.period) % cycle.period;
  return cycle.frames[Math.min(cycle.frames.length - 1, Math.floor(t / (cycle.period / cycle.frames.length)))]!;
}
