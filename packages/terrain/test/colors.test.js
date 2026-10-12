import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TransformStore,meshRuntime} from '@margoengine/core/extension';
import {TerrainColors} from '../dist/index.js';

const options={sand:[0.4,0.3,0.2],meadow:[[0.1,0.2,0.1],[0.2,0.3,0.1]],stone:[0.3,0.3,0.3],shore:[0,1],meadowHeight:[1,10],stoneHeight:[10,20],stoneNormal:[0.5,0.8],wetHeight:[0,0.6],wetDarkening:0.55};
test('terrain colors target a mesh ID and retain shader lighting while caching the patch',async()=>{
 const engine=new Engine({width:10,height:10},await TransformStore.create(8),{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
 const mesh=engine.createMesh(),other=engine.createMesh(),colors=new TerrainColors(mesh,options);engine.use(colors);
 const source='o.color=i.color.rgb; // PBR and shadows stay here',c={backend:'webgpu',shader:source,draw(){}};
 engine.frameGraph.execute(c);assert.ok(c.shader.includes(`if(i.factors.w==${meshRuntime(mesh).id}.0)`));assert.ok(!c.shader.includes(`if(i.factors.w==${meshRuntime(other).id}.0)`));assert.ok(c.shader.includes('PBR and shadows stay here'));
 const patched=c.shader;c.shader=source;engine.frameGraph.execute(c);assert.equal(c.shader,patched);
 assert.throws(()=>new TerrainColors(mesh,{...options,wetDarkening:2}),/wetness/);
 assert.throws(()=>new TerrainColors(mesh,{...options,shore:[1,1]}),/range/);
 colors.dispose();c.shader=source;engine.frameGraph.execute(c);assert.equal(c.shader,source);engine.dispose();
});
