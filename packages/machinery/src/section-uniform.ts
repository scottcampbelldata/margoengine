// Section uniform WGSL, shared by section clipping and feature edges.
export const declaration=(binding:number)=>`struct Section {planes:array<vec4f,6>,settings:vec4f,color:vec4f,camera:mat4x4f,inverse:mat4x4f}\n@group(0) @binding(${binding}) var<uniform> section:Section;\n`;
