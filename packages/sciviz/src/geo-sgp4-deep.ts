// Solar/lunar quadrupole averaging and geopotential resonances, equations described by
// Hujsak (1979), Hoots et al. (2004), with the perturbed-inclination Lyddane choice of Vallado et al. (2006).
export interface MeanOrbit {
  epoch: number;
  eccentricity: number;
  inclination: number;
  node: number;
  perigee: number;
  anomaly: number;
  motion: number;
}
interface Rates {
  anomaly: number;
  perigee: number;
  node: number;
}
const TAU = Math.PI * 2,
  spin = 0.0043752690880113;
interface Body {
  phase: number;
  frequency: number;
  eccentricity: number;
  /** Each row multiplies [f2,f3,sin(f)]; order e,i,M,omega,Omega*sin(i). */
  periodic: number[][];
  rates: number[];
}
function thirdBody(
  orbit: MeanOrbit,
  si: number,
  ci: number,
  sh: number,
  ch: number,
  sg: number,
  cg: number,
  scale: number,
  frequency: number,
  eccentricity: number,
  phase: number,
): Body {
  const c = Math.cos(orbit.inclination),
    s = Math.sin(orbit.inclination),
    co = Math.cos(orbit.perigee),
    so = Math.sin(orbit.perigee),
    e = orbit.eccentricity,
    b2 = 1 - e * e,
    b = Math.sqrt(b2);
  // Rotate the body's orbital basis into the satellite's equator and apsidal axes.
  const A = [cg * ch + sg * ci * sh, -cg * sh + sg * ci * ch, sg * si],
    B = [-sg * ch + cg * ci * sh, sg * sh + cg * ci * ch, cg * si],
    ay = c * A[1] + s * A[2],
    by = c * B[1] + s * B[2],
    az = -s * A[1] + c * A[2],
    bz = -s * B[1] + c * B[2],
    x = [
      A[0] * co + ay * so,
      B[0] * co + by * so,
      -A[0] * so + ay * co,
      -B[0] * so + by * co,
      az * so,
      bz * so,
      az * co,
      bz * co,
    ],
    z31 = 12 * x[0] ** 2 - 3 * x[2] ** 2,
    z32 = 24 * x[0] * x[1] - 6 * x[2] * x[3],
    z33 = 12 * x[1] ** 2 - 3 * x[3] ** 2,
    z1 = 2 * (3 * (A[0] ** 2 + ay ** 2) + z31 * e * e) + b2 * z31,
    z2 = 2 * (6 * (A[0] * B[0] + ay * by) + z32 * e * e) + b2 * z32,
    z3 = 2 * (3 * (B[0] ** 2 + by ** 2) + z33 * e * e) + b2 * z33,
    z11 = -6 * A[0] * az + e * e * (-24 * x[0] * x[6] - 6 * x[2] * x[4]),
    z12 = -6 * (A[0] * bz + B[0] * az) + e * e * (-24 * (x[1] * x[6] + x[0] * x[7]) - 6 * (x[2] * x[5] + x[3] * x[4])),
    z13 = -6 * B[0] * bz + e * e * (-24 * x[1] * x[7] - 6 * x[3] * x[5]),
    z21 = 6 * ay * az + e * e * (24 * x[0] * x[4] - 6 * x[2] * x[6]),
    z22 = 6 * (by * az + ay * bz) + e * e * (24 * (x[1] * x[4] + x[0] * x[5]) - 6 * (x[3] * x[6] + x[2] * x[7])),
    z23 = 6 * by * bz + e * e * (24 * x[1] * x[5] - 6 * x[3] * x[7]),
    s3 = scale / orbit.motion,
    s2 = (-0.5 * s3) / b,
    s4 = s3 * b,
    s1 = -15 * e * s4,
    s5 = x[0] * x[2] + x[1] * x[3],
    s6 = x[1] * x[2] + x[0] * x[3],
    s7 = x[1] * x[3] - x[0] * x[2];
  const nodeRate =
    orbit.inclination < 0.052359877 || orbit.inclination > Math.PI - 0.052359877
      ? 0
      : (-frequency * s2 * (z21 + z23)) / s;
  return {
    phase,
    frequency,
    eccentricity,
    periodic: [
      [2 * s1 * s6, 2 * s1 * s7, 0],
      [2 * s2 * z12, 2 * s2 * (z13 - z11), 0],
      [-2 * s3 * z2, -2 * s3 * (z3 - z1), -2 * s3 * (-21 - 9 * e * e) * eccentricity],
      [2 * s4 * z32, 2 * s4 * (z33 - z31), -18 * s4 * eccentricity],
      [-2 * s2 * z22, -2 * s2 * (z23 - z21), 0],
    ],
    rates: [
      s1 * frequency * s5,
      s2 * frequency * (z11 + z13),
      -frequency * s3 * (z1 + z3 - 14 - 6 * e * e),
      s4 * frequency * (z31 + z33 - 6) - c * nodeRate,
      nodeRate,
    ],
  };
}
/** Mathematical resonance term: coefficient * sin(k*lambda + j*omega - phase). */
interface Harmonic {
  coefficient: number;
  k: number;
  j: number;
  phase: number;
}
const polynomial = (x: number, coefficients: number[]) => coefficients.reduceRight((v, a) => v * x + a, 0);
function resonance(orbit: MeanOrbit, a: number): { synchronous: boolean; terms: Harmonic[] } | undefined {
  const n = orbit.motion,
    e = orbit.eccentricity,
    c = Math.cos(orbit.inclination),
    s = Math.sin(orbit.inclination),
    c2 = c * c,
    s2 = s * s,
    e2 = e * e,
    factor = 3 * (n / a) ** 2;
  if (n > 0.0034906585 && n < 0.0052359877)
    return {
      synchronous: true,
      terms: [
        {
          coefficient: (factor * (0.9375 * s2 * (1 + 3 * c) - 0.75 * (1 + c)) * (1 + 2 * e2) * 2.1460748e-6) / a,
          k: 1,
          j: 0,
          phase: 0.13130908,
        },
        {
          coefficient: 2 * factor * 0.75 * (1 + c) ** 2 * (1 + e2 * (-2.5 + 0.8125 * e2)) * 1.7891679e-6,
          k: 2,
          j: 0,
          phase: 2 * 2.8843198,
        },
        {
          coefficient: (3 * factor * 1.875 * (1 + c) ** 3 * (1 + e2 * (-6 + 6.60937 * e2)) * 2.2123015e-7) / a,
          k: 3,
          j: 0,
          phase: 3 * 0.37448087,
        },
      ],
    };
  if (n < 0.00826 || n > 0.00924 || e < 0.5) return undefined;
  // Published piecewise eccentricity functions of the ten 12-hour tesseral/sectoral harmonics.
  const low = e <= 0.65,
    g211 = polynomial(e, low ? [3.616, -13.247, 16.29] : [-72.099, 331.819, -508.738, 266.724]),
    g310 = polynomial(e, low ? [-19.302, 117.39, -228.419, 156.591] : [-346.844, 1582.851, -2415.925, 1246.113]),
    g322 = polynomial(e, low ? [-18.9068, 109.7927, -214.6334, 146.5816] : [-342.585, 1554.908, -2366.899, 1215.972]),
    g410 = polynomial(e, low ? [-41.122, 242.694, -471.094, 313.953] : [-1052.797, 4758.686, -7193.992, 3651.957]),
    g422 = polynomial(e, low ? [-146.407, 841.88, -1629.014, 1083.435] : [-3581.69, 16178.11, -24462.77, 12422.52]),
    g520 = polynomial(
      e,
      low
        ? [-532.114, 3017.977, -5740.032, 3708.276]
        : e > 0.715
          ? [-5149.66, 29936.92, -54087.36, 31324.56]
          : [1464.74, -4664.75, 3763.64],
    ),
    g521 = polynomial(
      e,
      e < 0.7 ? [-822.71072, 4568.6173, -8491.4146, 5337.524] : [-51752.104, 218913.95, -309468.16, 146349.42],
    ),
    g532 = polynomial(
      e,
      e < 0.7 ? [-853.666, 4690.25, -8624.77, 5341.4] : [-40023.88, 170470.89, -242699.48, 115605.82],
    ),
    g533 = polynomial(
      e,
      e < 0.7 ? [-919.2277, 4988.61, -9064.77, 5542.21] : [-37995.78, 161616.52, -229838.2, 109377.94],
    ),
    f220 = 0.75 * (1 + 2 * c + c2),
    rows = [
      [1, 2, 5.7686396, 1.7891679e-6, 0, f220, -0.306 - 0.44 * (e - 0.64)],
      [1, 0, 5.7686396, 1.7891679e-6, 0, 1.5 * s2, g211],
      [1, 1, 0.95240898, 3.7393792e-7, 1, 1.875 * s * (1 - 2 * c - 3 * c2), g310],
      [1, -1, 0.95240898, 3.7393792e-7, 1, -1.875 * s * (1 + 2 * c - 3 * c2), g322],
      [2, 2, 1.8014998, 2 * 7.3636953e-9, 2, 35 * s2 * f220, g410],
      [2, 0, 1.8014998, 2 * 7.3636953e-9, 2, 39.375 * s2 * s2, g422],
      [
        1,
        1,
        1.050833,
        1.1428639e-7,
        3,
        9.84375 * s * (s2 * (1 - 2 * c - 5 * c2) + 0.33333333 * (-2 + 4 * c + 6 * c2)),
        g520,
      ],
      [
        1,
        -1,
        1.050833,
        1.1428639e-7,
        3,
        s * (4.92187512 * s2 * (-2 - 4 * c + 10 * c2) + 6.56250012 * (1 + 2 * c - 3 * c2)),
        g532,
      ],
      [2, 1, 4.4108898, 2 * 2.1765803e-9, 3, 29.53125 * s * (2 - 8 * c + c2 * (-12 + 8 * c + 10 * c2)), g521],
      [2, -1, 4.4108898, 2 * 2.1765803e-9, 3, 29.53125 * s * (-2 - 8 * c + c2 * (12 + 8 * c - 10 * c2)), g533],
    ];
  return {
    synchronous: false,
    terms: rows.map(([k, j, phase, weight, power, f, g]) => ({
      k,
      j,
      phase,
      coefficient: (factor * weight * f * g) / a ** power,
    })),
  };
}
export function deepSpace(
  initial: MeanOrbit,
  gravity: Rates,
  a0: number,
  sidereal: number,
): {
  secular: (orbit: MeanOrbit, minutes: number) => MeanOrbit;
  periodic: (orbit: MeanOrbit, minutes: number) => MeanOrbit;
} {
  const day = initial.epoch / 86400000 + 2440587.5 - 2415020,
    lunarNode = (4.523602 - 0.00092422029 * day) % TAU,
    ci = 0.91375164 - 0.03568096 * Math.cos(lunarNode),
    si = Math.sqrt(1 - ci * ci),
    sh = (0.089683511 * Math.sin(lunarNode)) / si,
    ch = Math.sqrt(1 - sh * sh),
    gamma = 5.8351514 + 0.001944368 * day,
    lunarArg =
      gamma +
      Math.atan2(
        (0.39785416 * Math.sin(lunarNode)) / si,
        ch * Math.cos(lunarNode) + 0.91744867 * sh * Math.sin(lunarNode),
      ) -
      lunarNode,
    sn = Math.sin(initial.node),
    cn = Math.cos(initial.node),
    bodies = [
      thirdBody(
        initial,
        0.39785416,
        0.91744867,
        sn,
        cn,
        -0.98088458,
        0.1945905,
        2.9864797e-6,
        1.19459e-5,
        0.01675,
        (6.2565837 + 0.017201977 * day) % TAU,
      ),
      thirdBody(
        initial,
        si,
        ci,
        sn * ch - cn * sh,
        cn * ch + sn * sh,
        Math.sin(lunarArg),
        Math.cos(lunarArg),
        4.7968065e-7,
        1.5835218e-4,
        0.0549,
        (4.7199672 + 0.2299715 * day - gamma) % TAU,
      ),
    ],
    rates = Array.from({ length: 5 }, (_, i) => bodies[0].rates[i] + bodies[1].rates[i]),
    res = resonance(initial, a0),
    harmonic = res?.terms ?? [],
    lambda0 = res?.synchronous
      ? initial.anomaly + initial.node + initial.perigee - sidereal
      : initial.anomaly + 2 * initial.node - 2 * sidereal,
    drift = res?.synchronous
      ? gravity.anomaly + gravity.perigee + gravity.node + rates[2] + rates[3] + rates[4] - spin - initial.motion
      : gravity.anomaly + rates[2] + 2 * (gravity.node + rates[4] - spin) - initial.motion;
  return {
    secular(orbit, t) {
      const out = {
        ...orbit,
        eccentricity: orbit.eccentricity + rates[0] * t,
        inclination: orbit.inclination + rates[1] * t,
        anomaly: orbit.anomaly + rates[2] * t,
        perigee: orbit.perigee + rates[3] * t,
        node: orbit.node + rates[4] * t,
      };
      if (!res) return out;
      // Integrate from epoch on each seek. This removes cache/reset dependence for backwards and nonmonotone seeks.
      let at = 0,
        motion = initial.motion,
        lambda = lambda0 % TAU;
      const step = t >= 0 ? 720 : -720;
      while (true) {
        const omega = initial.perigee + gravity.perigee * at,
          lambdaDot = motion + drift,
          nDot = harmonic.reduce((v, h) => v + h.coefficient * Math.sin(h.k * lambda + h.j * omega - h.phase), 0),
          nDDot =
            harmonic.reduce((v, h) => v + h.coefficient * h.k * Math.cos(h.k * lambda + h.j * omega - h.phase), 0) *
            lambdaDot,
          remaining = t - at;
        if (Math.abs(remaining) < 720) {
          out.motion = motion + nDot * remaining + (nDDot * remaining * remaining) / 2;
          const longitude = lambda + lambdaDot * remaining + (nDot * remaining * remaining) / 2,
            theta = (sidereal + t * spin) % TAU;
          out.anomaly = res.synchronous
            ? longitude - out.node - out.perigee + theta
            : longitude - 2 * out.node + 2 * theta;
          break;
        }
        motion += nDot * step + nDDot * 259200;
        lambda += lambdaDot * step + nDot * 259200;
        at += step;
      }
      return out;
    },
    periodic(orbit, t) {
      const corrections = [0, 0, 0, 0, 0];
      for (const body of bodies) {
        const mean = body.phase + body.frequency * t,
          f = mean + 2 * body.eccentricity * Math.sin(mean),
          basis = [0.5 * Math.sin(f) ** 2 - 0.25, -0.5 * Math.sin(f) * Math.cos(f), Math.sin(f)];
        for (let i = 0; i < 5; i++)
          corrections[i] += body.periodic[i].reduce((v, coefficient, k) => v + coefficient * basis[k], 0);
      }
      const [pe, pi, pl, pg, ph] = corrections,
        out = { ...orbit, eccentricity: orbit.eccentricity + pe, inclination: orbit.inclination + pi },
        s = Math.sin(out.inclination),
        c = Math.cos(out.inclination);
      if (out.inclination >= 0.2) {
        out.node += ph / s;
        out.perigee += pg - (c * ph) / s;
        out.anomaly += pl;
      } else {
        const original = out.node % TAU,
          sn = Math.sin(original),
          cn = Math.cos(original),
          alpha = s * sn + ph * cn + pi * c * sn,
          beta = s * cn - ph * sn + pi * c * cn,
          longitude = out.anomaly + out.perigee + c * original + pl + pg - pi * original * s;
        let node = Math.atan2(alpha, beta);
        if (node < original - Math.PI) node += TAU;
        if (node > original + Math.PI) node -= TAU;
        out.node = node;
        out.anomaly += pl;
        out.perigee = longitude - out.anomaly - c * node;
      }
      return out;
    },
  };
}
