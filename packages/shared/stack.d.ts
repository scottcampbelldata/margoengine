// Types only: the protocol between @margoengine/post's PostStack and the effects it combines.
import type {PassContext} from '@margoengine/core/extension';
import type {SceneTarget} from './msaa.js';
type Context=Extract<PassContext,{backend:'webgpu'}>;
/** The shared capture; both fields change identity on resize and device restoration. */
export interface StackHost {target?:SceneTarget;depthTexture?:GPUTexture}
/** Linear HDR (rgba16float, 1x) when `hdr`, otherwise display-encoded output of `format` and `multisample`. */
export interface StageOutput {view:GPUTextureView;format:GPUTextureFormat;multisample:GPUMultisampleState;hdr:boolean}
/** hdr effects read and write linear light (tonemapping only when last); a display effect ends the HDR chain; ldr effects follow it.
 * render may return its own view for the next stage instead of writing `output`. */
export interface StackStage {readonly kind:'hdr'|'display'|'ldr';render(context:Context,input:GPUTextureView,output:StageOutput):GPUTextureView|void}
