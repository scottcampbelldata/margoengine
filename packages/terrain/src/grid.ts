export function clipmapGrid(resolution:number):{vertices:Float32Array;center:Uint32Array;ring:Uint32Array} {
  if(!Number.isInteger(resolution)||resolution<8||resolution>256||resolution%4)throw new RangeError('Clipmap resolution must be a multiple of four in 8..256');
  const vertices=new Float32Array((resolution+1)**2*2),center:number[]=[],ring:number[]=[];
  for(let z=0;z<=resolution;z++)for(let x=0;x<=resolution;x++)vertices.set([x-resolution/2,z-resolution/2],(z*(resolution+1)+x)*2);
  for(let z=0;z<resolution;z++)for(let x=0;x<resolution;x++){const a=z*(resolution+1)+x,b=a+1,c=a+resolution+1,d=c+1,indices=[a,c,b,b,c,d];center.push(...indices);if(x<resolution/4||x>=resolution*3/4||z<resolution/4||z>=resolution*3/4)ring.push(...indices);}
  return {vertices,center:new Uint32Array(center),ring:new Uint32Array(ring)};
}
