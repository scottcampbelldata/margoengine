import {install} from '@margoengine/webgl2-compat';
export const installCompatibility=signal=>install({force:true,signal});
