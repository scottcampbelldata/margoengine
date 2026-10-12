// shortcut: one procedural cloud sheet, use volumetric clouds for flight through the layer.
export const cloudShader = /* wgsl */`
fn cloudNoise(p:vec2f)->f32 {
 let cell=floor(p);let f=fract(p);let t=f*f*(3.0-2.0*f);
 let a=fract(sin(dot(cell,vec2f(127.1,311.7)))*43758.5453);
 let b=fract(sin(dot(cell+vec2f(1,0),vec2f(127.1,311.7)))*43758.5453);
 let c=fract(sin(dot(cell+vec2f(0,1),vec2f(127.1,311.7)))*43758.5453);
 let d=fract(sin(dot(cell+vec2f(1,1),vec2f(127.1,311.7)))*43758.5453);
 return mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
}
fn cloudSky(color:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {
 if(frame.clouds.x<=0.0||ray.y<=0.05||frame.eye.y>=frame.clouds.z){return color;}
 // Clamping the intersection angle stretches distant cloud edges into vertical columns.
 let height=frame.clouds.z-frame.eye.y;
 var p=(frame.eye.xz+ray.xz*height/ray.y)*0.001+normalize(vec2f(1,0.35))*frame.clouds.y*0.001;
 var footprint=angularFootprint*height*0.001/(ray.y*ray.y);
 var density=0.0;var weight=0.5;
 for(var octave=0;octave<4;octave++){density+=mix(cloudNoise(p),0.5,smoothstep(0.35,1.0,footprint))*weight;p=p*2.03+vec2f(17,29);weight*=0.5;footprint*=2.03;}
 density=smoothstep(1.0-frame.clouds.x,1.18-frame.clouds.x,density/0.9375);
 let alpha=(1.0-exp(-density*2.5))*smoothstep(0.05,0.18,ray.y);
 let daylight=mix(vec3f(0.25,0.3,0.4),vec3f(1.5,1.65,1.8),smoothstep(-0.1,0.4,frame.sun.y));
 let silver=pow(clamp(dot(ray,frame.sun.xyz),0.0,1.0),8.0)*vec3f(0.6,0.4,0.2);
 let night=vec3f(0.008,0.013,0.025)+frame.moonColor.rgb*frame.moon.w*0.08;
 return mix(color,mix(daylight+silver,night,frame.sun.w),alpha);
}
`;
