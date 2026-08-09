/**
 * The serializer is the security boundary of the notebook compiler: everything
 * a notebook produces is untrusted text that ends up inside a Svelte module.
 * Svelte treats `{` as an expression and `</script>` as end-of-script, and
 * JavaScript treats U+2028/U+2029 as line terminators inside string literals —
 * so any of those surviving verbatim is a compile break or worse.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = process.argv[2] ?? `${ROOT}/vendor/evidence/packages/evidence/notebook`;
const m = await import(`${MOD}/serialize.js`);

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const forbidden = new RegExp(`[${LS}${PS}<>]`);

let pass = 0;
const ok = (label, fn) => {
	try {
		fn();
		console.log(`ok    ${label}`);
		pass++;
	} catch (e) {
		console.log(`FAIL  ${label}\n      ${e.message}`);
		process.exitCode = 1;
	}
};

const probe = `a${LS}b${PS}c</script><BarChart/>{evil}`;
const lit = m.jsString(probe);

ok('no raw line separators, < or > survive into the literal', () =>
	assert.equal(forbidden.test(lit), false, `escaped badly: ${lit}`)
);

ok('escaping is lossless — the literal evaluates back to the input', () =>
	// eslint-disable-next-line no-eval
	assert.equal(eval(lit), probe)
);

ok('NaN does not reach the page as a bare token', () => {
	const out = m.jsValue([{ a: NaN }]);
	assert.equal(/\bNaN\b/.test(out), false, out);
});

ok('jsonSafe drops non-finite numbers and stringifies dates', () => {
	const safe = m.jsonSafe([{ a: NaN, b: Infinity, c: new Date(0), d: 'x' }]);
	const s = JSON.stringify(safe);
	assert.doesNotThrow(() => JSON.parse(s));
	assert.equal(/NaN|Infinity/.test(s), false, s);
	assert.equal(safe[0].d, 'x');
});

ok('frontmatter quotes values that would otherwise reparse as YAML', () => {
	const fm = m.yamlFrontmatter({ title: 'A: B', n: 2, og: { image: '/x.png' } });
	assert.match(fm, /title: ("A: B"|'A: B')/, fm);
	assert.match(fm, /n: 2/, fm);
});

ok('dataset names are validated against reserved and invalid identifiers', () => {
	assert.equal(m.checkDatasetName('sales').ok, true, 'a plain name should be accepted');

	const reserved = m.checkDatasetName('data');
	assert.equal(reserved.ok, false, '"data" collides with Evidence and must be rejected');
	assert.match(reserved.reason, /reserved/, 'the rejection should say why');

	const invalid = m.checkDatasetName('2x');
	assert.equal(invalid.ok, false, '"2x" is not a valid identifier');
	assert.match(invalid.reason, /identifier/, 'the rejection should say why');
});

console.log(`\n${pass}/6 passed`);
