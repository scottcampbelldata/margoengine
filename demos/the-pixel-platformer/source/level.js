import { createTileLayer } from '@margoengine/tilemap';

export const viewWidth=320;
export const viewHeight=180;
export const width=640;
export const height=192;
export const tile=16;
export const spawn=[54,135];
export const checkpoint=[314,135];
export const finish=[555,103];
export const samples=[{x:105,y:126},{x:216,y:106},{x:419,y:109}];
export const shelves=[
  {from:0,to:128,top:144},
  {from:160,to:240,top:128},
  {from:272,to:352,top:144},
  {from:384,to:448,top:128},
  {from:480,to:640,top:112},
];
export const lanterns=[
  {x:19,y:113,color:'#ffc885'},
  {x:186,y:87,color:'#fbb775'},
  {x:290,y:101,color:'#ffa27a'},
  {x:400,y:87,color:'#f9d68c'},
  {x:523,y:70,color:'#fbb586'},
];

const columns=width/tile,rows=height/tile,stone=new Uint32Array(columns*rows);
for(const {from,to,top} of shelves){
  for(let x=from/tile;x<to/tile;x++){
    const first=top/tile;
    for(let y=first;y<rows;y++){
      const boundary=x===from/tile?0:x===to/tile-1?2:1;
      const variation=(x*3+y*7)%4;
      stone[y*columns+x]=y===first?1+boundary+variation*3:13+boundary+variation*3;
    }
  }
}
export const map={
  width:columns,height:rows,tileWidth:tile,tileHeight:tile,
  tilesets:[{name:'basalt',firstGid:1,tileWidth:tile,tileHeight:tile,tileCount:24,columns:12,
    tiles:Array.from({length:24},(_,id)=>({id,properties:{solid:true}}))}],
  layers:[createTileLayer('basalt',columns,rows,stone)],
};

export const blockers=shelves.flatMap(({from,to,top})=>[
  {shape:'segment',from:[from+3,top+1],to:[to-3,top+1]},
  {shape:'segment',from:[from+4,top+2],to:[from+5,top+34]},
  {shape:'segment',from:[to-4,top+2],to:[to-5,top+34]},
]).concat([
  {shape:'polygon',points:[[18,119],[41,119],[45,144],[16,144]]},
  {shape:'box',offset:[144,103],width:7,height:44},
  {shape:'box',offset:[243,109],width:5,height:41},
  {shape:'box',offset:[453,110],width:8,height:40},
]);
