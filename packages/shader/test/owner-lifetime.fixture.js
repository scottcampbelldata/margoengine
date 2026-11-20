// Owner and lifetime fixtures of @margoengine/shader: each plugin is made, drawn and disposed by the owner checks
// (npm run check:owners -- --packages=shader), on the CPU adapter and in a browser on WebGPU and the WebGL2 layer.
// The raw plugin draws a GLSL ShaderMaterial mesh, so a GLSL program's pipelines and buffers are owned and released too,
// a PostStack runs a NodePass, drawn inside each view of a multi-view frame,
// a PostStack runs a GLSL ShaderPass, whose camera block, triangle and pipeline the pass owns, and an attached
// Shadertoy draws its texture and owns it, with the blanks of its unbound channels.
const vertexShader = `attribute vec3 position;
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const fragmentShader = `precision highp float;
varying vec2 vUv;
uniform vec3 tint;
void main() { gl_FragColor = vec4(vUv, 0.5, 1.0) * vec4(tint, 1.0); }`;
const passFragment = `precision highp float;
uniform sampler2D tDiffuse;
uniform float amount;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * amount, 1.0); }`;
const toySource = 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(fragCoord / iResolution.xy, texture(iChannel0, fragCoord / iResolution.xy).r, 1.0); }';
const quad = { positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], indices: [0, 1, 2, 0, 2, 3] };

export async function fixtures(load = (entry) => import(entry)) {
  const { RawShaders } = await load('../dist/raw.js');
  const { ShaderMaterial, shaderMesh } = await load('../dist/glsl-material.js');
  const { ShaderPass } = await load('../dist/glsl-pass.js');
  const { Shadertoy } = await load('../dist/shadertoy.js');
  const { PostStack } = await load('../../post/dist/stack.js');
  const { NodePass, inputColor } = await load('../dist/index.js');
  const glslMesh = (plugin) => {
    const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms: { tint: { value: [1, 0.5, 0.25] } } });
    plugin.add(shaderMesh(quad, material));
    return material;
  };
  return [
    {
      name: 'RawShaders with a GLSL ShaderMaterial',
      create() {
        const plugin = new RawShaders(),
          material = glslMesh(plugin);
        return { plugin, dispose: () => (plugin.dispose(), material.dispose()) };
      },
    },
    {
      name: 'RawShaders.attach with a GLSL ShaderMaterial',
      create({ engine }) {
        const plugin = RawShaders.attach(engine),
          material = glslMesh(plugin);
        return { plugin, dispose: () => (plugin.dispose(), material.dispose()) };
      },
    },
    {
      name: 'PostStack.attach with a NodePass',
      create({ engine }) {
        const pass = new NodePass(inputColor().mul(0.5)),
          plugin = PostStack.attach(engine, [pass]);
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => pass.dispose() };
      },
    },
    {
      name: 'PostStack.attach with a GLSL ShaderPass',
      create({ engine }) {
        const pass = new ShaderPass({ fragmentShader: passFragment, uniforms: { amount: { value: 0.5 } } }),
          plugin = PostStack.attach(engine, [pass]);
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => pass.dispose() };
      },
    },
    {
      name: 'Shadertoy attached, drawing its texture',
      create({ engine }) {
        const toy = new Shadertoy({ image: { source: toySource }, resolution: [16, 16] });
        toy.texture;
        engine.use(toy);
        return { plugin: toy, dispose: () => toy.dispose() };
      },
    },
    {
      name: 'PostStack.attach with a Shadertoy pass',
      create({ engine }) {
        const toy = new Shadertoy(toySource),
          plugin = PostStack.attach(engine, [toy.pass()]);
        return { plugin, dispose: () => plugin.dispose(), cleanup: () => toy.dispose() };
      },
    },
  ];
}
