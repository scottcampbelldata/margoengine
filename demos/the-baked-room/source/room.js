export const width=256,height=192;
export const albedo=[.62,.57,.51];
export const sunlight={direction:[-.72,.63,.286],color:[1,.81,.61],intensity:5.02};
export const skylight={color:[.63,.77,1],intensity:.245};
export const options={width,height,seed:15733,dilate:2,radiometry:'physical',bounces:2,albedo,
  aoDistance:2.5,bias:.007,maxSamples:width*height,
  lights:[
    {type:'directional',...sunlight},
    {type:'ambient',...skylight},
  ]};

const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normal=v=>{const length=Math.hypot(...v)||1;return v.map(x=>x/length);};
function linear(hex){
  return [1,3,5].map(at=>{
    const s=Number.parseInt(hex.slice(at,at+2),16)/255;
    return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;
  });
}

const finishes={
  lime:'#ddd0bb', plaster:'#c5bca8', shade:'#b7ac96', sand:'#b89d7f', inlay:'#876f58',
  amber:'#aa664b', ember:'#995344', blush:'#b17359', slate:'#4c6564', celadon:'#668782',
  grove:'#43756d', oak:'#9c7455', hardwood:'#806247', bronze:'#a78461', ink:'#424945',
  white:'#e0cbb0', black:'#494641',
};

function cut(raw,a){
  if(a.x+a.w<=raw.x||a.x>=raw.x+raw.w||a.y+a.h<=raw.y||a.y>=raw.y+raw.h)return [raw];
  const result=[];
  if(a.x>raw.x)result.push({x:raw.x,y:raw.y,w:a.x-raw.x,h:raw.h});
  if(a.x+a.w<raw.x+raw.w)result.push({x:a.x+a.w,y:raw.y,w:raw.x+raw.w-a.x-a.w,h:raw.h});
  if(a.y>raw.y)result.push({x:raw.x,y:raw.y,w:raw.w,h:a.y-raw.y});
  if(a.y+a.h<raw.y+raw.h)result.push({x:raw.x,y:a.y+a.h,w:raw.w,h:raw.y+raw.h-a.y-a.h});
  return result;
}

function pack(charts){
  const gutter=3;
  for(const scale of [10,9,8,7,6,5]){
    let spaces=[{x:0,y:0,w:width,h:height}];
    const reserved=[];
    const sizes=charts.map(chart=>({w:Math.max(2,Math.round(chart.w*scale))+2*gutter,
      h:Math.max(2,Math.round(chart.h*scale))+2*gutter,chart}));
    sizes.sort((a,b)=>b.w*b.h-a.w*a.h);
    for(const {w,h,chart} of sizes){
      let best,indexScore=Infinity;
      for(const room of spaces){
        if(w>room.w||h>room.h)continue;
        const score=Math.min(room.w-w,room.h-h)*width+Math.max(room.w-w,room.h-h);
        if(score<indexScore){best=room;indexScore=score;}
      }
      if(!best)break;
      const fit={x:best.x,y:best.y,w,h};
      const rest=spaces.flatMap(room=>cut(room,fit));
      spaces=rest.filter((room,i)=>!rest.some((other,j)=>i!==j&&
        room.x>=other.x&&room.y>=other.y&&room.x+room.w<=other.x+other.w&&room.y+room.h<=other.y+other.h&&
        (room.w<other.w||room.h<other.h||j<i)));
      reserved.push({chart,x:fit.x+gutter,y:fit.y+gutter,w:w-2*gutter,h:h-2*gutter});
    }
    if(reserved.length===charts.length)return reserved;
  }
  throw new RangeError('The room surfaces do not fit their lightmap atlas.');
}

export function buildRoom(){
  const charts=[];
  function quad(name,points,width,height){
    const n=normal(cross(subtract(points[1],points[0]),subtract(points[2],points[0])));
    charts.push({name,w:width,h:height,p:points,n:points.map(()=>n),uv:[[0,1],[1,1],[1,0],[0,0]],i:[0,1,2,0,2,3]});
  }
  function horizontal(name,y,x0,x1,z0,z1,invert=false){
    const p=[[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]];
    quad(name,invert?p.reverse():p,x1-x0,z0-z1);
  }
  function across(name,z,x0,x1,y0,y1,invert=false){
    const p=[[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]];
    quad(name,invert?p.reverse():p,x1-x0,y1-y0);
  }
  function side(name,x,z0,z1,y0,y1,invert=false){
    const p=[[x,y0,z0],[x,y0,z1],[x,y1,z1],[x,y1,z0]];
    quad(name,invert?p.reverse():p,z0-z1,y1-y0);
  }
  function solid(name,x0,x1,y0,y1,z0,z1){
    horizontal(name,y1,x0,x1,z0,z1);
    horizontal(name,y0,x0,x1,z0,z1,true);
    across(name,z0,x0,x1,y0,y1);
    across(name,z1,x0,x1,y0,y1,true);
    side(name,x1,z0,z1,y0,y1);
    side(name,x0,z0,z1,y0,y1,true);
  }

  const left=-3.48,right=3.40,far=-4.4,near=3.75,ceiling=3.60;
  horizontal('sand',0,left,right,near,far);
  across('lime',far,left,right,0,ceiling);
  side('plaster',left,near,far,0,.96);
  side('plaster',left,near,far,2.88,ceiling);
  side('shade',left,near,2.00,.96,2.88);
  side('plaster',left,-3.72,far,.96,2.88);
  side('lime',right,-.70,far,0,ceiling,true);
  horizontal('lime',ceiling,left,-2.68,near,far,true);
  horizontal('lime',ceiling,-1.84,right,near,far,true);
  horizontal('plaster',ceiling,-2.68,-1.84,near,-.51,true);
  horizontal('plaster',ceiling,-2.68,-1.84,-3.16,far,true);

  // Thick recessed window reveals and oak fins cast the long reading-room shadows.
  horizontal('shade',.96,left-.31,left,2,-3.72);
  horizontal('shade',2.88,left-.31,left,2,-3.72,true);
  across('shade',2,left-.31,left,.96,2.88,true);
  across('shade',-3.72,left-.31,left,.96,2.88);
  for(let i=0;i<9;i++){
    const z=1.68-i*.60;
    solid(i%3?'oak':'hardwood',left-.28,left+.056,.97,2.873,z+.034,z-.033);
  }

  // A low cabinet recess and handmade terracotta panel anchor the right wall.
  solid('shade',1.35,3.21,.012,.46,-3.43,-4.34);
  solid('oak',1.28,3.25,.452,.517,-3.38,-4.35);
  across('plaster',far+.011,-3.38,3.30,.027,.104);
  for(let i=0;i<8;i++){
    const x=.54+i*.307, color=['amber','blush','ember'][i%3];
    solid(color,x,x+.281,.79,3.085,-4.321,-4.396);
  }
  solid('bronze',.44,3.06,3.104,3.135,-4.28,-4.40);
  solid('bronze',.44,3.06,.752,.777,-4.28,-4.40);
  solid('slate',-2.14,-.22,.012,.314,-2.45,-3.77);
  solid('celadon',-2.16,-.20,.309,.356,-2.43,-3.79);

  // Cabinet seating, slat construction and a floor border.
  solid('hardwood',1.50,1.62,.032,.41,-.92,-2.29);
  solid('hardwood',2.93,3.05,.032,.41,-.92,-2.29);
  solid('oak',1.40,3.16,.402,.482,-.869,-2.344);
  for(let i=0;i<5;i++){
    const z=-.95-i*.299;
    solid(i%3?'oak':'bronze',1.39,3.17,.484,.508,z,z-.213);
  }
  horizontal('inlay',.001,left+.17,left+.22,2.83,-4.108);
  horizontal('inlay',.001,left+.17,right-.11,-4.106,-4.147);
  horizontal('inlay',.001,right-.16,right-.111,2.83,-4.108);

  // Room-specific lightmap charts follow each lathed surface all the way around.
  function pottery(name,x,y,z,profile,heightScale,axisScale=1){
    const segments=36, p=[],n=[],uv=[],i=[];
    const lengths=[0];
    for(let j=1;j<profile.length;j++){
      lengths.push(lengths[j-1]+Math.hypot((profile[j][0]-profile[j-1][0])*heightScale,profile[j][1]-profile[j-1][1]));
    }
    const surfaceLength=lengths.at(-1),rmax=Math.max(...profile.map(ring=>ring[1]));
    for(let row=0;row<profile.length;row++){
      const [level,r]=profile[row], [lo,r0]=profile[Math.max(0,row-1)], [hi,r1]=profile[Math.min(profile.length-1,row+1)];
      for(let segment=0;segment<=segments;segment++){
        const t=2*Math.PI*segment/segments, c=Math.cos(t),s=Math.sin(t);
        const wrinkle=1+.024*Math.cos(t*7+.31)+.019*Math.cos(t*3-level*3.3);
        p.push([x+r*wrinkle*c,y+heightScale*level,z+axisScale*r*wrinkle*s]);
        n.push(normal([(hi-lo)*heightScale*c,r0-r1,(hi-lo)*heightScale*s/axisScale]));
        uv.push([segment/segments,1-lengths[row]/surfaceLength]);
        if(segment>0&&row>0){
          const k=row*(segments+1)+segment,a=k-segments-2;
          i.push(a,k-1,k,a,k,a+1);
        }
      }
    }
    charts.push({name,w:2*Math.PI*rmax,h:surfaceLength,p,n,uv,i});
  }
  const bowl=[[0,.09],[.04,.18],[.105,.29],[.18,.38],[.265,.428],[.33,.441],[.42,.446],
    [.515,.426],[.599,.372],[.68,.274],[.760,.213],[.85,.191],[.918,.195],[.945,.231]];
  pottery('grove',-.99,.356,-2.98,bowl,1.29,1.02);
  pottery('celadon',-.99,.356,-2.98,[[.945,.231],[.968,.224],[.974,.197],[.947,.177]],1.29,1.02);
  pottery('white',-1.71,.356,-2.66,[[0,.065],[.055,.162],[.11,.197],[.25,.216],[.38,.192],
    [.53,.121],[.70,.090],[.83,.099],[.86,.092]],.84,1.04);
  pottery('ember',-1.77,.356,-3.38,[[0,.083],[.068,.125],[.14,.141],[.23,.123],[.34,.065],[.50,.071]],.66);
  pottery('amber',2.44,.517,-3.86,[[0,.09],[.07,.16],[.17,.19],[.28,.19],[.38,.135],[.52,.079],[.60,.084]],.94);

  const positions=[], normals=[], indices=[], uv1=[], drawn=[], rectangles=[];
  for(const {chart,x,y,w,h} of pack(charts)){
    rectangles.push({x,y,w,h});
    const color=linear(finishes[chart.name]),base=positions.length/3;
    for(let i=0;i<chart.p.length;i++){
      const p=chart.p[i],n=chart.n[i],uv=[(x+w*chart.uv[i][0])/width,(y+h*chart.uv[i][1])/height];
      positions.push(...p);normals.push(...n);uv1.push(...uv);
      drawn.push(...p,...uv,...color);
    }
    for(const i of chart.i)indices.push(base+i);
  }
  return {
    mesh:{positions:new Float32Array(positions),normals:new Float32Array(normals),
      indices:new Uint32Array(indices),uv1:new Float32Array(uv1)},
    vertices:new Float32Array(drawn), count:charts.length,rectangles,
  };
}

export function roomCamera(engine,narrow){
  engine.camera.position=narrow?[2.56,1.78,4.25]:[3.72,1.92,4.67];
  engine.camera.target=narrow?[-.56,1.29,-2.00]:[-.48,1.38,-2.20];
  engine.camera.fov=narrow?58:42;
}
