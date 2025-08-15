import { App } from './state.js';

export function isPassive(inst) {
	const ref = (inst?.ref || '').toUpperCase();
	const val = (inst?.value || '').toUpperCase();
	const key = (inst?.symbol?.key || '').toUpperCase();
	return /^R\d+/.test(ref) || /^C\d+/.test(ref) || /^D\d+/.test(ref) || /^L\d+/.test(ref) || /^Y\d+/.test(ref) || /^X\d+/.test(ref) ||
		/RES|CAP|DIODE|LED|INDUCTOR|CRYSTAL|XTAL|电阻|电容|二极管|发光二极管|电感|晶振/.test(val) ||
		/CRYSTAL/i.test(key);
}

export function isIC(inst) {
	return Array.isArray(inst?.pins) &&
		(inst.pins.length >= 8 ||
			/^U\d+/i.test(inst?.ref || '') ||
			/(mcu|cpu|fpga|ic|uln2003|89c51)/i.test(inst?.symbol?.key || ''));
}

export function isConnector(inst) {
	const ref = (inst?.ref || '').toUpperCase();
	const key = (inst?.symbol?.key || '').toLowerCase();
	const val = (inst?.value || '').toLowerCase();
	return (/^J\d+/.test(ref) || /^P\d+/.test(ref) || /^K\d+/.test(ref) || /^CN\d+/.test(ref) ||
		/header|hdr|connector|conn|socket|port|plug|jack/.test(key) ||
		/header|connector|conn/.test(val));
}

export function isPowerName(name) {
	return /^(VCC|VDD|3V3|5V|\+5V|3\.3V|\+3\.3V|\+12V|12V|GND|VSS|AGND|DGND|0V)$/i.test(String(name || ''));
}


