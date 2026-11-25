// Optional material features (skin(), hair(), eye(), alphaHash(), a custom MaterialFeature) on a loaded glTF model,
// picked by glTF material name. A materials mesh lists them in `Material.features`, whose record hands them to gltf/pbr
// through its shading hook (built-material.ts MaterialShading); a loaded model's own material records have no hook, so
// `install(model, {features})` gives each named record one that runs the features over gltf/pbr's shader, in list
// order, after any hook the record already had. The record keeps its colours, factors, maps and alpha mode, live, and
// skinned, morphed and instanced primitives keep their deformation: the features edit the fragment's lighting and the
// vertex stage's outputs, never the vertex positions. dispose() puts the records' own hooks back.
// Names, alpha modes and skinning as glTF 2.0 defines them (Khronos, "glTF 2.0 Specification", 2021, sections 3.9.4
// alpha coverage and 3.7.3 skins: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
import type { PBRMaterial, PBRMaterialShading, PBRModel } from '@margoengine/gltf/pbr-model';
import type { Engine } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
import type { Material, MaterialFeature } from './built-material.js';

/** Features per glTF material name, as `Material.features` takes them: one feature of each kind, run in list order. */
export type ModelFeatures = Readonly<Record<string, readonly MaterialFeature[]>>;

/**
 * What a feature's hooks receive as their `material` on a loaded model: the glTF material `record` and its alpha cut-out.
 * `alphaTest` reads the MASK cutoff (0 for OPAQUE and BLEND); setting it above 0 on an OPAQUE material makes it MASK
 * with that cutoff, and 0 makes a MASK material OPAQUE again (`alphaHash()` raises and restores it so).
 */
export interface ModelFeatureMaterial {
  readonly record: PBRMaterial;
  alphaTest: number;
}

const owned = new WeakSet<PBRMaterialShading>();
function standIn(record: PBRMaterial): ModelFeatureMaterial {
  // The OPAQUE material's own cutoff while a feature has made it MASK, put back when it is OPAQUE again.
  let saved: number | undefined;
  return {
    record,
    get alphaTest() {
      return record.settings[0] === 1 ? record.settings[1] : 0;
    },
    set alphaTest(v: number) {
      if (typeof v !== 'number' || !(v >= 0) || !Number.isFinite(v))
        throw new RangeError('Model feature alphaTest must be a finite number from 0 up; pass a cutoff such as 0.5');
      if (v > 0) {
        if (record.settings[0] === 0) {
          saved = record.settings[1];
          record.settings[0] = 1;
        }
        if (record.settings[0] === 1) record.settings[1] = v;
      } else if (record.settings[0] === 1) {
        record.settings[0] = 0;
        if (saved !== undefined) record.settings[1] = saved;
        saved = undefined;
      }
    },
  };
}

/** gltf/pbr's shading hook for one record: the record's previous hook, then each feature. */
class FeatureShading implements PBRMaterialShading {
  readonly material: Material;
  constructor(
    readonly features: readonly MaterialFeature[],
    readonly previous: PBRMaterialShading | undefined,
    readonly record: PBRMaterial,
    private readonly engine: Engine,
  ) {
    this.material = standIn(record) as unknown as Material;
    owned.add(this);
  }
  get replacesTextures(): boolean {
    return !!this.previous?.replacesTextures;
  }
  get texturedTint(): boolean {
    return !!this.previous?.texturedTint;
  }
  /** A feature's text is fixed when it is made, so the composed text changes only with the previous hook's. */
  get shaderRevision(): number {
    return this.previous ? (this.previous.shaderRevision ?? Number.NaN) : 1;
  }
  /** Unknown (each draw reads the record) when a feature binds anything, as an eye's live pupil; else the previous hook's. */
  get version(): number | undefined {
    return this.features.some((v) => v.bindings) ? Number.NaN : this.previous?.version;
  }
  shader(code: string, group: number): string {
    let text = this.previous?.shader ? this.previous.shader(code, group) : code;
    for (const v of this.features) text = v.shader(text, group, this.material);
    return text;
  }
  lit(code: string): string {
    let text = this.previous?.lit ? this.previous.lit(code) : code;
    for (const v of this.features) if (v.lit) text = v.lit(text, this.material);
    return text;
  }
  bindings(): GPUBindGroupEntry[] {
    const own = this.previous?.bindings() ?? [],
      device = this.engine.gpu;
    if (!device) return own;
    return [...own, ...this.features.flatMap((v) => v.bindings?.(device, this.engine, this.material) ?? [])];
  }
}

/** One record's features and what they replaced, for `restore`. */
export interface FeaturePlan {
  record: PBRMaterial;
  shading: FeatureShading;
  hadShading: boolean;
  castHashed: PBRMaterial['castHashed'];
  hadCastHashed: boolean;
}

/** Checks `features` against `model` and gives each named record its hook; throws, changing nothing, on a bad input. */
export function applyModelFeatures(model: PBRModel, features: ModelFeatures | undefined): FeaturePlan[] {
  if (features === undefined) return [];
  if (!features || typeof features !== 'object' || Array.isArray(features))
    throw new TypeError(
      'Invalid model features; pass an object of glTF material names to feature lists, such as { Skin: [skin()] }.',
    );
  const records = [...new Set(model.primitives.map((p) => p.material))],
    names = records.map((r) => r.name).filter((n): n is string => typeof n === 'string');
  const chosen: [PBRMaterial, readonly MaterialFeature[]][] = [];
  for (const [name, list] of Object.entries(features)) {
    if (!Array.isArray(list) || list.some((v) => !v || typeof v.name !== 'string' || typeof v.shader !== 'function'))
      throw new TypeError(
        `Model features for material "${name}" must be an array of features; pass [skin()] or other MaterialFeature objects.`,
      );
    const kinds = list.map((v) => v.name);
    if (new Set(kinds).size !== kinds.length)
      throw new TypeError(`Model features for material "${name}" hold two of one kind; list each feature once.`);
    const matching = records.filter((r) => r.name === name);
    if (!matching.length)
      throw new RangeError(
        `The model has no material named "${name}"; its materials are ${names.length ? names.map((n) => `"${n}"`).join(', ') : 'unnamed'}.`,
      );
    for (const record of matching) {
      if (Object.hasOwn(record, 'extendedFrame'))
        throw new TypeError(
          "Model features are for loaded glTF models; list a materials mesh's features in its Material.features.",
        );
      if (record.shading && owned.has(record.shading))
        throw margoError(
          'state',
          `Material "${name}" already has model features; dispose the installation that added them first.`,
        );
      if (list.length) chosen.push([record, list]);
    }
  }
  const engine = model.root.engine;
  return chosen.map(([record, list]) => {
    const shading = new FeatureShading(Object.freeze(list.slice()), record.shading, record, engine),
      hashed = list.find((v) => v.castHashed)?.castHashed,
      plan: FeaturePlan = {
        record,
        shading,
        hadShading: Object.hasOwn(record, 'shading'),
        castHashed: record.castHashed,
        hadCastHashed: Object.hasOwn(record, 'castHashed'),
      };
    record.shading = shading;
    if (hashed) record.castHashed = hashed;
    for (const v of list) v.attach?.(shading.material);
    return plan;
  });
}

/** Gives each record of `plans` back its own hook and shadow cut, and lets the features go. */
export function restoreModelFeatures(plans: readonly FeaturePlan[]): void {
  for (const { record, shading, hadShading, castHashed, hadCastHashed } of plans) {
    if (record.shading === shading) {
      if (hadShading) record.shading = shading.previous;
      else delete record.shading;
    }
    if (hadCastHashed) record.castHashed = castHashed;
    else delete record.castHashed;
    for (const v of shading.features) v.detach?.(shading.material);
  }
}
