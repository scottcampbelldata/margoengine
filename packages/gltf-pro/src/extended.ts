import { extendedPlan, extendedShader } from './shader.js';
import { scatterExtinction } from '../../shared/volume-scatter.js';
import type { GLTFExtendedMaterials } from './asset.js';
export type { ExtendedPlan } from './shader.js';
export type { GLTFExtendedMaterials } from './asset.js';

const number = (value: unknown, fallback: number, min: number, max: number, label: string): number => {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || v < min || v > max)
    throw new TypeError('Invalid glTF ' + label + '; re-export the file and check it with the glTF Validator');
  return v;
};

/**
 * KHR_materials_iridescence, KHR_materials_anisotropy, KHR_materials_diffuse_transmission, EXT_materials_bump (draft)
 * and KHR_materials_volume_scatter (draft)
 * for gltf-pro, passed like a decoder: `loadGLTF(engine, url, {decoders: {materials: extendedMaterials}})` (also parseGLTF, parseGLTFAsync, the worker
 * and progressive loaders). Without it gltf-pro ignores those extensions (a file that requires one is rejected), so apps
 * that never load them ship none of this WGSL. README "Extended materials".
 */
export const extendedMaterials: GLTFExtendedMaterials = {
  parse(e) {
    const ir = e.KHR_materials_iridescence,
      an = e.KHR_materials_anisotropy,
      dt = e.KHR_materials_diffuse_transmission,
      bu = e.EXT_materials_bump,
      vo = e.KHR_materials_volume,
      sc = e.KHR_materials_volume_scatter;
    const iridescence = number(ir?.iridescenceFactor, 0, 0, 1, 'iridescence'),
      anisotropy = number(an?.anisotropyStrength, 0, 0, 1, 'anisotropy strength');
    const diffuse = number(dt?.diffuseTransmissionFactor, 0, 0, 1, 'diffuse transmission');
    // Height times the factor: with no texture the height is one value, whose gradient is 0, so no bump.
    const height = number(bu?.bumpFactor, 1, -Infinity, Infinity, 'bump factor'),
      bump = !!bu?.bumpTexture && height !== 0;
    if (bu?.heightSpace !== undefined && bu.heightSpace !== 'world' && bu.heightSpace !== 'object')
      throw new TypeError(
        'Invalid glTF bump height space; use "world" or "object", re-export the file and check it with the glTF Validator',
      );
    const multiscatter = sc?.multiscatterColorFactor ?? [0, 0, 0],
      // gltf-pro checked the volume's values before this runs.
      scatterDistance: number = vo?.attenuationDistance ?? Infinity,
      thickness: number = vo?.thicknessFactor ?? 0,
      attenuation: number[] = vo?.attenuationColor ?? [1, 1, 1];
    if (!Array.isArray(multiscatter) || multiscatter.length !== 3)
      throw new TypeError(
        'Invalid glTF multi-scatter color; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    const scatterColor = multiscatter.map((c: unknown) => number(c, 0, 0, 1, 'multi-scatter color')),
      extinction = attenuation.map((c) => scatterExtinction(c, scatterDistance)),
      // Light must enter the volume (either transmission) and meet a medium for any of it to scatter.
      scatter =
        !!sc &&
        scatterColor.some((c) => c > 0) &&
        thickness > 0 &&
        extinction.some((c) => c > 0) &&
        (!!diffuse || !!e.KHR_materials_transmission?.transmissionFactor);
    if (!iridescence && !anisotropy && !diffuse && !bump && !scatter) return undefined;
    const color = dt?.diffuseTransmissionColorFactor ?? [1, 1, 1],
      rotation = number(an?.anisotropyRotation, 0, -Infinity, Infinity, 'anisotropy rotation');
    if (!Array.isArray(color) || color.length !== 3)
      throw new TypeError(
        'Invalid glTF diffuse transmission color; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    return {
      features: { iridescence: !!iridescence, anisotropy: !!anisotropy, diffuseTransmission: !!diffuse, bump, scatter },
      // Slots 13-20; an extension whose factor is 0 binds nothing.
      maps: [
        iridescence ? ir!.iridescenceTexture : undefined,
        iridescence ? ir!.iridescenceThicknessTexture : undefined,
        anisotropy ? an!.anisotropyTexture : undefined,
        diffuse ? dt!.diffuseTransmissionTexture : undefined,
        diffuse ? dt!.diffuseTransmissionColorTexture : undefined,
        bump ? bu!.bumpTexture : undefined,
        scatter ? sc!.multiscatterColorTexture : undefined,
        scatter ? vo!.thicknessTexture : undefined,
      ],
      // Rows iri (factor, film IOR, thickness min, max in nm), aniso (strength, cos and sin of the rotation), dtr (factor,
      // colour), bump (factor, 1 for heights in the node's space), scatter (multi-scatter colour, anisotropy), extinction
      // (per world unit, thickness).
      rows: [
        iridescence,
        number(ir?.iridescenceIor, 1.3, 1, Infinity, 'iridescence IOR'),
        number(ir?.iridescenceThicknessMinimum, 100, 0, Infinity, 'iridescence thickness'),
        number(ir?.iridescenceThicknessMaximum, 400, 0, Infinity, 'iridescence thickness'),
        anisotropy,
        Math.cos(rotation),
        Math.sin(rotation),
        0,
        diffuse,
        ...color.map((c: unknown) => number(c, 0, 0, 1, 'diffuse transmission color')),
        height,
        +(bu?.heightSpace === 'object'),
        0,
        0,
        ...scatterColor,
        number(sc?.scatterAnisotropy, 0, -1, 1, 'scatter anisotropy'),
        ...extinction,
        thickness,
      ],
    };
  },
  plan: extendedPlan,
  shader: extendedShader,
};
