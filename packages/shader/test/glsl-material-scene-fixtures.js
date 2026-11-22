// GLSL programs that read the scene's lights and fog (`lights: true`, `fog: true`), drawn by the browser's own WebGL
// compiler (the oracle, given the values the scene stands for, worked out on their own in the check page) and by
// ShaderMaterial on WebGPU and on the WebGL2 layer in test/glsl-material-check.mjs. `scene` holds the first and the
// changed scene: engine.lighting, the fog and light list of shaderScene(raw) (setFog, setLights). A plane 8 units wide at
// z = 0 fills the view; nothing turns at a pixel centre and nothing is undefined.
const full = [-1, -1, 1, -1, 1, 1, -1, 1];
const quadIndex = [0, 1, 2, 0, 2, 3];

const lightsAndFog = `
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 ambientLight;
uniform Point pointLights[3];
uniform int pointLightCount;
uniform Spot spotLights[2];
uniform int spotLightCount;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float fogDensity;
uniform float fogHeight;
uniform float fogHeightFalloff;
// The light's window clamp(1 - (d / range)^4, 0, 1)^2 (0 is unlimited) and falloff 1 / max(d^decay, 2^-12).
float reach(float d, float range, float decay) {
  float w = 1.0;
  if (range > 0.0) { float x = d / range; w = clamp(1.0 - x * x * x * x, 0.0, 1.0); w *= w; }
  return w / max(pow(d, decay), 1.0 / 4096.0);
}
vec3 shade(vec3 p) {
  vec3 n = normalize(vec3(p.xy * 0.2, 1.0));
  vec3 c = ambientLight * 0.5 + sunColor * max(dot(n, sunDirection), 0.0) * 0.3;
  for (int i = 0; i < 3; i++) {
    if (i >= pointLightCount) break;
    vec3 l = pointLights[i].position - p;
    float d = length(l);
    c += pointLights[i].color * max(dot(n, l / d), 0.0) * reach(d, pointLights[i].range, pointLights[i].decay) * 0.5;
  }
  for (int i = 0; i < 2; i++) {
    if (i >= spotLightCount) break;
    vec3 l = spotLights[i].position - p;
    float d = length(l);
    float cone = smoothstep(spotLights[i].outerCos, spotLights[i].innerCos, dot(-l / d, spotLights[i].direction));
    c += spotLights[i].color * cone * reach(d, spotLights[i].range, spotLights[i].decay);
  }
  // Margo's fog: linear from near to far, or exp2 with a density, thinned above its height.
  float dist = length(p - vec3(0.0, 0.0, 6.0));
  float f = fogDensity > 0.0 ? 1.0 - exp(-fogDensity * fogDensity * dist * dist) : clamp((dist - fogNear) / max(fogFar - fogNear, 1e-6), 0.0, 1.0);
  f *= exp(-fogHeightFalloff * max(p.y - fogHeight, 0.0));
  return mix(c, fogColor, f);
}`;
const structs = `struct Point { vec3 position; vec3 color; float range; float decay; };
struct Spot { vec3 position; vec3 direction; vec3 color; float range; float decay; float outerCos; float innerCos; };`;

const first = {
  lighting: { direction: [1, 2, 3, 1.5], radiance: [1, 0.9, 0.8, 0.4], ambient: [0.5, 0.7, 1] },
  fog: { color: '#4080c0', near: 3, far: 12, height: -1, heightFalloff: 0.3 },
  lights: {
    intensityScale: 0.8,
    list: [
      { position: [-2, 1, 2], range: 8, color: [1, 0.5, 0.2], intensity: 2 },
      {
        position: [0, 3, 3],
        range: 12,
        direction: [0, -1, -1],
        angle: 0.7,
        penumbra: 0.4,
        color: [0.2, 1, 0.4],
        intensity: 3,
      },
      { position: [2, -1, 1.5], range: 0, decay: 1 },
      { position: [1, 2, 2.5], range: 6, color: [0.3, 0.3, 1] },
      // A fourth point light: the program's list holds three.
      { position: [-1, -2, 1], range: 9, color: [1, 1, 1], intensity: 5 },
    ],
  },
};
const second = {
  lighting: { direction: [-1, 1, 2, 1], radiance: [0.6, 0.8, 1, 0.25], ambient: [1, 1, 1] },
  fog: { color: '#c08040', density: 0.15, height: 0.5, heightFalloff: 0.2 },
  lights: {
    intensityScale: () => 1.2,
    list: [
      {
        position: [3, 0, 2],
        direction: [-1, 0, -1],
        outerAngle: 0.9,
        innerAngle: 0.3,
        range: 10,
        decay: 1.5,
        color: [1, 0.8, 0.2],
      },
      { position: [-2, 2, 2], range: 7, color: [0.4, 0.6, 1], intensity: 2 },
    ],
  },
};

export const sceneFixtures = [
  {
    name: 'lights: true and fog: true (GLSL ES 3.00): sun, ambient, point and spot lists and fog, then a changed scene',
    vertex: `#version 300 es
in vec2 position;
out vec3 vWorld;
void main() { vWorld = vec3(position * 4.0, 0.0); gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
out vec4 color;
${structs}
${lightsAndFog}
void main() { color = vec4(shade(vWorld), 1.0); }`,
    attributes: { position: { data: full, size: 2 } },
    index: quadIndex,
    uniforms: {},
    cull: 'none',
    options: { lights: true, fog: true, builtins: false },
    scene: [first, second],
  },
  {
    name: 'lights: true and fog: true (GLSL ES 1.00): the second scene first',
    vertex: `attribute vec2 position;
varying vec3 vWorld;
void main() { vWorld = vec3(position * 4.0, 0.0); gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `precision highp float;
varying vec3 vWorld;
${structs}
${lightsAndFog}
void main() { gl_FragColor = vec4(shade(vWorld), 1.0); }`,
    attributes: { position: { data: full, size: 2 } },
    index: quadIndex,
    uniforms: {},
    cull: 'none',
    options: { lights: true, fog: true, builtins: false },
    scene: [second, first],
  },
];
