,.//PATH=src/plugins/controllerSupport.recar/index.tsx
const NAME = "ControllerSupport (Experimental)";

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

const logger = new Logger("ControllerSupport");

const BTN_B = 0;
const BTN_A = 1;
const BTN_Y = 2;
const BTN_X = 3;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_SELECT = 8;
const BTN_START = 9;
const BTN_L3 = 10;
const BTN_R3 = 11;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_Y = 3;

const FOCUSABLE_SEL = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
	"[role='button']:not([disabled])",
	"[role='link']",
	"[role='menuitem']",
	"[role='option']",
	"[role='tab']",
	"[role='treeitem']",
	"[role='checkbox']",
	"[role='radio']",
	"[contenteditable='true']",
	"[data-slate-editor='true']",
].join(",");

const MSG_ITEM_SEL = '[class*="messageListItem"]';

const POPUP_LAYERS = [
	'[class*="layerContainer-"]',
	'[class*="popout-"]',
	'[role="dialog"]',
	'[class*="menu-"]',
	'[class*="modal-"]',
].join(",");

const settings = definePluginSettings({
	swapAB: {
		type: OptionType.BOOLEAN,
		description: "Swap A/B buttons (disable for Switch Pro Controller).",
		default: true,
	},
	deadzone: {
		type: OptionType.SLIDER,
		description: "Analog stick deadzone (0–1).",
		default: 0.25,
		markers: [0, 0.15, 0.25, 0.4],
	},
	cursorSpeed: {
		type: OptionType.SLIDER,
		description: "Virtual cursor speed (pixels per frame).",
		default: 12,
		markers: [4, 8, 12, 20, 32],
	},
	scrollSpeed: {
		type: OptionType.SLIDER,
		description: "Right-stick scroll speed.",
		default: 10,
		markers: [2, 6, 10, 18, 28],
	},
	repeatDelayMs: {
		type: OptionType.NUMBER,
		description: "Delay (ms) before held button repeats.",
		default: 380,
	},
	repeatIntervalMs: {
		type: OptionType.NUMBER,
		description: "Interval (ms) between repeats while held.",
		default: 110,
	},
	showConnectToasts: {
		type: OptionType.BOOLEAN,
		description: "Toast on controller connect/disconnect.",
		default: true,
	},
	overlayColor: {
		type: OptionType.STRING,
		description: "CSS color for the focus highlight border.",
		default: "#5865f2",
	},
});

function OK_BTN() {
	return settings.store.swapAB ? BTN_B : BTN_A;
}
function BACK_BTN() {
	return settings.store.swapAB ? BTN_A : BTN_B;
}

const OVERLAY_ID = "vc-controller-focus-overlay";

function getOrCreateOverlay(): HTMLElement {
	let el = document.getElementById(OVERLAY_ID);
	if (!el) {
		el = document.createElement("div");
		el.id = OVERLAY_ID;
		Object.assign(el.style, {
			position: "fixed",
			pointerEvents: "none",
			zIndex: "99998",
			boxSizing: "border-box",
			border: `3px solid ${settings.store.overlayColor}`,
			transition:
				"top 80ms ease, left 80ms ease, width 80ms ease, height 80ms ease, opacity 80ms ease",
			opacity: "0",
		});
		document.body.appendChild(el);
	}
	return el;
}

function removeOverlay() {
	document.getElementById(OVERLAY_ID)?.remove();
}

function showOverlayOn(el: Element) {
	const overlay = getOrCreateOverlay();
	overlay.style.border = `3px solid ${settings.store.overlayColor}`;
	overlay.style.boxShadow = `0 0 0 3px ${settings.store.overlayColor}44, 0 0 12px 2px ${settings.store.overlayColor}66`;
	const rect = el.getBoundingClientRect();
	const PAD = 4;
	Object.assign(overlay.style, {
		top: `${rect.top - PAD}px`,
		left: `${rect.left - PAD}px`,
		width: `${rect.width + PAD * 2}px`,
		height: `${rect.height + PAD * 2}px`,
		opacity: "1",
	});
}

function hideOverlay() {
	const o = document.getElementById(OVERLAY_ID);
	if (o) o.style.opacity = "0";
}

const CURSOR_ID = "vc-controller-cursor";

let cursorX = window.innerWidth / 2;
let cursorY = window.innerHeight / 2;
let cursorVisible = false;
let lastHoveredElement: Element | null = null;

function getOrCreateCursor(): HTMLElement {
	let el = document.getElementById(CURSOR_ID);
	if (!el) {
		el = document.createElement("div");
		el.id = CURSOR_ID;
		Object.assign(el.style, {
			position: "fixed",
			pointerEvents: "none",
			zIndex: "99999",
			width: "24px",
			height: "24px",
			transform: "translate(-50%, -50%)",
			opacity: "0",
			transition: "opacity 120ms ease",
		});
		const h = document.createElement("div");
		Object.assign(h.style, {
			position: "absolute",
			top: "50%",
			left: "0",
			width: "100%",
			height: "2px",
			marginTop: "-1px",
			background: "white",
			boxShadow: "0 0 3px rgba(0,0,0,0.8)",
			borderRadius: "1px",
		});
		const v = document.createElement("div");
		Object.assign(v.style, {
			position: "absolute",
			left: "50%",
			top: "0",
			width: "2px",
			height: "100%",
			marginLeft: "-1px",
			background: "white",
			boxShadow: "0 0 3px rgba(0,0,0,0.8)",
			borderRadius: "1px",
		});
		const dot = document.createElement("div");
		Object.assign(dot.style, {
			position: "absolute",
			top: "50%",
			left: "50%",
			width: "4px",
			height: "4px",
			marginTop: "-2px",
			marginLeft: "-2px",
			background: settings.store.overlayColor,
			borderRadius: "50%",
			boxShadow: `0 0 4px ${settings.store.overlayColor}`,
		});
		el.appendChild(h);
		el.appendChild(v);
		el.appendChild(dot);
		document.body.appendChild(el);
	}
	return el;
}

function removeCursor() {
	document.getElementById(CURSOR_ID)?.remove();
}

function simulateHoverEvents(
	nextElement: Element | null,
	lastElement: Element | null
) {
	if (nextElement === lastElement) return;

	const commonOpts = {
		bubbles: true,
		cancelable: true,
		clientX: cursorX,
		clientY: cursorY,
		view: window,
	};

	if (lastElement && document.body.contains(lastElement)) {
		lastElement.dispatchEvent(new MouseEvent("mouseleave", commonOpts));
		lastElement.dispatchEvent(new MouseEvent("mouseout", commonOpts));
	}
	if (nextElement) {
		nextElement.dispatchEvent(new MouseEvent("mouseenter", commonOpts));
		nextElement.dispatchEvent(new MouseEvent("mouseover", commonOpts));
	}
}

function updateCursorPosition() {
	const el = getOrCreateCursor();
	el.style.left = `${cursorX}px`;
	el.style.top = `${cursorY}px`;
	el.style.opacity = cursorVisible ? "1" : "0";

	if (cursorVisible) {
		const target = document.elementFromPoint(cursorX, cursorY);
		if (target !== lastHoveredElement) {
			simulateHoverEvents(target, lastHoveredElement);
			lastHoveredElement = target;
		}
	} else if (lastHoveredElement) {
		simulateHoverEvents(null, lastHoveredElement);
		lastHoveredElement = null;
	}
}

function showCursor() {
	cursorVisible = true;
	updateCursorPosition();
}

function hideCursor() {
	cursorVisible = false;
	updateCursorPosition();
}

function cursorClick(button: 0 | 2) {
	const target = document.elementFromPoint(cursorX, cursorY);
	if (!target) return;
	const opts: MouseEventInit = {
		bubbles: true,
		cancelable: true,
		clientX: cursorX,
		clientY: cursorY,
		screenX: cursorX,
		screenY: cursorY,
		view: window,
		button,
		buttons: button === 0 ? 1 : 2,
	};
	target.dispatchEvent(new MouseEvent("mousedown", opts));
	target.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
	if (button === 0) {
		target.dispatchEvent(new MouseEvent("click", opts));
	} else {
		target.dispatchEvent(
			new MouseEvent("contextmenu", { ...opts, button: 2 })
		);
	}
}

function isVisible(el: HTMLElement): boolean {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return false;
	if (r.bottom < 0 || r.top > window.innerHeight) return false;
	if (r.right < 0 || r.left > window.innerWidth) return false;

	let node: HTMLElement | null = el;
	while (node && node !== document.documentElement) {
		if (node.getAttribute("aria-hidden") === "true") return false;
		const s = getComputedStyle(node);
		if (s.display === "none" || s.visibility === "hidden") return false;
		if (parseFloat(s.opacity) === 0) return false;
		if (
			s.overflow === "hidden" ||
			s.overflowY === "hidden" ||
			s.overflowX === "hidden"
		) {
			const cr = node.getBoundingClientRect();
			if (
				r.bottom < cr.top - 2 ||
				r.top > cr.bottom + 2 ||
				r.right < cr.left - 2 ||
				r.left > cr.right + 2
			) {
				return false;
			}
		}
		node = node.parentElement;
	}
	return true;
}

function getFocusableElements(): Element[] {
	let rootScope: Document | Element = document;

	const popups = Array.from(document.querySelectorAll(POPUP_LAYERS)).filter(
		(el) => isVisible(el as HTMLElement)
	);
	if (popups.length > 0) {
		popups.sort((a, b) => {
			const az = parseInt(getComputedStyle(a).zIndex) || 0;
			const bz = parseInt(getComputedStyle(b).zIndex) || 0;
			return bz - az;
		});
		rootScope = popups[0];
	}

	const standard = Array.from(
		rootScope.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)
	).filter(isVisible);
	const msgItems = Array.from(
		rootScope.querySelectorAll<HTMLElement>(MSG_ITEM_SEL)
	).filter(isVisible);

	const all = [...new Set([...standard, ...msgItems])];
	all.sort((a, b) => {
		const ra = a.getBoundingClientRect();
		const rb = b.getBoundingClientRect();
		const dy = ra.top - rb.top;
		return Math.abs(dy) > 4 ? dy : ra.left - rb.left;
	});
	return all;
}

let focusedEl: Element | null = null;
let controllerActive = false;
const focusStack: Element[] = [];

function setFocus(el: Element, pushStack = false) {
	if (pushStack && focusedEl) focusStack.push(focusedEl);

	if (focusedEl && focusedEl !== el) {
		simulateHoverEvents(null, focusedEl);
	}

	focusedEl = el;
	(el as HTMLElement).focus?.({ preventScroll: true });
	el.scrollIntoView({ block: "nearest", inline: "nearest" });
	showOverlayOn(el);

	simulateHoverEvents(el, null);
}

function goBack() {
	if (focusedEl) simulateHoverEvents(null, focusedEl);
	const parent = focusStack.pop();
	if (parent && document.body.contains(parent)) {
		focusedEl = parent;
		showOverlayOn(parent);
		simulateHoverEvents(parent, null);
	} else {
		hideOverlay();
		focusedEl = null;
		controllerActive = false;
	}
}

function findSpatialTarget(
	from: Element,
	dir: "up" | "down" | "left" | "right"
): Element | null {
	const candidates = getFocusableElements().filter((el) => el !== from);
	const rect = from.getBoundingClientRect();
	const cx = (rect.left + rect.right) / 2;
	const cy = (rect.top + rect.bottom) / 2;

	let best: Element | null = null;
	let bestScore = Infinity;

	for (const el of candidates) {
		const tgt = el.getBoundingClientRect();
		const tcx = (tgt.left + tgt.right) / 2;
		const tcy = (tgt.top + tgt.bottom) / 2;

		let primary: number, secondary: number;
		let a1: number, b1: number, a2: number, b2: number;

		switch (dir) {
			case "up":
				primary = rect.top - tgt.bottom;
				secondary = Math.abs(cx - tcx);
				a1 = rect.left;
				b1 = rect.right;
				a2 = tgt.left;
				b2 = tgt.right;
				break;
			case "down":
				primary = tgt.top - rect.bottom;
				secondary = Math.abs(cx - tcx);
				a1 = rect.left;
				b1 = rect.right;
				a2 = tgt.left;
				b2 = tgt.right;
				break;
			case "left":
				primary = rect.left - tgt.right;
				secondary = Math.abs(cy - tcy);
				a1 = rect.top;
				b1 = rect.bottom;
				a2 = tgt.top;
				b2 = tgt.bottom;
				break;
			case "right":
				primary = tgt.left - rect.right;
				secondary = Math.abs(cy - tcy);
				a1 = rect.top;
				b1 = rect.bottom;
				a2 = tgt.top;
				b2 = tgt.bottom;
				break;
		}

		if (primary! < -10) continue;
		primary = Math.max(0, primary!);

		const dim1 = b1! - a1!;
		let occ = 0;
		if (dim1 > 0) {
			const lo = Math.max(a1!, a2!);
			const hi = Math.min(b1!, b2!);
			occ = Math.max(0, hi - lo) / dim1;
		}

		const score = primary + secondary! * 0.5 - occ * 300;
		if (score < bestScore) {
			bestScore = score;
			best = el;
		}
	}
	return best;
}

function navigate(dir: "up" | "down" | "left" | "right") {
	const all = getFocusableElements();
	if (!all.length) return;

	let next: Element | null = null;

	if (!focusedEl || !document.body.contains(focusedEl)) {
		next = all.reduce((best, el) => {
			const rb = el.getBoundingClientRect(),
				bb = best.getBoundingClientRect();
			return rb.top + rb.left < bb.top + bb.left ? el : best;
		}, all[0]);
	} else {
		next = findSpatialTarget(focusedEl, dir);
		if (!next) {
			const idx = all.indexOf(focusedEl as Element);
			next =
				dir === "down" || dir === "right"
					? all[(idx + 1) % all.length]
					: all[(idx - 1 + all.length) % all.length];
		}
	}

	if (next) setFocus(next);
}

function getFocusableChildren(el: HTMLElement): HTMLElement[] {
	return Array.from(
		el.querySelectorAll<HTMLElement>(FOCUSABLE_SEL + "," + MSG_ITEM_SEL)
	).filter((child) => child !== el && isVisible(child));
}

function findFiberOnClick(el: Element): ((...args: any[]) => void) | null {
	const fiberKey = Object.keys(el).find(
		(k) =>
			k.startsWith("__reactFiber") ||
			k.startsWith("__reactInternalInstance")
	);
	if (!fiberKey) return null;
	let fiber = (el as any)[fiberKey];
	while (fiber) {
		const props = fiber.memoizedProps ?? fiber.pendingProps;
		if (props && typeof props.onClick === "function") return props.onClick;
		fiber = fiber.return;
	}
	return null;
}

function activateFocused() {
	if (!focusedEl) return;
	const el = focusedEl as HTMLElement;
	el.focus?.();

	if (
		el.hasAttribute("data-slate-editor") ||
		el.getAttribute("contenteditable") === "true"
	) {
		el.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				keyCode: 13,
				bubbles: true,
				cancelable: true,
			})
		);
		return;
	}

	if (el.matches(MSG_ITEM_SEL)) {
		const children = getFocusableChildren(el);
		if (children.length > 0) {
			setFocus(children[0], true);
			return;
		}
	}

	const isNativelyClickable =
		el instanceof HTMLButtonElement ||
		el instanceof HTMLAnchorElement ||
		[
			"button",
			"link",
			"menuitem",
			"option",
			"tab",
			"checkbox",
			"radio",
		].includes(el.getAttribute("role") ?? "");

	if (!isNativelyClickable) {
		const children = getFocusableChildren(el);
		if (children.length > 0) {
			setFocus(children[0], true);
			return;
		}
	}

	const onClick = findFiberOnClick(el);
	if (onClick) {
		onClick({
			preventDefault: () => {},
			stopPropagation: () => {},
			nativeEvent: new MouseEvent("click", { bubbles: true }),
			currentTarget: el,
			target: el,
			type: "click",
			button: 0,
		});
		return;
	}

	el.click();
}

function scroll(delta: number) {
	let node: HTMLElement | null = null;

	if (cursorVisible) {
		const elementAtCursor = document.elementFromPoint(cursorX, cursorY);
		if (elementAtCursor) {
			node = elementAtCursor as HTMLElement;
		}
	}

	if (!node && focusedEl) {
		node = (focusedEl as HTMLElement).parentElement;
	}

	while (node && node !== document.body) {
		const ov = getComputedStyle(node).overflowY;
		if (
			(ov === "auto" || ov === "scroll") &&
			node.scrollHeight > node.clientHeight
		) {
			node.scrollTop += delta;
			return;
		}
		node = node.parentElement;
	}

	const scroller =
		document.querySelector<HTMLElement>(
			'[class*="messagesWrapper"] [class*="scroller"]'
		) ??
		document.querySelector<HTMLElement>(
			'[class*="chatContent"] [class*="scroller"]'
		);
	if (scroller) scroller.scrollTop += delta;
}

interface BtnState {
	pressed: boolean;
	heldSince: number;
	lastRepeat: number;
}

const btnStates = new Map<number, BtnState>();
function getBtnState(k: number): BtnState {
	if (!btnStates.has(k))
		btnStates.set(k, { pressed: false, heldSince: 0, lastRepeat: 0 });
	return btnStates.get(k)!;
}

let rafId: number | null = null;
let ltWasPressed = false;
let rtWasPressed = false;

function pollGamepads() {
	const now = performance.now();
	const dead = settings.store.deadzone;
	const speed = settings.store.cursorSpeed;

	const OK_IDX = OK_BTN();
	const BACK_IDX = BACK_BTN();

	const ACTIONS: Record<number, { fn: () => void; repeatable?: boolean }> = {
		[OK_IDX]: { fn: activateFocused },
		[BACK_IDX]: { fn: goBack },
		[BTN_DPAD_UP]: { fn: () => navigate("up"), repeatable: true },
		[BTN_DPAD_DOWN]: { fn: () => navigate("down"), repeatable: true },
		[BTN_DPAD_LEFT]: { fn: () => navigate("left"), repeatable: true },
		[BTN_DPAD_RIGHT]: { fn: () => navigate("right"), repeatable: true },
		[BTN_LB]: { fn: () => navigate("up"), repeatable: true },
		[BTN_RB]: { fn: () => navigate("down"), repeatable: true },
	};

	let leftX = 0,
		leftY = 0;
	let ltPressed = false,
		rtPressed = false;

	for (const gp of navigator.getGamepads()) {
		if (!gp?.connected) continue;

		gp.buttons.forEach((btn, idx) => {
			const def = ACTIONS[idx];
			if (!def) return;
			const key = gp.index * 100 + idx;
			const state = getBtnState(key);

			if (btn.pressed) {
				controllerActive = true;
				if (!state.pressed) {
					state.pressed = true;
					state.heldSince = now;
					state.lastRepeat = now;
					def.fn();
				} else if (def.repeatable) {
					if (
						now - state.heldSince >= settings.store.repeatDelayMs &&
						now - state.lastRepeat >=
							settings.store.repeatIntervalMs
					) {
						state.lastRepeat = now;
						def.fn();
					}
				}
			} else {
				state.pressed = false;
			}
		});

		const ax = gp.axes[AXIS_LEFT_X] ?? 0;
		const ay = gp.axes[AXIS_LEFT_Y] ?? 0;
		if (Math.abs(ax) > dead) leftX = ax;
		if (Math.abs(ay) > dead) leftY = ay;

		const ry = gp.axes[AXIS_RIGHT_Y] ?? 0;
		if (Math.abs(ry) > dead) scroll(ry * settings.store.scrollSpeed);

		const ltVal = Math.max(
			gp.buttons[BTN_LT]?.value ?? 0,
			(gp.axes[2] ?? -1 + 1) / 2
		);
		const rtVal = Math.max(
			gp.buttons[BTN_RT]?.value ?? 0,
			(gp.axes[5] ?? -1 + 1) / 2
		);
		if (ltVal > 0.5) ltPressed = true;
		if (rtVal > 0.5) rtPressed = true;
	}

	if (leftX !== 0 || leftY !== 0) {
		controllerActive = true;
		const mx = Math.sign(leftX) * leftX * leftX * speed;
		const my = Math.sign(leftY) * leftY * leftY * speed;
		cursorX = Math.max(0, Math.min(window.innerWidth, cursorX + mx));
		cursorY = Math.max(0, Math.min(window.innerHeight, cursorY + my));
		showCursor();

		if (focusedEl) {
			simulateHoverEvents(null, focusedEl);
			focusedEl = null;
		}
		hideOverlay();
	}

	if (rtPressed && !rtWasPressed) {
		controllerActive = true;
		if (cursorVisible) cursorClick(0);
	}
	if (ltPressed && !ltWasPressed) {
		controllerActive = true;
		if (cursorVisible) cursorClick(2);
	}
	rtWasPressed = rtPressed;
	ltWasPressed = ltPressed;

	if (focusedEl && controllerActive && document.body.contains(focusedEl)) {
		showOverlayOn(focusedEl);
	}

	rafId = requestAnimationFrame(pollGamepads);
}

function onConnected(e: GamepadEvent) {
	logger.info(`Controller connected: ${e.gamepad.id}`);
	if (settings.store.showConnectToasts)
		showToast(`Controller connected: ${e.gamepad.id}`, Toasts.Type.SUCCESS);
	if (rafId === null) rafId = requestAnimationFrame(pollGamepads);
}

function onDisconnected(e: GamepadEvent) {
	logger.info(`Controller disconnected: ${e.gamepad.id}`);
	if (settings.store.showConnectToasts)
		showToast(
			`Controller disconnected: ${e.gamepad.id}`,
			Toasts.Type.FAILURE
		);
	const remaining = navigator.getGamepads().filter((g) => g?.connected);
	if (!remaining.length && rafId !== null) {
		cancelAnimationFrame(rafId);
		rafId = null;
		if (focusedEl) simulateHoverEvents(null, focusedEl);
		if (lastHoveredElement) simulateHoverEvents(null, lastHoveredElement);
		hideOverlay();
		hideCursor();
		focusedEl = null;
		controllerActive = false;
		focusStack.length = 0;
	}
}

function clearHoverAndFocus() {
	if (controllerActive) {
		if (focusedEl) simulateHoverEvents(null, focusedEl);
		if (lastHoveredElement) simulateHoverEvents(null, lastHoveredElement);
		hideOverlay();
		hideCursor();
		focusedEl = null;
		controllerActive = false;
		focusStack.length = 0;
	}
}

export default definePlugin({
	name: NAME,
	description: "Discord with controller support (kinda)",
	tags: ["Utility", "Accessibility", "Controller", "Gamepad"],
	authors: [{ name: "hamhim", id: 1244223146027122699 }],
	settings,

	start() {
		window.addEventListener("gamepadconnected", onConnected);
		window.addEventListener("gamepaddisconnected", onDisconnected);
		document.addEventListener("mousemove", clearHoverAndFocus, {
			passive: true,
		});
		document.addEventListener("keydown", clearHoverAndFocus, {
			passive: true,
		});

		const existing = navigator.getGamepads().filter((g) => g?.connected);
		if (existing.length && rafId === null)
			rafId = requestAnimationFrame(pollGamepads);
	},

	stop() {
		window.removeEventListener("gamepadconnected", onConnected);
		window.removeEventListener("gamepaddisconnected", onDisconnected);
		document.removeEventListener("mousemove", clearHoverAndFocus);
		document.removeEventListener("keydown", clearHoverAndFocus);

		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
		if (focusedEl) simulateHoverEvents(null, focusedEl);
		if (lastHoveredElement) simulateHoverEvents(null, lastHoveredElement);
		removeOverlay();
		removeCursor();
		btnStates.clear();
		focusedEl = null;
		controllerActive = false;
		focusStack.length = 0;
	},
});
