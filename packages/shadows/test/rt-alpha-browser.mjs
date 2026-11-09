import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';

import { closeAll, runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
const browser = await openBrowser({ port: 'free', compat: false });
const errors = [];
browser.page.on('pageerror', e => errors.push(e.message));
await runSuite(async () => {
  const report = await browser.page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { MeshBVH, Raycaster } = await import('/packages/bvh/dist/index.js');
    const { AlphaRaycaster, modelAlphaMasks } = await import('/packages/bvh/dist/alpha.js');
    const { alphaWorldTriangles } = await import('/packages/bvh/dist/alpha-triangles.js');
    const { GPUMeshBVH, bvhWGSL } = await import('/packages/bvh/dist/gpu.js');
    const { packRayTracedAlpha, createRayTracedAlpha, alphaRayTracedFilter } = await import('/packages/shadows/dist/rt-alpha.js');
    const check = (v, msg) => { if (!v) throw new Error(msg); };
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 96;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', capacity: 1024 });
    const device = engine.gpu;
    const gpuErrors = [];
    device.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
    device.pushErrorScope('validation');
    const model = await loadGLTF(engine, '/examples/assets/khronos/AlphaBlendModeTest/AlphaBlendModeTest.glb');
    const rows = [];
    try {
      for (const rotated of [false, true]) {
        if (rotated) for (const p of model.primitives) {
          const map = p.material.maps[0];
          if (p.material.settings[0] === 1 && map) map.extensions = { KHR_texture_transform: { offset: [0.75, 0.25], rotation: Math.PI / 2, scale: [0.75, 0.5] } };
        }
        const source = await modelAlphaMasks(model);
        check(source.skipped.length === 0, 'real model has unread masks');
        const triangles = alphaWorldTriangles(engine, [model]);
        const packed = packRayTracedAlpha(triangles, source);
        const bvh = MeshBVH.build({ positions: triangles.vertices, indices: triangles.indices });
        check(bvh.triangles.some((f, i) => f !== i), 'tree must permute source faces');
        const cpu = new AlphaRaycaster(); cpu.alphaMask = source; cpu.firstHitOnly = true;
        const plain = new Raycaster(); plain.firstHitOnly = true;
        const input = [], expected = [];
        let holes = 0, solid = 0;
        for (let y = 0.05; y <= 2.6; y += 0.13) for (let x = -2.8; x <= 2.8; x += 0.11) {
          const origin = [Math.fround(x), Math.fround(y), 7];
          const hit = cpu.set(origin, [0, 0, -1]).intersectObjects(engine, [model])[0];
          const nearest = plain.set(origin, [0, 0, -1]).intersectObjects(engine, [model])[0];
          if (nearest && (!hit || nearest.distance < hit.distance - 1e-5)) holes++;
          if (hit) solid++;
          input.push(...origin, 0);
          expected.push(hit?.distance ?? null);
        }
        check(holes > 20 && solid > 20, `insufficient real coverage ${holes}/${solid}`);
        const alpha = createRayTracedAlpha(packed), tree = GPUMeshBVH.forShader(device, bvh);
        try {
          // Re-setup exercises immutable coverage restoration on real GPU buffers.
          for (let restore = 0; restore < 2; restore++) {
            alpha.setup(device);
            const code = `${bvhWGSL({ accept: 'shadowFxAlphaAccept' })}\n${alpha.wgsl(0, 5)}
              @group(0) @binding(6) var<storage,read_write> answer:array<vec4f>;
              @group(0) @binding(7) var<storage,read> origins:array<vec4f>;
              @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
                if(id.x>=arrayLength(&origins)){return;}
                let a=bvhClosest(origins[id.x].xyz,vec3f(0,0,-1),0,100,0u);
                let b=bvhAny(origins[id.x].xyz,vec3f(0,0,-1),0,100,0u);
                answer[id.x]=vec4f(a.distance,select(0.0,1.0,a.face!=BVH_MISS),select(0.0,1.0,b.face!=BVH_MISS),0);
              }`;
            const module = device.createShaderModule({ code });
            const info = await module.getCompilationInfo();
            check(info.messages.every(m => m.type !== 'error'), info.messages.map(m => m.message).join('\n'));
            const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
            const bytes = input.length * 4;
            const rays = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            const out = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
            const read = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
            try {
              device.queue.writeBuffer(rays, 0, Float32Array.from(input));
              const entries = [...tree.bindings(), { binding: 5, resource: alpha.resources()[0] }, { binding: 6, resource: { buffer: out } }, { binding: 7, resource: { buffer: rays } }];
              const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
              const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
              pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(expected.length / 64)); pass.end();
              encoder.copyBufferToBuffer(out, 0, read, 0, bytes); device.queue.submit([encoder.finish()]);
              await read.mapAsync(GPUMapMode.READ);
              const actual = new Float32Array(read.getMappedRange());
              expected.forEach((distance, i) => {
                check(actual[i * 4 + 1] === +(distance !== null), `closest coverage ${rotated}/${restore}/${i}`);
                check(actual[i * 4 + 2] === +(distance !== null), `any coverage ${rotated}/${restore}/${i}`);
                if (distance !== null) check(Math.abs(actual[i * 4] - distance) < 1e-4, `distance ${i}`);
              });
              read.unmap();
            } finally { rays.destroy(); out.destroy(); read.destroy(); }
          }
        } finally { alpha.dispose(); tree.dispose(); }
        const filter = alphaRayTracedFilter(engine, bvh, packed, { rays: 1, lightSize: 0, bias: 0.001, far: 100 });
        check(typeof filter === 'object', 'real adapter needs fragment storage');
        const width = 64, height = Math.ceil(expected.length / width), bytes = width * height * 16;
        const rays = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const image = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const read = device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          device.queue.writeBuffer(rays, 0, Float32Array.from(input));
          for (let restore = 0; restore < 2; restore++) {
            filter.setup(device);
            filter.update({ light: [0, 0, -1], context: { device } });
            const code = `${filter.wgsl(0, 0)}
              @group(0) @binding(7) var<storage,read> origins:array<vec4f>;
              fn shadowNoise(position:vec3f)->vec2f{return vec2f(0);}
              fn visibility(position:vec3f,normal:vec3f)->f32{${filter.body}}
              @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
                let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);
              }
              @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{
                let at=u32(p.y)*64u+u32(p.x);let v=visibility(origins[at].xyz,vec3f(0,0,-1));return vec4f(v,v,v,1);
              }`;
            const module = device.createShaderModule({ code });
            const info = await module.getCompilationInfo();
            check(info.messages.every(m => m.type !== 'error'), info.messages.map(m => m.message).join('\n'));
            const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
            const entries = [...filter.resources().map((resource, binding) => ({ binding, resource })), { binding: 7, resource: { buffer: rays } }];
            const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
            const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: image.createView(), clearValue: [0.5, 0.5, 0.5, 1], loadOp: 'clear', storeOp: 'store' }] });
            pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
            encoder.copyTextureToBuffer({ texture: image }, { buffer: read, bytesPerRow: width * 4 }, [width, height]);
            device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
            const actual = new Uint8Array(read.getMappedRange());
            expected.forEach((distance, i) => check(actual[i * 4] === (distance === null ? 255 : 0), `fragment coverage ${rotated}/${restore}/${i}: ${actual[i * 4]}`));
            read.unmap();
          }
        } finally { filter.dispose(); rays.destroy(); image.destroy(); read.destroy(); }
        check(alphaRayTracedFilter({ gpu: null }, bvh, packed, { fallback: 'hard' }) === 'hard', 'compat fallback');
        rows.push({ rotated, rays: expected.length, holes, solid, restores: 2 });
      }
      const validation = await device.popErrorScope();
      check(!validation, validation?.message);
      check(gpuErrors.length === 0, gpuErrors.join('\n'));
      return rows;
    } finally { model.dispose(); engine.dispose(); canvas.remove(); }
  });
  assert.deepEqual(errors, []);
  writeFileSync('test-results/shadows-rt-alpha.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}, async () => {
  try { await closeAll({ browser }); } finally { watchExit(); }
});
