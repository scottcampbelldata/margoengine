export const span = 24;
export const saddleHeight = 4.45;
export const unloadedSag = 3.21;
export const uniformLoad = .42;
export const testLoad = 9.8;
export const axialRigidity = 25000;

const unloadedHorizontal = uniformLoad * span ** 2 / (8 * unloadedSag);
const quadrature = [
  [.1834346424956498, .3626837833783620], [.5255324099163290, .3137066458778873],
  [.7966664774136267, .2223810344533745], [.9602898564975363, .1012285362903763],
];

function integrate(from, to, value) {
  const radius = (to - from) / 2;
  const center = from + radius;
  let result = 0;
  for (const [node, weight] of quadrature) {
    result += weight * (value(center - radius * node) + value(center + radius * node));
  }
  return result * radius;
}

function unstrainedLength(horizontal, left, loadAt, force) {
  const unstretch = (x, jump) => {
    const tension = Math.hypot(horizontal, left - uniformLoad * x - jump);
    return tension / (horizontal * (1 + tension / axialRigidity));
  };
  return integrate(0, loadAt, (x) => unstretch(x, 0)) +
    integrate(loadAt, span, (x) => unstretch(x, force));
}

export const restLength = unstrainedLength(unloadedHorizontal, uniformLoad * span / 2, span / 2, 0);
export const referenceSag = (x) => 4 * unloadedSag * x * (span - x) / span ** 2;

export function equilibrium(position, totalLoad = testLoad) {
  const loadAt = Math.min(span, Math.max(0, position));
  const force = totalLoad / 2;
  const left = uniformLoad * span / 2 + force * (span - loadAt) / span;
  const right = uniformLoad * span + force - left;

  // At constant projected load the unstrained length decreases as horizontal force increases.
  let lower = unloadedHorizontal / 4;
  let upper = unloadedHorizontal * (4 + totalLoad / (uniformLoad * span));
  for (let iteration = 0; iteration < 36; iteration++) {
    const trial = (lower + upper) / 2;
    if (unstrainedLength(trial, left, loadAt, force) > restLength) lower = trial;
    else upper = trial;
  }
  const horizontal = (lower + upper) / 2;
  const sag = (x) => (left * x - uniformLoad * x ** 2 / 2 - force * Math.max(0, x - loadAt)) / horizontal;
  const deck = (x) => referenceSag(x) - sag(x);
  // A cart directly above a saddle is borne by the tower, outside the free cable.
  const freeLeft = left - (loadAt === 0 ? force : 0);
  const freeRight = right - (loadAt === span ? force : 0);
  const slope = (x) => 4 * unloadedSag * (span - 2 * x) / span ** 2
    - (left - uniformLoad * x - (loadAt < span && x >= loadAt ? force : 0)) / horizontal;
  return {
    loadAt, horizontal, left, right, sag, deck, slope,
    peakTension: Math.hypot(horizontal, Math.max(freeLeft, freeRight)),
    compatibleLength: unstrainedLength(horizontal, left, loadAt, force),
  };
}