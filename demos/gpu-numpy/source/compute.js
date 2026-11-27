import {createCompute,GpuArray} from '@margoengine/compute';
import {fft,ifft} from '@margoengine/compute/fft';
import {matmul} from '@margoengine/compute/linalg';
import {fixtures} from './fixtures.mjs';

const complex=value=>typeof value==='object'&&value!==null&&'re' in value&&'im' in value;

export async function openCompute(signal){
  const forced=new URLSearchParams(location.search).get('backend');
  if(forced==='cpu')return {gpu:await createCompute({backend:'cpu',signal}),backend:'cpu'};
  if(forced!=='webgl2'&&navigator.gpu){
    try{return {gpu:await createCompute({backend:'webgpu',signal}),backend:'webgpu'};}
    catch(reason){
      if(!['unsupported','no-adapter'].includes(reason?.code))throw reason;
    }
  }
  try{
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal});
    return {gpu:await createCompute({backend:'webgpu',signal}),backend:'webgl2'};
  }catch(reason){
    if(!['unsupported','no-adapter'].includes(reason?.code))throw reason;
    return {gpu:await createCompute({backend:'cpu',signal}),backend:'cpu'};
  }
}

export async function run(gpu,tree,signal){
  const started=performance.now(),owned=new Set(),input=new Map();
  const baseline=gpu.device.dispatches?{...gpu.device.dispatches}:undefined;
  const save=value=>{
    owned.add(value);
    return value;
  };
  const pack=(data,shape)=>save(gpu.array(data,{shape,dtype:'f32'}));
  function operand(value) {
    if(complex(value))throw new Error('Use magnitude() or ifft() to operate on a complex transform.');
    return typeof value==='number'?pack(Float32Array.of(value),[]):value;
  }
  const leaf=(value)=>typeof value==='number'?value:operand(value);
  const magnitude=value=>complex(value)?value.re.square().add(value.im.square()).sqrt():operand(value).abs();

  function evaluate(node){
    switch(node.type){
      case 'constant':return node.value;
      case 'array':return pack(Float32Array.from(node.values),node.shape);
      case 'name':{
        if(!input.has(node.name)){
          const {data,shape}=fixtures[node.name];
          input.set(node.name,pack(data,shape));
        }
        return input.get(node.name);
      }
      case 'unary':{
        const value=evaluate(node.value);
        return typeof value==='number'?-value:operand(value).neg();
      }
      case 'binary':{
        const left=operand(evaluate(node.left)),right=leaf(evaluate(node.right));
        if(node.operator==='@')return save(matmul(left,operand(right)));
        if(node.operator==='+')return left.add(right);
        if(node.operator==='-')return left.sub(right);
        if(node.operator==='*')return left.mul(right);
        return left.div(right);
      }
      default:{
        const values=node.args.map(evaluate),value=values[0];
        switch(node.name){
          case 'fft':
          case 'ifft':{
            const result=(node.name==='fft'?fft:ifft)(complex(value)?value:operand(value));
            save(result.re);
            save(result.im);
            return result;
          }
          case 'magnitude':return magnitude(value);
          case 'matmul':return save(matmul(operand(value),operand(values[1])));
          case 'sort':return save(gpu.sort(operand(value)));
          case 'transpose':{
            const array=operand(value);
            const material=array instanceof GpuArray?array:save(array.eval());
            return save(material.transpose());
          }
          case 'min':
          case 'max':
          case 'mean':
          case 'sum':return save(operand(value)[node.name]());
          default:return operand(value)[node.name]();
        }
      }
    }
  }

  try{
    signal.throwIfAborted();
    const value=evaluate(tree),isComplex=complex(value);
    const output=isComplex?magnitude(value):operand(value);
    const shape=[...output.shape];
    const accuracy=isComplex?{re:await value.re.read({signal}),im:await value.im.read({signal})}:undefined;
    const data=await output.read({signal});
    const elapsed=performance.now()-started;
    const total=gpu.device.dispatches;
    const dispatches=baseline?{
      gpu:total.fragment+total.scatter-baseline.fragment-baseline.scatter,
      cpu:total.cpu-baseline.cpu,
    }:undefined;
    return {data,shape,complex:accuracy,elapsed,dispatches};
  }finally{
    for(const array of Array.from(owned).reverse())array.dispose();
  }
}
