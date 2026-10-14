import type {EngineKernel} from '@margoengine/core';
import {Sky} from '@margoengine/sky/base';
import {night} from '@margoengine/sky/night';
import type {SkyNightOptions,SkyOptions} from '@margoengine/sky/base';
export type SkyMoonConfig=SkyNightOptions;
/** Moonlit night sky with stars and a phased moon: a `Sky` from `@margoengine/sky` held at midnight, loading only its stylized-night feature. `config` is read every frame. */
export class SkyMoon extends Sky {
  override readonly name='sky-moon';
  /**
   * Same as `engine.use(new SkyMoon(config))`; returns the SkyMoon (Sky.attach would add a plain Sky). `config` is the
   * moon config; the `SkyOptions` in its type only keeps the signature compatible with `Sky.attach`.
   */
  static override attach(engine:EngineKernel,config?:SkyMoonConfig|SkyOptions):SkyMoon {const value=new SkyMoon(config as SkyMoonConfig);engine.use(value);return value;}
  constructor(readonly config:SkyMoonConfig={}) {super({hours:0,timeScale:0,night:config},{night});}
}
