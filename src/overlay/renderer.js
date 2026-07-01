const net = require("net");
const fs = require("fs");
const path = require("path");
const { parentPort } = require("worker_threads");
const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");

let fontFamily = "sans-serif";

// Source Sans 3 is very similar to Discord's gg sans, hence its usage here.

const fontWeights = {
	400: "Source Sans 3 W400",
	500: "Source Sans 3 W500",
	600: "Source Sans 3 W600",
	700: "Source Sans 3 W700",
	800: "Source Sans 3 W800",
};

const availableFonts = [
	{ filename: "SourceSans3-Regular.ttf", family: fontWeights[400] },
	{ filename: "SourceSans3-Medium.ttf", family: fontWeights[500] },
	{ filename: "SourceSans3-SemiBold.ttf", family: fontWeights[600] },
	{ filename: "SourceSans3-Bold.ttf", family: fontWeights[700] },
	{ filename: "SourceSans3-ExtraBold.ttf", family: fontWeights[800] },
];

function initFonts(assetsDir) {
	const fontDir = assetsDir ? path.join(assetsDir, "font", "static") : null;

	let anyLoaded = false;

	if (fontDir) {
		for (const { filename, family } of availableFonts) {
			const fontPath = path.join(fontDir, filename);
			if (fs.existsSync(fontPath)) {
				try {
					GlobalFonts.registerFromPath(fontPath, family);
					console.log(
						`[Overlay] Loaded font: ${fontPath} as "${family}"`
					);
					anyLoaded = true;
				} catch (e) {
					console.warn(
						`[Overlay] Failed to load ${fontPath}:`,
						e.message
					);
				}
			} else {
				console.warn(`[Overlay] Font file not found: ${fontPath}`);
			}
		}
	}

	if (anyLoaded) {
		fontFamily = "Source Sans 3 W";
		return;
	}

	const systemFonts = [
		["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
		["/usr/share/fonts/TTF/DejaVuSans.ttf", "DejaVu Sans"],
		[
			"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
			"Liberation Sans",
		],
		["/usr/share/fonts/noto/NotoSans-Regular.ttf", "Noto Sans"],
	];

	for (const [fontPath, familyName] of systemFonts) {
		if (fs.existsSync(fontPath)) {
			try {
				GlobalFonts.registerFromPath(fontPath, familyName);
				fontFamily = familyName;
				console.log(`[Overlay] Loaded system font: ${fontPath}`);
				return;
			} catch {}
		}
	}
}

const ICON_MUTED = "muted";
const ICON_DEAFENED = "deafened";

const SHM_NAME = "/recar_overlay";
const SHM_HEADER_SIZE = 64;
const SHM_MAX_WIDTH = 3840;
const SHM_MAX_HEIGHT = 2160;
const SHM_PIXEL_SIZE = SHM_MAX_WIDTH * SHM_MAX_HEIGHT * 4;
const SHM_TOTAL_SIZE = SHM_HEADER_SIZE + SHM_PIXEL_SIZE;
const SHM_STATE_WRITING = 1;
const SHM_STATE_READY = 2;
const SOCKET_PATH = process.env.RECAR_SOCKET_PATH || "/tmp/recar_overlay.sock";

const DEFAULT_LAYOUT = {
	notifications: "top-left",
	voicePanel: "bottom-left",
};

function resolveSlotOrigin(slot, panelW, panelH, screenW, screenH, margin) {
	const cx = (screenW - panelW) / 2;

	switch (slot) {
		case "middle-left":
			return { x: margin, y: (screenH - panelH) / 2 };
		case "middle-right":
			return { x: screenW - panelW - margin, y: (screenH - panelH) / 2 };
		case "top-left":
			return { x: margin, y: margin };
		case "top-center":
			return { x: cx, y: margin };
		case "top-right":
			return { x: screenW - panelW - margin, y: margin };
		case "bottom-left":
			return { x: margin, y: screenH - panelH - margin };
		case "bottom-center":
			return { x: cx, y: screenH - panelH - margin };
		case "bottom-right":
			return {
				x: screenW - panelW - margin,
				y: screenH - panelH - margin,
			};
		default:
			return { x: margin, y: margin };
	}
}

function notifStackDirection(slot) {
	return slot.startsWith("bottom") ? "up" : "down";
}

class OverlayRenderer {
	constructor() {
		this._measureCtx = null;
		this._shmFd = -1;
		this._pxCache = {};
		this._voicePanelCanvas = null;
		this._headerBuf = null;
		this._readBuf = null;
		this._canvas = null;
		this._ctx = null;
		this._width = 0;
		this._height = 0;
		this._dirty = false;
		this._renderPending = false;
		this._heartbeatTimer = null;
		this._initialized = false;
		this._notifications = [];
		this._voiceUsers = [];
		this._lastWidth = 0;
		this._lastHeight = 0;
		this._scale = 1.0;
		this._resizeDebounce = null;
		this._avatarCache = new Map();
		this._assetsDir = null;
		this._svgCache = new Map();
		this._iconCache = new Map();
		this._iconLoading = new Set();
		this._layerSocket = null;
		this._layerSocketReady = false;
		this._fontCache = {};
		this._layout = { ...DEFAULT_LAYOUT };
	}

	async init(width = 1920, height = 1080, assetsDir = null, layout = null) {
		if (process.platform !== "linux") return false;

		this._assetsDir = assetsDir;
		if (layout) this._layout = { ...DEFAULT_LAYOUT, ...layout };

		initFonts(assetsDir);
		this._loadIconSvgs();
		this._connectLayerSocket();

		this._width = Math.min(width, SHM_MAX_WIDTH);
		this._height = Math.min(height, SHM_MAX_HEIGHT);
		this._updateScale();

		if (!this._openShm()) return false;

		const gameRes = this._readGameResolution();
		if (gameRes) {
			this._width = gameRes.width;
			this._height = gameRes.height;
			this._lastWidth = gameRes.width;
			this._lastHeight = gameRes.height;
		}

		this._recreateCanvas(this._width, this._height);
		this._initialized = true;
		this._lastFrameTime = Date.now();

		await this._waitForGameResolution();

		this._scheduleRender();

		return true;
	}

	setLayout(layout) {
		this._layout = { ...DEFAULT_LAYOUT, ...layout };
		this._invalidateVoicePanel();

		for (const n of this._notifications) {
			delete n._animY;
			delete n._velY;
		}
		this._markDirty();
	}

	async _waitForGameResolution(attempts = 20, intervalMs = 100) {
		for (let i = 0; i < attempts; i++) {
			const gameRes = this._readGameResolution();
			if (
				gameRes &&
				(gameRes.width !== this._width ||
					gameRes.height !== this._height)
			) {
				console.log(
					`[Overlay] Got game resolution: ${gameRes.width}x${gameRes.height}`
				);
				this._lastWidth = gameRes.width;
				this._lastHeight = gameRes.height;
				this._recreateCanvas(gameRes.width, gameRes.height);
				return;
			}
			if (gameRes) return;
			await new Promise((r) => setTimeout(r, intervalMs));
		}
		console.warn(
			"[Overlay] Could not read game resolution after init, using default"
		);
	}

	destroy() {
		if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
		if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
		this._closeShm();
		this._initialized = false;
	}

	_updateScale() {
		this._scale = Math.max(1.0, this._width / 1920);
	}

	_recreateCanvas(width, height) {
		const dpr = 1;
		this._width = width;
		this._height = height;
		this._dpr = dpr;
		this._updateScale();
		this._canvas = createCanvas(width * dpr, height * dpr);
		this._ctx = this._canvas.getContext("2d");
		this._ctx.scale(dpr, dpr);
		this._ctx.imageSmoothingEnabled = true;
		this._ctx.imageSmoothingQuality = "high";
		this._ctx.textRendering = "geometricPrecision";
		this._ctx.fontKerning = "normal";
		this._iconCache.clear();
		this._iconLoading.clear();
		this._fontCache = {};
		this._pxCache = {};
		this._voicePanelCanvas = null;
		this._measureCtx = null;
		this._markDirty();

		setTimeout(() => {
			const iconSize = this._px(24);
			const color = "#d3d3d3";
			this._renderIcon(ICON_MUTED, iconSize, color);
			this._renderIcon(ICON_DEAFENED, iconSize, color);
		}, 0);
	}

	_loadIconSvgs() {
		if (!this._assetsDir) return;

		const icons = {
			[ICON_MUTED]: "muted.svg",
			[ICON_DEAFENED]: "deafened.svg",
		};

		for (const [name, filename] of Object.entries(icons)) {
			const svgPath = path.join(
				this._assetsDir,
				"img",
				"overlay",
				filename
			);
			if (!fs.existsSync(svgPath)) {
				console.warn(`[Overlay] Icon not found: ${svgPath}`);
				continue;
			}
			try {
				const svgData = fs.readFileSync(svgPath, "utf-8");
				this._svgCache.set(name, svgData);
				console.log(`[Overlay] Loaded SVG source: ${filename}`);
			} catch (e) {
				console.warn(
					`[Overlay] Failed to read ${filename}:`,
					e.message
				);
			}
		}
	}

	async _renderIcon(iconName, size, color) {
		const cacheKey = `${iconName}_${size}_${color}`;
		if (this._iconCache.has(cacheKey) || this._iconLoading.has(cacheKey))
			return;

		const svgSource = this._svgCache.get(iconName);
		if (!svgSource) return;

		this._iconLoading.add(cacheKey);

		try {
			const dpr = this._dpr || 1;
			const renderSize = size * dpr;

			let svg = svgSource;
			svg = svg.replace(/(<svg[^>]*)\sfill="[^"]*"/i, "$1");
			svg = svg.replace(/width="[^"]*"/, `width="${renderSize}"`);
			svg = svg.replace(/height="[^"]*"/, `height="${renderSize}"`);
			svg = svg.replace(/<svg/, `<svg fill="${color}"`);

			const svgBuffer = Buffer.from(svg);
			const image = await loadImage(svgBuffer);

			if (this._dpr === dpr) {
				this._iconCache.set(cacheKey, image);
				this._invalidateVoicePanel();
				this._markDirty();
			}
		} catch (e) {
			console.warn(
				`[Overlay] Failed to render icon ${iconName}:`,
				e.message
			);
		} finally {
			this._iconLoading.delete(cacheKey);
		}
	}

	_drawIcon(ctx, iconName, x, y, size, color) {
		const cacheKey = `${iconName}_${size}_${color}`;
		const image = this._iconCache.get(cacheKey);

		if (image) {
			ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
			return;
		}

		this._renderIcon(iconName, size, color);
		this._drawFallbackIcon(ctx, iconName, x, y, size, color);
	}

	_drawFallbackIcon(ctx, iconName, x, y, size, color) {
		ctx.save();
		const radius = size * 0.35;
		ctx.strokeStyle = color;
		ctx.lineWidth = Math.max(1.5, size * 0.12);
		ctx.lineCap = "round";

		if (iconName === ICON_MUTED) {
			ctx.beginPath();
			ctx.arc(x, y - size * 0.1, radius * 0.55, Math.PI, 0);
			ctx.lineTo(x + radius * 0.55, y + size * 0.05);
			ctx.arc(x, y + size * 0.05, radius * 0.55, 0, Math.PI);
			ctx.closePath();
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(x - radius, y + radius);
			ctx.lineTo(x + radius, y - radius);
			ctx.stroke();
		} else if (iconName === ICON_DEAFENED) {
			ctx.beginPath();
			ctx.arc(x, y, radius, Math.PI * 1.15, Math.PI * 1.85);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(x - radius, y + radius);
			ctx.lineTo(x + radius, y - radius);
			ctx.stroke();
		}
		ctx.restore();
	}

	_openShm() {
		try {
			const shmPath = `/dev/shm${SHM_NAME}`;
			let fd;
			try {
				fd = fs.openSync(shmPath, "r+");
			} catch {
				fd = fs.openSync(shmPath, "w+");
				const zeroBuf = Buffer.alloc(4096);
				let written = 0;
				while (written < SHM_TOTAL_SIZE) {
					const chunk = Math.min(
						zeroBuf.length,
						SHM_TOTAL_SIZE - written
					);
					fs.writeSync(fd, zeroBuf, 0, chunk);
					written += chunk;
				}
			}
			if (fs.fstatSync(fd).size < SHM_TOTAL_SIZE)
				fs.ftruncateSync(fd, SHM_TOTAL_SIZE);

			this._shmFd = fd;
			this._headerBuf = Buffer.alloc(SHM_HEADER_SIZE);
			this._readBuf = Buffer.alloc(SHM_HEADER_SIZE);
			return true;
		} catch (e) {
			console.error("[Overlay] shm open failed:", e);
			return false;
		}
	}

	_closeShm() {
		if (this._shmFd >= 0) {
			try {
				fs.closeSync(this._shmFd);
			} catch {}
			this._shmFd = -1;
		}
	}

	_readGameResolution() {
		if (this._shmFd < 0) return null;
		try {
			fs.readSync(this._shmFd, this._readBuf, 0, SHM_HEADER_SIZE, 0);
			const width = this._readBuf.readUInt32LE(16);
			const height = this._readBuf.readUInt32LE(20);
			if (
				width > 0 &&
				height > 0 &&
				width <= SHM_MAX_WIDTH &&
				height <= SHM_MAX_HEIGHT
			)
				return { width, height };
		} catch {}
		return null;
	}

	_writeShm(pixelBuf, bufW, bufH) {
		if (this._shmFd < 0) return false;
		try {
			this._headerBuf[0] = SHM_STATE_WRITING;
			this._headerBuf.writeUInt32LE(bufW, 4);
			this._headerBuf.writeUInt32LE(bufH, 8);
			fs.writevSync(this._shmFd, [this._headerBuf, pixelBuf], 0);
			this._headerBuf[0] = SHM_STATE_READY;
			fs.writeSync(this._shmFd, this._headerBuf, 0, 1, 0);
			//console.log("[Overlay] SHM write ok, arming heartbeat");
			this._armHeartbeat();
			return true;
		} catch (e) {
			console.error("[Overlay] SHM write failed:", e);
			return false;
		}
	}

	_connectLayerSocket() {
		if (this._reconnecting) return;
		const client = net.createConnection(SOCKET_PATH);
		client.on("connect", () => {
			//console.log("[Overlay] Layer socket connected");
			this._reconnecting = false;
			this._layerSocket = client;
			this._layerSocketReady = true;
		});
		client.on("error", (e) => {
			console.warn("[Overlay] Layer socket error:", e.message);
			client.destroy();
		});
		client.on("close", () => {
			//console.log("[Overlay] Layer socket closed, reconnecting in 2s");
			this._layerSocketReady = false;
			this._layerSocket = null;
			if (!this._reconnecting) {
				this._reconnecting = true;
				setTimeout(() => {
					this._reconnecting = false;
					this._connectLayerSocket();
				}, 2000);
			}
		});
	}

	_signalLayer() {
		if (this._layerSocketReady && this._layerSocket) {
			try {
				this._layerSocket.write("FRAME_UPDATE");
			} catch (e) {}
			return;
		}
		if (this._signalingPending) return;
		this._signalingPending = true;
		const client = net.createConnection(SOCKET_PATH);
		client.on("connect", () => {
			client.write("FRAME_UPDATE", () => {
				client.destroy();
				this._signalingPending = false;
			});
		});
		client.on("error", () => {
			client.destroy();
			this._signalingPending = false;
		});
	}

	async _loadAvatar(userId, avatarHash) {
		if (!userId) return;
		const key = `${userId}_${avatarHash || "default"}`;
		if (this._avatarCache.has(key)) return;
		this._avatarCache.set(key, null);

		let url;
		if (avatarHash) {
			const ext = avatarHash.startsWith("a_") ? "gif" : "png";
			url = `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=128`;
		} else {
			const idx = (BigInt(userId) >> 22n) % 6n;
			url = `https://cdn.discordapp.com/embed/avatars/${idx}.png?size=128`;
		}

		try {
			const image = await loadImage(url);
			this._avatarCache.set(key, image);
			for (const n of this._notifications) {
				if (n.userId === userId) n._canvas = null;
			}
			this._dirty = true;
		} catch (e) {
			console.warn(
				`[Overlay] Failed to load avatar for ${userId}:`,
				e.message
			);
			this._avatarCache.set(key, false);
		}
	}

	_getAvatar(userId, avatarHash) {
		if (!userId) return null;
		const key = `${userId}_${avatarHash || "default"}`;
		const cached = this._avatarCache.get(key);
		return cached || null;
	}

	addNotification(data) {
		const notif = {
			message: data.message || "",
			sender: data.sender || null,
			channel: data.channel || null,
			server: data.server || null,
			userId: data.userId || null,
			avatarHash: data.avatarHash || null,
			isDM: !!data.isDM,
			type: data.type || "generic",
			createdAt: Date.now(),
			duration: data.duration || 5000,
			_canvas: null,
		};
		this._notifications.unshift(notif);

		if (data.userId) this._loadAvatar(data.userId, data.avatarHash);

		setTimeout(() => this._prebakeNotification(notif), 50);

		this._dirty = true;
		setTimeout(() => {
			this._dirty = true;
			this._renderFrame();
		}, notif.duration - 100);
		setTimeout(() => {
			this._dirty = true;
			this._renderFrame();
		}, notif.duration + 50);
	}

	_prebakeNotification(notif) {
		const shadowBlur = this._px(12);
		const shadowOffsetY = this._px(6);
		const extraPad = shadowBlur + shadowOffsetY;
		const W = this._width;
		const H = this._height;

		const measure = this._getMeasureCtx();
		const fontSize = 18;
		const lineHeight = this._px(fontSize * 1.15);
		const maxWidth = Math.min(W * 0.35, this._px(450));

		const padX_sender = this._px(14);
		const avatarRadius_n = this._px(20);
		const textStart_n = avatarRadius_n * 2 + this._px(12);
		const boxW_sender = Math.max(
			this._px(260),
			Math.min(
				maxWidth,
				padX_sender + textStart_n + this._px(280) + padX_sender
			)
		);
		const availW_sender =
			boxW_sender - padX_sender - textStart_n - padX_sender;

		let boxW, boxH;
		if (notif.sender) {
			const padY = this._px(10);
			measure.font = this._font(fontSize);
			const msgLines = this._wrapText(
				measure,
				notif.message,
				availW_sender,
				2
			);
			boxW = boxW_sender;
			boxH =
				padY +
				lineHeight +
				this._px(6) +
				lineHeight * msgLines.length +
				padY;
		} else {
			const padY = this._px(14);
			measure.font = this._font(fontSize);
			const msgLines = this._wrapText(
				measure,
				notif.message,
				maxWidth - this._px(48),
				2
			);
			const msgWidth = Math.max(
				...msgLines.map((l) => measure.measureText(l).width)
			);
			boxW = Math.max(
				this._px(160),
				Math.min(maxWidth, this._px(40) + msgWidth + this._px(8))
			);
			boxH =
				padY * 2 +
				lineHeight * msgLines.length +
				(msgLines.length > 1 ? this._px(4) : 0);
		}

		notif._boxW = boxW;
		notif._boxH = boxH;

		const canvasW = boxW + extraPad * 2;
		const canvasH = boxH + extraPad * 2;
		const offscreen = createCanvas(canvasW, canvasH);
		const ctx = offscreen.getContext("2d");
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.textRendering = "geometricPrecision";
		ctx.fontKerning = "normal";

		ctx.translate(extraPad, extraPad);

		const boxX = 0;
		const currentY = 0;
		const cornerRadius = this._px(12);

		if (notif.sender) {
			const padX = padX_sender;
			const padY = this._px(10);
			const avatarRadius = avatarRadius_n;
			const textStart = textStart_n;
			const availW = availW_sender;

			ctx.font = this._font(fontSize);
			const msgLines = this._wrapText(ctx, notif.message, availW, 2);

			let channelStr = "";
			if (notif.isDM) channelStr = "DM";
			else {
				if (notif.channel) channelStr = "#" + notif.channel;
				if (notif.server) {
					if (channelStr) channelStr += " · ";
					channelStr += notif.server;
				}
			}

			ctx.shadowColor = "rgba(0,0,0,0.4)";
			ctx.shadowBlur = shadowBlur;
			ctx.shadowOffsetY = shadowOffsetY;
			this._fillRoundedRect(
				ctx,
				boxX,
				currentY,
				boxW,
				boxH,
				cornerRadius,
				"#151417"
			);
			ctx.shadowColor = "transparent";

			const avatarImage = this._getAvatar(notif.userId, notif.avatarHash);
			this._drawAvatar(
				ctx,
				boxX + padX + avatarRadius,
				currentY + padY + avatarRadius,
				avatarRadius,
				avatarImage,
				notif.sender
			);

			const textX = boxX + padX + textStart;
			ctx.textAlign = "left";
			ctx.textBaseline = "top";

			ctx.font = this._font(fontSize, 500);
			ctx.fillStyle = "#f2f3f5";
			const truncName = this._truncate(ctx, notif.sender, availW * 0.55);
			ctx.fillText(truncName, textX, currentY + padY);

			if (channelStr) {
				const nameWidth = ctx.measureText(truncName).width;
				ctx.font = this._font(fontSize - 4);
				ctx.fillStyle = "#949ba4";
				const channelAvailW = availW - nameWidth - this._px(12);
				if (channelAvailW > this._px(20))
					ctx.fillText(
						this._truncate(ctx, channelStr, channelAvailW),
						textX + nameWidth + this._px(10),
						currentY + padY + this._px(4)
					);
			}

			ctx.font = this._font(fontSize);
			ctx.fillStyle = "#dbdee1";
			msgLines.forEach((line, i) => {
				ctx.fillText(
					line,
					textX,
					currentY + padY + lineHeight + this._px(2) + lineHeight * i
				);
			});
		} else {
			const padX = this._px(20);
			const padY = this._px(14);

			ctx.font = this._font(fontSize);
			const msgLines = this._wrapText(
				ctx,
				notif.message,
				maxWidth - padX * 2,
				2
			);
			const msgWidth = Math.max(
				...msgLines.map((l) => ctx.measureText(l).width)
			);
			const actualBoxW = Math.max(
				this._px(160),
				Math.min(maxWidth, padX * 2 + msgWidth + this._px(8))
			);

			ctx.shadowColor = "rgba(0,0,0,0.4)";
			ctx.shadowBlur = shadowBlur;
			ctx.shadowOffsetY = shadowOffsetY;
			this._fillRoundedRect(
				ctx,
				boxX,
				currentY,
				actualBoxW,
				boxH,
				cornerRadius,
				notif.type === "system" ? "#111214" : "#1e1f22"
			);
			ctx.shadowColor = "transparent";

			this._fillRoundedRect(
				ctx,
				boxX,
				currentY,
				this._px(4),
				boxH,
				this._px(4),
				notif.type === "system" ? "#5865F2" : "#80848e"
			);

			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			ctx.fillStyle = notif.type === "system" ? "#e3e5e8" : "#dbdee1";
			msgLines.forEach((line, i) => {
				ctx.fillText(
					line,
					boxX + padX,
					currentY + padY + (lineHeight + this._px(4)) * i
				);
			});
		}

		notif._canvas = offscreen;
		notif._extraPad = extraPad;
		this._dirty = true;
	}

	voiceJoin(data) {
		if (!data || !data.uid) return;
		this._voiceUsers = this._voiceUsers.filter((u) => u.id !== data.uid);
		this._voiceUsers.push({
			id: data.uid,
			username: data.username || data.uid,
			avatarHash: data.avatarHash || null,
			muted: !!data.muted,
			deafened: !!data.deafened,
			speaking: false,
		});

		if (data.uid) this._loadAvatar(data.uid, data.avatarHash);
		this._invalidateVoicePanel();
	}

	voiceLeave({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			const key = `${uid}_${user.avatarHash || "default"}`;
			this._avatarCache.delete(key);
		}
		this._voiceUsers = this._voiceUsers.filter((u) => u.id !== uid);
		this._invalidateVoicePanel();
	}

	voiceUpdateAvatar({ uid, avatarHash }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user && avatarHash && user.avatarHash !== avatarHash) {
			const oldKey = `${uid}_${user.avatarHash || "default"}`;
			this._avatarCache.delete(oldKey);
			user.avatarHash = avatarHash;
			this._loadAvatar(uid, avatarHash);
			this._invalidateVoicePanel();
		}
	}

	voiceMuted({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.muted = true;
			this._invalidateVoicePanel();
		}
	}

	voiceUnmuted({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.muted = false;
			this._invalidateVoicePanel();
		}
	}

	voiceDeafened({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.deafened = true;
			this._invalidateVoicePanel();
		}
	}

	voiceUndeafened({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.deafened = false;
			this._invalidateVoicePanel();
		}
	}

	voiceStartedSpeaking({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.speaking = true;
			this._invalidateVoicePanel();
		}
	}

	voiceStoppedSpeaking({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.speaking = false;
			this._invalidateVoicePanel();
		}
	}

	voiceClear() {
		this._voiceUsers = [];
		this._invalidateVoicePanel();
	}

	_markDirty() {
		this._dirty = true;
		this._scheduleRender();
	}

	_scheduleRender() {
		if (this._renderPending) return;
		this._renderPending = true;
		setTimeout(() => {
			this._renderPending = false;
			try {
				this._renderFrame();
			} catch (e) {
				console.error("[Overlay] Render error:", e);
			}
		}, 16);
	}

	_armHeartbeat() {
		if (this._heartbeatTimer) {
			//console.log("[Overlay] Heartbeat already armed, skipping");
			return;
		}
		//console.log("[Overlay] Heartbeat armed");
		this._heartbeatTimer = setInterval(() => {
			if (this._wasEmpty) return;
			this._dirty = true;
			this._renderFrame();
		}, 2000);
	}

	_renderFrame() {
		if (!this._initialized) return;

		const now = Date.now();
		this._currentDt = Math.min((now - this._lastFrameTime) / 1000, 0.033);
		if (this._currentDt <= 0) this._currentDt = 0.016;
		this._lastFrameTime = now;

		if (!this._lastGameResTime || now - this._lastGameResTime > 1000) {
			this._lastGameResTime = now;
			const gameRes = this._readGameResolution();
			if (
				gameRes &&
				(gameRes.width !== this._width ||
					gameRes.height !== this._height)
			) {
				console.log(
					`[Overlay] Resolution changed to ${gameRes.width}x${gameRes.height}, recreating canvas`
				);
				this._recreateCanvas(gameRes.width, gameRes.height);
			}
		}

		const prevCount = this._notifications.length;
		this._notifications = this._notifications.filter(
			(n) => now - n.createdAt < n.duration
		);
		if (this._notifications.length !== prevCount) this._markDirty();

		const next = this._notifications.reduce((min, n) => {
			const expiresIn = n.createdAt + n.duration - now;
			return Math.min(min, expiresIn);
		}, Infinity);
		if (next < Infinity && next > 0) {
			setTimeout(() => this._markDirty(), next + 16);
		}

		for (const n of this._notifications) {
			const elapsed = now - n.createdAt;
			const remaining = n.duration - elapsed;
			if (elapsed < 300 || remaining < 500) {
				this._dirty = true;
				setTimeout(() => {
					this._dirty = true;
					this._renderFrame();
				}, 16);
				break;
			}
		}

		if (!this._dirty) {
			// console.log("[Overlay] renderFrame > not dirty, skipping");
			return;
		}
		this._dirty = false;

		const isEmpty =
			this._notifications.length === 0 && this._voiceUsers.length === 0;
		//console.log(`[Overlay] Rendering > isEmpty:${isEmpty} wasEmpty:${this._wasEmpty} notifs:${this._notifications.length} voice:${this._voiceUsers.length}`);

		if (isEmpty && this._wasEmpty) return;
		this._wasEmpty = isEmpty;

		const ctx = this._ctx;
		const w = this._width;
		const h = this._height;

		ctx.clearRect(0, 0, this._width, this._height);
		this._drawNotifications(ctx, this._width, this._height);
		this._drawVoicePanel(ctx, this._width, this._height);

		const bufW = this._canvas.width;
		const bufH = this._canvas.height;

		let pixelBuf;
		if (typeof this._canvas.data === "function") {
			pixelBuf = this._canvas.data();
		} else {
			pixelBuf = Buffer.from(
				ctx.getImageData(0, 0, bufW, bufH).data.buffer
			);
		}

		if (this._writeShm(pixelBuf, bufW, bufH)) {
			this._signalLayer();
		}
	}

	_px(base) {
		return Math.round(base * this._scale);
	}

	_font(size, weight = 500) {
		if (typeof weight === "boolean") weight = weight ? 500 : 400;
		const cacheKey = `${size}_${weight}`;
		if (this._fontCache[cacheKey]) return this._fontCache[cacheKey];

		let family;
		if (fontFamily.startsWith("Source Sans 3 W")) {
			const available = [400, 500, 600, 700, 500];
			const snapped = available.reduce((prev, cur) =>
				Math.abs(cur - weight) < Math.abs(prev - weight) ? cur : prev
			);
			family = `"${fontWeights[snapped]}", sans-serif`;
			weight = 400;
		} else {
			family = `"${fontFamily}", sans-serif`;
		}

		const fontStr = `${weight} ${this._px(size)}px/${this._px(size * 1.2)}px ${family}`;
		this._fontCache[cacheKey] = fontStr;
		return fontStr;
	}

	_getNotifAlpha(notif) {
		const elapsed = Date.now() - notif.createdAt;
		const remaining = notif.duration - elapsed;
		let alpha = 1.0;
		if (elapsed < 200) alpha = elapsed / 200;
		if (remaining < 100) alpha = Math.min(alpha, remaining / 100);
		return Math.max(0, Math.min(1, alpha));
	}

	_roundedRectPath(ctx, x, y, w, h, r) {
		if (w <= 0 || h <= 0) return;
		r = Math.min(r, w / 2, h / 2);
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.lineTo(x + w - r, y);
		ctx.quadraticCurveTo(x + w, y, x + w, y + r);
		ctx.lineTo(x + w, y + h - r);
		ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
		ctx.lineTo(x + r, y + h);
		ctx.quadraticCurveTo(x, y + h, x, y + h - r);
		ctx.lineTo(x, y + r);
		ctx.quadraticCurveTo(x, y, x + r, y);
		ctx.closePath();
	}

	_fillRoundedRect(ctx, x, y, w, h, r, color) {
		this._roundedRectPath(ctx, x, y, w, h, r);
		ctx.fillStyle = color;
		ctx.fill();
	}

	_drawAvatar(ctx, centerX, centerY, radius, image, fallback) {
		ctx.save();
		ctx.beginPath();
		ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);

		if (image) {
			ctx.clip();
			ctx.drawImage(
				image,
				centerX - radius,
				centerY - radius,
				radius * 2,
				radius * 2
			);
		} else {
			// djb2 hash for determiniuystic palette color from fallback str
			let hashVal = 5381;
			for (let i = 0; i < fallback.length; i++)
				hashVal =
					((hashVal << 5) + hashVal + fallback.charCodeAt(i)) >>> 0;
			const palette = [
				[113, 140, 219],
				[84, 184, 148],
				[245, 148, 69],
				[232, 92, 92],
				[166, 128, 209],
				[61, 181, 184],
				[240, 181, 66],
				[219, 113, 171],
			];
			const [cr, cg, cb] = palette[hashVal % palette.length];

			ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
			ctx.fill();

			if (fallback.length > 0) {
				ctx.fillStyle = "#ffffff";
				ctx.font = this._font(Math.max(10, radius * 0.85), 500);
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(
					fallback[0].toUpperCase(),
					centerX,
					centerY + this._px(1)
				);
			}
		}
		ctx.restore();
	}

	_wrapText(ctx, text, maxWidth, maxLines) {
		if (!text) return [""];

		const words = text.split(" ");
		const lines = [];
		let current = "";

		for (const word of words) {
			if (lines.length >= maxLines - 1) break;
			const test = current ? current + " " + word : word;
			if (ctx.measureText(test).width <= maxWidth) {
				current = test;
			} else {
				if (current) lines.push(current);
				current = word;
			}
		}

		const remaining = words.slice(
			lines.reduce((acc, l) => acc + l.split(" ").length, 0)
		);
		const lastLine = remaining.join(" ");
		if (lastLine) lines.push(this._truncate(ctx, lastLine, maxWidth));
		else if (current) lines.push(this._truncate(ctx, current, maxWidth));

		if (lines.length === 0) lines.push(this._truncate(ctx, text, maxWidth));

		return lines;
	}

	_truncate(ctx, text, maxWidth) {
		if (!text || maxWidth <= 0) return "";
		if (ctx.measureText(text).width <= maxWidth) return text;
		const ellipsisWidth = ctx.measureText("…").width;
		const availWidth = maxWidth - ellipsisWidth;
		if (availWidth <= 0) return "…";
		let lo = 0,
			hi = text.length,
			best = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (ctx.measureText(text.substring(0, mid)).width <= availWidth) {
				best = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return text.substring(0, best) + "…";
	}

	// https://pomax.github.io/bezierinfo/
	_cubicBezierEase(t) {
		const p1x = 0.2,
			p1y = 0.0;
		const p2x = 0.0,
			p2y = 1.3;

		let bt = t;
		for (let i = 0; i < 8; i++) {
			const x =
				3 * bt * (1 - bt) * (1 - bt) * p1x +
				3 * bt * bt * (1 - bt) * p2x +
				bt * bt * bt -
				t;
			const dx =
				3 * (1 - bt) * (1 - bt) * p1x +
				6 * bt * (1 - bt) * (p2x - p1x) +
				3 * bt * bt * (1 - p2x);
			if (Math.abs(dx) < 1e-6) break;
			bt -= x / dx;
		}
		bt = Math.max(0, Math.min(1, bt));

		return (
			3 * bt * (1 - bt) * (1 - bt) * p1y +
			3 * bt * bt * (1 - bt) * p2y +
			bt * bt * bt
		);
	}

	_drawNotifications(ctx, W, H) {
		if (this._notifications.length === 0) return;

		const slot = this._layout.notifications || "top-left";
		const stackDir = notifStackDirection(slot);
		const margin = this._px(24);
		const spacing = this._px(12);
		const fontSize = 18;
		const lineHeight = this._px(fontSize * 1.15);
		const maxWidth = Math.min(W * 0.35, this._px(450));

		const padX_sender = this._px(14);
		const avatarRadius_n = this._px(20);
		const textStart_n = avatarRadius_n * 2 + this._px(12);
		const boxW_sender = Math.max(
			this._px(260),
			Math.min(
				maxWidth,
				padX_sender + textStart_n + this._px(280) + padX_sender
			)
		);
		const availW_sender =
			boxW_sender - padX_sender - textStart_n - padX_sender;

		const visible = [];
		for (const notif of this._notifications) {
			if (visible.length >= 4) break;
			const alpha = this._getNotifAlpha(notif);
			if (alpha <= 0.01) continue;

			let boxH = notif._boxH;
			if (!boxH) {
				if (notif.sender) {
					const padY = this._px(10);
					ctx.font = this._font(fontSize, 400);
					const msgLines = this._wrapText(
						ctx,
						notif.message,
						availW_sender,
						2
					);
					boxH =
						padY +
						lineHeight +
						this._px(6) +
						lineHeight * msgLines.length +
						padY;
				} else {
					const padY = this._px(14);
					ctx.font = this._font(fontSize, 400);
					const msgLines = this._wrapText(
						ctx,
						notif.message,
						maxWidth - this._px(48),
						2
					);
					boxH =
						padY * 2 +
						lineHeight * msgLines.length +
						(msgLines.length > 1 ? this._px(4) : 0);
				}
				notif._boxH = boxH;
			}

			visible.push({ notif, boxH, alpha });
		}

		const totalW = Math.max(boxW_sender, this._px(260));

		if (stackDir === "down") {
			let runningY = margin;
			for (const item of visible) {
				item.targetY = runningY;
				runningY += item.boxH + spacing;
			}
		} else {
			let runningY = H - margin;
			for (const item of visible) {
				runningY -= item.boxH;
				item.targetY = runningY;
				runningY -= spacing;
			}
		}

		const slotOriginX = resolveSlotOrigin(slot, totalW, 0, W, H, margin).x;

		for (const { notif, targetY, boxH, alpha } of visible) {
			if (notif._animY === undefined) {
				notif._animY = stackDir === "down" ? -boxH : H + boxH;
				notif._velY = 0;
			}

			const stiffness = 160;
			const damping = 16;
			const dt = Math.min((this._currentDt || 0.016) * 1.5, 0.05);

			const springF = (targetY - notif._animY) * stiffness;
			const dampF = -notif._velY * damping;
			notif._velY += (springF + dampF) * dt;
			notif._animY += notif._velY * dt;

			const settled =
				Math.abs(notif._animY - targetY) < 0.5 &&
				Math.abs(notif._velY) < 1.0;
			if (!settled) this._markDirty();

			ctx.save();
			ctx.globalAlpha = alpha;
			if (notif._canvas) {
				ctx.drawImage(
					notif._canvas,
					slotOriginX - notif._extraPad,
					notif._animY - notif._extraPad
				);
			} else {
				this._prebakeNotification(notif);
			}
			ctx.restore();
		}
	}

	_invalidateVoicePanel() {
		this._voicePanelCanvas = null;
		this._markDirty();
	}

	_getMeasureCtx() {
		if (!this._measureCtx)
			this._measureCtx = createCanvas(1, 1).getContext("2d");
		return this._measureCtx;
	}

	_buildVoicePanelCanvas() {
		if (!this._voiceUsers || this._voiceUsers.length === 0) return null;

		const margin = this._px(20);
		const padX = this._px(12);
		const padY = this._px(10);
		const fontSize = 16;
		const lineHeight = this._px(fontSize * 1.3);
		const avatarRadius = this._px(18);
		const avatarPad = this._px(18);
		const iconSize = this._px(24);
		const iconPad = this._px(6);
		const rowHeight = avatarRadius * 2 + this._px(8);
		const rowGap = this._px(4);

		const measure = this._getMeasureCtx();
		measure.font = this._font(fontSize, 500);
		let maxNameWidth = 0;
		for (const user of this._voiceUsers) {
			const w =
				measure.measureText(user.username).width +
				iconSize +
				this._px(8);
			if (w > maxNameWidth) maxNameWidth = w;
		}

		const panelW = Math.max(
			this._px(320),
			Math.min(
				this._width * 0.5,
				padX +
					avatarRadius * 2 +
					avatarPad +
					maxNameWidth +
					padX +
					this._px(8)
			)
		);
		const panelH =
			padY +
			this._voiceUsers.length * rowHeight +
			(this._voiceUsers.length > 1
				? (this._voiceUsers.length - 1) * rowGap
				: 0) +
			padY;

		const offscreen = createCanvas(panelW + margin, panelH + margin);
		const ctx = offscreen.getContext("2d");
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.textRendering = "geometricPrecision";

		let rowY = padY;

		for (const user of this._voiceUsers) {
			const name = user.username || "Unknown";
			const avatarCX = padX + avatarRadius;
			const avatarCY = rowY + rowHeight * 0.5;

			if (user.speaking) {
				ctx.beginPath();
				ctx.arc(
					avatarCX,
					avatarCY,
					avatarRadius + this._px(2.5),
					0,
					Math.PI * 2
				);
				ctx.strokeStyle = "#23a559";
				ctx.lineWidth = this._px(2);
				ctx.stroke();
			}

			const rowAlpha = user.speaking ? 1.0 : 0.6;
			const avatarAlpha = user.deafened || user.muted ? 0.6 : 1.0;
			ctx.globalAlpha = rowAlpha * avatarAlpha;
			this._drawAvatar(
				ctx,
				avatarCX,
				avatarCY,
				avatarRadius,
				this._getAvatar(user.id, user.avatarHash),
				name
			);
			ctx.globalAlpha = 1.0;

			const textX = padX + avatarRadius * 2 + avatarPad;
			const textAvailW =
				panelW - padX - avatarRadius * 2 - avatarPad - padX;

			ctx.font = this._font(fontSize, 400);

			const iconsToShow = [];
			if (user.deafened) {
				iconsToShow.push({ name: ICON_MUTED, color: "#d3d3d3" });
				iconsToShow.push({ name: ICON_DEAFENED, color: "#d3d3d3" });
			} else if (user.muted) {
				iconsToShow.push({ name: ICON_MUTED, color: "#d3d3d3" });
			}

			const iconSpace =
				iconsToShow.length > 0
					? iconsToShow.length * (iconSize + iconPad)
					: 0;
			const truncName = this._truncate(ctx, name, textAvailW - iconSpace);
			const measuredNameW = ctx.measureText(truncName).width;

			const textBgPadX = this._px(10);
			const textBgPadY = this._px(4);
			const textBgX = textX - textBgPadX;
			const textBgH = lineHeight + textBgPadY * 2;
			const textBgY = avatarCY - textBgH * 0.5;
			const textBgW = measuredNameW + iconSpace + textBgPadX * 2;
			const pillR = textBgH / 2;

			ctx.globalAlpha = rowAlpha;
			ctx.beginPath();
			ctx.arc(
				textBgX + pillR,
				textBgY + pillR,
				pillR,
				Math.PI * 0.5,
				Math.PI * 1.5
			);
			ctx.arc(
				textBgX + textBgW - pillR,
				textBgY + pillR,
				pillR,
				Math.PI * 1.5,
				Math.PI * 0.5
			);
			ctx.closePath();
			ctx.fillStyle = "rgba(0,0,0,0.55)";
			ctx.fill();
			ctx.strokeStyle = "rgba(0,0,0,0.75)";
			ctx.lineWidth = this._px(1);
			ctx.stroke();

			ctx.textAlign = "left";
			ctx.textBaseline = "middle";
			ctx.fillStyle = "rgba(255,255,255,1)";
			ctx.fillText(truncName, textX, avatarCY);

			if (iconsToShow.length > 0) {
				const nameW = ctx.measureText(truncName).width;
				let iconOffsetX = textX + nameW + iconPad;
				for (const icon of iconsToShow) {
					this._drawIcon(
						ctx,
						icon.name,
						iconOffsetX + iconSize / 2,
						avatarCY,
						iconSize,
						icon.color
					);
					iconOffsetX += iconSize + iconPad;
				}
			}
			ctx.globalAlpha = 1.0;
			rowY += rowHeight + rowGap;
		}

		return { canvas: offscreen, panelW, panelH };
	}

	_drawVoicePanel(ctx, W, H) {
		if (!this._voiceUsers || this._voiceUsers.length === 0) return;
		if (!this._voicePanelCanvas) {
			this._voicePanelCanvas = this._buildVoicePanelCanvas();
		}
		if (!this._voicePanelCanvas) return;

		const { canvas, panelW, panelH } = this._voicePanelCanvas;
		const slot = this._layout.voicePanel || "bottom-left";
		const margin = this._px(20);

		const { x, y } = resolveSlotOrigin(slot, panelW, panelH, W, H, margin);

		ctx.drawImage(canvas, x, y);
	}
}

const renderer = new OverlayRenderer();

parentPort.on("message", async (msg) => {
	switch (msg.type) {
		case "INIT": {
			const success = await renderer.init(
				msg.payload.width,
				msg.payload.height,
				msg.payload.assetsDir,
				msg.payload.layout ?? null
			);
			parentPort.postMessage({ type: "INIT_DONE", success });
			break;
		}
		case "LAYOUT_UPDATE":
			renderer.setLayout(msg.payload);
			break;
		case "DESTROY":
			renderer.destroy();
			process.exit(0);
			break;
		case "ADD_NOTIFICATION":
			renderer.addNotification(msg.payload);
			break;
		case "VOICE_JOIN":
			renderer.voiceJoin(msg.payload);
			break;
		case "VOICE_LEAVE":
			renderer.voiceLeave(msg.payload);
			break;
		case "VOICE_UPDATE_AVATAR":
			renderer.voiceUpdateAvatar(msg.payload);
			break;
		case "VOICE_MUTED":
			renderer.voiceMuted(msg.payload);
			break;
		case "VOICE_UNMUTED":
			renderer.voiceUnmuted(msg.payload);
			break;
		case "VOICE_DEAFENED":
			renderer.voiceDeafened(msg.payload);
			break;
		case "VOICE_UNDEAFENED":
			renderer.voiceUndeafened(msg.payload);
			break;
		case "VOICE_STARTED_SPEAKING":
			renderer.voiceStartedSpeaking(msg.payload);
			break;
		case "VOICE_STOPPED_SPEAKING":
			renderer.voiceStoppedSpeaking(msg.payload);
			break;
		case "VOICE_CLEAR":
			renderer.voiceClear();
			break;
	}
});
