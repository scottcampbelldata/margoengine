import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { AreaLightShadow } from '@margoengine/math';
import { ShapeLights, type DiscLight, type SphereLight, type ShapeLightOptions } from './shapes.js';
import { areaShadowSettings, lightBasis, MAX_AREA_SHADOWS, type AreaShadowLight } from './light-shadow-math.js';

/** Disk or sphere emitter with optional centre-sampled PCSS shadows from LocalShadows. */
export type ShadowedAreaShape = (DiscLight | SphereLight) & {
  /** Cast shadows through the attached LocalShadows. Default false. */
  castShadow?: boolean;
  /** Face resolution and near/far clipping; defaults are LocalShadows resolution, 0.1 and 100 metres. */
  shadow?: AreaLightShadow;
};

/**
 * LTC disks and spheres beside rectangle lights, with five disk or six sphere depth faces and radius-scaled PCSS.
 * Shares the ShapeLights slot, casters and shadow texture of LocalShadows. Up to four shapes cast at once in addition
 * to four rectangles. Shadow filtering uses the centre approximation and guard band of rectangle PCSS.
 */
export class AreaShapes extends ShapeLights {
  private shadowList: readonly AreaShadowLight[] = [];
  /** Attach shaped emitters to the clustered lighting of this engine. */
  static override attach(instance: EngineKernel, options: ShapeLightOptions): AreaShapes {
    const effect = new AreaShapes(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** Replace disk and sphere lights atomically; shadows are opt-in. Tubes belong to ShapeLights. */
  override setLights(lights: readonly ShadowedAreaShape[]): this {
    if (!Array.isArray(lights)) throw new TypeError('AreaShapes needs an array; pass disk and sphere lights');
    const shadows: AreaShadowLight[] = [];
    for (const [index, value] of lights.entries()) {
      if (!value || typeof value !== 'object') throw new TypeError('AreaShapes needs light objects; pass a shape');
      if (value.shape !== 'disc' && value.shape !== 'sphere')
        throw new TypeError('AreaShapes supports disks and spheres; use ShapeLights for tubes');
      const light = value as ShadowedAreaShape;
      if (light.castShadow !== undefined && typeof light.castShadow !== 'boolean')
        throw new TypeError('AreaShapes castShadow must be boolean; pass true or false');
      const settings = areaShadowSettings(light.shadow);
      if (!light.castShadow) continue;
      if (shadows.length === MAX_AREA_SHADOWS)
        throw new RangeError(`At most ${MAX_AREA_SHADOWS} shapes cast shadows; disable castShadow on the others`);
      const normal: readonly number[] = value.shape === 'sphere' ? [0, 0, 1] : value.direction,
        length = Math.hypot(...normal),
        n = normal.map((v) => v / length) as [number, number, number],
        [r, u] = lightBasis(n);
      shadows.push({
        index: index + 64,
        center: [...light.position],
        normal: n,
        right: r as [number, number, number],
        up: u as [number, number, number],
        twoSided: value.shape === 'sphere' || !!value.twoSided,
        ...settings,
      });
    }
    super.setLights(lights);
    this.shadowList = Object.freeze(shadows);
    return this;
  }
  /** Validated emitting frames consumed by LocalShadows. */
  shadowLights(): readonly AreaShadowLight[] {
    return this.shadowList;
  }
  /** LTC shader, with shadow visibility multiplied into each emitter before summing. */
  override declarations(group: number, shadow?: string): string {
    // This entry has no tubes. Exclude their tangent-hull integration and pointer-heavy arc walks from compilation.
    const code = super.declarations(group)
      .replace(/struct ShapeArc \{[^}]+\}\n/, '')
      .replace(/fn shapeArc\([\s\S]*?fn clusterShapeLighting\(/, 'fn clusterShapeLighting(')
      .replace('else{form=shapeTube(local,lobe,a,light.b.xyz-position,r);}', 'else{continue;}');
    if (!shadow) return code;
    return code.replace(
      'specular+=light.color.rgb*form.x;diffuse+=light.color.rgb*form.y;',
      `var radiance=light.color.rgb;if(light.a.w<1.5){let axis=select(light.b.xyz,vec3f(0,0,1),light.a.w<0.5);
    let hint=select(vec3f(0,1,0),vec3f(0,0,1),abs(axis.y)>0.99);let r=normalize(cross(hint,axis))*light.b.w;let u=cross(axis,r);
    radiance*=1.0${shadow};}specular+=radiance*form.x;diffuse+=radiance*form.y;`,
    );
  }
}
