import {Sky} from '@margoengine/sky/base';
import {night} from '@margoengine/sky/night';
import {VolumetricClouds} from '@margoengine/sky/volumetric-clouds';

export function buildStormField(engine,bottom,flash){
  Sky.attach(engine,{
    hours:0,timeScale:0,
    night:{
      moonDirection:[-.52,.39,-.78],moonSize:.0075,moonPhase:.69,
      moonColor:[.43,.55,.75],glowIntensity:.37,
      zenithColor:[.008,.012,.027],horizonColor:[.061,.082,.151],hazeDensity:.9,
      starIntensity:.23,starTwinkleIntensity:0,
    },
  },{night});
  const clouds=VolumetricClouds.attach(engine,{
    type:'storm',coverage:.78,bottom,top:3320,density:.022,
    hurricane:{center:[-9700,-14400],maxWindRadius:12700,eyeRadius:6800,eyewallWidth:5500,
      outerEyewall:18500,outerEyewallStrength:.45,moat:.28,shield:.31,canopy:.44,bands:4,
      bandWidth:5200,bandStart:18000,bandRotation:.37,extent:65000,swirl:0,pressureDrop:43},
    scale:6500,erosion:1.13,steps:86,lightSteps:5,maxDistance:16500,stepCap:94,
    groundAlbedo:.06,temporal:false,wind:[0,0],evolution:0,
    sunDirection:[-.54,.33,-.77],sunIntensity:.018,
    ambient:[[.016,.027,.053],[.013,.021,.048]],flash,
  });
  return clouds.ready;
}
