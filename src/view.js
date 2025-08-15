import { App, DEFAULT_VB, $, $$ } from './state.js';

export function applyCam() {
	const svg = $('#schematic');
	const c = App.cam;
	svg.setAttribute('viewBox', `${c.x} ${c.y} ${c.w} ${c.h}`);
}

export function enablePanZoom() {
	const svg = $('#schematic');
	svg.addEventListener('wheel', e => {
		e.preventDefault();
		const r = svg.getBoundingClientRect();
		const x = App.cam.x + (e.clientX - r.left) / r.width * App.cam.w,
			y = App.cam.y + (e.clientY - r.top) / r.height * App.cam.h;
		const k = e.deltaY < 0 ? 0.9 : 1.1;
		const nx = x - (x - App.cam.x) * k, ny = y - (y - App.cam.y) * k;
		App.cam.w *= k; App.cam.h *= k;
		App.cam.x = nx; App.cam.y = ny;
		applyCam();
	}, { passive: false });

	let panning = false, last = null;
	svg.addEventListener('contextmenu', e => e.preventDefault());
	svg.addEventListener('mousedown', e => {
		if (e.button === 2) {
			panning = true;
			last = { x: e.clientX, y: e.clientY };
		}
	});
	window.addEventListener('mousemove', e => {
		if (!panning) return;
		const r = svg.getBoundingClientRect();
		const dx = (e.clientX - last.x) / r.width * App.cam.w,
			dy = (e.clientY - last.y) / r.height * App.cam.h;
		App.cam.x -= dx; App.cam.y -= dy;
		last = { x: e.clientX, y: e.clientY };
		applyCam();
	});
	window.addEventListener('mouseup', () => { panning = false; });


	$('#btn-fit').onclick = () => {
		App.cam = { ...DEFAULT_VB };
		applyCam();
	};
}


