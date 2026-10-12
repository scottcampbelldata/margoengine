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
@group(0) @binding(2) var dayMap: texture_2d<f32>;
@group(0) @binding(3) var nightMap: texture_2d<f32>;
@group(0) @binding(4) var specularMap: texture_2d<f32>;
@group(0) @binding(5) var normalMap: texture_2d<f32>;
override outputHdr: bool = false;

struct VertexOutput {
    @builtin(position) clip: vec4f,
    @location(0) direction: vec3f,
    @location(1) world: vec3f,
};

@vertex fn vs_main(@location(0) position: vec3f) -> VertexOutput {
    var out: VertexOutput;
    let world = frame.model * vec4f(position * frame.eyeRadius.w, 1.0);
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
    let uv = vec2f(atan2(local.z, local.x) / 6.283185307 + 0.5, acos(clamp(local.y, -1.0, 1.0)) / 3.141592654);
    let day = textureSample(dayMap, filtering, uv).rgb;
    let night = textureSample(nightMap, filtering, uv).rgb;
    let mask = textureSample(specularMap, filtering, uv).rg;
    let relief = textureSample(normalMap, filtering, uv).rgb * 2.0 - 1.0;
    let rotation = mat3x3f(frame.model[0].xyz, frame.model[1].xyz, frame.model[2].xyz);
    let geometricNormal = normalize(rotation * local);
    var shadingNormal = geometricNormal;
    if (frame.settings.x > 0.0) {
        let horizontal = length(local.xz);
        var tangent = vec3f(1.0, 0.0, 0.0);
        if (horizontal > 0.0001) {tangent = vec3f(-local.z, 0.0, local.x) / horizontal;}
        let bitangent = cross(local, tangent);
        let mapped = tangent * relief.x + bitangent * relief.y + local * relief.z;
        if (dot(mapped, mapped) > 0.000001) {shadingNormal = normalize(rotation * mapped);}
    }
    let light = frame.sunOffset.xyz;
    let view = normalize(frame.eyeRadius.xyz - input.world);
    let geometricLight = dot(geometricNormal, light);
    let diffuse = max(dot(shadingNormal, light), 0.0);
    let nightWeight = 1.0 - smoothstep(-0.15, 0.05, geometricLight);
    let shininess = mix(256.0, 8.0, mask.g);
    let glint = pow(max(dot(reflect(-light, shadingNormal), view), 0.0), shininess) * mask.r * max(geometricLight, 0.0);
    let color = day * diffuse + night * frame.settings.z * nightWeight + vec3f(glint);
    return vec4f(encodeColor(color), 1.0);
}
