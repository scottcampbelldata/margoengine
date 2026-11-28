import {disc,polygonMesh,random,tau} from './geometry.js';
import {rail} from './paths.js';

const basin=(x,z)=>{
  const east=Math.max(0,Math.abs(x)-25),back=Math.max(0,-z-34),front=Math.max(0,z-30);
  const rim=Math.min(1,(east+back+front)/31);
  return -.092+rim*(1.15*Math.sin(.049*x+.037*z)+.68*Math.cos(.13*x-.06*z));
};
const stain=(x,z)=>.44*Math.sin(.103*x+.037*z)+.27*Math.cos(.188*z-.071*x)+.15*Math.sin(.33*x+.245*z);


export function landscape({paint,mesh,block,beam,diskAt}){
  const salt=['#aa9882','#b29f87','#b6a58d','#baa992','#bfaf98','#c4b59d','#c7b99f'].map(c=>paint(c,.96));
  const crust=salt.map(()=>polygonMesh());
  const samples=random(537),grid=[];
  const xSamples=[-149,-137,-125,-113,-101,-92,-83,-74,-65];
  const zSamples=[-140,-128,-116,-104,-92,-80,-68,-59,-50,-44,-38];
  for(let x=-62;x<65;x+=2.55)xSamples.push(x);
  for(let x=66;x<=150;x+=10)xSamples.push(x);
  for(let z=-34;z<54;z+=2.55)zSamples.push(z);
  for(let z=56;z<=132;z+=9.5)zSamples.push(z);
  for(const [ix,x] of xSamples.entries()){
    for(const [iz,z] of zSamples.entries()){
      const shake=.94,px=x+(samples()-.5)*shake,pz=z+(samples()-.5)*shake;
      (grid[ix]??=[])[iz]=[px,basin(px,pz),pz];
    }
  }
  function triangle(a,b,c){
    const x=(a[0]+b[0]+c[0])/3,z=(a[2]+b[2]+c[2])/3;
    const t=stain(x,z)-.12*Math.exp(-Math.pow((z+x*.08-3)/8,2))+
      .15*Math.sin(z*.47+x*.921)*Math.cos(z*.661-x*.143)+(samples()-.5)*.19;
    const brush=Math.max(0,Math.min(salt.length-1,Math.round((t+.70)*4.2)));
    crust[brush].face(a,b,c);
  }
  for(let x=1;x<grid.length;x++)for(let z=1;z<zSamples.length;z++){
    const [a,b,c,d]=[grid[x-1][z-1],grid[x][z-1],grid[x][z],grid[x-1][z]];
    if((x+z)%2){triangle(a,d,b);triangle(b,d,c);}
    else{triangle(a,d,c);triangle(a,c,b);}
  }
  const ridgeLines=[
    {z:-93,amplitude:14,slope:6,seed:1.4,colors:['#a38c82','#a69089','#b59d8e']},
    {z:-135,amplitude:26,slope:6,seed:4.6,colors:['#8f8890','#9b9599','#a09a9c']},
    {z:-196,amplitude:37,slope:8,seed:7.2,colors:['#93a0aa','#9ea9b0','#aab1b3']},
  ];
  for(const {z,amplitude,slope,seed,colors} of ridgeLines){
    const ridge=colors.map(()=>polygonMesh());
    const points=[];
    for(let x=-402;x<=402;x+=2.75){
      const t=x/39;
      const center=.54+.335*Math.sin(t+seed)+.118*Math.cos(2.7*t-seed)+.089*Math.sin(4.3*t+seed)+
        .035*Math.cos(9.9*t+seed*1.7)+.024*Math.sin(16.1*t+.84*seed);
      const elevation=1+Math.max(.03,center)*amplitude;
      const bend=Math.cos(t+seed)*16+Math.sin(2.1*t-seed)*13;
      points.push([
        [x,-2,z+bend+slope*4.7],
        [x,Math.max(.4,elevation*.44+Math.cos(5*t)*.7),z+bend+slope*2.25],
        [x,elevation,z+bend+Math.sin(t*2)*4],
        [x,-3,z+bend-slope*3],
      ]);
    }
    function normal(i,j){
      const from=points[Math.max(0,i-1)][j],to=points[Math.min(points.length-1,i+1)][j];
      const a=points[i][Math.max(0,j-1)],b=points[i][Math.min(3,j+1)];
      const x=to.map((v,k)=>v-from[k]),z=b.map((v,k)=>v-a[k]);
      const n=[x[1]*z[2]-x[2]*z[1],x[2]*z[0]-x[0]*z[2],x[0]*z[1]-x[1]*z[0]];
      return n.map(v=>v/Math.hypot(...n));
    }
    for(let i=1;i<points.length;i++)for(let j=0;j<3;j++){
      ridge[j].smoothQuad(points[i-1][j],points[i][j],points[i][j+1],points[i-1][j+1],
        [normal(i-1,j),normal(i,j),normal(i,j+1),normal(i-1,j+1)]);
    }
    for(let i=0;i<colors.length;i++)
      mesh('Atmospheric line of eroded ridges',ridge[i].geometry(),paint(colors[i],.98));
  }
  for(let i=0;i<crust.length;i++)mesh('Salt crust changes with mineral content',crust[i].geometry(),salt[i]);
  block('Salt plain continuing to the ridge line',paint('#b9aaa1',.97),[0,-4.8,-34],[1000,4,750]);

  const channels=[polygonMesh(),polygonMesh(),polygonMesh()];
  for(let j=0;j<3;j++){
    const offset=[-2.4,.4,4.2][j];
    function bend(x){return 29+Math.cos(x*.093)*1.9+Math.sin(x*.043+.70)*4+offset;}
    for(const [min,max] of [[-61,-27],[30,61]]){
      let previous;
      for(let x=min;x<=max;x+=.48){
        const z=bend(x),point=[x,basin(x,z)+.031,z];
        if(previous)channels[j].ribbon(previous,point,(j===1?2.1:.8)+(Math.sin(.44*x)*.38));
        previous=point;
      }
    }
  }
  for(let i=0;i<3;i++)mesh('Shallow seasonal brine channel',channels[i].geometry(),paint(['#859c95','#99aeaa','#98a79b'][i],.42));

  const grit=random(74),fractures=[polygonMesh(),polygonMesh()],stones=[polygonMesh(),polygonMesh(),polygonMesh()];
  for(let i=0;i<630;i++){
    const x=(grit()-.5)*100,z=(grit()-.6)*62;
    if(Math.abs(x)<21&&z>-8&&z<16)continue;
    const y=basin(x,z),r=.035+grit()*.22,a=grit()*tau,color=stones[i%3];
    const base=Array.from({length:5},(_,i)=>[x+r*Math.cos(a+i*tau/5),y-.02,z+r*.72*Math.sin(a+i*tau/5)]);
    const tip=[x+.25*r,y+r*(.26+grit()*.29),z-.09*r];
    for(let j=0;j<5;j++)color.face(base[(j+1)%5],base[j],tip);
  }
  for(let i=0;i<530;i++){
    const x=(grit()-.5)*105,z=(grit()-.52)*71;
    if(Math.abs(x)<23&&z>-8&&z<18&&grit()>.16)continue;
    const radius=.16+grit()*1.12,turn=grit()*tau,pts=[];
    for(let j=0;j<5;j++){
      const ang=turn+j*tau/5,r=radius*(.87+grit()*.30),a=x+Math.cos(ang)*r,b=z+Math.sin(ang)*r;
      pts.push([a,basin(a,b)+.019,b]);
    }
    for(let j=0;j<5;j++)fractures[i%2].ribbon(pts[j],pts[(j+1)%5],.014+grit()*.027);
  }
  for(const [i,c] of ['#958873','#a49b8c','#c0af92'].entries())
    mesh('Scale of salt and volcanic rubble',stones[i].geometry(),paint(c,.98));
  for(const [i,c] of ['#a8957c','#d4c1a5'].entries())
    mesh('Thin veins in mineral crust',fractures[i].geometry(),paint(c,.99));

  const deck=paint('#88877d',.87),warmCement=paint('#aaa795',.81);
  const asphalt=paint('#777973',.89),ink=paint('#c7bb97',.83),pebble=paint('#b9ac94',.97);
  const creases=polygonMesh(),ruts=polygonMesh();
  for(const z of [5.1,9,13.7]){
    for(let x=-23;x<24;x+=.45){
      const u=x+.45;
      const r=(x)=>z+Math.sin(x*.15)*.47;
      ruts.ribbon([x,-.045,r(x)],[u,-.045,r(u)],.16);
    }
  }
  for(let z=-7.6;z<14;z+=.46){
    const x=-21+1.5*Math.cos(.105*z);
    creases.ribbon([x,-.053,z],[x-.075,-.053,z+.46],1.52);
  }
  mesh('Compacted twin tracks in the flat',ruts.geometry(),pebble);
  mesh('Service-vehicle approach to the station',creases.geometry(),pebble);
  block('Equipment staging slab',deck,[0,.01,-9.95],[42,.20,4.35]);
  block('Building concrete plinth',warmCement,[-19.3,.09,-13.02],[12.6,.38,7.93]);
  const runway=polygonMesh();
  runway.quad([-24,.029,13.1],[-24,.029,16.1],[24,.029,16.1],[24,.029,13.1]);
  mesh('Film crew service shoulder',runway.geometry(),asphalt);
  for(let x=-22;x<=24;x+=2.2)block('Survey lane painted dash',ink,[x,.031,14.65],[.76,.009,.064]);

  const iron=paint('#55585c',.48,1),sleep=paint('#63564b',.89),chair=paint('#a07d53',.63);
  const lines=polygonMesh(),sleepers=polygonMesh(),joints=polygonMesh();
  function guide(distance){
    const center=Array.from(rail.atDistance(distance));center[1]=.083;return center;
  }
  for(let d=0;d<rail.length;d+=.56){
    const a=guide(d),b=guide(Math.min(rail.length,d+.56));
    if(d+.07<rail.length){
      const normal=[a[2]-b[2],b[0]-a[0]],length=Math.hypot(...normal);
      if(length<1e-8)continue;
      const [nx,nz]=normal.map(n=>n/length);
      for(const offset of [-.39,.39]){
        lines.ribbon([a[0]+nx*offset,.111,a[2]+nz*offset],[b[0]+nx*offset,.111,b[2]+nz*offset],.084);
        joints.ribbon([a[0]+nx*offset,.078,a[2]+nz*offset],[b[0]+nx*offset,.078,b[2]+nz*offset],.116);
      }
      sleepers.ribbon([a[0]-nx*.62,.066,a[2]-nz*.62],[a[0]+nx*.62,.066,a[2]+nz*.62],.12);
    }
  }
  mesh('Track sleeper beds',sleepers.geometry(),sleep);
  mesh('Rolled railway foot',joints.geometry(),chair);
  mesh('Narrow steel camera rails',lines.geometry(),iron);
  const cap=disc(.124,0,.13,.026,14);
  for(const [x,z] of [[-24,16.9],[23,15.8],[-24,-7.9],[22,-8.2],[19,-8.2]]){
    block('Low painted marker posts',deck,[x,.43,z],[.17,.83,.18]);
    diskAt('Amber reflector on lane marker',cap,chair,[x,.8,z]);
  }
  const railSteel=paint('#6e756e',.58,1);
  for(const side of [-1,1]){
    const x=side*21,z=-7.63;
    for(let i=0;i<5;i++)beam('Short equipment safety barrier post',railSteel,[x+side*i*.87,.13,z],[x+side*i*.87,1.1,z],.065,.07);
    for(const y of [.54,1.07])beam('Galvanized equipment safety barrier',railSteel,[x,y,z],[x+side*3.56,y,z],.073,.070);
  }
}
