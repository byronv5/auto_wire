import { App } from './state.js';

/* ===== 符号库匹配与处理 ===== */
export function addToMapList(map,key,rec){ 
  if(!key) return; 
  const arr=map.get(key)||[]; 
  arr.push(rec); 
  map.set(key,arr); 
}

export function norm(s){ 
  return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,''); 
}

export function aliasNorms(s){
  const n=norm(s); 
  const S=new Set([n]);
  if(n.startsWith('at')) S.add(n.slice(2));
  if(n.endsWith('a')) S.add(n.slice(0,-1));
  if(/^(hdr1x)(\d+)$/.test(n)) S.add('header'+RegExp.$2);
  if(/^header(\d+)$/.test(n)) S.add('hdr1x'+RegExp.$1);
  if(n.includes('uln2003')) S.add('uln2003');
  if(n.includes('89c51')){ S.add('89c51'); S.add('at89c51'); }
  if(n.includes('hc49s')) S.add('crystal');
  if(n.includes('component1')) S.add('component_1');
  if(n.includes('component_1')) S.add('component1');
  if(n.includes('step')&&n.includes('motor')){ S.add('hdr1x5'); S.add('header5'); }
  return [...S];
}

export function allDistinctRecs(){ 
  const set=new Set(); 
  for(const arr of App.lib.values()) arr.forEach(r=>set.add(r)); 
  return [...set]; 
}

export function libCount(){ 
  return allDistinctRecs().length; 
}

function collectCandidatesByKey(key){
  if(!key) return [];
  const arr1=App.lib.get(key)||[];
  const arr2=App.lib.get(key.toUpperCase())||[];
  const arr3=App.libNorm.get(norm(key))||[];
  const arr4=aliasNorms(key).flatMap(k=>App.libNorm.get(k)||[]);
  return [...new Set([...arr1,...arr2,...arr3,...arr4])];
}

function collectCandidatesByValue(val){
  if(!val) return []; 
  const v=String(val); 
  const arr=collectCandidatesByKey(v); 
  if(arr.length) return arr;
  const pool=allDistinctRecs(); 
  const nv=norm(v);
  return pool.filter(r=>{ 
    const keys=[r.key,r.fileBase,...aliasNorms(r.key),...aliasNorms(r.fileBase)].map(norm); 
    return keys.some(k=>k.includes(nv)||nv.includes(k)); 
  });
}

export function expectedPinCount(ref){
  const s=new Set(); 
  (App.plan.nets||[]).forEach(n=>(n.nodes||[]).forEach(nd=>{ 
    if(nd.ref===ref) s.add(String(nd.pin||'')); 
  })); 
  return s.size||0;
}

export function expectedPinNumbers(ref){
  const s=new Set(); 
  (App.plan.nets||[]).forEach(n=>{ 
    (n.nodes||[]).forEach(nd=>{ 
      if(nd.ref===ref) s.add(String(nd.pin)); 
    }); 
  }); 
  return [...s];
}

function pickBestByPins(cands,need){
  if(!cands||!cands.length) return null;
  if(cands.length===1) return cands[0];
  const scored=cands.map(r=>({r,score:Math.abs(((r.pins?.length)||0)-need)})); 
  scored.sort((a,b)=>a.score-b.score);
  return scored[0].r;
}

export function pickSymbol(c){
  const need=expectedPinCount(c.ref);
  if(c.symbolKey){ 
    const byKey=pickBestByPins(collectCandidatesByKey(c.symbolKey),need); 
    if(byKey) return byKey; 
  }
  const byVal=pickBestByPins(collectCandidatesByValue(c.value),need); 
  if(byVal) return byVal;
  return null;
}

export function genPlaceholder(comp){
  const pinNumsRaw=expectedPinNumbers(comp.ref);
  const count=Math.max(pinNumsRaw.length,8);
  const numeric=pinNumsRaw.filter(p=>/^\d+$/.test(p)).map(p=>Number(p)).sort((a,b)=>a-b).map(String);
  const nonNum=pinNumsRaw.filter(p=>!(/^\d+$/.test(p)));
  const orderedPins=[...numeric,...nonNum];
  while(orderedPins.length<count) orderedPins.push(String(orderedPins.length+1));
  const rows=Math.ceil(count/2);
  const h=Math.max(rows*15+30,80), w=140;
  const leftPins=orderedPins.slice(0,rows);
  const rightPins=orderedPins.slice(rows);
  const pins=[];
  for(let i=0;i<leftPins.length;i++){ 
    const y=15+i*((h-30)/Math.max(1,rows-1)); 
    pins.push({number:leftPins[i],name:'',x:0,y}); 
  }
  for(let i=0;i<rightPins.length;i++){ 
    const y=15+i*((h-30)/Math.max(1,rows-1)); 
    pins.push({number:rightPins[i],name:'',x:w,y}); 
  }
  const vb=`0 0 ${w} ${h}`;
  const meta=JSON.stringify({
    format:"EDA-SmartSymbol-1.0",
    component:{lib_reference:"__placeholder__",anchor_schema:"pin",pins}
  });
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">
    <rect x="10" y="5" width="${w-20}" height="${h-10}" fill="#FEFBCB" stroke="#8B0000"/>
    ${pins.map(p=>'<g class="connection-point" data-pin-number="'+p.number+'" data-x="'+p.x+'" data-y="'+p.y+'"><circle cx="'+p.x+'" cy="'+p.y+'" r="0.6" fill="transparent"/></g>').join('')}
    <metadata id="eda-meta">${meta}</metadata>
  </svg>`;
  return {key:'__placeholder__', label:'placeholder', svgText:svg, viewBox:vb, w, h, pins};
}

export function prefixIDs(root,prefix){
  const idMap=new Map();
  root.querySelectorAll('[id]').forEach(el=>{ 
    const old=el.getAttribute('id'); 
    const neo=prefix+old; 
    idMap.set(old,neo); 
    el.setAttribute('id',neo); 
  });
  const attrs=['fill','stroke','filter','clip-path','mask','marker-start','marker-mid','marker-end','href','xlink:href'];
  root.querySelectorAll('*').forEach(el=>{
    attrs.forEach(a=>{
      const val=el.getAttribute(a); 
      if(!val) return; 
      let v=val;
      idMap.forEach((neo,old)=>{ 
        v=v.replace(new RegExp('url\\(#'+old+'\\)','g'),'url(#'+neo+')'); 
        if((a==='href'||a==='xlink:href')&&v==='#'+old) v='#'+neo; 
      });
      if(v!==val) el.setAttribute(a,v);
    });
  });
}