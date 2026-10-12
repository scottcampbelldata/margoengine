struct SkyUniforms {
    invViewProj: mat4x4<f32>,
    cameraPos: vec4<f32>,
    moonDir: vec4<f32>, // w = cosine of angular radius
    zenithColor: vec4<f32>, // w = twinkle amplitude
    horizonColor: vec4<f32>, // w = haze density
    moonColor: vec4<f32>, // w = sine of angular radius
    params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> sky: SkyUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) ray: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let x = f32(i32(vertexIndex & 1u) * 4 - 1);
    let y = f32(i32(vertexIndex & 2u) * 2 - 1);
    var out: VertexOutput;
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    let worldPos = sky.invViewProj * vec4<f32>(x, y, 0.0, 1.0);
    // Far-plane rays are affine in NDC; reconstruct three vertices instead of every pixel.
    out.ray = worldPos.xyz - sky.cameraPos.xyz * worldPos.w;
    return out;
}

fn hash21(p: vec2<f32>) -> f32 {
    var p3 = fract(p.xyx * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let rayDir = normalize(in.ray);

    let elevation = clamp(rayDir.y, 0.0, 1.0);
    let atmosGradient = pow(1.0 - elevation, 2.5 / max(sky.horizonColor.w, 0.01)) * min(sky.horizonColor.w, 1.0);
    var color = mix(sky.zenithColor.rgb, sky.horizonColor.rgb, atmosGradient);
    let cosDist = clamp(dot(rayDir, sky.moonDir.xyz), -1.0, 1.0);

    if (rayDir.y > 0.258819) {
        let starCoord = rayDir.xz / (rayDir.y + 0.15) * 250.0;
        let starRand = hash21(floor(starCoord));
        if (starRand > 0.985) {
            let dist = length(fract(starCoord) - 0.5);
            let twinkle = max(0.0, sin(sky.params.w * 2.0 + starRand * 6.28) * 0.5 * sky.zenithColor.w + 0.5);
            let star = (1.0 - smoothstep(0.01, 0.12, dist)) * starRand * twinkle * sky.params.z
                * smoothstep(0.258819, 0.5, rayDir.y) * (1.0 - smoothstep(0.96, 1.0, cosDist));
            color += vec3<f32>(0.8, 0.9, 1.0) * star;
        }
    }

    let glow = pow(max(cosDist, 0.0), 32.0) * sky.params.y;
    color += sky.moonColor.rgb * glow * 0.35;

    if (cosDist > sky.moonDir.w) {
        let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(sky.moonDir.y) > 0.99);
        let right = normalize(cross(sky.moonDir.xyz, up));
        let discUp = cross(right, sky.moonDir.xyz);
        let disc = vec2<f32>(dot(rayDir, right), dot(rayDir, discUp)) / sky.moonColor.w;
        let radiusSquared = dot(disc, disc);
        let limb = sqrt(max(0.0, 1.0 - radiusSquared));
        let phase = sky.params.x;
        let illumination = disc.x * sqrt(max(0.0, 1.0 - phase * phase)) + limb * phase;
        let phaseMask = smoothstep(0.0, 0.02, illumination);
        let discColor = sky.moonColor.rgb * (0.8 + 0.2 * limb) * phaseMask;
        color = mix(color, discColor, 1.0 - smoothstep(0.96, 1.0, radiusSquared));
    }

    return vec4<f32>(color, 1.0);
}
