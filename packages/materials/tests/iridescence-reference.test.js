import test from 'node:test';
import assert from 'node:assert/strict';
import {iridescenceReference,iridescenceCases} from './support/iridescence-reference.js';

// Linear RGB checkpoints from the Khronos analytic model. The CPU reference
// reaches them by numerical quadrature; GPU tests consume the same inputs and
// compare the actual WGSL results against that independent integration.
const checkpoints=[
  [0.003166034645088191,0.004457509768797157,0.007568328217743924],
  [0.05627249241839978,0.07845896030688619,0.07886665097706454],
  [0.6847957864771369,0.6063732582145234,0.5334491379241578],
  [0.25868928569965505,0.17518401282382237,0.12778801024124145],
  [0.8191580340607755,0.21094021072672722,0.034475504553823366],
  [0.5344847203459776,0.2355303412517866,0.19729977244515737],
];
test('independent spectral quadrature matches thin-film dielectric and colored-metal RGB checkpoints',()=>{
  for(let index=0;index<checkpoints.length;index++){
    const actual=iridescenceReference(iridescenceCases[index]);
    for(let channel=0;channel<3;channel++)assert.ok(Math.abs(actual[channel]-checkpoints[index][channel])<1e-9,'Spectral checkpoint '+index+' channel '+channel);
  }
});
test('no film and an optically matched film preserve baseline Schlick Fresnel',()=>{
  const f0=[0.04,0.2,1];
  for(const cosine of [0,0.1,0.5,1])for(const input of [{filmIor:1.3,thicknessNm:0},{filmIor:1,thicknessNm:400}]){
    const actual=iridescenceReference({cosTheta:cosine,baseF0:f0,...input});
    assert.deepEqual(actual,f0.map(value=>value+(1-value)*(1-cosine)**5));
  }
});
test('thin-film total internal reflection returns white before a negative square root',()=>{
  assert.deepEqual(iridescenceReference({cosTheta:0.2,outsideIor:1.5,filmIor:1,thicknessNm:400}),[1,1,1]);
});
test('vanishing and extreme optical thickness stay finite and bounded',()=>{
  for(const thicknessNm of [1e-12,0.001,0.03,100,400,1000,100000,1e30])for(const cosTheta of [0,0.2,1]){
    const value=iridescenceReference({cosTheta,filmIor:1.3,thicknessNm,baseF0:[0,0.04,1]});assert.ok(value.every(channel=>Number.isFinite(channel)&&channel>=0&&channel<=1));
  }
  const infinitePath=iridescenceReference(iridescenceCases[9]);
  const dc=[0.09934771528940968,0.1889966174022629,0.999870274043774];
  for(let channel=0;channel<3;channel++)assert.ok(Math.abs(infinitePath[channel]-dc[channel])<1e-12);
});
