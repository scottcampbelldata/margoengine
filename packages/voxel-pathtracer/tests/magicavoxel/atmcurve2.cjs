// Slider curves refitted on the thin-atmosphere geometry (planet 25000 km, top 8 km).
const { samples, error, nelder } = require('./atmfit.cjs');
const B = {
  E: 7.6238,
  sR: 0.047073,
  sM: 0.0029483,
  HR: 3.1537,
  HM: 3.4329,
  g: 0.85,
  phase: 'cs',
  mieExtScale: 1.2135,
  R: 25000,
  top: 8,
  steps: 32,
  rayK: [45 / 255, 104 / 255, 1],
  mieK: [1, 1, 1],
  o3K: [105 / 255, 1, 110 / 255],
  sO: 0,
  amb: 0,
};
const one = (p, set) => error(p, [set]);
for (const [name, d] of [
  ['ray02', 0.2],
  ['ray08', 0.8],
  ['ray10', 1],
]) {
  const set = samples(name, 20),
    f = (x) => one({ ...B, sR: B.sR * Math.exp(x[0]) }, set);
  const b = nelder(f, [Math.log(d / 0.4)], [0.3], 60);
  console.log(
    name,
    'ray x',
    Math.exp(b.x[0]).toFixed(4),
    'rms',
    b.f.toFixed(4),
    'unfitted',
    f([Math.log(d / 0.4)]).toFixed(4),
  );
}
for (const [name, d] of [
  ['mie02', 0.2],
  ['mie07', 0.7],
  ['mie10', 1],
]) {
  const set = samples(name, 20),
    f = (x) => one({ ...B, sM: B.sM * Math.exp(x[0]), mieExtScale: B.mieExtScale * Math.exp(x[1]) }, set);
  const b = nelder(f, [Math.log(d / 0.4), 0], [0.3, 0.3], 120);
  console.log(
    name,
    'mie x',
    Math.exp(b.x[0]).toFixed(4),
    'ext/scat',
    (B.mieExtScale * Math.exp(b.x[1])).toFixed(3),
    'rms',
    b.f.toFixed(4),
  );
}
const g05 = samples('g05', 20);
console.log('g05 rms', one({ ...B, g: 0.5 }, g05).toFixed(4));
const gf = nelder((x) => one({ ...B, g: Math.tanh(x[0]) }, g05), [Math.atanh(0.5)], [0.2], 50);
console.log('g05 best g', Math.tanh(gf.x[0]).toFixed(3), 'rms', gf.f.toFixed(4));
console.log('mieRed rms', one({ ...B, mieK: [1, 128 / 255, 64 / 255] }, samples('mieRed', 20)).toFixed(4));
console.log('raywhite rms', one({ ...B, rayK: [1, 1, 1] }, samples('raywhite', 20)).toFixed(4));
const o3 = samples('o3', 20);
for (const prof of ['rayleigh', 'layer']) {
  const b = nelder((x) => one({ ...B, sO: Math.exp(x[0]), o3Profile: prof }, o3), [Math.log(0.3)], [0.5], 60);
  console.log('o3', prof, 'sO', Math.exp(b.x[0]).toFixed(4), 'rms', b.f.toFixed(4));
}
