/* PostgreSQL-only Equipment Registry adapter. UI preferences may use session state;
   equipment records are never read from or written to browser storage. */
(function(){
  'use strict';

  const hasSession=()=>Boolean(window.BFGBackend&&window.BFGBackend.user);
  async function api(path,options={}){
    if(!hasSession())throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});
    if(typeof window.bfgApi==='function')return window.bfgApi('/api/equipment'+path,options);
    const headers={'Content-Type':'application/json',...(options.headers||{})};
    const method=String(options.method||'GET').toUpperCase();
    if(!['GET','HEAD','OPTIONS'].includes(method)){
      const csrf=String(document.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('bfg_csrf='));
      if(csrf)headers['x-csrf-token']=decodeURIComponent(csrf.slice('bfg_csrf='.length));
    }
    const response=await fetch('/api/equipment'+path,{...options,headers,credentials:'same-origin'});
    if(!response.ok){
      const payload=await response.json().catch(()=>({}));
      throw Object.assign(new Error(payload.error||`HTTP ${response.status}`),{status:response.status,payload});
    }
    return response.json();
  }

  const remote={
    source:'postgresql',
    feature:()=>api('/feature'),
    filters:()=>api('/filters'),
    list:query=>api('/?'+new URLSearchParams(Object.entries(query||{}).filter(([,value])=>value!==''&&value!=null))),
    tree:query=>api('/tree?'+new URLSearchParams(Object.entries(query||{}).filter(([,value])=>value!==''&&value!=null))),
    get:id=>api('/'+encodeURIComponent(id)),
    create:data=>api('/',{method:'POST',body:JSON.stringify(data)}),
    update:(id,data)=>api('/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(data)}),
    move:(id,data)=>api('/'+encodeURIComponent(id)+'/move',{method:'POST',body:JSON.stringify(data)}),
    remove:(id,reason,rowVersion)=>api('/'+encodeURIComponent(id),{
      method:'DELETE',body:JSON.stringify({reason,rowVersion})
    }),
    structure:(id,options)=>api('/'+encodeURIComponent(id)+'/structure'+(options&&options.includeArchived?'?includeArchived=true':'')),
    structureCreate:data=>api('/',{method:'POST',body:JSON.stringify(data)}),
    structureUpdate:(id,data)=>api('/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(data)}),
    structureMove:(id,data)=>api('/'+encodeURIComponent(id)+'/move',{method:'POST',body:JSON.stringify(data)}),
    structureArchive:(id,reason,rowVersion)=>api('/'+encodeURIComponent(id),{
      method:'DELETE',body:JSON.stringify({reason,rowVersion})
    }),
    structureRestore:(id,data)=>api('/'+encodeURIComponent(id)+'/restore',{method:'POST',body:JSON.stringify(data)}),
    structureSuggestions:id=>api('/'+encodeURIComponent(id)+'/structure/suggestions',{method:'POST',body:'{}'}),
    inventoryItems:q=>api('/inventory-items?'+new URLSearchParams(q?{q}:{})),
    actionConfirm:id=>api('/actions/drafts/'+encodeURIComponent(id)+'/confirm',{method:'POST',body:'{}'}),
    actionExecute:(id,data)=>api('/actions/drafts/'+encodeURIComponent(id)+'/execute',{method:'POST',body:JSON.stringify(data)}),
    actionReject:id=>api('/actions/drafts/'+encodeURIComponent(id)+'/reject',{method:'POST',body:'{}'})
  };
  const unavailable={
    source:'server-required',
    async feature(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async filters(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async list(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async tree(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async get(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async create(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async update(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async move(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async remove(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async structure(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async structureCreate(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async structureUpdate(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async structureMove(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async structureArchive(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async structureRestore(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async structureSuggestions(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async inventoryItems(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async actionConfirm(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async actionExecute(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});},
    async actionReject(){throw Object.assign(new Error('SERVER_REQUIRED'),{status:503});}
  };
  window.EquipmentRepository={
    mode:hasSession()?'postgresql':'server-required',
    current(){return hasSession()?remote:unavailable;},
    remote
  };
})();
