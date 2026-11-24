// Rapier 3D as a black box, for the tests that hold the kernel to it. `RapierPhysics` is the wrapper this package had while
// Rapier was its solver (tests/oracle/src), over `@dimforge/rapier3d-compat`, a root devDependency. Nothing in `src` or
// `dist` imports Rapier (tests/no-rapier-shipped.test.js).
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from './oracle/dist/index.js';

let ready;
export class RapierPhysics extends Physics {
  constructor(engine, options = {}) {
    super(engine, { rapier: RAPIER, ...options });
  }
  static load() {
    const warn = console.warn;
    console.warn = () => {}; // wasm-bindgen's notice about init() arguments
    return (ready ??= RAPIER.init()).finally(() => {
      console.warn = warn;
    });
  }
}
export { RAPIER };
