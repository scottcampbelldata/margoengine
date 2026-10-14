import type {SkyFeatures} from './base.js';
/** Preetham analytic day model (the default `model`); needs no precomputed tables. */
export const preetham:NonNullable<SkyFeatures['preetham']>={wgsl:`fn perez(theta:f32,gamma:f32,a:f32,b:f32,c:f32,d:f32,e:f32)->f32{return (1.0+a*exp(b/max(0.01,cos(theta))))*(1.0+c*exp(d*gamma)+e*cos(gamma)*cos(gamma));}
fn preetham(w:vec3f,s:vec3f)->vec3f {
 let t=frame.settings.z;let theta=acos(clamp(w.y,0.01,1.0));let gamma=acos(clamp(dot(w,s),-1.0,1.0));let z=acos(clamp(s.y,0.01,1.0));let z2=z*z;let z3=z2*z;
 let yz=max(0.001,(4.0453*t-4.9710)*tan((4.0/9.0-t/120.0)*(3.14159265-2.0*z))-0.2155*t+2.4192);
 let xz=(0.00165*z3-0.00374*z2+0.00208*z)*t*t+(-0.02902*z3+0.06377*z2-0.03202*z+0.00394)*t+0.11693*z3-0.21196*z2+0.06052*z+0.25885;
 let zz=(0.00275*z3-0.00610*z2+0.00317*z)*t*t+(-0.04214*z3+0.08970*z2-0.04153*z+0.00516)*t+0.15346*z3-0.26756*z2+0.06670*z+0.26688;
 let y=yz*perez(theta,gamma,0.1787*t-1.4630,-0.3554*t+0.4275,-0.0227*t+5.3251,0.1206*t-2.5771,-0.0670*t+0.3703)/perez(0.0,z,0.1787*t-1.4630,-0.3554*t+0.4275,-0.0227*t+5.3251,0.1206*t-2.5771,-0.0670*t+0.3703)*0.05;
 let x=xz*perez(theta,gamma,-0.0193*t-0.2592,-0.0665*t+0.0008,-0.0004*t+0.2125,-0.0641*t-0.8989,-0.0033*t+0.0452)/perez(0.0,z,-0.0193*t-0.2592,-0.0665*t+0.0008,-0.0004*t+0.2125,-0.0641*t-0.8989,-0.0033*t+0.0452);
 let chroma=zz*perez(theta,gamma,-0.0167*t-0.2608,-0.0950*t+0.0092,-0.0079*t+0.2102,-0.0441*t-1.6537,-0.0109*t+0.0529)/perez(0.0,z,-0.0167*t-0.2608,-0.0950*t+0.0092,-0.0079*t+0.2102,-0.0441*t-1.6537,-0.0109*t+0.0529);
 let xyz=vec3f(x*y/max(chroma,0.001),y,(1.0-x-chroma)*y/max(chroma,0.001));
 return max(vec3f(0),mat3x3f(vec3f(3.2406,-0.9689,0.0557),vec3f(-1.5372,1.8758,-0.2040),vec3f(-0.4986,0.0415,1.0570))*xyz)*smoothstep(-0.2,0.05,s.y);
}
`};
