/// <reference lib="esnext.disposable" preserve="true" />
import { margoError } from '../../shared/errors.js';
import {
  textureCoordinates,
  type TextureTransform,
  type MaterialExtension,
  type MaterialExtensionTexture,
  type PBRMaterial,
  type PBRModel,
} from '@margoengine/gltf-pro';
import { coordinateSlot } from './coordinates.js';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { Cleanup } from '../../shared/cleanup.js';
import { clearcoatShader, type ClearcoatShaderTextures } from './shader.js';
import { MaterialTextures, validateTextureInfo, type TextureInfo } from './textures.js';
import { createTransmission, validateTransmission, type TransmissionOptions } from './transmission.js';
import { acquireOpaqueColor } from './opaque-color.js';
export { acquireOpaqueColor };
import { materialLobes, validateLobes, lobeMaps, type MaterialLobeOptions } from './lobes.js';
export { materialLobes, sheen, specular, anisotropy, iridescence } from './lobes.js';
export type {
  MaterialLobeOptions,
  SheenOptions,
  SpecularOptions,
  AnisotropyOptions,
  IridescenceOptions,
} from './lobes.js';
export { transmission, type TransmissionOptions, type VolumeOptions } from './transmission.js';
export { nodeMaterial, installNodeMaterial, materialGraphOutput, NodeMaterialInstallation } from './nodes.js';
export type { MaterialGraphOutput } from './nodes.js';
export type * from './node-types.js';
export { StencilBuffer } from './stencil-buffer.js';

/** A caller-owned GPU texture view for a clearcoat or lobe map: `texCoord` is 0 to 3 (default 0), `scale` scales a normal map (default 1) and `transform` is a KHR_texture_transform. */
export interface ClearcoatTexture extends MaterialExtensionTexture {
  texCoord?: 0 | 1 | 2 | 3;
  scale?: number;
  transform?: TextureTransform;
}
/** Options for `clearcoat()`: `factor` and `roughnessFactor` from 0 to 1 (both default 0) plus optional texture maps. */
export interface ClearcoatOptions {
  factor?: number;
  roughnessFactor?: number;
  clearcoatTexture?: ClearcoatTexture;
  clearcoatRoughnessTexture?: ClearcoatTexture;
  clearcoatNormalTexture?: ClearcoatTexture;
}

function scalar(value: unknown, fallback: number, label: string, min = -Infinity, max = Infinity): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(Math.fround(n)) || n < min || n > max)
    throw new RangeError(
      `Invalid clearcoat ${label}; pass a finite number${min > -Infinity ? ` of at least ${min}` : ''}${max < Infinity ? ` and at most ${max}` : ''}.`,
    );
  return n;
}
function texture(value: ClearcoatTexture): ClearcoatTexture {
  if (
    !value ||
    typeof value !== 'object' ||
    !value.view ||
    (value.texCoord !== undefined && ![0, 1, 2, 3].includes(value.texCoord))
  )
    throw new TypeError(
      'Invalid clearcoat texture or UV set; pass a texture with a GPUTextureView in view and texCoord 0 to 3.',
    );
  if (value.sampler !== undefined && !value.sampler)
    throw new TypeError('Invalid clearcoat sampler; pass a GPUSampler or omit it.');
  textureCoordinates({ texCoord: value.texCoord, extensions: { KHR_texture_transform: value.transform } });
  scalar(value.scale, 1, 'normal scale');
  return value;
}

/** Build a clearcoat extension from caller-owned GPU texture views. No GPU allocation. */
export function clearcoat(options: ClearcoatOptions = {}): MaterialExtension {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Invalid clearcoat options; pass an options object such as { factor: 1 }.');
  const factor = scalar(options.factor, 0, 'factor', 0, 1),
    roughness = scalar(options.roughnessFactor, 0, 'roughness', 0, 1);
  const textures: MaterialExtensionTexture[] = [],
    slots: ClearcoatShaderTextures = {},
    factors = [factor, roughness, scalar(options.clearcoatNormalTexture?.scale, 1, 'normal scale'), 0];
  for (const [field, slot] of [
    ['clearcoatTexture', 'factor'],
    ['clearcoatRoughnessTexture', 'roughness'],
    ['clearcoatNormalTexture', 'normal'],
  ] as const) {
    const value = options[field];
    if (value === undefined) continue;
    texture(value);
    slots[slot] = { index: textures.length, ...coordinateSlot(value, factors), sampler: !!value.sampler };
    textures.push({ view: value.view, ...(value.sampler ? { sampler: value.sampler } : {}) });
  }
  return { ...clearcoatShader(slots), factors: new Float32Array(factors), ...(textures.length ? { textures } : {}) };
}

type CoatMap = 'clearcoatTexture' | 'clearcoatRoughnessTexture' | 'clearcoatNormalTexture';
type MapField =
  | CoatMap
  | 'transmissionTexture'
  | 'thicknessTexture'
  | 'multiscatterColorTexture'
  | (typeof lobeMaps)[keyof typeof lobeMaps][number];
/** Fields read from normalized material options or their glTF extension counterparts, validated below. */
type MaterialDefinition = Partial<Record<MapField, TextureInfo | ClearcoatTexture>> & {
  factor?: number;
  roughnessFactor?: number;
  ior?: number;
  clearcoatFactor?: number;
  clearcoatRoughnessFactor?: number;
  transmissionFactor?: number;
  dispersion?: number;
  volume?: MaterialDefinition;
  thicknessFactor?: number;
  attenuationColor?: readonly [number, number, number];
  attenuationDistance?: number;
  multiscatterColorFactor?: readonly [number, number, number];
  scatterAnisotropy?: number;
  colorFactor?: readonly [number, number, number];
  sheenColorFactor?: readonly [number, number, number];
  sheenRoughnessFactor?: number;
  specularFactor?: number;
  specularColorFactor?: readonly [number, number, number];
  strength?: number;
  rotation?: number;
  anisotropyStrength?: number;
  anisotropyRotation?: number;
  thicknessMinimum?: number;
  thicknessMaximum?: number;
  iridescenceFactor?: number;
  iridescenceIor?: number;
  iridescenceThicknessMinimum?: number;
  iridescenceThicknessMaximum?: number;
};
interface Plan {
  material: PBRMaterial;
  coat: boolean;
  factor: number;
  roughnessFactor: number;
  maps: Partial<Record<MapField, TextureInfo | ClearcoatTexture>>;
  previous?: MaterialExtension;
  extension?: MaterialExtension;
  transmission?: TransmissionOptions;
  lobes?: MaterialLobeOptions;
  opaqueIndex?: number;
}
const mapFields: readonly CoatMap[] = ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture'];
function definition(value: unknown, label: string): MaterialDefinition | undefined {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new TypeError(`Invalid ${label}; pass an object or omit it.`);
  return value as MaterialDefinition | undefined;
}

/** Owns textures installed from glTF metadata. The model retains its image blueprints. */
export class MaterialInstallation implements EnginePlugin {
  static attach(model: PBRModel): MaterialInstallation {
    return install(model);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  readonly name: string;
  disposed = false;
  private readonly plans: Plan[] = [];
  private textures?: MaterialTextures;
  private unsubscribe?: () => void;
  private capture?: ReturnType<typeof acquireOpaqueColor>;
  constructor(readonly model: PBRModel) {
    this.name = 'materials:' + model.name;
    if (model.disposed)
      throw margoError('disposed', 'Cannot install materials on a disposed model; install them on a live model.');
    for (const material of new Set(model.primitives.map((p) => p.material))) {
      const normalized = material.clearcoat !== undefined,
        def = definition(
          normalized ? material.clearcoat : material.extensions?.KHR_materials_clearcoat,
          'KHR_materials_clearcoat',
        );
      const normalizedTransmission = material.transmission !== undefined;
      const transmit = definition(
        normalizedTransmission ? material.transmission : material.extensions?.KHR_materials_transmission,
        'KHR_materials_transmission',
      );
      const dispersion = definition(material.extensions?.KHR_materials_dispersion, 'KHR_materials_dispersion');
      // The built-in physical renderer stores packed attenuation in volume; normalized extension metadata stays an object.
      const normalizedVolume = material.physical && Array.isArray(material.volume) ? undefined : material.volume;
      const volume = definition(
        normalizedVolume !== undefined
          ? normalizedVolume
          : transmit?.volume !== undefined
            ? transmit.volume
            : material.extensions?.KHR_materials_volume,
        'KHR_materials_volume',
      );
      const scatter = definition(
        volume?.multiscatterColorFactor !== undefined
          ? volume
          : material.extensions?.KHR_materials_volume_scatter,
        'KHR_materials_volume_scatter',
      );
      const lobeOptions: MaterialLobeOptions = {},
        lobeTextures: Partial<Record<MapField, TextureInfo | ClearcoatTexture>> = {};
      for (const key of Object.keys(lobeMaps) as (keyof typeof lobeMaps)[]) {
        const normalized = material[key] !== undefined,
          value = definition(
            normalized ? material[key] : material.extensions?.['KHR_materials_' + key],
            'KHR_materials_' + key,
          );
        if (value === undefined) continue;
        if (key === 'sheen')
          lobeOptions.sheen = {
            colorFactor: normalized ? value.colorFactor : value.sheenColorFactor,
            roughnessFactor: normalized ? value.roughnessFactor : value.sheenRoughnessFactor,
          };
        else if (key === 'specular')
          lobeOptions.specular = {
            factor: normalized ? value.factor : value.specularFactor,
            colorFactor: normalized ? value.colorFactor : value.specularColorFactor,
          };
        else if (key === 'anisotropy')
          lobeOptions.anisotropy = {
            strength: normalized ? value.strength : value.anisotropyStrength,
            rotation: normalized ? value.rotation : value.anisotropyRotation,
          };
        else
          lobeOptions.iridescence = {
            factor: normalized ? value.factor : value.iridescenceFactor,
            ior: normalized ? value.ior : value.iridescenceIor,
            thicknessMinimum: normalized ? value.thicknessMinimum : value.iridescenceThicknessMinimum,
            thicknessMaximum: normalized ? value.thicknessMaximum : value.iridescenceThicknessMaximum,
          };
        for (const field of lobeMaps[key]) if (value[field] !== undefined) lobeTextures[field] = value[field];
      }
      const hasLobes = Object.keys(lobeOptions).length > 0;
      if (def === undefined && transmit === undefined && volume === undefined && dispersion === undefined && !hasLobes)
        continue;
      const iorDef = definition(material.extensions?.KHR_materials_ior, 'KHR_materials_ior');
      if (hasLobes) {
        if (
          material.extensions?.KHR_materials_unlit !== undefined ||
          material.extensions?.KHR_materials_pbrSpecularGlossiness !== undefined
        )
          throw margoError(
            'state',
            'Material lobes require metallic-roughness lighting; remove KHR_materials_unlit and pbrSpecularGlossiness from the material.',
          );
        lobeOptions.ior = transmit?.ior ?? (material.ior as number | undefined) ?? iorDef?.ior;
        validateLobes(lobeOptions);
      }
      const transmissionOptions: TransmissionOptions = {
        factor: transmit ? (normalizedTransmission ? transmit.factor : transmit.transmissionFactor) : 0,
        ior: transmit?.ior ?? (material.ior as number | undefined) ?? iorDef?.ior,
        dispersion: dispersion !== undefined ? dispersion.dispersion : (material.dispersion as number | undefined),
        ...(volume !== undefined
          ? {
              volume: {
                thicknessFactor: volume.thicknessFactor,
                attenuationColor: volume.attenuationColor,
                attenuationDistance: volume.attenuationDistance,
                multiscatterColorFactor: scatter?.multiscatterColorFactor,
                scatterAnisotropy: scatter?.scatterAnisotropy,
              },
            }
          : {}),
      };
      const transmitted = validateTransmission(transmissionOptions);
      if (def === undefined && transmitted.factor === 0 && !hasLobes) continue;
      const primitives = model.primitives.filter((p) => p.material === material);
      const plan: Plan = {
        material,
        coat: def !== undefined,
        factor: scalar(normalized ? def?.factor : def?.clearcoatFactor, 0, 'factor', 0, 1),
        roughnessFactor: scalar(
          normalized ? def?.roughnessFactor : def?.clearcoatRoughnessFactor,
          0,
          'roughness',
          0,
          1,
        ),
        maps: {},
        previous: material.extension,
        ...(hasLobes ? { lobes: lobeOptions } : {}),
        ...(transmitted.factor > 0 ? { transmission: transmissionOptions } : {}),
      };
      const maps: Partial<Record<MapField, TextureInfo | ClearcoatTexture>> = { ...lobeTextures };
      for (const field of mapFields) if (def?.[field] !== undefined) maps[field] = def[field];
      if (plan.transmission) {
        maps.transmissionTexture = transmit?.transmissionTexture;
        maps.thicknessTexture = volume?.thicknessTexture;
        maps.multiscatterColorTexture = scatter?.multiscatterColorTexture;
      }
      for (const field of Object.keys(maps) as MapField[])
        if (maps[field] !== undefined) {
          const value = maps[field],
            map: TextureInfo | ClearcoatTexture =
              value && 'view' in value && value.view ? texture(value) : validateTextureInfo(value, model);
          const coord =
            'view' in map
              ? textureCoordinates({ texCoord: map.texCoord, extensions: { KHR_texture_transform: map.transform } })
                  .texCoord
              : (map.texCoord ?? 0);
          if (
            primitives.some(
              (p) =>
                !p.extension &&
                ((coord > 1 && !p.uvs) ||
                  (p.definition.attributes && p.definition.attributes['TEXCOORD_' + coord] === undefined)),
            )
          )
            throw margoError(
              'state',
              `Material texture requires available TEXCOORD_${coord}; add that UV set to the primitive or point the texture at another texCoord.`,
            );
          plan.maps[field] = map;
        }
      this.plans.push(plan);
    }
  }
  setup(engine: Engine): void {
    if (this.disposed || this.model.disposed || engine !== this.model.root.engine)
      throw margoError(
        this.disposed || this.model.disposed ? 'disposed' : 'attached',
        'Materials model is disposed or belongs to another engine; install materials on a live model of the engine you attach to.',
      );
    if (!engine.gpu)
      throw margoError('unsupported', 'Materials require WebGPU: create the engine with a WebGPU device');
    const textures = new MaterialTextures(this.model, engine.gpu);
    try {
      if (this.plans.some((plan) => plan.transmission) && !this.capture)
        this.capture = acquireOpaqueColor(engine, (view) => {
          for (const plan of this.plans)
            if (plan.opaqueIndex !== undefined && plan.extension?.textures)
              plan.extension.textures[plan.opaqueIndex].view = view;
        });
      const ready = this.plans
        .filter((plan) => !plan.extension || plan.material.extension === plan.extension)
        .map((plan) => {
          const options: ClearcoatOptions = { factor: plan.factor, roughnessFactor: plan.roughnessFactor };
          const resolved: Partial<Record<MapField, ClearcoatTexture>> = {};
          for (const field of Object.keys(plan.maps) as MapField[]) {
            const map = plan.maps[field];
            if (map)
              resolved[field] =
                'view' in map
                  ? map
                  : textures.resolve(
                      map,
                      field === 'sheenColorTexture' ||
                        field === 'specularColorTexture' ||
                        field === 'multiscatterColorTexture',
                    );
          }
          for (const field of mapFields) options[field] = resolved[field];
          const coat = plan.coat ? clearcoat(options) : undefined;
          plan.opaqueIndex = plan.transmission ? (coat?.textures?.length ?? 0) : undefined;
          // Transmission first, so lobes composed over it know the surface transmits (lobeShader `transmits`).
          let extension = plan.transmission
            ? createTransmission(
                {
                  ...plan.transmission,
                  opaqueColor: this.capture!.view,
                  transmissionTexture: resolved.transmissionTexture,
                  ...(plan.transmission.volume
                    ? {
                        volume: {
                          ...plan.transmission.volume,
                          thicknessTexture: resolved.thicknessTexture,
                          multiscatterColorTexture: resolved.multiscatterColorTexture,
                        },
                      }
                    : {}),
                },
                coat,
              )
            : coat;
          if (plan.lobes) {
            const lobes: MaterialLobeOptions = { ...plan.lobes };
            for (const key of Object.keys(lobeMaps) as (keyof typeof lobeMaps)[])
              if (lobes[key]) {
                const value = { ...lobes[key] };
                for (const field of lobeMaps[key])
                  if (resolved[field]) Object.assign(value, { [field]: resolved[field] });
                Object.assign(lobes, { [key]: value });
              }
            extension = materialLobes(lobes, extension);
          }
          if (plan.extension?.factors) extension!.factors = plan.extension.factors;
          return { plan, extension: extension! };
        });
      for (const { plan, extension } of ready) {
        extension.replacesPhysical = true;
        plan.extension = extension;
        plan.material.extension = extension;
      }
      this.textures = textures;
      this.unsubscribe ??= this.model.onDispose(() => this.destroy());
    } catch (error) {
      const cleanup = new Cleanup(error);
      cleanup.run(() => textures.dispose()).run(() => this.capture?.release());
      this.capture = undefined;
      cleanup.finish();
    }
  }
  onDeviceRestored(engine: Engine): void {
    this.textures?.dispose();
    this.textures = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanup = new Cleanup();
    cleanup.run(() => this.model.root.engine.removePlugin(this.name));
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const plan of this.plans)
      if (plan.extension && plan.material.extension === plan.extension) {
        plan.material.extension = plan.previous;
      }
    cleanup.run(() => this.textures?.dispose()).run(() => this.capture?.release());
    this.textures = undefined;
    this.capture = undefined;
    cleanup.finish();
  }
  destroy(): void {
    this.dispose();
  }
}

/** Explicit opt-in after loadGLTF/parseGLTF; absent material metadata allocates nothing. */
export function install(model: PBRModel): MaterialInstallation {
  const installation = new MaterialInstallation(model);
  model.root.engine.use(installation);
  return installation;
}

// Mesh materials and imported glTF extensions share the same PBR renderer.
export * from './built-material.js';
export * from './material-classes.js';
export * from './tile-animation.js';
export * from './wgsl-material.js';
export { toonModel, ToonModel, type ToonModelOptions } from './toon.js';
