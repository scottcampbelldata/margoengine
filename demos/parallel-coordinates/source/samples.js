import url from './assets/vinho-verde.deflate?url';

export const axes=[
  {column:'sugar',label:'Residual sugar',short:'Sugar',unit:'g/L',domain:[.5,70],scale:'log',digits:1},
  {column:'density',label:'Density',short:'Density',unit:'g/cm³',domain:[.98,1.04],digits:3},
  {column:'alcohol',label:'Alcohol',short:'Alcohol',unit:'%',domain:[8,15],digits:1},
  {column:'ph',label:'pH',short:'pH',unit:'',domain:[2.7,4.1],digits:1},
  {column:'fixed',label:'Fixed acidity',short:'Fixed acid',unit:'g/L',domain:[3.5,16],digits:1},
  {column:'volatile',label:'Volatile acidity',short:'Vol. acid',unit:'g/L',domain:[.07,1.6],scale:'log',digits:2},
  {column:'sulphates',label:'Sulphates',short:'Sulph.',unit:'g/L',domain:[.2,2],scale:'log',digits:2},
  {column:'quality',label:'Tasting score',short:'Score',unit:'/ 10',domain:[3,9],digits:0},
];

export async function loadSamples(signal) {
  const response=await fetch(url,{signal});
  if(!response.ok||!response.body)throw new Error('The wine samples could not be loaded.');
  const buffer=await new Response(response.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
  signal.throwIfAborted();
  const data=new DataView(buffer);
  if(data.getUint32(0,false)!==0x56563031)throw new Error('The wine sample archive version is invalid.');
  const red=data.getUint16(4,true), white=data.getUint16(6,true), count=red+white;
  const columns={};
  let offset=8;
  for(const {column} of axes){
    const origin=data.getInt32(offset,true), unit=data.getUint32(offset+4,true), repairs=data.getUint16(offset+8,true);
    offset+=10;
    const reading=Float64Array.from({length:count},(_,i)=>
      (origin+data.getUint8(offset+i)+(data.getUint8(offset+count+i)<<8))/unit);
    offset+=count*2;
    for(let correction=0;correction<repairs;correction++){
      reading[data.getUint16(offset,true)]=data.getFloat64(offset+2,true);
      offset+=10;
    }
    columns[column]=reading;
  }
  if(offset!==buffer.byteLength||count!==6497)throw new Error('The wine sample archive is incomplete.');
  columns.color={values:Uint32Array.from({length:count},(_,i)=>Number(i>=red)),categories:['Red','White']};
  return {columns,count,red,white};
}
