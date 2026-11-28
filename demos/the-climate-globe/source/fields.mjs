export function decodeFields(bytes,frames,cols,rows,scale){
  let cursor=0;
  function read(){
    let result=0;
    for(let shift=0;shift<28;shift+=7){
      if(cursor>=bytes.length)throw new Error('Truncated annual temperature data.');
      const unit=bytes[cursor++];
      result|=(unit&127)<<shift;
      if(unit<128)return result;
    }
    throw new Error('Invalid annual temperature data.');
  }
  const fields=[];
  for(let frame=0;frame<frames;frame++){
    const values=new Float32Array(cols*rows);
    let above=new Int32Array(cols),current=new Int32Array(cols);
    for(let row=0;row<rows;row++){
      let left=0,oldAbove=0;
      for(let col=0;col<cols;col++){
        const top=above[col],word=read()-1;
        const value=word>=0?left+top-oldAbove+((word>>>1)^-(word&1)):0;
        values[row*cols+col]=word>=0?value*scale:NaN;
        current[col]=left=value;
        oldAbove=top;
      }
      [above,current]=[current,above];
    }
    fields.push(values);
  }
  if(cursor!==bytes.length)throw new Error('Annual data have unexpected trailing bytes.');
  return fields;
}
export function indexOfCell(latitude,longitude){
  const row=Math.max(0,Math.min(89,Math.floor((latitude+90)/2)));
  const turn=((longitude+180)%360+360)%360;
  const column=Math.min(179,Math.floor(turn/2));
  return row*180+column;
}
