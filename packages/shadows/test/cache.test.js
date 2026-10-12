import test from 'node:test';
import assert from 'node:assert/strict';
import {Shadows} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

test('shadow cascades reuse descriptors, attachments, callback contexts and matrix views',()=>{
  const h=optionalGPU(),descriptors=[],contexts=[],engine=h.engine;
  engine.gpu.limits.maxTextureDimension2D=8192;engine.gpu.limits.maxTextureArrayLayers=256;
  engine.lighting={direction:new Float32Array([1,2,3,3])};
  const render=h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass=descriptor=>{descriptors.push(descriptor);return render(descriptor);};
  const shadows=new Shadows({resolution:64});
  shadows.add({drawShadow(context){contexts.push(context);}});engine.use(shadows);
  const frame=()=>{h.context.shader='let linear=direct*vec3f(1);';h.context.bindings.length=0;engine.frameGraph.execute(h.context);};
  frame();const descriptor=descriptors[0],attachment=descriptor.depthStencilAttachment,groups=h.counts.groups,views=h.counts.views;
  const matrices=contexts.map(context=>context.matrix);
  for(let i=0;i<4;i++)assert.equal(contexts[i].cascade,i);
  frame();
  for(const value of descriptors){assert.equal(value,descriptor);assert.equal(value.depthStencilAttachment,attachment);assert.equal(value.colorAttachments.length,0);}
  for(let i=0;i<4;i++){assert.equal(contexts[i+4],contexts[i]);assert.equal(contexts[i+4].matrix,matrices[i]);}
  assert.equal(h.counts.groups,groups);assert.equal(h.counts.views,views);
  shadows.onDeviceRestored(engine);frame();shadows.dispose();assert.ok(h.resources.every(resource=>resource.destroyed));
});
