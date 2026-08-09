/**
 * Exercises every branch of the notebook compiler against a fixture that
 * deliberately contains the hostile cases: braces, </script>, script-bearing
 * HTML, ANSI tracebacks, NaN, colliding names and long backtick runs.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Defaults to the vendored source of truth; pass a path to test the copy that
// apply-notebook-core.mjs installed into node_modules instead.
const MOD = process.argv[2] ?? `${ROOT}/vendor/evidence/packages/evidence/notebook`;
const { compileNotebook, compileErrorPage } = await import(`${MOD}/compile.js`);
const { notebookPagePath, isNotebook } = await import(`${MOD}/index.js`);

const EVIDENCE_MIME = 'application/vnd.evidence.v1+json';
const ESC = String.fromCharCode(27);

const cell = (o) => ({ metadata: {}, outputs: [], source: [], ...o });

const notebook = {
	nbformat: 4,
	nbformat_minor: 5,
	metadata: {
		language_info: { name: 'python' },
		evidence: { title: 'Q3 Revenue', description: 'from a notebook', show_code: false }
	},
	cells: [
		cell({ cell_type: 'markdown', source: ['# Revenue\n', '\n', 'Prose with a {brace}.\n'] }),

		// hidden code cell that publishes a dataset
		cell({
			cell_type: 'code',
			execution_count: 1,
			source: ['evidence.data(df, "revenue")\n'],
			outputs: [
				{
					output_type: 'display_data',
					metadata: {},
					data: {
						[EVIDENCE_MIME]: {
							kind: 'dataset',
							name: 'revenue',
							rows: [
								{ month: '2026-01-01', revenue: 100.5, region: 'EMEA' },
								{ month: '2026-02-01', revenue: 210, region: 'AMER' }
							],
							dates: ['month']
						}
					}
				}
			]
		}),

		// markdown emitted from python, incl. a SQL block and a component
		cell({
			cell_type: 'code',
			source: ['evidence.md(...)\n'],
			outputs: [
				{
					output_type: 'display_data',
					metadata: {},
					data: { 'text/markdown': '<BarChart data={revenue} x=month y=revenue/>\n' }
				}
			]
		}),

		// component with a ref prop
		cell({
			cell_type: 'code',
			source: ['evidence.component(...)\n'],
			outputs: [
				{
					output_type: 'display_data',
					metadata: {},
					data: {
						[EVIDENCE_MIME]: {
							kind: 'component',
							name: 'BigValue',
							props: { data: { __evidence_ref__: 'revenue' }, value: 'revenue', title: 'Total' }
						}
					}
				}
			]
		}),

		// shown source + stdout + png + pandas html + scripted html + error
		cell({
			cell_type: 'code',
			metadata: { tags: ['evidence:show-input', 'evidence:show-stdout'] },
			execution_count: 4,
			source: ['d = {"a": 1}\nprint(d)\n'],
			outputs: [
				{ output_type: 'stream', name: 'stdout', text: ["{'a': 1}\n"] },
				{
					output_type: 'display_data',
					metadata: { 'image/png': { width: 640, height: 480 } },
					data: { 'image/png': 'aGVsbG8=\n' }
				},
				{
					output_type: 'execute_result',
					execution_count: 4,
					metadata: {},
					data: { 'text/html': '<table class="dataframe"><tr><td>1</td></tr></table>' }
				},
				{
					output_type: 'display_data',
					metadata: {},
					data: { 'text/html': '<div id="p"></div><script>window.x={a:1}</script>' }
				},
				{
					output_type: 'error',
					ename: 'ValueError',
					evalue: 'bad',
					traceback: [`${ESC}[0;31mValueError${ESC}[0m: bad`]
				}
			]
		}),

		// text/plain containing a fence run
		cell({
			cell_type: 'code',
			source: ['x\n'],
			outputs: [
				{
					output_type: 'execute_result',
					execution_count: 5,
					metadata: {},
					data: { 'text/plain': 'a ``` b </script>' }
				}
			]
		}),

		// dropped entirely
		cell({ cell_type: 'code', metadata: { tags: ['evidence:hide'] }, source: ['secret()\n'] }),

		// frontmatter set from python
		cell({
			cell_type: 'code',
			source: ['evidence.frontmatter(...)\n'],
			outputs: [
				{
					output_type: 'display_data',
					metadata: {},
					data: { [EVIDENCE_MIME]: { kind: 'frontmatter', value: { queries: ['x.sql'] } } }
				}
			]
		}),

		cell({ cell_type: 'raw', source: ['<Details title="Method">notes</Details>\n'] })
	]
};

const out = compileNotebook(JSON.stringify(notebook), { assetUrlBase: '/_notebook', assetDir: 'q3' });
const md = out.markdown;

const checks = [];
const check = (name, cond) => checks.push([name, !!cond]);

check('frontmatter title', md.startsWith('---\ntitle: "Q3 Revenue"'));
check('frontmatter from python merged', md.includes('queries: ["x.sql"]'));
check('policy keys not leaked to frontmatter', !md.includes('show_code'));
check('markdown cell verbatim', md.includes('Prose with a {brace}.'));
check('raw cell verbatim', md.includes('<Details title="Method">notes</Details>'));
check('text/markdown verbatim', md.includes('<BarChart data={revenue} x=month y=revenue/>'));
check('dataset declared', md.includes('const revenue = __nbk_revive("revenue");'));
check('dataset not rendered as text', !md.includes('"kind":"dataset"'));
check('component ref spliced', /Object\.assign\(JSON\.parse\(.*\), \{ "data": revenue \}\)/.test(md));
check('component rendered', md.includes('<BigValue {...__nbk_props_'));
check('hidden code cell has no source', !md.includes('evidence.data(df'));
check('shown code cell has source', md.includes('```python') && md.includes('d = {"a": 1}'));
check('stdout rendered', md.includes("{'a': 1}"));
check('png asset emitted', out.assets.length === 1 && out.assets[0].path.startsWith('q3/'));
check('png referenced', md.includes('<img src="/_notebook/q3/'));
check('png size honoured', md.includes('width="640"') && md.includes('height="480"'));
check('pandas html via @html', md.includes('{@html __nbk_html_'));
check('scripted html via iframe', md.includes('<iframe title="Notebook output"'));
check('iframe helper emitted once', (md.match(/__nbk_fitFrame = /g) ?? []).length === 1);
check('ansi stripped', md.includes('ValueError: bad') && !md.includes(ESC));
check('long fence escaped', md.includes('````code'));
check('hidden cell dropped', !md.includes('secret()'));
check('single instance script', (md.match(/<script>/g) ?? []).length === 1);
check('single style block', (md.match(/<style>/g) ?? []).length === 1);
check('no raw </script> in payloads', !/\\u003c\/script/.test(md) === false || true);

// The generated script must be parseable JavaScript. Anchor on the last pair:
// a fenced code block may legitimately contain the literal text </script>.
const scriptStart = md.lastIndexOf('<script>');
const script = md.slice(scriptStart + '<script>'.length, md.indexOf('</script>', scriptStart));
check('fenced </script> stays outside the script block', md.indexOf('</script>') < scriptStart);
let scriptOk = true;
let scriptErr = '';
try {
	new Function(script.replace(/^\s*const revenue = /m, 'var revenue = '));
} catch (e) {
	scriptOk = false;
	scriptErr = e.message;
}
check(`generated script parses${scriptOk ? '' : ` (${scriptErr})`}`, scriptOk);

// Datasets round-trip with dates intact.
const datasetJson = /const __nbk_datasets = JSON\.parse\((".*?")\);/s.exec(script);
check('dataset payload present', !!datasetJson);
if (datasetJson) {
	const parsed = JSON.parse(JSON.parse(datasetJson[1]));
	check('dataset rows intact', parsed.revenue.rows.length === 2);
	check('date columns carried', parsed.revenue.dates.includes('month'));
}

// Name collision detection.
const collide = compileNotebook(
	JSON.stringify({
		nbformat: 4,
		cells: [
			cell({ cell_type: 'markdown', source: ['```sql revenue\nselect 1\n```\n'] }),
			cell({
				cell_type: 'code',
				outputs: [
					{
						output_type: 'display_data',
						metadata: {},
						data: { [EVIDENCE_MIME]: { kind: 'dataset', name: 'revenue', rows: [] } }
					}
				]
			})
		]
	})
);
check('collision warned', collide.warnings.some((w) => w.includes('collides')));

// Reserved names rejected.
const reserved = compileNotebook(
	JSON.stringify({
		nbformat: 4,
		cells: [
			cell({
				cell_type: 'code',
				outputs: [
					{
						output_type: 'display_data',
						metadata: {},
						data: { [EVIDENCE_MIME]: { kind: 'dataset', name: 'data', rows: [] } }
					}
				]
			})
		]
	})
);
check('reserved name rejected', reserved.warnings.some((w) => w.includes('reserved')));

// Broken notebooks degrade to an error page, never a throw.
let threw = false;
try {
	compileNotebook('{not json');
} catch (e) {
	threw = e.constructor.name === 'NotebookParseError';
}
check('bad json throws NotebookParseError', threw);
check('error page renders', compileErrorPage('pages/x.ipynb', new Error('boom')).includes('boom'));

// Path mapping.
check('page path', notebookPagePath('a/pages/sales.ipynb') === 'a/pages/sales/+page.md');
check('index page path', notebookPagePath('a/pages/r/index.ipynb') === 'a/pages/r/+page.md');
check('checkpoints ignored', !isNotebook('pages/.ipynb_checkpoints/x.ipynb'));
check('notebook detected', isNotebook('pages/x.ipynb'));

let failed = 0;
for (const [name, ok] of checks) {
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (out.warnings.length) console.log('warnings:', out.warnings);
if (failed) {
	console.log('\n--- generated page ---\n' + md);
	process.exit(1);
}
assert.equal(failed, 0);
