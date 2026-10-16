import {execFileSync} from 'node:child_process';

// Keep WebGPU contexts and Vite builds sequential so shader reloads cannot affect captures.
for(const script of ['gltf-texture-tests.js','gltf-ktx2-production-tests.js','animation-influences-browser-tests.js','gltf-production-assets-tests.js']){
  execFileSync(process.execPath,['scripts/'+script],{stdio:'inherit'});
}
