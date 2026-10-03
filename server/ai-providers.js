'use strict';

class AIProviderError extends Error {
  constructor(code,message,status=502){super(message);this.name='AIProviderError';this.code=code;this.status=status;}
}

function timeoutSignal(ms){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),ms);
  timer.unref?.();
  return {signal:controller.signal,clear:()=>clearTimeout(timer)};
}

function parseOpenAIText(body){
  const content=body?.choices?.[0]?.message?.content;
  if(typeof content==='string')return content;
  if(Array.isArray(content))return content.map(x=>x.text||'').join('');
  throw new AIProviderError('INVALID_PROVIDER_RESPONSE','Provider returned no message content');
}

async function requestJson(url,options,timeoutMs){
  const timeout=timeoutSignal(timeoutMs);
  try{
    const response=await fetch(url,{...options,signal:timeout.signal});
    const text=await response.text();
    let body;try{body=text?JSON.parse(text):{};}catch(_){throw new AIProviderError('INVALID_PROVIDER_JSON',`Provider returned invalid JSON (${response.status})`);}
    if(!response.ok)throw new AIProviderError('PROVIDER_HTTP_ERROR',`Provider request failed (${response.status}): ${String(body?.error?.message||body?.message||'').slice(0,240)}`,response.status===429?429:502);
    return body;
  }catch(error){
    if(error.name==='AbortError')throw new AIProviderError('PROVIDER_TIMEOUT','AI provider timeout',504);
    if(error instanceof AIProviderError)throw error;
    throw new AIProviderError('PROVIDER_UNREACHABLE',error.message||'AI provider unavailable');
  }finally{timeout.clear();}
}

function openAIContent(input){
  const content=[{type:'text',text:input.prompt}];
  for(const media of input.media||[]){
    if(media.kind==='image')content.push({type:'image_url',image_url:{url:`data:${media.mimeType};base64,${media.data}`}});
    else content.push({type:'text',text:`[${media.kind} attachment ${media.mimeType}; this provider may not support direct decoding]`});
  }
  return content;
}

class OpenAICompatibleProvider {
  constructor({name,baseUrl,apiKey,model,timeoutMs,vision=false}){this.name=name;this.baseUrl=String(baseUrl||'').replace(/\/$/,'');this.apiKey=apiKey;this.model=model;this.timeoutMs=timeoutMs;this.vision=vision;}
  configured(){return !!(this.baseUrl&&this.model&&(this.name==='local'||this.apiKey));}
  capabilities(){return {text:true,image:this.vision,audio:false,search:false,structured:true};}
  async generate(input){
    if(!this.configured())throw new AIProviderError('PROVIDER_NOT_CONFIGURED',`${this.name} is not configured`,503);
    if((input.media||[]).some(x=>x.kind==='image')&&!this.vision)throw new AIProviderError('CAPABILITY_UNAVAILABLE',`${this.name} model does not support image input`,422);
    if((input.media||[]).some(x=>x.kind==='audio'))throw new AIProviderError('CAPABILITY_UNAVAILABLE',`${this.name} does not support audio input`,422);
    const headers={'content-type':'application/json'};if(this.apiKey)headers.authorization=`Bearer ${this.apiKey}`;
    const body=await requestJson(`${this.baseUrl}/chat/completions`,{method:'POST',headers,body:JSON.stringify({
      model:this.model,temperature:0.1,response_format:{type:'json_object'},messages:[
        {role:'system',content:input.system},{role:'user',content:openAIContent(input)}
      ]
    })},this.timeoutMs);
    return {text:parseOpenAIText(body),model:body.model||this.model,usage:body.usage||null,providerRequestId:body.id||null};
  }
}

class GeminiProvider {
  constructor({apiKey,model,baseUrl,timeoutMs,searchEnabled}){this.name='gemini';this.apiKey=apiKey;this.model=model;this.baseUrl=String(baseUrl||'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/,'');this.timeoutMs=timeoutMs;this.searchEnabled=searchEnabled;}
  configured(){return !!(this.apiKey&&this.model);}
  capabilities(){return {text:true,image:true,audio:true,search:this.searchEnabled,structured:true};}
  async generate(input){
    if(!this.configured())throw new AIProviderError('PROVIDER_NOT_CONFIGURED','Gemini is not configured',503);
    const parts=[{text:input.prompt}];
    for(const media of input.media||[])parts.push({inlineData:{mimeType:media.mimeType,data:media.data}});
    const request={systemInstruction:{parts:[{text:input.system}]},contents:[{role:'user',parts}],generationConfig:{temperature:0.1,responseMimeType:'application/json'}};
    if(input.useSearch&&this.searchEnabled)request.tools=[{googleSearch:{}}];
    const body=await requestJson(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)},this.timeoutMs);
    const text=(body.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
    if(!text)throw new AIProviderError('INVALID_PROVIDER_RESPONSE','Gemini returned no content');
    return {text,model:body.modelVersion||this.model,usage:body.usageMetadata||null,groundingMetadata:body.candidates?.[0]?.groundingMetadata||null,providerRequestId:body.responseId||null};
  }
}

function createProviderRegistry(env=process.env){
  const timeoutMs=Math.min(120000,Math.max(5000,Number(env.AI_TIMEOUT_MS)||45000));
  const providers={
    local:new OpenAICompatibleProvider({name:'local',baseUrl:env.LOCAL_AI_BASE_URL,apiKey:env.LOCAL_AI_API_KEY,model:env.LOCAL_AI_MODEL,timeoutMs,vision:env.LOCAL_AI_VISION==='true'}),
    deepseek:new OpenAICompatibleProvider({name:'deepseek',baseUrl:env.DEEPSEEK_BASE_URL||'https://api.deepseek.com',apiKey:env.DEEPSEEK_API_KEY,model:env.DEEPSEEK_MODEL||'deepseek-chat',timeoutMs,vision:env.DEEPSEEK_VISION==='true'}),
    gemini:new GeminiProvider({apiKey:env.GEMINI_API_KEY,model:env.GEMINI_MODEL||'gemini-3.5-flash',baseUrl:env.GEMINI_BASE_URL,timeoutMs,searchEnabled:env.GEMINI_SEARCH_ENABLED==='true'})
  };
  return {
    providers,
    status(){return Object.fromEntries(Object.entries(providers).map(([key,p])=>[key,{configured:p.configured(),capabilities:p.capabilities(),model:p.model} ]));},
    order({media=[],useSearch=false,purpose='analysis',preferred}){
      const hasAudio=media.some(x=>x.kind==='audio'),hasImage=media.some(x=>x.kind==='image');
      const primary=preferred||(hasAudio||hasImage||useSearch?'gemini':'deepseek');
      // Approved failover policy: specialist primary -> DeepSeek -> on-premise Local AI.
      // Duplicates are removed while preserving order. An incapable provider is skipped,
      // never asked to pretend it processed media/search that it cannot understand.
      return [...new Set([primary,'deepseek','local'])];
    },
    candidates(input={}){
      const media=input.media||[],hasAudio=media.some(x=>x.kind==='audio'),hasImage=media.some(x=>x.kind==='image'),useSearch=!!input.useSearch;
      return this.order(input).map(name=>providers[name]).filter(provider=>provider?.configured()&&(!hasAudio||provider.capabilities().audio)&&(!hasImage||provider.capabilities().image)&&(!useSearch||provider.capabilities().search));
    },
    select(input={}){
      const selected=this.candidates(input)[0];
      if(!selected)throw new AIProviderError('NO_CAPABLE_PROVIDER','No configured provider supports this request',503);
      return selected;
    }
  };
}

module.exports={AIProviderError,OpenAICompatibleProvider,GeminiProvider,createProviderRegistry};
