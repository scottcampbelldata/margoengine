const hues=[[119,111,90],[175,89,58],[231,188,132],[47,112,115]];
const hatch=(x,z)=>Math.sin(6.2831853*x)*.50+Math.cos(6.2831853*z)*.50;
export const layers=[.0038,.0043,.0051,.0032].map(scale=>({height:[-250,1400],slope:[0,1],scale}));

export function layerTexture(device){
  const size=32,mips=6;
  const result=device.createTexture({label:'T_CanyonlandsPigment_SRGB',size:[size,size,4],mipLevelCount:mips,
    format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  for(let mip=0;mip<mips;mip++){
    const n=size>>mip,data=new Uint8Array(n*n*4*4);
    for(let l=0;l<4;l++)for(let j=0;j<n;j++)for(let i=0;i<n;i++){
      const u=(i+.5)/n,v=(j+.5)/n,q=((l*n+j)*n+i)*4;
      const fold=.48*hatch(u,v)+.23*hatch(u*3+v*2,v*7)+.11*hatch(u*9,v*16);
      const residue=[22,21,18,11][l]*fold*Math.min(1,n*.30);
      for(let c=0;c<3;c++)data[q+c]=Math.round(hues[l][c]+residue);
      data[q+3]=255;
    }
    device.queue.writeTexture({texture:result,mipLevel:mip},data,{bytesPerRow:4*n,rowsPerImage:n},[n,n,4]);
  }
  return result;
}

export const home={position:[16672,1065,14240],target:[15115,140,15840],near:24,far:14500};
export const sun=[-.526,.435,-.731];
export const horizon=[.405,.478,.505];

const linearLight='if(frame.heights.w>0.5){return vec4f(linear,1);}';
const rasterOutput='let mapped=pbrNeutral(max(linear,vec3f(0)));';
export const terrainLook={
  bindings(){return [];},
  shader(source){
    if(!source.includes(linearLight)||!source.includes(rasterOutput))throw Error('Terrain color hooks changed at the engine pin.');
    const pigment=String.raw`
    var lookColor=linear;
    let surveyDistance=length(frame.eye.xz-i.position.xz);
    let strata=1.0+0.095*sin(i.position.y*.087+.30*sin(i.position.x*.0037))+0.045*sin(i.position.y*.26);
    let slope=1.0-clamp(n.y,0.0,1.0);
    lookColor *= mix(1.0,strata,smoothstep(0.035,0.22,slope));
    let river=smoothstep(0.025,0.105,base.g-base.r);
    let ripple=0.019*sin(i.position.x*.079+i.position.z*.167)+0.012*sin(i.position.x*.193-i.position.z*.051);
    let shallows=pow(max(1.0-abs(v.y),0.0),4.0);
    lookColor=mix(lookColor,lookColor*(1.0+ripple)+vec3f(0.035,0.045,0.043)*shallows,river);
    let contour=(i.position.y+1180.0)/25.0;
    let distanceToLine=abs(fract(contour+0.5)-0.5);
    let contourWidth=clamp(fwidth(contour),0.013,0.16);
    let mark=1.0-smoothstep(contourWidth*.43,contourWidth*1.08,distanceToLine);
    lookColor *= 1.0-0.16*mark*(1.0-river)*(1.0-smoothstep(1800.0,3400.0,surveyDistance));
    let air=smoothstep(2720.0,5450.0,surveyDistance);
    lookColor=mix(lookColor,vec3f(HORIZON),air*air);
    if(i.position.y < -22.0){discard;}
    if(frame.heights.w>0.5){return vec4f(lookColor,1);}
    `.replace('HORIZON',horizon.join(','));
    return source.replace(linearLight,pigment).replace(rasterOutput,'let mapped=pbrNeutral(max(lookColor,vec3f(0)));');
  },
};
