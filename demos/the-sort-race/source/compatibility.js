import { install } from '@margoengine/webgl2-compat';

export function installCompatibility(forced, signal = AbortSignal.timeout(18000)) {
  return install({ force: forced, signal });
}
