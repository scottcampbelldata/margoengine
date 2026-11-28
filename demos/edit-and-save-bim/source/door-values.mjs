export const propertySet='Pset_DoorCommon';
export const acousticLabel = value => 'Rw '+value+' dB';
export const ratingSteps=[24,26,28,30,32,34,36,38,40,42,44,46,48];

export function extractDoors(data) {
  return [...data.elements.values()].filter(row=>row.type==='IfcDoor').map(row=>{
    const set=row.psets.find(p=>p.name===propertySet);
    const acoustic=set?.properties.AcousticRating;
    const selfClosing=set?.properties.SelfClosing;
    const rating=+(typeof acoustic?.value==='string'&&/^Rw (\d+) dB$/.exec(acoustic.value)?.[1]);
    if(acoustic?.dataType!=='IFCLABEL'||selfClosing?.dataType!=='IFCBOOLEAN'||
      !Number.isFinite(rating)||typeof selfClosing.value!=='boolean'||!row.globalId)
      throw new Error('The pavilion door has incomplete IFC information.');
    return {id:row.id,guid:row.globalId,name:row.name,tag:row.tag,rating,selfClosing:selfClosing.value};
  });
}

export function prepareIFC(api,original,edits,{openIFC,readIFCData,editIFC,saveIFC}){
  const model=openIFC(api,original);
  let bytes,expected;
  try{
    const doors=extractDoors(readIFCData(model));
    const change=new Map(edits.map(item=>[item.guid,item]));
    if(change.size!==edits.length||!edits.length||
      edits.some(item=>!ratingSteps.includes(item.rating)||typeof item.selfClosing!=='boolean'||
        !doors.some(door=>door.guid===item.guid)))throw new Error('The door edits are invalid.');
    const editor=editIFC(model,{
      application:{name:'Margo Web Demos',version:'1.0',identifier:'margo-bim',developer:'Margo Engine'},
      user:{organization:'Tern Garden Pavilion'},
    });
    expected=doors.map(door=>{
      const changeTo=change.get(door.guid);
      if(!changeTo)return door;
      const updates={};
      if(door.rating!==changeTo.rating)updates.AcousticRating={type:'IfcLabel',value:acousticLabel(changeTo.rating)};
      if(door.selfClosing!==changeTo.selfClosing)updates.SelfClosing={type:'IfcBoolean',value:changeTo.selfClosing};
      if(Object.keys(updates).length)editor.setPropertySet(door.id,propertySet,updates);
      return {...door,rating:changeTo.rating,selfClosing:changeTo.selfClosing};
    });
    bytes=saveIFC(model);
  }finally{
    model.close();
  }
  const verify=openIFC(api,bytes);
  let checked;
  try{
    checked=extractDoors(readIFCData(verify));
    if(verify.schema!=='IFC4'||JSON.stringify(checked)!==JSON.stringify(expected))
      throw new Error('The exported IFC did not read back with the requested door data.');
  }finally{
    verify.close();
  }
  return {bytes,checked};
}
