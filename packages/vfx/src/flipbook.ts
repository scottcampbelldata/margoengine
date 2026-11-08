import { MargoError } from '@margoengine/math/errors';
import type { VFXExtension, VFXFlipbook, VFXOptions } from './base.js';

function once(code: string, from: string, to: string): string {
  if (code.split(from).length !== 2)
    throw new MargoError(
      'unsupported',
      'VFX flipbook needs the atlas billboard it was written for; update the flipbook edits',
    );
  return code.replace(from, to);
}

/**
 * Lifetime atlas position, the same buckets as `./texture`: 0 at birth, `count` at death. The last frame holds, so
 * `next` stays on it and the mix is a no-op there. Linear interpolation of successive frames (WGSL `mix`): Reeves,
 * "Particle Systems", SIGGRAPH 1983 (a particle's look changes over its life); sampling is `textureSample` and the
 * cells are `@interpolate(flat)` (W3C WebGPU / WGSL). The half-texel inset is the texture feature's. No other
 * engine's source was read.
 */
const lifetime =
  /o\.uv=corner;let atlasFrame=min\(u32\(max\(1-p\.positionLife\.w\/p\.rotation\.z,0\.0\)\*(\d+)\.0\),(\d+)u\);o\.cell=vec2f\(f32\(atlasFrame%(\d+)u\),f32\(atlasFrame\/\3u\)\);/;

/** The mix the fragment keeps. A test removes this text; the picture must then disagree with the blended frames. */
const blended = 'mix(flipbookSample(i.cell,i.uv),flipbookSample(i.nextCell,i.uv),i.blend)';

const billboard = (code: string): string => {
  const found = code.match(lifetime);
  if (!found || Number(found[2]) !== Number(found[1]) - 1)
    throw new MargoError(
      'unsupported',
      'VFX flipbook needs the atlas billboard it was written for; update the flipbook edits',
    );
  const count = found[1],
    last = found[2],
    columns = found[3];
  const withFrames = once(
    code,
    found[0],
    `o.uv=corner;let atlasPos=max(1.0-p.positionLife.w/p.rotation.z,0.0)*${count}.0;let atlasFrame=min(u32(atlasPos),${last}u);let atlasNext=min(atlasFrame+1u,${last}u);o.cell=vec2f(f32(atlasFrame%${columns}u),f32(atlasFrame/${columns}u));o.nextCell=vec2f(f32(atlasNext%${columns}u),f32(atlasNext/${columns}u));o.blend=atlasPos-f32(atlasFrame);`,
  );
  const start = 'let t=textureSample(sprite,spriteSampler,(i.cell+';
  const end = '));if(t.a';
  const at = withFrames.indexOf(start);
  const stop = withFrames.indexOf(end, at);
  if (at < 0 || stop < 0 || withFrames.indexOf(start, at + 1) >= 0)
    throw new MargoError(
      'unsupported',
      'VFX flipbook needs the atlas billboard it was written for; update the flipbook edits',
    );
  const inner = withFrames.slice(at + start.length, stop).replaceAll('i.uv', 'uv');
  const sampled = withFrames.slice(0, at) + `let t=${blended};` + withFrames.slice(stop + 3);
  const helper = `fn flipbookSample(cell:vec2f,uv:vec2f)->vec4f{return textureSample(sprite,spriteSampler,(cell+${inner}));}\n`;
  return once(
    once(
      sampled,
      '@location(2) @interpolate(flat) cell:vec2f}',
      '@location(2) @interpolate(flat) cell:vec2f,@location(4) @interpolate(flat) nextCell:vec2f,@location(5) @interpolate(flat) blend:f32}',
    ),
    '@fragment fn fragment',
    helper + '@fragment fn fragment',
  );
};

/**
 * The `flipbook` feature: blends each lifetime atlas frame into the next instead of stepping. Pass it as `{flipbook}`
 * to `VFX` from `@margoengine/vfx/base`; the root `VFX` has it. Needs `texture` with an atlas whose frames are
 * `'lifetime'`.
 */
export const flipbook: VFXExtension<VFXFlipbook> = {
  validate(value: VFXFlipbook, options: VFXOptions) {
    if (!value || typeof value !== 'object') throw new TypeError('VFX flipbook must be an object; pass {}');
    const atlas = options.texture?.atlas;
    if (!options.texture || !atlas || atlas.frames !== 'lifetime')
      throw new MargoError(
        'state',
        "VFX flipbook needs a texture with an atlas whose frames are 'lifetime'; pass texture and {texture: textureFeature} from @margoengine/vfx/texture",
      );
  },
  billboard,
};
