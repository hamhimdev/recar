const path = require("path");
const fs = require("fs");
const os = require("os");

const LIB_DIR = path.join(os.homedir(), ".local", "lib", "recar-overlay");
const LAYER_DIR = path.join(
	os.homedir(),
	".local",
	"share",
	"vulkan",
	"implicit_layer.d"
);
const LAYER_FILENAME = "recar_layer.json";
const LIB_FILENAME = "librecar_overlay.so";
const SHM_PATH = "/dev/shm/recar_overlay";
const SOCK_PATH = "/tmp/recar_overlay.sock";

function getBundledSo(appPath) {
	const arch = process.arch; // 'x64' or 'arm64'
	const soName =
		arch === "arm64"
			? "librecar_overlay_arm64.so"
			: "librecar_overlay_x64.so";
	return path.join(appPath, "dist", "roverpp", soName);
}

function isInstalled() {
	return (
		fs.existsSync(path.join(LIB_DIR, LIB_FILENAME)) &&
		fs.existsSync(path.join(LAYER_DIR, LAYER_FILENAME))
	);
}

function install(appPath) {
	const soSrc = getBundledSo(appPath);

	if (!fs.existsSync(soSrc)) {
		throw new Error(
			`[roverpp] Bundled library not found for arch '${process.arch}': ${soSrc}`
		);
	}

	fs.mkdirSync(LIB_DIR, { recursive: true });
	fs.mkdirSync(LAYER_DIR, { recursive: true });

	const soDest = path.join(LIB_DIR, LIB_FILENAME);
	fs.copyFileSync(soSrc, soDest);
	fs.chmodSync(soDest, 0o755);

	const manifest = {
		file_format_version: "1.3.0",
		layer: {
			name: "VK_LAYER_RECAR_overlay",
			type: "GLOBAL",
			library_path: soDest,
			api_version: "1.3.0",
			implementation_version: "1",
			description: "Recar notification overlay layer",
			disable_environment: {
				DISABLE_RECAR_OVERLAY: "1",
			},
			functions: {
				vkNegotiateLoaderLayerInterfaceVersion:
					"vkNegotiateLoaderLayerInterfaceVersion",
			},
		},
	};

	fs.writeFileSync(
		path.join(LAYER_DIR, LAYER_FILENAME),
		JSON.stringify(manifest, null, 2)
	);

	console.log("[roverpp] Installed successfully.");
	console.log(`[roverpp]   library  @ ${soDest}`);
	console.log(
		`[roverpp]   manifest @ ${path.join(LAYER_DIR, LAYER_FILENAME)}`
	);
}

function uninstall() {
	const manifestPath = path.join(LAYER_DIR, LAYER_FILENAME);
	if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

	const libPath = path.join(LIB_DIR, LIB_FILENAME);
	if (fs.existsSync(libPath)) fs.unlinkSync(libPath);

	// clean up the lib dir if now empty
	try {
		if (fs.readdirSync(LIB_DIR).length === 0) fs.rmdirSync(LIB_DIR);
	} catch {}

	// clean up leftover IPC files from a running or crashed session
	for (const p of [SHM_PATH, SOCK_PATH]) {
		try {
			if (fs.existsSync(p)) fs.unlinkSync(p);
		} catch {}
	}

	console.log("[roverpp] Uninstalled.");
}

module.exports = { install, uninstall, isInstalled };
