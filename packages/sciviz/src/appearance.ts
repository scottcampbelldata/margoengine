/** Optional per-fragment physical transport, supplied only by an explicitly imported entry. */
export interface LayerAppearance {
 /** Solar surface shading instead of unlit data colours. Default false. */ readonly surface?:boolean;
 /** Updates transport for the current view before drawing, even when its background is hidden. */ prepare?(context:import('./render.js').GpuContext):void;
 /** Pipeline cache identity for shader source/layout. */ readonly key:string;
 /** WGSL defining planetSurface(world,albedo) and planetAerial(world,radiance), group 2 only. */ readonly shader:string;
 /** Current device's fragment group layout. */ readonly layout:GPUBindGroupLayout;
 /** Current device's transport bindings. */ readonly group:GPUBindGroup;
}
