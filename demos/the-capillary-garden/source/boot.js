const request=new URLSearchParams(location.search);
const useCompatibility=request.get('backend')==='webgl2'||!navigator.gpu;

try{
  const [stage,compatibility]=await Promise.all([
    import('./scene.js'),
    useCompatibility?import('@margoengine/webgl2-compat'):null,
  ]);
  await stage.start(compatibility?.install);
}catch(error){
  document.body.dataset.state='error';
  document.getElementById('loading').textContent='The glasshouse could not open. '+(error?.message??error);
  console.error(error);
}
