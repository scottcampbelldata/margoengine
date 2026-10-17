import type { PBRRenderState } from './index.js';

const compares = ['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'];
const operations = [
  'keep',
  'zero',
  'replace',
  'invert',
  'increment-clamp',
  'decrement-clamp',
  'increment-wrap',
  'decrement-wrap',
];
const stencilFields = [
  'stencilFront',
  'stencilBack',
  'stencilReadMask',
  'stencilWriteMask',
  'stencilReference',
] as const;
const stencilReferences = new WeakMap<GPURenderPassEncoder, number>();

/** Preserve feature-off command streams while resetting references left by another material on the same pass. */
export function applyStencilReference(pass: GPURenderPassEncoder, state: PBRRenderState | undefined): void {
  if (!(state && stencilFields.some((key) => state[key] !== undefined)) && !stencilReferences.get(pass)) return;
  const reference = state?.stencilReference ?? 0;
  pass.setStencilReference?.(reference);
  stencilReferences.set(pass, reference);
}

/** Winding-normalized static batches cannot preserve different native raster-front and raster-back operations. */
export function asymmetricStencilFaces(state: PBRRenderState | undefined): boolean {
  const front = state?.stencilFront,
    back = state?.stencilBack;
  if (!front && !back) return false;
  return (
    (front?.compare ?? 'always') !== (back?.compare ?? 'always') ||
    (front?.failOp ?? 'keep') !== (back?.failOp ?? 'keep') ||
    (front?.depthFailOp ?? 'keep') !== (back?.depthFailOp ?? 'keep') ||
    (front?.passOp ?? 'keep') !== (back?.passOp ?? 'keep')
  );
}

/** Validate optional native state before a cached pipeline or a dynamic reference can reach WebGPU. */
export function validateRenderState(state: PBRRenderState, format: GPUTextureFormat): void {
  if (state.depthBiasMode !== undefined && !['native', 'away'].includes(state.depthBiasMode))
    throw new TypeError('PBR renderState depthBiasMode is invalid; set it to native or away');
  if (state.depthBias !== undefined && typeof state.depthBias !== 'number')
    throw new TypeError('PBR renderState depthBias must be a number; set a signed 32-bit integer');
  if (
    state.depthBias !== undefined &&
    (!Number.isInteger(state.depthBias) || state.depthBias < -0x80000000 || state.depthBias > 0x7fffffff)
  )
    throw new RangeError(
      'PBR renderState depthBias must be a signed 32-bit integer; set an integer from -2147483648 through 2147483647',
    );
  for (const key of ['depthBiasSlopeScale', 'depthBiasClamp'] as const) {
    const value = state[key];
    if (value !== undefined && typeof value !== 'number')
      throw new TypeError('PBR renderState ' + key + ' must be a number; set a finite float32 value');
    if (value !== undefined && !Number.isFinite(Math.fround(value)))
      throw new RangeError(
        'PBR renderState ' + key + ' is not finite as float32; set a finite number representable as float32',
      );
  }
  for (const key of ['stencilReadMask', 'stencilWriteMask', 'stencilReference'] as const) {
    const value = state[key];
    if (value !== undefined && typeof value !== 'number')
      throw new TypeError('PBR renderState ' + key + ' must be a number; set an unsigned 32-bit integer');
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
      throw new RangeError(
        'PBR renderState ' + key + ' must be an unsigned 32-bit integer; set an integer from 0 through 4294967295',
      );
  }
  for (const key of ['stencilFront', 'stencilBack'] as const) {
    const face = state[key];
    if (face === undefined) continue;
    if (
      !face ||
      typeof face !== 'object' ||
      Array.isArray(face) ||
      (Object.getPrototypeOf(face) !== Object.prototype && Object.getPrototypeOf(face) !== null)
    )
      throw new TypeError(
        'PBR renderState ' +
          key +
          ' must be a stencil face state; pass {} or an object with compare, failOp, depthFailOp and passOp fields',
      );
    if (face.compare !== undefined && !compares.includes(face.compare))
      throw new TypeError('PBR renderState ' + key + '.compare is invalid; set one of ' + compares.join(', '));
    for (const operation of ['failOp', 'depthFailOp', 'passOp'] as const)
      if (face[operation] !== undefined && !operations.includes(face[operation]))
        throw new TypeError(
          'PBR renderState ' + key + '.' + operation + ' is invalid; set one of ' + operations.join(', '),
        );
  }
  if (state.colorWrite !== undefined && typeof state.colorWrite !== 'boolean')
    throw new TypeError('PBR renderState colorWrite must be a boolean; set true or false');
  if (stencilFields.some((key) => state[key] !== undefined) && !format.includes('stencil'))
    throw new TypeError(
      'PBR stencil state requires a target format with a stencil aspect; render into depth24plus-stencil8 or depth32float-stencil8, or remove the stencil fields (received ' +
        format +
        ')',
    );
}

/** The reference is per draw; all other native overrides select the pipeline. */
export function renderStateKey(state: PBRRenderState | undefined): string {
  return state ? JSON.stringify({ ...state, stencilReference: undefined }) : '';
}

/** Polygon bias has no effect on points and lines, and WebGPU requires those pipeline values to be zero. */
export function pipelineDepthState(
  state: PBRRenderState | undefined,
  triangles: boolean,
  forwardZ: boolean,
): Partial<GPUDepthStencilState> {
  if (!state) return {};
  const direction = state.depthBiasMode === 'away' && !forwardZ ? -1 : 1,
    depthBias = triangles && state.depthBias !== undefined ? state.depthBias * direction : undefined;
  if (depthBias !== undefined && (depthBias < -0x80000000 || depthBias > 0x7fffffff))
    throw new RangeError(
      'Converted PBR renderState depthBias must be a signed 32-bit integer; reduce its magnitude or use native mode for a literal WebGPU bias',
    );
  const result: Partial<GPUDepthStencilState> = {};
  if (depthBias !== undefined) result.depthBias = depthBias;
  if (triangles && state.depthBiasSlopeScale !== undefined)
    result.depthBiasSlopeScale = state.depthBiasSlopeScale * direction;
  if (triangles && state.depthBiasClamp !== undefined) result.depthBiasClamp = state.depthBiasClamp * direction;
  if (state.stencilFront !== undefined) result.stencilFront = state.stencilFront;
  if (state.stencilBack !== undefined) result.stencilBack = state.stencilBack;
  if (state.stencilReadMask !== undefined) result.stencilReadMask = state.stencilReadMask;
  if (state.stencilWriteMask !== undefined) result.stencilWriteMask = state.stencilWriteMask;
  return result;
}
