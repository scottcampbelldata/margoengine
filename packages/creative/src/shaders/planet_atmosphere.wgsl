struct PlanetFrame {
    camera: mat4x4f,
    model: mat4x4f,
    eyeRadius: vec4f,
    sunOffset: vec4f,
    atmosphere: vec4f,
    settings: vec4f,
};

@group(0) @binding(0) var<uniform> frame: PlanetFrame;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var cloudMap: texture_2d<f32>;
override outputHdr: bool = false;

struct VertexOutput {
    @builtin(position) clip: vec4f,
    @location(0) direction: vec3f,
    @location(1) world: vec3f,
};

@vertex fn vs_main(@location(0) position: vec3f) -> VertexOutput {
    var out: VertexOutput;
    let world = frame.model * vec4f(position * frame.eyeRadius.w * 1.01, 1.0);
    out.clip = frame.camera * world;
    out.direction = position;
    out.world = world.xyz;
    return out;
}

fn encodeColor(linear: vec3f) -> vec3f {
    if (outputHdr) {return linear;}
    let mapped = linear / (vec3f(1.0) + linear);
    return select(mapped * 12.92, 1.055 * pow(mapped, vec3f(1.0 / 2.4)) - 0.055, mapped >= vec3f(0.0031308));
}

@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    let local = normalize(input.direction);
    let uv = vec2f(atan2(local.z, local.x) / 6.283185307 + 0.5 + frame.sunOffset.w, acos(clamp(local.y, -1.0, 1.0)) / 3.141592654);
    let cloud = textureSample(cloudMap, filtering, uv);
    let rotation = mat3x3f(frame.model[0].xyz, frame.model[1].xyz, frame.model[2].xyz);
    let normal = normalize(rotation * local);
    let view = normalize(frame.eyeRadius.xyz - input.world);
    let light = dot(normal, frame.sunOffset.xyz);
    let opacity = clamp(cloud.r * cloud.a * frame.settings.y, 0.0, 1.0);
    let cloudColor = vec3f(max(light, 0.0) + 0.025);
    let rim = pow(1.0 - clamp(dot(view, normal), 0.0, 1.0), 3.5);
    let sunlight = smoothstep(-0.15, 0.35, light);
    let glow = frame.atmosphere.rgb * frame.atmosphere.a * rim * sunlight;
    return vec4f(encodeColor(cloudColor) * opacity + encodeColor(glow), opacity);
}
