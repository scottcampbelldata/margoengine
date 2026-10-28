// `node --import ./scripts/lib/lower-using.mjs --test ...`: lets the tests that hold `using` / `await using`
// declarations run on Node 22, which cannot parse them (scripts/node22-tests.mjs, CI's "node22 unit tests" job). On a
// runtime with the syntax (Node 24 and later) it registers nothing, so the same files run natively there and the native
// path stays covered; tests/lower-using.test.js checks both. The node:test runner passes --import on to every test
// file's process.
import { register } from 'node:module';

/** True when this runtime parses `using` declarations itself. */
export const nativeUsing = (() => {
  try {
    new Function('{ using resource = null; }');
    return true;
  } catch {
    return false;
  }
})();

if (!nativeUsing) register('./lower-using-hooks.mjs', import.meta.url);
