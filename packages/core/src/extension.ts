// Explicit extension access for device-bound passes and Wasm systems.
export {Engine,Mesh,VectorRef} from './engine.js';
export type {FrameCallback,EngineOptions} from './engine.js';
export {TransformStore} from './kernel.js';
export {FrameGraph} from './plugin.js';
export type {EnginePlugin,FramePass,PassContext,DrawOptions} from './plugin.js';
export {Geometry,PbrMaterial,box} from './geometry.js';
export {Camera} from './camera.js';
export type {Vec3,CameraOptions} from './camera.js';
export type {GeometryBuffers} from './renderer.js';
import type {EngineKernel,Mesh as MeshHandle} from './api.js';
import type {Engine,Mesh} from './engine.js';
export const engineRuntime=(engine:EngineKernel):Engine=>engine as unknown as Engine;
export const meshRuntime=(mesh:MeshHandle):Mesh=>mesh as unknown as Mesh;
