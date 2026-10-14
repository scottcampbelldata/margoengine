export const SLOW_FPS:number;
export function watchFrameRate(options?:{request?:(callback:(now:number)=>void)=>unknown;store?:()=>void;reload?:()=>void}):void;
export function capFrameRate(rate?:number,target?:{requestAnimationFrame(callback:(now:number)=>void):unknown}):void;
