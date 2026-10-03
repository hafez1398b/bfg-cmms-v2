/* Shared backend session and authorized realtime client. */
(function(){
  'use strict';
  const state=window.BFGBackend={mode:'initializing',config:null,user:null,realtime:null};
  const token=()=>sessionStorage.getItem('bfg_token');
  async function api(path,options={}){
    const headers={...(options.headers||{})};if(token())headers.authorization='Bearer '+token();
    if(options.body&&!(options.body instanceof FormData)&&!headers['content-type'])headers['content-type']='application/json';
    const response=await fetch(path,{...options,headers});
    let payload=null;try{payload=await response.json();}catch(_){}
    if(!response.ok){const error=new Error(payload?.message||payload?.error||`HTTP ${response.status}`);error.status=response.status;error.payload=payload;throw error;}
    return payload;
  }
  window.bfgApi=api;

  function enterApplication(user){
    let shellUser=(DB.users||[]).find(x=>x.id===user.id||x.u===user.username);
    if(!shellUser){shellUser={id:user.id,u:user.username,name:user.name,role:user.role,unit:user.unit,active:true,backendIdentity:true};DB.users.push(shellUser);}
    Object.assign(shellUser,{name:user.name,role:user.role,unit:user.unit||shellUser.unit,active:true});
    ME=shellUser;state.user=user;state.mode='backend';sessionStorage.setItem('bfg_me',shellUser.id);
    document.getElementById('loginPage').style.display='none';document.getElementById('app').style.display='block';
    document.getElementById('uName').textContent=ME.name;document.getElementById('uRole').textContent=ROLES[ME.role]||ME.role;document.getElementById('uAvatar').textContent=ME.name[0];
    buildMenu();go('dash');updateBadge();connectRealtime();
  }

  function connectRealtime(){
    if(!token()||typeof io!=='function')return;
    try{state.realtime?.disconnect();}catch(_){}
    state.realtime=io({auth:{token:token()},transports:['websocket','polling']});
    state.realtime.on('realtime:ready',()=>{document.documentElement.dataset.realtime='connected';});
    state.realtime.on('disconnect',()=>{document.documentElement.dataset.realtime='disconnected';});
    state.realtime.on('domain:event',event=>{
      window.dispatchEvent(new CustomEvent('bfg:domain-event',{detail:event}));
      if(event.type==='notification.created'&&typeof toast==='function')toast('🔔 '+(event.payload?.title||'اعلان جدید'));
      if(event.aggregateType==='equipment'&&CUR==='tree'&&typeof eqv2Load==='function')eqv2Load();
    });
  }

  const localLogin=window.doLogin;
  window.doLogin=async function(){
    const username=document.getElementById('loginUser').value.trim(),password=document.getElementById('loginPass').value;
    try{
      const result=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username,password})});
      sessionStorage.setItem('bfg_token',result.token);enterApplication(result.user);
    }catch(error){
      if(state.config?.allowLocalCompatibility&&typeof localLogin==='function'){
        state.mode='local-compatibility';localLogin();
        if(ME&&typeof toast==='function')toast('⚠️ حالت توسعه محلی؛ Backend/PostgreSQL در دسترس نیست',1);
      }else if(typeof toast==='function')toast('ورود Backend ناموفق: '+error.message,1);
    }
  };
  const localLogout=window.logout;
  window.logout=function(){sessionStorage.removeItem('bfg_token');state.realtime?.disconnect();if(typeof localLogout==='function')localLogout();else location.reload();};

  async function restoreBackend(){
    try{
      state.config=await fetch('/api/runtime-config').then(r=>r.json());
      if(token()){const result=await api('/api/auth/me');enterApplication(result.user);}
      else state.mode=state.config.allowLocalCompatibility?'local-compatibility':'backend-required';
    }catch(_){state.config={allowLocalCompatibility:true};state.mode='local-compatibility';}
  }
  restoreBackend();
})();
