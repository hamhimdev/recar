const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const net = require("net");
const fs = require("fs");
const path = require("path");

let fontFamily = "sans-serif";

function initFonts(assetsDir) {
	const fontDir = assetsDir ? path.join(assetsDir, "font") : null;

	const bundledFonts = fontDir
		? [
				{
					filename: "SourceSans3-VariableFont_wght.ttf",
					familyName: "Source Sans 3",
				},
				{
					filename: "SourceSans3-Italic-VariableFont_wght.ttf",
					familyName: "Source Sans 3",
				},
			]
		: [];

	for (const { filename, familyName } of bundledFonts) {
		const fontPath = path.join(fontDir, filename);
		if (fs.existsSync(fontPath)) {
			try {
				GlobalFonts.registerFromPath(fontPath, familyName);
				fontFamily = familyName;
				console.log(`[Overlay] Loaded font: ${fontPath}`);
			} catch (e) {
				console.warn(`[Overlay] Failed to load ${fontPath}:`, e.message);
			}
		}
	}

	if (fontFamily !== "sans-serif") return;

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
const SOCKET_PATH = "/tmp/recar_overlay.sock";

class OverlayRenderer {
	constructor() {
		this._shmFd = -1;
		this._headerBuf = null;
		this._readBuf = null;
		this._canvas = null;
		this._ctx = null;
		this._width = 0;
		this._height = 0;
		this._dirty = false;
		this._renderTimer = null;
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
	}

	async init(width = 1920, height = 1080, assetsDir = null) {
		if (process.platform !== "linux") return false;

		this._assetsDir = assetsDir;
		initFonts(assetsDir);
		this._loadIconSvgs();

		this._width = Math.min(width, SHM_MAX_WIDTH);
		this._height = Math.min(height, SHM_MAX_HEIGHT);
		this._updateScale();

		if (!this._openShm()) return false;

		this._recreateCanvas(this._width, this._height);
		this._initialized = true;

		this._renderTimer = setInterval(() => {
			try {
				this._renderFrame();
			} catch (e) {
				console.error("[Overlay] Render error:", e);
			}
		}, 33);

		return true;
	}

	destroy() {
		if (this._renderTimer) clearInterval(this._renderTimer);
		if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
		this._closeShm();
		this._initialized = false;
	}

	_updateScale() {
		this._scale = Math.max(1.0, this._width / 1920);
	}

	_recreateCanvas(width, height) {
		this._width = width;
		this._height = height;
		this._updateScale();
		this._canvas = createCanvas(width, height);
		this._ctx = this._canvas.getContext("2d");
		this._iconCache.clear();
		this._iconLoading.clear();
		this._dirty = true;
	}

	_loadIconSvgs() {
		if (!this._assetsDir) return;

		const icons = {
			[ICON_MUTED]: "muted.svg",
			[ICON_DEAFENED]: "deafened.svg",
		};

		for (const [name, filename] of Object.entries(icons)) {
			const svgPath = path.join(this._assetsDir, "img", "overlay", filename);
			if (!fs.existsSync(svgPath)) {
				console.warn(`[Overlay] Icon not found: ${svgPath}`);
				continue;
			}
			try {
				const svgData = fs.readFileSync(svgPath, "utf-8");
				this._svgCache.set(name, svgData);
				console.log(`[Overlay] Loaded SVG source: ${filename}`);
			} catch (e) {
				console.warn(`[Overlay] Failed to read ${filename}:`, e.message);
			}
		}
	}

	async _renderIcon(iconName, size, color) {
		const cacheKey = `${iconName}_${size}_${color}`;
		if (this._iconCache.has(cacheKey) || this._iconLoading.has(cacheKey)) return;

		const svgSource = this._svgCache.get(iconName);
		if (!svgSource) return;

		this._iconLoading.add(cacheKey);

		try {
			// strp existing fill attr from <svg> tag, set explicit w/h
			// then prepend a new fill attr so all child paths inherit it
			let svg = svgSource;
			svg = svg.replace(/(<svg[^>]*)\sfill="[^"]*"/i, "$1");
			svg = svg.replace(/width="[^"]*"/, `width="${size}"`);
			svg = svg.replace(/height="[^"]*"/, `height="${size}"`);
			svg = svg.replace(/<svg/, `<svg fill="${color}"`);

			// svg -> temp cvs -> png buff -> img
			// why? bc napi-rs is a prick with direct svg rendering :p
			const tempCanvas = createCanvas(size, size);
			const tempCtx = tempCanvas.getContext("2d");
			const svgImage = await loadImage(Buffer.from(svg));
			tempCtx.drawImage(svgImage, 0, 0, size, size);
			const pngBuffer = tempCanvas.toBuffer("image/png");
			const finalImage = await loadImage(pngBuffer);

			this._iconCache.set(cacheKey, finalImage);
			this._dirty = true;
		} catch (e) {
			console.warn(`[Overlay] Failed to render icon ${iconName}:`, e.message);
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
					const chunk = Math.min(zeroBuf.length, SHM_TOTAL_SIZE - written);
					fs.writeSync(fd, zeroBuf, 0, chunk);
					written += chunk;
				}
			}
			if (fs.fstatSync(fd).size < SHM_TOTAL_SIZE) fs.ftruncateSync(fd, SHM_TOTAL_SIZE);

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
			if (width > 0 && height > 0 && width <= SHM_MAX_WIDTH && height <= SHM_MAX_HEIGHT)
				return { width, height };
		} catch {}
		return null;
	}

	_writeShm(pixelBuf) {
		if (this._shmFd < 0) return false;
		try {
			this._headerBuf[0] = SHM_STATE_WRITING;
			this._headerBuf.writeUInt32LE(this._width, 4);
			this._headerBuf.writeUInt32LE(this._height, 8);
			fs.writeSync(this._shmFd, this._headerBuf, 0, 16, 0);
			fs.writeSync(this._shmFd, pixelBuf, 0, pixelBuf.length, SHM_HEADER_SIZE);
			this._headerBuf[0] = SHM_STATE_READY;
			fs.writeSync(this._shmFd, this._headerBuf, 0, 1, 0);
			return true;
		} catch (e) {
			return false;
		}
	}

	_signalLayer() {
		const client = net.createConnection(SOCKET_PATH, () => {
			client.write('{"op":"FRAME_UPDATE"}');
			client.end();
		});
		client.on("error", () => {});
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
			this._dirty = true;
		} catch (e) {
			console.warn(
				`[Overlay] Failed to load avatar for ${userId}:`,
				e.message
			);
			this._avatarCache.delete(key);
		}
	}

	_getAvatar(userId, avatarHash) {
		if (!userId) return null;
		const key = `${userId}_${avatarHash || "default"}`;
		return this._avatarCache.get(key) || null;
	}

	addNotification(data) {
		this._notifications.push({
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
		});

		if (data.userId) this._loadAvatar(data.userId, data.avatarHash);
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
		this._dirty = true;
	}

	voiceLeave({ uid }) {
		this._voiceUsers = this._voiceUsers.filter((u) => u.id !== uid);
		this._dirty = true;
	}

	voiceUpdateAvatar({ uid, avatarHash }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user && avatarHash && user.avatarHash !== avatarHash) {
			user.avatarHash = avatarHash;
			this._loadAvatar(uid, avatarHash);
			this._dirty = true;
		}
	}

	voiceMuted({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.muted = true;
			this._dirty = true;
		}
	}

	voiceUnmuted({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.muted = false;
			this._dirty = true;
		}
	}

	voiceDeafened({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.deafened = true;
			this._dirty = true;
		}
	}

	voiceUndeafened({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.deafened = false;
			this._dirty = true;
		}
	}

	voiceStartedSpeaking({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.speaking = true;
			this._dirty = true;
		}
	}

	voiceStoppedSpeaking({ uid }) {
		const user = this._voiceUsers.find((u) => u.id === uid);
		if (user) {
			user.speaking = false;
			this._dirty = true;
		}
	}

	voiceClear() {
		this._voiceUsers = [];
		this._dirty = true;
	}

	_renderFrame() {
		if (!this._initialized) return;

		const gameRes = this._readGameResolution();
		if (gameRes && (gameRes.width !== this._lastWidth || gameRes.height !== this._lastHeight)) {
			this._lastWidth = gameRes.width;
			this._lastHeight = gameRes.height;
			if (gameRes.width !== this._width || gameRes.height !== this._height) {
				if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
				this._resizeDebounce = setTimeout(() => {
					const current = this._readGameResolution();
					if (
						current &&
						current.width === this._lastWidth &&
						current.height === this._lastHeight
					) {
						this._recreateCanvas(current.width, current.height);
					}
					this._resizeDebounce = null;
				}, 200);
			}
		}

		const now = Date.now();
		const prevCount = this._notifications.length;
		this._notifications = this._notifications.filter((n) => now - n.createdAt < n.duration);
		if (this._notifications.length !== prevCount) this._dirty = true;

		for (const n of this._notifications) {
			const elapsed = now - n.createdAt;
			const remaining = n.duration - elapsed;
			if (elapsed < 300 || remaining < 500) {
				this._dirty = true;
				break;
			}
		}

		if (!this._dirty) return;
		this._dirty = false;

		const ctx = this._ctx;
		const w = this._width;
		const h = this._height;

		ctx.clearRect(0, 0, w, h);
		this._drawNotifications(ctx, w, h);
		this._drawVoicePanel(ctx, w, h);

		const imageData = ctx.getImageData(0, 0, w, h);
		const pixelBuf = Buffer.from(imageData.data.buffer);

		if (this._writeShm(pixelBuf)) {
			this._signalLayer();
		}
	}

	_px(base) {
		return Math.round(base * this._scale);
	}

	_font(size, weight = 400) {
		if (typeof weight === "boolean") weight = weight ? 600 : 400;
		return `${weight} ${this._px(size)}px "${fontFamily}", sans-serif`;
	}

	_getNotifAlpha(notif) {
		const elapsed = Date.now() - notif.createdAt;
		const remaining = notif.duration - elapsed;
		let alpha = 1.0;
		if (elapsed < 200) alpha = elapsed / 200;
		if (remaining < 500) alpha = Math.min(alpha, remaining / 500);
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
			ctx.drawImage(image, centerX - radius, centerY - radius, radius * 2, radius * 2);
		} else {
			// djb2 hash for determiniuystic palette color from fallback str
			let hashVal = 5381;
			for (let i = 0; i < fallback.length; i++)
				hashVal = ((hashVal << 5) + hashVal + fallback.charCodeAt(i)) >>> 0;
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
				ctx.font = this._font(Math.max(10, radius * 0.85), 600);
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(fallback[0].toUpperCase(), centerX, centerY + this._px(1));
			}
		}
		ctx.restore();
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

	_drawNotifications(ctx, W, H) {
		if (this._notifications.length === 0) return;

		const margin = this._px(24);
		const cornerRadius = this._px(12);
		const spacing = this._px(12);
		const maxWidth = Math.min(W * 0.35, this._px(450));
		const fontSize = 20;
		const lineHeight = this._px(fontSize * 1.3);
		let y = margin;
		let count = 0;

		for (const notif of this._notifications) {
			if (count >= 4) break;
			const alpha = this._getNotifAlpha(notif);
			if (alpha <= 0.01) continue;

			const elapsed = Date.now() - notif.createdAt;
			const t = Math.min(elapsed / 300, 1);
			const eased = 1 - Math.pow(1 - t, 3);
			const slideX = (1 - eased) * this._px(60);

			ctx.save();
			ctx.globalAlpha = alpha;

			if (notif.sender) {
				const padX = this._px(20),
					padY = this._px(16);
				const avatarRadius = this._px(20);
				const textStart = avatarRadius * 2 + this._px(16);

				ctx.font = this._font(fontSize, 600);
				ctx.font = this._font(fontSize);

				let channelStr = "";
				if (notif.isDM) channelStr = "DM";
				else {
					if (notif.channel) channelStr = "#" + notif.channel;
					if (notif.server) {
						if (channelStr) channelStr += " · ";
						channelStr += notif.server;
					}
				}

				const boxW = Math.max(
					this._px(260),
					Math.min(maxWidth, padX + textStart + this._px(280) + padX)
				);
				const boxH = padY + lineHeight + this._px(6) + lineHeight + padY;
				const boxX = W - boxW - margin + slideX;

				ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
				ctx.shadowBlur = this._px(12);
				ctx.shadowOffsetY = this._px(6);

				this._fillRoundedRect(ctx, boxX, y, boxW, boxH, cornerRadius, "#111214");
				ctx.shadowColor = "transparent";

				this._fillRoundedRect(
					ctx,
					boxX,
					y,
					this._px(4),
					boxH,
					this._px(4),
					notif.isDM ? "#9766de" : "#5865F2"
				);

				const avatarImage = this._getAvatar(notif.userId, notif.avatarHash);
				this._drawAvatar(ctx, boxX + padX + avatarRadius, y + boxH * 0.5, avatarRadius, avatarImage, notif.sender);

				const textX = boxX + padX + textStart;
				const availW = boxW - padX - textStart - padX;

				ctx.textAlign = "left";
				ctx.textBaseline = "top";

				ctx.font = this._font(fontSize, 600);
				ctx.fillStyle = "#f2f3f5";
				const truncName = this._truncate(ctx, notif.sender, availW * 0.55);
				ctx.fillText(truncName, textX, y + padY);

				if (channelStr) {
					const nameWidth = ctx.measureText(truncName).width;
					ctx.font = this._font(fontSize - 4);
					ctx.fillStyle = "#949ba4";
					const channelAvailW = availW - nameWidth - this._px(12);
					if (channelAvailW > this._px(20))
						ctx.fillText(
							this._truncate(ctx, channelStr, channelAvailW),
							textX + nameWidth + this._px(10),
							y + padY + this._px(4)
						);
				}

				ctx.font = this._font(fontSize);
				ctx.fillStyle = "#dbdee1";
				ctx.fillText(
					this._truncate(ctx, notif.message, availW),
					textX,
					y + padY + lineHeight + this._px(4)
				);

				y += boxH + spacing;
			} else {
				const padX = this._px(20),
					padY = this._px(14);

				ctx.font = this._font(fontSize);
				const msgWidth = ctx.measureText(notif.message).width;
				const boxW = Math.max(
					this._px(160),
					Math.min(maxWidth, padX * 2 + msgWidth + this._px(8))
				);
				const boxH = padY * 2 + lineHeight;
				const boxX = W - boxW - margin + slideX;

				ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
				ctx.shadowBlur = this._px(12);
				ctx.shadowOffsetY = this._px(6);

				this._fillRoundedRect(
					ctx,
					boxX,
					y,
					boxW,
					boxH,
					cornerRadius,
					notif.type === "system" ? "#111214" : "#1e1f22"
				);
				ctx.shadowColor = "transparent";

				this._fillRoundedRect(
					ctx,
					boxX,
					y,
					this._px(4),
					boxH,
					this._px(4),
					notif.type === "system" ? "#5865F2" : "#80848e"
				);

				ctx.textAlign = "left";
				ctx.textBaseline = "top";
				ctx.fillStyle = notif.type === "system" ? "#e3e5e8" : "#dbdee1";
				ctx.fillText(
					this._truncate(ctx, notif.message, boxW - padX * 2),
					boxX + padX,
					y + padY
				);

				y += boxH + spacing;
			}

			ctx.restore();
			count++;
		}
	}

	_drawVoicePanel(ctx, W, H) {
		if (!this._voiceUsers || this._voiceUsers.length === 0) return;

		const margin = this._px(20);
		const padX = this._px(12);
		const padY = this._px(10);
		const cornerRadius = this._px(10);
		const fontSize = 16;
		const lineHeight = this._px(fontSize * 1.3);
		const avatarRadius = this._px(14);
		const avatarPad = this._px(10);
		const iconSize = this._px(15);
		const iconPad = this._px(6);
		const rowHeight = avatarRadius * 2 + this._px(8);
		const rowGap = this._px(4);

		ctx.font = this._font(fontSize, 500);
		let maxNameWidth = 0;
		for (const user of this._voiceUsers) {
			const nameWidth = ctx.measureText(user.username).width + iconSize + this._px(8);
			if (nameWidth > maxNameWidth) maxNameWidth = nameWidth;
		}

		const panelW = Math.max(
			this._px(170),
			Math.min(W * 0.22, padX + avatarRadius * 2 + avatarPad + maxNameWidth + padX + this._px(8))
		);
		const panelH =
			padY +
			this._voiceUsers.length * rowHeight +
			(this._voiceUsers.length > 1 ? (this._voiceUsers.length - 1) * rowGap : 0) +
			padY;
		const panelX = margin;
		const panelY = H - panelH - margin;

		ctx.save();

		ctx.shadowColor = "rgba(0, 0, 0, 0.15)";
		ctx.shadowBlur = this._px(8);
		ctx.shadowOffsetY = this._px(2);

		this._fillRoundedRect(ctx, panelX, panelY, panelW, panelH, cornerRadius, "rgba(0, 0, 0, 0.25)");
		ctx.shadowColor = "transparent";

		ctx.globalAlpha = 1.0;

		let rowY = panelY + padY;

		for (const user of this._voiceUsers) {
			const name = user.username || "Unknown";
			const avatarCX = panelX + padX + avatarRadius;
			const avatarCY = rowY + rowHeight * 0.5;

			if (user.speaking) {
				ctx.beginPath();
				ctx.arc(avatarCX, avatarCY, avatarRadius + this._px(2.5), 0, Math.PI * 2);
				ctx.strokeStyle = "#23a559";
				ctx.lineWidth = this._px(2);
				ctx.stroke();
			}

			const avatarAlpha = user.deafened ? 0.4 : user.muted ? 0.65 : 1.0;
			ctx.globalAlpha = avatarAlpha;
			const avatarImage = this._getAvatar(user.id, user.avatarHash);
			this._drawAvatar(ctx, avatarCX, avatarCY, avatarRadius, avatarImage, name);
			ctx.globalAlpha = 1.0;

			const textX = panelX + padX + avatarRadius * 2 + avatarPad;
			const textAvailW = panelW - padX - avatarRadius * 2 - avatarPad - padX;

			let nameColor;
			if (user.speaking) nameColor = "#23a559";
			else if (user.deafened) nameColor = "#da373c";
			else if (user.muted) nameColor = "#f0b232";
			else nameColor = "rgba(255, 255, 255, 0.9)";

			ctx.textAlign = "left";
			ctx.textBaseline = "middle";

			const fontWeight = user.speaking ? 600 : 500;
			ctx.font = this._font(fontSize, fontWeight);
			ctx.fillStyle = nameColor;

			const iconSpace = user.deafened || user.muted ? iconSize + iconPad : 0;
			const truncName = this._truncate(ctx, name, textAvailW - iconSpace);
			ctx.fillText(truncName, textX, avatarCY);

			if (user.deafened || user.muted) {
				const nameW = ctx.measureText(truncName).width;
				const iconX = textX + nameW + iconPad + iconSize / 2;
				const iconY = avatarCY;
				const iconColor = user.deafened ? "#da373c" : "#f0b232";
				const iconName = user.deafened ? ICON_DEAFENED : ICON_MUTED;
				this._drawIcon(ctx, iconName, iconX, iconY, iconSize, iconColor);
			}

			rowY += rowHeight + rowGap;
		}

		ctx.restore();
	}
}

module.exports = { OverlayRenderer };
