// The engine values a GLSL program may read under the names of a web shader convention, each named by its signature
// uniform. Written clean room from the conventions' public documentation (docs/clean-room.md, "GLSL programs as
// materials"); the WGSL reads Margo's camera and mesh blocks of the raw material prelude.

/** What an attribute holds, for `shaderMesh`: a geometry stream or an instance stream. */
export type GLSLAttributeSemantic =
  | 'position'
  | 'normal'
  | 'uv'
  | 'uv1'
  | 'color'
  | 'tangent'
  | 'instanceMatrix'
  | 'instanceColor';
/** A convention's name, `'auto'` (the one the program's names show) or false (none). */
export type GLSLBuiltins = 'modelViewMatrix' | 'worldViewProjection' | 'matrix_model' | 'auto' | false;
/** @internal A uniform the engine supplies: its GLSL type, the WGSL that reads it and the stages that may use it undeclared. */
export interface GLSLPresetUniform {
  readonly glsl: string;
  readonly code: string;
  readonly implicit?: readonly ('vertex' | 'fragment')[];
  readonly helpers?: readonly string[];
}
/** @internal An attribute a convention names: its GLSL type, what it holds and its value when the mesh lacks it. */
export interface GLSLPresetAttribute {
  readonly glsl: string;
  readonly semantic: GLSLAttributeSemantic;
  readonly implicit?: boolean;
  readonly default?: readonly number[];
}
/** @internal */
export interface GLSLPreset {
  readonly uniforms: Readonly<Record<string, GLSLPresetUniform>>;
  readonly attributes: Readonly<Record<string, GLSLPresetAttribute>>;
}

/** @internal */
export const semantics: readonly GLSLAttributeSemantic[] = [
  'position',
  'normal',
  'uv',
  'uv1',
  'color',
  'tangent',
  'instanceMatrix',
  'instanceColor',
];
/** @internal */
export const presetNames = ['modelViewMatrix', 'worldViewProjection', 'matrix_model'] as const;

// GL's projection from Margo's: a reversed-Z clip z (near 1, far 0) becomes GL's (near -w, far w), per column
// z' = w - 2z, so the linked vertex entry's (w - z') / 2 gives Margo's z back. Jitter, XR and custom projections survive.
/** @internal */
export const glProjection =
  'fn margoGLProjection()->mat4x4f{var p=camera.projection;for(var c=0;c<4;c++){p[c].z=p[c].w-2.0*p[c].z;}return p;}\n';
const view3 = 'mat3x3f(camera.view[0].xyz,camera.view[1].xyz,camera.view[2].xyz)';
// The inverse of the rigid view matrix: the transposed rotation and the camera position.
/** @internal */
export const viewInverse =
  'fn margoViewInverse()->mat4x4f{let r=transpose(' +
  view3 +
  ');return mat4x4f(vec4f(r[0],0.0),vec4f(r[1],0.0),vec4f(r[2],0.0),vec4f(camera.position,1.0));}\n';
// 1 / far, far, near and 1 for an orthographic projection, from Margo's reversed-Z projection (clip z = a z + b w).
const cameraParams =
  'fn margoCameraParams()->vec4f{let p=camera.projection;let a=p[2].z;let b=p[3].z;if(p[3].w>0.5){return vec4f(a/b,b/a,(b-1.0)/a,1.0);}let f=select(b/a,3.4e38,a==0.0);return vec4f(a/b,f,b/(1.0+a),0.0);}\n';

/** @internal Each convention's names; `gl` false keeps Margo's projection (WebGPU clip space). */
export const presets: Record<(typeof presetNames)[number], (gl: boolean) => GLSLPreset> = {
  // The convention whose uniforms are declared for the program: modelMatrix, viewMatrix and the rest.
  modelViewMatrix: (gl) => {
    const projection = gl ? 'margoGLProjection()' : 'camera.projection',
      p = gl ? [glProjection] : [],
      both = ['vertex', 'fragment'] as const,
      vertex = ['vertex'] as const;
    return {
      uniforms: {
        modelMatrix: { glsl: 'mat4', code: 'mesh.world', implicit: vertex },
        viewMatrix: { glsl: 'mat4', code: 'camera.view', implicit: both },
        modelViewMatrix: { glsl: 'mat4', code: '(camera.view*mesh.world)', implicit: vertex },
        projectionMatrix: { glsl: 'mat4', code: projection, implicit: vertex, helpers: p },
        normalMatrix: { glsl: 'mat3', code: `(${view3}*mesh.normal)`, implicit: vertex },
        cameraPosition: { glsl: 'vec3', code: 'camera.position', implicit: both },
        isOrthographic: { glsl: 'bool', code: '(camera.projection[3].w>0.5)', implicit: both },
      },
      attributes: {
        position: { glsl: 'vec3', semantic: 'position', implicit: true },
        normal: { glsl: 'vec3', semantic: 'normal', implicit: true },
        uv: { glsl: 'vec2', semantic: 'uv', implicit: true, default: [0, 0] },
        uv1: { glsl: 'vec2', semantic: 'uv1', implicit: true, default: [0, 0] },
        color: { glsl: 'vec3', semantic: 'color', implicit: true, default: [1, 1, 1] },
        tangent: { glsl: 'vec4', semantic: 'tangent', implicit: true },
        instanceMatrix: { glsl: 'mat4', semantic: 'instanceMatrix', implicit: true },
        instanceColor: { glsl: 'vec3', semantic: 'instanceColor', implicit: true, default: [1, 1, 1] },
      },
    };
  },
  // The convention whose program declares world, view, projection and their products.
  worldViewProjection: (gl) => {
    const projection = gl ? 'margoGLProjection()' : 'camera.projection',
      p = gl ? [glProjection] : [];
    return {
      uniforms: {
        world: { glsl: 'mat4', code: 'mesh.world' },
        view: { glsl: 'mat4', code: 'camera.view' },
        projection: { glsl: 'mat4', code: projection, helpers: p },
        worldView: { glsl: 'mat4', code: '(camera.view*mesh.world)' },
        worldViewProjection: { glsl: 'mat4', code: `(${projection}*camera.view*mesh.world)`, helpers: p },
      },
      attributes: {
        position: { glsl: 'vec3', semantic: 'position' },
        normal: { glsl: 'vec3', semantic: 'normal' },
        uv: { glsl: 'vec2', semantic: 'uv' },
        uv2: { glsl: 'vec2', semantic: 'uv1' },
        color: { glsl: 'vec4', semantic: 'color' },
      },
    };
  },
  // The convention of matrix_ and view_ names.
  matrix_model: (gl) => {
    const projection = gl ? 'margoGLProjection()' : 'camera.projection',
      p = gl ? [glProjection] : [],
      size = 'vec4f(camera.resolution,1.0/camera.resolution)',
      view = 'vec4f(camera.viewport.zw,1.0/camera.viewport.zw)';
    return {
      uniforms: {
        matrix_model: { glsl: 'mat4', code: 'mesh.world' },
        matrix_normal: { glsl: 'mat3', code: 'mesh.normal' },
        matrix_view: { glsl: 'mat4', code: 'camera.view' },
        matrix_viewInverse: { glsl: 'mat4', code: 'margoViewInverse()', helpers: [viewInverse] },
        matrix_view3: { glsl: 'mat3', code: view3 },
        matrix_projection: { glsl: 'mat4', code: projection, helpers: p },
        matrix_viewProjection: { glsl: 'mat4', code: `(${projection}*camera.view)`, helpers: p },
        view_position: { glsl: 'vec3', code: 'camera.position' },
        camera_params: { glsl: 'vec4', code: 'margoCameraParams()', helpers: [cameraParams] },
        screen_size: { glsl: 'vec4', code: size },
        viewport_size: { glsl: 'vec4', code: view },
        view_index: { glsl: 'uint', code: '0u' },
      },
      attributes: {
        vertex_position: { glsl: 'vec3', semantic: 'position' },
        vertex_normal: { glsl: 'vec3', semantic: 'normal' },
      },
    };
  },
};
