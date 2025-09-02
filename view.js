import { App } from './state.js';
import { $ } from './utils.js';
import { DEFAULT_VB } from './config.js';

/* ===== 视图/缩放控制 ===== */
function applyCam(){ 
  const svg=$('#schematic'); 
  const c=App.cam; 
  svg.setAttribute('viewBox',`${c.x} ${c.y} ${c.w} ${c.h}`); 
}

export function enablePanZoom(){
  const svg=$('#schematic');
  svg.addEventListener('wheel',e=>{ 
    e.preventDefault(); 
    const r=svg.getBoundingClientRect();
    const x=App.cam.x+(e.clientX-r.left)/r.width*App.cam.w;
    const y=App.cam.y+(e.clientY-r.top)/r.height*App.cam.h;
    const k=e.deltaY<0?0.9:1.1; 
    const nx=x-(x-App.cam.x)*k;
    const ny=y-(y-App.cam.y)*k; 
    App.cam.w*=k; 
    App.cam.h*=k; 
    App.cam.x=nx; 
    App.cam.y=ny; 
    applyCam();
  },{passive:false});
  
  let panning=false,last=null; 
  svg.addEventListener('contextmenu',e=>e.preventDefault());
  svg.addEventListener('mousedown',e=>{ 
    if(e.button===2){ 
      panning=true; 
      last={x:e.clientX,y:e.clientY}; 
    }
  });
  
  window.addEventListener('mousemove',e=>{ 
    if(!panning) return; 
    const r=svg.getBoundingClientRect();
    const dx=(e.clientX-last.x)/r.width*App.cam.w;
    const dy=(e.clientY-last.y)/r.height*App.cam.h;
    App.cam.x-=dx; 
    App.cam.y-=dy; 
    last={x:e.clientX,y:e.clientY}; 
    applyCam();
  });
  
  window.addEventListener('mouseup',()=>{ panning=false; });
  
  $('#btn-zoom-in').onclick=()=>{
    const cx=App.cam.x+App.cam.w/2, cy=App.cam.y+App.cam.h/2; 
    const k=0.8; 
    App.cam.x=cx-(cx-App.cam.x)*k; 
    App.cam.y=cy-(cy-App.cam.y)*k; 
    App.cam.w*=k; 
    App.cam.h*=k; 
    applyCam();
  };
  
  $('#btn-zoom-out').onclick=()=>{
    const cx=App.cam.x+App.cam.w/2, cy=App.cam.y+App.cam.h/2; 
    const k=1.25; 
    App.cam.x=cx-(cx-App.cam.x)*k; 
    App.cam.y=cy-(cy-App.cam.y)*k; 
    App.cam.w*=k; 
    App.cam.h*=k; 
    applyCam();
  };
  
  $('#btn-fit').onclick=()=>{ 
    App.cam={...DEFAULT_VB}; 
    applyCam(); 
  };
}

function clientToSvg(evt){
  const svg=$('#schematic'); 
  const r=svg.getBoundingClientRect();
  const sx=(evt.clientX - r.left)/r.width; 
  const sy=(evt.clientY - r.top)/r.height;
  return {x: App.cam.x + sx*App.cam.w, y: App.cam.y + sy*App.cam.h};
}