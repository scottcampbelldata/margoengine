// GPU pixels for /targets-depth (run natively and with --compat): cube, array and volume targets at 1 and 4 samples in
// rgba8unorm and rgba16float, per-surface reversed depth that keeps the nearer draw, and area-filtered odd mips.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { DepthTextureRenderTarget } = await import('/packages/creative/dist/targets-depth.js');
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const errors = []; device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const check = (ok, msg) => { if (!ok) throw new Error(msg); };
    device.pushErrorScope('validation');
    let surfaces = 0;
    try {
      for (const kind of ['cube','array','3d']) for (const samples of [1,4]) for (const format of ['rgba8unorm','rgba16float']) {
        const t = new DepthTextureRenderTarget(device, { kind, width: 5, depthOrLayers: kind === 'cube' ? 6 : 5, mipLevelCount: 3, samples, format });
        const module = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0.8,1);
}
@fragment fn fs()->@location(0) vec4f { return vec4f(0,1,0,1); }` });
        const pipeline = device.createRenderPipeline({ layout:'auto', vertex:{module,entryPoint:'vs'}, fragment:{module,entryPoint:'fs',targets:[{format}]}, depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'}, multisample:{count:samples} });
        const encoder = device.createCommandEncoder();
        for(let layer=0;layer<t.mipSize()[2];layer++) {
          const p = t.begin(encoder,{layer,clearColor:[1,0,0,1]}); p.setPipeline(pipeline); p.draw(3); p.end();
          // A second farther draw must fail reversed depth, retaining green.
          const p2 = t.begin(encoder,{layer,loadOp:'load',depthLoadOp:'load'}); p2.setPipeline(pipeline); p2.draw(3); p2.end();
        }
        t.generateMipmaps(encoder);
        const reads = [];
        for(let mip=0;mip<3;mip++) {
          const [w,h,d]=t.mipSize(mip);
          const buffer=device.createBuffer({size:256*h*d,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
          encoder.copyTextureToBuffer({texture:t.texture,mipLevel:mip},{buffer,bytesPerRow:256,rowsPerImage:h},[w,h,d]);
          reads.push({buffer,w,h,d});
        }
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        const error = await device.popErrorScope(); check(!error, error?.message); device.pushErrorScope("validation");
        for(const {buffer,w,h,d} of reads) {
          await buffer.mapAsync(GPUMapMode.READ); const data = new Uint8Array(buffer.getMappedRange());
          for(let z=0;z<d;z++) for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
            const i=(z*h+y)*256+x*(format==='rgba16float'?8:4);
            check(data[i]===0 && (format==='rgba8unorm'?data[i+1]===255:data[i+2]===0&&data[i+3]===60),`pixel ${kind} ${samples} ${format} ${w}x${h} ${x},${y},${z}: ${data.slice(i,i+8)}, ${errors.join(";")}`);
          }
          surfaces+=d; buffer.unmap(); buffer.destroy();
        }
        t.restore(device); t.begin(device.createCommandEncoder()).end(); t.dispose();
      }
      check(!(await device.popErrorScope()),'GPU validation'); check(!errors.length,errors.join('\n'));
      return {surfaces,depth:'occlusion preserved',msaa:'1 and 4',mips:'odd cube, array, volume',backend:globalThis.__margoCompat ? 'webgl2-compat' : 'webgpu'};
    } finally { device.destroy(); }
  });
  console.log(result);
  // 3 kinds x 2 sample counts x 2 formats over three mips: cube 6+6+6, array 5+5+5, volume 5+2+1 surfaces.
  assert.equal(result.surfaces, 164);
  assert.equal(result.backend, compatRun() ? 'webgl2-compat' : 'webgpu');
} finally { await browser.close(); }
