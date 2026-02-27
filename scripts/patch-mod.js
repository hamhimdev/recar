const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const searchRoot = path.join(__dirname, "..", "src");

function findUp(startDir, name) {
	let dir = startDir;
	while (true) {
		if (fs.existsSync(path.join(dir, name))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function applyFiles(patchDir, targetRoot) {
	if (!fs.existsSync(patchDir)) return;

	const entries = fs.readdirSync(patchDir);

	for (const entry of entries) {
		const entryPath = path.join(patchDir, entry);
		if (fs.statSync(entryPath).isDirectory()) continue;

		if (entry.endsWith(".patch")) {
			try {
				execFileSync("git", ["apply", entryPath], { cwd: targetRoot, stdio: "inherit" });
				console.log(`Applied patch ${entry}`);
			} catch {
				console.error(`Failed to apply patch ${entry}`);
				process.exit(1);
			}
		} else {
			const content = fs.readFileSync(entryPath, "utf8");
			const lines = content.split("\n");
			const firstLine = lines[0];

			if (!firstLine.startsWith("//PATH=")) {
				console.warn(`Skipping ${entry}: no //PATH= header`);
				continue;
			}

			const destRelative = firstLine.slice("//PATH=".length).trim();
			const destPath = path.join(targetRoot, destRelative);
			const fileContent = lines.slice(1).join("\n");

			fs.mkdirSync(path.dirname(destPath), { recursive: true });
			fs.writeFileSync(destPath, fileContent);
			console.log(`Copied ${entry} -> ${destPath}`);
		}
	}
}

function main() {
	const target = process.argv[2];
	if (!target) {
		console.error("Usage: node patch-mod.js <targetPackageName>");
		process.exit(1);
	}

	const modPatchesParent = findUp(searchRoot, "modPatches");
	if (!modPatchesParent) {
		console.warn("No `modPatches` directory found searching upward from", searchRoot);
		return;
	}

	const targetParent = findUp(searchRoot, target);
	if (!targetParent) {
		console.warn(`Target package '${target}' not found searching upward from`, searchRoot);
		return;
	}

	const modPatchesDir = path.join(modPatchesParent, "modPatches");
	const targetRoot = path.join(targetParent, target);

	try {
		execFileSync("git", ["checkout", "--", "."], { cwd: targetRoot, stdio: "inherit" });
		execFileSync("git", ["clean", "-fd"], { cwd: targetRoot, stdio: "inherit" });
		console.log(`Discarded all changes in ${targetRoot}`);
	} catch (err) {
		console.error("Failed to discard changes:", err);
		process.exit(1);
	}

	applyFiles(modPatchesDir, targetRoot);
	applyFiles(path.join(modPatchesDir, target), targetRoot);
}

main();
