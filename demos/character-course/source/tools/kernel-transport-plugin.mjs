import {resolve} from 'node:path';

const simdProbe=[0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11];
const directVariant=/let [$\w]+ = await \(([$\w]+) === "simd" \? import\("\.\/wasm-/;
const packagedCompile=/let [$\w]+ = Uint8Array\.from\(atob\([$\w]+\.wasmBase64\), \(([$\w]+)\) => \1\.charCodeAt\(0\)\);\s*return WebAssembly\.compile\(await new Response\(new Blob\(\[[$\w]+\]\)\.stream\(\)\.pipeThrough\(new DecompressionStream\("deflate-raw"\)\)\)\.arrayBuffer\(\)\);/;
const payload=/["'][A-Za-z0-9+/]{10000,}={0,2}["']/g;

/** Changes the consuming bundle’s binary transport. The pinned facade and decoded physics module retain their APIs and state. */
export function courseKernelTransport(source,checkout){
  const normalize=path=>path.replaceAll('\\','/');
  const physics=normalize(resolve(checkout,'packages/physics/dist'));
  const delivery=normalize(resolve(source,'kernel-transport.js'));
  return {
    name:'character-course-kernel-transport',
    enforce:'pre',
    config(){return {define:{__COURSE_KERNEL_TRANSPORT__:'true'}};},
    transform(code,id){
      const path=normalize(id);
      if(path===physics+'/index.js'){
        const variant=code.match(directVariant)?.[1];
        if(!variant||!packagedCompile.test(code))throw new Error('Character Course did not find the pinned kernel loader.');
        const importLine='import {compileCourseKernel as compileTransportedCourseKernel} from '+JSON.stringify(delivery)+';\n';
        return {code:importLine+code.replace(packagedCompile,original=>
          'if ('+variant+' !== "threads") return compileTransportedCourseKernel('+variant+');\n\t'+original),map:null};
      }
      if(path.startsWith(physics+'/')&&/\/wasm-(?!threads)[^/]+\.js$/.test(path)){
        const hits=[...code.matchAll(payload)];
        if(hits.length!==1)throw new Error('Character Course did not find the pinned binary descriptor.');
        return {code:code.replace(payload,'""'),map:null};
      }
    },
    transformIndexHtml:{
      order:'post',
      handler(html,{bundle}){
        const assets=Object.keys(bundle);
        const paths=['simd','scalar'].map(variant=>{
          const file=assets.find(name=>name.includes('course-'+variant+'-')&&name.endsWith('.packed'));
          if(!file)throw new Error('Character Course is missing its '+variant+' binary.');
          return './'+file;
        });
        const modules=Object.values(bundle).filter(file=>file.type==='chunk'&&file.facadeModuleId);
        const facade=modules.find(file=>normalize(file.facadeModuleId)===normalize(resolve(source,'physics.js')));
        if(!facade)throw new Error('Character Course is missing its physics entry.');
        const hashes=['simd','scalar'].map(variant=>{
          const name=variant==='simd'?/\/wasm-(?!scalar|threads)[^/]+\.js$/:/\/wasm-scalar-[^/]+\.js$/;
          const file=modules.find(chunk=>name.test(normalize(chunk.facadeModuleId)));
          if(!file)throw new Error('Character Course is missing its '+variant+' descriptor.');
          return './'+file.fileName;
        });
        const preload='<script>{const simd=WebAssembly.validate(new Uint8Array('+JSON.stringify(simdProbe)+
          '));let link=document.createElement("link");link.rel="preload";link.as="fetch";link.crossOrigin="anonymous";'+
          'link.href='+JSON.stringify(paths)+'[simd?0:1];document.head.append(link);'+
          'link=document.createElement("link");link.rel="modulepreload";link.crossOrigin="anonymous";'+
          'link.href='+JSON.stringify(hashes)+'[simd?0:1];document.head.append(link);}</script>';
        const ready='<link rel="modulepreload" crossorigin href="./'+facade.fileName+'">';
        return html.replace('<head>','<head>'+preload+ready);
      },
    },
  };
}
