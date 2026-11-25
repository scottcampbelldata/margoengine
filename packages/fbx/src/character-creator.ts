// Character Creator's material json: the file Reallusion's Character Creator writes beside its FBX (`<name>.json`),
// holding what the FBX has no slot for. Its layout is read from such files (vendor format, no published spec):
// `<name>.Object.<name>.Meshes.<mesh>.Materials.<material>` with `Textures` (Base Color, Normal, Roughness, Metallic, AO,
// Opacity: a `Texture Path` relative to the json and a `Strength` in percent), `Two Side`, and a `Custom Shader` with
// its `Shader Name` and `Variable` numbers. Paths without a folder are the images the FBX embeds, which the base reader
// already took; the others are the maps Character Creator exported next to it.
// What lands where, as glTF 2.0 holds it (Khronos, glTF 2.0 Specification, 2021, section 3.9): roughness in green and
// metalness in blue of one image, ambient occlusion in red with its strength. The eye occlusion (`RLEyeOcclusion`) is a
// clear shell over the eyeball that Character Creator's shader darkens along the lids, so the eye sits in its socket: the
// ambient occlusion of the eyeball by the lids and lashes, which film eye rendering draws as a soft gradient on such a
// shell (Jimenez, von der Pahlen et al., "Next-Generation Character Rendering", GDC 2013; ambient occlusion after Zhukov,
// Iones and Kronin, "An Ambient Light Illumination Model", EGWR 1998). Its numbers are read by their names: per edge of
// the opening (top, bottom, inner and outer corner) the shadow's width as a share of the eye, its `Range` the share of
// that width that fades, its `Arc` how much the width follows the lid's curve; `Shadow Strength` and `Shadow Color` the
// darkening, a second, narrower `Shadow2` under the top lid. glTF blends over the eye rather than multiplying it, so a
// colour c at strength s is the darkening s (1 - luminance(c)) with the darker colour on top. The tear line
// (`RLEyeTearline`) is the wet strip on the lower lid: clear, with its `_Roughness`, so it shows as a glint.
// Skin (`RLHead`, `RLSkin`) carries a micro normal map, pores and fine wrinkles tiled `MicroNormal Tiling` times at
// `MicroNormal Strength` where its `MicroNormalMask` allows, and a `Micro Roughness Scale` that Character Creator adds to
// the roughness of the whole material (Reallusion, Character Creator 4 manual, "Digital Human Shader > Head >
// Roughness"). The micro normals are a fraction of a millimetre across, far below a pixel at any film distance, so what
// they do on screen is widen the highlight: the slopes they add widen the microfacet distribution by their variance,
// alpha'^2 = alpha^2 + sigma_x^2 + sigma_y^2 (LEAN mapping, Olano and Baker, "LEAN Mapping", I3D 2010; Toksvig,
// "Mipmapping Normal Maps", JGT 2005; Beckmann's alpha^2 is twice the slope variance per axis). Without it the skin
// keeps the sheen of the bare roughness map, a smooth oiled film in sunlight; measured faces keep a narrow sheen only
// where sebum gathers, the nose and forehead, the nose smoothest (Weyrich et al., "Analysis of Human Faces using a
// Measurement-Based Skin Reflectance Model", SIGGRAPH 2006, section 7). The head shader also scales roughness per region of
// the face (`Nose`, `Mouth`, `UpperLid`, `InnerLid`, `Cheek`, `Forehead`, `UpperLip`, `Chin`, `Ear`, `Neck` `Roughness
// Scale`), each over a channel of its region masks (`Nose Mouth UpperInnerLid Mask` red to alpha, `Cheek Fore UpperLip Chin
// Mask`, `Ear Neck Mask`), and `Unmasked Roughness Scale` where no mask reaches; the body's `RLSkin` the same over the four
// channels of its `RGBA Area Mask` (Reallusion, Character Creator 4 manual, "Digital Human Shader > Head > Roughness"). A
// wet upper lid (UpperLid -0.3 on a CC default head) keeps its sheen as the measured lid margin does, where the rest of
// the face is drier (Weyrich et al. 2006).
import { parseTGA } from '@margoengine/decoders/tga';
import { decodeJPEG } from '@margoengine/exporters/jpeg-read';
import { encodePNG } from '@margoengine/exporters/capture';
import type { ExportNode, MaterialData, TextureData } from '@margoengine/exporters';
import { decodePNG } from '@margoengine/decoders/png';
import type { ExtensionHooks, FBXExtension, MaterialRead } from './extension.js';
import { id, objectName } from './document.js';
import { composeTRS, multiply, transformPoint } from './math.js';
import type { MeshBinding, SceneContext } from './scene.js';
import { anchorLidShadow } from './eye-margin.js';

export { anchorLidShadow, type LidMargin, type MarginMesh, type MarginShell } from './eye-margin.js';

/** One material of the json, as Character Creator writes it. */
interface CCMaterial {
  'Two Side'?: boolean;
  Textures?: Record<string, { 'Texture Path'?: string; Strength?: number } | undefined>;
  'Custom Shader'?: {
    'Shader Name'?: string;
    Variable?: Record<string, unknown>;
    Image?: Record<string, { 'Texture Path'?: string } | undefined>;
  };
}
/** Options of {@link characterCreator}. */
export interface CharacterCreatorOptions {
  /** Where the json's relative texture paths start: the json's own URL. Default the page's location, if any. */
  base?: string | URL;
  /** Reads one exported map; nothing when it is missing. Default `fetch` of the path against `base`. */
  read?: (url: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
  /** Stops the map reads. */
  signal?: AbortSignal;
}
type Pixels = { width: number; height: number; data: Uint8Array };

const fetchBytes = async (url: string, signal?: AbortSignal): Promise<Uint8Array | undefined> => {
  const response = await fetch(url, { signal });
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
};
const kind = (b: Uint8Array): TextureData['mimeType'] | undefined =>
  b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : undefined;
const decode = (t: TextureData): Pixels =>
  (t.mimeType === 'image/png' ? decodePNG(t.image) : decodeJPEG(t.image)) as Pixels;
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const unit = (v: number): number => Math.min(1, Math.max(0, v));
/** sRGB 0 to 255 to linear (IEC 61966-2-1). */
const linear = (c: number): number => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (v: unknown, fallback: readonly number[]): number[] =>
  Array.isArray(v) && v.length >= 3 && v.every((c) => typeof c === 'number')
    ? v.slice(0, 3).map(linear)
    : fallback.map(linear);
const luminance = (c: readonly number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (a: number, b: number, x: number): number => {
  const t = b > a ? unit((x - a) / (b - a)) : x < a ? 0 : 1;
  return t * t * (3 - 2 * t);
};

/** Every material of the json by name. Throws on something that is not Character Creator's json. */
function materialsOf(json: unknown): Map<string, CCMaterial> {
  const out = new Map<string, CCMaterial>(),
    roots = json && typeof json === 'object' ? Object.values(json as Record<string, unknown>) : [];
  for (const root of roots) {
    const objects = (root as { Object?: Record<string, { Meshes?: Record<string, { Materials?: object }> }> })?.Object;
    for (const object of Object.values(objects ?? {}))
      for (const mesh of Object.values(object?.Meshes ?? {}))
        for (const [name, material] of Object.entries(mesh?.Materials ?? {}))
          if (material && typeof material === 'object') out.set(name, material as CCMaterial);
  }
  if (!out.size)
    throw new TypeError(
      'Character Creator json has no materials; pass the .json Character Creator wrote beside the FBX',
    );
  return out;
}

/**
 * The eye occlusion's opacity over its shell, `width` by `height` in the glTF UVs of Character Creator's shell: v 0 at
 * the top lid and 1 at the bottom, u 0 at the outer corner and 1 at the inner (tear duct) corner, both eyes alike.
 */
export function eyeOcclusionAlpha(
  variables: Record<string, unknown> = {},
  width = 128,
  height = 64,
): { width: number; height: number; data: Uint8Array } {
  const v = (name: string, fallback: number) => num(variables[name], fallback),
    edge = (d: number, w: number, range: number) => (w > 0 ? 1 - smooth(w * (1 - unit(range)), w, d) : 0),
    arc = (u: number, power: number) => (power > 0 ? Math.sin(Math.PI * u) ** power : 1),
    first = rgb(variables['Shadow Color'], [178, 126, 109]),
    second = rgb(variables['Shadow2 Color'], [60, 41, 36]),
    s1 = unit(v('Shadow Strength', 0.5)) * (1 - luminance(first)),
    s2 = unit(v('Shadow2 Strength', 0.41)) * (1 - luminance(second)),
    data = new Uint8Array(width * height * 4),
    color = second.map((c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  for (let y = 0, at = 0; y < height; y++)
    for (let x = 0; x < width; x++, at += 4) {
      const u = (x + 0.5) / width,
        t = (y + 0.5) / height,
        top = edge(t, v('Shadow Top', 0.26) * arc(u, v('Shadow Top Arc', 1)), v('Shadow Top Range', 1)),
        bottom = edge(
          1 - t,
          v('Shadow Bottom', 0.05) * arc(u, v('Shadow Bottom Arc', 2)),
          v('Shadow Bottom Range', 0.3),
        ),
        outer = edge(u, v('Shadow Outer Corner', 0.2), v('Shadow Outer Corner Range', 0.5)),
        inner = edge(1 - u, v('Shadow Inner Corner', 0.25), v('Shadow Inner Corner Range', 0.5)),
        top2 = edge(t, v('Shadow2 Top', 0.09) * arc(u, v('Shadow Top Arc', 1)), v('Shadow2 Top Range', 1)),
        a = 1 - (1 - s1 * Math.max(top, bottom, outer, inner)) * (1 - s2 * top2);
      data.set([color[0], color[1], color[2], Math.round(255 * unit(a))], at);
    }
  return { width, height, data };
}

/**
 * Reads Character Creator's material json into the FBX import: the exported roughness, metallic and ambient occlusion
 * maps of every material, a normal map the FBX lacks, two-sided materials, and the eye occlusion and tear line shells as
 * the soft lid shadow and wet strip they stand for. Pass it after `pbrMaterials`, with the json and its URL:
 * ```ts
 * const url = new URL('./wilbur.json', location.href);
 * const cc = characterCreator(await (await fetch(url)).json(), { base: url });
 * const model = await loadFBX(engine, new URL('./wilbur.fbx', location.href), { extensions: [pbrMaterials, cc] });
 * ```
 * A material the json does not name is left as the FBX has it. Runs with `loadFBX` and `convertFBX` on the page.
 */
export function characterCreator(json: unknown, options: CharacterCreatorOptions = {}): FBXExtension {
  const materials = materialsOf(json),
    { read = fetchBytes, signal } = options,
    base = options.base ?? (globalThis as { location?: { href: string } }).location?.href;
  if (typeof read !== 'function') throw new TypeError('characterCreator read must be a function returning bytes');
  const maps = new Map<string, Promise<TextureData | undefined>>(),
    variances = new Map<TextureData, Promise<number>>();
  const map = (entry: { 'Texture Path'?: string } | undefined): Promise<TextureData | undefined> | undefined => {
    const path = entry?.['Texture Path'];
    // A bare name is an image inside the FBX, which the base reader read already.
    if (typeof path !== 'string' || !/[\\/]/.test(path)) return undefined;
    const url = new URL(path.replace(/\\/g, '/'), base).href;
    let loading = maps.get(url);
    if (!loading) {
      loading = (async () => {
        signal?.throwIfAborted();
        const bytes = await read(url, signal),
          mimeType = bytes && kind(bytes);
        return bytes && mimeType ? { image: bytes, mimeType, name: path.replace(/^.*[\\/]/, '') } : undefined;
      })();
      maps.set(url, loading);
    }
    return loading;
  };
  // Any exported picture as pixels: PNG and JPEG through `map`, Targa (the region masks) read here.
  const targas = new Map<string, Promise<Pixels | undefined>>();
  const picture = async (entry: { 'Texture Path'?: string } | undefined): Promise<Pixels | undefined> => {
    const path = entry?.['Texture Path'];
    if (typeof path !== 'string' || !/[\\/]/.test(path)) return undefined;
    if (!/\.tga$/i.test(path)) {
      const texture = await map(entry);
      return texture && decode(texture);
    }
    const url = new URL(path.replace(/\\/g, '/'), base).href;
    let loading = targas.get(url);
    if (!loading) {
      loading = (async () => {
        signal?.throwIfAborted();
        const bytes = await read(url, signal);
        return bytes && (parseTGA(bytes) as Pixels);
      })();
      targas.set(url, loading);
    }
    return loading;
  };
  async function finish({ out }: MaterialRead): Promise<void> {
    const cc = materials.get(String(out.name ?? ''));
    if (!cc) return;
    const shader = cc['Custom Shader']?.['Shader Name'],
      variables = cc['Custom Shader']?.Variable ?? {},
      textures = cc.Textures ?? {};
    if (cc['Two Side'] === true) out.doubleSided = true;
    if (shader === 'RLEyeOcclusion') return occlusion(out, variables);
    if (shader === 'RLEyeTearline') return tearLine(out, variables);
    const strength = (name: string) => unit(num(textures[name]?.Strength, 100) / 100);
    const [rough, metal, ao, normal] = await Promise.all(
      ['Roughness', 'Metallic', 'AO', 'Normal'].map((name) => map(textures[name])),
    );
    const micro = await microRoughness(cc, variables, map, variances, picture);
    if (rough || metal || micro) {
      out.metallicRoughnessTexture = await pack(
        String(out.name),
        rough && decode(rough),
        metal && decode(metal),
        out,
        micro,
      );
      out.roughness = 1;
      out.metalness = 1;
    }
    if (ao && !out.occlusionTexture) {
      out.occlusionTexture = ao;
      out.occlusionStrength = strength('AO');
    }
    if (normal && !out.normalTexture) {
      out.normalTexture = normal;
      out.normalScale = strength('Normal');
    }
    out.extras = { ...out.extras, characterCreator: { shader: shader ?? 'Pbr' } };
  }
  // The eye occlusion shells' top shadow starts at the lid margin the head's skin leaves visible (eye-margin.ts).
  function scene(ctx: SceneContext): boolean {
    const shaderOf = (mesh: MeshBinding) => {
      const source = (ctx.incoming.get(id(mesh.model.properties[0])) ?? [])
        .map((c) => (c.kind === 'OO' ? ctx.document.objects.get(c.child) : undefined))
        .filter((n) => n?.name === 'Material')[mesh.materialIndex];
      return source && materials.get(objectName(source))?.['Custom Shader']?.['Shader Name'];
    };
    const shells: MeshBinding[] = [],
      heads: MeshBinding[] = [];
    for (const mesh of ctx.meshes) {
      if (mesh.materialIndex < 0) continue;
      const shader = shaderOf(mesh);
      if (shader === 'RLEyeOcclusion') shells.push(mesh);
      else if (shader === 'RLHead') heads.push(mesh);
    }
    if (!shells.length || !heads.length) return false;
    const world = worlds(ctx.roots),
      place = (mesh: MeshBinding) => {
        const m = world.get(mesh.node),
          p = mesh.geometry.positions,
          out = new Float64Array(p.length);
        for (let i = 0; i < p.length; i += 3)
          out.set(m ? transformPoint(m, p[i], p[i + 1], p[i + 2]) : [p[i], p[i + 1], p[i + 2]], i);
        return out;
      };
    // The head's skin as one triangle list, and its centre: the face is in front of it.
    const parts = heads.map((mesh) => ({ positions: place(mesh), indices: mesh.geometry.indices })),
      positions = new Float64Array(parts.reduce((n, p) => n + p.positions.length, 0)),
      indices: number[] = [],
      centre = [0, 0, 0];
    let offset = 0;
    for (const part of parts) {
      positions.set(part.positions, offset * 3);
      const count = part.positions.length / 3;
      if (part.indices) for (let i = 0; i < part.indices.length; i++) indices.push(part.indices[i] + offset);
      else for (let i = 0; i < count; i++) indices.push(i + offset);
      offset += count;
    }
    for (let i = 0; i < positions.length; i++) centre[i % 3] += (3 * positions[i]) / positions.length;
    const skin = { positions, indices };
    for (const mesh of shells) {
      const uvs = mesh.geometry.uvs;
      if (!uvs) continue;
      const p = place(mesh),
        idx = mesh.geometry.indices,
        count = idx ? idx.length : p.length / 3,
        front = [0, 0, 0],
        middle = [0, 0, 0];
      // Out of the face: the shell's area-weighted normal, turned away from the head's centre.
      for (let t = 0; t + 2 < count; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => 3 * (idx ? idx[t + k] : t + k)),
          e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
          e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        front[0] += e1[1] * e2[2] - e1[2] * e2[1];
        front[1] += e1[2] * e2[0] - e1[0] * e2[2];
        front[2] += e1[0] * e2[1] - e1[1] * e2[0];
      }
      for (let i = 0; i < p.length; i++) middle[i % 3] += (3 * p[i]) / p.length;
      const away = front.reduce((s, f, k) => s + f * (middle[k] - centre[k]), 0) < 0 ? -1 : 1;
      const anchored = anchorLidShadow(
        { positions: p, indices: idx, uvs },
        skin,
        front.map((f) => f * away),
      );
      if (anchored) mesh.geometry.uvs = anchored.uvs;
    }
    return false;
  }
  return { name: 'character-creator', material: finish, scene } as ExtensionHooks;
}

/** Every node's world matrix, column-major, from the roots down. */
function worlds(roots: readonly ExportNode[]): Map<ExportNode, Float64Array> {
  const out = new Map<ExportNode, Float64Array>(),
    walk = (node: ExportNode, parent: Float64Array) => {
      const local = node.matrix
        ? Float64Array.from(node.matrix)
        : composeTRS(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
      const m = multiply(parent, local);
      out.set(node, m);
      for (const child of node.children ?? []) walk(child, m);
    };
  for (const root of roots) walk(root, composeTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
  return out;
}

/** The region masks of Character Creator's skin shaders and the region each channel, red to alpha, stands for. */
const REGIONS: Record<string, readonly (readonly [string, readonly string[]])[]> = {
  RLHead: [
    ['Nose Mouth UpperInnerLid Mask', ['Nose', 'Mouth', 'UpperLid', 'InnerLid']],
    ['Cheek Fore UpperLip Chin Mask', ['Cheek', 'Forehead', 'UpperLip', 'Chin']],
    ['Ear Neck Mask', ['Ear', 'Neck']],
  ],
  RLSkin: [['RGBA Area Mask', ['R Channel', 'G Channel', 'B Channel', 'A Channel']]],
};
/** A channel of an image at u, v (0 to 1, v down), 0 to 1, the nearest texel. */
const sample = (p: Pixels, u: number, v: number, channel: number): number => {
  const step = p.data.length / (p.width * p.height);
  return (
    p.data[
      (Math.min(p.height - 1, Math.max(0, (v * p.height) | 0)) * p.width +
        Math.min(p.width - 1, Math.max(0, (u * p.width) | 0))) *
        step +
        Math.min(step - 1, channel)
    ] / 255
  );
};
/** Roughness, 0 to 1, at a point (u, v in 0 to 1) of the material, from the roughness `r` of the map there. */
type Roughen = (r: number, u: number, v: number) => number;
/**
 * The variance of the slopes of a tangent-space normal map at strength 1, sigma_x^2 + sigma_y^2 of (x / z, y / z) over
 * every texel: what the map adds to alpha^2 once it is far below a pixel (Olano and Baker 2010).
 */
export function microNormalVariance(image: Pixels): number {
  const step = image.data.length / (image.width * image.height);
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    n = 0;
  for (let i = 0; i < image.data.length; i += step) {
    const x = (image.data[i] / 255) * 2 - 1,
      y = (image.data[i + 1] / 255) * 2 - 1,
      z = Math.sqrt(Math.max(1e-4, 1 - x * x - y * y)),
      a = x / z,
      b = y / z;
    sx += a;
    sy += b;
    sxx += a * a;
    syy += b * b;
    n++;
  }
  return n ? Math.max(0, sxx / n - (sx / n) ** 2 + syy / n - (sy / n) ** 2) : 0;
}
/**
 * Skin's micro detail as roughness: `Micro Roughness Scale` added to the map's roughness, then the micro normal map's
 * slope variance at `MicroNormal Strength` (times its mask's red) added to alpha^2. Undefined when the material has
 * neither, so its roughness map stays as it is.
 */
async function microRoughness(
  cc: CCMaterial,
  variables: Record<string, unknown>,
  map: (entry: { 'Texture Path'?: string } | undefined) => Promise<TextureData | undefined> | undefined,
  slopeVariances: Map<TextureData, Promise<number>>,
  picture: (entry: { 'Texture Path'?: string } | undefined) => Promise<Pixels | undefined>,
): Promise<Roughen | undefined> {
  const images = cc['Custom Shader']?.Image ?? {},
    regions: { mask: Pixels; scales: number[] }[] = [],
    unmasked = num(variables['Unmasked Roughness Scale'], 0);
  for (const [image, names] of REGIONS[cc['Custom Shader']?.['Shader Name'] ?? ''] ?? []) {
    const scales = names.map((name) => num(variables[`${name} Roughness Scale`], 0)),
      mask = scales.some((k) => k) || unmasked ? await picture(images[image]) : undefined;
    if (mask) regions.push({ mask, scales });
  }
  // The regions' roughness offset at u, v: each channel's share times its scale, the uncovered share times Unmasked.
  const offset = (u: number, v: number): number => {
    let sum = 0,
      covered = 0;
    for (const { mask, scales } of regions)
      for (let c = 0; c < scales.length; c++) {
        const w = sample(mask, u, v, c);
        covered += w;
        sum += w * scales[c];
      }
    return sum + unmasked * (1 - Math.min(1, covered));
  };
  const scale = num(variables['Micro Roughness Scale'], 0),
    strength = Math.max(0, num(variables['MicroNormal Strength'], 1)),
    [normal, mask] = await Promise.all([map(images.MicroNormal), map(images.MicroNormalMask)]);
  let variance = 0;
  if (normal && strength > 0) {
    // Head and body share one micro normal map: its variance is measured once.
    let loading = slopeVariances.get(normal);
    if (!loading) {
      loading = Promise.resolve().then(() => microNormalVariance(decode(normal)));
      slopeVariances.set(normal, loading);
    }
    variance = (await loading) * strength * strength;
  }
  if (!scale && !variance && !regions.length) return undefined;
  const weights = mask && decode(mask);
  return (r, u, v) => {
    const k = weights
        ? weights.data[
            (Math.min(weights.height - 1, (v * weights.height) | 0) * weights.width +
              Math.min(weights.width - 1, (u * weights.width) | 0)) *
              (weights.data.length / (weights.width * weights.height))
          ] / 255
        : 1,
      a = unit(r + scale + (regions.length ? offset(u, v) : 0)) ** 2;
    return unit(Math.sqrt(Math.sqrt(a * a + variance * k * k)));
  };
}

/** glTF's metallic-roughness image from Character Creator's two grey maps (their red), the flat factors where one lacks. */
async function pack(
  name: string,
  rough: Pixels | undefined,
  metal: Pixels | undefined,
  out: MaterialData,
  roughen?: Roughen,
): Promise<TextureData> {
  const width = Math.max(rough?.width ?? 1, metal?.width ?? 1),
    height = Math.max(rough?.height ?? 1, metal?.height ?? 1),
    data = new Uint8Array(width * height * 4),
    at = (p: Pixels, x: number, y: number) =>
      p.data[
        (Math.min(p.height - 1, ((y * p.height) / height) | 0) * p.width +
          Math.min(p.width - 1, ((x * p.width) / width) | 0)) *
          4
      ],
    flatRough = Math.round(unit(num(out.roughness, 1)) * 255),
    flatMetal = Math.round(unit(num(out.metalness, 0)) * 255);
  for (let y = 0, i = 0; y < height; y++)
    for (let x = 0; x < width; x++, i += 4)
      data.set(
        [
          255,
          roughen
            ? Math.round(
                255 * roughen((rough ? at(rough, x, y) : flatRough) / 255, (x + 0.5) / width, (y + 0.5) / height),
              )
            : rough
              ? at(rough, x, y)
              : flatRough,
          metal ? at(metal, x, y) : flatMetal,
          255,
        ],
        i,
      );
  return { name: `${name} metallic roughness`, mimeType: 'image/png', image: await encodePNG({ width, height, data }) };
}

async function occlusion(out: MaterialData, variables: Record<string, unknown>): Promise<void> {
  const alpha = eyeOcclusionAlpha(variables);
  out.baseColorTexture = {
    name: `${out.name} lid shadow`,
    mimeType: 'image/png',
    image: await encodePNG(alpha),
    wrapS: 'clamp',
    wrapT: 'clamp',
  };
  delete out.baseColorTextureTransform;
  out.color = [1, 1, 1, 1];
  out.alphaMode = 'BLEND';
  delete out.alphaCutoff;
  out.unlit = true;
  out.extras = { ...out.extras, characterCreator: { shader: 'RLEyeOcclusion' } };
}

async function tearLine(out: MaterialData, variables: Record<string, unknown>): Promise<void> {
  // Clear water: no colour of its own, its gloss from the shader's roughness, a little of it covering so the glint shows.
  delete out.baseColorTexture;
  delete out.baseColorTextureTransform;
  out.color = [0, 0, 0, 0.15];
  out.roughness = unit(num(variables._Roughness, 0.1));
  out.metalness = 0;
  delete out.metallicRoughnessTexture;
  out.alphaMode = 'BLEND';
  delete out.alphaCutoff;
  out.extras = { ...out.extras, characterCreator: { shader: 'RLEyeTearline' } };
}
