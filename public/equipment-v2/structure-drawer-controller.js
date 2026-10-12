/* Independent CRUD contracts for subsystem, main-component and sub-component drawers. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BFGStructureDrawerController=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';

  const PARENT_KINDS=Object.freeze({
    subsystem:['equipment','sub-equipment'],
    'main-component':['subsystem'],
    'sub-component':['main-component']
  });
  const FORM_FIELDS=Object.freeze({
    subsystem:[
      {id:'name',label:'نام',kind:'text',required:true,maxLength:240},
      {id:'code',label:'کد',kind:'text',maxLength:120},
      {id:'structureNotes',label:'شرح',kind:'textarea',maxLength:4000},
      {id:'manufacturer',label:'سازنده',kind:'text',maxLength:180},
      {id:'model',label:'مدل',kind:'text',maxLength:180},
      {id:'status',label:'وضعیت',kind:'select',required:true},
      {id:'crit',label:'بحرانیت',kind:'select'},
      {id:'technicalSpecification',label:'مشخصات فنی',kind:'textarea',maxLength:4000}
    ],
    'main-component':[
      {id:'name',label:'نام قطعه',kind:'text',required:true,maxLength:240},
      {id:'code',label:'کد یکتا',kind:'text',required:true,maxLength:120},
      {id:'componentType',label:'نوع قطعه',kind:'text',maxLength:240},
      {id:'brand',label:'برند',kind:'text',maxLength:180},
      {id:'manufacturer',label:'سازنده',kind:'text',maxLength:180},
      {id:'model',label:'مدل',kind:'text',maxLength:180},
      {id:'partNumber',label:'شماره فنی',kind:'text',maxLength:180},
      {id:'requiredQuantity',label:'تعداد',kind:'number',min:0,step:0.001},
      {id:'unit',label:'واحد شمارش',kind:'text',maxLength:40},
      {id:'structureNotes',label:'توضیحات',kind:'textarea',maxLength:4000},
      {id:'technicalSpecification',label:'مشخصات فنی',kind:'textarea',maxLength:4000},
      {id:'status',label:'وضعیت',kind:'select',required:true},
      {id:'crit',label:'بحرانیت',kind:'select'},
      {id:'inventoryItemId',label:'قلم انبار موجود',kind:'inventory'}
    ],
    'sub-component':[
      {id:'name',label:'نام زیرقطعه',kind:'text',required:true,maxLength:240},
      {id:'code',label:'کد',kind:'text',maxLength:120},
      {id:'partNumber',label:'شماره فنی',kind:'text',maxLength:180},
      {id:'requiredQuantity',label:'تعداد',kind:'number',min:0,step:0.001},
      {id:'unit',label:'واحد شمارش',kind:'text',maxLength:40},
      {id:'brand',label:'برند',kind:'text',maxLength:180},
      {id:'structureNotes',label:'توضیحات',kind:'textarea',maxLength:4000},
      {id:'technicalSpecification',label:'مشخصات فنی',kind:'textarea',maxLength:4000},
      {id:'status',label:'وضعیت',kind:'select',required:true},
      {id:'inventoryItemId',label:'قلم انبار موجود',kind:'inventory'}
    ]
  });
  const INPUT_FIELDS=Object.freeze({
    subsystem:['name','code','structureNotes','manufacturer','model','status','crit','technicalSpecification'],
    'main-component':['name','code','componentType','brand','manufacturer','model','partNumber','requiredQuantity','unit','structureNotes','technicalSpecification','status','crit','inventoryItemId'],
    'sub-component':['name','code','partNumber','requiredQuantity','unit','brand','structureNotes','technicalSpecification','status','inventoryItemId']
  });

  function clone(value){
    if(Array.isArray(value))return value.map(clone);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)]));
    return value;
  }
  function kindOf(node){return String(node&&(node.nodeKind||node.node_kind)||'equipment');}
  function isValidParent(kind,parent){
    if(!Object.prototype.hasOwnProperty.call(PARENT_KINDS,kind)||!parent||parent.archived||parent.is_active===false||parent.isActive===false||String(parent.status||'').toLowerCase()==='archived')return false;
    return PARENT_KINDS[kind].includes(kindOf(parent));
  }
  function formFields(kind){return FORM_FIELDS[kind]||[];}
  function normalizeValue(value){return value==null?'':String(value);}
  function validate(kind,values={}){
    const errors=[];
    if(!String(values.name||'').trim())errors.push('name');
    if(!String(values.status||'').trim())errors.push('status');
    if(kind==='main-component'&&!String(values.code||'').trim())errors.push('code');
    if(values.requiredQuantity!==''&&values.requiredQuantity!=null){
      const quantity=Number(values.requiredQuantity);
      if(!Number.isFinite(quantity)||quantity<0||quantity>1_000_000_000)errors.push('requiredQuantity');
    }
    return errors;
  }
  function cleanValues(kind,values={}){
    const allowed=new Set(INPUT_FIELDS[kind]||[]),result={};
    for(const [key,value] of Object.entries(values))if(allowed.has(key)){
      if(key==='requiredQuantity')result[key]=value===''||value==null?null:Number(value);
      else result[key]=typeof value==='string'?value.trim()||null:value;
    }
    return result;
  }
  function createPayload({rootEquipmentId,parent,kind,values,requestId}){
    if(!isValidParent(kind,parent))throw Object.assign(new Error('STRUCTURE_PARENT_KIND_INVALID'),{code:'STRUCTURE_PARENT_KIND_INVALID'});
    const parentRowVersion=Number(parent.rowVersion??parent.row_version);
    if(!Number.isInteger(parentRowVersion)||parentRowVersion<1)throw Object.assign(new Error('ROW_VERSION_REQUIRED'),{code:'ROW_VERSION_REQUIRED'});
    if(!rootEquipmentId)throw Object.assign(new Error('ROOT_EQUIPMENT_NOT_FOUND'),{code:'ROOT_EQUIPMENT_NOT_FOUND'});
    if(!requestId)throw Object.assign(new Error('IDEMPOTENCY_KEY_REQUIRED'),{code:'IDEMPOTENCY_KEY_REQUIRED'});
    return{...cleanValues(kind,values),rootEquipmentId:String(rootEquipmentId),nodeKind:kind,parentId:String(parent.id),parentRowVersion,requestId:String(requestId)};
  }
  function updatePayload({rootEquipmentId,node,kind,values}){
    if(!node||String(node.nodeKind||node.node_kind)!==kind)throw Object.assign(new Error('STRUCTURE_NODE_KIND_INVALID'),{code:'STRUCTURE_NODE_KIND_INVALID'});
    const rowVersion=Number(node.rowVersion??node.row_version);
    if(!Number.isInteger(rowVersion)||rowVersion<1)throw Object.assign(new Error('ROW_VERSION_REQUIRED'),{code:'ROW_VERSION_REQUIRED'});
    return{...cleanValues(kind,values),rootEquipmentId:String(rootEquipmentId||node.rootEquipmentId||''),nodeKind:kind,rowVersion};
  }
  function stableStringify(value){
    if(Array.isArray(value))return`[${value.map(stableStringify).join(',')}]`;
    if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function newRequestId(cryptoObject=typeof crypto!=='undefined'?crypto:null){
    if(cryptoObject&&typeof cryptoObject.randomUUID==='function')return cryptoObject.randomUUID();
    if(cryptoObject&&typeof cryptoObject.getRandomValues==='function'){
      const bytes=new Uint8Array(16);cryptoObject.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
      const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
      return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
    return`eqs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  function create(options={}){
    const state={open:false,mode:null,kind:null,parent:null,node:null,values:{},initialValues:{},dirty:false,saving:false,error:null,saved:null,requestId:null,requestFingerprint:null,closeReason:null};
    const changed=()=>{if(typeof options.onStateChange==='function')options.onStateChange(state);};
    function open(config={}){
      if(state.saving||state.open)return false;
      const values=clone(config.values||{});
      Object.assign(state,{open:true,mode:config.mode||'create',kind:config.kind||null,parent:config.parent||null,node:config.node||null,
        values,initialValues:clone(values),dirty:false,saving:false,error:null,saved:null,requestId:null,requestFingerprint:null,closeReason:null});
      changed();return true;
    }
    function setValues(values={}){
      if(!state.open||state.saving)return false;
      state.values=clone(values);
      state.dirty=stableStringify(state.values)!==stableStringify(state.initialValues);
      state.error=null;changed();return true;
    }
    function requestIdFor(fingerprint,cryptoObject){
      const key=String(fingerprint||stableStringify(state.values));
      if(!state.requestId||state.requestFingerprint!==key){state.requestId=newRequestId(cryptoObject);state.requestFingerprint=key;}
      return state.requestId;
    }
    async function close(reason='cancel'){
      if(!state.open||state.saving)return false;
      if(state.dirty&&typeof options.confirmDiscard==='function'){
        const allowed=await options.confirmDiscard({reason,state});
        if(!allowed)return false;
      }
      state.open=false;state.closeReason=reason;changed();
      if(typeof options.onClose==='function')await options.onClose({reason,state});
      return true;
    }
    async function submit({payload,save,expectedStatus=201,validationErrors=null}={}){
      if(!state.open||state.saving)return false;
      const errors=Array.isArray(validationErrors)?validationErrors:validate(state.kind,state.values);
      if(errors.length){state.error={code:'VALIDATION_ERROR',fields:errors};changed();return false;}
      if(typeof save!=='function')throw new Error('STRUCTURE_DRAWER_SAVE_REQUIRED');
      state.saving=true;state.error=null;changed();
      let result;
      try{
        result=await save(payload);
        const status=Number(result&&(result.httpStatus??result.status));
        if(status!==Number(expectedStatus))throw Object.assign(new Error('UNEXPECTED_RESPONSE_STATUS'),{code:'UNEXPECTED_RESPONSE_STATUS',status,payload:result});
        if(result.committed!==true||!result.data||!result.data.id)throw Object.assign(new Error('NOT_COMMITTED'),{code:'NOT_COMMITTED',payload:result});
      }catch(error){state.saving=false;state.error=error;changed();if(typeof options.onSaveError==='function')options.onSaveError(error,state);return false;}
      state.saving=false;state.saved=result;state.open=false;state.closeReason='saved';changed();
      if(typeof options.onSaveSuccess==='function')await options.onSaveSuccess(result,state);
      return true;
    }
    return{state,open,setValues,requestIdFor,close,submit};
  }

  return{PARENT_KINDS,FORM_FIELDS,INPUT_FIELDS,formFields,kindOf,isValidParent,validate,cleanValues,createPayload,updatePayload,newRequestId,stableStringify,create};
});
