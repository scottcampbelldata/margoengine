import { finish,lanterns,samples,shelves,tile,viewHeight,width } from './level.js';

const rgb=value=>typeof value==='string'
  ?[1,3,5].map(i=>parseInt(value.slice(i,i+2),16))
  :value;
const mix=(a,b,t)=>a.map((value,i)=>Math.round(value+(b[i]-value)*t));
const clamp=t=>Math.min(1,Math.max(0,t));
function noise(seed){
  const f=Math.sin(seed*92.149+28.795)*43758.54531;
  return f-Math.floor(f);
}

export class Pixels{
  constructor(width,height){
    this.width=width;
    this.height=height;
    this.data=new Uint8Array(width*height*4);
  }
  dot(x,y,[r,g,b,a=255]){
    if(x<0||y<0||x>=this.width||y>=this.height)return;
    const i=(y*this.width+x)*4;
    this.data[i]=r;this.data[i+1]=g;this.data[i+2]=b;this.data[i+3]=a;
  }
  rect(x,y,w,h,color){
    const fill=rgb(color);
    for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)this.dot(i,j,fill);
  }
  polygon(points,color){
    const fill=rgb(color),rows=points.map(p=>p[1]);
    for(let y=Math.max(0,Math.min(...rows));y<Math.min(this.height,Math.max(...rows));y++){
      const cuts=[];
      for(let i=0;i<points.length;i++){
        const [x1,y1]=points[i],[x2,y2]=points[(i+1)%points.length];
        if((y1>y+.5)!==(y2>y+.5))cuts.push(x1+(x2-x1)*(y+.5-y1)/(y2-y1));
      }
      cuts.sort((a,b)=>a-b);
      for(let i=0;i+1<cuts.length;i+=2)for(let x=Math.ceil(cuts[i]-.5);x<cuts[i+1]-.5;x++)this.dot(x,y,fill);
    }
  }
  disc(x,y,r,color){
    const fill=rgb(color);
    for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++)if(i*i+j*j<=r*r)this.dot(x+i,y+j,fill);
  }
  copy(image,x,y){
    for(let j=0;j<image.height;j++)this.data.set(
      image.data.subarray(j*image.width*4,(j+1)*image.width*4),((y+j)*this.width+x)*4,
    );
  }
}

function horizon(){
  const sky=new Pixels(430,viewHeight);
  const bands=[[0,'#201d47'],[.30,'#39325f'],[.57,'#745381'],[.74,'#af797f'],[1,'#e3a17e']]
    .map(([t,c])=>[t,rgb(c)]);
  const matrix=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  for(let y=0;y<130;y++){
    const t=y/130;
    const i=Math.max(1,bands.findIndex(b=>b[0]>=t));
    const [lo,a]=bands[i-1],[hi,b]=bands[i];
    const ratio=(t-lo)/(hi-lo);
    const c0=mix(a,b,Math.floor(ratio*20)/20),c1=mix(a,b,Math.min(20,Math.ceil(ratio*20))/20);
    for(let x=0;x<sky.width;x++)sky.dot(x,y,matrix[(x&3)+(y&3)*4]/16<(ratio*20)%1?c1:c0);
  }
  for(let i=0;i<78;i++){
    const x=Math.floor(noise(i+9)*sky.width),y=2+Math.floor(noise(i*2.71+52)**1.6*76);
    sky.rect(x,y,1,1,['#837697','#9584a7','#b7a6a9','#c9b6b3'][i%4]);
    if(i%19===0){
      sky.rect(x-1,y,3,1,'#c6abac');
      sky.rect(x,y-1,1,3,'#b7a6ac');
      sky.rect(x,y,1,1,'#e6c6b5');
    }
  }
  sky.disc(77,43,20,'#d5a493');
  sky.disc(77,43,18,'#f1c4a3');
  sky.disc(83,37,15,'#f6d9b0');
  for(const [x,y,w] of [[64,48,26],[68,52,37],[69,54,23],[75,58,15]]){
    sky.rect(x,y,w,1,'#dca999');
  }
  for(let cloud=0;cloud<16;cloud++){
    const x=Math.round(noise(cloud+68)*440)-20;
    const y=25+Math.floor(noise(cloud*5+44)*88);
    const w=24+Math.floor(noise(cloud*13+1)*64);
    const c=y>70?'#ad778c':y>47?'#8a6285':'#675481';
    sky.polygon([[x,y+2],[x+Math.round(w*.35),y+2],[x+Math.round(w*.56),y-1],
      [x+w,y-1],[x+Math.round(w*.88),y+1],[x+Math.round(w*.52),y+4],[x+6,y+4]],c);
    if(y>55)sky.rect(x+Math.round(w*.25),y+4,Math.round(w*.33),1,'#c58794');
  }
  return sky;
}

function ridgeArt(w,index){
  const image=new Pixels(w,viewHeight);
  const tone=index===0?'#64516a':index===1?'#494563':'#3b425e';
  const base=index===0?105:index===1?120:133;
  const outline=[];
  for(let x=0;x<=w;x+=4){
    const swell=Math.sin((x+index*60)*.017)+.78*Math.sin(x*.027+index*3);
    const crag=.28*Math.sin(x*.107+index*20)+noise(x+index*7)*.43;
    const y=base-Math.round(Math.abs(swell+crag)*(index===0?18:13));
    outline.push([x,y]);
  }
  image.polygon([...outline,[w,158],[0,158]],tone);
  const shadow=index===0?'#574961':index===1?'#41405d':'#353e5b';
  for(let i=index+1;i<outline.length;i+=8){
    const [x,y]=outline[i];
    image.polygon([[x,y+1],[x+5,y+5],[x+44,149],[x+18,149],[x+4,y+13]],shadow);
  }
  return image;
}

function surf(){
  const water=new Pixels(506,viewHeight);
  const low=rgb('#26324d'),high=rgb('#715f79'),foam=rgb('#aa8089');
  for(let y=124;y<viewHeight;y++)water.rect(0,y,water.width,1,mix(high,low,(y-124)/56));
  for(let i=0;i<320;i++){
    const y=124+Math.floor(noise(i*14.7+12)**1.26*56),x=Math.floor(noise(i+215)*water.width);
    const l=1+Math.floor(noise(i*9+1)*23*(.2+(y-124)/65));
    water.rect(x,y,l,1,mix(mix(high,low,(y-124)/56),foam,.28+.25*noise(i)));
  }
  for(let x=1;x<water.width;x+=18){
    const y=154+Math.round(Math.sin(x*.13)*6);
    water.rect(x,y,3,1,'#79849b');
    water.rect(x+5,y,8,1,'#6d748e');
    water.rect(x+4,y+1,20,1,'#524e72');
  }
  return water;
}

function basalt(){
  const atlas=new Pixels(tile*12,tile*2);
  const planes=['#46475b','#514754','#45465a','#4f4d62','#584955','#3d4158'].map(rgb);
  for(let cell=0;cell<24;cell++){
    const image=new Pixels(tile,tile);
    const top=cell<12,left=cell%3===0,right=cell%3===2;
    const seed=cell+2,variant=Math.floor(cell%12/3);
    for(let y=0;y<tile;y++)for(let x=0;x<tile;x++){
      let c=planes[(Math.floor((x+y*.44+variant*5)/6)+Math.floor(y/6)*3+variant)%planes.length];
      const edge=x<3&&left||x>=13&&right;
      if(edge)c=mix(c,rgb('#242b44'),x===0||x===15?.58:.24);
      if(y===4+variant||y===12+variant%2)c=mix(c,rgb('#272a43'),.46);
      if(noise(cell*2+x*64+y)>.91)c=mix(c,rgb('#a78583'),.18);
      if(top&&y<3+Math.floor(Math.sin(x*.6+seed)*.8)){
        c=rgb(y===0?'#a8a17a':y===1?'#887d66':'#736658');
      }
      image.dot(x,y,c);
    }
    atlas.copy(image,(cell%12)*tile,Math.floor(cell/12)*tile);
  }
  return atlas;
}

function lanternHouse(objects,x,y){
  objects.polygon([[x-15,y],[x-16,y-18],[x-12,y-28],[x+9,y-28],[x+15,y-19],[x+15,y]],'#60505a');
  objects.rect(x-11,y-23,22,4,'#7c605f');
  objects.rect(x-16,y-21,31,2,'#3f304b');
  objects.rect(x-6,y-18,11,18,'#333448');
  objects.rect(x-7,y-18,2,18,'#8a6564');
  objects.rect(x-2,y-13,4,6,'#c08a6f');
  objects.rect(x+2,y-12,1,5,'#f0ad79');
  objects.rect(x-13,y-4,8,3,'#886e73');
  objects.polygon([[x-22,y-26],[x-10,y-35],[x+7,y-35],[x+19,y-25]],'#302940');
  objects.polygon([[x-20,y-27],[x-10,y-35],[x+6,y-35],[x+16,y-27]],'#605266');
  objects.rect(x-16,y-27,32,2,'#85717b');
}

function coastFixtures(){
  const objects=new Pixels(width,viewHeight);
  lanternHouse(objects,31,144);
  lanternHouse(objects,487,112);
  for(const [x,y] of [[144,81],[243,88],[453,89]]){
    objects.polygon([[x-4,y+6],[x+3,y+4],[x+5,170],[x-5,170]],'#343346');
    objects.rect(x-2,y+10,2,158-y,'#705765');
    objects.rect(x-8,162,16,5,'#48465c');
    objects.rect(x-7,164,9,1,'#837083');
    objects.rect(x-11,168,7,1,'#776b8a');
    objects.rect(x+4,171,9,1,'#776b8a');
    objects.rect(x-8,y-1,16,3,'#987365');
    objects.rect(x-6,y+2,12,3,'#5d4a56');
    for(const sign of [-1,1]){
      objects.rect(x+sign*9-1,y,2,4,'#d29f87');
      objects.rect(x+sign*9,y-2,1,6,'#765a69');
    }
  }
  for(const [first,last,y] of [[104,171,80],[224,277,89],[422,490,91]]){
    for(let x=first;x<=last;x++){
      const s=(x-first)/(last-first);
      const yy=y+Math.round(16*s*(1-s));
      objects.rect(x,yy,1,1,'#534b60');
      if(x%9===0)objects.rect(x,yy+1,1,1,'#a78072');
    }
  }
  for(const {from,to,top} of shelves){
    for(let x=from+11;x<to-10;x+=13){
      const n=Math.round(noise(x)*5);
      objects.rect(x,top-1,4,1,'#a4a182');
      objects.rect(x+1,top-n-1,1,n+1,'#788b7a');
      objects.rect(x-1,top-2,2,1,'#84917c');
      if(x%3===0){
        objects.rect(x+3,top-3,1,2,'#926b64');
        objects.rect(x+3,top-4,1,1,'#d0977c');
      }
    }
  }
  for(const {x,y} of lanterns){
    const stand=shelves.find(shelf=>x>=shelf.from&&x<shelf.to).top;
    objects.rect(x-2,y+6,4,stand-y-6,'#4d4057');
    objects.rect(x-2,y+7,1,stand-y-7,'#9d756f');
    objects.rect(x-3,stand-7,6,2,'#62475c');
    objects.rect(x-5,stand-2,10,2,'#4a3a53');
    objects.rect(x-5,y-1,10,7,'#634754');
    objects.rect(x-3,y,6,5,'#dc966a');
    objects.rect(x-2,y+1,3,3,'#e9b584');
    objects.rect(x-6,y-2,12,2,'#a07376');
  }
  const [x]=finish;
  objects.polygon([[x-17,112],[x-10,46],[x+11,46],[x+18,112]],'#9a7a79');
  objects.polygon([[x+5,48],[x+11,46],[x+18,112],[x+9,112]],'#6f6678');
  for(let i=0;i<8;i++){
    const y=51+i*8,left=Math.round(-10-(y-50)*.113);
    objects.rect(x+left,y,Math.round(20+(y-50)*.20),1,'#715665');
    objects.rect(x+left+2,y+1,5,1,'#bc9386');
  }
  objects.rect(x-7,94,13,18,'#40374c');
  objects.rect(x-2,97,4,15,'#cd9473');
  objects.rect(x-3,79,6,10,'#61465e');
  objects.rect(x-2,80,4,6,'#d6a88a');
  objects.rect(x-14,43,29,5,'#55445b');
  objects.rect(x-11,27,22,16,'#65495b');
  objects.rect(x-8,29,16,11,'#ae876e');
  for(const offset of [-9,-3,4,10])objects.rect(x+offset,29,1,11,'#e0a287');
  objects.polygon([[x-15,28],[x-8,22],[x,18],[x+9,22],[x+15,28]],'#463c58');
  objects.polygon([[x-13,26],[x-7,22],[x,19],[x+6,22],[x+11,26]],'#9a716b');
  objects.rect(x,13,1,5,'#b99088');
  objects.rect(x-19,112,39,2,'#392e46');
  objects.rect(314,112,1,32,'#c19d94');
  objects.rect(312,112,5,2,'#dbc2b0');
  objects.polygon([[315,114],[329,115],[324,122],[315,121]],'#bd7979');
  objects.rect(316,116,9,1,'#e1a39a');
  for(const {x,y} of samples){
    const stand=shelves.find(shelf=>x>=shelf.from&&x<shelf.to).top;
    objects.rect(x-3,y+9,7,stand-y-9,'#484359');
    objects.rect(x-1,y+11,2,stand-y-11,'#726477');
    objects.rect(x-6,stand-3,12,3,'#686079');
    objects.rect(x-8,y+9,16,3,'#352d48');
    objects.rect(x-6,y+7,12,2,'#827778');
  }
  return objects;
}

const custodianColors={
  I:'#27263d',H:'#ecdfc9',G:'#bcbfb8',B:'#66999d',D:'#4c687c',
  C:'#3b526c',K:'#305164',L:'#ffd194',T:'#b6806e',S:'#776675',E:'#ffebbc',
};
function keeper(pose){
  const image=new Pixels(24,27);
  const lines=[
    '       IIIIII           ',
    '      IHHHHHGI          ',
    '     IHHHGGGGGI         ',
    '     IHHGICCCGI         ',
    '    IHHGICCCDCGI        ',
    '    IHHGICCBCBGI        ',
    '    IHHGICCBECGI        ',
    '    IHHGICCBCBGI        ',
    '     IHGGICCCGI         ',
    '      IHGHHHGI          ',
    '      IIIGGGI           ',
    '     IDDBBDDI           ',
    '    IBDDBBBDDI          ',
    '    IDDDBDBSDII         ',
    '    IDDDDBDTIIIII       ',
    '    IDDDBBDTSIILI       ',
    '    IDDDDBDSIILEI       ',
    '     IBDDDDSIILTI       ',
    '     IBDDDDSIII         ',
    '     IDDDDDSI           ',
    '     IIIIIIII           ',
  ];
  for(const [y,row] of lines.entries())for(const [x,key] of [...row].entries()){
    if(custodianColors[key])image.rect(x+1,y+1,1,1,custodianColors[key]);
  }
  const legs=pose===3?[[6,22,4,3],[12,22,4,3]]:pose===1?[[5,22,4,3],[13,21,4,4]]:pose===2?[[8,21,4,4],[12,22,4,2]]:[[7,22,4,3],[12,22,4,3]];
  for(const [x,y,w,h] of legs){
    image.rect(x,y,w,h,'#31455b');
    image.rect(x,y+h-1,w+1,1,'#24293d');
    image.rect(x,y,1,h,'#5a7a82');
  }
  return image;
}

function crystal(){
  const p=new Pixels(14,20);
  p.polygon([[7,0],[12,6],[12,12],[7,17],[2,12],[2,6]],'#546170');
  p.polygon([[7,1],[11,7],[11,11],[7,16],[3,11],[3,7]],'#78c0a6');
  p.polygon([[7,1],[6,7],[7,15],[3,11],[3,7]],'#c4eacc');
  p.polygon([[7,1],[11,7],[11,10],[8,9]],'#cee7be');
  p.rect(6,6,2,5,'#e5f3d2');
  p.rect(8,4,1,1,'#f2e7b9');
  return p;
}

function relief(source,x1,y1,w,h,atlas,kind){
  const heights=new Float32Array(w*h),alpha=new Uint8Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=((y+y1)*source.width+x+x1)*4;
    const hIndex=y*w+x;
    alpha[hIndex]=source.data[i+3];
    const l=(source.data[i]+source.data[i+1]+source.data[i+2])/765;
    if(alpha[hIndex]){
      const dome=kind==='keeper'?Math.max(0,1-Math.hypot((x-11)/11,(y-10)/15)):0;
      const timber=kind==='fixtures'?.38*Math.sin(x*.55)*Math.sin(y*.62):0;
      heights[hIndex]=.9+l*.78+dome*2.1+timber;
    }
  }
  const read=(x,y)=>heights[Math.max(0,Math.min(h-1,y))*w+Math.max(0,Math.min(w-1,x))];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(!alpha[y*w+x])continue;
    const dx=read(x-1,y)-read(x+1,y),dy=read(x,y-1)-read(x,y+1),n=Math.hypot(dx,dy,2.3);
    atlas.dot(x+x1,y+y1,[Math.round(127.5*(dx/n+1)),Math.round(127.5*(dy/n+1)),Math.round(127.5*(2.3/n+1)),255]);
  }
}

export function makeArt(){
  const atlas=new Pixels(640,216),normals=new Pixels(640,216);
  atlas.copy(coastFixtures(),0,0);
  relief(atlas,0,0,640,180,normals,'fixtures');
  for(let i=0;i<4;i++){
    atlas.copy(keeper(i),i*24,180);
    relief(atlas,i*24,180,24,27,normals,'keeper');
  }
  atlas.copy(crystal(),100,182);
  relief(atlas,100,182,14,20,normals,'crystal');
  const windows=new Pixels(39,21);
  windows.polygon([[0,8],[20,0],[38,6],[36,14],[18,18],[0,13]],[249,190,113,21]);
  windows.rect(13,5,12,9,'#d59d6a');
  windows.rect(15,6,8,7,'#ffe3a6');
  windows.rect(17,6,1,7,'#fff3bf');
  windows.rect(22,6,1,7,'#fff3bf');
  windows.rect(13,8,12,1,'#9d6a62');
  return {sky:horizon(),ridges:[ridgeArt(470,0),ridgeArt(506,1),ridgeArt(530,2)],
    surf:surf(),tiles:basalt(),atlas,normals,windows};
}
