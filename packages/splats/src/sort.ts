const settings=`struct Sort {count:u32,groups:u32,blocks:u32,shift:u32}
@group(0) @binding(0) var<uniform> sort:Sort;`;
export const histogram=settings+`
@group(0) @binding(1) var<storage,read> input:array<vec2u>;
@group(0) @binding(2) var<storage,read_write> histograms:array<u32>;
var<workgroup> bins:array<atomic<u32>,16>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3u){
  if(lane<16){atomicStore(&bins[lane],0);}workgroupBarrier();
  if(id.x<sort.count){atomicAdd(&bins[(input[id.x].x>>sort.shift)&15],1);}workgroupBarrier();
  if(lane<16){histograms[lane*sort.groups+group.x]=atomicLoad(&bins[lane]);}}`;
export const scan=settings+`
@group(0) @binding(1) var<storage,read> histograms:array<u32>;
@group(0) @binding(2) var<storage,read_write> offsets:array<u32>;
@group(0) @binding(3) var<storage,read_write> totals:array<u32>;
var<workgroup> values:array<u32,256>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3u){
  let index=group.x*256+lane;values[lane]=0;if(index<sort.groups){values[lane]=histograms[group.y*sort.groups+index];}workgroupBarrier();
  for(var stride=1u;stride<256;stride*=2){let at=(lane+1)*stride*2-1;if(at<256){values[at]+=values[at-stride];}workgroupBarrier();}
  if(lane==0){totals[group.y*sort.blocks+group.x]=values[255];values[255]=0;}workgroupBarrier();
  for(var stride=128u;stride>0;stride/=2){let at=(lane+1)*stride*2-1;if(at<256){let left=values[at-stride];values[at-stride]=values[at];values[at]+=left;}workgroupBarrier();}
  if(index<sort.groups){offsets[group.y*sort.groups+index]=values[lane];}}`;
export const scanTotals=settings+`
@group(0) @binding(1) var<storage,read> totals:array<u32>;
@group(0) @binding(2) var<storage,read_write> bases:array<u32>;
var<workgroup> values:array<u32,1024>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) lane:u32){
  for(var i=lane;i<1024;i+=256){values[i]=0;if(i<sort.blocks*16){values[i]=totals[i];}}workgroupBarrier();
  for(var stride=1u;stride<1024;stride*=2){for(var i=lane;i<1024/(stride*2);i+=256){let at=(i+1)*stride*2-1;values[at]+=values[at-stride];}workgroupBarrier();}
  if(lane==0){values[1023]=0;}workgroupBarrier();
  for(var stride=512u;stride>0;stride/=2){for(var i=lane;i<1024/(stride*2);i+=256){let at=(i+1)*stride*2-1;let left=values[at-stride];values[at-stride]=values[at];values[at]+=left;}workgroupBarrier();}
  for(var i=lane;i<sort.blocks*16;i+=256){bases[i]=values[i];}}`;
export const scatter=settings+`
@group(0) @binding(1) var<storage,read> input:array<vec2u>;
@group(0) @binding(2) var<storage,read_write> output:array<vec2u>;
@group(0) @binding(3) var<storage,read> offsets:array<u32>;
@group(0) @binding(4) var<storage,read> bases:array<u32>;
var<workgroup> masks:array<atomic<u32>,128>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3u){
  if(lane<128){atomicStore(&masks[lane],0);}workgroupBarrier();
  var item=vec2u(0);var digit=0u;let word=lane/32;let bit=lane%32;
  if(id.x<sort.count){item=input[id.x];digit=(item.x>>sort.shift)&15;atomicOr(&masks[digit*8+word],1u<<bit);}workgroupBarrier();
  if(id.x<sort.count){var rank=countOneBits(atomicLoad(&masks[digit*8+word])&((1u<<bit)-1));
    for(var i=0u;i<word;i++){rank+=countOneBits(atomicLoad(&masks[digit*8+i]));}
    let destination=bases[digit*sort.blocks+group.x/256]+offsets[digit*sort.groups+group.x]+rank;output[destination]=item;}}`;
