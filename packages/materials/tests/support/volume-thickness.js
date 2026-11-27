// The pass hook (Transmission.declarations) calls margoVolumeThickness(i), a function of the lit shader it is pasted
// into, like the dielectric Fresnel: gltf's transmissionPBR writes a stub returning 1 when the shader samples no
// thickness map, and extendedShader writes the map read. The CPU tests compose the hook the same way, with the stub
// read from gltf's source so they follow it.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../../gltf/src/shader.ts', import.meta.url), 'utf8');
const stub = /: '(fn margoVolumeThickness\(i:Out\)->f32 \{return 1\.0;\})\\n'/.exec(source);
if (!stub) throw new Error('gltf transmissionPBR no longer writes the margoVolumeThickness stub');
/** WGSL of the host shader's margoVolumeThickness when no thickness map is sampled. */
export const volumeThicknessStub = stub[1] + '\n';
/** The same function as a shader whose thickness map reads `value` (green channel) everywhere. */
export const volumeThicknessMap = (value) => `fn margoVolumeThickness(i:Out)->f32 {return ${value};}\n`;
