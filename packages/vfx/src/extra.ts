/** Per-frame camera and obstacle uniform shared by the obstacle and sort features. */
export const extra=/* wgsl */`
struct Extra {eye:vec4f,forward:vec4f,count:vec4u,obstacles:array<vec4f,128>}
@group(0) @binding(6) var<uniform> extra:Extra;
`;
