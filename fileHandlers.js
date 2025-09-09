import { App } from './state.js';
import { $, toast } from './utils.js';
import { allDistinctRecs, libCount, aliasNorms, addToMapList, norm } from './symbol.js';

/* ===== 库/网表处理 ===== */
export async function loadLibFilesFromDirectory() {
  try {
    // 通过后端API列出svglib目录的SVG文件（Express不会自动列目录）
    const response = await fetch('/api/svglib/list');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const svgFiles = Array.isArray(data.files) ? data.files : [];
    
    if (svgFiles.length === 0) {
      toast('svglib目录中没有找到SVG文件', 'warn');
      return;
    }
    
    // 为每个SVG文件创建File对象
    const files = await Promise.all(svgFiles.map(async (url) => {
      const response = await fetch(url);
      const blob = await response.blob();
      const fileName = url.split('/').pop();
      return new File([blob], fileName, { type: 'image/svg+xml' });
    }));
    
    // 使用现有的loadLibFiles函数处理这些文件
    await loadLibFiles(files);
    
  } catch (error) {
    console.error('从svglib目录加载SVG文件失败:', error);
    toast('从svglib目录加载SVG文件失败', 'err');
  }
}

export async function loadLibFiles(files){
  let ok=0, fail=0;
  for (const f of files) {
    try {
      const txt = await f.text();
      const dp = new DOMParser();
      const doc = dp.parseFromString(txt, 'image/svg+xml');
      const svgEl = doc.querySelector('svg');
      if (!svgEl) { fail++; continue; }

      const vbStr = (svgEl.getAttribute('viewBox') || '').trim();
      let vx = 0, vy = 0, w = 0, h = 0;
      if (vbStr) {
        const p = vbStr.split(/\s+/).map(Number);
        vx = p[0] || 0; vy = p[1] || 0; w = p[2]; h = p[3];
      } else {
        const ww = parseFloat((svgEl.getAttribute('width') || '100').replace(/px$/i,''));
        const hh = parseFloat((svgEl.getAttribute('height') || '60').replace(/px$/i,''));
        w = ww || 100; h = hh || 60;
      }

      const metaText = doc.querySelector('metadata#eda-meta')?.textContent?.trim();
      let meta = null;
      try { if (metaText) meta = JSON.parse(metaText); } catch {}

      let pins = [];
      if (Array.isArray(meta?.component?.pins)) {
        pins = meta.component.pins.map(p => ({
          number: String(p.number ?? p.display_number ?? ''),
          name: String(p.name ?? ''),
          x: Number(p.x) - vx,
          y: Number(p.y) - vy
        })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      }
      if (!pins.length) {
        const cps = [...doc.querySelectorAll('.connection-point,[role="connection-point"]')];
        pins = cps.map(cp => {
          const cx = Number(cp.getAttribute('data-x') || cp.querySelector('circle')?.getAttribute('cx') || NaN) - vx;
          const cy = Number(cp.getAttribute('data-y') || cp.querySelector('circle')?.getAttribute('cy') || NaN) - vy;
          return {
            number: String(cp.getAttribute('data-pin-number') || ''),
            name: String(cp.getAttribute('data-pin-name') || ''),
            x: cx, y: cy
          };
        }).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      }

      let key = f.name.replace(/\.[a-z0-9]+$/i,'');
      if (meta?.component?.lib_reference) key = String(meta.component.lib_reference);

      const rec = {
        key,
        label: `${key} (${f.name})`,
        svgText: txt,
        viewBox: vbStr || `0 0 ${w} ${h}`,
        w, h,
        pins: Array.isArray(pins) ? pins : [],
        fileBase: f.name.replace(/\.[a-z0-9]+$/i,'')
      };

      addToMapList(App.lib, key, rec);
      if (rec.fileBase !== key) addToMapList(App.lib, rec.fileBase, rec);
      aliasNorms(key).forEach(k => addToMapList(App.libNorm, k, rec));
      aliasNorms(rec.fileBase).forEach(k => addToMapList(App.libNorm, k, rec));
      ok++;
    } catch (e) {
      console.warn('解析库失败:', f.name, e);
      fail++;
    }
  }
  $('#lib-count').textContent = String(libCount());
  toast(`库载入成功 ${ok} 个，失败 ${fail} 个`, ok ? 'ok' : 'warn');
}

export function tryParseJSON(txt){ 
  try{ 
    const js=JSON.parse(txt); 
    if(Array.isArray(js.components)&&Array.isArray(js.nets)) return js; 
    if(js?.plan&&Array.isArray(js.plan.components)) return js.plan; 
  }catch{} 
  return null; 
}

export function parseProtelNET(txt){
  const comps=[], nets=[];
  const compRe = /\[\s*([\s\S]*?)\s*\]/g;
  let m;
  while((m = compRe.exec(txt)) !== null){
    const lines = m[1].split(/\r?\n/).map(s => s.trim());
    if(!lines[0]) continue;
    const ref = lines[0] || ''; 
    const symbolKey = lines[1] || ''; 
    const value = lines[2] || ''; 
    comps.push({ref, value, symbolKey});
  }
  const netRe = /\(\s*([\s\S]*?)\s*\)/g;
  while((m = netRe.exec(txt)) !== null){
    const lines = m[1].split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if(!lines.length) continue;
    const name = lines[0];
    const nodes = lines.slice(1).map(s => { 
      const mm = s.match(/^([^-\s]+)-(.+)$/); 
      return mm ? {ref: mm[1], pin: mm[2]} : null; 
    }).filter(Boolean);
    nets.push({name, nodes});
  }
  return {components: comps, nets};
}

export function importNetlistFromText(txt){
  const plan=tryParseJSON(txt)||parseProtelNET(txt);
  if(!plan||!plan.components||!plan.nets){ 
    toast('网表解析失败，格式无法识别','err'); 
    return; 
  }
  App.plan={components:plan.components||[], nets:plan.nets||[]};
  refreshPlanView(); 
  showValidation(validatePlan());
}

export function importNetlistFile(){
  const inpt=document.createElement('input'); 
  inpt.type='file'; 
  inpt.accept='.json,.txt,.net';
  inpt.onchange=async e=>{ 
    const f=e.target.files?.[0]; 
    if(!f) return; 
    const txt=await f.text(); 
    $('#netlist-text').value=txt; 
    importNetlistFromText(txt); 
  };
  inpt.click();
}

export function refreshPlanView(){
  $('#cmp-count').textContent=String(App.plan.components.length);
  $('#net-count').textContent=String(App.plan.nets.length);
  const lc=$('#list-comps'); 
  lc.innerHTML='';
  (App.plan.components||[]).forEach(c=>{ 
    const d=document.createElement('div'); 
    d.textContent=`${c.ref}  ${c.value||''}  ${c.symbolKey?('['+c.symbolKey+']'):''}`; 
    lc.appendChild(d); 
  });
  const ln=$('#list-nets'); 
  ln.innerHTML='';
  (App.plan.nets||[]).forEach(n=>{ 
    const d=document.createElement('div'); 
    d.textContent=`${n.name}: ${(n.nodes||[]).map(x=>`${x.ref}-${x.pin}`).join(', ')}`; 
    ln.appendChild(d); 
  });
}

export function validatePlan(){
  const r={unknownRefs:new Set(), emptyNets:[], dupRefs:[], totalNodes:0};
  const refSet=new Set();
  for(const c of (App.plan.components||[])){ 
    if(refSet.has(c.ref)) r.dupRefs.push(c.ref); 
    refSet.add(c.ref); 
  }
  for(const net of (App.plan.nets||[])){ 
    const nodes=(net.nodes||[]).filter(Boolean); 
    if(!nodes.length) r.emptyNets.push(net.name); 
    r.totalNodes+=nodes.length; 
    nodes.forEach(nd=>{ 
      if(!refSet.has(nd.ref)) r.unknownRefs.add(nd.ref); 
    }); 
  }
  return r;
}

export function showValidation(r){
  if(r.dupRefs.length||r.unknownRefs.size||r.emptyNets.length){
    const msg=[
      r.dupRefs.length?`重复器件: ${[...new Set(r.dupRefs)].join(', ')}`:'',
      r.unknownRefs.size?`未定义器件: ${[...r.unknownRefs].join(', ')}`:'',
      r.emptyNets.length?`空网络: ${r.emptyNets.join(', ')}`:''
    ].filter(Boolean).join('； ');
    toast('网表导入成功，但存在问题：'+msg,'warn',4200);
  }else{
    toast(`网表导入成功：${App.plan.components.length} 个器件，${App.plan.nets.length} 条网络`,'ok');
  }
}