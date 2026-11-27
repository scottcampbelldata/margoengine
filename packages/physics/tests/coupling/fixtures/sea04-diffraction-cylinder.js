// MacCamy & Fuchs (1954), Wave Forces on Piles, Technical Memorandum 69.
// https://usace.contentdm.oclc.org/digital/api/collection/p266001coll1/id/7401/download
// Integer Bessel power series and recurrences follow https://dlmf.nist.gov/10.8 and /10.6.
const eulerGamma = 0.5772156649015329;
const orders = 24;

function bessel(x) {
  const j = new Float64Array(orders + 2);
  const y = new Float64Array(j.length);
  const square = (x / 2) ** 2;
  let first = 1;
  let harmonicSum = 0;
  let harmonicDerivative = 0;
  for (let n = 0; n < j.length; n++) {
    let term = first;
    let sum = term;
    let harmonic = 0;
    for (let m = 1; m <= 64; m++) {
      term *= -square / (m * (m + n));
      sum += term;
      if (n === 0) {
        harmonic += 1 / m;
        harmonicSum -= harmonic * term;
        harmonicDerivative -= (2 * m * harmonic * term) / x;
      }
      if (Math.abs(term) < 1e-19 * Math.abs(first)) break;
    }
    j[n] = sum;
    first *= x / (2 * (n + 1));
  }
  const logarithm = Math.log(x / 2) + eulerGamma;
  y[0] = (2 / Math.PI) * (logarithm * j[0] + harmonicSum);
  y[1] = (2 / Math.PI) * (logarithm * j[1] - j[0] / x - harmonicDerivative);
  for (let n = 1; n <= orders; n++) y[n + 1] = (2 * n * y[n]) / x - y[n - 1];
  return { j, y };
}

// Unit incidence exp(i*k*x), time convention exp(-i*omega*t).
// Subtract J'_n(ka)/H'_n(ka) times the outgoing Hankel mode so that
// the incident and scattered normal derivatives cancel at r=a.
export function cylinderMode(k, a) {
  const { j, y } = bessel(k * a);
  const coefficients = Array.from({ length: orders }, (_, n) => {
    const jPrime = (n * j[n]) / (k * a) - j[n + 1];
    const yPrime = (n * y[n]) / (k * a) - y[n + 1];
    const norm = jPrime ** 2 + yPrime ** 2;
    const real = -(jPrime ** 2) / norm;
    const imaginary = (jPrime * yPrime) / norm;
    return n === 0
      ? [real, imaginary]
      : [
          [2 * real, 2 * imaginary],
          [-2 * imaginary, 2 * real],
          [-2 * real, -2 * imaginary],
          [2 * imaginary, -2 * real],
        ][n % 4];
  });
  const radialCache = new Map();
  return (x, z) => {
    const radius = Math.hypot(x, z);
    if (radius < a) return [0, 0];
    const angle = Math.atan2(z, x);
    let radial = radialCache.get(radius);
    if (radial === undefined) {
      radial = bessel(k * radius);
      radialCache.set(radius, radial);
    }
    let real = Math.cos(k * x);
    let imaginary = Math.sin(k * x);
    for (let n = 0; n < orders; n++) {
      const [c, d] = coefficients[n];
      const phase = Math.cos(n * angle);
      real += phase * (c * radial.j[n] - d * radial.y[n]);
      imaginary += phase * (c * radial.y[n] + d * radial.j[n]);
    }
    return [real, imaginary];
  };
}
