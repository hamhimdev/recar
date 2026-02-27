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

function main() {
	const target = process.argv[2];
	if (!target) {
		console.error("Usage: node discard-changes.js <targetPackageName>");
		process.exit(1);
	}

	const targetParent = findUp(searchRoot, target);
	if (!targetParent) {
		console.warn(`Target package '${target}' not found searching upward from`, searchRoot);
		process.exit(1);
	}

	const targetRoot = path.join(targetParent, target);

	try {
		execFileSync("git", ["checkout", "--", "."], { cwd: targetRoot, stdio: "inherit" });
		execFileSync("git", ["clean", "-fd"], { cwd: targetRoot, stdio: "inherit" });
		console.log(`Discarded all changes in ${targetRoot}`);
	} catch (err) {
		console.error("Failed to discard changes:", err);
		process.exit(1);
	}
}

main();
