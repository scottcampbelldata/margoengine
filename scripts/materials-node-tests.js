import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {openBrowser} from './browser.js';
import {materialQuad} from '../tests/support/materials-fixture.js';
import {transmissionQuads} from '../tests/support/transmission-fixture.js';

/** Hardware-backed graph checks exercise the compiled extension, including shared lobes. */
export async function nodeBrowserChecks(page) {
  const quad=materialQuad(),glass=transmissionQuads(),front=transmissionQuads(),back=transmissionQuads();
  front.doc.nodes=[front.doc.nodes[1]];back.doc.nodes=[back.doc.nodes[0]];
  const serialize=fixture=>({doc:fixture.doc,buffers:fixture.buffers.map(buffer=>[...new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength)])});
  return page.evaluate(async fixtures=>{
    const {Engine}=await import('/packages/core/dist/index.js');
    const {parseGLTF}=await import('/packages/gltf-pro/dist/index.js');
    const materials=await import('/packages/materials/dist/index.js');
    const assert=(value,message)=>{if(!value)throw new Error(message);};
    const width=128,height=128,canvas=document.createElement('canvas');
    canvas.style.cssText=`width:${width}px;height:${height}px`;document.body.append(canvas);
    const engine=await Engine.create(canvas,{backend:'webgpu',capacity:64,camera:{position:[0,0,3],target:[0,0,0]}});
    const device=engine.gpu,modules=[],owned=[],createModule=device.createShaderModule.bind(device);
    device.createShaderModule=descriptor=>{const module=createModule(descriptor);modules.push(module);return module;};
    engine.camera.update(1,true);engine.lighting.direction.set([0,0,1,1]);engine.lighting.radiance.set([1,1,1,0.03]);
    const texture=(bytes,size=[1,1])=>{
      const resource=device.createTexture({size,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(resource);
      device.queue.writeTexture({texture:resource},new Uint8Array(bytes),{bytesPerRow:size[0]*4},size);
      return {view:resource.createView(),sampler:device.createSampler({minFilter:'nearest',magFilter:'nearest',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'})};
    };
    const target=device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});owned.push(target);
    const depth=device.createTexture({size:[width,height],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT});owned.push(depth);
    const normals=device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});owned.push(normals);
    const color=target.createView(),depthView=depth.createView(),normalView=normals.createView();
    const read=async(source=target)=>{
      const row=width*(source===normals?8:4),buffer=device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:source},{buffer,bytesPerRow:row},[width,height]);device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);const result=new Uint8Array(buffer.getMappedRange()).slice();buffer.unmap();return result;
      }finally{buffer.destroy();}
    };
    let captures=0;
    const render=async(configure=()=>{},fixture=fixtures.quad,frame=false)=>{
      captures++;const background=fixture===fixtures.front?parseGLTF(engine,structuredClone(fixtures.back.doc),fixtures.back.buffers.map(buffer=>new Uint8Array(buffer))):undefined;
      const model=parseGLTF(engine,structuredClone(fixture.doc),fixture.buffers.map(buffer=>new Uint8Array(buffer)));
      let installation;
      try{
        installation=configure(model);engine.store.tick(false);
        const encoder=device.createCommandEncoder(),context={backend:'webgpu',device,encoder,color,depth:depthView,format:'rgba8unorm',width,height,camera:engine.camera,
          descriptor:{multisample:{count:1},depthStencil:{format:'depth32float'}},draw(){
            encoder.beginRenderPass({colorAttachments:[{view:color,clearValue:[0,0,0,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depthView,depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}}).end();
          },delta:0};
        if(frame){engine.frameGraph.prepare(context);engine.frameGraph.execute(context);}else{
          context.draw();model.draw(context,'beauty',color,depthView);
          encoder.beginRenderPass({colorAttachments:[{view:normalView,clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]}).end();
          model.draw(context,'gbuffer',normalView,depthView);
        }
        device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
        return {beauty:await read(),...(!frame?{normals:await read(normals)}:{})};
      }finally{installation?.dispose();model.destroy();background?.destroy();}
    };
    const difference=(a,b,center=false)=>{
      let changed=0,max=0;for(let y=center?48:0;y<(center?80:height);y++)for(let x=center?48:0;x<(center?80:width);x++)for(let c=0;c<4;c++){
        const index=(y*width+x)*4+c,delta=Math.abs(a[index]-b[index]);changed+=+(delta>0);max=Math.max(max,delta);
      }return {changed,max};
    };
    const exact=(a,b,message)=>{assert(a.length===b.length&&a.every((value,index)=>value===b[index]),message);};
    const base=(primitive,value=[0.08,0.08,0.08,1],roughness=1,metal=0)=>{
      primitive.material.base=value;primitive.material.factors[0]=roughness;primitive.material.factors[1]=metal;
    };
    const scalar=value=>({type:'scalar',value}),constant=(value=[0.08,0.08,0.08,1])=>({type:'color',value});
    const graph=(value=constant(),extra={})=>({nodes:[{type:'emit',color:value,...extra}]});
    const attach=(value=graph())=>model=>{model.primitives[0].extension=materials.nodeMaterial(value);};
    const txGraph=(factor=1,ior=scalar(1),volume)=>graph(constant([1,1,1,1]),{transmission:{type:'transmission',factor:typeof factor==='number'?scalar(factor):factor,ior,...(volume?{volume}:{})}});
    device.pushErrorScope('validation');
    try{
      const pbrColor=[0.2,0.4,0.6,1];
      const baseline=await render(model=>{base(model.primitives[0],pbrColor);});
      const emitted=await render(attach(graph(constant(pbrColor)))),colorDifference=difference(baseline.beauty,emitted.beauty);
      assert(colorDifference.changed===0,`Color into emit changed ${colorDifference.changed} PBR channels`);
      exact(baseline.normals,emitted.normals,'Color into emit changed the PBR g-buffer normal');
      const center=(height/2*width+width/2)*4;
      assert(emitted.beauty[center]!==51||emitted.beauty[center+1]!==102||emitted.beauty[center+2]!==153,'emit incorrectly bypassed PBR lighting');

      const first=constant([0.125,0.25,0.5,1]),product={type:'mul',a:first,b:scalar(0.5)};
      const sum={type:'add',a:product,b:scalar(0.125)},mixed={type:'mix',a:sum,b:constant([0.5,0.5,0.5,1]),factor:scalar(0.5)};
      const calculated=await render(attach(graph(mixed))),calculatedBaseline=await render(model=>{base(model.primitives[0],[0.34375,0.375,0.4375,0.8125]);});
      assert(difference(calculated.beauty,calculatedBaseline.beauty).changed===0,'Scalar/vector add, mul and mix differ from their expected PBR color');
      const vectorMix={type:'mix',a:constant([0.125,0.25,0.5,1]),b:constant([0.5,0.5,0.25,1]),factor:constant([0,0.5,1,1])};
      const componentMix=await render(attach(graph(vectorMix))),componentBaseline=await render(model=>{base(model.primitives[0],[0.125,0.375,0.25,1]);});
      assert(difference(componentMix.beauty,componentBaseline.beauty).changed===0,'Vec4 mix did not interpolate component-wise');

      const rgb=texture([64,128,192,255]),sample={type:'texture',texture:rgb};
      const sampled=await render(attach(graph(sample))),sampledBaseline=await render(model=>{base(model.primitives[0],[64/255,128/255,192/255,1]);});
      assert(difference(sampled.beauty,sampledBaseline.beauty).max<=1,'A linear node texture differs from its matching constant base color');
      const loaded=await render(attach(graph({type:'texture',texture:{view:rgb.view}})));
      assert(difference(sampled.beauty,loaded.beauty).changed===0,'Sampler-free node texture changed its constant sampled value');
      const halves=texture([128,0,0,255,0,128,0,255],[2,1]);
      const uv0=await render(attach(graph({type:'texture',texture:halves,texCoord:0})));
      const uv1=await render(attach(graph({type:'texture',texture:halves,texCoord:1})));
      assert(difference(uv0.beauty,uv1.beauty).changed>0,'Node texture UV1 did not select the existing independent UV set');

      const plain=await render(attach()),flat=texture([128,128,255,255]),tilted=texture([218,128,218,255]);
      const normal=(map,texCoord=0,scale=scalar(1))=>({type:'normalMap',texture:{type:'texture',texture:map,texCoord},texCoord,scale});
      const flatNormal=await render(attach(graph(constant(),{normal:normal(flat)})));
      assert(difference(plain.beauty,flatNormal.beauty).max<=1,'Flat node normal map changed the ordinary PBR normal');
      const mapped=await render(attach(graph(constant(),{normal:normal(tilted)})));
      assert(difference(mapped.beauty,plain.beauty).changed>0,'Node normalMap did not affect PBR lighting');
      assert(mapped.normals.some((value,index)=>value!==plain.normals[index]),'Node normalMap did not update the base g-buffer normal');
      const zeroNormal=await render(attach(graph(constant(),{normal:normal(tilted,0,scalar(0))})));
      const geometricNormal=await render(model=>{base(model.primitives[0]);model.primitives[0].material.factors[2]=0;});
      assert(difference(zeroNormal.beauty,geometricNormal.beauty).max<=1,'Node normal scale zero differs from the geometric normal');
      await render(attach(graph(constant(),{normal:normal(tilted,1)})));
      const extremeNormal=await render(attach(graph(constant(),{normal:normal(tilted,0,scalar(1e38))})));
      const halfNormals=new Uint16Array(extremeNormal.normals.buffer,extremeNormal.normals.byteOffset,extremeNormal.normals.byteLength/2);
      assert([...halfNormals].every(value=>(value&0x7c00)!==0x7c00),'Extreme finite node normal scale produced a nonfinite g-buffer normal');
      const packed=texture([255,64,192,255]);
      const packedGraph=graph(constant(),{metalRough:{type:'metalRough',texture:{type:'texture',texture:packed}}});
      const packedImage=await render(attach(packedGraph)),packedBaseline=await render(model=>{base(model.primitives[0],[0.08,0.08,0.08,1],64/255,192/255);});
      assert(difference(packedImage.beauty,packedBaseline.beauty).max<=1,'metalRough did not use the green roughness and blue metallic channels');
      const factoredGraph=graph(constant(),{metalRough:{type:'metalRough',texture:{type:'texture',texture:packed},roughness:scalar(0.5),metal:scalar(0.5)}});
      const factored=await render(attach(factoredGraph)),factoredBaseline=await render(model=>{base(model.primitives[0],[0.08,0.08,0.08,1],32/255,96/255);});
      assert(difference(factored.beauty,factoredBaseline.beauty).max<=1,'metalRough did not multiply packed channels by scalar factors');

      const coatGraph=factor=>graph(constant(),{clearcoat:{type:'clearcoat',factor:scalar(factor),roughness:scalar(0.05)}});
      const coatZero=await render(attach(coatGraph(0))),coatZeroDifference=difference(plain.beauty,coatZero.beauty);
      assert(coatZeroDifference.changed===0,`Clearcoat node factor zero changed ${coatZeroDifference.changed} channels`);
      exact(plain.normals,coatZero.normals,'Factor-zero clearcoat node changed the g-buffer');
      const coatOne=await render(attach(coatGraph(1))),sharedCoat=await render(model=>{base(model.primitives[0]);model.primitives[0].extension=materials.clearcoat({factor:1,roughnessFactor:0.05});});
      assert(difference(coatOne.beauty,plain.beauty).changed>0,'Positive node clearcoat did not contribute its second lobe');
      assert(difference(coatOne.beauty,sharedCoat.beauty).max<=1,'Node clearcoat differs from the shared glTF clearcoat lobe');
      exact(plain.normals,coatOne.normals,'Clearcoat node changed the base g-buffer normal');
      const redZero=texture([0,255,255,255]),redOne=texture([255,0,0,255]);
      const coatFactor=map=>graph(constant(),{clearcoat:{type:'clearcoat',factor:{type:'texture',texture:map},roughness:scalar(0.05)}});
      const coatMapZero=await render(attach(coatFactor(redZero))),coatMapOne=await render(attach(coatFactor(redOne)));
      assert(difference(coatMapZero.beauty,plain.beauty).changed===0,'Clearcoat node texture factor must use its red channel');
      assert(difference(coatMapOne.beauty,coatOne.beauty).max<=1,'Clearcoat node red=1 differs from its scalar factor');
      const coatNormal=await render(attach(graph(constant(),{clearcoat:{type:'clearcoat',factor:scalar(1),roughness:scalar(0.05),normal:normal(tilted)}})));
      const sharedCoatNormal=await render(model=>{base(model.primitives[0]);model.primitives[0].extension=materials.clearcoat({factor:1,roughnessFactor:0.05,clearcoatNormalTexture:tilted});});
      assert(difference(coatNormal.beauty,sharedCoatNormal.beauty).max<=1,'Node clearcoat normal differs from the shared coat normal path');
      exact(plain.normals,coatNormal.normals,'Independent node coat normal changed the base g-buffer');

      const background=await render(()=>{},fixtures.back,true);
      const glassBaseline=await render(model=>{base(model.primitives[0],[1,1,1,1]);},fixtures.front,true);
      const glassZero=await render(model=>materials.installNodeMaterial(model,txGraph(0)),fixtures.front,true),transmissionZeroDifference=difference(glassBaseline.beauty,glassZero.beauty);
      assert(transmissionZeroDifference.changed===0,'Transmission node factor zero changed the opaque PBR material');
      const straight=await render(model=>materials.installNodeMaterial(model,txGraph()),fixtures.front,true),iorOneDifference=difference(background.beauty,straight.beauty,true);
      assert(iorOneDifference.max<=1,`Node IOR 1 differs from the opaque background by ${iorOneDifference.max}`);
      const sharedTransmission=await render(model=>{
        base(model.primitives[0],[1,1,1,1]);model.primitives[0].material.transmission={factor:1,ior:1};return materials.install(model);
      },fixtures.front,true);
      assert(difference(straight.beauty,sharedTransmission.beauty).changed===0,'Node transmission differs from the shared glTF capture and shader path');
      const iorExpression={type:'add',a:scalar(0.5),b:scalar(0.5)};
      const arithmeticIOR=await render(model=>materials.installNodeMaterial(model,txGraph(1,iorExpression)),fixtures.front,true);
      assert(difference(straight.beauty,arithmeticIOR.beauty).changed===0,'Scalar arithmetic for node IOR did not preserve IOR-1 parity');
      const transmissionMapZero=await render(model=>materials.installNodeMaterial(model,txGraph({type:'texture',texture:redZero})),fixtures.front,true);
      const transmissionMapOne=await render(model=>materials.installNodeMaterial(model,txGraph({type:'texture',texture:redOne})),fixtures.front,true);
      const transmissionMapZeroDifference=difference(glassBaseline.beauty,transmissionMapZero.beauty,true);
      assert(transmissionMapZeroDifference.max<=1,'Transmission node factor must use texture red');
      assert(difference(straight.beauty,transmissionMapOne.beauty).changed===0,'Transmission node red=1 differs from its scalar factor');
      const volume={thickness:scalar(1),attenuationColor:constant([0.2,1,1,1]),attenuationDistance:0.5};
      const absorbed=await render(model=>materials.installNodeMaterial(model,txGraph(1,scalar(1),volume)),fixtures.front,true);
      const sharedVolume=await render(model=>{
        base(model.primitives[0],[1,1,1,1]);model.primitives[0].material.transmission={factor:1,ior:1,volume:{thicknessFactor:1,attenuationColor:[0.2,1,1],attenuationDistance:0.5}};return materials.install(model);
      },fixtures.front,true);
      assert(difference(absorbed.beauty,sharedVolume.beauty).max<=1,'Node volume differs from the shared Beer-law attenuation path');
      assert(absorbed.beauty[center]<straight.beauty[center],'Node volume did not absorb the red opaque background');
      const unattenuated=await render(model=>materials.installNodeMaterial(model,txGraph(1,scalar(1),{...volume,attenuationDistance:Infinity})),fixtures.front,true);
      assert(difference(straight.beauty,unattenuated.beauty).changed===0,'Infinite node volume distance changed transmission');
      const greenZero=texture([255,0,255,255]),greenOne=texture([0,255,0,255]);
      const thicknessMap=map=>txGraph(1,scalar(1),{...volume,thickness:{type:'texture',texture:map}});
      const thinMap=await render(model=>materials.installNodeMaterial(model,thicknessMap(greenZero)),fixtures.front,true);
      const thickMap=await render(model=>materials.installNodeMaterial(model,thicknessMap(greenOne)),fixtures.front,true);
      assert(difference(straight.beauty,thinMap.beauty).changed===0,'Node volume thickness must use texture green');
      assert(difference(absorbed.beauty,thickMap.beauty).max<=1,'Node volume green=1 differs from its scalar thickness');
      const validation=await device.popErrorScope();assert(!validation,validation?.message);
      const compilationErrors=(await Promise.all(modules.map(module=>module.getCompilationInfo()))).flatMap(info=>info.messages.filter(message=>message.type==='error').map(message=>message.message));
      assert(!compilationErrors.length,compilationErrors.join('\n'));
      return {pixelsPerCapture:width*height,captures,colorEmit:colorDifference,clearcoatFactorZero:coatZeroDifference,transmissionFactorZero:transmissionZeroDifference,iorOne:iorOneDifference,
        scalarVectorArithmetic:true,linearTextures:true,independentUVSets:true,samplerFree:true,normalMap:true,finiteExtremeNormalScale:true,packedMetalRoughChannels:true,sharedClearcoat:true,independentCoatNormal:true,
        sharedTransmission:true,sharedVolume:true,textureChannels:['clearcoat.red','metalRough.green','metalRough.blue','transmission.red','thickness.green'],
        shaderModules:modules.length,compilationErrors};
    }finally{engine.dispose();for(const resource of owned)resource.destroy();canvas.remove();}
  },{quad:serialize(quad),glass:serialize(glass),front:serialize(front),back:serialize(back)});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const browser=await openBrowser({startPath:'/tests/modern-extension.html',port:5200}),errors=[];
  browser.page.on('pageerror',error=>errors.push(error.message));
  browser.page.on('console',message=>{if(message.type()==='error'||/Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))errors.push(message.text());});
  try{
    const checks=await nodeBrowserChecks(browser.page);assert.deepEqual(errors,[]);
    const report={hardware:browser.hardware,...checks,errors};await writeFile('test-results/materials-node-webgpu.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await browser.close();}
}
