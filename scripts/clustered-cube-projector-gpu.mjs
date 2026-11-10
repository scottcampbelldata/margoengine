import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
const browser=await openBrowser({startPath:'/tests/clustered-shadow.html',port:'free'});
try{
 const page=browser.page;await page.waitForFunction(()=>window.clusteredShadowFixture);
 const result=await page.evaluate(async()=>{
  const f=window.clusteredShadowFixture,dirs=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[1,1,1],[1,0.5,0.5],[1,1,0],[1.0001,1,0],[1,1.0001,0]],
    points=dirs.map(d=>[...d.map(v=>v*2),...d.map(v=>-v)]),
    light={position:[0,0,0],range:10,intensity:8},colors=[[255,0,0],[0,255,255],[0,255,0],[255,0,255],[0,0,255],[255,255,0]],
    image=(colors,side=1)=>({faces:colors.map(c=>({width:side,height:side,data:new Uint8Array(c)}))}),
    scene=async(cubes,extra={})=>{await f.scene({meshes:['floor'],local:false,points:[light],...(cubes?{cubes}:{}),...extra});await f.render(2);return f.probe(points);};
  const off=await scene(),faces=image(colors.map(c=>[...c,255])),axis=await scene([{image:faces,colorSpace:'linear'}]);
  const rotated=await scene([{image:faces,colorSpace:'linear',rotation:[0,Math.SQRT1_2,0,Math.SQRT1_2]}]);
  const grey=image(Array(6).fill([128,128,128,128])),srgb=await scene([grey]);
  const gradient=image(Array(6).fill([32,64,0,255,200,64,0,255,32,220,0,255,200,220,0,255]),2),oriented=await scene([{image:gradient,colorSpace:'linear'}]);
  const mixedLights=[{...light,color:[1,0,0]},{position:[0,3,0],range:10,intensity:8,color:[0,0,1],direction:[0,-1,0],outerAngle:1.2}];
  const mixedOff=await scene(undefined,{points:mixedLights});
  const white=v=>image(Array(6).fill([v,v,v,255]));
  const mixed=await scene([{image:white(64),colorSpace:'linear'},{image:white(0),colorSpace:'linear'}],{points:mixedLights,
    projectors:[{width:1,height:1,data:new Uint8Array([0,0,0,255])},{image:{width:1,height:1,data:new Uint8Array([128,128,128,255])},colorSpace:'linear'}]});
  f.cubes([]);await f.render(2);const noCube=await f.probe(points);
  f.cubes([{image:white(64),colorSpace:'linear'},{image:white(0),colorSpace:'linear'}]);await f.render(2);const reactivated=await f.probe(points);
  const shadowed={points:[{...light,castShadow:true}],local:{resolution:64},meshes:['floor','block']};
  const exactCookie=await scene([grey],shadowed),sampledCookie=await scene([grey],{...shadowed,stochastic:true});
  return {off,axis,rotated,srgb,oriented,mixedOff,mixed,noCube,reactivated,exactCookie,sampledCookie,compiled:await f.compile(),errors:f.errors};
 });
 const ratio=(a,b)=>a.map((p,i)=>p.map((v,k)=>v/b[i][k])),close=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<0.0002,`${label}: ${actual} vs ${expected}`),
   axis=ratio(result.axis,result.off),rotated=ratio(result.rotated,result.off),srgb=ratio(result.srgb,result.off),gradient=ratio(result.oriented,result.off),
   expected=[[1,0,0],[0,1,1],[0,1,0],[1,0,1],[0,0,1],[1,1,0]];
 for(let i=0;i<6;i++)for(let k=0;k<3;k++)close(axis[i][k],expected[i][k],`face ${i} channel ${k}`);
 for(let k=0;k<3;k++){close(axis[6][k],1/3,'three-face corner');close(rotated[0][k],[0,0,1][k],'rotation');
  close(srgb[0][k],((128/255+0.055)/1.055)**2.4*(128/255),'sRGB plus alpha');}
 close(gradient[7][0],32/255,'face horizontal orientation');close(gradient[7][1],64/255,'face vertical orientation');
 for(let k=0;k<3;k++){close(axis[8][k],[0.5,0.5,0][k],'two-face edge');close(axis[9][k],axis[10][k],'edge continuity');}
 close(result.mixed[4][0]/result.mixedOff[4][0],64/255,'point cube with spot cookie');
 close(result.mixed[4][2]/result.mixedOff[4][2],128/255,'spot cookie ignores cube');
 close(result.noCube[4][0]/result.mixedOff[4][0],1,'removing cubes preserves active spot hook and restores point light');
 close(result.reactivated[4][0]/result.mixedOff[4][0],64/255,'reactivating cubes rebuilds cached shader');
 for(let i=0;i<result.exactCookie.length;i++)for(let k=0;k<3;k++)close(result.sampledCookie[i][k],result.exactCookie[i][k],'cube cookie with exact stochastic shadow');
 assert.deepEqual(result.compiled,{core:[],probe:[]});assert.deepEqual(result.errors,[]);
 console.log(JSON.stringify({faces:axis.slice(0,6),corner:axis[6],rotation:rotated[0],srgb:srgb[0],mixed:true}));
}finally{await browser.close();}
