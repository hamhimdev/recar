const fs = require("fs");
const { execSync } = require("child_process");

const folder = process.argv[2];

if (!folder) {
	console.error("Please specify a folder to build.");
	process.exit(1);
}

if (!fs.existsSync(folder) || !fs.existsSync(`${folder}/.git`)) {
	console.error(`\nError: Submodule "${folder}" is missing!`);
	console.error("Did you forget to clone with the --recursive flag?\n");
	process.exit(1);
}

try {
	console.log(`\nBuilding ${folder}...`);
	execSync("make", { cwd: folder, stdio: "inherit" });
} catch (error) {
	console.error(`\n"make" failed inside ${folder}.`);
	process.exit(1);
}
