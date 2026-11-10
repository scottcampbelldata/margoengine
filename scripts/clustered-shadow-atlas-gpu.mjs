import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
const browser = await openBrowser({startPath:'/tests/clustered-shadow.html',port:'free'});
try {
  const page=browser.page;
  await page.waitForFunction(()=>window.clusteredShadowFixture);
  const call=(name,...args)=>page.evaluate(({name,args})=>window.clusteredShadowFixture[name](...args),{name,args});
  const points=[[0,0,0,0,1,0],[3,0,0,0,1,0]],results=[];
  for(const kind of ['point','spot']){
    const light={position:[0,3,0],range:10,intensity:10,...(kind==='spot'?{direction:[0,-1,0],outerAngle:1.2}:{})};
    await call('scene',{meshes:['floor','block'],atlas:true,points:[light]});await call('render',2);
    const off=await call('probe',points);
    await call('scene',{meshes:['floor','block'],atlas:true,points:[{...light,castShadow:true}]});await call('render',2);
    const on=await call('probe',points),compiled=await call('compile');
    assert.deepEqual(compiled,{core:[],probe:[]});
    assert.ok(on[0][0]<off[0][0]*0.05,kind+' blocked');
    assert.ok(Math.abs(on[1][0]/off[1][0]-1)<0.02,kind+' clear');
    results.push({kind,visibility:on.map((p,i)=>p[0]/off[i][0])});
  }
  const spots=[{position:[0,3,0],color:[1,0,0],range:10,intensity:10,direction:[0,-1,0],outerAngle:1.2,shadow:{resolution:64}},
    {position:[3,3,0],color:[0,0,1],range:10,intensity:10,direction:[0,-1,0],outerAngle:1.2,shadow:{resolution:32}}];
  await call('scene',{meshes:['floor','block'],atlas:true,points:spots.map(({shadow:_shadow,...p})=>p)});await call('render',2);
  const separateOff=await call('probe',points);
  await call('scene',{meshes:['floor','block'],atlas:true,points:spots.map(p=>({...p,castShadow:true}))});await call('render',2);
  const separateOn=await call('probe',points);
  assert.ok(separateOn[0][0]<separateOff[0][0]*0.05,'first tile shadows its red light');
  assert.ok(Math.abs(separateOn[0][2]/separateOff[0][2]-1)<0.02,'adjacent smaller tile keeps blue light clear');
  assert.ok(Math.abs(separateOn[1][0]/separateOff[1][0]-1)<0.02,'first tile is clear away from blocker');
  // Rectangles and spheres share the same packed image and filtering without index collisions.
  await call('scene',{meshes:['floor','block'],atlas:true,
    areas:[{position:[0,3,0],direction:[0,-1,0],width:0.3,height:0.3,castShadow:true}],
    shapes:[{shape:'sphere',position:[0,3,0],radius:0.15,castShadow:true}]});
  await call('render',2);
  const area=await call('probe',points);
  assert.ok(area[0][0]<area[1][0]*0.05);
  assert.deepEqual(await page.evaluate(()=>window.clusteredShadowFixture.errors),[]);
  console.log(JSON.stringify(results));
}finally{await browser.close();}
