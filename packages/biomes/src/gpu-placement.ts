// Clean-room J6, derived only from Margo placement.ts, stands.ts, hash.ts and fixed.ts.
// W3C WGSL CRD 2026-10-26 https://www.w3.org/TR/2026/CRD-WGSL-20261026/
// #integer-types, #arithmetic-expr, #bit-expr, #compute-shader-workgroups: wrapping hashes, exact limbs and guarded lanes.
// Signed cluster-table entries retain the CPU's wrapped interpolation and safe-integer parent sum before its cap;
// the signed two-limb sum is reduced to i32 only where CPU qmul does. No positivity assumption or per-parent cap.
// WebGPU CRD 2026-09-15 transport claims/limits: gpu-placement-flow-transport.ts.
// Luby (1986) https://doi.org/10.1137/0215074: parallel independent-set rounds (publisher abstract checked).
// Blelloch, Fineman & Shun (2012) https://doi.org/10.1145/2312005.2312058,
// https://www.cs.cmu.edu/~guyb/paralg/papers/BlellochFinemanShun12.pdf (body checked):
// fixed-order parallel decisions reproduce greedy MIS on a complete finite conflict graph.
// Margo truncates to 1..16 rounds, leaves unresolved vertices, and keeps its existing priority tie rule.
// Thomas (1949), https://doi.org/10.1093/biomet/36.1-2.18 (publisher record checked, body unavailable);
// Matern (1960), Spatial Variation, https://pub.epsilon.slu.se/10033/1/medd_statens_skogsforskningsinst_049_05.pdf
// section 3.6 (primary text checked): Poisson parents and clustered satellites. These motivate the existing CPU process;
// its truncated Thomas/Matern/2dt intensity tables, cap and integer inverse CDF are Margo-specific approximations.
// GPU: candidate counts, hash/position emission, cluster/stand factors, and fixed-priority accept/kill rounds.
// CPU shared tail: field/sea lookup, biome/suitability/exclusion/edge, final density thinning, size/room/qpow,
// inter-stratum shade/blocking, conflict CSR, records, canopy, exclusion and detail density. No speed claim.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { BiomePlacement, PlacedTile } from './placement.js';
import { divFloor, qmul } from './fixed.js';
import {
  placementBridges,
  type CandidateSource,
  type GPUSpec,
  type GPUPool,
  type TickRect,
  type PlacementBridge,
} from './gpu-placement-flow-internal.js';
import { PLACEMENT_FLOW_ARITHMETIC } from './gpu-placement-flow-arithmetic.js';
import { checkWords, ComputeSession, computeError, dispatchShape, markers } from './gpu-placement-flow-transport.js';

export const PLACEMENT_WGSL = /* wgsl */ `
${PLACEMENT_FLOW_ARITHMETIC}
@group(0) @binding(0) var<storage,read> input: array<i32>;
@group(0) @binding(1) var<storage,read_write> output: array<i32>;
fn signedwide(value: i32) -> vec2<u32> {
  return vec2<u32>(bitcast<u32>(value),select(0u,4294967295u,value<0));
}
fn cluster(at: u32, x: i32, z: i32) -> i32 {
  let reach=input[at+9u]; if (reach==0) { return 65536; }
  let cell=u32(input[at+10u]); let reach2=wide(u32(reach),u32(reach));
  let x0=floorSigned(x-reach,cell); let x1=floorSigned(x+reach,cell);
  let z0=floorSigned(z-reach,cell); let z1=floorSigned(z+reach,cell);
  let seed=bitcast<u32>(input[at]); let code=bitcast<u32>(input[at+14u]);
  let table=u32(input[at+15u]); var sum=vec2<u32>(0u);
  for (var pz=z0; pz<=z1; pz++) { for (var px=x0; px<=x1; px++) {
    let count=poisson(u32(input[at+11u]),u32(input[at+12u]),hash5(seed,code,px,pz,0u));
    for (var i=1u; i<=count; i++) {
      let h=hash5(seed,code,px,pz,i);
      let xp=wide(h>>16u,cell); let zp=wide(h&65535u,cell);
      let ox=px*i32(cell)+i32((xp.x>>16u)|(xp.y<<16u));
      let oz=pz*i32(cell)+i32((zp.x>>16u)|(zp.y<<16u));
      let dx=u32(abs(x-ox)); let dz=u32(abs(z-oz));
      let d2=addwide(wide(dx,dx),wide(dz,dz));
      if (!lesswide(d2,reach2)) { continue; }
      // d2*16384 <= 2^52 for the existing cluster reach (<=512000 ticks).
      let numerator=vec2<u32>(d2.x<<14u,(d2.y<<14u)|(d2.x>>18u));
      let t=dividewide(numerator,reach2); let j=t>>6u; let f=i32(t&63u);
      let a=input[table+j]; let b=input[table+j+1u];
      // CPU tables are Int32, including wrapped negative entries. Only the interpolation product
      // wraps before its signed shift; the addition to a and the parent sum use JS safe integers.
      // Sign-extend each addend separately: a + interpolation can itself exceed an i32.
      let interpolation=((b-a)*f)>>6u;
      sum=addwide(sum,addwide(signedwide(a),signedwide(interpolation)));
    }
  } }
  // Apply the CPU cap once, after every signed contribution. A later negative parent can undo
  // an earlier cap. qmul converts its argument to i32, so retain the low limb for negative sums.
  let negative=(sum.y&2147483648u)!=0u;
  let capped=select(sum.x,262144u,!negative && (sum.y!=0u || sum.x>262144u));
  let beta=input[at+13u]; return 65536-beta+qmul(beta,bitcast<i32>(capped));
}
@compute @workgroup_size(64)
fn counts(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let k=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (k>=n) { return; }
  let at=1u+18u*k;
  output[k]=i32(poisson(u32(input[at+5u]),u32(input[at+6u]),
    hash5(bitcast<u32>(input[at]),bitcast<u32>(input[at+1u]),input[at+2u],input[at+3u],0u)));
  output[n+k]=1;
}
@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let k=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (k>=n) { return; }
  let at=1u+18u*k; let out=9u*k;
  let h0=hash5(bitcast<u32>(input[at]),bitcast<u32>(input[at+1u]),input[at+2u],input[at+3u],u32(input[at+16u]));
  let h1=pcg(h0); let h2=pcg(h1); let h3=pcg(h2); let h4=pcg(h3);
  let gen=u32(input[at+4u]); let xp=wide(h0>>8u,gen); let zp=wide(h1>>8u,gen);
  let x=input[at+2u]*i32(gen)+i32((xp.x>>24u)|(xp.y<<8u));
  let z=input[at+3u]*i32(gen)+i32((zp.x>>24u)|(zp.y<<8u));
  output[out]=bitcast<i32>(h0); output[out+1u]=bitcast<i32>(h1); output[out+2u]=bitcast<i32>(h2);
  output[out+3u]=bitcast<i32>(h3); output[out+4u]=bitcast<i32>(h4); output[out+5u]=x; output[out+6u]=z;
  output[out+7u]=stand(bitcast<u32>(input[at]),u32(input[at+7u]),input[at+8u],x,z);
  output[out+8u]=cluster(at,x,z); output[9u*n+k]=1;
}
`;

export const LUBY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage,read> graph: array<u32>;
@group(0) @binding(1) var<storage,read> previous: array<u32>;
@group(0) @binding(2) var<storage,read_write> output: array<u32>;
@group(0) @binding(3) var<storage,read_write> executed: array<atomic<u32>>;
@compute @workgroup_size(64)
fn accept(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let i=id.x+id.y*groups.x*64u; let n=graph[0]; if (i>=n) { return; }
  let old=previous[i]; var free=old==0u;
  for (var q=graph[1u+i]; q<graph[2u+i] && free; q++) { if (previous[graph[q]]==0u) { free=false; } }
  // State packs the settled round above two fate bits; live vertices carry zero.
  let round=atomicLoad(&executed[i])/2u+1u;
  output[i]=select(old,round*4u+1u,free); atomicAdd(&executed[i],1u);
}
@compute @workgroup_size(64)
fn kill(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let i=id.x+id.y*groups.x*64u; let n=graph[0]; if (i>=n) { return; }
  let round=atomicLoad(&executed[i])/2u+1u; var value=previous[i];
  if (value==0u) {
    for (var q=graph[1u+i]; q<graph[2u+i]; q++) {
      if (previous[graph[q]]==round*4u+1u) { value=round*4u+2u; break; }
    }
  }
  output[i]=value; atomicAdd(&executed[i],1u);
}
`;

interface Cell {
  sp: GPUSpec;
  gx: number;
  gz: number;
  start: number;
  count: number;
}
const key = (sp: GPUSpec, x: number, z: number) => `${sp.index}/${x}/${z}`;

function packed(cells: readonly Cell[], seed: number, emit: boolean): Int32Array {
  const n = emit ? cells.reduce((n, c) => n + c.count, 0) : cells.length;
  const tables = new Map<GPUSpec, number>();
  let length = 1 + 18 * n;
  for (const { sp } of cells)
    if (sp.cluster && !tables.has(sp)) {
      tables.set(sp, length);
      length += 257;
    }
  const data = new Int32Array(length);
  data[0] = n;
  let at = 1;
  for (const c of cells)
    for (let i = emit ? 1 : 0; i <= (emit ? c.count : 0); i++) {
      const { sp, gx, gz } = c,
        st = sp.stands,
        cl = sp.cluster;
      data.set(
        [
          seed,
          sp.code,
          gx,
          gz,
          sp.gen,
          sp.mu,
          sp.e0,
          st?.scale ?? 0,
          st?.top ?? 0,
          cl?.reach ?? 0,
          cl?.cell ?? 0,
          cl?.mu ?? 0,
          cl?.e0 ?? 0,
          cl?.beta ?? 0,
          cl?.code ?? 0,
          tables.get(sp) ?? 0,
          i,
          0,
        ],
        at,
      );
      at += 18;
    }
  for (const [sp, offset] of tables) data.set(sp.cluster!.table, offset);
  return data;
}

/** Dependency windows include whole generation/stratum cells, with an extra cell per dependency edge. */
function windowsFor(bridge: PlacementBridge, x: number, z: number): TickRect[] {
  const { plan, tileTicks } = bridge,
    result: TickRect[] = [];
  const tile: TickRect = [x * tileTicks, z * tileTicks, (x + 1) * tileTicks, (z + 1) * tileTicks];
  for (let s = plan.strata.length - 1; s >= 0; s--) {
    const st = plan.strata[s];
    let [x0, z0, x1, z1] = tile;
    const crown = s === 1 || s === 2 ? Math.max(plan.strata[1].rmax, plan.strata[2].rmax) + st.g : 0;
    x0 -= crown;
    z0 -= crown;
    x1 += crown;
    z1 += crown;
    for (let t = s + 1; t < plan.strata.length; t++)
      if (plan.strata[t].species.length) {
        const reach = Math.max(st.rmax, qmul(plan.across, st.rmax + plan.strata[t].rmax) + 1) + st.g;
        const r = result[t];
        x0 = Math.min(x0, r[0] - reach);
        z0 = Math.min(z0, r[1] - reach);
        x1 = Math.max(x1, r[2] + reach);
        z1 = Math.max(z1, r[3] + reach);
      }
    // Acceptance at K reads a higher neighbour's live state at K-1; killing at K also reads that
    // neighbour's acceptance at K. Thus a fate has a 2*K*dmax dependency cone, not just K*dmax.
    // g >= dmax, so this pad is >= 2*K*dmax+g; it also protects the outer whole-cell generation.
    const pad = (plan.rounds + 1) * (st.dmax + st.g);
    result[s] = [
      Math.max(0, divFloor(x0 - pad, st.g) * st.g),
      Math.max(0, divFloor(z0 - pad, st.g) * st.g),
      Math.min(-divFloor(-bridge.worldX, st.g) * st.g, -divFloor(-(x1 + pad), st.g) * st.g),
      Math.min(-divFloor(-bridge.worldZ, st.g) * st.g, -divFloor(-(z1 + pad), st.g) * st.g),
    ];
  }
  return result;
}

function graphOf(p: GPUPool, factor: Int32Array, species: number, g: number, reach: number): Uint32Array {
  const bins = new Map<string, number[]>();
  for (let i = 0; i < p.n; i++) {
    const k = `${divFloor(p.x[i], g)},${divFloor(p.z[i], g)}`;
    let bin = bins.get(k);
    if (!bin) bins.set(k, (bin = []));
    bin.push(i);
  }
  const starts: number[] = [p.n],
    edges: number[] = [];
  for (let i = 0; i < p.n; i++) {
    starts.push(2 + p.n + edges.length);
    for (let z = divFloor(p.z[i] - reach, g); z <= divFloor(p.z[i] + reach, g); z++)
      for (let x = divFloor(p.x[i] - reach, g); x <= divFloor(p.x[i] + reach, g); x++)
        for (const j of bins.get(`${x},${z}`) ?? []) {
          if (
            j === i ||
            p.prio[j] < p.prio[i] ||
            (p.prio[j] === p.prio[i] &&
              (p.x[j] < p.x[i] ||
                (p.x[j] === p.x[i] && (p.z[j] < p.z[i] || (p.z[j] === p.z[i] && p.sp[j] <= p.sp[i])))))
          )
            continue;
          const d = qmul(factor[p.sp[i] * species + p.sp[j]], p.r[i] + p.r[j]),
            dx = p.x[j] - p.x[i],
            dz = p.z[j] - p.z[i];
          if (dx * dx + dz * dz < d * d) edges.push(j);
        }
  }
  starts.push(2 + p.n + edges.length);
  return new Uint32Array([...starts, ...edges]);
}

/** Places tile (x, z) of `placement` on `device`, byte-identical to the CPU: what `BiomePlacement` runs for a backend 'gpu' world. */
export async function placeTileGPU(
  device: GPUDevice,
  placement: BiomePlacement,
  x: number,
  z: number,
  { signal }: { readonly signal?: AbortSignal } = {},
): Promise<PlacedTile> {
  signal?.throwIfAborted();
  const get = placementBridges.get(placement);
  if (!get) throw typeError('GPU placement needs a live BiomePlacement from this module', 'biomes');
  const bridge = get(x, z),
    { plan } = bridge,
    windows = windowsFor(bridge, x, z),
    cells: Cell[] = [];
  for (const sp of plan.specs) {
    const cl = sp.cluster;
    if (
      ![sp.gen, sp.mu, sp.e0, sp.stands?.scale ?? 0, cl?.cell ?? 0, cl?.mu ?? 0].every(
        (v) => Number.isSafeInteger(v) && v >= 0 && v <= 2147483647,
      )
    )
      throw rangeError(
        'GPU placement needs nonnegative i32 plan values; reduce cluster/stand scale or density',
        'biomes',
      );
  }
  const tableWords = plan.specs.filter((sp) => sp.cluster).length * 257;
  let cellCount = 0;
  for (let s = 0; s < plan.strata.length; s++) {
    const [x0, z0, x1, z1] = windows[s];
    for (const sp of plan.strata[s].species) {
      const count = divFloor(x1 - x0, sp.gen) * divFloor(z1 - z0, sp.gen);
      cellCount += count;
      checkWords(device, 1 + cellCount * 18 + tableWords);
      checkWords(device, cellCount * 2);
      dispatchShape(device, Math.max(1, cellCount));
      for (let gz = divFloor(z0, sp.gen); gz < divFloor(z1, sp.gen); gz++)
        for (let gx = divFloor(x0, sp.gen); gx < divFloor(x1, sp.gen); gx++)
          cells.push({ sp, gx, gz, start: 0, count: 0 });
    }
  }
  // Count buffers are known now; emission buffers depend on the GPU's actual counts.
  dispatchShape(device, Math.max(1, cells.length));
  checkWords(device, 1 + cells.length * 18 + tableWords);
  checkWords(device, cells.length * 2);
  const countsInput = packed(cells, bridge.seed, false);
  const session = new ComputeSession(device, signal);
  try {
    const [counts, emit] = await session.pipelines(PLACEMENT_WGSL, ['counts', 'emit']);
    const [accept, kill] = await session.pipelines(LUBY_WGSL, ['accept', 'kill']);
    const runKernel = async (pipeline: GPUComputePipeline, data: Int32Array, stride: number) => {
      const n = data[0];
      if (!n) return new Int32Array();
      const [src, dst] = await session.scoped(() => [
        session.buffer(data.length, data),
        session.buffer(n * (stride + 1)),
      ]);
      const out = await session.read(dst, n * (stride + 1), (encoder) =>
        session.dispatch(encoder, pipeline, [src, dst], n),
      );
      markers(out, stride * n, n);
      return out;
    };
    const countValues = await runKernel(counts, countsInput, 1);
    let total = 0;
    const byCell = new Map<string, Cell>();
    cells.forEach((c, k) => {
      const count = countValues[k];
      if (!Number.isInteger(count) || count < 0 || count > 40)
        throw fault('failed', 'GPU Poisson count is invalid; check shader execution', 'biomes');
      c.count = count;
      c.start = total;
      total += count;
      byCell.set(key(c.sp, c.gx, c.gz), c);
    });
    if (!Number.isSafeInteger(total) || total > 2147483647)
      throw rangeError('GPU candidate prefix exceeds i32; use a smaller placement window', 'biomes');
    dispatchShape(device, Math.max(1, total));
    checkWords(device, 1 + total * 18 + tableWords);
    checkWords(device, total * 10);
    const raw = await runKernel(emit, packed(cells, bridge.seed, true), 9);
    const source: CandidateSource = {
      count(sp, gx, gz) {
        const c = byCell.get(key(sp, gx, gz));
        if (!c)
          throw fault('failed', 'GPU placement dependency window is incomplete; check the cone derivation', 'biomes');
        return c.count;
      },
      candidate(sp, gx, gz, i) {
        const c = byCell.get(key(sp, gx, gz));
        if (!c || i < 1 || i > c.count)
          throw fault('failed', 'GPU placement candidate is missing; check emission', 'biomes');
        const a = 9 * (c.start + i - 1);
        return {
          h0: raw[a] >>> 0,
          h1: raw[a + 1] >>> 0,
          h2: raw[a + 2] >>> 0,
          h3: raw[a + 3] >>> 0,
          h4: raw[a + 4] >>> 0,
          x: raw[a + 5],
          z: raw[a + 6],
          stand: raw[a + 7],
          cluster: raw[a + 8],
        };
      },
    };
    const opened = await session.wait(bridge.open(windows, source, signal));
    for (let s = 0; s < plan.strata.length; s++) {
      signal?.throwIfAborted();
      const st = plan.strata[s];
      if (!st.species.length) continue;
      const r = windows[s];
      for (let cz = divFloor(r[1], st.g); cz < divFloor(r[3], st.g); cz++)
        for (let cx = divFloor(r[0], st.g); cx < divFloor(r[2], st.g); cx++) opened.run.cell(s, cx, cz);
      const pool = opened.run.pools[s],
        n = pool.n;
      if (!n) continue;
      const graph = graphOf(pool, plan.factor, plan.specs.length, st.g, st.dmax);
      checkWords(device, graph.length);
      checkWords(device, n);
      dispatchShape(device, n);
      const [csr, a, b, executed] = await session.scoped(() => [
        session.buffer(graph.length, graph),
        session.buffer(n),
        session.buffer(n),
        session.buffer(n),
      ]);
      const fate = await session.read(a, n, (encoder) => {
        for (let r = 0; r < plan.rounds; r++) {
          session.dispatch(encoder, accept, [csr, a, b, executed], n);
          session.dispatch(encoder, kill, [csr, b, a, executed], n);
        }
      });
      markers(await session.read(executed, n), 0, n, 2 * plan.rounds);
      for (let i = 0; i < n; i++) {
        pool.fate[i] = fate[i] & 3;
        pool.round[i] = fate[i] >>> 2;
        pool.known[i] = plan.rounds;
      }
    }
    signal?.throwIfAborted();
    return opened.render();
  } catch (error) {
    computeError(error, signal);
  } finally {
    session.close();
  }
}
