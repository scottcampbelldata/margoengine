// Internal adapter: the GLSL front end lives in @margoengine/shader (src/glsl) and is bundled into this entry from
// source. Typing goes through glsl-front.d.ts, as gltf/pbr does for materials/src/native-glass.js, because tsc
// cannot take a TypeScript source from another package under this package's rootDir.
export { GLSLParser } from '../../shader/src/glsl/parser.ts';
export { GLSLEmitter } from '../../shader/src/glsl/emit.ts';
export { preprocessGLSL } from '../../shader/src/glsl/preprocess.ts';
