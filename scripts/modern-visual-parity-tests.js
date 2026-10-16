import assert from 'node:assert/strict';
import {openBrowser} from './browser.js';
import {prepareThreeReference, THREE_REFERENCE_VERSION} from './three-reference.js';

const reference = await prepareThreeReference();
const browser = await openBrowser({startPath: '/tests/modern-extension.html'}), errors = [];
browser.page.on('pageerror', e => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async referenceModule => {
    const THREE = await import(referenceModule);
    const {acesShader} = await import('/packages/shared/aces.js');
    const {pbrShader} = await import('/packages/gltf-pro/src/shader.ts');
    const {Engine} = await import('/packages/core/dist/index.js');
    const {parseMargo} = await import('/packages/blender/dist/index.js');
    const {SSAO, Bloom} = await import('/packages/post/dist/index.js');
    const {Selection} = await import('/packages/selection/dist/index.js');
    const {DOF} = await import('/packages/dof/dist/index.js');
    const {Tonemap} = await import('/packages/tonemap/dist/index.js');
    const {PointsPlugin, PointCloud} = await import('/packages/points/dist/index.js');
    const {Lines, Line} = await import('/packages/lines/dist/index.js');
    const {box} = await import('/packages/core/dist/index.js');
    const assert = (value, message) => {if (!value) throw new Error(message);};
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:128px;height:128px'; document.body.append(canvas);
    const engine = await Engine.create(canvas, {backend: 'webgpu', capacity: 16, camera: {position: [0, 0, 3]}});
    const device = engine.gpu; device.pushErrorScope('validation');
    const bytes = await (await fetch('/packages/blender/tests/fixtures/cad-triangle.margo')).arrayBuffer();
    const model = await parseMargo(engine, bytes);
    engine.render(); canvas.style.width = '160px'; engine.render();
    const mesh = engine.createMesh().setGeometry(box());
    const points = new PointsPlugin(); engine.use(points);
    points.add(new PointCloud({positions: new Float32Array([0,0,1]), material: {size: 8, edl: true}})); engine.render(); engine.removePlugin(points.name);
    const lines = new Lines(); engine.use(lines); lines.add(new Line({positions: [-1,0,1,1,0,1]})); engine.render(); engine.removePlugin(lines.name);
    const outline = Selection.attach(engine); outline.set([mesh]); engine.render(); outline.dispose();
    const ssao = SSAO.attach(engine, {samples: 4}); ssao.add(model); engine.render(); ssao.dispose();
    const bloom = Bloom.attach(engine); engine.render(); bloom.dispose(); engine.render();
    const dof = DOF.attach(engine); engine.render(); dof.dispose();
    const tonemap = Tonemap.attach(engine); engine.render(); tonemap.dispose(); engine.render();
    await device.queue.onSubmittedWorkDone();
    const validation = await device.popErrorScope(); assert(!validation, validation?.message);

    const colors = [[0,0,0], [0.18,0.18,0.18], [1,1,1], [4,0.25,0.1], [0.01,3,0.3], [100,100,100]];
    const surface = /struct Surface \{[^}]+\}/.exec(pbrShader)[0];
    const ambient = /fn hemisphere_ambient\(s:Surface\)->vec3f \{[\s\S]*?\n\}/.exec(pbrShader)[0]+'\n'+/fn ambient\(s:Surface\)->vec3f \{[\s\S]*?\n\}/.exec(pbrShader)[0];
    const code = `${acesShader}\n${surface}\nstruct Frame {radiance:vec4f}\n@group(0) @binding(0) var<uniform> f:Frame;\n${ambient}
      @group(0) @binding(1) var<storage,read_write> output:array<vec4f>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
        let colors=array<vec3f,6>(${colors.map(c => `vec3f(${c.join(',')})`).join(',')});
        if(id.x<6){output[id.x]=vec4f(aces(colors[id.x]/0.6),1);return;}
        var s:Surface;s.base=vec4f(0.5,0.5,0.5,1);s.metal=select(0.0,1.0,id.x==9);s.occlusion=1;
        s.n=vec3f(0,1.0-f32(min(id.x-6,2u)),0);output[id.x]=vec4f(ambient(s),1);
      }`;
    device.pushErrorScope('validation');
    const uniform = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    const output = device.createBuffer({size: 160, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    const read = device.createBuffer({size: 160, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    device.queue.writeBuffer(uniform, 0, new Float32Array([1,1,1,0.15]));
    const pipeline = device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
    const bind = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: uniform}}, {binding: 1, resource: {buffer: output}}]});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(10); pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, 160); device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(read.getMappedRange()).slice(); read.unmap();
    const shaderError = await device.popErrorScope(); assert(!shaderError, shaderError?.message);
    assert(values[24] > values[28] && values[28] > values[32] && values[32] > 0 && values[36] > 0, 'Hemispherical fill must illuminate side, ground and metallic surfaces');
    const reference = new THREE.WebGLRenderer({preserveDrawingBuffer: true}); reference.setSize(1,1);
    reference.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1,1,1,-1,0.1,10); camera.position.z = 1;
    const material = new THREE.MeshBasicMaterial(), plane = new THREE.PlaneGeometry(2,2); scene.add(new THREE.Mesh(plane,material));
    const gl = reference.getContext(), pixel = new Uint8Array(4), matches = [];
    const srgb = x => Math.round(255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1/2.4) - 0.055));
    for (let i=0;i<colors.length;i++) {
      material.color.setRGB(...colors[i]); reference.render(scene,camera); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      const margo = [...values.slice(i*4,i*4+3)].map(srgb);
      assert(margo.every((v,c) => Math.abs(v-pixel[c]) <= 1), `ACES differs from Three.js for ${colors[i]}: ${margo} vs ${pixel}`);
      matches.push({input: colors[i], margo, three: [...pixel.slice(0,3)]});
    }
    material.dispose(); plane.dispose(); reference.dispose(); uniform.destroy(); output.destroy(); read.destroy(); engine.dispose(); canvas.remove();
    return matches;
  }, reference.moduleUrl);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({hardware: browser.hardware, reference: {three: THREE_REFERENCE_VERSION}, checks: ['MSAA CAD + resize', 'points + EDL', 'lines', 'selection', 'SSAO', 'Bloom + restore', 'DOF', 'Tonemap', 'hemisphere fill'], aces: result}, null, 2));
} finally {await browser.close();}
