import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {openBrowser} from './browser.js';
import {materialQuad} from '../tests/support/materials-fixture.js';
import {textureQuad,texturePixels,basisTextureQuad} from '../tests/support/texture-fixture.js';
import {iridescenceCases,iridescenceReference} from '../packages/materials/tests/support/iridescence-reference.js';

export async function lobeBrowserChecks(page){
  const fixture=materialQuad();
  const transform={offset:[0.61,0.17],rotation:0.37,scale:[0.59,0.73],texCoord:1},actual=textureQuad('base',transform),reference=textureQuad('base',transform,{bake:true});
  for(const value of [actual,reference])delete value.doc.materials[0].pbrMetallicRoughness.baseColorTexture;
  const serialize=value=>({doc:value.doc,buffers:value.buffers.map(buffer=>[...new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength)])});
  const filmSource=await readFile(new URL('../packages/materials/src/iridescence.ts',import.meta.url),'utf8');
  const filmWGSL=/export const iridescenceWGSL=\/\* wgsl \*\/`([\s\S]*?)`;/.exec(filmSource)?.[1];assert.ok(filmWGSL,'Missing tested thin-film WGSL');
  const float=value=>{const text=String(Math.fround(value));return /[.eE]/.test(text)?text:text+'.0';};
  const filmProgram=iridescenceCases.map((value,index)=>`case ${index}u:{results[${index}]=vec4f(materialIridescenceFresnel(${float(value.cosTheta)},${float(value.outsideIor??1)},${float(value.filmIor)},${float(value.thicknessNm)},vec3f(${value.baseF0.map(float).join(',')})),1.0);}`).join('\n');
  const ktx=basisTextureQuad({colorURI:'/packages/decoders/tests/fixtures/Dot_C.ktx2'});delete ktx.doc.materials[0].pbrMetallicRoughness.baseColorTexture;
  ktx.doc.materials[0].extensions={KHR_materials_sheen:{sheenColorFactor:[0.4,0.2,0.1],sheenColorTexture:{index:0},sheenRoughnessFactor:0.4},
    KHR_materials_specular:{specularFactor:0.7,specularColorTexture:{index:0},specularTexture:{index:0}},KHR_materials_anisotropy:{anisotropyStrength:0.4,anisotropyTexture:{index:0}},
    KHR_materials_iridescence:{iridescenceFactor:0.4,iridescenceTexture:{index:0},iridescenceThicknessTexture:{index:0}}};
  ktx.doc.extensionsUsed.push(...Object.keys(ktx.doc.materials[0].extensions));
  await writeFile('test-results/materials-lobes-ktx.gltf',JSON.stringify(ktx.doc));
  return page.evaluate(async({doc,buffers,...payload})=>{
    const {Engine}=await import('/packages/core/dist/index.js'),{parseGLTF,loadGLTF}=await import('/packages/gltf-pro/dist/index.js');
    const materials=await import('/packages/materials/dist/index.js'),assert=(value,message)=>{if(!value)throw new Error(message);};
    const width=128,height=128,canvas=document.createElement('canvas');canvas.style.cssText=`width:${width}px;height:${height}px`;document.body.append(canvas);
    const engine=await Engine.create(canvas,{backend:'webgpu',capacity:32,camera:{position:[0,0,3],target:[0,0,0]}});
    const device=engine.gpu,owned=[],modules=[],createModule=device.createShaderModule.bind(device);
    device.createShaderModule=descriptor=>{const value=createModule(descriptor);modules.push(value);return value;};
    const model=parseGLTF(engine,doc,buffers.map(value=>new Uint8Array(value)));engine.camera.update(1,true);engine.store.tick(false);
    const texture=(bytes,size=[1,1],srgb=false)=>{
      const value=device.createTexture({size,format:srgb?'rgba8unorm-srgb':'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(value);
      device.queue.writeTexture({texture:value},new Uint8Array(bytes),{bytesPerRow:size[0]*4},size);
      return {view:value.createView(),sampler:device.createSampler({minFilter:'nearest',magFilter:'nearest',addressModeU:'repeat',addressModeV:'repeat'})};
    };
    const allocate=(format,depth=false)=>{const value=device.createTexture({size:[width,height],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|(depth?0:GPUTextureUsage.COPY_SRC)});owned.push(value);return value;};
    const beauty=allocate('rgba8unorm'),linear=allocate('rgba16float'),normal=allocate('rgba16float'),ambient=allocate('rgba16float'),depth=allocate('depth32float',true);
    const beautyView=beauty.createView(),linearView=linear.createView(),normalView=normal.createView(),ambientView=ambient.createView(),depthView=depth.createView();
    const read=async source=>{const row=width*(source===beauty?4:8),buffer=device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:source},{buffer,bytesPerRow:row},[width,height]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        const bytes=new Uint8Array(buffer.getMappedRange()).slice();buffer.unmap();return bytes;}finally{buffer.destroy();}
    };
    let captures=0;
    const render=async(extension,options={},target=model)=>{
      captures++;engine.store.tick(false);const material=target.primitives[0].material;
      material.base=options.base??[0.08,0.08,0.08,1];material.factors[0]=options.roughness??0.6;material.factors[1]=options.metal??0;material.factors[2]=options.normalScale??1;
      material.settings[0]=options.blend?2:0;material.emission=[0,0,0];
      engine.lighting.direction.set(options.direction??[0,0,1,1]);engine.lighting.radiance.set([1,1,1,options.ambient??0.03]);
      if(extension===undefined)delete target.primitives[0].extension;else target.primitives[0].extension=extension;
      const encoder=device.createCommandEncoder(),context={backend:'webgpu',device,encoder,color:beautyView,depth:depthView,format:'rgba8unorm',width,height,camera:engine.camera,
        descriptor:{multisample:{count:1},depthStencil:{format:'depth32float'}}};
      encoder.beginRenderPass({colorAttachments:[{view:beautyView,clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depthView,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}}).end();
      target.draw(context,'beauty',beautyView,depthView);
      for(const [mode,view] of [['gbuffer',normalView],['ambient',ambientView]]){encoder.beginRenderPass({colorAttachments:[{view,clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]}).end();target.draw(context,mode,view,depthView);}
      device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();const result={beauty:await read(beauty),normal:await read(normal),ambient:await read(ambient)};
      const hdr=device.createCommandEncoder();hdr.beginRenderPass({colorAttachments:[{view:linearView,clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]}).end();
      target.draw({...context,encoder:hdr,format:'rgba16float'},'beauty',linearView,depthView);device.queue.submit([hdr.finish()]);await device.queue.onSubmittedWorkDone();return {...result,linear:await read(linear)};
    };
    const difference=(a,b)=>{let max=0,changed=0;for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);max=Math.max(max,delta);changed+=+(delta>0);}return {max,changed};};
    const exact=(a,b,message)=>{assert(a.length===b.length&&a.every((value,index)=>value===b[index]),message);};
    const half=value=>{const sign=value&0x8000?-1:1,exponent=value>>10&31,mantissa=value&1023;return sign*(exponent===0?mantissa*2**-24:exponent===31?Infinity:(1+mantissa/1024)*2**(exponent-15));};
    const rgb=image=>{const words=new Uint16Array(image.buffer,image.byteOffset,image.byteLength/2);return Array.from({length:width*height},(_,i)=>[half(words[i*4]),half(words[i*4+1]),half(words[i*4+2])]);};
    const sum=image=>rgb(image).reduce((total,pixel)=>total.map((value,index)=>value+pixel[index]),[0,0,0]);
    const linearize=byte=>{const value=byte/255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;};
    device.pushErrorScope('validation');
    try{
      const baseline=await render(),parity={};
      for(const [name,extension] of [['sheen',materials.sheen({colorFactor:[0,0,0],roughnessFactor:0.4})],['anisotropy',materials.anisotropy({strength:0,rotation:0.37})],
        ['iridescence',materials.iridescence({factor:0})],['specularNeutral',materials.specular({factor:1,colorFactor:[1,1,1]})],
        ['combinedNeutral',materials.materialLobes({sheen:{colorFactor:[0,0,0]},anisotropy:{strength:0},iridescence:{factor:0},specular:{factor:1,colorFactor:[1,1,1]}})]]){
        const actual=await render(extension);for(const mode of ['beauty','normal','ambient','linear'])exact(actual[mode],baseline[mode],`${name} changed the baseline ${mode}`);parity[name]=difference(actual.beauty,baseline.beauty);
      }
      const black={base:[0,0,0,1],roughness:0.4,metal:0,ambient:0,normalScale:0},blackBaseline=await render(undefined,black),noSpecular=await render(materials.specular({factor:0}),black);
      assert(sum(blackBaseline.linear).every(value=>value>0),'The black dielectric baseline has no specular highlight');
      assert(sum(noSpecular.linear).every(value=>value===0),'Specular factor zero did not remove the dielectric specular lobe');
      const noSpecularColor=await render(materials.specular({colorFactor:[0,0,0]}),black);assert(sum(noSpecularColor.linear).every((value,index)=>value<sum(blackBaseline.linear)[index]),'Black specular color did not reduce normal-incidence reflectance');
      const iorTwo=await render(materials.materialLobes({ior:2,specular:{factor:1,colorFactor:[1,1,1]}}),black),iorOne=await render(materials.materialLobes({ior:1,specular:{factor:1,colorFactor:[1,1,1]}}),black);
      const centerIndex=height/2*width+width/2,iorRatio=rgb(iorTwo.linear)[centerIndex][0]/rgb(blackBaseline.linear)[centerIndex][0];
      assert(Math.abs(iorRatio-25/9)<0.01,`IOR 2 normal-incidence F0 ratio differs from (1/9)/0.04: ${iorRatio}`);
      assert(rgb(iorOne.linear)[centerIndex].every(value=>value===0),'IOR 1 did not remove normal-incidence dielectric F0');
      const metalOptions={base:[0.6,0.6,0.6,1],roughness:0.4,metal:1,ambient:0,normalScale:0};
      const bareMetal=await render(undefined,metalOptions),specularMetal=await render(materials.materialLobes({ior:2,specular:{factor:0,colorFactor:[0.1,0.2,0.3]}}),metalOptions);
      for(const mode of ['beauty','normal','ambient','linear'])exact(bareMetal[mode],specularMetal[mode],'Dielectric specular options changed a fully metallic surface');
      const sheen=await render(materials.sheen({colorFactor:[1,0.2,0.1],roughnessFactor:0.4}),{...black,direction:[0.8,0.3,0.6,1]});
      const noSheen=await render(undefined,{...black,direction:[0.8,0.3,0.6,1]}),sheenDelta=sum(sheen.linear).map((value,index)=>value-sum(noSheen.linear)[index]);
      assert(sheenDelta[0]>0&&sheenDelta[0]>sheenDelta[1]&&sheenDelta[1]>sheenDelta[2],'Sheen did not contribute its colored directional lobe');
      exact(sheen.normal,noSheen.normal,'Sheen changed the base g-buffer normal');

      const metallic={base:[0.6,0.6,0.6,1],roughness:0.4,metal:1,ambient:0,normalScale:0};
      const anisotropic=await render(materials.anisotropy({strength:0.8,rotation:0}),metallic),rotated=await render(materials.anisotropy({strength:0.8,rotation:Math.PI/2}),metallic);
      const moments=image=>{let weight=0,x=0,y=0;for(const [i,pixel] of rgb(image).entries()){const w=pixel[0],dx=i%width-(width-1)/2,dy=Math.floor(i/width)-(height-1)/2;weight+=w;x+=w*dx*dx;y+=w*dy*dy;}return {x:x/weight,y:y/weight,ratio:x/y};};
      const moment0=moments(anisotropic.linear),moment90=moments(rotated.linear);
      assert((moment0.ratio>1.2&&moment90.ratio<1/1.2)||(moment0.ratio<1/1.2&&moment90.ratio>1.2),'Anisotropic rotation did not rotate the highlight axes');
      let tinyAnisotropy;
      const originalEye=[...engine.camera.position];engine.camera.position=[3,0,0.3];engine.camera.update(1,true);
      try{
        // Oblique view and light make a mismatch between correlated and uncorrelated Smith visibility measurable.
        const grazing={...metallic,roughness:0.3,direction:[1,0.1,0.2,1]},isotropic=await render(undefined,grazing),tiny=await render(materials.anisotropy({strength:1e-8}),grazing);
        const beauty=difference(isotropic.beauty,tiny.beauty),left=rgb(isotropic.linear),right=rgb(tiny.linear);let hdrMax=0,peak=0;
        for(let i=0;i<left.length;i++)for(let c=0;c<3;c++){hdrMax=Math.max(hdrMax,Math.abs(left[i][c]-right[i][c]));peak=Math.max(peak,left[i][c]);}
        assert(peak>0,'The grazing anisotropy continuity reference rendered no light');assert(beauty.max<=1,'Infinitesimal anisotropy changed the isotropic LDR limit');
        assert(hdrMax<=peak*0.002+0.00000012,`Infinitesimal anisotropy changed Smith visibility: HDR delta ${hdrMax}, peak ${peak}`);tinyAnisotropy={strength:1e-8,beauty,hdrMax,peak};
      }finally{engine.camera.position=originalEye;engine.camera.update(1,true);}
      const film100=await render(materials.iridescence({factor:1,ior:1.3,thicknessMinimum:100,thicknessMaximum:100}),black);
      const film400=await render(materials.iridescence({factor:1,ior:1.3,thicknessMinimum:400,thicknessMaximum:400}),black);
      assert(difference(film100.beauty,film400.beauty).changed>0,'Thin-film thickness did not change interference color');
      const filmRgb=sum(film400.linear);assert(Math.max(...filmRgb)-Math.min(...filmRgb)>0.01,'Iridescence produced no spectral color');
      const noFilm=await render(materials.iridescence({factor:1,thicknessMinimum:0,thicknessMaximum:0}),black);exact(noFilm.linear,blackBaseline.linear,'Zero thickness did not recover baseline dielectric Fresnel');

      const alphaZero=texture([255,255,255,0]),alphaOne=texture([0,0,0,255]);
      const textureNoSpec=await render(materials.specular({specularTexture:alphaZero}),black);exact(textureNoSpec.linear,noSpecular.linear,'Specular strength must use texture alpha');
      const textureNeutralSpec=await render(materials.specular({specularTexture:alphaOne}));exact(textureNeutralSpec.beauty,baseline.beauty,'Specular alpha one did not retain neutral strength');
      const roughMap=texture([255,255,0,64]),sheenRough=await render(materials.sheen({colorFactor:[0.4,0.2,0.1],roughnessFactor:1,sheenRoughnessTexture:roughMap}));
      const sheenRoughScalar=await render(materials.sheen({colorFactor:[0.4,0.2,0.1],roughnessFactor:64/255}));assert(difference(sheenRough.beauty,sheenRoughScalar.beauty).max<=1,'Sheen roughness must use texture alpha');
      const colorMap=texture([128,64,192,255],[1,1],true),colorFactor=[128,64,192].map(linearize);
      const sheenColor=await render(materials.sheen({colorFactor:[1,1,1],roughnessFactor:0.4,sheenColorTexture:colorMap}));
      const sheenColorScalar=await render(materials.sheen({colorFactor,roughnessFactor:0.4}));assert(difference(sheenColor.beauty,sheenColorScalar.beauty).max<=1,'Sheen color texture was not sampled in linear light');
      const specColor=await render(materials.specular({specularColorTexture:colorMap})),specColorScalar=await render(materials.specular({colorFactor}));assert(difference(specColor.beauty,specColorScalar.beauty).max<=1,'Specular color texture was not sampled in linear light');
      const directionMap=texture([255,128,128,255]),angle=Math.atan2(2*128/255-1,1);
      const mapAnisotropy=await render(materials.anisotropy({strength:1,anisotropyTexture:directionMap}),metallic);
      const scalarAnisotropy=await render(materials.anisotropy({strength:128/255,rotation:angle}),metallic);assert(difference(mapAnisotropy.beauty,scalarAnisotropy.beauty).max<=1,'Anisotropy must decode RG direction and B strength');
      const redZero=texture([0,255,255,255]),greenZero=texture([255,0,255,255]),greenOne=texture([0,255,0,255]);
      const noFilmMap=await render(materials.iridescence({factor:1,iridescenceTexture:redZero}),black);exact(noFilmMap.linear,blackBaseline.linear,'Iridescence factor must use texture red');
      const minimumFilm=await render(materials.iridescence({factor:1,thicknessMinimum:100,thicknessMaximum:400,iridescenceThicknessTexture:greenZero}),black);
      const maximumFilm=await render(materials.iridescence({factor:1,thicknessMinimum:100,thicknessMaximum:400,iridescenceThicknessTexture:greenOne}),black);
      assert(difference(minimumFilm.beauty,film100.beauty).max<=1&&difference(maximumFilm.beauty,film400.beauty).max<=1,'Iridescence thickness must interpolate min/max with texture green');
      const reverseMinimum=await render(materials.iridescence({factor:1,thicknessMinimum:400,thicknessMaximum:100,iridescenceThicknessTexture:greenZero}),black);
      const reverseMaximum=await render(materials.iridescence({factor:1,thicknessMinimum:400,thicknessMaximum:100,iridescenceThicknessTexture:greenOne}),black);
      assert(difference(reverseMinimum.beauty,film400.beauty).max<=1&&difference(reverseMaximum.beauty,film100.beauty).max<=1,'Reversed nonnegative thickness endpoints were not interpolated');
      const samplerFreeSpec=await render(materials.specular({specularTexture:{view:alphaZero.view}}),black);exact(samplerFreeSpec.linear,noSpecular.linear,'Sampler-free specular alpha texture differs from its sampled value');

      const markerBytes=[...payload.pixels];for(let i=0;i<16;i++)markerBytes[i*4+3]=32+64*(i%4);
      const marker=texture(markerBytes,[4,4]),markerSRGB=texture(markerBytes,[4,4],true),uvResults=[];
      const actualModel=parseGLTF(engine,payload.actual.doc,payload.actual.buffers.map(value=>new Uint8Array(value))),referenceModel=parseGLTF(engine,payload.reference.doc,payload.reference.buffers.map(value=>new Uint8Array(value)));
      try{
        for(const name of ['sheenColor','sheenRoughness','specularFactor','specularColor','anisotropy','iridescenceFactor','iridescenceThickness']){
          const make=transformed=>{
            const map={...(name==='sheenColor'||name==='specularColor'?markerSRGB:marker),texCoord:transformed?0:1,...(transformed?{transform:payload.transform}:{})};
            if(name==='sheenColor')return materials.sheen({colorFactor:[1,1,1],roughnessFactor:0.4,sheenColorTexture:map});
            if(name==='sheenRoughness')return materials.sheen({colorFactor:[0.3,0.2,0.1],roughnessFactor:1,sheenRoughnessTexture:map});
            if(name==='specularFactor')return materials.specular({specularTexture:map});
            if(name==='specularColor')return materials.specular({specularColorTexture:map});
            if(name==='anisotropy')return materials.anisotropy({strength:0.8,anisotropyTexture:map});
            if(name==='iridescenceFactor')return materials.iridescence({factor:1,thicknessMinimum:250,thicknessMaximum:250,iridescenceTexture:map});
            return materials.iridescence({factor:1,thicknessMinimum:100,thicknessMaximum:400,iridescenceThicknessTexture:map});
          };
          const options=name==='anisotropy'?metallic:{},actual=await render(make(true),options,actualModel),reference=await render(make(false),options,referenceModel),delta=difference(actual.beauty,reference.beauty);
          assert(delta.max<=1,`${name} UV1/affine texture differs from independently baked coordinates: ${JSON.stringify(delta)}`);uvResults.push({name,difference:delta});
        }
      }finally{actualModel.destroy();referenceModel.destroy();}

      const filmModule=device.createShaderModule({code:payload.filmWGSL+'\n@group(0) @binding(0) var<storage,read_write> results:array<vec4f>;\n@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){switch id.x{'+payload.filmProgram+'default:{}}}'});
      assert(materials.iridescence({factor:1}).declarations.includes(payload.filmWGSL),'The built material did not use the quantitatively tested thin-film helper');
      const filmPipeline=device.createComputePipeline({layout:'auto',compute:{module:filmModule,entryPoint:'main'}}),filmBytes=payload.filmExpected.length*16;
      const output=device.createBuffer({size:filmBytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),readback=device.createBuffer({size:filmBytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      let filmMaxError=0;
      try{
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(filmPipeline);pass.setBindGroup(0,device.createBindGroup({layout:filmPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}}]}));pass.dispatchWorkgroups(payload.filmExpected.length);pass.end();
        encoder.copyBufferToBuffer(output,0,readback,0,filmBytes);device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);const values=new Float32Array(readback.getMappedRange());
        for(let i=0;i<payload.filmExpected.length;i++)for(let c=0;c<3;c++)filmMaxError=Math.max(filmMaxError,Math.abs(values[i*4+c]-payload.filmExpected[i][c]));readback.unmap();
        assert(filmMaxError<=0.00002,`Thin-film GPU Fresnel differs from independent numerical CIE integration by ${filmMaxError}`);
      }finally{output.destroy();readback.destroy();}

      const all={sheen:{colorFactor:[0.2,0.1,0.05],roughnessFactor:0.4},specular:{factor:0.8,colorFactor:[1,0.8,0.6]},anisotropy:{strength:0.5,rotation:0.2},iridescence:{factor:0.5,thicknessMinimum:250,thicknessMaximum:250}};
      const coat=materials.clearcoat({factor:0.4,roughnessFactor:0.2}),combined=await render(materials.materialLobes(all,coat));
      assert(difference(combined.beauty,baseline.beauty).changed>0,'Composed lobes and clearcoat did not change the material');exact(combined.normal,baseline.normal,'New lobes changed the base g-buffer normal');
      const opaque=texture([160,80,40,255]),transmitted=materials.transmission({factor:1,ior:1,opaqueColor:opaque.view});
      const transmissionBase=await render(transmitted,{blend:true,base:[1,1,1,1]});
      const transmissionLobes=await render(materials.materialLobes(all,transmitted),{blend:true,base:[1,1,1,1]});exact(transmissionBase.beauty,transmissionLobes.beauty,'New lobes bypassed full transmission compositing');
      const shadowedExtension=materials.materialLobes(all,coat),unshadowed=await render(shadowedExtension,{...black,direction:[0.4,0.3,1,1]});
      const removeLighting=model.addLighting({shader(code){assert(code.includes('direct+ambient(s)'),'The standard lighting hook changed');return code.replace('direct+ambient(s)','direct*0.0+ambient(s)');},bindings(){return [];}});
      try{const shadowed=await render(shadowedExtension,{...black,direction:[0.4,0.3,1,1]});assert(sum(unshadowed.linear).some(value=>value>0),'The directional lobe test was black before visibility');assert(sum(shadowed.linear).every(value=>value===0),'New lobes bypassed directional shadow visibility');}
      finally{removeLighting();}

      const textureRecords=[],createTexture=device.createTexture.bind(device);device.createTexture=descriptor=>{const value=createTexture(descriptor),record={descriptor,destroyed:false},destroy=value.destroy.bind(value);textureRecords.push(record);value.destroy=()=>{record.destroyed=true;destroy();};return value;};
      let ktxReport;
      try{
        const ktxModel=await loadGLTF(engine,new URL('/test-results/materials-lobes-ktx.gltf',location.href),{allowedURLs:[new URL('/packages/decoders/tests/fixtures/',location.href).href]}),installation=materials.install(ktxModel);
        try{
          const uploads=textureRecords.filter(record=>record.descriptor.mipLevelCount===8);assert(uploads.some(record=>record.descriptor.format.endsWith('-srgb'))&&uploads.some(record=>!record.descriptor.format.endsWith('-srgb')),'KTX2 lobe maps did not create separate linear and sRGB mip views');
          const initial=await render(undefined,{},ktxModel),factors=ktxModel.primitives[0].material.extension.factors;ktxModel.onDeviceRestored(engine);installation.onDeviceRestored(engine);
          assert(uploads.every(record=>record.destroyed),'Device restoration retained old KTX2 lobe uploads');assert(ktxModel.primitives[0].material.extension.factors===factors,'Device restoration replaced live lobe factors');
          const restored=await render(undefined,{},ktxModel);exact(initial.beauty,restored.beauty,'KTX2 lobe restoration changed pixels');ktxReport={formats:uploads.map(record=>record.descriptor.format),mipLevels:8,restored:true};
        }finally{installation.dispose();ktxModel.destroy();}
        assert(textureRecords.every(record=>record.destroyed),'Uninstall/disposal retained a KTX2 lobe texture');
      }finally{device.createTexture=createTexture;}
      const validation=await device.popErrorScope();assert(!validation,validation?.message);
      const compilationErrors=(await Promise.all(modules.map(module=>module.getCompilationInfo()))).flatMap(info=>info.messages.filter(message=>message.type==='error').map(message=>message.message));assert(!compilationErrors.length,compilationErrors.join('\n'));
      return {pixelsPerCapture:width*height,captures,parity,specularZeroRemovesLobe:true,iorTwoF0Ratio:iorRatio,iorOneZeroF0:true,metalSpecularUnaffected:true,sheenDelta,anisotropyMoments:[moment0,moment90],tinyAnisotropy,iridescenceRGB:filmRgb,
        textureChannels:['sheen.roughness.a','specular.factor.a','anisotropy.direction.rg','anisotropy.strength.b','iridescence.factor.r','iridescence.thickness.g'],linearColorTextures:true,clearcoatComposition:true,transmissionComposition:true,
        independentThinFilm:{cases:payload.filmExpected.length,maxError:filmMaxError},transformedUV1Maps:uvResults,samplerFree:true,directionalVisibility:true,ktx2:ktxReport,shaderModules:modules.length,compilationErrors};
    }finally{engine.dispose();for(const resource of owned)resource.destroy();canvas.remove();}
  },{...serialize(fixture),actual:serialize(actual),reference:serialize(reference),transform,pixels:[...texturePixels],filmWGSL,filmProgram,filmExpected:iridescenceCases.map(iridescenceReference)});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const browser=await openBrowser({startPath:'/tests/modern-extension.html',port:5202}),errors=[];browser.page.on('pageerror',error=>errors.push(error.message));browser.page.on('console',message=>{if(message.type()==='error'||/Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))errors.push(message.text());});
  try{const checks=await lobeBrowserChecks(browser.page);assert.deepEqual(errors,[]);const report={hardware:browser.hardware,...checks,errors};await writeFile('test-results/materials-lobes-webgpu.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
  finally{await browser.close();}
}
