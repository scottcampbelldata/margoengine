import type {EngineKernel} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {Sky as SkyBase,type SkyOptions} from './base.js';
import {preetham} from './preetham.js';
import {bruneton} from './bruneton.js';
import {clouds} from './clouds.js';
import {night} from './night.js';
import {fog} from './fog.js';
import {reflection} from './reflection.js';
import {lighting} from './lighting.js';
export {sunDirection,type SkyOptions,type SkyLightingOptions,type SkyCloudOptions,type SkyFogOptions,type SkyNightOptions,type SkyFeatures} from './base.js';
const features={preetham,bruneton,clouds,night,fog,reflection,lighting};
/**
 * Every sky feature: Preetham and Bruneton day models, clouds, stylized night, fog, reflection and lighting.
 * A scene that needs fewer loads less with `Sky` from `@margoengine/sky/base` and only the feature entries it uses.
 */
export class Sky extends SkyBase {
 constructor(options:SkyOptions={}){super(options,features);}
 static attach(engine:EngineKernel,options:SkyOptions={}):Sky {const effect=new Sky(options);engineRuntime(engine).use(effect);return effect;}
}
