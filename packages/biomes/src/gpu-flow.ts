// Clean-room J6 from Margo hydrology.ts, with CPU Priority-Flood, flat drainage and output tail.
// W3C WGSL CRD 2026-10-26 https://www.w3.org/TR/2026/CRD-WGSL-20261026/
// #integer-types, #bit-expr, #compute-shader-workgroups, #atomic-builtin-functions:
// wrapping limbs, bounded compute lanes and atomic execution/change counters.
// WebGPU transport provenance is in gpu-placement-flow-transport.ts.
// O'Callaghan & Mark (1984), https://doi.org/10.1016/S0734-189X(84)80011-0:
// D8 routes a grid cell to one of eight neighbours. Publisher metadata found; full text returned 403.
// D8 implementation, tie and border rules are derived from Margo's CPU code, not an unread paper body.
// Jain et al. (2024), FastFlow, CGF 43(7), author manuscript checked:
// https://www-sop.inria.fr/reves/Basilic/2024/JKGFC24/FastFlowPG2024_Author_Version.pdf
// Context only: parallel flow routing. We use bounded pull recurrence, not its pointer jumping.
// Claim: integer flow equals CPU Kahn accumulation on the CPU's acyclic drainage graph, n <= 2^31-1.
// The score comparison rounds 65-bit squared drops to binary64 precision to preserve CPU ties at extreme heights.
// Shares, TWI, HAND, lakes, channels and water distance stay CPU; no performance claim.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import './hydrology.js';
import type { HeightGrid, Hydrology, HydrologyOptions } from './hydrology.js';
import { flowBridge } from './gpu-placement-flow-internal.js';
import { PLACEMENT_FLOW_ARITHMETIC } from './gpu-placement-flow-arithmetic.js';
import { checkWords, ComputeSession, computeError, dispatchShape, markers } from './gpu-placement-flow-transport.js';

export const FLOW_WGSL = /* wgsl */ `
${PLACEMENT_FLOW_ARITHMETIC}
@group(0) @binding(0) var<storage,read> input: array<i32>;
@group(0) @binding(1) var<storage,read> previous: array<i32>;
@group(0) @binding(2) var<storage,read_write> output: array<i32>;
@group(0) @binding(3) var<storage,read_write> counters: array<atomic<u32>>;
const DX = array<i32,8>(1,1,0,-1,-1,-1,0,1);
const DZ = array<i32,8>(0,1,1,1,0,-1,-1,-1);
// 65-bit drop^2*weight, rounded once to nearest-even binary64, exactly like CPU multiplication.
fn score(drop: u32, straight: bool) -> vec3<u32> {
  let sq = wide(drop,drop);
  var lo = sq.x; var hi = sq.y; var top = 0u;
  if (straight) { top=hi >> 31u; hi=(hi<<1u)|(lo>>31u); lo <<= 1u; }
  let bits = select(64u-countLeadingZeros(hi),65u,top!=0u);
  if (bits > 53u) {
    let shift=bits-53u; let unit=1u<<shift; let mask=unit-1u;
    let rem=lo&mask; let base=lo&~mask;
    let up=rem>unit/2u || (rem==unit/2u && (base&unit)!=0u);
    lo=base+select(0u,unit,up);
    if (lo<base) { hi++; if (hi==0u) { top++; } }
  }
  return vec3<u32>(lo,hi,top);
}
fn greater(a: vec3<u32>, b: vec3<u32>) -> bool {
  return a.z>b.z || (a.z==b.z && (a.y>b.y || (a.y==b.y && a.x>b.x)));
}
@compute @workgroup_size(64)
fn d8(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let c=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (c>=n) { return; }
  let nx=u32(input[1]); let nz=u32(input[2]); let x=i32(c%nx); let z=i32(c/nx);
  var pick = -1; var best=vec3<u32>(0u);
  if (previous[c]==0) {
    for (var d=0u; d<8u; d++) {
      let u=x+DX[d]; let v=z+DZ[d];
      if (u<0 || v<0 || u>=i32(nx) || v>=i32(nz)) { continue; }
      let other=input[3u+u32(v)*nx+u32(u)]; let own=input[3u+c];
      if (own<=other) { continue; }
      let drop=bitcast<u32>(own)-bitcast<u32>(other);
      let w=score(drop,(d&1u)==0u);
      if (greater(w,best)) { best=w; pick=i32(d); }
    }
  }
  output[c]=pick;
  output[n+c]=select(0,1,pick<0 && previous[c]==0 && x>0 && z>0 && x<i32(nx)-1 && z<i32(nz)-1);
  atomicAdd(&counters[c],1u);
}
@compute @workgroup_size(64)
fn accumulate(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let c=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (c>=n) { return; }
  let nx=u32(input[1]); let nz=u32(input[2]); let x=i32(c%nx); let z=i32(c/nx);
  var sum=1;
  for (var d=0u; d<8u; d++) {
    let u=x+DX[d]; let v=z+DZ[d];
    if (u<0 || v<0 || u>=i32(nx) || v>=i32(nz)) { continue; }
    let k=u32(v)*nx+u32(u);
    if (input[3u+k]==i32((d+4u)&7u)) { sum += previous[k]; }
  }
  output[c]=sum;
  if (sum!=previous[c]) { atomicAdd(&counters[n],1u); }
  atomicAdd(&counters[c],1u);
}
`;

/** Internal opt-in exact D8 and flow; no change to the synchronous or world backend. */
export async function hydrologyGPU(
  device: GPUDevice,
  grid: HeightGrid,
  options: HydrologyOptions = {},
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<Hydrology> {
  signal?.throwIfAborted();
  if (!grid || !(grid.height instanceof Int32Array))
    throw typeError('GPU hydrology needs Int32Array heights', 'biomes');
  const { nx, nz, step } = grid,
    n = nx * nz;
  if (
    !Number.isSafeInteger(nx) ||
    !Number.isSafeInteger(nz) ||
    nx < 2 ||
    nz < 2 ||
    !Number.isSafeInteger(n) ||
    n > 2147483647 ||
    grid.height.length !== n ||
    !Number.isFinite(step) ||
    step < 1
  )
    throw rangeError(
      'GPU hydrology needs integer nx,nz >= 2, matching heights, n <= 2147483647 and step >= 1',
      'biomes',
    );
  if (!options || typeof options !== 'object') throw typeError('GPU hydrology options must be an object', 'biomes');
  const snapshot = { ...options };
  if (
    (snapshot.sea !== undefined && !Number.isFinite(snapshot.sea)) ||
    (snapshot.channelCells !== undefined && (!Number.isFinite(snapshot.channelCells) || snapshot.channelCells < 1)) ||
    (snapshot.lakeDepth !== undefined && (!Number.isFinite(snapshot.lakeDepth) || snapshot.lakeDepth <= 0)) ||
    (snapshot.multiple !== undefined && typeof snapshot.multiple !== 'boolean')
  )
    throw rangeError(
      'GPU hydrology needs finite sea, positive lakeDepth, channelCells >= 1 and boolean multiple',
      'biomes',
    );
  dispatchShape(device, n);
  checkWords(device, 3 + 2 * n);
  checkWords(device, 2 * n);
  checkWords(device, n + 1);
  const state = flowBridge.prepare!({ height: grid.height.slice(), nx, nz, step }, snapshot);
  const packed = new Int32Array(3 + 2 * n);
  packed.set([n, nx, nz]);
  packed.set(state.filled, 3);
  packed.set(state.ocean, 3 + n);
  const session = new ComputeSession(device, signal);
  try {
    const [d8, accumulate] = await session.pipelines(FLOW_WGSL, ['d8', 'accumulate']);
    const buffers = await session.scoped(() => [
      session.buffer(packed.length, packed),
      session.buffer(n, Int32Array.from(state.ocean)),
      session.buffer(2 * n),
      session.buffer(n + 1),
    ]);
    const [input, a, b, counters] = buffers;
    const directions = await session.read(b, 2 * n, (encoder) =>
      session.dispatch(encoder, d8, [input, a, b, counters], n),
    );
    const executed = await session.read(counters, n + 1);
    markers(executed, 0, n);
    state.direction.set(directions.subarray(0, n));
    state.flat.set(directions.subarray(n));
    flowBridge.drain!(state);
    const routed = new Int32Array(3 + n);
    routed.set([n, nx, nz]);
    routed.set(state.direction, 3);
    // Different binding shape from the height/ocean pass; upload only the new logical input prefix.
    await session.scoped(() => {
      device.queue.writeBuffer(input, 0, routed);
      device.queue.writeBuffer(a, 0, new Int32Array(n).fill(1));
    });
    let previous = a,
      next = b,
      rounds = 0;
    while (rounds < n) {
      signal?.throwIfAborted();
      const batch = Math.min(64, n - rounds);
      const counts = await session.read(counters, n + 1, (encoder) => {
        for (let r = 0; r < batch; r++) {
          // Keep only the last round's change counter; all execution counts survive the batch.
          encoder.clearBuffer(counters, n * 4, 4);
          session.dispatch(encoder, accumulate, [input, previous, next, counters], n);
          [previous, next] = [next, previous];
        }
      });
      rounds += batch;
      markers(counts, 0, n, rounds + 1);
      if (counts[n] === 0) {
        const flow = await session.read(previous, n);
        return flowBridge.finish!(state, flow);
      }
    }
    throw fault('failed', 'GPU flow did not converge within the cell count; check drainage for cycles', 'biomes');
  } catch (error) {
    computeError(error, signal);
  } finally {
    session.close();
  }
}
