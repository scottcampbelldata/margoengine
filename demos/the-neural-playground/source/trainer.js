
import { createCompute } from '@margoengine/compute';
import { domain, resolution, maxSamples, hiddenSize } from './data.js';

const parameterCount=4*hiddenSize+1;

function openingWeights() {
  let seed=15371;
  const values=new Float32Array(4*parameterCount);
  for(let index=0;index<parameterCount;index++){
    seed^=seed<<13;
    seed^=seed>>>17;
    seed^=seed<<5;
    const unit=2*(seed>>>0)/4294967296-1;
    const slot=index%4;
    values[4*index]=index===parameterCount-1?0:unit*[1.05,1.05,.72,.33][slot];
  }
  return values;
}

const model=`
const WIDTH: u32 = 10u;
const OUTPUT_BIAS: u32 = 4u * WIDTH;
@group(0) @binding(0) var<storage, read> state: array<vec4f>;
@group(0) @binding(1) var<storage, read> examples: array<vec4f>;

fn hidden(xy: vec2f, j: u32) -> f32 {
  let slot = 4u * j;
  let z = state[slot].x * xy.x + state[slot + 1u].x * xy.y + state[slot + 2u].x;
  let t = exp(-2.0 * clamp(z, -12.0, 12.0));
  return (1.0 - t) / (1.0 + t);
}
fn logit(xy: vec2f) -> f32 {
  var next = state[OUTPUT_BIAS].x;
  for (var j = 0u; j < WIDTH; j++) {
    next += hidden(xy, j) * state[4u * j + 3u].x;
  }
  return next;
}
`;

// One invocation owns one scalar parameter and its Adam moments. All read the
// previous state and sum gradients over the same labeled batch before writing.
const backprop=model+`
struct Train { count: u32, rate: f32, correctM: f32, correctV: f32 }
@group(0) @binding(2) var<storage, read_write> output: array<vec4f>;
@group(0) @binding(3) var<uniform> train: Train;
@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index > OUTPUT_BIAS) { return; }
  let unit = index / 4u;
  let slot = index % 4u;
  var gradient = 0.0;
  for (var row = 0u; row < train.count; row++) {
    let sample = examples[row];
    let probability = 1.0 / (1.0 + exp(-clamp(logit(sample.xy), -40.0, 40.0)));
    let residual = probability - sample.z;
    var factor = 1.0;
    if (index != OUTPUT_BIAS) {
      let activation = hidden(sample.xy, unit);
      if (slot == 3u) { factor = activation; }
      else {
        factor = state[4u * unit + 3u].x * (1.0 - activation * activation);
        if (slot == 0u) { factor *= sample.x; }
        if (slot == 1u) { factor *= sample.y; }
      }
    }
    gradient += residual * factor;
  }
  gradient /= f32(train.count);
  let before = state[index];
  let m = 0.9 * before.y + 0.1 * gradient;
  let v = 0.999 * before.z + 0.001 * gradient * gradient;
  let adjusted = train.rate * (m * train.correctM) / (sqrt(v * train.correctV) + 1e-8);
  output[index] = vec4f(before.x - adjusted, m, v, 0.0);
}
`;

const atlas=model+`
struct Readout { count: u32, stride: u32, extent: f32, padding: f32 }
@group(0) @binding(2) var<storage, read_write> result: array<f32>;
@group(0) @binding(3) var<uniform> readout: Readout;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  let vertices = readout.stride * readout.stride;
  if (index >= vertices + readout.count) { return; }
  var xy = vec2f(0.0);
  if (index < vertices) {
    let x = f32(index % readout.stride);
    let y = f32(index / readout.stride);
    xy = (vec2f(x, y) * (2.0 / f32(readout.stride - 1u)) - vec2f(1.0)) * readout.extent;
  } else {
    xy = examples[index - vertices].xy;
  }
  result[index] = logit(xy);
}
`;

export async function prepareTrainer(engine, signal) {
  const gpu=await createCompute({engine,signal});
  const trainKernel=gpu.kernel(backprop,{label:'Neural Playground backpropagation'});
  const readKernel=gpu.kernel(atlas,{label:'Neural Playground atlas'});
  const weights=openingWeights();
  let current=gpu.array(weights), next=gpu.zeros(weights.length), count=0, iteration=0, samples;
  const examples=gpu.zeros(4*maxSamples);
  const stride=resolution+1, vertices=stride*stride;
  const result=gpu.zeros(vertices+maxSamples);

  function edit(rows){
    count=rows.length;
    samples=rows;
    examples.write(Float32Array.from({length:count*4},(_,i)=>rows[i>>2][i%4]??0));
  }

  function reset(rows){
    iteration=0;
    current.write(weights);
    edit(rows);
  }

  function step(steps,rate=.045){
    for(let i=0;i<steps;i++){
      iteration++;
      const train={count,rate,correctM:1/(1-.9**iteration),correctV:1/(1-.999**iteration)};
      trainKernel.run({state:current,examples,output:next,train},{count:parameterCount});
      [current,next]=[next,current];
    }
  }

  async function sample(){
    readKernel.run({state:current,examples,result,readout:{count,stride,extent:domain,padding:0}},
      {count:vertices+count});
    const scores=await result.read({length:vertices+count,signal});
    let loss=0, correct=0;
    for(let i=0;i<count;i++){
      const value=scores[vertices+i], label=samples[i][2], signed=label?value:-value;
      correct+=Number((value>=0?1:0)===label);
      loss+=Math.log1p(Math.exp(-Math.abs(signed)))+Math.max(0,-signed);
    }
    return {margin:scores.subarray(0,vertices),loss:loss/count,correct};
  }

  return {reset,edit,step,sample,dispose:()=>gpu.dispose(),backend:gpu.backend};
}
