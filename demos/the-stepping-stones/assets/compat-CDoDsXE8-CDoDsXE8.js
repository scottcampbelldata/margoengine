var e=`struct Sort {count:u32,groups:u32,blocks:u32,shift:u32}
@group(0) @binding(0) var<uniform> sort:Sort;
@group(0) @binding(1) var<storage,read_write> keys:array<vec2u>;
@group(0) @binding(2) var<storage,read_write> spare:array<vec2u>;
@compute @workgroup_size(1) fn main() {
  var at:array<u32,256>;
  for(var p=0u;p<4u;p++){
    let shift=p*8u;let even=p%2u==0u;
    for(var d=0u;d<256u;d++){at[d]=0u;}
    for(var i=0u;i<sort.count;i++){
      var key=0u;if(even){key=keys[i].x;}else{key=spare[i].x;}at[(key>>shift)&255u]+=1u;
    }
    var sum=0u;for(var d=0u;d<256u;d++){let n=at[d];at[d]=sum;sum+=n;}
    for(var i=0u;i<sort.count;i++){
      if(even){let k=keys[i];let d=(k.x>>shift)&255u;spare[at[d]]=k;at[d]+=1u;}
      else{let k=spare[i];let d=(k.x>>shift)&255u;keys[at[d]]=k;at[d]+=1u;}
    }
  }
}`;function t(t,n,r){let i=t.createComputePipeline({layout:`auto`,compute:{module:t.createShaderModule({code:e}),entryPoint:`main`}});return{pipeline:i,group:t.createBindGroup({layout:i.getBindGroupLayout(0),entries:[n,r[0],r[1]].map((e,t)=>({binding:t,resource:{buffer:e}}))})}}export{e as cpuSort,t as splatCompatSort};