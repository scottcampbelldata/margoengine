// Independent implementation of the mathematical SGP4 model: Hoots/Roehrich (1980), section 6;
// Vallado, Crawford, Hujsak and Kelso (2006), corrections and Appendix D/E reference vectors.
import { fault, rangeError } from '../../shared/errors.js';
import { deepSpace, type MeanOrbit } from './geo-sgp4-deep.js';
/** SGP4 mean elements. Angles are degrees, motion rev/day, epoch UTC Unix milliseconds, BSTAR inverse Earth radii. */
export interface SatelliteElements {
  readonly id: string;
  readonly name?: string;
  readonly epoch: number;
  readonly inclination: number;
  readonly node: number;
  readonly eccentricity: number;
  readonly perigee: number;
  readonly anomaly: number;
  readonly meanMotion: number;
  readonly bstar: number;
}
/** True Equator Mean Equinox of date, kilometres and kilometres/second. */
export interface SatelliteState {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly time: number;
}
const TAU = 2 * Math.PI,
  RAD = Math.PI / 180;
const RE = 6378.135,
  J2 = 0.001082616,
  J3 = -0.00000253881,
  J4 = -0.00000165597,
  KE = 60 / Math.sqrt(RE ** 3 / 398600.8),
  J32 = J3 / J2;
const angle = (v: number) => ((v % TAU) + TAU) % TAU;
const bad = (message: string) => rangeError(`SGP4: ${message}`, 'sciviz');
const numeric = (value: unknown): number => {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
  )
    throw bad('orbital numeric fields must be numbers or nonempty numeric strings');
  return Number(value);
};
/** Greenwich mean sidereal angle (IAU 1982), UTC used as UT1 unless dut1Seconds supplied. */
export function greenwichSiderealTime(time: number, dut1Seconds = 0): number {
  if (!Number.isFinite(time) || !Number.isFinite(dut1Seconds)) throw bad('time and DUT1 must be finite');
  const t = (time / 86400000 + 2440587.5 + dut1Seconds / 86400 - 2451545) / 36525;
  return angle(
    ((67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 0.0000062 * t ** 3) * RAD) / 240,
  );
}
function validate(e: SatelliteElements): SatelliteElements {
  if (
    typeof e.id !== 'string' ||
    !e.id ||
    ![e.epoch, e.inclination, e.node, e.eccentricity, e.perigee, e.anomaly, e.meanMotion, e.bstar].every(
      Number.isFinite,
    ) ||
    e.inclination < 0 ||
    e.inclination > 180 ||
    e.eccentricity < 0 ||
    e.eccentricity >= 1 ||
    e.meanMotion <= 0 ||
    e.meanMotion > 30
  )
    throw bad('need id, finite elements, inclination 0..180, eccentricity [0,1) and motion (0,30] rev/day');
  return { ...e };
}
/** Reads a CCSDS OMM JSON record (CelesTrak GP). Large catalog numbers remain strings. */
export function parseOMM(record: Readonly<Record<string, unknown>>): SatelliteElements {
  for (const [key, expected] of [
    ['CENTER_NAME', 'EARTH'],
    ['REF_FRAME', 'TEME'],
    ['TIME_SYSTEM', 'UTC'],
    ['MEAN_ELEMENT_THEORY', 'SGP4'],
  ])
    if (record[key] !== undefined && record[key] !== expected) throw bad(`OMM ${key} must be ${expected}`);
  const epoch = String(record.EPOCH ?? ''),
    iso = /(?:Z|[+-]\d\d:\d\d)$/.test(epoch) ? epoch : `${epoch}Z`;
  return validate({
    id: String(record.NORAD_CAT_ID ?? ''),
    name: record.OBJECT_NAME as string | undefined,
    epoch: Date.parse(iso),
    inclination: numeric(record.INCLINATION),
    node: numeric(record.RA_OF_ASC_NODE),
    eccentricity: numeric(record.ECCENTRICITY),
    perigee: numeric(record.ARG_OF_PERICENTER),
    anomaly: numeric(record.MEAN_ANOMALY),
    meanMotion: numeric(record.MEAN_MOTION),
    bstar: numeric(record.BSTAR),
  });
}
/** Reads fixed-column TLEs, checking checksums and matching catalog IDs. Optional name line is separate. */
export function parseTLE(
  line1: string,
  line2: string,
  options: { readonly name?: string; readonly checksum?: boolean } = {},
): SatelliteElements {
  for (const [i, line] of [line1, line2].entries()) {
    if (line.length < 69 || line[0] !== String(i + 1) || line[1] !== ' ')
      throw bad('TLE needs two complete numbered 69-column lines');
    if (options.checksum ?? true) {
      let sum = 0;
      for (const c of line.slice(0, 68)) sum += /\d/.test(c) ? Number(c) : c === '-' ? 1 : 0;
      if (!/\d/.test(line[68]) || sum % 10 !== Number(line[68])) throw bad(`TLE line ${i + 1} checksum does not match`);
    }
  }
  if (line1.slice(2, 7) !== line2.slice(2, 7)) throw bad('TLE catalog IDs differ');
  if (!/^\d{7}$/.test(line2.slice(26, 33))) throw bad('TLE eccentricity needs seven implied-decimal digits');
  const year2 = Number(line1.slice(18, 20)),
    year = year2 < 57 ? 2000 + year2 : 1900 + year2,
    day = Number(line1.slice(20, 32)),
    days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000,
    drag = line1.slice(53, 61);
  if (!/^\d{2}$/.test(line1.slice(18, 20)) || day < 1 || day >= days + 1 || !/^[ +-]\d{5}[+-]\d$/.test(drag))
    throw bad('invalid TLE epoch or BSTAR exponent');
  return validate({
    id: line1.slice(2, 7).trim(),
    name: options.name,
    epoch: Date.UTC(year, 0, 1) + (day - 1) * 86400000,
    inclination: numeric(line2.slice(8, 16)),
    node: numeric(line2.slice(17, 25)),
    eccentricity: Number(`0.${line2.slice(26, 33)}`),
    perigee: numeric(line2.slice(34, 42)),
    anomaly: numeric(line2.slice(43, 51)),
    meanMotion: numeric(line2.slice(52, 63)),
    bstar: Number(`${drag[0] === '-' ? '-' : ''}0.${drag.slice(1, 6)}e${drag.slice(6)}`),
  });
}
/** Full SGP4, including deep-space solar/lunar and synchronous/half-day resonance. WGS72 constants. */
export class SGP4 {
  readonly elements: Readonly<SatelliteElements>;
  /** Recovered orbital period in minutes. */
  readonly period: number;
  readonly method: 'near-earth' | 'deep-space';
  readonly #evaluate: (minutes: number) => SatelliteState;
  constructor(elements: SatelliteElements) {
    const e = validate(elements);
    this.elements = Object.freeze(e);
    const ecc = e.eccentricity,
      inc = e.inclination * RAD,
      node0 = e.node * RAD,
      arg0 = e.perigee * RAD,
      m0 = e.anomaly * RAD,
      c = Math.cos(inc),
      s = Math.sin(inc),
      c2 = c * c,
      beta2 = 1 - ecc * ecc,
      beta = Math.sqrt(beta2),
      rawN = (e.meanMotion * TAU) / 1440,
      a1 = (KE / rawN) ** (2 / 3),
      perturb = (0.75 * J2 * (3 * c2 - 1)) / (beta * beta2),
      d1 = perturb / (a1 * a1),
      aCorrected = a1 * (1 - d1 / 3 - d1 * d1 - (134 * d1 ** 3) / 81),
      delta = perturb / aCorrected ** 2,
      n = rawN / (1 + delta),
      a0 = (KE / n) ** (2 / 3),
      perigeeHeight = (a0 * (1 - ecc) - 1) * RE,
      deep = TAU / n >= 225,
      simple = deep || perigeeHeight < 220;
    this.period = TAU / n;
    this.method = deep ? 'deep-space' : 'near-earth';
    const atmosphere = perigeeHeight < 156 ? Math.max(20, perigeeHeight - 78) : 78,
      sf = 1 + atmosphere / RE,
      q4 = ((120 - atmosphere) / RE) ** 4,
      xi = 1 / (a0 - sf),
      eta = a0 * ecc * xi,
      eta2 = eta * eta,
      eeta = ecc * eta,
      psi = Math.abs(1 - eta2),
      coef = q4 * xi ** 4,
      scaled = coef / psi ** 3.5,
      c1 =
        e.bstar *
        scaled *
        n *
        (a0 * (1 + 1.5 * eta2 + eeta * (4 + eta2)) +
          ((0.375 * J2 * xi) / psi) * (3 * c2 - 1) * (8 + 3 * eta2 * (8 + eta2))),
      c3 = ecc > 0.0001 ? (-2 * coef * xi * J32 * n * s) / ecc : 0,
      c4 =
        2 *
        n *
        scaled *
        a0 *
        beta2 *
        (eta * (2 + 0.5 * eta2) +
          ecc * (0.5 + 2 * eta2) -
          ((J2 * xi) / (a0 * psi)) *
            (-3 * (3 * c2 - 1) * (1 - 2 * eeta + eta2 * (1.5 - 0.5 * eeta)) +
              0.75 * (1 - c2) * (2 * eta2 - eeta * (1 + eta2)) * Math.cos(2 * arg0))),
      c5 = 2 * scaled * a0 * beta2 * (1 + 2.75 * (eta2 + eeta) + eeta * eta2),
      pInverse2 = 1 / (a0 * beta2) ** 2,
      secular2 = 1.5 * J2 * pInverse2 * n,
      secular22 = 0.5 * secular2 * J2 * pInverse2,
      secular4 = -0.46875 * J4 * pInverse2 ** 2 * n,
      mRate = n + 0.5 * secular2 * beta * (3 * c2 - 1) + 0.0625 * secular22 * beta * (13 - 78 * c2 + 137 * c2 ** 2),
      argRate =
        -0.5 * secular2 * (1 - 5 * c2) +
        0.0625 * secular22 * (7 - 114 * c2 + 395 * c2 ** 2) +
        secular4 * (3 - 36 * c2 + 49 * c2 ** 2),
      nodeRate = -secular2 * c + (0.5 * secular22 * (4 - 19 * c2) + 2 * secular4 * (3 - 7 * c2)) * c,
      nodeDrag = -3.5 * beta2 * secular2 * c * c1,
      omegaDrag = e.bstar * c3 * Math.cos(arg0),
      meanDrag = ecc > 0.0001 ? (-(2 / 3) * coef * e.bstar) / eeta : 0,
      mReference = (1 + eta * Math.cos(m0)) ** 3,
      d2 = 4 * a0 * xi * c1 ** 2,
      d3 = (4 / 3) * a0 * xi ** 2 * (17 * a0 + sf) * c1 ** 3,
      d4 = (2 / 3) * a0 ** 2 * xi ** 3 * (221 * a0 + 31 * sf) * c1 ** 4,
      t3 = d2 + 2 * c1 ** 2,
      t4 = (3 * d3 + 12 * c1 * d2 + 10 * c1 ** 3) / 4,
      t5 = (3 * d4 + 12 * c1 * d3 + 6 * d2 ** 2 + 30 * c1 ** 2 * d2 + 15 * c1 ** 4) / 5,
      deepModel = deep
        ? deepSpace(
            { epoch: e.epoch, eccentricity: ecc, inclination: inc, node: node0, perigee: arg0, anomaly: m0, motion: n },
            { anomaly: mRate, perigee: argRate, node: nodeRate },
            a0,
            greenwichSiderealTime(e.epoch),
          )
        : undefined;
    this.#evaluate = (t) => {
      let mean = m0 + mRate * t,
        arg = arg0 + argRate * t,
        node = node0 + nodeRate * t + nodeDrag * t * t,
        scaleA = 1 - c1 * t,
        dragE = e.bstar * c4 * t,
        dragL = 1.5 * c1 * t * t;
      if (!simple) {
        const shift = omegaDrag * t + meanDrag * ((1 + eta * Math.cos(mean)) ** 3 - mReference);
        mean += shift;
        arg -= shift;
        scaleA -= d2 * t * t + d3 * t ** 3 + d4 * t ** 4;
        dragE += e.bstar * c5 * (Math.sin(mean) - Math.sin(m0));
        dragL += t3 * t ** 3 + t4 * t ** 4 + t5 * t ** 5;
      }
      let orbit: MeanOrbit = {
        epoch: e.epoch,
        eccentricity: ecc,
        inclination: inc,
        node,
        perigee: arg,
        anomaly: mean,
        motion: n,
      };
      if (deepModel) orbit = deepModel.secular(orbit, t);
      let a = (KE / orbit.motion) ** (2 / 3) * scaleA * scaleA;
      orbit.eccentricity -= dragE;
      if (orbit.motion <= 0 || a <= 0 || orbit.eccentricity >= 1 || orbit.eccentricity < -0.001)
        throw fault('state', 'SGP4 mean orbit is invalid at this time; use a newer element set', 'sciviz');
      orbit.eccentricity = Math.max(0.000001, orbit.eccentricity);
      orbit.anomaly = angle(orbit.anomaly + n * dragL);
      orbit.node %= TAU;
      orbit.perigee = angle(orbit.perigee);
      if (deepModel) orbit = deepModel.periodic(orbit, t);
      if (orbit.inclination < 0) {
        orbit.inclination = -orbit.inclination;
        orbit.node += Math.PI;
        orbit.perigee -= Math.PI;
      }
      const ep = orbit.eccentricity,
        ip = orbit.inclination,
        cp = Math.cos(ip),
        sp = Math.sin(ip);
      if (ep < 0 || ep >= 1)
        throw fault('state', 'SGP4 perturbed eccentricity is invalid; use a newer element set', 'sciviz');
      const inverseP = 1 / (a * (1 - ep * ep)),
        ax = ep * Math.cos(orbit.perigee),
        ay = ep * Math.sin(orbit.perigee) - 0.5 * J32 * sp * inverseP,
        xLong =
          orbit.anomaly +
          orbit.perigee -
          ((0.25 * J32 * sp * (3 + 5 * cp)) / (Math.abs(1 + cp) > 1.5e-12 ? 1 + cp : 1.5e-12)) * inverseP * ax,
        u = angle(xLong);
      let E = u;
      for (let k = 0; k < 10; k++) {
        const correction = Math.max(
          -0.95,
          Math.min(0.95, (u - ay * Math.cos(E) + ax * Math.sin(E) - E) / (1 - ay * Math.sin(E) - ax * Math.cos(E))),
        );
        E += correction;
        if (Math.abs(correction) < 1e-12) break;
      }
      const ec = ax * Math.cos(E) + ay * Math.sin(E),
        es = ax * Math.sin(E) - ay * Math.cos(E),
        el2 = ax * ax + ay * ay,
        p = a * (1 - el2);
      if (p < 0) throw fault('state', 'SGP4 semilatus rectum is negative; use a newer element set', 'sciviz');
      const radius = a * (1 - ec),
        q = es / (1 + Math.sqrt(1 - el2)),
        sinU = (a / radius) * (Math.sin(E) - ay - ax * q),
        cosU = (a / radius) * (Math.cos(E) - ax + ay * q),
        sin2U = 2 * sinU * cosU,
        cos2U = 1 - 2 * sinU * sinU,
        k2p = (0.5 * J2) / p,
        k2p2 = k2p / p,
        cp2 = cp * cp,
        con41 = 3 * cp2 - 1,
        rk = radius * (1 - 1.5 * k2p2 * Math.sqrt(1 - el2) * con41) + 0.5 * k2p * (1 - cp2) * cos2U,
        uk = Math.atan2(sinU, cosU) - 0.25 * k2p2 * (7 * cp2 - 1) * sin2U,
        nk = orbit.node + 1.5 * k2p2 * cp * sin2U,
        ik = ip + 1.5 * k2p2 * cp * sp * cos2U,
        nm = KE / a ** 1.5,
        radial = (Math.sqrt(a) * es) / radius - (nm * k2p * (1 - cp2) * sin2U) / KE,
        transverse = Math.sqrt(p) / radius + (nm * k2p * ((1 - cp2) * cos2U + 1.5 * con41)) / KE,
        N = [Math.cos(nk), Math.sin(nk), 0],
        M = [-Math.sin(nk) * Math.cos(ik), Math.cos(nk) * Math.cos(ik), Math.sin(ik)],
        U = N.map((v, k) => v * Math.cos(uk) + M[k] * Math.sin(uk)),
        V = N.map((v, k) => -v * Math.sin(uk) + M[k] * Math.cos(uk));
      if (rk < 1) throw fault('state', 'SGP4 satellite has decayed below the Earth reference ellipsoid', 'sciviz');
      const position = U.map((v) => v * rk * RE) as [number, number, number],
        velocity = U.map((v, k) => ((v * radial + V[k] * transverse) * RE * KE) / 60) as [number, number, number];
      if (![...position, ...velocity].every(Number.isFinite)) throw bad('propagation overflow; reduce time from epoch');
      return { position, velocity, time: e.epoch + t * 60000 };
    };
  }
  /** Pure, seek-order-independent propagation, minutes since the element epoch. Maximum absolute offset 10 years. */
  propagate(minutes: number): SatelliteState {
    if (!Number.isFinite(minutes) || Math.abs(minutes) > 5259600)
      throw bad('minutes must be finite and within ten years of epoch');
    return this.#evaluate(minutes);
  }
  /** UTC Unix milliseconds. */
  at(time: number): SatelliteState {
    return this.propagate((time - this.elements.epoch) / 60000);
  }
}
/** TEME to WGS84 geodetic longitude/latitude degrees and altitude metres, polar motion neglected. */
export function satelliteGeodetic(
  state: SatelliteState,
  options: { readonly dut1Seconds?: number } = {},
): [number, number, number] {
  const theta = greenwichSiderealTime(state.time, options.dut1Seconds ?? 0),
    [x, y, z] = state.position,
    p = Math.hypot(x, y),
    ecc2 = (2 - 1 / 298.257223563) / 298.257223563,
    a = 6378.137;
  if (![x, y, z].every(Number.isFinite) || Math.hypot(p, z) === 0)
    throw bad('geodetic conversion needs a nonzero finite position');
  let lat = Math.atan2(z, p * (1 - ecc2));
  for (let i = 0; i < 12; i++) {
    const n = a / Math.sqrt(1 - ecc2 * Math.sin(lat) ** 2),
      next = Math.atan2(z + n * ecc2 * Math.sin(lat), p);
    if (Math.abs(next - lat) < 1e-14) {
      lat = next;
      break;
    }
    lat = next;
  }
  const n = a / Math.sqrt(1 - ecc2 * Math.sin(lat) ** 2),
    h = p * Math.cos(lat) + z * Math.sin(lat) - n * (1 - ecc2 * Math.sin(lat) ** 2);
  return [(angle(Math.atan2(y, x) - theta + Math.PI) - Math.PI) / RAD, lat / RAD, h * 1000];
}
