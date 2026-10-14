import {Spline} from '../../packages/splines/dist/index.js';
import {grid} from './layout.js';

const traceCount = 48;
export function createWorkload(count = 384) {
  if (!Number.isInteger(count) || count < 96 || count > 1536) throw new RangeError('Spline workload count must be 96..1536');
  const start = performance.now(), points = grid(count), yaw = new Float32Array(count), position = new Float64Array(3), direction = new Float64Array(3);
  let curves = [
    new Spline([[-5,0.3,-2],[-2,0.5,-2],[-2,0.3,2],[-5,0.5,2]], {closed: true, divisions: 128}),
    new Spline([[-1.4,0.3,-2],[1.4,1.2,-0.8],[-1.4,0.3,0.8],[1.4,0.5,2]], {kind: 'bezier', divisions: 128}),
    new Spline([[3,0.3,-2],[5,0.6,-1],[5,0.3,2],[3,0.5,1]], {kind: 'hermite', closed: true,
      tangents: [[2,0,-1],[1,0,2],[-2,0,1],[-1,0,-2]], divisions: 128})
  ];
  let time = 0, frames = 0, parameterQueries = 0, distanceQueries = 0, tangentQueries = 0, disposed = false;
  const lengths = curves.map(curve => curve.length);
  const write = (index, curve, parameter, distanceMode, forward, lift = 0) => {
    if (distanceMode) {
      curve.atDistance(parameter * curve.length, position); curve.atDistance(Math.min(1, parameter + 0.0001) * curve.length, direction); distanceQueries += 2;
      for (let axis = 0; axis < 3; axis++) direction[axis] -= position[axis];
    } else {curve.at(parameter, position); curve.tangent(parameter, direction); parameterQueries++; tangentQueries++;}
    const offset = index * 4; points[offset] = position[0]; points[offset + 1] = position[1] + lift; points[offset + 2] = position[2];
    points[offset + 3] = index % 3; yaw[index] = Math.atan2(direction[0] * forward, direction[2] * forward);
  };
  for (let i = 0; i < traceCount; i++) write(i, curves[i % 3], Math.floor(i / 3) / 15, false, 1);
  const update = delta => {
    time += delta; parameterQueries = distanceQueries = tangentQueries = 0; frames++;
    for (let i = traceCount; i < count; i++) {
      const curve = curves[i % 3], phase = (Math.floor((i - traceCount) / 3) / Math.ceil((count - traceCount) / 3) + time * 0.12) % (curve.closed ? 1 : 2);
      const forward = curve.closed || phase <= 1 ? 1 : -1, parameter = forward > 0 ? phase : 2 - phase;
      write(i, curve, parameter, i % 2 === 1, forward, 0.2);
    }
  };
  update(0); const setupCpuMilliseconds = performance.now() - start;
  return {points, yaw, get curves() {return curves;}, bounds: {min: [-5.7,0,-2.7], max: [5.7,1.6,2.7]},
    description: 'Three real Catmull-Rom, Bezier and Hermite curves. Fixed markers show their paths; followers alternate parameter/tangent and cached arc-length queries. Colors identify curve types.',
    step(delta) {if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid spline frame delta'); update(delta);},
    details: () => ({curves: 3, staticCurveSamples: traceCount, followers: count - traceCount, frames, parameterQueries, tangentQueries, distanceQueries,
      catmullRomLength: lengths[0], bezierLength: lengths[1], hermiteLength: lengths[2], setupCpuMilliseconds}),
    dispose() {disposed = true; curves = null;}
  };
}
