struct CameraUniforms {
    inverseViewProjection: mat4x4<f32>,
    position: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) ray: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    let x = f32(i32(index & 1u) * 4 - 1);
    let y = f32(i32(index & 2u) * 2 - 1);
    var out: VertexOutput;
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    let world = camera.inverseViewProjection * out.position;
    out.ray = world.xyz - camera.position.xyz * world.w;
    return out;
}

fn hash(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let ray = normalize(in.ray);
    let magnitude = abs(ray);
    var plane: vec2<f32>;
    var face: f32;
    if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
        plane = ray.yz / magnitude.x;
        face = select(0.0, 1.0, ray.x > 0.0);
    } else if (magnitude.y >= magnitude.z) {
        plane = ray.xz / magnitude.y;
        face = select(2.0, 3.0, ray.y > 0.0);
    } else {
        plane = ray.xy / magnitude.z;
        face = select(4.0, 5.0, ray.z > 0.0);
    }
    let grid = (plane * 0.5 + 0.5) * 450.0;
    let seed = hash(vec3<f32>(floor(grid), face));
    let distance = length(fract(grid) - 0.5);
    let pixel = max(fwidth(grid.x), fwidth(grid.y));
    let star = (1.0 - smoothstep(0.02, 0.065 + pixel * 0.5, distance)) * smoothstep(0.998, 1.0, seed);
    let tint = mix(vec3<f32>(0.70, 0.84, 1.0), vec3<f32>(1.0, 0.86, 0.66), hash(vec3<f32>(floor(grid), face + 10.0)));
    return vec4<f32>(vec3<f32>(0.0015, 0.002, 0.004) + tint * star * 0.8, 1.0);
}
