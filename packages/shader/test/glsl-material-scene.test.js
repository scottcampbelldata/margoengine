// ShaderMaterial's scene uniforms (lights: true, fog: true) and its own motion vectors for TAA (velocity): the names
// and types the linker accepts and refuses, the values a RawShaders hands them, and the WGSL of the velocity entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShaderMaterial, shaderScene, glslProgramToWGSL } from '../dist/glsl-material.js';
import { RawMesh, RawShaders } from '../dist/raw.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';

const vertex = `#version 300 es
in vec3 position;
in vec3 normal;
out vec3 vNormal;
out vec3 vWorld;
void main() { vNormal = normal; vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const lit = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
out vec4 color;
struct Point { vec3 position; vec3 color; float range; float decay; };
struct Spot { vec3 position; vec3 direction; vec3 color; float outerCos; float innerCos; };
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 ambientLight;
uniform Point pointLights[2];
uniform int pointLightCount;
uniform Spot spotLights[1];
uniform int spotLightCount;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float fogDensity;
uniform float fogHeight;
uniform float fogHeightFalloff;
void main() {
  vec3 c = ambientLight + sunColor * max(dot(normalize(vNormal), sunDirection), 0.0);
  for (int i = 0; i < 2; i++) { if (i >= pointLightCount) break; c += pointLights[i].color / max(distance(vWorld, pointLights[i].position), 1.0); }
  if (spotLightCount > 0) c += spotLights[0].color * smoothstep(spotLights[0].outerCos, spotLights[0].innerCos, 0.5);
  float d = length(vWorld);
  float f = fogDensity > 0.0 ? 1.0 - exp(-fogDensity * fogDensity * d * d) : clamp((d - fogNear) / max(fogFar - fogNear, 1e-6), 0.0, 1.0);
  color = vec4(mix(c, fogColor, f * exp(-fogHeightFalloff * max(vWorld.y - fogHeight, 0.0))), 1.0);
}`;
const quad = { position: { data: [-1, -1, 0, 1, -1, 0, 1, 1, 0], type: 'vec3f' }, normal: { data: [0, 0, 1, 0, 0, 1, 0, 0, 1], type: 'vec3f' } };
// A RawShaders as a drawn frame leaves it: its engine's lighting, a fog and a light list.
const sceneOf = ({ lighting, fog = null, lights = null }) => {
  const raw = new RawShaders();
  raw['engine'] = { lighting };
  shaderScene(raw).setFog(fog).setLights(lights);
  return raw;
};
const lighting = { direction: new Float32Array([0, 3, 4, 2]), radiance: new Float32Array([1, 0.5, 0.25, 0.2]), ambient: new Float32Array([1, 2, 3]) };
const close = (a, b, what) => [a].flat().forEach((v, i) => assert.ok(Math.abs(v - [b].flat()[i]) < 1e-6, `${what}[${i}]: ${v} vs ${[b].flat()[i]}`));

test('lights and fog: the scene fills the uniforms the program declares, by Margo name', () => {
  const m = new ShaderMaterial({ vertexShader: vertex, fragmentShader: lit, lights: true, fog: true });
  assert.deepEqual([...m.program.scene].sort(), ['ambientLight', 'fogColor', 'fogDensity', 'fogFar', 'fogHeight', 'fogHeightFalloff', 'fogNear', 'pointLightCount', 'pointLights', 'spotLightCount', 'spotLights', 'sunColor', 'sunDirection']);
  const mesh = new RawMesh({ material: m, attributes: quad });
  assert.doesNotThrow(() => checkWGSL(m.code('vertex', mesh)));
  assert.doesNotThrow(() => checkWGSL(m.code('fragment', mesh)));
  const lights = {
    intensityScale: () => 0.5,
    list: [
      { position: [1, 2, 3], range: 10, color: [1, 0, 0], intensity: 4 },
      { position: [0, 5, 0], range: 8, direction: [0, -2, 0], angle: 0.6, penumbra: 0.5, decay: 1 },
      { position: [4, 0, 0], range: 0 },
      { position: [9, 9, 9], range: 1 },
    ],
  };
  m.drawnBy = sceneOf({ lighting, fog: { color: '#808080', near: 2, far: 30, height: 1, heightFalloff: 0.5 }, lights });
  const v = (name) => m.uniforms[name].value;
  close(v('sunDirection'), [0, 0.6, 0.8], 'sunDirection');
  close(v('sunColor'), [2, 1, 0.5], 'sunColor: radiance times intensity');
  close(v('ambientLight'), [0.2, 0.4, 0.6], 'ambientLight: ambient times radiance w');
  // The default output space writes display-ready colour, so the fog colour arrives sRGB encoded, as it was given.
  close(v('fogColor'), [128 / 255, 128 / 255, 128 / 255], 'fogColor');
  assert.deepEqual([v('fogNear'), v('fogFar'), v('fogDensity'), v('fogHeight'), v('fogHeightFalloff')], [2, 30, 0, 1, 0.5]);
  // Two of the three point lights fit the declared array; the spot's cone is cos(angle) to cos(angle (1 - penumbra)).
  assert.equal(v('pointLightCount'), 2);
  assert.equal(v('spotLightCount'), 1);
  close(v('pointLights')[0].color, [2, 0, 0], 'point colour times intensity and intensityScale');
  assert.deepEqual(v('pointLights')[0].position, [1, 2, 3]);
  assert.equal(v('pointLights')[0].decay, 2);
  assert.deepEqual([v('pointLights')[1].position, v('pointLights')[1].range], [[4, 0, 0], 0]);
  const spot = v('spotLights')[0];
  close(spot.direction, [0, -1, 0], 'spot direction');
  close([spot.outerCos, spot.innerCos, spot.decay], [Math.cos(0.6), Math.cos(0.3), 1], 'spot cone');
  assert.throws(() => (m.uniforms.sunColor.value = [1, 1, 1]), /comes from the scene; give it in uniforms/);
});

test('fog colour is linear for a program that writes linear light, and no fog reads as Fog switched off', () => {
  const m = new ShaderMaterial({ vertexShader: vertex, fragmentShader: lit, lights: true, fog: true, outputColorSpace: 'linear' });
  m.drawnBy = sceneOf({ lighting, fog: { color: '#ff8000', density: 0.1 } });
  close(m.uniforms.fogColor.value, [1, Math.fround(((128 / 255 + 0.055) / 1.055) ** 2.4), 0], 'linear fog colour');
  assert.equal(m.uniforms.fogDensity.value, Math.fround(0.1));
  const none = new ShaderMaterial({ vertexShader: vertex, fragmentShader: lit, lights: true, fog: true });
  none.drawnBy = sceneOf({ lighting });
  assert.deepEqual([none.uniforms.fogDensity.value, none.uniforms.fogNear.value, none.uniforms.fogFar.value, none.uniforms.pointLightCount.value], [0, 3.4028234663852886e38, 3.4028234663852886e38, 0]);
  close(none.uniforms.fogColor.value, [0, 0, 0], 'no fog colour');
});

test('without lights or fog, or set in uniforms, the names are the caller\'s own uniforms', () => {
  const plain = new ShaderMaterial({ vertexShader: vertex, fragmentShader: lit });
  assert.deepEqual(plain.program.scene, []);
  assert.deepEqual(plain.uniforms.sunColor.value, [0, 0, 0]);
  const own = new ShaderMaterial({ vertexShader: vertex, fragmentShader: lit, lights: true, uniforms: { sunColor: { value: [3, 3, 3] } } });
  assert.ok(!own.program.scene.includes('sunColor') && own.program.scene.includes('sunDirection') && !own.program.scene.includes('fogColor'));
  own.drawnBy = sceneOf({ lighting });
  assert.deepEqual(own.uniforms.sunColor.value, [3, 3, 3]);
});

test('a scene name of the wrong type, or a light struct with an unknown field, is refused at its line', () => {
  const fragment = (decl) => `#version 300 es\nprecision highp float;\nout vec4 color;\n${decl}\nvoid main() { color = vec4(1.0); }`;
  const refused = (decl, pattern, line) =>
    assert.throws(() => new ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment(decl), lights: true, fog: true }), (e) => {
      assert.match(e.message, pattern);
      assert.equal(e.stage, 'fragment');
      assert.equal(e.line, line);
      return true;
    });
  refused('uniform float sunColor;', /uniform sunColor is the scene's vec3 under lights; declare it vec3/, 4);
  refused('uniform vec4 fogColor;', /fogColor is the scene's vec3 under fog/, 4);
  refused('uniform vec3 pointLights[2];', /pointLights is the scene's light list under lights; declare it an array of a struct/, 4);
  refused('struct P { vec3 position; float radius; };\nuniform P pointLights[2];', /pointLights field radius is not a light field; use position, color, range, decay/, 4);
  refused('struct S { vec3 position; vec2 direction; };\nuniform S spotLights[1];', /spotLights field direction must be vec3/, 4);
});

test('shaderScene: one scene per RawShaders, and setFog and setLights check what they are given', () => {
  const raw = new RawShaders(),
    scene = shaderScene(raw);
  assert.equal(shaderScene(raw), scene);
  assert.notEqual(shaderScene(new RawShaders()), scene);
  assert.equal(scene.fog, null);
  assert.equal(scene.lights, null);
  assert.throws(() => shaderScene({}), /shaderScene needs the RawShaders/);
  assert.throws(() => scene.setFog(5), TypeError);
  assert.throws(() => scene.setFog({ near: -1 }), RangeError);
  assert.throws(() => scene.setLights({}), /setLights needs a Clustered/);
  const lights = { list: [] };
  assert.equal(scene.setLights(lights).lights, lights);
  assert.equal(scene.setFog(null).fog, null);
  // The raw entry carries no scene of its own: plain RawShaderMaterial users pay nothing for it.
  assert.equal('setFog' in raw, false);
  assert.equal('setLights' in raw, false);
});

test('glslProgramToWGSL of the glsl-material entry links the scene options too', () => {
  const p = glslProgramToWGSL({ vertexShader: vertex, fragmentShader: lit, lights: true, fog: true });
  assert.ok(p.scene.includes('sunDirection') && p.scene.includes('fogColor'));
});

const moved = `#version 300 es
in vec3 position;
uniform float shift;
float scale = 1.0;
void main() { scale *= 2.0; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position * scale * 0.5 + vec3(shift, 0.0, 0.0), 1.0); }`;
const plainFragment = '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4(1.0); }';

test('velocity: a second run of main with last frame\'s matrices and the named uniforms\' last values', () => {
  const m = new ShaderMaterial({ vertexShader: moved, fragmentShader: plainFragment, velocity: { shift: 'shiftBefore' }, uniforms: { shift: { value: 1 }, shiftBefore: { value: 0.5 } } });
  assert.equal(m.velocityName, 'margoGLSLVelocity');
  assert.equal(m.program.velocity, true);
  assert.ok(m.program.uniforms.some((u) => u.name === 'shiftBefore' && u.glsl === 'float'), 'the last-frame uniform is declared for the program');
  const mesh = new RawMesh({ material: m, attributes: { position: quad.position } }),
    code = m.code('vertex', mesh);
  assert.doesNotThrow(() => checkWGSL(code));
  const entry = code.slice(code.indexOf('@vertex fn margoGLSLVelocity'));
  assert.match(code, /struct GLSLVaryings\{@builtin\(position\) @invariant clip:vec4f/);
  assert.match(entry, /margoNow_modelMatrix=mesh\.world;[\s\S]*margoNow_shift=uniforms\.user_shift;[\s\S]*let margoKept_user_scale=user_scale;/);
  assert.match(entry, /user_scale=margoKept_user_scale;\nglsl_Position=margoKept_glsl_Position;|glsl_Position=margoKept_glsl_Position;[\s\S]*user_scale=margoKept_user_scale;/);
  assert.match(entry, /margoNow_modelMatrix=margoBefore\.world;[\s\S]*margoNow_projectionMatrix=margoGLProjectionBefore\(\);[\s\S]*margoNow_shift=uniforms\.user_shiftBefore;/);
  assert.match(entry, /margoNow_viewMatrix=camera\.view;[\s\S]*margoNow_viewMatrix=camera\.view;/, 'the view stays this frame\'s: last frame\'s projection takes the camera\'s move');
  assert.match(entry, /return MargoVelocity\(margoClip,margoPrevious\);/);
  assert.match(code, /fn margoBeforeProjection\(\)->mat4x4f\{return margoBefore\.viewProjection\*margoViewInverse\(\);\}/);
  // Without velocity nothing of it is emitted, so the other programs' WGSL is unchanged.
  const still = new ShaderMaterial({ vertexShader: moved, fragmentShader: plainFragment });
  assert.doesNotMatch(still.code('vertex'), /margoNow_|margoGLSLVelocity|@invariant/);
  assert.equal(still.velocityName, undefined);
});

test('velocity: true moves with the engine\'s matrices alone; a wrong uniform map is refused', () => {
  const m = new ShaderMaterial({ vertexShader: moved, fragmentShader: plainFragment, velocity: true, uniforms: { shift: { value: 0 } } });
  assert.match(m.code('vertex'), /@vertex fn margoGLSLVelocity/);
  assert.throws(() => new ShaderMaterial({ vertexShader: moved, fragmentShader: plainFragment, velocity: { lift: 'liftBefore' } }), /velocity names uniform lift, which the program does not declare/);
  assert.throws(() => new ShaderMaterial({ vertexShader: moved, fragmentShader: plainFragment, velocity: { modelMatrix: 'oldModel' } }), /the engine's matrices follow by themselves/);
  assert.throws(() => new ShaderMaterial({ vertexShader: moved, fragmentShader: plainFragment, velocity: { shift: 'shift' } }), /must name another uniform/);
  assert.throws(() => new ShaderMaterial({ vertexShader: moved, fragmentShader: plainFragment, velocity: 'yes' }), /velocity must be true, false or/);
  const typed = moved.replace('uniform float shift;', 'uniform float shift;\nuniform vec2 shiftBefore;');
  assert.throws(() => new ShaderMaterial({ vertexShader: typed, fragmentShader: plainFragment, velocity: { shift: 'shiftBefore' } }), /names shiftBefore, a vec2; give it the type of shift \(float\)/);
});
