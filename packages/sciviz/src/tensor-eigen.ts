import type { ComputeContext, GpuArray } from '@margoengine/compute';
import { tensorError } from './tensor-math.js';

const shader = /* wgsl */ `
struct Params {count:u32,a:u32,b:u32,c:u32}
@group(0) @binding(0) var<storage,read> source:array<f32>;
@group(0) @binding(1) var<storage,read_write> frames:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> status:array<u32>;
@group(0) @binding(3) var<uniform> params:Params;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) group:vec3u,@builtin(num_workgroups) groups:vec3u,@builtin(local_invocation_index) local:u32) {
 let id=(group.x+group.y*groups.x)*64u+local;if(id>=params.count){return;}let at=id*7u;
 var a=array<f32,9>(source[at],source[at+3u],source[at+4u],source[at+3u],source[at+1u],source[at+5u],source[at+4u],source[at+5u],source[at+2u]);
 var v=array<f32,9>(1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0);
 for(var iteration=0u;iteration<48u;iteration++) {
  var p=0u;var q=1u;
  for(var i=0u;i<3u;i++){for(var j=i+1u;j<3u;j++){if(abs(a[i*3u+j])>abs(a[p*3u+q])){p=i;q=j;}}}
  let b=a[p*3u+q];if(abs(b)<=1e-7){break;}
  let tau=(a[q*3u+q]-a[p*3u+p])/(2.0*b);let t=select(-1.0,1.0,tau>=0.0)/(abs(tau)+sqrt(1.0+tau*tau));let c=inverseSqrt(1.0+t*t);let s=t*c;
  for(var k=0u;k<3u;k++){if(k!=p&&k!=q){let x=a[k*3u+p];let y=a[k*3u+q];a[k*3u+p]=c*x-s*y;a[p*3u+k]=a[k*3u+p];a[k*3u+q]=s*x+c*y;a[q*3u+k]=a[k*3u+q];}}
  a[p*3u+p]-=t*b;a[q*3u+q]+=t*b;a[p*3u+q]=0.0;a[q*3u+p]=0.0;
  for(var k=0u;k<3u;k++){let x=v[p*3u+k];let y=v[q*3u+k];v[p*3u+k]=c*x-s*y;v[q*3u+k]=s*x+c*y;}
 }
 var order=array<u32,3>(0u,1u,2u);
 for(var i=0u;i<2u;i++){for(var j=i+1u;j<3u;j++){if(a[order[j]*3u+order[j]]>a[order[i]*3u+order[i]]){let old=order[i];order[i]=order[j];order[j]=old;}}}
 var basis:array<vec3f,3>;var values=vec3f(0.0);
 for(var col=0u;col<3u;col++){let k=order[col];values[col]=a[k*3u+k];basis[col]=vec3f(v[k*3u],v[k*3u+1u],v[k*3u+2u]);}
 for(var col=0u;col<2u;col++){var axis=0u;for(var k=1u;k<3u;k++){if(abs(basis[col][k])>abs(basis[col][axis])){axis=k;}}if(basis[col][axis]<0.0){basis[col]=-basis[col];}}
 basis[2]=cross(basis[0],basis[1]);
 let mean=(values.x+values.y+values.z)/3.0;let denom=dot(values,values);var fa=0.0;if(denom>0.0){let d=values-mean;fa=sqrt(1.5*dot(d,d)/denom);}
 frames[id*4u]=vec4f(values*source[at+6u],fa);
 for(var col=0u;col<3u;col++){frames[id*4u+col+1u]=vec4f(basis[col],0.0);}
 status[id]=select(0u,1u,max(max(abs(a[1]),abs(a[2])),abs(a[5]))>8e-6);
}`;

/** Packed GPU eigensystems, ready for direct storage-buffer binding. */
export interface GpuTensorEigen {
  /** Sixteen f32 per tensor: eigenvalues xyz/FA, followed by three eigenvector xyz/pad columns. */
  readonly frames: GpuArray<'f32'>;
  readonly count: number;
  /** Absolute matrix/eigen residual bound per tensor: 64 * 2^-23 * max(abs(coefficients)). */
  readonly residualBounds: Float64Array;
  dispose(): void;
  [Symbol.dispose](): void;
}
/** Scaled symmetric 3x3 Jacobi eigensystems on WebGPU or the compatibility compute context. */
export async function tensorEigenGPU(
  gpu: ComputeContext,
  tensors: ArrayLike<number>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GpuTensorEigen> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(tensors.length) || tensors.length < 0 || tensors.length % 6)
    tensorError('GPU tensor coefficients must have a nonnegative multiple-of-six length');
  const count = tensors.length / 6;
  await gpu.routeReady;
  options.signal?.throwIfAborted();
  if (count * 64 > Math.min(gpu.device.limits.maxBufferSize, gpu.device.limits.maxStorageBufferBindingSize))
    tensorError('GPU eigensystem buffer exceeds device limits; partition the field');
  const input = new Float32Array(count * 7),
    residualBounds = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let scale = 0;
    for (let k = 0; k < 6; k++) {
      const x = tensors[i * 6 + k];
      if (!Number.isFinite(x)) tensorError('GPU tensor coefficients must be finite');
      scale = Math.max(scale, Math.abs(x));
    }
    if (scale && (scale < 2 ** -96 || scale > 2 ** 120))
      tensorError('GPU tensor magnitudes must be 2^-96..2^120 for the residual bound; rescale tensor units');
    for (let k = 0; k < 6; k++) input[i * 7 + k] = scale ? tensors[i * 6 + k] / scale : 0;
    input[i * 7 + 6] = scale;
    residualBounds[i] = 64 * 2 ** -23 * scale;
  }
  let frames: GpuArray<'f32'> | undefined;
  const temporaries: { dispose(): void }[] = [];
  try {
    frames = gpu.zeros([count, 16]);
    const source = gpu.array(input);
    temporaries.push(source);
    const status = gpu.zeros(count, 'u32');
    temporaries.push(status);
    const kernel = gpu.kernel(shader);
    temporaries.push(kernel);
    if (count) {
      const x = Math.min(Math.ceil(count / 64), gpu.device.limits.maxComputeWorkgroupsPerDimension);
      kernel.run(
        { source, frames, status, params: { count, a: 0, b: 0, c: 0 } },
        { workgroups: [x, Math.ceil(count / 64 / x), 1] },
      );
      const flags = await status.read({ signal: options.signal });
      if (flags.some((v) => v !== 0))
        tensorError('GPU Jacobi residual did not converge within the published float32 bound');
    }
    options.signal?.throwIfAborted();
    const resultFrames = frames;
    let disposed = false;
    const dispose = () => {
      if (!disposed) {
        disposed = true;
        resultFrames.dispose();
      }
    };
    return { frames, count, residualBounds, dispose, [Symbol.dispose]: dispose };
  } catch (error) {
    frames?.dispose();
    throw error;
  } finally {
    for (const temporary of temporaries.reverse()) temporary.dispose();
  }
}
