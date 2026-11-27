import { Sky } from '@margoengine/sky/base';
import { clouds } from '@margoengine/sky/clouds';
import { look } from '@margoengine/sky/look';
import { preetham } from '@margoengine/sky/preetham';

export const sunDirection=[-.28,.045,-.958];

export function createDusk(engine) {
  return Sky.attach(engine,{
    sunDirection,timeScale:0,hours:18,turbidity:5.4,exposure:-.85,
    clouds:{coverage:.27,height:4200,speed:13},
    look:{
      gradientStrength:.75,gradientIntensity:1,
      gradient:[
        {elevation:-25,color:[.075,.039,.072]}, {elevation:0,color:[.54,.237,.197]},
        {elevation:12,color:[.27,.115,.165]}, {elevation:42,color:[.086,.076,.175]},
        {elevation:90,color:[.024,.031,.095]},
      ],
      sunDiscColor:[1,.55,.31],sunDiscSize:1.75,sunDiscIntensity:.48,sunDiscSoftness:.15,
      glowColor:[.56,.19,.13],glowStrength:.4,glowWidth:9,cloudColor:[.69,.39,.46],cloudDensity:.88,
    },
  },{preetham,look,clouds});
}
