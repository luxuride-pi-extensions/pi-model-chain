/**
 * Assert that `npm pack` ships exactly what package.json promises: the extension
 * entry pi loads, plus the files a consumer needs, and nothing outside the
 * `files` allowlist. A clone and a tarball differ only in what this checks.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const parsed = JSON.parse(raw);
// npm <=10 returns an array of pack results; npm 11 returns an object keyed by
// package name. Accept either so the check does not break on an npm bump.
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
if (!pack || !Array.isArray(pack.files)) {
	console.error("unexpected `npm pack --json` shape");
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const shipped = pack.files.map((file) => file.path).sort();
const always = ["package.json", "README.md"];
const required = [...pkg.files, ...always];

const problems = [];
for (const file of required) {
	if (!shipped.includes(file)) problems.push(`missing from tarball: ${file}`);
}
for (const entry of pkg.pi.extensions) {
	const path = entry.replace(/^\.\//, "");
	if (!shipped.includes(path)) problems.push(`pi.extensions entry not shipped: ${entry}`);
}
for (const file of shipped) {
	if (!required.includes(file)) problems.push(`shipped but not allowlisted: ${file}`);
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
console.log(`ok ${shipped.length} files, pi.extensions entries present`);
