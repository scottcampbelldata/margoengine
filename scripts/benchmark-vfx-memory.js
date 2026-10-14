import assert from 'node:assert/strict';
import {writeFile,appendFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
import {prepareSources} from './support/vfx-memory-candidate.js';

const baselineRef = process.argv[2], source = await prepareSources(baselineRef), browser = await openBrowser({startPath: '/tests/modern-game.html',port: 5199,args: []}), errors = [];
browser.page.on('pageerror',error => errors.push(error.message)); browser.page.on('console',message => {if (message.type() === 'error') errors.push(message.text());});
try {
  const result = await browser.page.evaluate(async ({shaders,billboardShader}) => {
    const assert = (value,message) => {if (!value) throw new Error(message);}, adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
    assert(adapter&&!adapter.info.isFallbackAdapter,'Native WebGPU adapter required'); assert(adapter.features.has('timestamp-query'),'Timestamp queries required');
    const d = await adapter.requestDevice({requiredFeatures: ['timestamp-query']}), resources = [], modules = [], uncaptured = [], names = ['original','full','partial'];
    d.addEventListener('uncapturederror',event => uncaptured.push(event.error.message)); d.pushErrorScope('validation'); let scopePending = true;
    const buffer = descriptor => {const b = d.createBuffer(descriptor); resources.push(b); return b;}, texture = descriptor => {const t = d.createTexture(descriptor); resources.push(t); return t;};
    const module = code => {const m = d.createShaderModule({code}); modules.push(m); return m;};
    const pipelines = shaders.map(code => d.createComputePipeline({layout: 'auto',compute: {module: module(code),entryPoint: 'main'}}));
    const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const header = (capacity,{dt = 1/60,time = 0.2,budget = 0,turbulence = 0.8,ground = 0.15,birthFixture = false} = {}) => {
      const values = new Float32Array(56), ints = new Uint32Array(values.buffer); values.set(identity); values[16] = values[21] = 1;
      values.set([0.13,-9.81,-0.27,dt],24); values.set([0,1,0.5,time],28); values.set([0.2,-0.8,0.1,1.2],32); values.set([0.3,0.2,0.6,0.7],36);
      values.set([0.035,0.4,1.2,ground],40); values.set([turbulence,1.7,0.55,-2.1],44); values.set([0.8,0.6,0.3,4],48);
      if (birthFixture) {values[25] = -10; values[29] = 0.1; values[33] = -2; values[35] = 0; values.set([0.1,3,3,0],40); values[44] = 0; values[46] = 0.5; values[48] = values[49] = values[50] = 0;}
      ints[52] = capacity; ints[53] = budget; return values;
    };
    const seed = (capacity,mixed = false) => {
      const data = new Float32Array(capacity*16);
      for (let i = 0; i < capacity; i++) {
        const offset = i*16;
        data.set([((i%97)/96-0.5)*1.5,((i%89)/88-0.5)*1.2,0.5+(i%13)*0.005,mixed&&i%7===0 ? 0.0001 : 1000+(i%31),
          (i%11-5)*0.017,-0.3-(i%17)*0.03,(i%19-9)*0.011,0.02+(i%3)*0.005,
          0.05+(i%5)*0.3,0.12+(i%7)*0.2,0.2+(i%3)*0.7,0.1+(i%9)*0.09,
          (i%37)*0.13,-2+(i%23)*0.15,1000+(i%31),(i%5)*0.25],offset);
      }
      return data;
    };
    const make = (capacity,variant) => {
      const stateBytes = capacity*64, storage = GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;
      const states = Array.from({length: variant ? 1 : 2},() => buffer({size: stateBytes,usage: storage}));
      const uniform = buffer({size: 224,usage: GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}), alive = buffer({size: capacity*4,usage: storage}), indirect = buffer({size: 20,usage: storage|GPUBufferUsage.INDIRECT}), respawn = buffer({size: 8,usage: storage});
      const groups = states.map((state,index) => d.createBindGroup({layout: pipelines[variant].getBindGroupLayout(0),entries: variant ?
        [{binding: 0,resource: {buffer: uniform}},{binding: 1,resource: {buffer: state}},{binding: 3,resource: {buffer: alive}},{binding: 4,resource: {buffer: indirect}},{binding: 5,resource: {buffer: respawn}}] :
        [uniform,state,states[1-index],alive,indirect,respawn].map((buffer,binding) => ({binding,resource: {buffer}}))}));
      d.queue.writeBuffer(indirect,0,new Uint32Array([6,0,0,0,0])); return {capacity,variant,stateBytes,states,uniform,alive,indirect,respawn,groups,front: 0};
    };
    const reset = (encoder,e,initial) => {for (const state of e.states) encoder.copyBufferToBuffer(initial,0,state,0,e.stateBytes); encoder.clearBuffer(e.respawn); e.front = 0;};
    const simulate = (encoder,e,uniforms,at,query,index) => {
      encoder.copyBufferToBuffer(uniforms,at,e.uniform,0,224); encoder.clearBuffer(e.indirect,4,4); encoder.clearBuffer(e.respawn,0,4);
      const pass = encoder.beginComputePass(index === undefined ? {} : {timestampWrites: {querySet: query,beginningOfPassWriteIndex: index,endOfPassWriteIndex: index+1}});
      pass.setPipeline(pipelines[e.variant]); pass.setBindGroup(0,e.groups[e.front]); pass.dispatchWorkgroups(Math.ceil(e.capacity/256)); pass.end(); if (!e.variant) e.front = 1-e.front;
    };
    const state = e => e.states[e.front];
    const compare = (words,a,b,count) => {let changed = 0,first = null; const fields = new Uint32Array(16); for (let i = 0; i < count; i++) if (words[a+i] !== words[b+i]) {changed++; fields[i%16]++; first ??= {word: i,field: i%16,original: words[a+i],candidate: words[b+i]};} return {changedWords: changed,fields: Array.from(fields),first};};
    const validatePopulation = (words,stateOffset,metadata,metaOffset,capacity) => {
      const floats = new Float32Array(words.buffer,words.byteOffset,words.length), count = metadata[metaOffset+1], seen = new Uint8Array(capacity); let alive = 0,invalid = 0;
      for (let i = 0; i < capacity; i++) {if (floats[stateOffset+i*16+3] > 0) alive++; for (let field = 0; field < 16; field++) if (!Number.isFinite(floats[stateOffset+i*16+field])) invalid++;}
      assert(metadata[metaOffset]===6&&metadata[metaOffset+2]===0&&metadata[metaOffset+3]===0&&metadata[metaOffset+4]===0,'Indirect ABI changed'); assert(count===alive,`Population mismatch ${count}/${alive}`); assert(invalid===0,'Nonfinite particle fields');
      for (let i = 0; i < count; i++) {const id = metadata[metaOffset+7+i]; assert(id < capacity&&!seen[id]&&floats[stateOffset+id*16+3] > 0,'Invalid/duplicate/dead live ID'); seen[id] = 1;}
      return {population: count,respawnCount: metadata[metaOffset+5],sequence: metadata[metaOffset+6],allIDsUniqueAndAlive: true,allFieldsFinite: true};
    };
    const capture = (encoder,e,read,offset,meta,metaOffset) => {encoder.copyBufferToBuffer(state(e),0,read,offset,e.stateBytes); encoder.copyBufferToBuffer(e.indirect,0,meta,metaOffset,20); encoder.copyBufferToBuffer(e.respawn,0,meta,metaOffset+20,8); encoder.copyBufferToBuffer(e.alive,0,meta,metaOffset+28,e.capacity*4);};
    const functional = async (capacity,kind,frames) => {
      const emitters = names.map((_,i) => make(capacity,i)), initialData = kind === 'no-respawn' ? seed(capacity,true) : new Float32Array(capacity*16), initial = buffer({size: initialData.byteLength,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}); d.queue.writeBuffer(initial,0,initialData);
      const headers = new Float32Array(frames.length*56); frames.forEach((config,i) => headers.set(header(capacity,config),i*56)); const uniforms = buffer({size: headers.byteLength,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}); d.queue.writeBuffer(uniforms,0,headers);
      const bytes = capacity*64, stride = 28+capacity*4, read = buffer({size: bytes*3*frames.length,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}), meta = buffer({size: stride*3*frames.length,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}), encoder = d.createCommandEncoder();
      emitters.forEach(e => reset(encoder,e,initial));
      for (let frame = 0; frame < frames.length; frame++) for (const e of emitters) {simulate(encoder,e,uniforms,frame*224); const index = frame*3+e.variant; capture(encoder,e,read,index*bytes,meta,index*stride);}
      d.queue.submit([encoder.finish()]); await Promise.all([read.mapAsync(GPUMapMode.READ),meta.mapAsync(GPUMapMode.READ)]);
      const words = new Uint32Array(read.getMappedRange()), metadata = new Uint32Array(meta.getMappedRange()), results = [];
      for (let frame = 0; frame < frames.length; frame++) {
        const populations = names.map((name,i) => ({name,...validatePopulation(words,(frame*3+i)*capacity*16,metadata,(frame*3+i)*stride/4,capacity)}));
        assert(populations.every(p => p.population===populations[0].population&&p.sequence===populations[0].sequence&&p.respawnCount===populations[0].respawnCount),'Population/birth count differs between variants');
        if (kind === 'births') {
          const floats = new Float32Array(words.buffer), values = header(capacity,frames[frame]);
          for (let variant = 0; variant < 3; variant++) for (let id = 0; id < capacity; id++) {
            const offset = (frame*3+variant)*capacity*16+id*16; if (floats[offset+3] <= 0) continue;
            for (let channel = 0; channel < 3; channel++) assert(floats[offset+8+channel]===Math.fround(values[36+channel]*values[51]),'Birth HDR color changed');
            assert(floats[offset+11]===values[39]&&floats[offset+7]===values[40]&&floats[offset+13]===values[47]&&floats[offset+15]===0,'Birth alpha/size/angular velocity/ABI changed');
            assert(floats[offset+14]>=values[41]-1e-6&&floats[offset+14]<=values[42]+1e-6&&floats[offset+3]<=floats[offset+14]+1e-6,'Birth lifetime/fade range changed');
            assert(floats[offset+1]>=values[43]+values[40]*0.5-1e-6,'Particle penetrated ground');
          }
        }
        const parity = names.slice(1).map((name,i) => ({name,...compare(words,frame*3*capacity*16,(frame*3+i+1)*capacity*16,capacity*16)}));
        if (capacity===1&&frame===0&&frames[frame].birthFixture) {const floats = new Float32Array(words.buffer); assert(floats[1]===Math.fround(0.05)&&floats[5]===2.25,'Deterministic birth/gravity/ground bounce fixture changed');}
        results.push({frame,config: frames[frame],populations,parityRequired: kind==='no-respawn'||capacity===1,parity});
      }
      read.unmap(); meta.unmap(); return {capacity,kind,recordBytes: 64,fields: 16,frames: results};
    };
    const renderQuality = async () => {
      const capacity = 257, emitters = names.map((_,i) => make(capacity,i)), data = seed(capacity), initial = buffer({size: data.byteLength,usage: GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}); d.queue.writeBuffer(initial,0,data);
      const headers = new Float32Array(4*56); for (let i = 0; i < 4; i++) headers.set(header(capacity,{dt: 0.04,time: 0.1+i*0.04}),i*56);
      const uniforms = buffer({size: headers.byteLength,usage: GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}); d.queue.writeBuffer(uniforms,0,headers);
      let encoder = d.createCommandEncoder(); emitters.forEach(e => reset(encoder,e,initial)); for (let frame = 0; frame < 4; frame++) for (const e of emitters) simulate(encoder,e,uniforms,frame*224);
      d.queue.submit([encoder.finish()]); await d.queue.onSubmittedWorkDone();
      // The production compaction is unordered. Fixed validated IDs isolate record/render parity from legal atomic ordering.
      for (const e of emitters) d.queue.writeBuffer(e.alive,0,Uint32Array.from({length: capacity},(_,i) => i));
      const index = buffer({size: 24,usage: GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}); d.queue.writeBuffer(index,0,new Uint32Array([0,1,2,2,1,3]));
      const shader = module(billboardShader), size = 256, bytes = size*size*8, images = buffer({size: bytes*6,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}); encoder = d.createCommandEncoder();
      for (const samples of [1,4]) {
        const pipeline = d.createRenderPipeline({layout: 'auto',vertex: {module: shader,entryPoint: 'vertex'},fragment: {module: shader,entryPoint: 'fragment',targets: [{format: 'rgba16float',blend: {color: {srcFactor: 'src-alpha',dstFactor: 'one-minus-src-alpha'},alpha: {srcFactor: 'one',dstFactor: 'one-minus-src-alpha'}}}]},multisample: {count: samples},depthStencil: {format: 'depth32float',depthWriteEnabled: false,depthCompare: 'greater-equal'}});
        const depth = texture({size: [size,size],sampleCount: samples,format: 'depth32float',usage: GPUTextureUsage.RENDER_ATTACHMENT}), depthView = depth.createView();
        encoder.beginRenderPass({colorAttachments: [],depthStencilAttachment: {view: depthView,depthLoadOp: 'clear',depthStoreOp: 'store',depthClearValue: 0}}).end();
        for (const e of emitters) {
          const color = texture({size: [size,size],sampleCount: samples,format: 'rgba16float',usage: GPUTextureUsage.RENDER_ATTACHMENT|(samples===1 ? GPUTextureUsage.COPY_SRC : 0)}), resolved = samples===1 ? color : texture({size: [size,size],format: 'rgba16float',usage: GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
          const group = d.createBindGroup({layout: pipeline.getBindGroupLayout(0),entries: [e.uniform,state(e),e.alive].map((buffer,binding) => ({binding,resource: {buffer}}))});
          const pass = encoder.beginRenderPass({colorAttachments: [{view: color.createView(),...(samples===4 ? {resolveTarget: resolved.createView()} : {}),loadOp: 'clear',storeOp: 'store',clearValue: [0,0,0,0]}],depthStencilAttachment: {view: depthView,depthReadOnly: true}});
          pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.setIndexBuffer(index,'uint32'); pass.drawIndexedIndirect(e.indirect,0); pass.end();
          encoder.copyTextureToBuffer({texture: resolved},{buffer: images,offset: (samples===1 ? e.variant : 3+e.variant)*bytes,bytesPerRow: size*8},[size,size]);
        }
      }
      d.queue.submit([encoder.finish()]); await images.mapAsync(GPUMapMode.READ); const pixels = new Uint16Array(images.getMappedRange()), reports = [];
      for (const [mode,samples] of [1,4].entries()) {
        const base = mode*3*bytes/2; let visiblePixels = 0,hdrPixels = 0,translucentPixels = 0,invalid = 0;
        const changes = [0,0];
        for (let pixel = 0; pixel < size*size; pixel++) {
          const at = base+pixel*4, alpha = pixels[at+3]; if (alpha) visiblePixels++; if (alpha>0&&alpha<0x3c00) translucentPixels++;
          if (pixels[at]>0x3c00||pixels[at+1]>0x3c00||pixels[at+2]>0x3c00) hdrPixels++;
          for (let variant = 0; variant < 3; variant++) for (let channel = 0; channel < 4; channel++) if ((pixels[at+variant*bytes/2+channel]&0x7c00)===0x7c00) invalid++;
          for (let variant = 1; variant <= 2; variant++) {let changed = false; for (let channel = 0; channel < 4; channel++) if (pixels[at+channel]!==pixels[at+variant*bytes/2+channel]) changed = true; if (changed) changes[variant-1]++;}
        }
        assert(visiblePixels>100&&translucentPixels>100&&hdrPixels>0,'Billboard seed did not exercise visible HDR/alpha'); assert(invalid===0,'Invalid billboard HDR output');
        reports.push({samples,pixels: size*size,visiblePixels,hdrPixels,translucentPixels,invalid,fullChangedPixels: changes[0],partialChangedPixels: changes[1],canonicalAliveOrder: true,actualIndirectDraw: true});
      }
      images.unmap(); return reports;
    };
    try {
      const functionalReports = [];
      functionalReports.push(await functional(4097,'no-respawn',[{dt: 0,time: 0.1},{dt: 1/60,time: 0.2},{dt: 0.05,time: 0.3,turbulence: 1.3},{dt: 0.08,time: 0.4,ground: 0.4}]));
      functionalReports.push(await functional(1,'births',[{dt: 0.25,time: 0.25,budget: 1,birthFixture: true},{dt: 0.05,time: 0.3,birthFixture: true},{dt: 4,time: 4.3,birthFixture: true},{dt: 0.25,time: 4.55,budget: 1,birthFixture: true},{dt: 0,time: 4.55,birthFixture: true}]));
      functionalReports.push(await functional(4097,'births',[{dt: 0.04,time: 0.1,budget: 1023},{dt: 0.04,time: 0.2,budget: 4097},{dt: 2,time: 2.2},{dt: 0.04,time: 2.3,budget: 17}]));
      const renderReports = await renderQuality();
      const capacity = 1000000, emitters = names.map((_,i) => make(capacity,i)), initialData = seed(capacity), initial = buffer({size: initialData.byteLength,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}); d.queue.writeBuffer(initial,0,initialData);
      const headers = new Float32Array(30*56); for (let i = 0; i < 30; i++) headers.set(header(capacity,{time: 0.2+i/60}),i*56);
      const uniforms = buffer({size: headers.byteLength,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}); d.queue.writeBuffer(uniforms,0,headers);
      const query = d.createQuerySet({type: 'timestamp',count: 80}); resources.push(query);
      const resolved = buffer({size: 640,usage: GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}), queryRead = buffer({size: 640,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const bytes = capacity*64, stride = 28+capacity*4, read = buffer({size: bytes*4,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}), meta = buffer({size: stride*4,usage: GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}), encoder = d.createCommandEncoder(), order = [];
      let timestamp = 0;
      for (let candidate = 1; candidate <= 2; candidate++) {
        const left = emitters[0], right = emitters[candidate]; reset(encoder,left,initial); reset(encoder,right,initial);
        for (let warm = 0; warm < 20; warm++) for (const e of [left,right]) simulate(encoder,e,uniforms,warm*224);
        for (let pair = 0; pair < 10; pair++) for (const e of pair%2 ? [right,left] : [left,right]) {order.push({candidate: names[candidate],pair,variant: names[e.variant],timestamp}); simulate(encoder,e,uniforms,(20+pair)*224,query,timestamp); timestamp += 2;}
        const offset = (candidate-1)*2; capture(encoder,left,read,offset*bytes,meta,offset*stride); capture(encoder,right,read,(offset+1)*bytes,meta,(offset+1)*stride);
      }
      encoder.resolveQuerySet(query,0,80,resolved,0); encoder.copyBufferToBuffer(resolved,0,queryRead,0,640);
      d.queue.submit([encoder.finish()]); await Promise.all([queryRead.mapAsync(GPUMapMode.READ),read.mapAsync(GPUMapMode.READ),meta.mapAsync(GPUMapMode.READ)]);
      const timestamps = new BigUint64Array(queryRead.getMappedRange()), words = new Uint32Array(read.getMappedRange()), metadata = new Uint32Array(meta.getMappedRange());
      const quality = [], timedReports = [];
      for (let candidate = 1; candidate <= 2; candidate++) {
        const offset = (candidate-1)*2, originalState = offset*capacity*16, candidateState = (offset+1)*capacity*16;
        const originalPopulation = validatePopulation(words,originalState,metadata,offset*stride/4,capacity), candidatePopulation = validatePopulation(words,candidateState,metadata,(offset+1)*stride/4,capacity);
        assert(originalPopulation.population===capacity&&candidatePopulation.population===capacity,'Seeded million population dropped');
        quality.push({candidate: names[candidate],...compare(words,originalState,candidateState,capacity*16),originalPopulation,candidatePopulation});
        const samples = order.filter(sample => sample.candidate===names[candidate]).map(sample => ({...sample,milliseconds: Number(timestamps[sample.timestamp+1]-timestamps[sample.timestamp])/1e6}));
        const pairs = Array.from({length: 10},(_,pair) => {const values = samples.filter(sample => sample.pair===pair), original = values.find(sample => sample.variant==='original').milliseconds, next = values.find(sample => sample.variant===names[candidate]).milliseconds; return {pair,order: pair%2 ? 'BA' : 'AB',originalMs: original,candidateMs: next,ratio: original/next,savedMs: original-next};});
        const median = values => {const sorted = values.slice().sort((a,b) => a-b); return (sorted[4]+sorted[5])/2;};
        timedReports.push({candidate: names[candidate],pairs,originalMedianMs: median(pairs.map(pair => pair.originalMs)),candidateMedianMs: median(pairs.map(pair => pair.candidateMs)),medianRatio: median(pairs.map(pair => pair.ratio)),wins: pairs.filter(pair => pair.savedMs > 0).length,ties: pairs.filter(pair => pair.savedMs===0).length});
      }
      queryRead.unmap(); read.unmap(); meta.unmap();
      // Actual million births exercise atomics/population; seed scheduling is intentionally not a byte-parity claim.
      functionalReports.push(await functional(1000000,'births',[{dt: 0.04,time: 0.1,budget: 1000000}]));
      const compilationErrors = (await Promise.all(modules.map(m => m.getCompilationInfo()))).flatMap(info => info.messages.filter(message => message.type==='error').map(message => message.message));
      scopePending = false; const validation = await d.popErrorScope(); assert(!validation,validation?.message); assert(!compilationErrors.length,JSON.stringify(compilationErrors)); assert(!uncaptured.length,JSON.stringify(uncaptured));
      const requiredFunctionalParity = functionalReports.flatMap(report => report.frames.filter(frame => frame.parityRequired).flatMap(frame => frame.parity));
      return {oneQueue: true,pairedOneCommandBuffer: true,performanceQueueSubmissions: 1,capacity,particleABI: {bytes: 64,floats: 16},stateBytes: {original: 128000000,full: 64000000,partial: 64000000},
        quality,requiredFunctionalParityExact: requiredFunctionalParity.every(parity => parity.changedWords===0),functionalReports,renderReports,timedReports,querySets: 1,queryReadBuffers: 2,
        shaderCompilationErrors: compilationErrors,validationErrors: [],uncapturedErrors: uncaptured,resourceCount: resources.length,lifecycleProofPending: true,productionEdited: false};
    } finally {try {if (scopePending) await d.popErrorScope();} finally {for (const resource of resources) resource.destroy(); d.destroy();}}
  },{shaders: source.shaders,billboardShader: source.billboardShader});
  assert.deepEqual(errors,[]); const report = {baselineRef,recordedAt: new Date().toISOString(),hardware: browser.hardware,...result};
  await writeFile('test-results/vfx-inplace-gpu.json',JSON.stringify(report,null,2)); console.log(JSON.stringify({...report,functionalReports: report.functionalReports.map(({capacity,kind,frames}) => ({capacity,kind,frames: frames.map(frame => ({frame: frame.frame,population: frame.populations[0].population,parityRequired: frame.parityRequired,changedWords: frame.parity.map(p => p.changedWords)}))}))},null,2));
} catch (error) {await appendFile('test-results/vfx-inplace-gpu-failures.jsonl',JSON.stringify({baselineRef,recordedAt: new Date().toISOString(),message: error.message,stack: error.stack})+'\n'); throw error;} finally {await browser.close();}
