import type { GLTFMaterial, GLTFTextureInfo } from '../../shared/gltf.js';
import type { GLTFExtendedMaterials } from './asset.js';
import { extendedMaterials } from './extended.js';
import { extendedPlan, extendedShader } from './shader.js';
import { textureCoordinates } from './texture-coordinates.js';
import { margoError } from '../../shared/errors.js';

const name = 'KHR_materials_pbrSpecularGlossiness';
const unit = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
    throw new TypeError(`Invalid glTF spec/gloss ${label}; pass a finite number from 0 to 1`);
  return v;
};
const vector = (v: unknown, size: number, label: string): number[] => {
  if (!Array.isArray(v) || v.length !== size || Array.from(v).some((n) => typeof n !== 'number'))
    throw new TypeError(`Invalid glTF spec/gloss ${label}; pass ${size} finite components from 0 to 1`);
  return Array.from(v, (n) => unit(n, label));
};
const texture = (v: unknown): GLTFTextureInfo | undefined => {
  if (v === undefined) return undefined;
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    !Number.isSafeInteger((v as GLTFTextureInfo).index) ||
    (v as GLTFTextureInfo).index < 0
  )
    throw new TypeError('Invalid glTF spec/gloss texture; pass a textureInfo with a nonnegative integer index');
  textureCoordinates(v as GLTFTextureInfo);
  return v as GLTFTextureInfo;
};

/** Metal/rough factors derived from one linear-light spec/gloss sample. */
export interface MetalRoughSample {
  /** Linear RGBA; opacity is copied from diffuse alpha. */
  readonly baseColor: readonly number[];
  readonly metallic: number;
  readonly roughness: number;
}
/**
 * Converts linear diffuse RGBA, specular RGB and glossiness to metal/rough. Defaults are the extension's white/white/1.
 * Conversion is an approximation for nonphysical spec/gloss colours; saturated endpoints remain finite.
 */
export function specGlossToMetalRough(
  diffuse: readonly number[] = [1, 1, 1, 1],
  specular: readonly number[] = [1, 1, 1],
  glossiness = 1,
): MetalRoughSample {
  const d = vector(diffuse, 4, 'diffuse'),
    s = vector(specular, 3, 'specular');
  const brightness = (v: number[]) => Math.sqrt(0.299 * v[0] ** 2 + 0.587 * v[1] ** 2 + 0.114 * v[2] ** 2);
  const ds = brightness(d),
    ss = brightness(s),
    share = 1 - Math.max(...s);
  // Equate dielectric diffuse energy and metal/dielectric F0, then solve the resulting quadratic in metalness.
  const b = (ds * share) / 0.96 + ss - 0.08;
  const metallic = ss < 0.04 ? 0 : Math.min(1, Math.max(0, (-b + Math.sqrt(b * b - 0.16 * (0.04 - ss))) / 0.08));
  const baseColor = s.map((c, i) => {
    const fromDiffuse = (d[i] * share) / (0.96 * Math.max(1 - metallic, 1e-6));
    const fromSpecular = (c - 0.04 * (1 - metallic)) / Math.max(metallic, 1e-6);
    return Math.min(1, Math.max(0, fromDiffuse * (1 - metallic * metallic) + fromSpecular * metallic * metallic));
  });
  return { baseColor: [...baseColor, d[3]], metallic, roughness: 1 - unit(glossiness, 'glossiness') };
}

/** Converts the authored factors/map routing without changing the input document or baking mismatched UV sets. */
export function convertSpecGlossMaterial(material: GLTFMaterial): GLTFMaterial {
  const extension = material.extensions?.[name];
  if (extension === undefined) return material;
  if (!extension || typeof extension !== 'object' || Array.isArray(extension))
    throw new TypeError('Invalid glTF spec/gloss extension; pass a material extension object');
  const e = extension as Record<string, unknown>;
  const diffuse = vector(e.diffuseFactor === undefined ? [1, 1, 1, 1] : e.diffuseFactor, 4, 'diffuse');
  const specular = vector(e.specularFactor === undefined ? [1, 1, 1] : e.specularFactor, 3, 'specular');
  const gloss = unit(e.glossinessFactor === undefined ? 1 : e.glossinessFactor, 'glossiness');
  return {
    ...material,
    pbrMetallicRoughness: {
      baseColorFactor: diffuse,
      baseColorTexture: texture(e.diffuseTexture),
      // Kept as gloss in the uniform; the optional fragment converts after texture filtering.
      roughnessFactor: gloss,
      metallicFactor: 0,
    },
    extensions: {
      ...material.extensions,
      KHR_materials_specular: {
        specularColorFactor: specular.map((c) => c * 25),
        specularColorTexture: texture(e.specularGlossinessTexture),
      },
      KHR_materials_ior: { ior: 1.5 },
    },
  };
}

const conversionWGSL = `
fn margoSpecGloss(d:vec3f,s:vec3f)->vec4f {
  let weights=vec3f(0.299,0.587,0.114);
  let db=sqrt(dot(d*d,weights)); let sb=sqrt(dot(s*s,weights));
  let share=1-max(s.r,max(s.g,s.b)); let qb=db*share/0.96+sb-0.08;
  let metal=select(clamp((-qb+sqrt(max(0.0,qb*qb-0.16*(0.04-sb))))/0.08,0.0,1.0),0.0,sb<0.04);
  let bd=d*share/(0.96*max(1-metal,0.000001));
  let bs=(s-vec3f(0.04*(1-metal)))/max(metal,0.000001);
  return vec4f(clamp(mix(bd,bs,metal*metal),vec3f(0),vec3f(1)),metal);
}
`;

/**
 * Optional reader for loadGLTF/parseGLTFAsync (selected automatically) and synchronous parseGLTF's materials hook.
 * Retains per-map UV sets, transforms, filters, alpha, normal/occlusion/emission maps and material variants.
 */
export const specGlossMaterials: GLTFExtendedMaterials = {
  extensions: [name],
  convert: convertSpecGlossMaterial,
  parse(e) {
    const parsed = extendedMaterials.parse(e);
    if (e[name] === undefined) return parsed;
    return {
      features: {
        iridescence: false,
        anisotropy: false,
        diffuseTransmission: false,
        ...parsed?.features,
        specularGlossiness: true,
      },
      maps: parsed?.maps ?? Array(8).fill(undefined),
      rows: parsed?.rows ?? Array(24).fill(0),
    };
  },
  plan: extendedPlan,
  shader(plan) {
    const shader = extendedShader(plan);
    if (!plan.specularGlossiness) return shader;
    const j = plan.slots[12];
    const sample = j >= 0 ? `textureSample(margoMap${j},margoSampler${j},uv(i,12)).a` : '1.0';
    const anchor = '  return s;';
    if (shader.split(anchor).length !== 2)
      throw margoError('failed', 'Spec/gloss surface conversion anchor changed; update the optional material shader');
    return (
      conversionWGSL +
      shader.replace(
        anchor,
        `
  if(f.ext.x<0.5){
    let converted=margoSpecGloss(s.base.rgb,s.f0);
    s.base=vec4f(converted.rgb,s.base.a); s.metal=converted.a;
    s.roughness=clamp(1-f.factors.x*${sample},0.045,1.0);
    s.f0=vec3f(0.04); s.sw=1;
  }
${anchor}`,
      )
    );
  },
};
