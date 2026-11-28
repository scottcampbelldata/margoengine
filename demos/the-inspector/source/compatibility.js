export async function enableCompatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true});
}
