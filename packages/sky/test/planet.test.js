import test from 'node:test';import assert from 'node:assert/strict';
import {PlanetAtmosphere} from '@margoengine/sky/planet';
import {tracedGPU} from '../../../tests/support/gpu-trace.js';

test('planet tables retain an arbitrary ECEF observer and cache medium work independently of frame changes',t=>{
 const previous=globalThis.GPUShaderStage;globalThis.GPUShaderStage={VERTEX:1,FRAGMENT:2};
 t.after(()=>{if(previous===undefined)delete globalThis.GPUShaderStage;else globalThis.GPUShaderStage=previous;});
 const h=tracedGPU(),device=h.engine.gpu,writes=[],write=device.queue.writeBuffer.bind(device.queue);
 device.queue.writeBuffer=(buffer,offset,data)=>{if(data.length===56)writes.push(Float32Array.from(data));return write(buffer,offset,data);};
 const planet=new PlanetAtmosphere(device),matrix=[2,0,0,0,0,3,0,0,0,0,4,0,5,6,7,1];
 const encoder=h.context.encoder;
 planet.prepare(encoder,matrix,[9000,8000,7000],[1,2,3]);
 const count=h.commands().filter(x=>x.startsWith('dispatch')).length;
 planet.prepare(encoder,matrix,[7000,0,0],[0,1,0],{exposure:1});
 assert.equal(h.commands().filter(x=>x.startsWith('dispatch')).length,count,'camera and sun changes do not regenerate medium tables');
 assert.deepEqual(Array.from(writes[0].slice(0,16)),matrix);
 assert.deepEqual(Array.from(writes[0].slice(40,43)),[9000,8000,7000]);
 assert.deepEqual(Array.from(writes.at(-1).slice(40,43)),[7000,0,0]);assert.equal(writes.at(-1)[39],2);
 assert.throws(()=>planet.prepare(encoder,matrix,[7000,0,0],[0,0,0]),/nonzero sun/);
 assert.throws(()=>planet.prepare(encoder,matrix,[7000,0,0],[0,1,0],{atmosphere:{rayleigh:[1,1,1]}}),/scattering depth/);
 planet.dispose();planet.dispose();assert.throws(()=>planet.prepare(encoder,matrix,[7000,0,0],[0,1,0]),/disposed/);
 assert.throws(()=>new PlanetAtmosphere(null),/GPUDevice/);
});
