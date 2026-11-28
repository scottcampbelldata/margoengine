import {createDoor,driveNames,lampNames} from './machine.js';
import {vault} from './vault.js';

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const stageName={service:'Service',mechanism:'Mechanism',operating:'Operating',hold:'Held'};
const unitName={drive:'Door drive',lamp:'Lamp'};
const stateName=state=>driveNames[state]??lampNames[state]??stageName[state]??'Inactive';
const motion=new Set(['withdraw','swingOut','swingIn','extend']);

export async function mount({engine,canvas,notice,signal,size,fail}){
  const get=id=>document.getElementById(id),data=canvas.dataset;
  const chart=get('mode').closest('.chart'),history=get('history'),command=get('command'),lamp=get('lamp'),hold=get('hold');
  const phaseLabels=[...chart.querySelectorAll('[data-drive]')];
  const events=get('journal-list'),journal=events.closest('details');
  data.renderer=engine.backend==='webgl2'?'compatibility':'webgpu';
  get('renderer').textContent=data.renderer==='webgpu'?'Margo WebGPU':'Margo WebGL2';
  const {machine,regions,pose,trace,snapshot}=createDoor(),art=vault(engine);
  performance.mark('state-machine-door-stage');
  let request=0,last=0,frame=0,dirty=true,enabled=false,prior='',operationMark=false;

  function log(){
    events.replaceChildren();
    const labels=trace.records.filter(record=>record.to||record.from).slice(-12).reverse();
    for(const record of labels){
      const li=document.createElement('li'),branch=record.machine.split('/').at(-1);
      li.textContent=(unitName[branch]??'Controller')+' · '+stateName(record.from)+' → '+stateName(record.to);
      events.append(li);
    }
    if(!labels.length){
      const li=document.createElement('li');
      li.textContent='No transitions since startup.';
      events.append(li);
    }
  }

  function readout(){
    const active=regions.active,paused=!regions.running;
    const key=[machine.state,active.drive,active.lamp,enabled].join('/');
    if(key===prior)return;
    prior=key;
    const snap=snapshot();
    const [,saved]=snap.regions[0],memory=new Map(snap.memory).get('service');
    const drive=paused?saved.starts[0]:active.drive;
    const inspect=paused?saved.starts[1]:active.lamp;
    data.root=snap.state;
    data.drive=active.drive??'';
    data.lamp=active.lamp??'';
    data.savedDrive=paused?drive:'';
    data.savedLamp=paused?inspect:'';
    data.history=memory??'';
    data.trace=trace.records.map(r=>r.event).filter(Boolean).join(',');
    chart.dataset.hold=String(paused);
    get('mode').textContent=paused?'Held':'Operating';
    const ancestorNames=paused?[]:snap.entered.map(([state])=>stageName[state]);
    if(paused){
      for(let at=memory;at;at=machine.states[at].parent)ancestorNames.unshift(stageName[at]);
    }
    const displayedPath=paused?'Held · saved '+ancestorNames.join(' › '):ancestorNames.join(' › ');
    get('ancestors').textContent=displayedPath;
    history.textContent=paused?'Both regions are suspended. Resume restores these two states.':
      'Two regions run in parallel inside Operating.';
    get('drive').textContent=stateName(drive);
    get('lamp-state').textContent=stateName(inspect);
    for(const label of phaseLabels){
      label.toggleAttribute('data-active',!paused&&label.dataset.drive===drive);
      label.toggleAttribute('data-remembered',paused&&label.dataset.drive===drive);
    }
    hold.textContent=paused?'Resume':'Hold';
    command.textContent=drive==='open'||drive==='swingIn'||drive==='extend'?'Close vault':'Open vault';
    command.disabled=!enabled||paused||!['sealed','open'].includes(drive);
    hold.disabled=!enabled;
    lamp.disabled=!enabled||paused;
    lamp.setAttribute('aria-pressed',String(pose.light));
    get('announcement').textContent=paused?'Held. Saved '+stateName(drive)+' and lamp '+stateName(inspect)+'.':
      stateName(drive)+'. Inspection lamp '+stateName(inspect)+'.';
    if(journal.open)log();
  }
  journal.addEventListener('toggle',()=>{if(journal.open)log();},{signal});
  command.addEventListener('click',event=>{
    const action=regions.active.drive==='open'?'close':'open';
    if(machine.send(action)){
      if(event.isTrusted&&action==='open'&&!performance.getEntriesByName('state-machine-door-first-input').length)
        operationMark=true;
      last=performance.now();
      readout();
      dirty=true;
    }
  },{signal});
  lamp.addEventListener('click',()=>{if(machine.send('light')){readout();dirty=true;}},{signal});
  hold.addEventListener('click',()=>{
    if(machine.send(regions.running?'hold':'resume')){last=performance.now();readout();dirty=true;}
  },{signal});

  function draw(){
    art.pose(pose,!regions.running);
    engine.render(0);
    data.angle=pose.angle.toFixed(5);
    data.bolt=pose.bolt.toFixed(5);
    data.light=String(pose.light);
    data.frame=String(++frame);
    get('angle').textContent=Math.round(pose.angle)+'°';
    get('bolts').textContent=Math.round(pose.bolt*100)+'%';
  }

  function animate(now){
    if(signal.aborted)return;
    request=requestAnimationFrame(animate);
    const moving=motion.has(regions.active.drive);
    if(!dirty&&!moving)return;
    try{
      const dt=Math.min(.064,Math.max(.001,(now-last)/1000));
      last=now;
      dirty=false;
      if(moving){machine.update(dt);readout();}
      draw();
      if(operationMark&&pose.bolt<.974){
        operationMark=false;
        Promise.resolve(engine.gpu?.queue.onSubmittedWorkDone()).then(nextFrame).then(()=>{
          if(!signal.aborted)performance.mark('state-machine-door-first-input');
        }).catch(fail);
      }
    }catch(reason){fail(reason);}
  }

  const resize=new ResizeObserver(()=>{if(!signal.aborted&&size())dirty=true;});
  signal.addEventListener('abort',()=>{cancelAnimationFrame(request);resize.disconnect();trace.dispose();},{once:true});
  readout();
  draw();
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  await nextFrame();
  signal.throwIfAborted();
  enabled=true;
  readout();
  notice.hidden=true;
  data.ready='true';
  performance.mark('state-machine-door-ready');
  resize.observe(canvas);
  request=requestAnimationFrame(animate);
}
