const tau = Math.PI * 2;
const f32 = (values) => Float32Array.from(values);
const u32 = (values) => Uint32Array.from(values);

function lathe(id, material, center, profile, divisions = 80) {
  const points = [], normals = [], faces = [];
  for (const [row,[radius,height]] of profile.entries()) {
    const from=profile[Math.max(0,row-1)],to=profile[Math.min(profile.length-1,row+1)];
    const dr=to[0]-from[0],dy=to[1]-from[1],normalScale=1/Math.hypot(dr,dy);
    for (let i = 0; i < divisions; i++) {
      const angle = i * tau / divisions;
      points.push(center[0] + radius * Math.cos(angle), center[1] + height, center[2] + radius * Math.sin(angle));
      normals.push(dy*Math.cos(angle)*normalScale,-dr*normalScale,dy*Math.sin(angle)*normalScale);
    }
  }
  for(let row=0;row<profile.length-1;row++){
    for(let i=0;i<divisions;i++){
      const j=(i+1)%divisions, a=row*divisions+i, b=row*divisions+j;
      faces.push(a,a+divisions,b,b,a+divisions,b+divisions);
    }
  }
  return {id,material,positions:f32(points),normals:f32(normals),indices:u32(faces)};
}

function extrusion(id, material, path, low, high) {
  const count = path.length;
  const positions = [low, high].flatMap(y => path.flatMap(([x,z])=>[x,y,z]));
  const faces = [];
  for(let j=1;j<count-1;j++) faces.push(0,j,j+1,count,count+j+1,count+j);
  for(let j=0;j<count;j++) {
    const k=(j+1)%count;
    faces.push(j,j+count,k,k,j+count,k+count);
  }
  return {id,material,positions:f32(positions),indices:u32(faces)};
}

function panel(id, material, a, b, c, d) {
  return {id,material,positions:f32([...a,...b,...c,...d]),indices:u32([0,1,2,0,2,3]),
    uvs:f32([0,0,1,0,1,1,0,1])};
}

function slab(id,material,x,z,width,length,low,high) {
  const a=x-width/2,b=x+width/2,c=z-length/2,d=z+length/2;
  return extrusion(id,material,[[a,c],[b,c],[b,d],[a,d]],low,high);
}

function walnutStreak(id, material, z, width) {
  const points=[],faces=[],steps=32;
  for(let j=0;j<=steps;j++){
    const x=-2.8+5.6*j/steps;
    const grain=z+.027*Math.sin(1.8*x+z*4)+.012*Math.sin(6.4*x+z*10);
    points.push(x,.0007,grain-width,x,.0007,grain+width);
    if(j>0) faces.push(j*2-2,j*2-1,j*2,j*2,j*2-1,j*2+1);
  }
  return {id,material,positions:f32(points),indices:u32(faces)};
}

export const flintGlass = { index:1.68, abbe:24 };

export function prismFootprint() {
  const turn=-41*Math.PI/180,c=Math.cos(turn),s=Math.sin(turn);
  return [[-.31,.17],[0,-.37],[.31,.17]].map(([x,z])=>[.48+c*x+s*z,-.20-s*x+c*z]);
}

export function glasshouse({ analyticSlits = false } = {}) {
  const materials=[
    {id:1,type:'plastic',color:[.12,.047,.025],roughness:.41},
    {id:2,type:'diffuse',color:[.25,.31,.30],roughness:.65},
    {id:3,type:'glass',color:[.81,.98,1],roughness:.008,ior:1.51,abbe:59,density:.20,tint:false},
    {id:4,type:'glass',color:[.94,.97,1],roughness:.008,ior:flintGlass.index,abbe:flintGlass.abbe,density:.05,tint:false},
    {id:5,type:'metal',color:[.61,.34,.12],roughness:.19},
    {id:6,type:'metal',color:[.23,.28,.31],roughness:.23},
    {id:7,type:'diffuse',color:[.86,.86,.77],roughness:.52},
    {id:8,type:'diffuse',color:[.12,.05,.038],roughness:.63},
    {id:9,type:'glass',color:[.76,.94,.55],roughness:.012,ior:1.54,abbe:28,density:.32,tint:false},
    {id:10,type:'plastic',color:[.146,.060,.036],roughness:.40},
    {id:11,type:'plastic',color:[.098,.038,.019],roughness:.42},
    {id:12,type:'plastic',color:[.130,.055,.026],roughness:.43},
    ...(!analyticSlits ? [{id:13,type:'emit',color:[1,1,1],emission:10}] : []),
    {id:14,type:'diffuse',color:[.023,.033,.037],roughness:.72},
  ];
  const flint=prismFootprint();
  const meshes=[
    panel('figured walnut worktop',1,[-2.80,0,1.60],[2.80,0,1.60],[2.80,0,-2.75],[-2.80,0,-2.75]),
    slab('chamfer shadow in front table apron',8,0,-.57,5.6,4.35,-.135,-.004),
    panel('deep mineral wall',2,[-4,-.41,-2.62],[4,-.41,-2.62],[4,4.2,-2.62],[-4,4.2,-2.62]),
    panel('plaster below aperture',2,[-3.02,-.4,2],[-3.02,-.4,-2.62],[-3.02,1.47,-2.62],[-3.02,1.47,2]),
    panel('plaster above aperture',2,[-3.02,1.57,2],[-3.02,1.57,-2.62],[-3.02,4.2,-2.62],[-3.02,4.2,2]),
    panel('aperture south jamb',2,[-3.02,1.47,2],[-3.02,1.47,-.373],[-3.02,1.57,-.373],[-3.02,1.57,2]),
    panel('aperture north jamb',2,[-3.02,1.47,-.470],[-3.02,1.47,-2.62],[-3.02,1.57,-2.62],[-3.02,1.57,-.470]),
    slab('fired porcellain caustic plate',7,.41,.01,1.48,.62,.009,.030),
    slab('spectral receiver tile',7,1.39,.965,.58,.35,.001,.022),
    slab('calibrated light box',14,.17,-1.62,1.26,.11,.14,.98),
    slab('blackened brass prism foot',6,.47,-.24,.62,.43,.036,.176),
    slab('brass prism insert',5,.47,-.24,.58,.39,.177,.189),
    extrusion('high-dispersion flint prism',4,flint,.193,.751),
    lathe('crown glass reservoir',3,[-.64,.003,-.09],
      [[.0001,0],[.192,0],[.216,.025],[.232,.11],[.246,.30],[.255,.52],[.253,.69],[.236,.80],
      [.185,.879],[.112,.927],[.099,.974],[.100,1.12],[.111,1.145],[.112,1.162],[.077,1.166],
      [.061,1.144],[.064,1.088],[.065,.99],[.09,.947],[.156,.908],[.204,.85],[.222,.76],[.229,.62],
      [.223,.39],[.212,.19],[.195,.11],[.157,.092],[.0001,.083]]),
    lathe('turned brass cap',5,[-.64,1.154,-.09],
      [[.0001,0],[.105,0],[.116,.012],[.117,.039],[.109,.054],[.085,.062],[.080,.116],[.073,.135],
      [.044,.156],[.0001,.161]]),
    lathe('brass sampling weight',5,[-.09,.005,.42],
      [[.0001,0],[.115,0],[.127,.011],[.127,.035],[.123,.046],[.091,.05],[.090,.181],[.073,.195],
      [.064,.225],[.0001,.226]]),
    lathe('green calibration bead',9,[.98,.109,.17],
      [[.0001,-.076],[.055,-.071],[.084,-.048],[.103,-.016],[.100,.023],[.083,.057],[.057,.081],[.0001,.088]]),
    lathe('machined calibration bead socket',6,[.98,.003,.17],
      [[.0001,0],[.14,0],[.148,.009],[.148,.028],[.132,.039],[.075,.048],[.061,.054],[.0001,.057]]),
  ];
  for(const [index,x] of [-.31,-.05,.21,.47,.73].entries()) {
    if (!analyticSlits) meshes.push(panel('white reference slit '+index,13,[x-.007,.247,-1.564],[x+.007,.247,-1.564],
      [x+.007,.876,-1.564],[x-.007,.876,-1.564]));
  }
  for(let band=0;band<5;band++) {
    const y=.03+.082*band;
    meshes.push(lathe('prism mount screw ring '+band,5,[.804,y,-.34],
      [[.035,0],[.049,0],[.05,.004],[.045,.009],[.035,.009],[.035,0]],26));
  }
  for(let line=0;line<131;line++){
    const t=line/131,z=-2.7+4.25*t+.011*Math.sin(line*8.11);
    meshes.push(walnutStreak('walnut grain '+line,10+line%3,z,.0023+.006*Math.sin(line*3.12)**2));
  }
  const lights=[
    {position:[-1.76,1.92,.17],direction:[1.50,-1.32,-.26],width:.24,height:.63,color:[1,.889,.76],intensity:49,opaque:false},
    {position:[.25,2.30,-1.1],direction:[-.12,-1.94,1.0],width:2.13,height:.66,color:[.68,.83,1],intensity:12,opaque:false},
    {position:[1.26,.78,1.52],direction:[-1,-.8,-1.3],width:1.23,height:.62,color:[1,.74,.62],intensity:3.2,opaque:false},
    // In the browser these visible rectangles retain the apertures without separate emissive triangle acceleration.
    ...(analyticSlits ? [-.31,-.05,.21,.47,.73].map(x=>({
      position:[x,.5615,-1.564], direction:[0,0,1], width:.014, height:.629,
      color:[1,1,1], intensity:10, opaque:true,
    })) : []),
  ];
  return {revision:1,models:[],instances:[],materials,meshes,lights,
    environment:{ground:false,skyColor:[.52,.63,.78],skyIntensity:.15,sunIntensity:8.45,
      sunDirection:[-1,.29,0],sunAngularSize:.006}};
}
