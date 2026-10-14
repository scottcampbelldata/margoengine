import {Sky} from '@margoengine/sky/base';
import {night} from '@margoengine/sky/night';
import type {SkyNightOptions} from '@margoengine/sky/base';
export type SkyMoonConfig=SkyNightOptions;
/** Moonlit night sky with stars and a phased moon: a `Sky` from `@margoengine/sky` held at midnight, loading only its stylized-night feature. `config` is read every frame. */
export class SkyMoon extends Sky {
  override readonly name='sky-moon';
  constructor(readonly config:SkyMoonConfig={}) {super({hours:0,timeScale:0,night:config},{night});}
}
