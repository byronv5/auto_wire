import { GRID } from './config.js';

/* ===== 工具函数 ===== */
export const $=(s,el=document)=>el.querySelector(s);
export const uuid=()=>('id_'+Math.random().toString(36).slice(2,9));
export const snap=v=>(Math.round(v/GRID)*GRID);

export function toast(msg,type='ok',timeout=2600){ 
  const box=$('#toasts'); 
  const d=document.createElement('div'); 
  d.className='toast '+(type==='err'?'err':type==='warn'?'warn':'ok'); 
  d.textContent=msg; 
  box.appendChild(d); 
  setTimeout(()=>{d.style.opacity='0';},timeout); 
  setTimeout(()=>{box.removeChild(d);},timeout+360); 
}