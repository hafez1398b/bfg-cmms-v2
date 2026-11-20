import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const LEVEL_COLORS={0:0x254f6e,1:0x0e7c7b,2:0xe58b2a,3:0x727c88};
const KINDS={0:'تجهیز',1:'زیرسیستم',2:'قطعه اصلی',3:'زیرقطعه'};
const CONCEPT_LABEL='نمای مفهومی — نقشه مهندسی یا As-Built نیست';

function descendants(id,byId,out=new Set()){
  const node=byId.get(String(id));if(!node)return out;
  for(const child of node.children||[]){out.add(String(child));descendants(child,byId,out);}
  return out;
}

export function mount(host,scene,engineering,onSelect=()=>{}){
  if(!host||!scene?.rootId||!Array.isArray(scene.nodes))return{dispose(){}};
  host.replaceChildren();
  const toolbar=document.createElement('div');toolbar.className='bfg-3d-toolbar';
  const status=document.createElement('div');status.className='bfg-3d-status';status.setAttribute('role','status');
  const canvasWrap=document.createElement('div');canvasWrap.className='bfg-3d-canvas-wrap';
  const canvas=document.createElement('canvas');canvas.className='bfg-3d-canvas';canvas.setAttribute('aria-label',CONCEPT_LABEL);
  const info=document.createElement('div');info.className='bfg-3d-node-info';info.textContent='برای مشاهده جزئیات، یک گره را انتخاب کنید.';
  const btn=(text,action)=>{const b=document.createElement('button');b.type='button';b.className='btn btn-sm btn-ghost';b.textContent=text;b.onclick=action;return b;};
  const conceptual=btn('نمای مفهومی',()=>showMode('conceptual'));
  const engineeringButton=btn('مدل مهندسی تأییدشده',()=>showMode('engineering'));
  engineeringButton.disabled=!(engineering&&engineering.available);
  const zoomIn=btn('بزرگ‌نمایی +',()=>{camera.position.multiplyScalar(.84);controls.update();});
  const zoomOut=btn('کوچک‌نمایی −',()=>{camera.position.multiplyScalar(1.19);controls.update();});
  const collapse=btn('جمع‌کردن گره انتخاب‌شده',toggleCollapse);
  const explodeLabel=document.createElement('label');explodeLabel.className='bfg-3d-explode';explodeLabel.textContent='بازشدگی اجزا ';
  const explode=document.createElement('input');explode.type='range';explode.min='0';explode.max='100';explode.value='25';explode.setAttribute('aria-label','میزان بازشدگی ساختار');explodeLabel.append(explode);
  toolbar.append(conceptual,engineeringButton,zoomIn,zoomOut,collapse,explodeLabel);
  canvasWrap.append(canvas);host.append(toolbar,status,canvasWrap,info);

  let renderer,scene3d,camera,controls,conceptGroup,engineeringGroup,raf=0,disposed=false,selected=null,collapsed=new Set(),mode='conceptual';
  const byId=new Map(scene.nodes.map(node=>[String(node.id),node]));
  try{
    renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.setSize(Math.max(320,canvasWrap.clientWidth||640),380,false);
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    scene3d=new THREE.Scene();scene3d.background=new THREE.Color(0xf4f7f8);
    camera=new THREE.PerspectiveCamera(42,Math.max(320,canvasWrap.clientWidth||640)/380,.1,1000);camera.position.set(14,13,20);
    controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.target.set(0,2,0);controls.minDistance=5;controls.maxDistance=80;
    scene3d.add(new THREE.HemisphereLight(0xffffff,0x667788,2));
    const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(8,16,12);scene3d.add(light);
    conceptGroup=new THREE.Group();engineeringGroup=new THREE.Group();engineeringGroup.visible=false;scene3d.add(conceptGroup,engineeringGroup);
    const floor=new THREE.GridHelper(40,40,0xb0bec5,0xdce4e8);floor.position.y=-.2;scene3d.add(floor);
    const meshes=new Map(),labels=new Map(),lineMaterials=[];
    const pos=new Map();const childrenByParent=new Map();
    for(const node of scene.nodes){if(node.parentId){if(!childrenByParent.has(String(node.parentId)))childrenByParent.set(String(node.parentId),[]);childrenByParent.get(String(node.parentId)).push(node);}}
    for(const list of childrenByParent.values())list.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    function layout(node,parentPosition=[0,0,0],siblingIndex=0,siblingCount=1){
      const level=Number(node.level)||0;
      let point;
      if(level===0)point=[0,0,0];
      else {
        const angle=(2*Math.PI*siblingIndex/Math.max(1,siblingCount))+(level*.35);
        const radius=level===1?5:level===2?2.4:1.55;
        point=[parentPosition[0]+Math.cos(angle)*radius,parentPosition[1]+(level===1?1.7:level===2?1.5:1.25),parentPosition[2]+Math.sin(angle)*radius];
      }
      pos.set(String(node.id),point);
      const siblings=childrenByParent.get(String(node.id))||[];
      siblings.forEach((child,index)=>layout(child,point,index,siblings.length));
    }
    const root=byId.get(String(scene.rootId));if(root)layout(root);
    const maxY=Math.max(5,...[...pos.values()].map(v=>v[1]));
    function makeLabel(node){
      const labelCanvas=document.createElement('canvas');labelCanvas.width=512;labelCanvas.height=96;
      const context=labelCanvas.getContext('2d');context.fillStyle='rgba(255,255,255,.92)';context.fillRect(0,0,512,96);
      context.fillStyle='#172b3a';context.font='bold 28px sans-serif';context.textAlign='center';context.direction='rtl';
      context.fillText(String(node.name||node.code||'گره ساختاری').slice(0,28),256,42);
      context.font='22px sans-serif';context.fillStyle='#526573';context.fillText(`${KINDS[node.level]||'ساختار'} · ${node.code||node.id}`,256,76);
      const texture=new THREE.CanvasTexture(labelCanvas);texture.colorSpace=THREE.SRGBColorSpace;
      const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false}));sprite.scale.set(3.8,.72,1);sprite.position.set(0,1.25,0);return sprite;
    }
    function makeGeometry(level){
      if(level===0)return new THREE.BoxGeometry(3.2,1.25,2.2);
      if(level===1)return new THREE.CylinderGeometry(.9,.9,1.25,8);
      if(level===2)return new THREE.BoxGeometry(1.65,1.05,1.35);
      return new THREE.IcosahedronGeometry(.63,0);
    }
    for(const node of scene.nodes){
      const level=Math.max(0,Math.min(3,Number(node.level)||0)),material=new THREE.MeshStandardMaterial({color:LEVEL_COLORS[level],roughness:.65,metalness:.12});
      const mesh=new THREE.Mesh(makeGeometry(level),material);mesh.userData.nodeId=String(node.id);mesh.position.fromArray(pos.get(String(node.id))||[0,0,0]);mesh.add(makeLabel(node));conceptGroup.add(mesh);meshes.set(String(node.id),mesh);
      if(node.parentId&&pos.has(String(node.parentId))){const points=[new THREE.Vector3(...(pos.get(String(node.parentId)))),new THREE.Vector3(...(pos.get(String(node.id))))];
        const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineDashedMaterial({color:0x82949e,dashSize:.22,gapSize:.14}));line.computeLineDistances();line.userData.parentId=String(node.parentId);line.userData.nodeId=String(node.id);conceptGroup.add(line);lineMaterials.push(line);}
    }
    function updateVisibility(){
      const hidden=new Set();for(const id of collapsed)for(const child of descendants(id,byId))hidden.add(child);
      for(const [id,mesh] of meshes){mesh.visible=!hidden.has(id);}
      for(const line of lineMaterials)line.visible=!hidden.has(line.userData.nodeId)&&!hidden.has(line.userData.parentId);
    }
    function applyExplode(){
      const factor=Number(explode.value)/100;
      for(const node of scene.nodes){const mesh=meshes.get(String(node.id)),base=pos.get(String(node.id));if(!mesh||!base)continue;
        const level=Number(node.level)||0;mesh.position.set(base[0]*(1+factor*level*.45),base[1]+factor*level*1.4,base[2]*(1+factor*level*.45));}
      for(const line of lineMaterials){const a=meshes.get(line.userData.parentId),b=meshes.get(line.userData.nodeId);if(!a||!b)continue;
        line.geometry.dispose();line.geometry=new THREE.BufferGeometry().setFromPoints([a.position,b.position]);line.computeLineDistances();}
    }
    explode.addEventListener('input',applyExplode);
    const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
    canvas.addEventListener('click',event=>{
      const rect=canvas.getBoundingClientRect();pointer.x=((event.clientX-rect.left)/rect.width)*2-1;pointer.y=-((event.clientY-rect.top)/rect.height)*2+1;
      raycaster.setFromCamera(pointer,camera);const hits=raycaster.intersectObjects(conceptGroup.children.filter(object=>object.isMesh),false);
      if(!hits.length)return;selected=String(hits[0].object.userData.nodeId);const node=byId.get(selected);if(!node)return;
      info.textContent=`${KINDS[node.level]||'گره ساختاری'}: ${node.name} · کد ${node.code||'ثبت نشده'} · Source ID ${node.sourceId||node.id}`;onSelect(node);}
    );
    function resize(){if(disposed)return;const width=Math.max(320,canvasWrap.clientWidth||640),height=380;camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height,false);}
    const observer=new ResizeObserver(resize);observer.observe(canvasWrap);
    function animate(){if(disposed)return;raf=requestAnimationFrame(animate);controls.update();renderer.render(scene3d,camera);}animate();resize();updateVisibility();applyExplode();
    status.textContent=CONCEPT_LABEL;
    let engineeringLoaded=false;
    async function showMode(next){
      if(next==='engineering'){
        if(!engineering?.available||!engineering.contentUrl){status.textContent='مدل مهندسی معتبر و تأییدشده در دسترس نیست.';return;}
        try{
          status.textContent='در حال دریافت مدل GLB تأییدشده…';
          if(!engineeringLoaded){const response=await fetch(engineering.contentUrl,{credentials:'same-origin'});if(!response.ok)throw Error('GLB_FETCH_FAILED');const buffer=await response.arrayBuffer();
            const gltf=await new GLTFLoader().parseAsync(buffer,'');engineeringGroup.add(gltf.scene);engineeringLoaded=true;}
          conceptGroup.visible=false;engineeringGroup.visible=true;mode='engineering';
          status.textContent=`مدل مهندسی تأییدشده · سند ${engineering.documentId} · Rev ${engineering.revision||'ثبت نشده'} · SHA-256 ${engineering.sha256}`;
        }catch(_){status.textContent='مدل GLB تأییدشده بارگذاری نشد؛ نمای مفهومی بدون تغییر باقی ماند.';engineeringGroup.visible=false;conceptGroup.visible=true;}
      }else{engineeringGroup.visible=false;conceptGroup.visible=true;mode='conceptual';status.textContent=CONCEPT_LABEL;}
    }
    function toggleCollapse(){if(!selected)return; if(collapsed.has(selected))collapsed.delete(selected);else collapsed.add(selected);updateVisibility();collapse.textContent=collapsed.has(selected)?'بازکردن گره انتخاب‌شده':'جمع‌کردن گره انتخاب‌شده';}
    return {dispose(){disposed=true;cancelAnimationFrame(raf);observer.disconnect();controls.dispose();renderer.dispose();conceptGroup.traverse(o=>{o.geometry?.dispose?.();if(o.material){if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material.dispose();}});engineeringGroup.traverse(o=>{o.geometry?.dispose?.();if(o.material){if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material.dispose();}});}};
  }catch(error){host.replaceChildren();const warning=document.createElement('p');warning.textContent='نمای سه‌بعدی در این مرورگر در دسترس نیست؛ داده ساختار تغییری نکرد.';host.append(warning);return{dispose(){}};}
}
