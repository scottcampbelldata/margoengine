import type { VFXFeatures, VFXTexture } from './base.js';
declare const GPUTextureUsage: { COPY_DST: number; TEXTURE_BINDING: number };
const sample = 'textureSample(sprite,spriteSampler,i.uv*vec2f(0.5,-0.5)+0.5)';
/**
 * Atlas frames: the vertex stage picks the particle's frame and passes its cell (column, row) flat; the fragment stage
 * samples inside that cell, clamped half a texel in so linear filtering never reads a neighbour. A random frame hashes
 * the birth angle, which the simulation draws at random once per spawn, so it stays fixed for the particle's life.
 * The default triangle (inradius 1) cuts the square's top corners; frames are square content (block debris), so the
 * triangle grows to contain the whole square.
 */
const atlas = (billboard: string, { width, height, atlas }: VFXTexture): string => {
  if (!atlas) return billboard;
  const { columns, rows } = atlas,
    count = columns * rows,
    inset = [(0.5 * columns) / width, (0.5 * rows) / height],
    random = atlas.frames === 'random',
    frame = random
      ? `atlasHash(bitcast<u32>(p.rotation.x))%${count}u`
      : `min(u32(max(1-p.positionLife.w/p.rotation.z,0.0)*${count}.0),${count - 1}u)`;
  return billboard
    .replace(
      'struct Out',
      (random
        ? 'fn atlasHash(v:u32)->u32 {var x=v;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return x^(x>>16u);}\n'
        : '') + 'struct Out',
    )
    .replace('@location(1) color:vec4f}', '@location(1) color:vec4f,@location(2) @interpolate(flat) cell:vec2f}')
    .replace('vec2f(-1.7320509,-1),vec2f(1.7320509,-1)', 'vec2f(-3,-1),vec2f(3,-1)')
    .replace(
      'o.uv=corner;',
      `o.uv=corner;let atlasFrame=${frame};o.cell=vec2f(f32(atlasFrame%${columns}u),f32(atlasFrame/${columns}u));`,
    )
    .replace(
      sample,
      `textureSample(sprite,spriteSampler,(i.cell+clamp(i.uv*vec2f(0.5,-0.5)+0.5,vec2f(${inset[0]},${inset[1]}),vec2f(${1 - inset[0]},${1 - inset[1]})))/vec2f(${columns},${rows}))`,
    );
};
/**
 * The `texture` feature: draws each particle as the RGBA8 sRGB sprite in `options.texture` (at most 4096 px per side)
 * multiplied by the particle colour instead of the soft disc, or with `atlas` a grid of frames, one per particle
 * (random at spawn, or stepped through over its life). Pass it as `{texture: textureFeature}` to `VFX` from
 * `@margoengine/vfx/base`. Named `textureFeature` so it does not clash with `@margoengine/shader`'s `texture()` node.
 */
export const textureFeature: NonNullable<VFXFeatures['texture']> = {
  copy(t) {
    if (
      !Number.isSafeInteger(t.width) ||
      !Number.isSafeInteger(t.height) ||
      Math.min(t.width, t.height) < 1 ||
      Math.max(t.width, t.height) > 4096 ||
      !(t.data instanceof Uint8Array || t.data instanceof Uint8ClampedArray) ||
      t.data.length !== t.width * t.height * 4
    )
      throw new RangeError(
        'Particle texture needs whole-number width and height from 1 to 4096 and RGBA data of width x height x 4 bytes; pass a Uint8Array of that length.',
      );
    const copy: VFXTexture = { width: t.width, height: t.height, data: Uint8Array.from(t.data) },
      a = t.atlas;
    if (a !== undefined) {
      if (a?.frames !== 'random' && a?.frames !== 'lifetime')
        throw new TypeError(`Particle atlas frames is ${String(a?.frames)}; pass 'random' or 'lifetime'`);
      if (
        !Number.isSafeInteger(a.columns) ||
        !Number.isSafeInteger(a.rows) ||
        Math.min(a.columns, a.rows) < 1 ||
        a.columns > t.width ||
        a.rows > t.height
      )
        throw new RangeError(
          `Particle atlas of ${a.columns} x ${a.rows} frames does not fit a ${t.width} x ${t.height} texture; pass whole numbers from 1 to the texture width and height`,
        );
      copy.atlas = { columns: a.columns, rows: a.rows, frames: a.frames };
    }
    return copy;
  },
  patch: (billboard, sprite) =>
    atlas(
      billboard
        .replace(
          'struct Out',
          '@group(0) @binding(3) var sprite:texture_2d<f32>;\n@group(0) @binding(4) var spriteSampler:sampler;\nstruct Out',
        )
        .replace(
          'let radius=dot(i.uv,i.uv);if(radius>1){discard;}return vec4f(i.color.rgb,i.color.a*(1-radius)*(1-radius));',
          `let t=${sample};if(t.a<0.02||any(abs(i.uv)>vec2f(1))){discard;}return vec4f(i.color.rgb*t.rgb,i.color.a*t.a);`,
        ),
      sprite,
    ),
  create(d, s, owned) {
    const texture = d.createTexture({
      size: [s.width, s.height],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    owned.push(texture);
    d.queue.writeTexture({ texture }, s.data as Uint8Array<ArrayBuffer>, { bytesPerRow: s.width * 4 }, [
      s.width,
      s.height,
    ]);
    return [
      { binding: 3, resource: texture.createView() },
      { binding: 4, resource: d.createSampler({ minFilter: 'linear', magFilter: 'linear' }) },
    ];
  },
};
