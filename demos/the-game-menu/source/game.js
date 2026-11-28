import { Button, HealthBar, Inventory, Label, Menu, Panel, Slider, Toast, Toggle, createTheme, themes } from '@margoengine/ui';
import { language, zones } from './language.js';

const diveTheme=createTheme({
  name:'Lantern',radius:3,focusWidth:3,transition:.11,shadowBlur:16,
  fontSize:{small:14,body:16,large:22,title:30,display:43},
  colors:{background:'#07151a',surface:'#10262eee',surfaceRaised:'#1b3742',surfaceSunken:'#0c222b',
    border:'#628082',text:'#edf2e3',textMuted:'#bdd3cc',primary:'#f5c873',onPrimary:'#15272c',
    accent:'#8fcac5',onAccent:'#12262c',success:'#99d5b8',warning:'#ffd67e',danger:'#ff9a76',onDanger:'#361e21',
    focus:'#fff1b8',scrim:'#061215dc'},
});
const makeItem=(id,count=1)=>({id,count});
const reserves=()=>[makeItem('cell',2),makeItem('log'),null,null,null,null];
const get=id=>document.getElementById(id);
const numbers={en:new Intl.NumberFormat('en'),ar:new Intl.NumberFormat('ar',{numberingSystem:'arab'})};
const num=(value,locale)=>numbers[locale].format(value);

export function createDive(ui,{width,screenChanged,onAction,signal}){
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const high=matchMedia('(prefers-contrast: more)');
  let locale='en',strings=language.en,rtl=false,screen='title',settingsFrom='title';
  let station=0,battery=82,logged=new Set(),equipment=reserves(),contrast=high.matches,motion=reduced.matches;
  let bag,currentNotice,batteryLabel;
  const layout=()=>width()<710;
  const utility=value=>new Label({text:value,color:'textMuted',size:'small',align:'start'});
  const action=(text,onClick,variant='secondary',options={})=>new Button({text,onClick,variant,...options});
  const frame=(options)=>new Panel({background:'surface',border:true,padding:13,gap:8,...options});
  const anchor=(edge)=>{
    if(layout())return edge;
    return edge+'-'+(rtl?'right':'left');
  };
  const menuWidth=()=>layout()?Math.min(width()-26,345):280;
  const menuMargin=()=>layout()?13:37;
  const number=value=>num(value,locale);
  ui.captureKeys=true;

  function mirrorLanguage(){
    document.documentElement.lang=locale;
    document.documentElement.dir=rtl?'rtl':'ltr';
    get('gallery').textContent=strings.gallery;
    get('heading').textContent=strings.heading;
    get('dive-type').textContent=strings.tag;
    get('dive-title').replaceChildren(strings.title[0],document.createElement('br'),strings.title[1]);
    get('dive-description').textContent=strings.summary;
    get('ocean').setAttribute('aria-label',strings.canvas);
    document.querySelector('[data-margo-ui=mirror]')?.setAttribute('aria-label',strings.heading);
    document.title=strings.heading+' · Margo Engine';
  }
  function syncKeyboardFocus(widget){
    requestAnimationFrame(()=>{
      if(signal.aborted||widget.ui!==ui||ui.focused!==widget)return;
      const element=get('margo-ui-'+widget.id);
      if(element&&!element.closest('[inert]'))element.focus({preventScroll:true});
    });
  }
  function initialFocus(){
    const source=ui.inputMode;
    if(source!=='keyboard'&&source!=='gamepad')return;
    const first=ui.focusables()[0];
    if(first){
      ui.focus(first,source);
      syncKeyboardFocus(first);
    }
  }
  function describeEquipment(){
    return equipment.map(item=>{
      if(!item)return null;
      const [name,description,icon]=strings.item[item.id];
      const color=item.id==='cell'?'warning':item.id==='log'?'accent':'success';
      return {...item,name,description,icon,color};
    });
  }
  function slotNames(){
    if(!bag)return;
    for(let i=0;i<bag.slots;i++){
      const item=bag.get(i);
      bag.slot(i).label=item
        ? item.name+(item.count>1?', '+number(item.count):'')
        : (rtl?'خانة فارغة ':'Empty slot ')+number(i+1);
    }
  }
  function notify(message,kind='info'){
    currentNotice?.removeFromParent();
    currentNotice=new Toast(message,{kind,duration:3.4});
    currentNotice.label=message;
    currentNotice.pointerEvents='none';
    ui.toastLayer.children[0].add(currentNotice);
    ui.announce(message);
  }
  function positionNotices(){
    const stack=ui.toastLayer.children[0];
    stack.setStyle({anchor:layout()?'top':rtl?'top-left':'top-right',
      width:menuWidth(),margin:layout()?[141,13,0,13]:37});
  }
  function toData(){
    screenChanged({screen,station,battery,count:logged.size,rtl,locale,
      inventory:equipment.map(item=>item?item.id+'/'+item.count:'').join('|'),mode:ui.inputMode});
  }
  function switchScreen(next,{focus=true}={}){
    if(screen!==next){
      currentNotice?.removeFromParent();
      currentNotice=undefined;
    }
    screen=next;
    bag=undefined;
    ui.focus(null);
    ui.root.clear();
    if(next==='title')ui.add(titleMenu());
    else if(next==='paused')ui.add(pauseMenu());
    else if(next==='settings')ui.add(settings());
    else if(next==='play')ui.add(instruments(),mission());
    else if(next==='equipment')ui.add(instruments(),toolkit());
    else ui.add(endScreen());
    positionNotices();
    if(focus)initialFocus();
    toData();
  }
  function resize(){
    const previous=ui.focused?.label;
    switchScreen(screen,{focus:false});
    const focus=ui.focusables().find(widget=>widget.label===previous);
    if(focus)ui.focus(focus,ui.inputMode);
  }
  function applyPreferences(){
    ui.theme=contrast?themes.highContrast:diveTheme;
    ui.motion=!motion;
  }
  function showSettings(){
    settingsFrom=screen;
    switchScreen('settings');
  }
  function toggleLanguage(){
    locale=rtl?'en':'ar';
    strings=language[locale];
    rtl=locale==='ar';
    ui.direction=rtl?'rtl':'ltr';
    mirrorLanguage();
    switchScreen(screen);
  }
  function titleMenu(){
    return new Menu({label:strings.heading,anchor:anchor('bottom'),margin:menuMargin(),width:menuWidth(),
      border:layout(),shadow:false,padding:layout()?11:0,background:layout()?'surface':'none',
      gap:6,items:[
        {label:strings.launch,onSelect:()=>{switchScreen('play');onAction();}},
        {label:strings.settings,onSelect:showSettings},
        {label:strings.help,onSelect:help}
      ]});
  }
  function pauseMenu(){
    return new Menu({title:strings.paused,anchor:anchor('bottom'),margin:menuMargin(),width:menuWidth(),padding:12,
      gap:6,items:[{label:strings.resume,onSelect:()=>switchScreen('play')},{label:strings.settings,onSelect:showSettings},
        {label:strings.end,onSelect:endDive}]});
  }
  function settings(){
    return frame({label:strings.settings,width:menuWidth(),anchor:anchor('bottom'),margin:menuMargin(),children:[
      new Label({text:strings.settings,size:'large'}),
      new Toggle({text:strings.contrast,checked:contrast,onChange:event=>{contrast=event.value;applyPreferences();}}),
      new Toggle({text:strings.motion,checked:motion,onChange:event=>{motion=event.value;applyPreferences();}}),
      new Slider({text:strings.typeSize,min:1,max:1.35,step:.05,value:ui.textScale,format:value=>number(Math.round(value*100))+'%',
        onChange:event=>{ui.textScale=event.value;}}),
      action(strings.language,toggleLanguage,'secondary',{description:strings.languageTitle}),
      action(strings.back,()=>switchScreen(settingsFrom),'ghost')
    ]});
  }
  async function dialog(title,message,buttons){
    const invoking=ui.focused;
    const navigation=get('gallery').parentElement;
    const dialogWidth=Math.min(width()-18,492);
    const dialogPromise=ui.dialog({title,message,buttons,signal,width:dialogWidth});
    navigation.inert=true;
    const dialogWidget=ui.modalLayer.children.at(-1);
    if(rtl){
      const row=dialogWidget.children.at(-1);
      const total=row.children.length;
      if(total>1){
        const gap=10;
        const buttonWidth=Math.min(138,(dialogWidth-48-gap*(total-1))/total);
        row.children.forEach((button,index)=>button.setStyle({
          width:buttonWidth,minWidth:0,offset:[(total-1-2*index)*(buttonWidth+gap),0]
        }));
      }
    }
    try {
      return await dialogPromise;
    }catch(error){
      if(!signal.aborted)throw error;
    }finally{
      navigation.inert=ui.modalLayer.children.length!==0;
      if(invoking&&ui.inputMode==='keyboard')syncKeyboardFocus(invoking);
    }
  }
  const close=()=>[{label:strings.close,value:'close'}];
  const help=()=>void dialog(strings.helpTitle,strings.helpText,close());
  async function endDive(){
    const yes=await dialog(strings.endTitle,strings.endText,[
      {label:strings.stay,value:false},{label:strings.endYes,value:true,variant:'danger'}
    ]);
    if(yes)reset();
  }
  function reset(){
    station=0;
    battery=82;
    logged.clear();
    equipment=reserves();
    switchScreen('title');
  }
  const chargeText=()=>strings.charge+'  '+number(battery)+(rtl?'٪':'%');
  function instruments(){
    const site=zones[station];
    const depth=number(site.depth)+(rtl?' م':' m');
    const badge=new Label({text:strings.stations[station]+'  ·  '+depth,size:'large'});
    const rail=new HealthBar({label:strings.charge,max:100,value:battery,width:'fill',minHeight:8,height:8,smooth:false,display:'none'});
    const score=utility(strings.records+'  '+number(logged.size)+' / '+number(zones.length));
    batteryLabel=utility(chargeText());
    return frame({label:strings.stations[station],width:menuWidth(),anchor:anchor('top'),
      margin:menuMargin(),children:[badge,score,batteryLabel,rail]});
  }
  function controls(children){
    return new Panel({direction:'row',gap:6,children:rtl?[...children].reverse():children});
  }
  const halves=(text,onClick)=>action(text,onClick,'secondary',{grow:1,basis:0});
  function mission(){
    const complete=logged.size===zones.length;
    const canTravel=station<zones.length-1&&logged.has(station);
    const lead=complete?action(strings.finish,()=>switchScreen('complete'),'primary')
      :canTravel?action(strings.descend,()=>{station++;switchScreen('play');},'primary')
      :action(strings.survey,survey,'primary');
    return frame({width:menuWidth(),anchor:anchor('bottom'),margin:menuMargin(),children:[
      lead,controls([halves(strings.kit,()=>switchScreen('equipment')),halves(strings.log,showLog)]),
      action(strings.pause,()=>switchScreen('paused'),'ghost')
    ]});
  }
  function toolkit(){
    const slotSize=46,slotGap=7;
    const columns=menuWidth()-26>=6*slotSize+5*slotGap?6:3;
    bag=new Inventory({label:strings.kit,columns,slots:equipment.length,slotSize,slotGap,items:describeEquipment(),
      onSelect:({item})=>ui.announce(strings.held+' '+item.name),
      onMove:({from,index})=>{
        [equipment[from],equipment[index]]=[equipment[index],equipment[from]];
        slotNames();
        ui.announce(strings.moved);
        toData();
      },
      onUse:({index,item})=>useItem(index,item)
    });
    if(rtl){
      for(let i=0;i<bag.slots;i++){
        const col=i%columns;
        bag.slot(i).setStyle({offset:[(columns-1-2*col)*(slotSize+slotGap),0]});
      }
    }
    slotNames();
    return frame({label:strings.kit,width:menuWidth(),anchor:anchor('bottom'),margin:menuMargin(),children:[
      new Label({text:strings.kit,size:'large'}),utility(strings.kitIntro),bag,
      action(strings.back,()=>switchScreen('play'),'ghost')
    ]});
  }
  function useItem(index,item){
    if(item.id==='log'){
      showLog();
      return;
    }
    if(item.id!=='cell'){
      void dialog(item.name,item.description,close());
      return;
    }
    if(battery===100){
      notify(strings.full);
      return;
    }
    battery=Math.min(100,battery+28);
    equipment[index]=item.count>1?makeItem(item.id,item.count-1):null;
    bag.set(index,describeEquipment()[index]);
    slotNames();
    const meter=ui.root.children[0].children.find(widget=>widget instanceof HealthBar);
    meter.value=battery;
    batteryLabel.text=chargeText();
    notify(strings.recharge,'success');
    toData();
  }
  function showLog(){
    const report=zones.map(({depth},index)=>(logged.has(index)?'✓ ':'○ ')+strings.stations[index]+'  ·  '+number(depth)+(rtl?' م':' m')).join('\n');
    void dialog(strings.logTitle,report,close());
  }
  async function survey(){
    if(logged.has(station)){
      void dialog(strings.stations[station],strings.review,close());
      return;
    }
    if(battery<18){
      void dialog(strings.stations[station],strings.needCharge,close());
      return;
    }
    const selected=station;
    const yes=await dialog(strings.stations[selected],strings.detail[selected]+' '+strings.surveyCost,[
      {label:strings.record,value:true},{label:strings.cancel,value:false,variant:'ghost'}
    ]);
    if(!yes||logged.has(selected))return;
    const slot=equipment.findIndex(item=>!item);
    equipment[slot]=makeItem(zones[selected].sample);
    logged.add(selected);
    battery-=18;
    switchScreen('play');
    notify(logged.size===zones.length?strings.done:strings.siteLogged,'success');
  }
  function endScreen(){
    return frame({width:menuWidth(),anchor:anchor('bottom'),margin:menuMargin(),children:[
      new Label({text:strings.finished,size:'title'}),utility(strings.done),
      action(strings.log,showLog,'primary'),action(strings.back,reset,'ghost')
    ]});
  }
  function back(){
    if(screen==='play')switchScreen('paused');
    else if(screen==='paused'||screen==='equipment')switchScreen('play');
    else if(screen==='settings')switchScreen(settingsFrom);
    else if(screen==='complete')reset();
  }
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!event.defaultPrevented&&!event.repeat&&
      (document.activeElement===get('ocean')||document.activeElement.closest('[data-margo-ui=mirror]')))back();
  },{signal});
  applyPreferences();
  switchScreen('title',{focus:false});
  return {back,resize,data:()=>({screen,station,battery,rtl,locale})};
}
