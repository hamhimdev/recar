const { createCanvas, GlobalFonts, loadImage } = require("@napi-rs/canvas");
const net = require("net");
const fs = require("fs");
const path = require("path");

let fF = "sans-serif";

function initFn(ad) {
	const fDR = ad ? path.join(ad, "font") : null;

	const bFNs = fDR
		? [
				{
					ff: "SourceSans3-VariableFont_wght.ttf",
					fm: "Source Sans 3",
				},
				{
					ff: "SourceSans3-Italic-VariableFont_wght.ttf",
					fm: "Source Sans 3",
				},
			]
		: [];

	for (const { ff, fm } of bFNs) {
		const fp = path.join(fDR, ff);
		if (fs.existsSync(fp)) {
			try {
				GlobalFonts.registerFromPath(fp, fm);
				fF = fm;
				console.log(`[Overlay] Loaded font: ${fp}`);
			} catch (e) {
				console.warn(`[Overlay] Failed to load ${fp}:`, e.message);
			}
		}
	}

	if (fF !== "sans-serif") return;

	const sFNs = [
		["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVu Sans"],
		["/usr/share/fonts/TTF/DejaVuSans.ttf", "DejaVu Sans"],
		[
			"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
			"Liberation Sans",
		],
		["/usr/share/fonts/noto/NotoSans-Regular.ttf", "Noto Sans"],
	];

	for (const [fp, fm] of sFNs) {
		if (fs.existsSync(fp)) {
			try {
				GlobalFonts.registerFromPath(fp, fm);
				fF = fm;
				console.log(`[Overlay] Loaded system font: ${fp}`);
				return;
			} catch {}
		}
	}
}

const icmcof = "muted";
const ichsof = "deafened";

const shnm = "/recar_overlay";
const shhdsz = 64;
const shmmwt = 3840;
const shmmht = 2160;
const shpxsz = shmmwt * shmmht * 4;
const shttsz = shhdsz + shpxsz;
const shwring = 1;
const shrd = 2;
const scpt = "/tmp/recar_overlay.sock";

class OverlayRenderer {
	constructor() {
		this._shfd = -1;
		this._hdbf = null;
		this._rdbf = null;
		this._cvs = null;
		this._ctx = null;
		this._w = 0;
		this._h = 0;
		this._drt = false;
		this._rtmr = null;
		this._ind = false;
		this._ntfs = [];
		this._vcu = [];
		this._lgw = 0;
		this._lgh = 0;
		this._dsc = 1.0;
		this._rdbc = null;
		this._avc = new Map();
		this._asd = null;
		this._isvg = new Map();
		this._irnd = new Map();
		this._ild = new Set();
	}

	async init(w = 1920, h = 1080, ad = null) {
		if (process.platform !== "linux") return false;

		this._asd = ad;
		initFn(ad);
		this._plIcSvg();

		this._w = Math.min(w, shmmwt);
		this._h = Math.min(h, shmmht);
		this._updSc();

		if (!this._opShm()) return false;

		this._rcCvs(this._w, this._h);
		this._ind = true;

		this._rtmr = setInterval(() => {
			try {
				this._rnFr();
			} catch (e) {
				console.error("[Overlay] Render error:", e);
			}
		}, 33);

		return true;
	}

	destroy() {
		if (this._rtmr) clearInterval(this._rtmr);
		if (this._rdbc) clearTimeout(this._rdbc);
		this._clShm();
		this._ind = false;
	}

	_updSc() {
		this._dsc = Math.max(1.0, this._w / 1920);
	}

	_rcCvs(w, h) {
		this._w = w;
		this._h = h;
		this._updSc();
		this._cvs = createCanvas(w, h);
		this._ctx = this._cvs.getContext("2d");
		this._irnd.clear();
		this._ild.clear();
		this._drt = true;
	}

	_plIcSvg() {
		if (!this._asd) return;

		const ic = {
			[icmcof]: "muted.svg",
			[ichsof]: "deafened.svg",
		};

		for (const [nm, fn] of Object.entries(ic)) {
			const sp = path.join(this._asd, "img", "overlay", fn);
			if (!fs.existsSync(sp)) {
				console.warn(`[Overlay] Icon not found: ${sp}`);
				continue;
			}
			try {
				const sd = fs.readFileSync(sp, "utf-8");
				this._isvg.set(nm, sd);
				console.log(`[Overlay] Loaded SVG source: ${fn}`);
			} catch (e) {
				console.warn(`[Overlay] Failed to read ${fn}:`, e.message);
			}
		}
	}

	async _rnIcImg(icn, sz, cl) {
		const ck = `${icn}_${sz}_${cl}`;
		if (this._irnd.has(ck) || this._ild.has(ck)) return;

		const ss = this._isvg.get(icn);
		if (!ss) return;

		this._ild.add(ck);

		try {
			// strp existing fill attr from <svg> tag, set explicit w/h
			// then prepend a new fill attr so all child paths inherit it
			let sv = ss;
			sv = sv.replace(/(<svg[^>]*)\sfill="[^"]*"/i, "$1");
			sv = sv.replace(/width="[^"]*"/, `width="${sz}"`);
			sv = sv.replace(/height="[^"]*"/, `height="${sz}"`);
			sv = sv.replace(/<svg/, `<svg fill="${cl}"`);

			// svg -> temp cvs -> png buff -> img
			// why? bc napi-rs is a prick with direct svg rendering :p
			const tc = createCanvas(sz, sz);
			const tx = tc.getContext("2d");
			const si = await loadImage(Buffer.from(sv));
			tx.drawImage(si, 0, 0, sz, sz);
			const pb = tc.toBuffer("image/png");
			const fi = await loadImage(pb);

			this._irnd.set(ck, fi);
			this._drt = true;
		} catch (e) {
			console.warn(`[Overlay] Failed to render icon ${icn}:`, e.message);
		} finally {
			this._ild.delete(ck);
		}
	}

	_drIcSn(ctx, icn, x, y, sz, cl) {
		const ck = `${icn}_${sz}_${cl}`;
		const im = this._irnd.get(ck);

		if (im) {
			ctx.drawImage(im, x - sz / 2, y - sz / 2, sz, sz);
			return;
		}

		this._rnIcImg(icn, sz, cl);
		this._drFbIc(ctx, icn, x, y, sz, cl);
	}

	_drFbIc(ctx, icn, x, y, sz, cl) {
		ctx.save();
		const r = sz * 0.35;
		ctx.strokeStyle = cl;
		ctx.lineWidth = Math.max(1.5, sz * 0.12);
		ctx.lineCap = "round";

		if (icn === icmcof) {
			ctx.beginPath();
			ctx.arc(x, y - sz * 0.1, r * 0.55, Math.PI, 0);
			ctx.lineTo(x + r * 0.55, y + sz * 0.05);
			ctx.arc(x, y + sz * 0.05, r * 0.55, 0, Math.PI);
			ctx.closePath();
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(x - r, y + r);
			ctx.lineTo(x + r, y - r);
			ctx.stroke();
		} else if (icn === ichsof) {
			ctx.beginPath();
			ctx.arc(x, y, r, Math.PI * 1.15, Math.PI * 1.85);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(x - r, y + r);
			ctx.lineTo(x + r, y - r);
			ctx.stroke();
		}
		ctx.restore();
	}

	_opShm() {
		try {
			const sp = `/dev/shm${shnm}`;
			let fd;
			try {
				fd = fs.openSync(sp, "r+");
			} catch {
				fd = fs.openSync(sp, "w+");
				const zb = Buffer.alloc(4096);
				let wr = 0;
				while (wr < shttsz) {
					const ch = Math.min(zb.length, shttsz - wr);
					fs.writeSync(fd, zb, 0, ch);
					wr += ch;
				}
			}
			if (fs.fstatSync(fd).size < shttsz) fs.ftruncateSync(fd, shttsz);

			this._shfd = fd;
			this._hdbf = Buffer.alloc(shhdsz);
			this._rdbf = Buffer.alloc(shhdsz);
			return true;
		} catch (e) {
			console.error("[Overlay] shm open failed:", e);
			return false;
		}
	}

	_clShm() {
		if (this._shfd >= 0) {
			try {
				fs.closeSync(this._shfd);
			} catch {}
			this._shfd = -1;
		}
	}

	_rdGmRes() {
		if (this._shfd < 0) return null;
		try {
			fs.readSync(this._shfd, this._rdbf, 0, shhdsz, 0);
			const w = this._rdbf.readUInt32LE(16);
			const h = this._rdbf.readUInt32LE(20);
			if (w > 0 && h > 0 && w <= shmmwt && h <= shmmht)
				return { width: w, height: h };
		} catch {}
		return null;
	}

	_wrShm(pb) {
		if (this._shfd < 0) return false;
		try {
			this._hdbf[0] = shwring;
			this._hdbf.writeUInt32LE(this._w, 4);
			this._hdbf.writeUInt32LE(this._h, 8);
			fs.writeSync(this._shfd, this._hdbf, 0, 16, 0);
			fs.writeSync(this._shfd, pb, 0, pb.length, shhdsz);
			this._hdbf[0] = shrd;
			fs.writeSync(this._shfd, this._hdbf, 0, 1, 0);
			return true;
		} catch (e) {
			return false;
		}
	}

	_sgLyr() {
		const cl = net.createConnection(scpt, () => {
			cl.write('{"op":"FRAME_UPDATE"}');
			cl.end();
		});
		cl.on("error", () => {});
	}

	async _ldAv(uid, ah) {
		if (!uid) return;
		const k = `${uid}_${ah || "default"}`;

		if (this._avc.has(k)) return;
		this._avc.set(k, null);

		let url;
		if (ah) {
			const ext = ah.startsWith("a_") ? "gif" : "png";
			url = `https://cdn.discordapp.com/avatars/${uid}/${ah}.${ext}?size=128`;
		} else {
			const idx = (BigInt(uid) >> 22n) % 6n;
			url = `https://cdn.discordapp.com/embed/avatars/${idx}.png?size=128`;
		}

		try {
			const im = await loadImage(url);
			this._avc.set(k, im);
			this._drt = true;
		} catch (e) {
			console.warn(
				`[Overlay] Failed to load avatar for ${uid}:`,
				e.message
			);
			this._avc.delete(k);
		}
	}

	_gtAvImg(uid, ah) {
		if (!uid) return null;
		const k = `${uid}_${ah || "default"}`;
		const c = this._avc.get(k);
		return c || null;
	}

	addNotification(data) {
		this._ntfs.push({
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

		if (data.userId) this._ldAv(data.userId, data.avatarHash);
		this._drt = true;
	}

	voiceJoin(data) {
		if (!data || !data.uid) return;
		this._vcu = this._vcu.filter((u) => u.id !== data.uid);
		this._vcu.push({
			id: data.uid,
			username: data.username || data.uid,
			avatarHash: data.avatarHash || null,
			muted: !!data.muted,
			deafened: !!data.deafened,
			speaking: false,
		});

		if (data.uid) this._ldAv(data.uid, data.avatarHash);
		this._drt = true;
	}

	voiceLeave({ uid }) {
		this._vcu = this._vcu.filter((u) => u.id !== uid);
		this._drt = true;
	}

	voiceUpdateAvatar({ uid, avatarHash }) {
		const u = this._vcu.find((u) => u.id === uid);
		if (u && avatarHash && u.avatarHash !== avatarHash) {
			u.avatarHash = avatarHash;
			this._ldAv(uid, avatarHash);
			this._drt = true;
		}
	}

	voiceMuted({ uid }) {
		const u = this._vcu.find((u) => u.id === uid);
		if (u) {
			u.muted = true;
			this._drt = true;
		}
	}

	voiceUnmuted({ uid }) {
		const u = this._vcu.find((u) => u.id === uid);
		if (u) {
			u.muted = false;
			this._drt = true;
		}
	}

	voiceDeafened({ uid }) {
		const u = this._vcu.find((u) => u.id === uid);
		if (u) {
			u.deafened = true;
			this._drt = true;
		}
	}

	voiceUndeafened({ uid }) {
		const u = this._vcu.find((u) => u.id === uid);
		if (u) {
			u.deafened = false;
			this._drt = true;
		}
	}

	voiceStartedSpeaking({ uid }) {
		const u = this._vcu.find((u) => u.id === uid);
		if (u) {
			u.speaking = true;
			this._drt = true;
		}
	}

	voiceStoppedSpeaking({ uid }) {
		const u = this._vcu.find((u) => u.id === uid);
		if (u) {
			u.speaking = false;
			this._drt = true;
		}
	}

	voiceClear() {
		this._vcu = [];
		this._drt = true;
	}

	_rnFr() {
		if (!this._ind) return;

		const gr = this._rdGmRes();
		if (gr && (gr.width !== this._lgw || gr.height !== this._lgh)) {
			this._lgw = gr.width;
			this._lgh = gr.height;
			if (gr.width !== this._w || gr.height !== this._h) {
				if (this._rdbc) clearTimeout(this._rdbc);
				this._rdbc = setTimeout(() => {
					const cr = this._rdGmRes();
					if (
						cr &&
						cr.width === this._lgw &&
						cr.height === this._lgh
					) {
						this._rcCvs(cr.width, cr.height);
					}
					this._rdbc = null;
				}, 200);
			}
		}

		const nw = Date.now();
		const bf = this._ntfs.length;
		this._ntfs = this._ntfs.filter((n) => nw - n.createdAt < n.duration);
		if (this._ntfs.length !== bf) this._drt = true;

		for (const n of this._ntfs) {
			const el = nw - n.createdAt;
			const rm = n.duration - el;
			if (el < 300 || rm < 500) {
				this._drt = true;
				break;
			}
		}

		if (!this._drt) return;
		this._drt = false;

		const ctx = this._ctx;
		const w = this._w;
		const h = this._h;

		ctx.clearRect(0, 0, w, h);
		this._drNt(ctx, w, h);
		this._drVp(ctx, w, h);

		const id = ctx.getImageData(0, 0, w, h);
		const pb = Buffer.from(id.data.buffer);

		if (this._wrShm(pb)) {
			this._sgLyr();
		}
	}

	_px(b) {
		return Math.round(b * this._dsc);
	}

	_fn(sz, wt = 400) {
		if (typeof wt === "boolean") wt = wt ? 600 : 400;
		return `${wt} ${this._px(sz)}px "${fF}", sans-serif`;
	}

	_gtNtAl(n) {
		const el = Date.now() - n.createdAt;
		const rm = n.duration - el;
		let a = 1.0;
		if (el < 200) a = el / 200;
		if (rm < 500) a = Math.min(a, rm / 500);
		return Math.max(0, Math.min(1, a));
	}

	_rrct(ctx, x, y, w, h, r) {
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

	_flRR(ctx, x, y, w, h, r, cl) {
		this._rrct(ctx, x, y, w, h, r);
		ctx.fillStyle = cl;
		ctx.fill();
	}

	_drAv(ctx, cx, cy, r, im, fb) {
		ctx.save();
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);

		if (im) {
			ctx.clip();
			ctx.drawImage(im, cx - r, cy - r, r * 2, r * 2);
		} else {
			// djb2 hash for determiniuystic palette color from fallback str
			let hv = 5381;
			for (let i = 0; i < fb.length; i++)
				hv = ((hv << 5) + hv + fb.charCodeAt(i)) >>> 0;
			const pl = [
				[113, 140, 219],
				[84, 184, 148],
				[245, 148, 69],
				[232, 92, 92],
				[166, 128, 209],
				[61, 181, 184],
				[240, 181, 66],
				[219, 113, 171],
			];
			const [cr, cg, cb] = pl[hv % pl.length];

			ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
			ctx.fill();

			if (fb.length > 0) {
				ctx.fillStyle = "#ffffff";
				ctx.font = this._fn(Math.max(10, r * 0.85), 600);
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(fb[0].toUpperCase(), cx, cy + this._px(1));
			}
		}
		ctx.restore();
	}

	_trnc(ctx, txt, mw) {
		if (!txt || mw <= 0) return "";
		if (ctx.measureText(txt).width <= mw) return txt;
		const ew = ctx.measureText("…").width;
		const aw = mw - ew;
		if (aw <= 0) return "…";
		let lo = 0,
			hi = txt.length,
			bs = 0;
		while (lo <= hi) {
			const md = (lo + hi) >> 1;
			if (ctx.measureText(txt.substring(0, md)).width <= aw) {
				bs = md;
				lo = md + 1;
			} else hi = md - 1;
		}
		return txt.substring(0, bs) + "…";
	}

	_drNt(ctx, W, H) {
		if (this._ntfs.length === 0) return;

		const mg = this._px(24);
		const rd = this._px(12);
		const sp = this._px(12);
		const mxW = Math.min(W * 0.35, this._px(450));
		const fz = 20;
		const lh = this._px(fz * 1.3);
		let y = mg;
		let ct = 0;

		for (const n of this._ntfs) {
			if (ct >= 4) break;
			const al = this._gtNtAl(n);
			if (al <= 0.01) continue;

			const el = Date.now() - n.createdAt;
			const t = Math.min(el / 300, 1);
			const es = 1 - Math.pow(1 - t, 3);
			const sx = (1 - es) * this._px(60);

			ctx.save();
			ctx.globalAlpha = al;

			if (n.sender) {
				const pX = this._px(20),
					pY = this._px(16);
				const aR = this._px(20);
				const ts = aR * 2 + this._px(16);

				ctx.font = this._fn(fz, 600);
				ctx.font = this._fn(fz);

				let cs = "";
				if (n.isDM) cs = "DM";
				else {
					if (n.channel) cs = "#" + n.channel;
					if (n.server) {
						if (cs) cs += " · ";
						cs += n.server;
					}
				}

				const bW = Math.max(
					this._px(260),
					Math.min(mxW, pX + ts + this._px(280) + pX)
				);
				const bH = pY + lh + this._px(6) + lh + pY;
				const bx = W - bW - mg + sx;

				ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
				ctx.shadowBlur = this._px(12);
				ctx.shadowOffsetY = this._px(6);

				this._flRR(ctx, bx, y, bW, bH, rd, "#111214");
				ctx.shadowColor = "transparent";

				this._flRR(
					ctx,
					bx,
					y,
					this._px(4),
					bH,
					this._px(4),
					n.isDM ? "#9766de" : "#5865F2"
				);

				const im = this._gtAvImg(n.userId, n.avatarHash);
				this._drAv(ctx, bx + pX + aR, y + bH * 0.5, aR, im, n.sender);

				const tx = bx + pX + ts;
				const avW = bW - pX - ts - pX;

				ctx.textAlign = "left";
				ctx.textBaseline = "top";

				ctx.font = this._fn(fz, 600);
				ctx.fillStyle = "#f2f3f5";
				const tn = this._trnc(ctx, n.sender, avW * 0.55);
				ctx.fillText(tn, tx, y + pY);

				if (cs) {
					const sw = ctx.measureText(tn).width;
					ctx.font = this._fn(fz - 4);
					ctx.fillStyle = "#949ba4";
					const ca = avW - sw - this._px(12);
					if (ca > this._px(20))
						ctx.fillText(
							this._trnc(ctx, cs, ca),
							tx + sw + this._px(10),
							y + pY + this._px(4)
						);
				}

				ctx.font = this._fn(fz);
				ctx.fillStyle = "#dbdee1";
				ctx.fillText(
					this._trnc(ctx, n.message, avW),
					tx,
					y + pY + lh + this._px(4)
				);

				y += bH + sp;
			} else {
				const pX = this._px(20),
					pY = this._px(14);

				ctx.font = this._fn(fz);
				const mW = ctx.measureText(n.message).width;
				const bW = Math.max(
					this._px(160),
					Math.min(mxW, pX * 2 + mW + this._px(8))
				);
				const bH = pY * 2 + lh;
				const bx = W - bW - mg + sx;

				ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
				ctx.shadowBlur = this._px(12);
				ctx.shadowOffsetY = this._px(6);

				this._flRR(
					ctx,
					bx,
					y,
					bW,
					bH,
					rd,
					n.type === "system" ? "#111214" : "#1e1f22"
				);
				ctx.shadowColor = "transparent";

				this._flRR(
					ctx,
					bx,
					y,
					this._px(4),
					bH,
					this._px(4),
					n.type === "system" ? "#5865F2" : "#80848e"
				);

				ctx.textAlign = "left";
				ctx.textBaseline = "top";
				ctx.fillStyle = n.type === "system" ? "#e3e5e8" : "#dbdee1";
				ctx.fillText(
					this._trnc(ctx, n.message, bW - pX * 2),
					bx + pX,
					y + pY
				);

				y += bH + sp;
			}

			ctx.restore();
			ct++;
		}
	}

	_drVp(ctx, W, H) {
		if (!this._vcu || this._vcu.length === 0) return;

		const mg = this._px(20);
		const pX = this._px(12);
		const pY = this._px(10);
		const rd = this._px(10);
		const fz = 16;
		const lh = this._px(fz * 1.3);
		const aR = this._px(14);
		const aP = this._px(10);
		const iSz = this._px(15);
		const iPd = this._px(6);
		const iH = aR * 2 + this._px(8);
		const iG = this._px(4);

		ctx.font = this._fn(fz, 500);
		let mrW = 0;
		for (const u of this._vcu) {
			const uw = ctx.measureText(u.username).width + iSz + this._px(8);
			if (uw > mrW) mrW = uw;
		}

		const pW = Math.max(
			this._px(170),
			Math.min(W * 0.22, pX + aR * 2 + aP + mrW + pX + this._px(8))
		);
		const pH =
			pY +
			this._vcu.length * iH +
			(this._vcu.length > 1 ? (this._vcu.length - 1) * iG : 0) +
			pY;
		const px = mg;
		const py = H - pH - mg;

		ctx.save();

		ctx.shadowColor = "rgba(0, 0, 0, 0.15)";
		ctx.shadowBlur = this._px(8);
		ctx.shadowOffsetY = this._px(2);

		this._flRR(ctx, px, py, pW, pH, rd, "rgba(0, 0, 0, 0.25)");
		ctx.shadowColor = "transparent";

		ctx.globalAlpha = 1.0;

		let iy = py + pY;

		for (const us of this._vcu) {
			const nm = us.username || "Unknown";
			const acx = px + pX + aR;
			const acy = iy + iH * 0.5;

			if (us.speaking) {
				ctx.beginPath();
				ctx.arc(acx, acy, aR + this._px(2.5), 0, Math.PI * 2);
				ctx.strokeStyle = "#23a559";
				ctx.lineWidth = this._px(2);
				ctx.stroke();
			}

			const avAl = us.deafened ? 0.4 : us.muted ? 0.65 : 1.0;
			ctx.globalAlpha = avAl;
			const im = this._gtAvImg(us.id, us.avatarHash);
			this._drAv(ctx, acx, acy, aR, im, nm);
			ctx.globalAlpha = 1.0;

			const tx = px + pX + aR * 2 + aP;
			const tA = pW - pX - aR * 2 - aP - pX;

			let nc;
			if (us.speaking) nc = "#23a559";
			else if (us.deafened) nc = "#da373c";
			else if (us.muted) nc = "#f0b232";
			else nc = "rgba(255, 255, 255, 0.9)";

			ctx.textAlign = "left";
			ctx.textBaseline = "middle";

			const wt = us.speaking ? 600 : 500;
			ctx.font = this._fn(fz, wt);
			ctx.fillStyle = nc;

			const iSp = us.deafened || us.muted ? iSz + iPd : 0;
			const dn = this._trnc(ctx, nm, tA - iSp);
			ctx.fillText(dn, tx, acy);

			if (us.deafened || us.muted) {
				const nW = ctx.measureText(dn).width;
				const ix = tx + nW + iPd + iSz / 2;
				const iy2 = acy;
				const ic = us.deafened ? "#da373c" : "#f0b232";
				const ii = us.deafened ? ichsof : icmcof;
				this._drIcSn(ctx, ii, ix, iy2, iSz, ic);
			}

			iy += iH + iG;
		}

		ctx.restore();
	}
}

module.exports = { OverlayRenderer };
