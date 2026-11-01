// Clean-room derivation, 2026-11-01, solely from Margo fields.ts, gpu-region-fields.ts and gpu-fixed-lerp.ts.
// No other engine code. No new ecology behavior, so no new biome research reference is needed.
// W3C WGSL https://www.w3.org/TR/2026/CRD-WGSL-20261026/ sections 6.2.3 (#integer-types), 8.10 (#bit-expr):
// the reused Q16 sampler uses 32-bit integers and shifts for exact signed floor interpolation.
// WGSL section 14.3 (#address-spaces): the reused sampler reads storage grids and writes independent samples.
// WebGPU https://www.w3.org/TR/2026/CRD-webgpu-20260915/ sections 5.2 (#buffer-mapping), 16 (#computepass):
// dispatch the existing sampler and await mapped readback before entering the synchronous field loop.
// WebGPU sections 3.6.2.4 (#gpuadapterinfo), 22.3 (#error-scopes): selected adapter identity in the hardware proof
// and validation error reporting in the reused sampler. Standards define transport, not biome parity.
// Supported claim: bytes equal synchronous rectFields for every field layer, given upsampleRegionFieldsGPU equals
// regionFieldsRef (the J5a2 hardware proof). No classification, default-backend or performance claim.
import { rectFields, type TileFrame } from './fields.js';
import { upsampleRegionFieldsGPU } from './gpu-region-fields.js';
import type { RasterLayer } from './layers.js';

/**
 * Internal opt-in region sampling on the supplied device, followed by the shared synchronous field loop.
 * `temporary` defaults to false; true reuses frame.scratch output until its next use.
 * `signal` defaults to no cancellation and rejects with its reason. No scratch is taken while awaiting GPU samples.
 * @throws RangeError/TypeError for invalid inputs; MargoError 'failed' for GPU failures or incomplete writes.
 */
export async function rectFieldsGPU(
  device: GPUDevice,
  frame: TileFrame,
  ox: number,
  oz: number,
  width: number,
  depth: number,
  names: readonly string[],
  { temporary = false, signal }: { temporary?: boolean; signal?: AbortSignal } = {},
): Promise<Map<string, RasterLayer>> {
  signal?.throwIfAborted();
  const raw = await upsampleRegionFieldsGPU(device, frame.region, frame.cell, ox, oz, width, depth, { signal });
  signal?.throwIfAborted();
  return rectFields(frame, ox, oz, width, depth, names, temporary, raw);
}
