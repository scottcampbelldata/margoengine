import {PbrMaterial} from '@vexel/core/extension';
export const industrialMaterials=Object.freeze({
  machinedSteel:Object.freeze({color:'#a9b0b6',roughness:0.25,metalness:1}),carbonSteel:Object.freeze({color:'#727b83',roughness:0.35,metalness:1}),
  galvanizedZinc:Object.freeze({color:'#b9c2c8',roughness:0.45,metalness:0.95}),anodizedAluminum:Object.freeze({color:'#c7ccd0',roughness:0.2,metalness:0.9}),coloredAnodizedAluminum:Object.freeze({color:'#46749a',roughness:0.2,metalness:0.9}),
  neoprene:Object.freeze({color:'#202326',roughness:0.85,metalness:0}),powderCoat:Object.freeze({color:'#e6a326',roughness:0.3,metalness:0})
});
export function industrialMaterial(name:keyof typeof industrialMaterials,color?:string):PbrMaterial {const preset=industrialMaterials[name];if(!preset)throw new TypeError('Unknown industrial material');return new PbrMaterial({...preset,...(color?{color}:{})});}
