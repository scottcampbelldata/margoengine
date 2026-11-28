// Texture maps for Scatter (`ScatterOptions.textures`): a scanned plant or rock drawn with its glTF 2.0 metallic-roughness
// maps (base colour with an alpha MASK cut-out, a tangent-space normal map and an occlusion-roughness-metal map) instead
// of one flat colour per part. Everything here is pure: the option checks, the mip chains built on the CPU and the WGSL
// edits that Scatter applies to its lit colour pass and its shadow pass.
//
// Sources (clean room, from the papers and the specification):
// - Khronos glTF 2.0 specification (2021), sections 3.9.2 to 3.9.6: baseColorFactor times the base colour texture,
//   roughness in G and metalness in B of the metallicRoughness texture, occlusion in R scaling indirect light only,
//   alphaMode MASK with alphaCutoff (default 0.5) and doubleSided back faces with flipped normals.
//   https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
// - C. Schueler, "Normal Mapping Without Precomputed Tangents", ShaderX5 (2006), and the follow-up note (2013):
//   the cotangent frame from screen derivatives of position and texture coordinate, so a mesh needs no tangents.
//   http://www.thetenthplanet.de/archives/1180
//   The frame is divided by the sign of its determinant, so it holds with WebGPU's y-down screen derivatives
//   (the note assumes y up) and on mirrored meshes.
// - M. Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU", JGT 2010: the surface-gradient form the frame
//   above is a case of. https://doi.org/10.1080/2151237X.2010.10390356
// - I. Castano, "Computing Alpha Mipmaps" (2010): each mip level's alpha is scaled so the share of texels passing the
//   cut-off matches the full-size image, so cut-out foliage does not thin out and vanish with distance.
//   http://www.ludicon.com/castano/blog/articles/computing-alpha-mipmaps/
// - C. Wyman and M. McGuire, "Hashed Alpha Testing", I3D 2017 / JCGT 6(2): why plain mips of alpha lose coverage
//   (the problem the scaling above answers). https://jcgt.org/published/0006/02/02/
import { rangeError, typeError } from '../../shared/errors.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** An image a scatter map can be made from: decoded pixels (RGBA, 8 bits a channel, rows top first) or an image the
 * browser can draw (ImageBitmap, image element, canvas). */
export type ScatterImage =
  | { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray }
  | ImageBitmap
  | OffscreenCanvas
  | HTMLCanvasElement
  | HTMLImageElement;

/**
 * Texture maps of a scatter mesh (`ScatterOptions.textures`), as a glTF metallic-roughness material reads them. The
 * scatter's `material` colour, roughness and metalness multiply the maps (glTF factors); give a textured mesh a white
 * material colour to show the map as authored. Needs `material`.
 */
export interface ScatterTextures {
  /** Texture coordinates, two per vertex (glTF TEXCOORD_0), one array per LOD ring geometry or one for all three. */
  readonly uvs: ArrayLike<number> | readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  /** Base colour in sRGB with alpha (glTF baseColorTexture). Default white. */
  readonly baseColor?: ScatterImage;
  /** Tangent-space normal map, OpenGL convention (glTF normalTexture, green up). Default flat. */
  readonly normal?: ScatterImage;
  /** Occlusion in R, roughness in G, metalness in B (glTF occlusion and metallicRoughness textures packed). Default
   * white (no occlusion; the material's roughness and metalness as they are). */
  readonly occlusionRoughnessMetal?: ScatterImage;
  /**
   * Alpha cut-off (glTF alphaMode MASK): pixels with base colour alpha below it are not drawn, in the colour pass and
   * in the shadow casters, so leaf cards cast leaf-shaped shadows. 0 draws every pixel (OPAQUE). Default 0.5 when
   * `baseColor` is given, else 0.
   */
  readonly alphaCutoff?: number;
}

/** A map's mip chain: RGBA8 levels, full size first. */
export interface MipChain {
  readonly width: number;
  readonly height: number;
  readonly levels: Uint8Array[];
}

const isImage = (v: unknown): boolean =>
  typeof v === 'object' &&
  v !== null &&
  ((ArrayBuffer.isView((v as { data?: unknown }).data) &&
    Number.isInteger((v as { width: number }).width) &&
    Number.isInteger((v as { height: number }).height)) ||
    typeof (v as { width?: unknown }).width === 'number');

/** Checks `textures` against the ring geometries' vertex counts; returns the three uv arrays as Float32Array. */
export function checkTextures(textures: unknown, vertexCounts: readonly number[]): Float32Array[] {
  if (typeof textures !== 'object' || textures === null || Array.isArray(textures))
    throw typeError('Scatter textures must be an object with uvs and maps', 'scatter');
  const t = textures as ScatterTextures;
  for (const key of ['baseColor', 'normal', 'occlusionRoughnessMetal'] as const)
    if (t[key] !== undefined && !isImage(t[key]))
      throw typeError(
        `Scatter textures.${key} must be an ImageBitmap, canvas, image or { width, height, data }`,
        'scatter',
      );
  const cut = t.alphaCutoff ?? 0;
  if (!Number.isFinite(cut) || cut < 0 || cut > 1)
    throw rangeError('Scatter textures.alphaCutoff must be 0 to 1', 'scatter');
  const ring = (t.uvs as ArrayLike<unknown>)?.[0];
  const list =
    typeof ring === 'object' && ring !== null ? (t.uvs as readonly ArrayLike<number>[]) : [t.uvs, t.uvs, t.uvs];
  if (list.length !== 3) throw typeError('Scatter textures.uvs is one array or three (near, middle, far)', 'scatter');
  return list.map((uv, i) => {
    if (!uv || typeof (uv as ArrayLike<number>).length !== 'number')
      throw typeError('Scatter textures.uvs must hold numbers, two per vertex', 'scatter');
    const a = Float32Array.from(uv as ArrayLike<number>);
    if (a.length !== vertexCounts[i] * 2)
      throw rangeError(
        `Scatter textures.uvs ring ${i} holds ${a.length / 2} coordinates for ${vertexCounts[i]} vertices`,
        'scatter',
      );
    if (!a.every(Number.isFinite)) throw rangeError('Scatter textures.uvs must be finite numbers', 'scatter');
    return a;
  });
}

/** The cut-off a textures option draws with. */
export const cutoffOf = (t: ScatterTextures): number => t.alphaCutoff ?? (t.baseColor ? 0.5 : 0);

/** Interleaves a ring's 24-byte core vertices (position, normal) with its uvs: 32 bytes a vertex. */
export function interleave(vertices: Float32Array, uvs: Float32Array): Float32Array {
  const n = vertices.length / 6,
    out = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    out.set(vertices.subarray(i * 6, i * 6 + 6), i * 8);
    out[i * 8 + 6] = uvs[i * 2];
    out[i * 8 + 7] = uvs[i * 2 + 1];
  }
  return out;
}

const toLinear = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const toSrgb = (l: number): number => {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

/** Share of texels whose alpha scaled by `scale` reaches `cut`. */
function coverage(level: Uint8Array, cut: number, scale: number): number {
  let n = 0;
  const limit = (cut * 255) / scale; // float division: share only
  for (let i = 3; i < level.length; i += 4) if (level[i] >= limit) n++;
  return n / (level.length / 4); // float division: share only
}

/**
 * The mip chain of an RGBA8 image, each level a 2x2 box of the one above (odd sizes clamp at the edge). `kind` picks the
 * filter: `'color'` averages sRGB colour in linear light and, with `cut` > 0, rescales each level's alpha so its
 * coverage at `cut` matches level 0 (Castano 2010); `'normal'` averages and renormalises the vectors; `'data'` averages.
 */
export function mipChain(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  kind: 'color' | 'normal' | 'data',
  cut = 0,
): MipChain {
  if (!(width > 0 && height > 0 && data.length === width * height * 4))
    throw rangeError('Scatter texture data must hold width x height RGBA texels', 'scatter');
  const levels = [Uint8Array.from(data)],
    target = kind === 'color' && cut > 0 ? coverage(levels[0], cut, 1) : 0;
  let w = width,
    h = height;
  while (w > 1 || h > 1) {
    const src = levels[levels.length - 1],
      nw = Math.max(1, w >> 1),
      nh = Math.max(1, h >> 1),
      out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const s = [0, 0, 0, 0];
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const at = (Math.min(h - 1, y * 2 + dy) * w + Math.min(w - 1, x * 2 + dx)) * 4;
            for (let c = 0; c < 4; c++) s[c] += kind === 'color' && c < 3 ? toLinear[src[at + c]] : src[at + c];
          }
        const o = (y * nw + x) * 4;
        if (kind === 'color') {
          for (let c = 0; c < 3; c++) out[o + c] = toSrgb(s[c] / 4);
          out[o + 3] = Math.round(s[3] / 4);
        } else if (kind === 'normal') {
          const v = [s[0] / 4 / 127.5 - 1, s[1] / 4 / 127.5 - 1, s[2] / 4 / 127.5 - 1], // float division: texel only
            l = Math.hypot(v[0], v[1], v[2]) || 1;
          for (let c = 0; c < 3; c++) out[o + c] = Math.round((v[c] / l + 1) * 127.5);
          out[o + 3] = Math.round(s[3] / 4);
        } else for (let c = 0; c < 4; c++) out[o + c] = Math.round(s[c] / 4);
      }
    if (target > 0 && coverage(out, cut, 1) < target) {
      // Bisect the smallest alpha scale whose coverage at the cut reaches level 0's, then apply it. A level that kept
      // its coverage is left as it is (scaling it down would put its texels on the cut-off itself).
      let lo = 1,
        hi = 255;
      for (let k = 0; k < 16; k++) {
        const mid = (lo + hi) / 2; // float division: search only
        if (coverage(out, cut, mid) < target) lo = mid;
        else hi = mid;
      }
      const scale = hi;
      for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, Math.round(out[i] * scale));
    }
    levels.push(out);
    w = nw;
    h = nh;
  }
  return { width, height, levels };
}

/** RGBA8 texels of an image (decoded pixels as they are; a drawable image through a 2D canvas). */
export function pixelsOf(image: ScatterImage): { width: number; height: number; data: Uint8Array | Uint8ClampedArray } {
  const raw = image as { width: number; height: number; data?: Uint8Array | Uint8ClampedArray };
  if (raw.data && ArrayBuffer.isView(raw.data)) return { width: raw.width, height: raw.height, data: raw.data };
  const width = raw.width,
    height = raw.height,
    canvas = new OffscreenCanvas(width, height),
    ctx = canvas.getContext('2d');
  if (!ctx)
    throw typeError('Scatter textures need a 2D canvas to read an image; pass { width, height, data }', 'scatter');
  ctx.drawImage(image as CanvasImageSource, 0, 0);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/** Uploads a mip chain to a new texture of `format`. */
export function uploadChain(d: GPUDevice, chain: MipChain, format: GPUTextureFormat): GPUTexture {
  let first = 0;
  while (
    chain.width >> first > d.limits.maxTextureDimension2D ||
    chain.height >> first > d.limits.maxTextureDimension2D
  )
    first++;
  const levels = chain.levels.slice(first),
    width = Math.max(1, chain.width >> first),
    height = Math.max(1, chain.height >> first),
    texture = d.createTexture({
      size: [width, height],
      format,
      mipLevelCount: levels.length,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  levels.forEach((level, mip) => {
    const w = Math.max(1, width >> mip),
      h = Math.max(1, height >> mip);
    d.queue.writeTexture({ texture, mipLevel: mip }, level as Uint8Array<ArrayBuffer>, { bytesPerRow: w * 4 }, [w, h]);
  });
  return texture;
}

/** The three maps' mip chains (a default 1x1 texel for a map not given). */
export function chainsOf(t: ScatterTextures): { base: MipChain; normal: MipChain; orm: MipChain } {
  const make = (image: ScatterImage | undefined, kind: 'color' | 'normal' | 'data', fallback: number[]) => {
    if (!image) return { width: 1, height: 1, levels: [Uint8Array.from(fallback)] };
    const p = pixelsOf(image);
    return mipChain(p.data, p.width, p.height, kind, kind === 'color' ? cutoffOf(t) : 0);
  };
  return {
    base: make(t.baseColor, 'color', [255, 255, 255, 255]),
    normal: make(t.normal, 'normal', [128, 128, 255, 255]),
    orm: make(t.occlusionRoughnessMetal, 'data', [255, 255, 255, 255]),
  };
}

/** WGSL the textured colour pass adds before its fragment stage: the maps and the cotangent-frame normal. */
export const mapsShader = (group: number) => `
@group(${group}) @binding(0) var scatterSampler:sampler;
@group(${group}) @binding(1) var scatterBase:texture_2d<f32>;
@group(${group}) @binding(2) var scatterNormal:texture_2d<f32>;
@group(${group}) @binding(3) var scatterOrm:texture_2d<f32>;
fn scatterPerturb(n:vec3f,dp1:vec3f,dp2:vec3f,duv1:vec2f,duv2:vec2f,t:vec3f)->vec3f {
 let a=cross(dp2,n);let b=cross(n,dp1);let e=select(-1.0,1.0,dot(dp1,a)>=0.0);
 let tu=(a*duv1.x+b*duv2.x)*e;let tv=(a*duv1.y+b*duv2.y)*e;
 let m=max(dot(tu,tu),dot(tv,tv));if(!(m>1e-30)){return n;}
 let s=inverseSqrt(m);return normalize(tu*s*t.x+tv*s*t.y+n*t.z);
}
`;

/**
 * Edits core's lit fragment stage (already carrying Scatter's other edits) to read the maps: base colour times the
 * material colour, the alpha cut-off, roughness and metalness times the material's, occlusion on the ambient term
 * and the normal map through the cotangent frame. Every map is sampled first, in uniform control flow.
 */
export function texturedFragment(code: string, cut: number, normalLine: string): string {
  const at = code.indexOf('@fragment fn fragment');
  if (at < 0) throw typeError('Scatter textures need a lit shader with a fragment stage', 'scatter');
  const head = code.slice(0, at),
    body = code.slice(at),
    brace = body.indexOf('{') + 1,
    // Scatter's positiveColor stage copies its input to a `var i` first: the maps are read after that line.
    open = body.slice(brace).trimStart().startsWith('var i=') ? body.indexOf('\n', brace + 1) + 1 : brace;
  const sample =
    '\n let surfBase=textureSample(scatterBase,scatterSampler,i.uv);let surfOrm=textureSample(scatterOrm,scatterSampler,i.uv);' +
    'let surfMap=textureSample(scatterNormal,scatterSampler,i.uv).xyz*2.0-1.0;' +
    'let sdp1=dpdx(i.position);let sdp2=dpdy(i.position);let suv1=dpdx(i.uv);let suv2=dpdy(i.uv);' +
    (cut > 0 ? `if(surfBase.a<${cut.toFixed(6)}){discard;}` : '') +
    'var surfColor=surfBase.rgb*i.color;var surfRough=clamp(surfOrm.g*i.material.x,0.02,1.0);var surfMetal=surfOrm.b*i.material.y;';
  let rest = body
    .slice(open)
    .replaceAll('i.color', 'surfColor')
    .replaceAll('i.material.x', 'surfRough')
    .replaceAll('i.material.y', 'surfMetal')
    .replaceAll('frame.ambient.rgb', '(frame.ambient.rgb*surfOrm.r)');
  if (rest.includes(normalLine))
    rest = rest.replace(
      normalLine,
      normalLine.replace(
        /^let n=(.*);$/,
        'let n=scatterPerturb($1,sdp1,sdp2,suv1,suv2,vec3f(surfMap.xy,max(surfMap.z,0.0)));',
      ),
    );
  return head + mapsShader(2) + body.slice(0, open) + sample + rest;
}

/** Edits the lit vertex stage to take texture coordinates (vertex location 2) and pass them on at `location`. */
export function texturedVertex(code: string, location: number): string {
  const signature = '@location(1) n:vec3f,',
    output = '@location(3) material:vec4f';
  if (!code.includes(signature) || !code.includes(output))
    throw typeError('Scatter textures need the lit vertex stage they were written for', 'scatter');
  const start = code.indexOf('@vertex fn vertex'),
    end = code.indexOf('@fragment', start),
    stage = code
      .slice(start, end < 0 ? undefined : end)
      .replace(signature, signature + '@location(2) uv:vec2f,')
      .replace(/return o;\s*\}/, 'o.uv=uv;return o;\n}');
  return (
    code.slice(0, start).replace(output, `${output},@location(${location}) uv:vec2f`) +
    stage +
    (end < 0 ? '' : code.slice(end))
  );
}

/**
 * Edits a shadow vertex stage (Scatter's depth-only casters) to take texture coordinates and add a fragment stage
 * that drops texels under the cut-off, so cut-out leaves cast leaf-shaped shadows.
 */
export function texturedShadow(code: string, cut: number): string {
  const head = '->@builtin(position) @invariant vec4f {',
    back = /\n return (frame\.light\*[^\n]+);\n\}/;
  if (!code.includes(head) || !back.test(code))
    throw typeError('Scatter textures need the shadow stage they were written for', 'scatter');
  return (
    `struct ScatterShadow {@builtin(position) @invariant clip:vec4f,@location(0) uv:vec2f}
@group(1) @binding(0) var scatterSampler:sampler;
@group(1) @binding(1) var scatterBase:texture_2d<f32>;
` +
    code
      .replace('@location(1) n:vec3f,', '@location(1) n:vec3f,@location(2) uv:vec2f,')
      .replace(head, '->ScatterShadow {')
      .replace(back, '\n var o:ScatterShadow;o.clip=$1;o.uv=uv;return o;\n}') +
    `
@fragment fn fragment(i:ScatterShadow) {if(textureSample(scatterBase,scatterSampler,i.uv).a<${cut.toFixed(6)}){discard;}}
`
  );
}
