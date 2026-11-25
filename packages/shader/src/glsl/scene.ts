// The scene values a GLSL program reads under `lights: true` and `fog: true`: Margo's own names for its sun, ambient,
// clustered point and spot lights and fog, filled by ShaderMaterial each pass. A program declares the ones it reads as
// uniforms; the light lists are arrays of a struct the program declares with any of the listed fields. Also the
// linker's part for `velocity`: the vertex stage run a second time with last frame's values. Only ShaderMaterial of
// shader/glsl-material imports this module, so ShaderPass and Shadertoy, which read no scene, carry none of it.
import type { Declaration } from './parser.js';
import type { GLSLHostName } from './host.js';
import { glProjection, viewInverse, type GLSLPreset } from './presets.js';
import {
  has,
  identifier,
  read,
  rect,
  refuse,
  uniformTypes,
  uses,
  type GLSLProgramSource,
  type GLSLProgramUniform,
  type GLSLSceneLink,
  type StageUnit,
} from './program.js';

/** @internal Plain scene uniforms by name, with their GLSL types. */
export const lightUniforms: Readonly<Record<string, string>> = {
  sunDirection: 'vec3',
  sunColor: 'vec3',
  ambientLight: 'vec3',
  pointLightCount: 'int',
  spotLightCount: 'int',
};
/** @internal The light lists: the fields a program's struct may hold, with their GLSL types. */
export const lightLists: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  pointLights: { position: 'vec3', color: 'vec3', range: 'float', decay: 'float' },
  spotLights: {
    position: 'vec3',
    direction: 'vec3',
    color: 'vec3',
    range: 'float',
    decay: 'float',
    outerCos: 'float',
    innerCos: 'float',
  },
};
/** @internal Fog uniforms by name, with their GLSL types. */
export const fogUniforms: Readonly<Record<string, string>> = {
  fogColor: 'vec3',
  fogNear: 'float',
  fogFar: 'float',
  fogDensity: 'float',
  fogHeight: 'float',
  fogHeightFalloff: 'float',
};

/** @internal The scene part of one link (see GLSLSceneLinker in program.ts), or undefined when no option is set. */
export function sceneLink(source: GLSLProgramSource): GLSLSceneLink | undefined {
  const { lights = false, fog = false, velocity = false } = source;
  if (typeof lights !== 'boolean' || typeof fog !== 'boolean')
    throw new TypeError('ShaderMaterial lights and fog must be booleans');
  if (typeof velocity !== 'boolean' && (!velocity || typeof velocity !== 'object' || Array.isArray(velocity)))
    throw new TypeError("ShaderMaterial velocity must be true, false or {uniform: 'uniformOfLastFrame'}");
  if (!lights && !fog && !velocity) return undefined;
  const previous: Record<string, string> = velocity && typeof velocity === 'object' ? { ...velocity } : {};
  for (const [k, v] of Object.entries(previous))
    if (!identifier.test(k) || typeof v !== 'string' || !identifier.test(v) || k === v)
      throw new TypeError(
        `ShaderMaterial velocity.${k} must name another uniform, the one holding ${k}'s value of last frame`,
      );
  // With velocity, the engine values and the named uniforms the vertex stage reads sit in private variables that each
  // entry fills: with this frame's values, or with last frame's for the second run of the velocity entry.
  const moving: { name: string; type: string; now: string; before: string }[] = [];
  const sets = (then: boolean) => moving.map((m) => `margoNow_${m.name}=${then ? m.before : m.now};\n`).join('');
  return {
    velocity: !!velocity,
    get now() {
      return sets(false);
    },
    // Each uniform the motion reads, and the one holding its value of last frame, declared beside it when undeclared.
    declare(vs: StageUnit, fs: StageUnit, own: ReadonlySet<string>, preset: GLSLPreset | undefined): string[] {
      const lines: string[] = [];
      for (const [now, before] of Object.entries(previous)) {
        const find = (name: string) =>
          [vs, fs].flatMap((u) => u.program.globals).find((d) => d.name === name && has(d.qualifier, 'uniform'));
        if (!own.has(now) && preset?.uniforms[now])
          refuse(vs, `velocity.${now}: the engine's matrices follow by themselves; name your own uniforms`, now);
        const d = find(now) ?? refuse(vs, `velocity names uniform ${now}, which the program does not declare`),
          type = d.type;
        if (!(uniformTypes[type] || rect(type)))
          refuse(
            vs,
            `velocity.${now}: the motion's uniforms are your own scalars, vectors or matrices; the engine's matrices follow by themselves`,
            now,
          );
        const other = find(before);
        if (other && other.type !== type)
          refuse(vs, `velocity.${now} names ${before}, a ${other.type}; give it the type of ${now} (${type})`, before);
        if (!other) lines.push(`uniform ${type} ${before};`);
      }
      return lines;
    },
    // A scene value: its documented type, or for a light list an array of a struct of the list's fields.
    uniform(unit: StageUnit, d: Declaration, own: ReadonlySet<string>): boolean {
      if (own.has(d.name)) return false;
      const plain = (lights && lightUniforms[d.name]) || (fog && fogUniforms[d.name]) || undefined,
        list = lights ? lightLists[d.name] : undefined;
      if (plain) {
        if (d.type !== plain)
          refuse(
            unit,
            `uniform ${d.name} is the scene's ${plain} under ${fogUniforms[d.name] ? 'fog' : 'lights'}; declare it ${plain}, or set it yourself in uniforms`,
            d.name,
          );
        return true;
      }
      if (!list) return false;
      const [, base] = /^(\w+)\[\d+\]$/.exec(d.type) ?? [],
        fields = base ? unit.program.structs.get(base) : undefined;
      if (!fields)
        refuse(
          unit,
          `uniform ${d.name} is the scene's light list under lights; declare it an array of a struct of ${Object.keys(list).join(', ')}`,
          d.name,
        );
      for (const f of fields)
        if (list[f.name] !== f.type)
          refuse(
            unit,
            `${d.name} field ${f.name} ${list[f.name] ? `must be ${list[f.name]}` : `is not a light field; use ${Object.keys(list).join(', ')}`}`,
            f.name,
          );
      return true;
    },
    motion(
      vs: StageUnit,
      engine: Record<string, GLSLHostName>,
      uniforms: ReadonlyMap<string, GLSLProgramUniform>,
      names: Record<string, GLSLHostName>,
      wgslOf: (unit: StageUnit, t: string) => string,
      helpers: ReadonlySet<string>,
    ): string {
      if (!velocity) return '';
      const then = new Set<string>();
      const beforeOf = (name: string, code: string) =>
        name === 'isOrthographic' || name === 'camera_params'
          ? code
          : code
              .replaceAll('margoGLProjection()', 'margoGLProjectionBefore()')
              .replaceAll('mesh.world', 'margoBefore.world')
              .replaceAll('mesh.normal', 'margoBeforeNormal()')
              .replaceAll('camera.viewProjection', 'margoBefore.viewProjection')
              .replaceAll('camera.projection', 'margoBeforeProjection()')
              .replaceAll('camera.time', 'margoBefore.time');
      for (const [name, h] of Object.entries(engine))
        if (uses(vs, name)) moving.push({ name, type: h.type, now: h.code, before: beforeOf(name, h.code) });
      for (const [now, before] of Object.entries(previous)) {
        const u = uniforms.get(now)!;
        moving.push({ name: now, type: u.glsl, now: read(u), before: read(uniforms.get(before)!) });
      }
      for (const m of moving) {
        names[m.name] = { code: 'margoNow_' + m.name, type: m.type };
        for (const f of ['margoBeforeNormal', 'margoBeforeProjection', 'margoGLProjectionBefore'])
          if (m.before.includes(f)) then.add(f);
      }
      if (then.has('margoGLProjectionBefore')) then.add('margoBeforeProjection');
      return (
        moving.map((m) => `var<private> margoNow_${m.name}:${wgslOf(vs, m.type)};\n`).join('') +
        (then.has('margoBeforeNormal')
          ? 'fn margoBeforeNormal()->mat3x3f{let w=margoBefore.world;let a=w[0].xyz;let b=w[1].xyz;let c=w[2].xyz;let x=mat3x3f(cross(b,c),cross(c,a),cross(a,b));let d=dot(a,x[0]);return x*select(0.0,1.0/d,d!=0.0);}\n'
          : '') +
        (then.has('margoBeforeProjection')
          ? (helpers.has(viewInverse) ? '' : viewInverse) +
            'fn margoBeforeProjection()->mat4x4f{return margoBefore.viewProjection*margoViewInverse();}\n'
          : '') +
        (then.has('margoGLProjectionBefore')
          ? glProjection
              .replace('margoGLProjection', 'margoGLProjectionBefore')
              .replace('camera.projection', 'margoBeforeProjection()')
          : '')
      );
    },
    // The velocity entry: main runs with this frame's values, then again from the same start with last frame's; each
    // position is converted as the vertex entry converts it.
    entry(
      params: string,
      lines: string,
      copy: string,
      main: string,
      gl: boolean,
      sprite: string,
      vs: StageUnit,
      names: Record<string, GLSLHostName>,
    ): string {
      // Private globals main may change, kept from the start of the invocation so the second run starts as the first did.
      const kept = [
        'glsl_Position',
        'glsl_PointSize',
        ...vs.program.globals
          .filter(
            (d) => !/\b(uniform|attribute|in|out|varying|const)\b/.test(d.qualifier) && !Object.hasOwn(names, d.name),
          )
          .map((d) => 'user_' + d.name),
      ];
      const clipOf = (v: string) =>
        `var ${v}=glsl_Position;${gl ? `\n${v}.z=(${v}.w-${v}.z)*0.5;` : ''}\n${sprite ? `{${sprite.replaceAll('o.clip', v)}}\n` : ''}`;
      return `@vertex fn margoGLSLVelocity(${params})->MargoVelocity{
${lines}
${sets(false)}${copy}${kept.map((k) => `let margoKept_${k}=${k};\n`).join('')}${main}();
${clipOf('margoClip')}${kept.map((k) => `${k}=margoKept_${k};\n`).join('')}${sets(true)}${main}();
${clipOf('margoPrevious')}return MargoVelocity(margoClip,margoPrevious);
}
`;
    },
  };
}
