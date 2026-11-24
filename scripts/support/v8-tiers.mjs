// Which tier of V8 runs a function, for tests that must measure optimized code. %GetOptimizationStatus returns V8's own
// bit field and the bits move between versions: Turbofan is bit 64 on V8 13 (Node 24) and bit 32 on V8 14 (Node 26),
// where bit 64 means the interpreter. So nothing here names a bit. Three small functions are put in known tiers, and
// what differs between them is the answer. A V8 that breaks that reading throws instead of misreporting.
import { execFileSync } from 'node:child_process';
import { setFlagsFromString } from 'node:v8';

// In a process of its own, as the caller may run with a flag that stops a tier (--max-opt=2 stops Turbofan). Each
// function has its own text: V8 shares code between functions compiled from the same text.
const CALIBRATE = `
const statusAfter = (constant, optimize) => {
  const f = new Function('a', 'b', 'return a * b + ' + constant);
  f(1, 2);
  f(2, 3);
  if (optimize) {
    new Function('f', '%PrepareFunctionForOptimization(f); f(1, 2); ' + optimize + '(f); f(3, 4);')(f);
  }
  return new Function('f', 'return %GetOptimizationStatus(f)')(f);
};
console.log(JSON.stringify([
  statusAfter(1),
  statusAfter(2, '%OptimizeMaglevOnNextCall'),
  statusAfter(3, '%OptimizeFunctionOnNextCall'),
]));
`;

const oneBit = (bits) => bits > 0 && (bits & (bits - 1)) === 0;

/**
 * Reads this V8's tier bits. Sets --allow-natives-syntax here, which a process may do at any time before it parses a
 * native call. Returns `status(f)` for the raw field, the `bits` it found, and `isTurbofan(f)` and `isOptimized(f)`
 * (Maglev or Turbofan).
 */
export function v8Tiers() {
  const [interpreted, maglev, turbofan] = JSON.parse(
      execFileSync(process.execPath, ['--allow-natives-syntax', '-e', CALIBRATE], { encoding: 'utf8', timeout: 30_000 }),
    ),
    bits = { turbofan: turbofan & ~maglev, maglev: maglev & ~turbofan, optimized: turbofan & maglev & ~interpreted };
  if (!Object.values(bits).every(oneBit))
    throw new Error(`V8 ${process.versions.v8}: no tier bits in statuses ${interpreted}, ${maglev}, ${turbofan}`);
  setFlagsFromString('--allow-natives-syntax');
  const status = new Function('f', 'return %GetOptimizationStatus(f)');
  return {
    bits,
    status,
    isTurbofan: (f) => (status(f) & bits.turbofan) !== 0,
    isOptimized: (f) => (status(f) & bits.optimized) !== 0,
  };
}
