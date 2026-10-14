export function clipmapGrid(resolution:number):{vertices:Float32Array;center:Uint32Array;ring:Uint32Array} {
  if(!Number.isInteger(resolution)||resolution<8||resolution>256||resolution%4)throw new RangeError('Clipmap resolution must be a multiple of four in 8..256');
  // The ring is every cell outside the middle half-by-half block, three quarters of the grid, so both index lists have known sizes.
  const side=resolution+1,vertices=new Float32Array(side**2*2),center=new Uint32Array(resolution**2*6),ring=new Uint32Array(resolution**2*9/2);
  for(let z=0,v=0;z<=resolution;z++)for(let x=0;x<=resolution;x++){vertices[v++]=x-resolution/2;vertices[v++]=z-resolution/2;}
  for(let z=0,i=0,r=0;z<resolution;z++)for(let x=0;x<resolution;x++){const a=z*side+x,b=a+1,c=a+side,d=c+1;center[i++]=a;center[i++]=c;center[i++]=b;center[i++]=b;center[i++]=c;center[i++]=d;
    if(x<resolution/4||x>=resolution*3/4||z<resolution/4||z>=resolution*3/4){ring[r++]=a;ring[r++]=c;ring[r++]=b;ring[r++]=b;ring[r++]=c;ring[r++]=d;}}
  return {vertices,center,ring};
}
