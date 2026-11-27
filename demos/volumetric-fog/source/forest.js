const shades={
  track:'#907354',clay:'#897055',litter:'#6b604a',darkLitter:'#655c45',
  terrainMoss:'#68704a',rock:'#666b65',rockDark:'#545b55',
  cedar:'#685045',bark:'#56463e',ridge:'#795e50',greyBark:'#786b5d',
  rootMoss:'#798448',wood:'#9c7751',woodShade:'#72563c',
  pine:'#2f533f',pineLight:'#4b694f',tip:'#5d7950',pineShade:'#394c3f',
  fern:'#526c3b',fernNew:'#768e43',fernDark:'#3b5c3d',lichen:'#a6a47a',fungi:'#af8663',fungiEdge:'#a89b78',
};

const turn=2*Math.PI;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const scale=(a,s)=>a.map(v=>v*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalized=a=>scale(a,1/(Math.hypot(...a)||1));
const mid=(a,b,t=.5)=>a.map((v,i)=>v+(b[i]-v)*t);

function randomSource(start){
  let bits=start;
  return ()=>{
    bits^=bits<<13;
    bits^=bits>>>17;
    bits^=bits<<5;
    return (bits>>>0)/4294967296;
  };
}

function trail(z){
  return .55*Math.sin((z+4.)*.31)-.045*Math.max(0,2-z)+.72*Math.sin(z*.127);
}

function height(x,z){
  const d=Math.abs(x-trail(z));
  const mound=.42*Math.sin(x*.69+z*.16)+.26*Math.cos(x*.61-z*.47)
    +.20*Math.sin(x*.91-z*.29);
  return .025*(5-z)+(1-Math.exp(-.14*d*d))*(.31+mound)
    +.078*Math.sin(.86*z+.48*x)+.042*Math.sin(1.6*x-2.2*z);
}

export function prepareForest(){
  const num=randomSource(892315);
  const batches=new Map();
  function layer(name,caster){
    const key=name+':'+Number(caster);
    if(!batches.has(key))batches.set(key,{name,caster,positions:[],normals:[],indices:[]});
    return batches.get(key);
  }
  function vertex(data,point,normal){
    const index=data.positions.length/3;
    data.positions.push(...point);
    data.normals.push(...normal);
    return index;
  }
  function polygon(name,points,{normal,caster=false}={}){
    const data=layer(name,caster),head=data.positions.length/3;
    const normals=normal??normalized(cross(sub(points[1],points[0]),sub(points[2],points[0])));
    for(const point of points)vertex(data,point,normals);
    for(let i=1;i<points.length-1;i++)data.indices.push(head,head+i,head+i+1);
  }
  function needleWhorl(name,base,ridge,left,tip,right,normal){
    const data=layer(name,true),a=data.positions.length/3;
    for(const point of [base,ridge,left,tip,right])vertex(data,point,normal);
    data.indices.push(a,a+1,a+2,a+2,a+1,a+3,a+3,a+1,a+4,a+4,a+1,a);
  }
  function sharedVertex(data,point){
    const current=point.vertexIndices.get(data);
    if(current!==undefined)return current;
    const index=vertex(data,point.p,point.normal);
    point.vertexIndices.set(data,index);
    return index;
  }

  function pipe(name,centers,radii,{sides=8,ruffle=.09,seed=0,caster=true,stripes=false}={}){
    const nodes=[];
    for(let ring=0;ring<centers.length;ring++){
      const c=centers[ring],a=centers[Math.max(0,ring-1)],b=centers[Math.min(ring+1,centers.length-1)];
      const up=normalized(sub(b,a));
      const right=normalized(cross(up,Math.abs(up[2])>.94?[1,0,0]:[0,0,1]));
      const front=cross(right,up), radial=[];
      for(let j=0;j<sides;j++){
        const t=j/sides*turn;
        const vibration=Math.sin(t*3+seed)*.65+Math.cos(t*5+seed*2.20)*.34;
        const ripple=(1-vibration*ruffle)*(1+ruffle*.18*Math.sin(ring*1.8+j*4.8));
        const normal=add(scale(right,Math.cos(t)),scale(front,Math.sin(t)));
        radial.push({p:add(c,scale(normal,radii[ring]*ripple)),normal,vertexIndices:new Map()});
      }
      nodes.push(radial);
    }
    for(let i=0;i<nodes.length-1;i++){
      for(let j=0;j<sides;j++){
        const k=(j+1)%sides;
        const points=[nodes[i][j],nodes[i+1][j],nodes[i+1][k],nodes[i][k]];
        const stripe=stripes&&(j%6===2?'ridge':j%7===0?'bark':name);
        const data=layer(stripe||name,caster);
        const a=sharedVertex(data,points[0]),b=sharedVertex(data,points[1]);
        const c=sharedVertex(data,points[2]),d=sharedVertex(data,points[3]);
        data.indices.push(a,b,c,a,c,d);
        if(stripes&&i<5&&radii[i]>.24){
          const [lower,upper,upperNext,lowerNext]=points;
          const phase=seed*2.9+i*3.87+j*.71;
          const lo=.13+.19*Math.sin(phase), hi=lo+.49+.15*Math.sin(phase*2.3);
          const offset=.3+.19*Math.cos(phase*1.3);
          const width=.055+.03*Math.cos(phase*1.7);
          function point(h,v,lift){
            const inner=mid(mid(lower.p,upper.p,h),mid(lowerNext.p,upperNext.p,h),v);
            const outside=normalized(mid(lower.normal,lowerNext.normal,v));
            return add(inner,scale(outside,lift));
          }
          const ridgeLow=point(lo,offset,.004),ridgeHigh=point(hi,offset+.072,.003);
          const middle=point((hi+lo)/2,offset-.01,.031);
          polygon(j%3?'ridge':'greyBark',[ridgeLow,middle,ridgeHigh,point((hi+lo)/2,offset-width,.004)]);
          polygon(j%4?'cedar':'bark',[ridgeHigh,middle,ridgeLow,point((hi+lo)/2,offset+width,.004)]);
        }
      }
    }
  }

  // A nonuniform ground mesh and a winding, soft-edged trail.
  function surfacePoint(x,z,step){
    const drift=step*.19;
    const px=x+drift*Math.sin(x*12.379+z*5.94),pz=z+drift*Math.sin(z*11.113+x*2.378);
    const y=height(px,pz);
    return [px,y,pz];
  }
  function terrainPoint([x,y,z]){
    return {p:[x,y,z],normal:normalized([
      height(x-.03,z)-height(x+.03,z),.06,height(x,z-.03)-height(x,z+.03),
    ]),vertexIndices:new Map()};
  }
  function ground(a,b,c){
    const p=mid(a.p,mid(b.p,c.p),2/3), x=p[0],z=p[2],d=Math.abs(x-trail(z));
    const grain=Math.sin(x*2.24+Math.cos(z*1.40))*.38+Math.sin(x*.77-z*3.14)*.15
      +Math.sin(x*7.19+z*6.55)*.15;
    const edge=.93+.25*Math.cos(z*.73)+grain*.15;
    const name=d<edge?(grain>.06?'track':'clay'):
      d<edge+.25?'litter':grain>.07?'terrainMoss':grain<-.10?'darkLitter':'litter';
    const data=layer(name,false);
    data.indices.push(sharedVertex(data,a),sharedVertex(data,b),sharedVertex(data,c));
  }
  function terrain(startX,startZ,cols,rows,step){
    let top=Array.from({length:cols+1},(_,i)=>terrainPoint(surfacePoint(startX+i*step,startZ,step)));
    for(let row=1;row<=rows;row++){
      const z=startZ-row*step;
      const next=Array.from({length:cols+1},(_,i)=>terrainPoint(surfacePoint(startX+i*step,z,step)));
      for(let i=0;i<cols;i++){
        const a=top[i],b=top[i+1],c=next[i+1],d=next[i];
        if((i+row)%2){ground(a,b,d);ground(b,c,d);}
        else{ground(a,b,c);ground(a,c,d);}
      }
      top=next;
    }
  }
  terrain(-20,13,101,105,.40);
  terrain(-54,-28.63,48,26,2.30);

  // Variable radial ridges and irregular shoulders give the rocks a natural silhouette.
  function rock(x,z,w,d,h,phase,moss=false){
    const y=height(x,z)-.17*h;
    const belt=[],second=[],peak=[x+w*.12*Math.sin(phase),y+h,z-d*.18];
    for(let i=0;i<9;i++){
      const t=phase+i/9*turn, wave=1+.19*Math.sin(3*t+phase)+.14*Math.cos(t*4.1);
      belt.push([x+Math.cos(t)*w*wave,y+.15*h,z+Math.sin(t)*d*wave]);
      second.push([x+Math.cos(t)*w*wave*.74,y+h*(.52+.2*Math.sin(t*2)),z+Math.sin(t)*d*wave*.68]);
    }
    for(let i=0;i<belt.length;i++){
      const j=(i+1)%belt.length;
      polygon(i%4===0?'rockDark':'rock',[belt[i],second[i],second[j],belt[j]]);
      polygon(moss&&i%4!==0?'rootMoss':'rock',[second[i],peak,second[j]]);
    }
  }

  const twigs=['pine','pineLight','tip','pineShade'];
  function bough(start,end,weight,phase,close){
    const drift=sub(end,start);
    const xy=Math.hypot(drift[0],drift[2])||1;
    const side=[drift[2]/xy,0,-drift[0]/xy];
    for(let i=0;i<(close?8:3);i++){
      const t=.21+(close?.11:.27)*i;
      const p=mid(start,end,t);
      const forward=scale(normalized(drift),weight*(.47+.3*num()));
      const wide=(1-t)*weight*(.47+num()*.43);
      for(const sign of [-1,1]){
        const tip=add(add(p,scale(side,sign*wide)),forward);
        tip[1]-=weight*(.16+.20*num());
        const centre=mid(p,tip,.52),ridge=add(centre,[0,weight*.105,0]);
        const left=add(centre,scale(normalized([drift[0],0,drift[2]]),-.424*wide));
        const right=add(centre,scale(normalized([drift[0],0,drift[2]]),.35*wide));
        const n=normalized([side[0]*sign*.2,1,side[2]*sign*.2]);
        const m=twigs[Math.floor(num()*4)];
        if(close){
          needleWhorl(m,p,ridge,left,tip,right,n);
        }else{
          polygon(m,[p,left,tip,right],{normal:n,caster:true});
        }
      }
    }
    if(close)pipe('bark',[start,mid(start,end,.49),end],[weight*.082,weight*.041,weight*.008],
      {sides:5,seed:phase,ruffle:.12});
  }

  function tree(x,z,h,r,kind,near=false){
    const y=height(x,z)-.08,phase=num()*turn,dx=(num()-.5)*h*.11,dz=(num()-.5)*h*.082;
    const base=[x,y,z];
    const at=t=>[x+dx*t*t+.16*r*Math.sin(9*t+phase),y+h*t,z+dz*t*t-.11*r*Math.sin(12*t+phase)];
    const heights=near?[0,.015,.06,.15,.30,.48,.67,.83,1]:[0,.035,.21,.55,.83,1];
    pipe(kind,heights.map(at),heights.map(t=>r*(1-t)**.84*(1+.58*Math.exp(-t*38))+.006),
      {sides:near?16:9,ruffle:near?.20:.13,seed:phase,stripes:near});
    const roots=near?8:3;
    for(let i=0;i<roots;i++){
      const a=phase+i/roots*turn+.42*(num()-.5),length=r*(1.85+num()*2.95);
      const xx=x+length*Math.cos(a), zz=z+length*Math.sin(a);
      const mm=mid(base,[xx,y,zz],.51),root=[xx,height(xx,zz)+.011,zz];
      mm[1]=height(mm[0],mm[2])+r*.16;
      pipe(i%4?'bark':'rootMoss',[add(at(.02),[0,r*.21,0]),mm,root],[r*.41,r*.21,.008],
        {sides:near?7:5,seed:phase+i,caster:true});
    }
    const start=.37+num()*.18, count=near?11:8;
    for(let tier=0;tier<count;tier++){
      const t=start+tier/count*(.98-start),station=at(t);
      const number=near?6:4;
      const spread=Math.min(h*.16,h*(1-t)*.41);
      for(let i=0;i<number;i++){
        const a=phase+(i/number)*turn+tier*.72+(num()-.5)*.29;
        const len=spread*(.62+.45*num());
        const middle=add(station,[Math.cos(a)*len*.48,-len*.12,Math.sin(a)*len*.48]);
        const end=add(station,[Math.cos(a)*len,-len*(.15+.25*num()),Math.sin(a)*len]);
        bough(middle,end,len*.54,a,near);
        if(near)pipe(kind,[station,middle,end],[len*.045,len*.027,.009],{sides:5,seed:a});
      }
    }
  }

  // The broken cedar and the opening behind it frame the light in all lenses.
  for(const entry of [
    [-3.28,5.03,20.8,.76,'cedar'],[3.86,3.31,19.4,.50,'cedar'],
    [-2.56,-2.80,17.23,.39,'greyBark'],[2.73,-5.1,20.6,.36,'bark'],
    [6.26,-5.16,18.9,.49,'greyBark'],[-6.52,-6.02,23.3,.69,'bark'],
    [-4.86,-9.89,21.9,.46,'cedar'],[4.58,-13.36,18.6,.34,'greyBark'],
    [1.53,-15.59,17.4,.39,'cedar'],[-7.68,1.47,19.7,.50,'greyBark'],
    [-2.90,-18.8,17.5,.28,'greyBark'],[7.23,-18.99,23,.43,'cedar'],
    [-10.45,-9.38,17.5,.32,'greyBark'],[-14.77,-15.44,16.2,.31,'cedar'],
  ])tree(...entry,entry[0]>-10);
  for(let i=0;i<61;i++){
    const z=-9-i*.97+(num()-.5)*2.9, side=i%2===0?1:-1;
    const x=trail(z)+side*(3.6+num()*(Math.abs(z)*.30+5.2));
    tree(x,z,10+num()*14,.18+num()*.41,i%3===0?'greyBark':'bark');
  }

  const stumpX=-3.35,stumpZ=-.34,y=height(stumpX,stumpZ);
  pipe('cedar',[[stumpX,y-.09,stumpZ],[stumpX,y+.20,stumpZ],
    [stumpX+.10,y+1.16,stumpZ],[stumpX+.14,y+1.33,stumpZ]],
    [.60,.49,.37,.33],{sides:13,ruffle:.29,stripes:true,seed:31});
  for(let i=0;i<11;i++){
    const a=i/11*turn;
    const a1=a+.56, t=.7+.27*Math.cos(i*14.6);
    const cx=stumpX+.14,cz=stumpZ,r=.35;
    polygon(i%4===0?'woodShade':'wood',[
      [cx+Math.cos(a)*r,y+1.19,cz+Math.sin(a)*r],
      [cx+Math.cos(a+.25)*r*t,y+1.37+.21*num(),cz+Math.sin(a+.25)*r*t],
      [cx+Math.cos(a1)*r,y+1.20,cz+Math.sin(a1)*r],
      [cx+.041,y+1.05,cz+.064],
    ],{caster:true});
  }
  const logStart=[2.24,height(2.24,-2.8)+.29,-2.8],logTip=[8.12,height(8.12,-4.25)+.29,-4.25];
  const logMid=mid(logStart,logTip,.42);
  logMid[1]+=.35;
  pipe('cedar',[logStart,mid(logStart,logMid,.27),logMid,logTip],[.37,.43,.41,.32],
    {sides:15,ruffle:.15,seed:21,stripes:true});
  pipe('rootMoss',[add(logStart,[0,.218,.015]),add(logMid,[0,.29,.015]),add(logTip,[0,.21,.015])],
    [.17,.20,.10],{sides:9,ruffle:.30,seed:4});
  const cutNormal=normalized(sub(logStart,logMid)),axis=[0,1,0],offset=cross(cutNormal,axis);
  for(let r=1;r<5;r++){
    for(let i=0;i<13;i++){
      const a=i/13*turn, b=(i+1)/13*turn;
      const at=(a,r)=>add(add(logStart,scale(cutNormal,.006)),scale(add(scale(axis,Math.cos(a)),scale(offset,Math.sin(a))),r));
      polygon(r%2?'wood':'woodShade',[at(b,.071*(r-1)),at(b,.073*r),at(a,.073*r),at(a,.071*(r-1))],
        {normal:cutNormal,caster:true});
    }
  }

  for(const [along,radius] of [[.08,.154],[.145,.126],[.18,.115],[.313,.163],[.391,.122]]){
    const base=add(mid(logStart,logMid,along),[0,.181,.263]);
    const crest=add(base,[0,.082,radius*.38]);
    for(let i=0;i<8;i++){
      const angle=-.87+i/8*4.87, next=-.87+(i+1)/8*4.87;
      const edge=a=>add(base,[Math.cos(a)*radius,0,Math.sin(a)*radius*.91+.081]);
      const rim=edge(angle),other=edge(next);
      polygon('fungi',[crest,rim,other]);
      polygon('fungiEdge',[rim,add(rim,[0,-.019,0]),add(other,[0,-.019,0]),other]);
    }
  }

  function fern(x,z,reach,colour,count){
    const start=[x,height(x,z)+.013,z], phase=num()*turn;
    for(let f=0;f<count;f++){
      const phi=phase+turn*f/count+.51*(num()-.5);
      const forward=[Math.cos(phi),0,Math.sin(phi)], across=[-forward[2],0,forward[0]];
      const length=reach*(.67+.41*num());
      const stem=t=>add(add(start,scale(forward,length*t**.68)),[0,length*(Math.sin(t*2.80)*.53+.11*t),0]);
      const n=[0,.97,.18];
      for(let k=1;k<10;k++){
        const t=.07*k+.12, p=stem(t), forwardEdge=stem(t+.055);
        for(const sign of [-1,1]){
          const extension=(.078+.16*Math.sin(3.3*t))*length;
          const outer=add(add(p,scale(across,extension*sign)),scale(forward,length*(.035+t*.11)));
          outer[1]-=length*.026;
          const leafRidge=add(mid(p,outer,.59),[0,length*.034,0]);
          const shoulder=add(leafRidge,scale(forward,-length*(.020+.011*t)));
          polygon(colour,[p,shoulder,outer,forwardEdge],{normal:n});
        }
      }
      polygon(colour,[stem(.75),add(stem(.83),scale(across,length*.048)),stem(1),
        add(stem(.83),scale(across,-length*.040))],{normal:n});
    }
  }
  for(const [x,z,w,d,h,seed] of [[-1.82,3.5,.71,.60,.44,7],[3.1,4.4,.65,.78,.52,2],
    [2.03,-4.18,.75,.65,.55,9],[-3.85,-3.44,1.12,.83,.92,2],
    [4.2,-8.38,.79,.70,.63,5],[-1.76,-4.17,.31,.53,.34,8]])rock(x,z,w,d,h,seed,true);

  for(let i=0;i<78;i++){
    const z=6-i*.442+(num()-.5)*2.5,s=i%2?1:-1;
    const x=trail(z)+s*(1.33+num()*(2.4+Math.max(0,-z)*.21));
    fern(x,z,.31+num()*.73,['fern','fernNew','fernDark'][i%3],i<18?8:5);
    if(i%4===0)rock(x+.48,z+.77,.19+num()*.42,.16+num()*.43,.17+num()*.34,i,true);
  }
  fern(-1.65,4.81,.99,'fernNew',9);
  fern(2.08,4.32,1.13,'fern',11);
  fern(-3.19,5.99,1.19,'fernDark',10);
  for(let i=0;i<280;i++){
    const z=7-num()*21,x=trail(z)+(num()-.5)*6.3;
    if(Math.abs(x-trail(z))<.75&&i%2)continue;
    const y=height(x,z), tip=.026+num()*.085;
    polygon(i%5?'darkLitter':'lichen',[[x-tip,y+.013,z],[x+.04,y+.016,z-tip*.36],
      [x+tip*.57,y+.019,z+.014],[x,y+.014,z+.019+tip*.29]],{normal:[0,1,0]});
  }

  return [...batches.values()].map(({name,caster,positions,normals,indices})=>({
    name,caster,color:shades[name],roughness:name.startsWith('fern')?.68:.90,
    positions:Float32Array.from(positions),normals:Float32Array.from(normals),indices:Uint32Array.from(indices),
  }));
}
