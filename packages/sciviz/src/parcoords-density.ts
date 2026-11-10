import type { ComputeContext } from '@margoengine/compute';
import { rangeError } from '../../shared/errors.js';
import type { SelectionStore } from './link.js';
import type { MultivariateData } from './parcoords.js';

/** Raster dimensions and optional GPU. Counts are exact integer line occupancy, not alpha blending. */
export interface ParallelDensityOptions {
  /** Default 256. At least the axis count, at most 8192. */ readonly width?: number;
  /** Default 128. From 2 to 8192. */ readonly height?: number;
  readonly gpu?: ComputeContext;
  readonly signal?: AbortSignal;
}
const code = `@group(0) @binding(0) var<storage,read> points:array<u32>;
@group(0) @binding(1) var<storage,read> axes:array<vec2u>;
@group(0) @binding(2) var<storage,read> mask:array<u32>;
@group(0) @binding(3) var<storage,read_write> counts:array<atomic<u32>>;
struct Params{rows:u32,dims:u32,width:u32,height:u32,start:u32,end:u32};@group(0) @binding(4) var<uniform> p:Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){let row=p.start+id.x;if(row>=p.end||mask[row]==0u){return;}
for(var x=0u;x<p.width;x++){
 let s=min(p.dims-2u,((x+1u)*(p.dims-1u)-1u)/(p.width-1u));let a=axes[s];let b=axes[s+1u];
 var ya=points[a.x*p.rows+row];var yb=points[b.x*p.rows+row];if(ya>=p.height||yb>=p.height){continue;}
 ya=select(ya,p.height-1u-ya,a.y>0u);yb=select(yb,p.height-1u-yb,b.y>0u);
 let xa=s*(p.width-1u)/(p.dims-1u);let xb=(s+1u)*(p.width-1u)/(p.dims-1u);
 let y=(ya*(xb-x)+yb*(x-xa))/(xb-xa);atomicAdd(&counts[y*p.width+x],1u);}}`;

/** One vote per valid row at each horizontal pixel. Quantised endpoints make CPU/GPU identical. */
export async function densityCounts(data: MultivariateData, selection: SelectionStore, options: ParallelDensityOptions = {}): Promise<Uint32Array> {
  const width = options.width ?? 256, height = options.height ?? 128, n = data.table.length, dims = data.axes.length;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < dims || height < 2 || width > 8192 || height > 8192 || width * height > 16777216) throw rangeError('Density needs width >= axis count, height >= 2, dimensions <= 8192 and at most 16777216 pixels', 'sciviz');
  options.signal?.throwIfAborted(); const order = data.order.slice(), mask = new Uint32Array(n), points = new Uint32Array(data.values.length).fill(0xffffffff), counts = new Uint32Array(width * height);
  for (let i = 0; i < n; i++) mask[i] = Number(selection.has(data.rowIds[i]));
  for (let i = 0; i < points.length; i++) if (Number.isFinite(data.values[i])) points[i] = Math.min(height - 1, Math.floor(Math.fround(Math.fround(data.values[i] * (height - 1)) + 0.5)));
  if (options.gpu && n) {
    using positions = options.gpu.array(points, { dtype: 'u32' }); using axes = options.gpu.array(order, { dtype: 'u32' }); using selected = options.gpu.array(mask, { dtype: 'u32' }); using output = options.gpu.array(counts, { dtype: 'u32' }); using kernel = options.gpu.kernel(code);
    for (let start = 0; start < n; start += 8192) {
      options.signal?.throwIfAborted(); const end = Math.min(n, start + 8192);
      kernel.run({ points: positions, axes, mask: selected, counts: output, p: { rows: n, dims, width, height, start, end } }, { count: end - start });
      await options.gpu.done({ signal: options.signal });
    }
    return await output.read({ signal: options.signal });
  }
  for (let row = 0; row < n; row++) {
    if ((row & 2047) === 0) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); options.signal?.throwIfAborted(); }
    if (!mask[row]) continue;
    for (let x = 0; x < width; x++) {
      const s = Math.min(dims - 2, Math.floor(((x + 1) * (dims - 1) - 1) / (width - 1))), a = order[s * 2], b = order[(s + 1) * 2];
      let ya = points[a * n + row], yb = points[b * n + row]; if (ya >= height || yb >= height) continue;
      if (order[s * 2 + 1]) ya = height - 1 - ya; if (order[(s + 1) * 2 + 1]) yb = height - 1 - yb;
      const xa = Math.floor(s * (width - 1) / (dims - 1)), xb = Math.floor((s + 1) * (width - 1) / (dims - 1));
      const y = Math.floor((ya * (xb - x) + yb * (x - xa)) / (xb - xa)); counts[y * width + x]++;
    }
  }
  return counts;
}
