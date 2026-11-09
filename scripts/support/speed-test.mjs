// Registration in the named speed suite, without a skipped test or a false passing assertion.
import test from 'node:test';
import { deferSpeed } from './speed-phase.mjs';

export function speedTest(name, ...args) {
  if (deferSpeed(name)) return;
  return test(name, ...args);
}
