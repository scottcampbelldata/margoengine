import {buildMeridian} from './form.js';

const form=buildMeridian();
self.postMessage(form,[form.positions.buffer,form.normals.buffer,form.indices.buffer]);
