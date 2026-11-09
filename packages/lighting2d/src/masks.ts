import type { LightMask2D } from './index.js';
import { rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** Internal, shared CPU packing and GPU clipping contract for every direct-light entry. */
export class MaskData {
  buffer?: GPUBuffer;
  fields: number[][] = [];

  upload(device: GPUDevice, lights: readonly { mask?: LightMask2D }[]): void {
    const points: number[] = [];
    this.fields = lights.map(({ mask }) => {
      if (!mask) return [0, 0, 0, 0, 0, 0, 0, 0];
      const invert = mask.invert ? 1 : 0;
      if (mask.kind === 'rect') return [mask.minX, mask.minY, mask.maxX, mask.maxY, 1, invert, 0, 0];
      if (mask.kind === 'circle') return [mask.center?.[0] ?? 0, mask.center?.[1] ?? 0, 0, mask.radius ** 2, 2, invert, 0, 0];
      const start = points.length / 4;
      for (const [x, y] of mask.points) points.push(x, y, 0, 0);
      return [0, 0, 0, 0, 3, invert, start, mask.points.length];
    });
    const values = new Float32Array(points.length ? points : [0, 0, 0, 0]);
    if (values.byteLength > device.limits.maxStorageBufferBindingSize) {
      throw rangeError('Light mask vertices exceed maxStorageBufferBindingSize', 'pixel-lighting');
    }
    if (!this.buffer || this.buffer.size < values.byteLength) {
      this.buffer?.destroy();
      this.buffer = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    device.queue.writeBuffer(this.buffer, 0, values);
  }

  dispose(): void {
    this.buffer?.destroy();
    this.buffer = undefined;
    this.fields = [];
  }
}

export const maskShader = (binding: number): string => /* wgsl */ `
@group(0)@binding(${
binding}
)var<storage,read>maskPoints:array<vec4f>;
fn maskVisible(world:vec2f,bounds:vec4f,info:vec4f)->bool{
let kind=u32(info.x);
if(kind==0u){
return true;
}
var inside=false;
if(kind==1u){
inside=all(world>=bounds.xy)&&all(world<=bounds.zw);
}
else if(kind==2u){
let d=world-bounds.xy;
inside=dot(d,d)<=bounds.w;
}
else{
let start=u32(info.z);
let count=u32(info.w);
var j=count-1u;
for(var i=0u;
i<count;
i++){
let a=maskPoints[start+i].xy;
let b=maskPoints[start+j].xy;
if((a.y>world.y)!=(b.y>world.y)){
if(world.x<(b.x-a.x)*(world.y-a.y)/(b.y-a.y)+a.x){
inside=!inside;
}
}
j=i;
}
}
return select(inside,!inside,info.y>0.5);
}
`;
