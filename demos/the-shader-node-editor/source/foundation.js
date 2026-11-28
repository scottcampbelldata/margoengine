const node=(id,op,inputs=[],value)=>({id,op,inputs,...(value===undefined?{}:{value})});

export function initialGraph(){
  return {version:1,nodes:[
    node('coordinates','position'),
    node('veins','vec3',[],[5.0,19.7,-7.6]),
    node('axis','dot',['coordinates','veins']),
    node('wave','sin',['axis']),
    node('crest','abs',['wave']),
    node('ink','vec3',[],[.019,.054,.059]),
    node('celadon','vec3',[],[.076,.425,.329]),
    node('glaze','mix',['ink','celadon','crest']),
    node('finish','float',[],.16),
  ],outputs:{color:'glaze',roughness:'finish'},
  fallback:{color:[.084,.268,.228],roughness:.37,metalness:0,emissive:[0,0,0],opacity:1}};
}

export function initialLayout(phone){
  if(phone)return {coordinates:[0,0],veins:[0,80],axis:[0,207],wave:[0,301],crest:[0,384],
    ink:[212,0],celadon:[212,125],glaze:[212,245],finish:[212,355],output:[212,444]};
  return {coordinates:[0,0],veins:[0,112],axis:[216,13],wave:[216,117],crest:[216,209],
    ink:[0,259],celadon:[0,389],glaze:[432,34],finish:[216,407],output:[432,225]};
}
