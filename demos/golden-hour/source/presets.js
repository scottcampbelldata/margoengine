
import {SCENE_PRESETS} from '@margoengine/sky/scenes';

const golden={
  ...SCENE_PRESETS.goldenHour,
  day:{...SCENE_PRESETS.goldenHour.day,azimuth:198,elevation:6,turbidity:2.8,clouds:.25,exposure:-.82,intensity:7.3},
  fog:.00021,
};
const clear={
  ...SCENE_PRESETS.noon,
  day:{...SCENE_PRESETS.noon.day,azimuth:313,elevation:48,clouds:.06,exposure:-.20},
  fog:.00015,
};
const hazy={
  ...SCENE_PRESETS.noon,
  day:{...SCENE_PRESETS.noon.day,azimuth:215,elevation:34,turbidity:8.45,clouds:.12,exposure:-.68},
  fog:.00046,tonemap:{...SCENE_PRESETS.noon.tonemap,exposure:.35,temperature:6800,contrast:.91},
};
const overcast={
  ...SCENE_PRESETS.overcast,
  day:{...SCENE_PRESETS.overcast.day,azimuth:300,elevation:43,exposure:-.23},
  fog:.00025,
};

export const modes={
  golden:{preset:golden,skyLook:{glowStrength:.27,glowWidth:10,glowSunward:.8,glowColor:[1,.34,.11],
    cloudColor:[1,.75,.60],sunDiscSize:1.04,zenithColor:[.22,.19,.42],zenithStrength:.30},
    fogColor:'#ac775b',fill:[.23,.20,.23],exposure:.82,text:'Low sun grazes the sandstone and warms the dust over the basin.'},
  clear:{preset:clear,skyLook:{zenithColor:[.14,.31,.55],zenithStrength:.17},
    fogColor:'#a69a94',fill:[.21,.27,.36],exposure:-.15,text:'Clear air keeps distant ridges sharp beneath the high sun.'},
  haze:{preset:hazy,skyLook:{sunDiscSoftness:.63,horizonColor:[.83,.71,.57],horizonStrength:.18},
    fogColor:'#b39683',fill:[.40,.35,.31],exposure:.15,text:'Haze softens the sun and erases contrast across the far ridges.'},
  overcast:{preset:overcast,skyLook:{cloudColor:[.73,.78,.86],cloudDensity:1.5},
    fogColor:'#9c9da9',fill:[.43,.48,.52],exposure:1,text:'A full cloud deck hides the sun. Diffuse light reveals the stone bands without hard shadows.'},
};

export const lookFamilies={
  neutral:{curve:'neutral',contrast:1},
  agx:{curve:'agx',contrast:1.035},
  acescg:{curve:'acescg',contrast:1.06},
};
