import {Engine} from '@margoengine/core';
import {XR,XRManager,XRController,useXRSession,type XRFrameState} from '@margoengine/xr';
import {parseUSDC,parseUSDZ as parsePBRUSDZ,type USDAsset} from '@margoengine/usdz';
import {parseIFC,type IFCResult} from '@margoengine/ifc';
import {parseUSDA,parseUSDZ,createMeshes} from '@margoengine/loaders';
import {exportUSDZ} from '@margoengine/exporters';
import {decodeMargo,parseMargo,loadMargo,type MargoAsset} from '@margoengine/blender';
import type {IfcAPI} from 'web-ifc';

export async function scene(canvas:HTMLCanvasElement,api:IfcAPI,data:Uint8Array) {
  const engine=await Engine.create(canvas,{backend:'webgpu'});
  const ifc:IFCResult=parseIFC(api,data);const meshes=createMeshes(engine,ifc);
  const xr=await XR.create(engine);
  const render=(frame:XRFrameState)=>{for(const input of frame.inputs){const position=input.grip?.transform.position;const gamepad:Gamepad|undefined=input.source.gamepad;void position;void gamepad;}};
  const enter=()=>xr.requestSession('immersive-vr',{onFrame:render});
  const archive:Uint8Array=exportUSDZ(engine);const loaded=await parseUSDZ(archive);void parseUSDA;
  const pbr:USDAsset=await parsePBRUSDZ(archive);void pbr.meshes;void parseUSDC;void XRManager;void XRController;void useXRSession;
  const inspect:(bytes:Uint8Array)=>MargoAsset=decodeMargo;void inspect;void parseMargo;void loadMargo;
  return {enter,archive,loaded,products:ifc.products,dispose(){meshes.dispose();xr.dispose();engine.dispose();}};
}
