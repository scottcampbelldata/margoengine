import { install } from '@margoengine/webgl2-compat';

export function installCompatibility(force, signal) {
  return install({force, signal});
}
