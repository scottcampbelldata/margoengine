// Whole GLSL programs as materials: ShaderMaterial is a RawShaderMaterial whose two stages are GLSL ES 1.00 or 3.00
// with `void main()`, translated once per source and defines by the GLSL front end that shader/glsl and
// transitions/glsl share, so one GLSL source draws on WebGPU and on the WebGL2 layer. Optional entry
// @margoengine/shader/glsl-material. ShaderMaterial is the program core of glsl/material.ts plus the scene options
// (lights, fog, velocity) of this file and glsl/scene.ts, which ShaderPass and Shadertoy do not import. Written clean
// room from the GLSL ES 1.00 and 3.00 specifications, the WebGL and WebGPU specifications and the public documentation
// of other web engines' shader materials (docs/clean-room.md).
import type { RawShaders } from './raw.js';
import { checkFog, writeFog, type FogLike } from '../../shared/fog.js';
import { linkGLSLProgram, type GLSLLinked, type GLSLProgramSource, type GLSLProgramWGSL } from './glsl/program.js';
import { sceneLink } from './glsl/scene.js';
import {
  GLSLMaterial,
  type GLSLMaterialScene,
  type ShaderMaterialOptions,
  type ShaderUniformValue,
} from './glsl/material.js';

export { shaderMesh } from './glsl/material.js';
export type {
  ShaderUniformValue,
  ShaderUniform,
  ShaderSide,
  ShaderDepthFunc,
  ShaderMaterialOptions,
  ShaderGeometry,
  ShaderMeshOptions,
} from './glsl/material.js';
/** Programs linked so far, for work-count tests. @internal */
export { glslPrograms } from './glsl/program.js';
export type {
  GLSLProgramSource,
  GLSLProgramWGSL,
  GLSLProgramUniform,
  GLSLProgramTexture,
  GLSLProgramAttribute,
  GLSLProgramVarying,
  GLSLStage,
  GLSLAttributeSemantic,
  GLSLBuiltins,
} from './glsl/program.js';
export type { FogLike } from '../../shared/fog.js';

/** A point light for {@link ShaderScene.setLights}, as `@margoengine/clustered` takes it. */
export interface ShaderPointLight {
  readonly position: ArrayLike<number>;
  /** Where the light ends; 0 is unlimited. */
  readonly range: number;
  /** Linear RGB. Default 1, 1, 1. */
  readonly color?: ArrayLike<number>;
  /** Default 1. */
  readonly intensity?: number;
  /** Distance falloff exponent. Default 2. */
  readonly decay?: number;
}
/** A spot light for {@link ShaderScene.setLights}: a point light with a direction and a cone. */
export interface ShaderSpotLight extends ShaderPointLight {
  readonly direction: ArrayLike<number>;
  readonly outerAngle?: number;
  readonly innerAngle?: number;
  readonly angle?: number;
  readonly penumbra?: number;
}
/** What {@link ShaderScene.setLights} takes: a `Clustered` fits. */
export interface ShaderLightSource {
  readonly list: readonly (ShaderPointLight | ShaderSpotLight)[];
  readonly intensityScale?: number | (() => number);
}
/** The fog and the point and spot lights that ShaderMaterials drawn by one RawShaders read: see {@link shaderScene}. */
export interface ShaderScene {
  /** The fog materials with `fog: true` read, or null (no fog). */
  readonly fog: FogLike | null;
  /** The point and spot lights materials with `lights: true` read, or null (none). */
  readonly lights: ShaderLightSource | null;
  /**
   * Sets the fog: `@margoengine/environment`'s `Fog` or any object with its fields, read every frame; null for none.
   * @throws TypeError when `fog` is neither an object nor null; RangeError or TypeError for an invalid field.
   */
  setFog(fog: FogLike | null): this;
  /**
   * Sets the point and spot lights: a `Clustered` of `@margoengine/clustered`, or any object with its `list` (and
   * optional `intensityScale`), read every frame; null for none. The sun and ambient light are always `engine.lighting`'s.
   * @throws TypeError when `lights` has no `list` array.
   */
  setLights(lights: ShaderLightSource | null): this;
}
const scenes = new WeakMap<RawShaders, ShaderScene>();
/**
 * The scene that ShaderMaterials made with `fog: true` or `lights: true` read when `raw` draws them:
 * `shaderScene(raw).setFog(fog).setLights(clustered)`. One per RawShaders; it starts with no fog and no lights.
 * @throws TypeError when `raw` is not a RawShaders.
 */
export function shaderScene(raw: RawShaders): ShaderScene {
  if (!raw || typeof raw !== 'object' || typeof (raw as { add?: unknown }).add !== 'function')
    throw new TypeError('shaderScene needs the RawShaders that draws the materials');
  let scene = scenes.get(raw);
  if (!scene) {
    let fog: FogLike | null = null,
      lights: ShaderLightSource | null = null;
    scene = {
      get fog() {
        return fog;
      },
      get lights() {
        return lights;
      },
      setFog(value) {
        fog = checkFog(value);
        return this;
      },
      setLights(value) {
        if (value !== null && (typeof value !== 'object' || !Array.isArray(value.list)))
          throw new TypeError(
            'ShaderScene.setLights needs a Clustered, an object with a list of point and spot lights, or null',
          );
        lights = value;
        return this;
      },
    };
    scenes.set(raw, scene);
  }
  return scene;
}

/** The material whose RawShaders the scene values come from, and this pass's values. */
interface SceneHolder {
  material?: GLSLMaterial;
  cache?: Record<string, ShaderUniformValue>;
  /** The RawShaders and its pass the cache was read in. */
  key?: [RawShaders | undefined, number];
}
// The scene uniforms' {value} objects, told apart from the caller's when the program is linked again.
const sceneObjects = new WeakSet<object>();
const off = { enabled: false };
// This pass's scene values (engine.lighting, the RawShaders' fog and lights), in the names of `lights` and `fog`.
function sceneValues(linked: GLSLLinked, holder: SceneHolder): Record<string, ShaderUniformValue> {
  const raw = holder.material?.drawnBy,
    pass = raw?.pass ?? -1;
  // Read once a pass: every leaf of a light list asks.
  if (holder.cache && holder.key![0] === raw && holder.key![1] === pass) return holder.cache;
  holder.key = [raw, pass];
  const lighting = raw?.kernel?.lighting,
    scene = raw ? scenes.get(raw) : undefined,
    out: Record<string, ShaderUniformValue> = {};
  // The sun: its unit direction, its colour times its intensity, and the ambient light of core meshes.
  const d = lighting?.direction ?? [0, 1, 0, 0],
    r = lighting?.radiance ?? [0, 0, 0, 0],
    a = lighting?.ambient ?? [1, 1, 1],
    length = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  out.sunDirection = [d[0]! / length, d[1]! / length, d[2]! / length];
  out.sunColor = [r[0]! * d[3]!, r[1]! * d[3]!, r[2]! * d[3]!];
  out.ambientLight = [a[0]! * r[3]!, a[1]! * r[3]!, a[2]! * r[3]!];
  // Fog as Fog's fields, its colour encoded as the program writes colour (display-ready or linear).
  const f = new Float32Array(12);
  writeFog(scene?.fog ?? off, [0, 0, 0], f, linked.display);
  Object.assign(out, {
    fogColor: [f[0]!, f[1]!, f[2]!],
    fogHeight: f[3]!,
    fogNear: f[4]!,
    fogFar: f[5]!,
    fogDensity: f[6]!,
    fogHeightFalloff: f[7]!,
  });
  // Point and spot lights in list order, as many as each declared array holds.
  const source = scene?.lights,
    scale = typeof source?.intensityScale === 'function' ? source.intensityScale() : (source?.intensityScale ?? 1),
    points: ShaderUniformValue[] = [],
    spots: ShaderUniformValue[] = [],
    room = (root: string) => {
      let n = 0;
      for (const u of linked.uniforms) if (u.root === root) n = Math.max(n, (u.path?.[0] as readonly number[])[0]! + 1);
      return linked.scene.includes(root) ? n : Infinity;
    },
    pointRoom = room('pointLights'),
    spotRoom = room('spotLights');
  for (const light of source?.list ?? []) {
    const c = light.color ?? [1, 1, 1],
      k = (light.intensity ?? 1) * scale,
      base = {
        position: Array.from(light.position),
        color: [c[0]! * k, c[1]! * k, c[2]! * k],
        range: light.range,
        decay: light.decay ?? 2,
      };
    if (!('direction' in light)) {
      if (points.length < pointRoom) points.push(base);
      continue;
    }
    if (spots.length >= spotRoom) continue;
    const s = light as ShaderSpotLight,
      n = Math.hypot(s.direction[0]!, s.direction[1]!, s.direction[2]!) || 1,
      outer = s.angle ?? s.outerAngle ?? Math.PI / 2,
      inner = s.angle === undefined ? (s.innerAngle ?? 0) : s.angle * (1 - (s.penumbra ?? 0));
    spots.push({
      ...base,
      direction: [s.direction[0]! / n, s.direction[1]! / n, s.direction[2]! / n],
      outerCos: Math.cos(outer),
      innerCos: Math.cos(inner),
    });
  }
  Object.assign(out, {
    pointLights: points,
    spotLights: spots,
    pointLightCount: points.length,
    spotLightCount: spots.length,
  });
  return (holder.cache = out);
}
// The scene options' code: the linker's part, and the {value} of each scene uniform the program reads, unless the
// caller set it in uniforms. A relinked program drops the scene uniforms it no longer reads.
const scene: GLSLMaterialScene = {
  link: sceneLink,
  uniforms(linked, values, holder: SceneHolder) {
    for (const name of Object.keys(values)) if (sceneObjects.has(values[name]!)) delete values[name];
    for (const name of linked.scene) {
      if (values[name]) continue;
      const u = {
        get value() {
          return sceneValues(linked, holder)[name] ?? null;
        },
        set value(_: ShaderUniformValue) {
          throw new TypeError(
            `ShaderMaterial uniform ${name} comes from the scene; give it in uniforms to set it yourself`,
          );
        },
      };
      sceneObjects.add(u);
      values[name] = u;
    }
  },
};

/**
 * A material from a whole GLSL program, as a web engine's `RawShaderMaterial` takes one: GLSL ES 1.00 or 3.00 vertex and
 * fragment stages with `void main()`, live `uniforms` by GLSL name, `defines` and the render state of
 * RawShaderMaterial. Draw it with a RawMesh in a RawShaders plugin; attributes match by name. The GLSL is translated
 * here, once per source and defines (syntax and link errors throw here, with `stage`, `line` and `column`), and
 * `material.code(stage, mesh)` shows the WGSL each stage becomes. `lights`, `fog` and `velocity` read the scene
 * (see {@link shaderScene}) and write motion vectors for TAA.
 */
export class ShaderMaterial extends GLSLMaterial {
  constructor(options: ShaderMaterialOptions) {
    super(options, scene);
  }
  /**
   * True for every material made from a GLSL program, including those ShaderPass and Shadertoy make, which are the
   * same program core without the scene options (so those entries carry no scene code). A subclass checks as usual.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return this === ShaderMaterial
      ? value instanceof GLSLMaterial
      : Function.prototype[Symbol.hasInstance].call(this, value);
  }
}

/**
 * Translates a whole GLSL program (GLSL ES 1.00 or 3.00, a vertex and a fragment stage with `void main()`) to the two
 * WGSL stages a `RawShaderMaterial` of `@margoengine/shader/raw` draws, with the uniforms, textures, attributes and
 * varyings it declares. `ShaderMaterial` does this for you; this shows the WGSL.
 * @throws MargoError `failed` with `stage`, `line` and `column` for a syntax or link error; TypeError for bad options.
 */
export function glslProgramToWGSL(source: GLSLProgramSource): GLSLProgramWGSL {
  const { vertexFor: _, display: __, ...linked } = linkGLSLProgram(source, sceneLink);
  return linked;
}
