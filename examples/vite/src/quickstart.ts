import {createStage} from 'margoengine';
const app = await createStage('#scene', {onError: error => {document.querySelector('#error')!.textContent = String(error);}});
const orb = app.sphere({color: '#84d6bd', roughness: 0.25, scale: [1, 0.85, 1]});
app.onTick(delta => {orb.rotation.z += delta;});
window.addEventListener('pagehide', () => app.dispose(), {once: true});
