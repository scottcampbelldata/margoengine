// Lower device tiers, written from Khronos format tables and IEEE binary16 rules.
// Logical formats and copy layouts stay WebGPU's; only render/storage targets change.
export { requireCompatTier } from '../../shared/compat.js';
import { waitFor, install, type InstallOptions, type InstallResult, type CompatTier } from './index.js';
import type { CompatGPU, CompatGPUOptions } from './device.js';
import { FORMATS, type FormatInfo } from './device/formats.js';

/** One target-format substitution, exposed for diagnostics and attachment requirements. */
export interface TierSubstitution {
  readonly requested: string;
  readonly stored: string;
}

/** @internal Format operations shared by a lower-tier device and its upload path. */
export interface TierFormats {
  target(info: FormatInfo, usage: number): FormatInfo;
  upload(
    logical: FormatInfo,
    physical: FormatInfo,
    bytes: Uint8Array<ArrayBuffer>,
  ): { info: FormatInfo; bytes: Uint8Array<ArrayBuffer> };
  fragment(
    source: string,
    targets: readonly (GPUColorTargetState | null)[],
    outputs: readonly { readonly location: number }[],
  ): string;
  store(expression: string, format: GPUTextureFormat): string;
}

/** Installs the complete layer on the best available tier, down to LDR by default. Native WebGPU stays preferred. */
export function installTiers(options: InstallOptions = {}): Promise<InstallResult> {
  return install({ minimumTier: 'ldr', ...options });
}

/** A tier-aware GPU without changing globals. Default minimumTier `ldr`; the adapter reports capabilities.tier. */
export async function createTieredGPU({ signal, ...options }: TierGPUOptions = {}): Promise<CompatGPU> {
  signal?.throwIfAborted();
  const { createCompatGPU } = await waitFor(import('./device.js'), signal);
  signal?.throwIfAborted();
  return createCompatGPU({ minimumTier: 'ldr', ...options });
}

/** Options for {@link createTieredGPU}; cancellation applies to creation, never to adapters requested afterwards. */
export interface TierGPUOptions extends CompatGPUOptions {
  /** Cancels the lazy module wait. Default none; rejects with the signal's reason and allocates no context. */
  readonly signal?: AbortSignal;
}

/** The render/storage target selected for a WebGPU colour format. Sample-only textures retain their format. */
export function tierTextureFormat(format: GPUTextureFormat, tier: CompatTier, usage = 16): GPUTextureFormat {
  if (!['full', 'half-float', 'ldr'].includes(tier)) throw new TypeError('tier must be full, half-float or ldr');
  const info = FORMATS.get(format);
  if (!info) throw new TypeError(`Unknown texture format '${format}'; pass a WebGPU format such as rgba8unorm`);
  if (!(usage & 24) || tier === 'full' || info.kind !== 'float' || !info.name.includes('float') || !info.renderable)
    return format;
  const channels = info.channels === 3 ? 4 : info.channels;
  return `${channels === 1 ? 'r' : channels === 2 ? 'rg' : 'rgba'}${tier === 'half-float' ? '16float' : '8unorm'}` as GPUTextureFormat;
}

/** Every float target a tier substitutes; neither integer targets nor depth/stencil are changed. */
export function tierSubstitutions(tier: CompatTier): readonly TierSubstitution[] {
  return [...FORMATS.keys()].flatMap((requested) => {
    const stored = tierTextureFormat(requested as GPUTextureFormat, tier);
    return requested === stored ? [] : [{ requested, stored }];
  });
}

function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1,
    e = (bits >>> 10) & 31,
    m = bits & 1023;
  return sign * (e === 31 ? (m ? NaN : Infinity) : e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24);
}

function packed(bits: number, mantissa: number): number {
  const m = bits & ((1 << mantissa) - 1),
    e = bits >>> mantissa;
  return e === 31 ? (m ? NaN : Infinity) : e ? (1 + m / 2 ** mantissa) * 2 ** (e - 15) : m * 2 ** (-14 - mantissa);
}

/** @internal Built only when a device actually needs a lower-tier target. */
export function tierFormats(tier: CompatTier): TierFormats {
  const store = (expression: string, format: GPUTextureFormat): string =>
    tier === 'ldr' && tierTextureFormat(format, tier) !== format
      ? `(floor(clamp(${expression}, 0.0, 1.0) * 255.0 + 0.5) / 255.0)`
      : expression;
  return {
    store,
    fragment(source, targets, outputs) {
      const writes = targets.flatMap((target, location) => {
        if (!target || target.blend || !outputs.some((output) => output.location === location)) return [];
        const output = `_o${location}`,
          value = store(output, target.format);
        return output === value ? [] : [`${output} = ${value};`];
      });
      if (!writes.length) return source;
      // All stages come from the owned GLSL emitter. A wrapper also handles early returns without duplicating work.
      return (
        source.replace('void main() {', 'void _margoTierMain() {') +
        `\nvoid main() { _margoTierMain(); ${writes.join(' ')} }\n`
      );
    },
    target(info, usage) {
      return FORMATS.get(tierTextureFormat(info.name as GPUTextureFormat, tier, usage)) as FormatInfo;
    },
    upload(logical, physical, bytes) {
      if (logical === physical) return { info: logical, bytes };
      const count = bytes.length / logical.bytes;
      const floats = new Float32Array(count * physical.channels);
      const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < count; i++) {
        const word = logical.name === 'rg11b10ufloat' ? input.getUint32(i * 4, true) : 0;
        for (let c = 0; c < physical.channels; c++) {
          floats[i * physical.channels + c] =
            c >= logical.channels
              ? 1
              : logical.name === 'rg11b10ufloat'
                ? packed((word >>> (c === 0 ? 0 : c === 1 ? 11 : 22)) & (c === 2 ? 1023 : 2047), c === 2 ? 5 : 6)
                : logical.channelBytes === 4
                  ? input.getFloat32(i * logical.bytes + c * 4, true)
                  : half(input.getUint16(i * logical.bytes + c * 2, true));
        }
      }
      if (physical.channelBytes === 1) {
        // Explicit UNORM conversion: GL does not accept FLOAT uploads to sized UNORM textures.
        const out = Uint8Array.from(floats, (value) => Math.round(Math.max(0, Math.min(1, value || 0)) * 255));
        return { info: physical, bytes: out };
      }
      // GL accepts FLOAT uploads to a half-float texture and rounds to its physical storage on upload.
      return {
        info: { ...physical, type: 'FLOAT', bytes: physical.channels * 4 },
        bytes: new Uint8Array(floats.buffer),
      };
    },
  };
}
