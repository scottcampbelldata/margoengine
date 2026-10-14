import {road} from '../../packages/road/dist/index.js';
import {Spline} from '../../packages/splines/dist/index.js';

export function createWorkload(count = 136) {
  if (!Number.isInteger(count) || count < 24 || count > 1032 || count % 8) throw new RangeError('Road workload count must be a multiple of 8 in 24..1032');
  const started = performance.now(), segments = count / 8 - 1, points = new Float32Array(count*4);
  let curve = new Spline([[-2,0,-8],[2,0.2,-3],[-2,0.3,3],[2,0,8]],{divisions: 256}), result, disposed = false, time = 0, frames = 0, generations = 0, sweepCpuMilliseconds = 0;
  const generate = () => {
    const start = performance.now(); result = road(curve,{width: 2.4,curbWidth: 0.3,curbHeight: 0.35+Math.sin(time)*0.1,segments,uvMeters: 2}); sweepCpuMilliseconds = performance.now() - start; generations++;
    const vertices = result.geometry.vertices;
    // Each strip owns duplicated hard-normal vertices. Display each section corner once.
    for (let row = 0; row <= segments; row++) for (let corner = 0; corner < 8; corner++) {
      const vertex = (row*14 + (corner === 7 ? 13 : corner*2))*6, offset = (row*8+corner)*4;
      points[offset] = vertices[vertex]; points[offset+1] = vertices[vertex+1]; points[offset+2] = vertices[vertex+2]; points[offset+3] = result.section[corner][1] > 0 ? 1 : 0;
    }
  };
  generate(); const setupCpuMilliseconds = performance.now() - started;
  return {points, get curve() {return curve;}, get result() {return result;}, bounds: {min: [-4.5,-0.2,-9.5], max: [4.5,1,9.5]},
    description: 'The actual Road package sweeps a spline every frame. Markers display its eight unique cross-section corners per row, with amber raised curbs and green surface edges. Generated hard normals, triangle indices and tiled UVs are counted separately; this view displays vertices, not filled road triangles.',
    step(delta) {if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid road frame delta'); time += delta; frames++; generate();},
    details: () => ({segments, markers: count, generatedVertices: (segments+1)*14, generatedTriangles: segments*14, uvValues: (segments+1)*28, frames, generations, setupCpuMilliseconds, sweepCpuMilliseconds}),
    dispose() {disposed = true; curve = result = null;}
  };
}
