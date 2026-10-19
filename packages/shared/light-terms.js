// WGSL distance falloff and spot cone of one clustered light record (`light`, its unit vector `l` from the shaded point
// and `distance`), shared by @margoengine/clustered's light loop and @margoengine/environment's volumetric fog.
// As written before lights had a decay.
export const legacyTerms = /* wgsl */ `let falloff=pow(max(0.0,1-pow(distance/light.positionRange.w,4.0)),2.0)/max(distance*distance,0.01);
    var cone=1.0;if(light.params.y>0.5){cone=clamp((dot(-l,light.directionOuter.xyz)-light.directionOuter.w)/max(light.params.x-light.directionOuter.w,0.00001),0.0,1.0);cone*=cone*(3-2*cone);}`;
// The same terms once any light sets `decay` or `angle` (clustered `setLights`): params.y holds 0 (point) or 1 (spot)
// for a light that sets neither, which keeps the terms above, and -(1 + decay) (point) or 2 + decay (spot) for one that
// does, so every `params.y > 0.5` spot test elsewhere still holds. Those lights get window / max(d^decay, 0.01) and the
// cone smoothstep(cos outer, cos inner, dot(-L, direction)), a hard edge when the two are equal (penumbra 0).
export const decayTerms = /* wgsl */ `let kind=light.params.y;let legacy=kind==0.0||kind==1.0;let decay=select(-1.0-kind,kind-2.0,kind>0.5);
    let falloff=pow(max(0.0,1-pow(distance/light.positionRange.w,4.0)),2.0)/select(max(pow(max(distance,0.0001),decay),0.01),max(distance*distance,0.01),legacy);
    var cone=1.0;if(kind>0.5){let x=dot(-l,light.directionOuter.xyz);let lo=light.directionOuter.w;let hi=light.params.x;
      if(legacy){cone=clamp((x-lo)/max(hi-lo,0.00001),0.0,1.0);}else if(hi>lo){cone=clamp((x-lo)/(hi-lo),0.0,1.0);}else{cone=select(0.0,1.0,x>=lo);}
      cone*=cone*(3-2*cone);}`;
