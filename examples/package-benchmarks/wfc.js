import {WFC} from '../../packages/wfc/dist/index.js';
import {grid} from './layout.js';

export function createWorkload(count = 64, initialSeed = 137) {
  const side = Math.sqrt(count);
  if (!Number.isInteger(side) || side < 4 || count > 1024) throw new RangeError('WFC workload needs 16..1024 square cells');
  if (!Number.isInteger(initialSeed) || initialSeed < 0 || initialSeed > 0xffffffff) throw new RangeError('Invalid WFC demo seed');
  const start = performance.now(), points = grid(count), tiles = [1,4,2,1].map((weight,id) => ({weight,
    neighbors: Array.from({length:6}, (_,direction) => [0,1,2,3].filter(other => direction === 2 || direction === 3 ? other === id : Math.abs(other-id) <= 1))}));
  const pins = [{position: [0,0,0], tile: 0}, {position: [side-1,0,side-1], tile: 3}], retryBudget = 8;
  let generator = new WFC([side,1,side],tiles), solution, seed = initialSeed, generations = 0, elapsed = 0, disposed = false, frames = 0;
  let lastSolveCpuMilliseconds = 0, lastGenerationCpuMilliseconds = 0, constraintViolations = 0, generatedThisFrame = false;
  const generate = () => {
    const start = performance.now(); solution = generator.solve(seed,pins,retryBudget); lastSolveCpuMilliseconds = performance.now() - start; generations++;
    constraintViolations = 0;
    for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) {
      const index = x + side*z, tile = solution[index], offset = index*4;
      points[offset] = (x-(side-1)/2)*0.4; points[offset+1] = 0.12+tile*0.22; points[offset+2] = (z-(side-1)/2)*0.4; points[offset+3] = tile;
      if (x+1 < side && !tiles[tile].neighbors[0].includes(solution[index+1])) constraintViolations++;
      if (z+1 < side && !tiles[tile].neighbors[4].includes(solution[index+side])) constraintViolations++;
    }
    for (const pin of pins) if (solution[pin.position[0]+side*pin.position[2]] !== pin.tile) constraintViolations++;
    if (constraintViolations) throw new Error('Generated WFC solution violated its tile rules');
    lastGenerationCpuMilliseconds = performance.now() - start;
  };
  generate(); const setupCpuMilliseconds = performance.now() - start, extent = side*0.2+0.15;
  return {points, tiles, pins, get generator() {return generator;}, get solution() {return solution;}, bounds: {min: [-extent,0,-extent], max: [extent,1,extent]},
    description: 'Seeded weighted Wave Function Collapse generates four height/color levels, with reciprocal adjacency and pinned opposite corners. Run generates a new seed each simulation second; solve/validation CPU is shown separately from render cadence. Large presets expose synchronous generation stalls.',
    step(delta) {
      if (disposed) return; if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid WFC frame delta');
      frames++; elapsed += delta; generatedThisFrame = elapsed >= 1;
      if (generatedThisFrame) {elapsed -= 1; seed = (seed+1) >>> 0; generate();}
    },
    details: () => ({cells: count, side, tileTypes: tiles.length, seed, generations, frames, generatedThisFrame: Number(generatedThisFrame), retryBudget,
      constraintViolations, setupCpuMilliseconds, lastSolveCpuMilliseconds, lastGenerationCpuMilliseconds}),
    dispose() {disposed = true; generator = solution = null;}
  };
}
