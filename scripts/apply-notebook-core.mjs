#!/usr/bin/env node
/**
 * Install the native-notebook change into the Evidence package this project runs.
 *
 *   node scripts/apply-notebook-core.mjs           # install (also runs on postinstall)
 *   node scripts/apply-notebook-core.mjs --check   # report drift, change nothing
 *
 * The change itself lives in the vendored monorepo, where it belongs and where
 * it can be sent upstream:
 *
 *   vendor/evidence/packages/evidence/notebook/   the notebook -> page compiler
 *   vendor/evidence/packages/evidence/cli.js      the page pipeline wiring
 *
 * npm installs @evidence-dev/evidence from the registry, so that source is not
 * what executes. This script copies the two paths into node_modules and drops
 * the python helper at the project root. It is idempotent, and `npm install`
 * re-runs it via postinstall.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * Each vendored package whose local changes have to reach node_modules, and
 * which files carry them.
 *
 *   @evidence-dev/evidence      .ipynb as a native page format
 *   @evidence-dev/universal-sql parquet written at zstd level 6 instead of 3
 *                               (see docs/openzl-evaluation.md)
 */
const TARGETS = [
	{
		pkg: '@evidence-dev/evidence',
		vendor: 'vendor/evidence/packages/evidence',
		payload: ['cli.js', 'notebook']
	},
	{
		pkg: '@evidence-dev/universal-sql',
		vendor: 'vendor/evidence/packages/lib/universal-sql',
		payload: ['src/build-parquet.js']
	}
];

const VENDOR = path.join(ROOT, TARGETS[0].vendor);
const INSTALLED = path.join(ROOT, 'node_modules', TARGETS[0].pkg);

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

/** @param {string} dir @returns {string[]} files relative to dir */
const walk = (dir, base = dir) =>
	fs.existsSync(dir)
		? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const full = path.join(dir, entry.name);
				return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
			})
		: [];

const fail = (message) => {
	console.error(`[notebook-core] ${message}`);
	process.exit(1);
};

if (!exists(VENDOR)) {
	fail('vendor/evidence is not checked out. Run:\n  git submodule update --init --recursive --depth 1');
}
if (!exists(INSTALLED)) {
	// Nothing to patch yet — npm calls postinstall before every package is linked
	// in some layouts. Silence here beats a spurious failure.
	console.log('[notebook-core] @evidence-dev/evidence is not installed yet, skipping');
	process.exit(0);
}

const vendorVersion = JSON.parse(read(path.join(VENDOR, 'package.json'))).version;
const installedVersion = JSON.parse(read(path.join(INSTALLED, 'package.json'))).version;

if (vendorVersion !== installedVersion) {
	console.warn(
		`[notebook-core] version drift: vendor is ${vendorVersion}, installed is ${installedVersion}.\n` +
			'                Re-check the page pipeline in cli.js before trusting this patch.'
	);
}

/** @type {{ from: string, to: string }[]} */
const copies = [];
for (const target of TARGETS) {
	const vendorDir = path.join(ROOT, target.vendor);
	const installedDir = path.join(ROOT, 'node_modules', target.pkg);

	if (!exists(vendorDir)) fail(`missing ${target.vendor}`);
	if (!exists(installedDir)) {
		console.log(`[notebook-core] ${target.pkg} is not installed, skipping`);
		continue;
	}

	for (const entry of target.payload) {
		const from = path.join(vendorDir, entry);
		if (!exists(from)) fail(`missing ${path.relative(ROOT, from)}`);

		if (fs.statSync(from).isDirectory()) {
			for (const rel of walk(from)) {
				copies.push({ from: path.join(from, rel), to: path.join(installedDir, entry, rel) });
			}
		} else {
			copies.push({ from, to: path.join(installedDir, entry) });
		}
	}
}

// The python helper lives at the project root so `import evidence` resolves from
// a notebook anywhere under pages/ (see the bootstrap in the demo notebook).
copies.push({
	from: path.join(VENDOR, 'notebook/python/evidence.py'),
	to: path.join(ROOT, 'evidence.py')
});

const stale = copies.filter(({ from, to }) => !exists(to) || read(from) !== read(to));

if (CHECK_ONLY) {
	if (stale.length === 0) {
		console.log(`[notebook-core] up to date (${copies.length} files)`);
		process.exit(0);
	}
	console.error(`[notebook-core] ${stale.length} file(s) out of date:`);
	for (const { to } of stale) console.error(`  ${path.relative(ROOT, to)}`);
	console.error('Run: node scripts/apply-notebook-core.mjs');
	process.exit(1);
}

for (const { from, to } of stale) {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.copyFileSync(from, to);
}

console.log(
	stale.length === 0
		? `[notebook-core] already applied (${copies.length} files)`
		: `[notebook-core] applied ${stale.length} file(s) to @evidence-dev/evidence@${installedVersion}`
);
