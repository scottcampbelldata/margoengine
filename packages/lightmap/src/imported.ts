/// <reference lib="esnext.disposable" preserve="true" />
import { Texture } from '@margoengine/materials';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import type { MaterialExtension, PBRModel, PBRPrimitive } from '@margoengine/gltf-pro/model';

/** Linear RGBA8 irradiance, top row first, with a shared HDR scale. */
export interface ImportedLightmap {
  width: number;
  height: number;
  data: Uint8Array;
  scale: number;
}

/** Validate and copy an external bake (default scale 1); no colour conversion or re-baking. */
export function readLightmap(input: Omit<ImportedLightmap, 'scale'> & { scale?: number }): ImportedLightmap {
  const { width, height, data, scale = 1 } = input;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    !(data instanceof Uint8Array) ||
    data.length !== width * height * 4
  )
    throw new RangeError(
      'Imported lightmap needs RGBA8 data for a 1 to 4096 pixel width and height; supply matching dimensions',
    );
  if (!Number.isFinite(scale) || scale < 1 || scale > 1e20)
    throw new RangeError('Imported lightmap scale must be finite from 1 to 1e20; normalize the HDR bake');
  return { width, height, data: data.slice(), scale };
}

let serial = 0;
/** Owns the lightmap GPU texture and restores the previous material extension on disposal. */
export class ImportedLightmapInstallation implements EnginePlugin, Disposable {
  /** Applies a validated external bake to the model's engine. Nodes default to all primitives. */
  static attach(model: PBRModel, lightmap: ImportedLightmap, nodes?: readonly number[]): ImportedLightmapInstallation {
    return applyLightmap(model, lightmap, nodes);
  }
  readonly name = `imported-lightmap:${++serial}`;
  readonly texture: Texture;
  readonly lightmap: ImportedLightmap;
  private readonly previous = new Map<PBRPrimitive, MaterialExtension | undefined>();
  private readonly extensions = new Map<PBRPrimitive, MaterialExtension>();
  private unsubscribe?: () => void;
  private disposed = false;
  constructor(
    private readonly model: PBRModel,
    lightmap: ImportedLightmap,
    nodes?: readonly number[],
  ) {
    const chosen = nodes === undefined ? model.primitives : model.primitives.filter((p) => nodes.includes(p.nodeIndex));
    if (model.disposed || !chosen.length || nodes?.some((n) => !Number.isSafeInteger(n) || !model.nodes[n]))
      throw new TypeError('Imported lightmap needs a live model and existing mesh node indices; select its mesh nodes');
    if (chosen.some((p) => p.extension || p.material.extension))
      throw new TypeError(
        'Imported lightmap needs the free material extension slot; remove the previous extension first',
      );
    // Prepared PBR always has both UV pairs in its 80-byte layout, with no accessor dictionary.
    if (chosen.some((p) => p.definition.attributes !== undefined && p.definition.attributes.TEXCOORD_1 === undefined))
      throw new TypeError('Imported lightmap needs TEXCOORD_1 on every selected primitive; export its lightmap UV set');
    const validated = readLightmap(lightmap);
    this.lightmap = validated;
    this.texture = new Texture(
      { width: validated.width, height: validated.height, data: validated.data },
      { colorSpace: 'linear', mipmaps: false, wrapS: 'clamp', wrapT: 'clamp' },
    );
    for (const p of chosen) this.previous.set(p, p.extension);
  }
  setup(engine: Engine): void {
    const bound = this.texture.bind(engine.gpu!, false);
    if (!bound) throw new TypeError('Imported lightmap texture could not bind; use a live GPU engine');
    for (const p of this.previous.keys()) {
      const extension: MaterialExtension = {
        factors: new Float32Array([this.lightmap.scale / Math.PI, 0, 0, 0]),
        textures: [{ view: bound[0], sampler: bound[1] }],
        direct: 'direct=vec3f(0);',
        ambient:
          'materialAmbient=s.base.rgb*(1.0-s.metal)*textureSample(materialTexture0,materialSampler0,uv(i,1.0)).rgb*materialFactors[0].x;',
        lighting: false,
      };
      this.extensions.set(p, extension);
      p.extension = extension;
    }
    this.unsubscribe ??= this.model.onDispose(() => this.dispose());
  }
  onDeviceRestored(engine: Engine): void {
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const [p, previous] of this.previous) if (p.extension === this.extensions.get(p)) p.extension = previous;
    this.texture.dispose();
    this.model.root.engine.removePlugin(this.name);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Apply an external diffuse bake on UV1, replacing direct/ambient light; existing emission stays. */
export function applyLightmap(
  model: PBRModel,
  lightmap: ImportedLightmap,
  nodes?: readonly number[],
): ImportedLightmapInstallation {
  const result = new ImportedLightmapInstallation(model, lightmap, nodes);
  try {
    model.root.engine.use(result);
    return result;
  } catch (error) {
    result.dispose();
    throw error;
  }
}
