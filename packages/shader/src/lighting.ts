// Node access to the scene's light, for lighting models written in the graph. The nodes here run at the end of the lit
// fragment, after the shadow, clustered and environment effects have composed their hooks, so they read what those
// effects worked out and need no knowledge of which ones are attached.
import { MargoError } from '@margoengine/math/errors';
import { clusterBrdf } from '../../shared/light-terms.js';
import { directVisibility } from '../../shared/pbr-hooks.js';
import { NodeMaterial, fragmentStage, type NodeMaterialOptions } from './material.js';
import { Node, builtin, cast, type NodeInput, type Program, type ShaderStage } from './node.js';

/** Unit vector from the surface towards the sun. `lightingNode` only. */
export const sunDirection = /*@__PURE__*/ builtin('sunDirection', 'vec3f');
/** The sun's light (colour times intensity), before shadows. `lightingNode` only. */
export const sunColor = /*@__PURE__*/ builtin('sunColor', 'vec3f');
/** How much of the sun reaches this pixel per colour channel, 0 in full shadow to 1; 1 without a shadow effect. `lightingNode` only. */
export const sunVisibility = /*@__PURE__*/ builtin('sunVisibility', 'vec3f');
/** Ambient light on this surface, with the material's response: image-based light, probes or the sky. `lightingNode` only. */
export const ambientLight = /*@__PURE__*/ builtin('ambientLight', 'vec3f');
/** The sum of the clustered lights on this surface, shadows included; zero without them. `lightingNode` only. */
export const localLight = /*@__PURE__*/ builtin('localLight', 'vec3f');
/** The colour the material shows with its usual lighting, before tone mapping. `lightingNode` only. */
export const litColor = /*@__PURE__*/ builtin('litColor', 'vec3f');
/**
 * What the scene's environment shows towards `direction`, blurred as a surface of `roughness` (0..1) would see it. It is
 * the scene's ambient light on a mirror facing that way, so it follows whichever effect provides that light.
 */
export function environment(direction: NodeInput<'vec3f'>, roughness: NodeInput<'f32'> = 0): Node<'vec3f'> {
  return new Node(
    'vec3f',
    'E',
    [cast(direction, 'vec3f', 'environment direction'), cast(roughness, 'f32', 'environment roughness')],
    (b, n) => `${b.builtin('environment')}(i,s,${b.expr(n.args[0])},${b.expr(n.args[1])})`,
  );
}
/** What a {@link LightModel} receives for each light. Vectors are unit length, in world space. */
export interface LightInput {
  /** Towards the light. */
  readonly direction: Node<'vec3f'>;
  /** Towards the camera. */
  readonly view: Node<'vec3f'>;
  /** The shading normal. */
  readonly normal: Node<'vec3f'>;
  /** The surface's base colour. */
  readonly color: Node<'vec3f'>;
  readonly roughness: Node<'f32'>;
  readonly metalness: Node<'f32'>;
}
/**
 * A surface's response to one light: how much of the light's colour leaves towards the camera, the cosine term included.
 * The sun and each clustered point, spot and extra directional light use it, with their colour, falloff and shadows
 * applied around it.
 */
export type LightModel = (light: LightInput) => Node<'vec3f'>;
/** Options for `new LightingMaterial(options)`: every NodeMaterial option, and the two ways to take over the lighting. */
export interface LightingMaterialOptions extends NodeMaterialOptions {
  /** Replaces the physically based response to the sun and clustered lights. Ambient and emissive light stay. */
  lightModel?: LightModel;
  /** The final linear colour of the pixel, before fog and tone mapping. It can read every node of this entry. */
  lightingNode?: Node<'vec3f'>;
}
const brdf = 'margoNodeBrdf',
  mirror = 'margoNodeEnvironment',
  local = 'margoNodeLocal',
  sunCall = 'let direct=direct_light(s,v,l);',
  localTerm = `result+=${clusterBrdf}*nl*`,
  // The colour statement, with the ambient hook's statement that sits in front of it.
  sum = /(let margoAmbient=([^;]*);)?var color=([^;]*);/,
  // What follows the lit sum: the physical layers and env map edits stay above it, the display steps below it.
  display = /\n\s*(?:if\(f\.ext\.x>0\.5\)|color=[^;]*pbrNeutral|if\(f\.settings\.w<0\.5\))/;
const stage = (builtins: ShaderStage['builtins']): ShaderStage => ({
  ...fragmentStage,
  builtins: {
    ...fragmentStage.builtins,
    normalWorld: 's.n',
    environment: mirror,
    ...builtins,
  },
});
const finalStage = /*@__PURE__*/ stage({
    viewDirection: 'v',
    sunDirection: 'l',
    sunColor: 'f.radiance.rgb*f.light.w',
    sunVisibility: 'margoDirectVisible',
    ambientLight: 'margoNodeAmbient',
    localLight: local,
    litColor: 'color',
  }),
  modelStage = /*@__PURE__*/ stage({
    modelDirection: 'l',
    modelView: 'v',
    modelNormal: 'n',
    modelColor: 'base',
    modelRoughness: 'roughness',
    modelMetalness: 'metal',
  });
const refuse = (what: string): never => {
  throw new MargoError(
    'unsupported',
    `LightingMaterial requires the standard gltf-pro PBR shader (${what} is missing); use matching @margoengine/gltf-pro and shader versions`,
  );
};
const indent = (lines: string[]) => lines.map((l) => '  ' + l + '\n').join('');
/**
 * A NodeMaterial that writes its own lighting: toon steps, hatching, a custom BRDF. Shadows, clustered lights and the
 * environment keep working, because the graph reads what those effects worked out.
 */
export class LightingMaterial extends NodeMaterial {
  /** Generated statements of `lightingNode` (for inspection and tests). */
  readonly lightingCode: string;
  /** The generated WGSL function of `lightModel` (for inspection and tests). */
  readonly lightModelCode: string;
  private readonly finalColor?: string;
  private readonly declared = new Map<string, string>();
  private readonly relit = new Map<string, string>();
  constructor(options: LightingMaterialOptions = {}) {
    const { lightModel, lightingNode, ...rest } = options;
    if (lightingNode !== undefined && lightingNode?.type !== 'vec3f')
      throw new TypeError('lightingNode must be a vec3f node');
    if (lightModel !== undefined && typeof lightModel !== 'function')
      throw new TypeError('lightModel must be a function from a LightInput to a vec3f node');
    if ((rest.shading ?? 'standard') !== 'standard')
      throw new TypeError('LightingMaterial writes its own lighting; leave shading at standard');
    let lines = '',
      value: string | undefined,
      model = '';
    // Before the vertex stage compiles, so a varying these nodes read reaches it.
    super(rest, (program: Program) => {
      if (lightingNode) {
        const final = program.stage(finalStage, [lightingNode]);
        lines = indent(final.lines);
        value = final.values[0];
      }
      if (lightModel) {
        const response = cast(
            lightModel({
              direction: builtin('modelDirection', 'vec3f'),
              view: builtin('modelView', 'vec3f'),
              normal: builtin('modelNormal', 'vec3f'),
              color: builtin('modelColor', 'vec3f'),
              roughness: builtin('modelRoughness', 'f32'),
              metalness: builtin('modelMetalness', 'f32'),
            }),
            'vec3f',
            'lightModel result',
          ),
          compiled = program.stage(modelStage, [response]);
        model =
          `var<private> margoNodeIn:Out;\nvar<private> margoNodeSurface:Surface;\nvar<private> margoNodeFront:bool;\n` +
          `fn ${brdf}(l:vec3f,v:vec3f,n:vec3f,base:vec3f,roughness:f32,metal:f32)->vec3f {\n` +
          `  let i=margoNodeIn;let s=margoNodeSurface;let front=margoNodeFront;\n` +
          `${indent(compiled.lines)}  return ${compiled.values[0]};\n}\n`;
      }
    });
    this.lightingCode = lines;
    this.finalColor = value;
    this.lightModelCode = model;
  }
  override shader(source: string, group: number): string {
    const code = super.shader(source, group);
    let out = this.declared.get(code);
    if (out === undefined) {
      // A shadow effect then keeps its visibility apart from the sun's light, for sunVisibility.
      out = code.includes(directVisibility) ? code : directVisibility + '\n' + code;
      this.declared.set(code, out);
    }
    return out;
  }
  /** @internal Runs once the scene's lighting effects are composed into `code`. */
  override relight(code: string): string {
    if (!this.lightModelCode && this.finalColor === undefined) return code;
    let out = this.relit.get(code);
    if (out !== undefined) return out;
    out = code;
    if (this.lightModelCode) {
      if (!out.includes(sunCall)) refuse('its direct_light call');
      out =
        out
          .replace(
            sunCall,
            `margoNodeIn=i;margoNodeSurface=s;margoNodeFront=front;let direct=${brdf}(l,v,s.n,s.base.rgb,s.roughness,s.metal)*f.radiance.rgb*f.light.w;`,
          )
          .replaceAll(localTerm, `result+=${brdf}(l,v,n,base,roughness,metal)*`) +
        '\n' +
        this.lightModelCode;
    }
    const found = sum.exec(out) ?? refuse('its var color line');
    if (this.finalColor !== undefined) {
      const terms = /^(.*?)direct(?:\*margoDirectVisible)?\+ambient\(s\)/.exec(found[3]) ?? refuse('direct+ambient(s)'),
        rest = out.slice(found.index + found[0].length),
        at = rest.search(display);
      if (at < 0) refuse('its tone map line');
      out =
        out.slice(0, found.index) +
        `let ${local}=${terms[1]}vec3f(0);${found[1] ?? ''}var color=${local}+${found[3].slice(terms[1].length)};` +
        rest.slice(0, at) +
        `\n  let margoNodeAmbient=ambient(s)${found[1] ? '+margoAmbient' : ''};\n  {\n${this.lightingCode}` +
        `  color=${this.finalColor};\n  }` +
        rest.slice(at);
    }
    if ((this.lightingCode + this.finalColor + this.lightModelCode).includes(mirror))
      out +=
        `\nfn ${mirror}(i:Out,surface:Surface,d:vec3f,r:f32)->vec3f {\n` +
        `  var s=surface;s.base=vec4f(1);s.metal=1.0;s.n=d;s.occlusion=1.0;s.roughness=clamp(r,0.045,1.0);let v=d;\n` +
        `  return ambient(s)${found[2] ? '+' + found[2] : ''};\n}\n`;
    if (this.relit.size >= 64) this.relit.clear();
    this.relit.set(code, out);
    return out;
  }
}
