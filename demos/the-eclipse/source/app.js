import { demoStatus } from 'margo-demo-status';
import { clock, contacts, eclipse, initial, totalSeconds } from './model.mjs';

const el = id => document.getElementById(id);
const stage = el('stage'), slider = el('time');
const buttons = [...document.querySelectorAll('[data-jump]')];
const controls = [slider,...buttons];
const status = demoStatus(stage,el('status'));
const controller = new AbortController();
const { signal } = controller;
const forced = new URLSearchParams(location.search).get('backend')==='webgl2';
let scene, desired = initial, frame, observer, running=false, dirty=false, interacted=false;

function band(name,from,to) {
  const segment=el(name+'-band');
  segment.style.left=(100*from/totalSeconds)+'%';
  segment.style.width=(100*(to-from)/totalSeconds)+'%';
}
band('partial',contacts.start,contacts.end);
band('total',contacts.total,contacts.exit);
function read(current) {
  const {second, cover, flux, phase} = current;
  const format = n => (100*n).toFixed(1)+'%';
  el('time-readout').textContent=clock(second);
  el('phase').textContent=second===Math.round(contacts.start)?'First contact':second===Math.round(contacts.end)?'Last contact':phase;
  el('coverage').textContent=format(cover);
  el('flux').textContent=format(flux);
  if (second===desired) slider.value=String(second);
  slider.setAttribute('aria-valuetext',clock(second)+' Central Daylight Time, '+phase);
  for(const button of buttons) button.setAttribute('aria-pressed',String(Math.round(contacts[button.dataset.jump])===second));
  Object.assign(stage.dataset,{second,phase,cover,flux,elevation:current.elevation,separation:current.distance});
}

function stop(error) {
  if (signal.aborted) return;
  for(const control of controls) control.disabled=true;
  status.error(error);
  scene?.close();
}

function queue() {
  if (signal.aborted || !scene || status.failed || running || frame !== undefined) return;
  frame=requestAnimationFrame(async () => {
    frame=undefined;
    running=true;
    dirty=false;
    const current=eclipse(desired);
    try {
      await scene.render(current);
      if (signal.aborted) return;
      read(current);
      if (interacted && current.second===desired && current.second!==initial &&
          !performance.getEntriesByName('margo-first-input-rendered').length) {
        performance.mark('margo-first-input-rendered');
      }
    } catch(error) { stop(error); }
    finally {
      running=false;
      if (dirty) queue();
    }
  });
}

function select(second) {
  desired=second;
  interacted=true;
  dirty=true;
  queue();
}
slider.addEventListener('input',()=>select(Number(slider.value)),{signal});
for(const button of buttons) button.addEventListener('click',()=>select(Math.round(contacts[button.dataset.jump])),{signal});
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  observer?.disconnect();
  if(frame!==undefined)cancelAnimationFrame(frame);
},{signal});

const first=eclipse(initial);
read(first);
const earlyCompatibility = forced || !navigator.gpu
  ? import('./compatibility.js').then(async module => {
    await module.installCompatibility(forced,signal);
    return {};
  }).catch(error=>({error}))
  : undefined;
import('./scene.js').then(async ({openScene})=>{
  scene=await openScene(el('sky'),first,signal,forced,earlyCompatibility);
  signal.throwIfAborted();
  stage.dataset.renderer=scene.backend;
  observer=new ResizeObserver(()=>{dirty=true;queue();});
  observer.observe(stage);
  for(const control of controls)control.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}).catch(stop);
