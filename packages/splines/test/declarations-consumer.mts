import { Spline } from '@margoengine/splines';
import { catmullRomSpline } from '@margoengine/splines/kinds';
import type { ControlPath, PathControls } from '@margoengine/controls/presentation';

const spline = new Spline([[0, 0, 0], [1, 1, 1]]);
const path: ControlPath = spline;
const constructorPath: ConstructorParameters<typeof PathControls>[1] = spline;
for (const output of [undefined, new Float32Array(3), new Float64Array(3)]) {
  for (const sample of [spline.at(0.5, output), spline.tangent(0.5, output), spline.atDistance(0, output)]) {
    const defined: Float64Array | Float32Array = sample;
    console.log(defined.length);
  }
}
// Also check calls that omit the optional argument entirely.
const point: ArrayLike<number> = spline.at(0.5);
const tangent: ArrayLike<number> = spline.tangent(0.5);
const distance: ArrayLike<number> = spline.atDistance(0);
void [path, constructorPath, point, tangent, distance];
const cubic = catmullRomSpline([[0, 0, 0], [1, 1, 1]]);
const cubicPath: ControlPath = cubic;
const cubicTangent: ArrayLike<number> = cubic.tangent(0.5);
void [cubicPath, cubicTangent];
