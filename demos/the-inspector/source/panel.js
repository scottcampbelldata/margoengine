const panelStyle=String.raw`
:host{color:#ebeedb;font:13px/1.4 "Segoe UI",Arial,sans-serif}
section{background:#203a3a;border-color:#54706a;border-radius:0;max-height:570px!important}
h2{font:400 1.37rem Georgia,serif;border-color:#54706a;padding:12px 13px}
h2{letter-spacing:0}
fieldset,details{border-color:#45625e}
fieldset.bar button{background:#284945;border-color:#66827b;color:inherit;border-radius:2px;min-height:31px}
input[type=text],input[type=number]{color:#eef0df;background:#294744;border:1px solid #66827b;padding:3px 5px;border-radius:2px}
input[type=range],input[type=checkbox]{accent-color:#9ccbbb}
.status:empty{display:none}.status{color:#a8ccbd}
.row{min-height:30px}
[role=tree]{max-height:180px}
[aria-selected=true]>.row{background:#9ccbbb;color:#1f3c39}
fieldset:has(input[data-property="wireframe"]){display:none}
fieldset:has(input[data-property="exposure"]:disabled){display:none}
details pre{color:#e8e8d6}
@media(max-width:780px){section{max-height:610px!important}}
`;

export function dockPanel(inspector,stats){
  Object.assign(inspector.element.style,{position:'relative',inset:'auto',width:'100%',maxWidth:'100%',maxHeight:'none',zIndex:'auto'});
  const style=document.createElement('style');
  style.textContent=panelStyle;
  inspector.root.append(style);
  const heading=inspector.root.querySelector('h2');
  if(heading)heading.textContent='Scene tree';
  Object.assign(stats.element.style,{position:'relative',inset:'auto',width:'100%',maxWidth:'100%',
    zIndex:'auto',background:'#203a3a',color:'#eef0df',borderColor:'#54706a',borderRadius:'0',
    padding:'10px 12px',fontSize:'.77rem'});
}

export function revealSelection(inspector){
  const tree=inspector.root.querySelector('[role=tree]');
  const row=tree?.querySelector('[aria-selected=true] > .row');
  if(!row)return;
  const bounds=tree.getBoundingClientRect(),focus=row.getBoundingClientRect();
  if(focus.bottom>bounds.bottom||focus.top<bounds.top)
    tree.scrollTop+=focus.top-bounds.top-bounds.height*.4;
}
