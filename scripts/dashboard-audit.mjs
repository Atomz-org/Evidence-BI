#!/usr/bin/env node
/**
 * Score an Evidence page against this project's design contract.
 *
 * The point of a build-and-critique loop is that it terminates. A critique
 * written in prose does not terminate — the next pass always finds something
 * else to say, and nothing distinguishes "the chart is wrong" from "the chart is
 * not to my taste". So the rules this project already treats as non-negotiable
 * (`.claude/skills/evidence-bi/SKILL.md` § Non-negotiables) are checked here
 * mechanically, and the loop stops when the score stops moving.
 *
 * What this can and cannot see: it reads page source, not rendered pixels. It
 * catches the structural failures — an unreferenced number, a KPI with nothing
 * to compare against, a hue invented outside the palette, a chart with no way to
 * reach its rows. It cannot tell you the page answers the wrong question. That
 * judgement stays with the reader, which is why `dashboard-loop` pairs this
 * score with a written critique and treats them as two different instruments.
 *
 *   node scripts/dashboard-audit.mjs                 # every page
 *   node scripts/dashboard-audit.mjs pages/index.md  # one page
 *   node scripts/dashboard-audit.mjs --json          # machine-readable
 *
 * Exit code is 1 when any error-level finding survives, so this can gate a build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------- the palette -- */

/**
 * The only hues allowed to appear in page source. Read from the config rather
 * than copied, so a palette change cannot leave the auditor enforcing the old one.
 */
const allowedColours = () => {
	const config = fs.readFileSync(path.join(ROOT, 'evidence.config.yaml'), 'utf8');
	return new Set((config.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()));
};

/* ------------------------------------------------------------- source view -- */

/**
 * Component rules read a *masked* copy of the page: fenced blocks and inline
 * code spans are blanked out, character for character, so that prose about
 * `<FlintChart>` is not audited as a chart while every offset still points at
 * the line it came from.
 */
const maskCode = (text) =>
	text
		.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

/** Line number (1-based) of a character offset. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Words that name a measure. Matched against snake_case parts rather than as
 * substrings, so `country_code` is not a count and `order_count` is.
 */
const MEASURE_WORDS = new Set([
	'revenue', 'amount', 'price', 'cost', 'value', 'total', 'count', 'counts',
	'rate', 'share', 'margin', 'aov', 'orders', 'qty', 'quantity', 'spend',
	'profit', 'sales', 'pct', 'percent', 'avg', 'average', 'sum', 'growth'
]);

const namesAMeasure = (id) => id.toLowerCase().split(/[_\s.-]+/).some((part) => MEASURE_WORDS.has(part));

/* --------------------------------------------------------------- the rules -- */

/**
 * Each rule reads the page's source and returns findings. A rule is written to
 * be *specific*: it names the line, states what is wrong, and says what to do —
 * a finding that cannot be acted on is noise in a loop that runs many times.
 *
 * `level: 'error'` means the page violates a non-negotiable and the loop cannot
 * finish. `level: 'warn'` costs score but does not block.
 */
const RULES = [
	{
		id: 'kpi-needs-comparison',
		level: 'error',
		check: ({ masked }) => {
			const out = [];
			// A BigValue's props may wrap across several lines.
			for (const m of masked.matchAll(/<BigValue[\s\S]*?\/>/g)) {
				const block = m[0];
				if (!/\bcomparison\s*=/.test(block) && !/\bsparkline\s*=/.test(block)) {
					const value = block.match(/\bvalue\s*=\s*["']?([\w.]+)/)?.[1] ?? '?';
					out.push({
						line: lineAt(masked, m.index),
						message: `BigValue "${value}" has no reference. Add comparison= (previous period or target) or sparkline=. A number with nothing to compare to is a decoration.`
					});
				}
			}
			return out;
		}
	},
	{
		id: 'palette-only',
		level: 'error',
		check: ({ lines, allowed }) => {
			const out = [];
			lines.forEach((line, i) => {
				for (const hex of line.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
					if (!allowed.has(hex.toLowerCase())) {
						out.push({
							line: i + 1,
							message: `Hex ${hex} is not in the validated palette. Colour comes from evidence.config.yaml — series by slot order, status colours reserved for deltas and alerts.`
						});
					}
				}
			});
			return out;
		}
	},
	{
		id: 'no-dual-axis',
		level: 'error',
		check: ({ maskedLines }) => {
			const out = [];
			maskedLines.forEach((line, i) => {
				if (/\by2\s*=/.test(line) && !/Range Area/.test(line)) {
					out.push({
						line: i + 1,
						message: 'Second y-scale on one chart. Two measures of different scale → two charts, or index both to 100. (Range Area Chart\'s y2 is a band, not a second scale.)'
					});
				}
			});
			return out;
		}
	},
	{
		id: 'table-reachable',
		level: 'warn',
		check: ({ masked, text }) => {
			const charts = (masked.match(/<(Line|Bar|Area|Scatter|Bubble|Heatmap|Funnel|Sankey|Hist|Box|FlintChart)/g) ?? []).length;
			const reachable = /<DataTable/.test(masked) || /link=|href=|\]\(\//.test(text);
			return charts > 0 && !reachable
				? [{ line: 1, message: `${charts} chart(s) and no DataTable or drill link. Every chart's rows must be inspectable — add a table or a drill page one click away.` }]
				: [];
		}
	},
	{
		id: 'page-states-basis',
		level: 'warn',
		check: ({ text }) => {
			// Prose between the frontmatter and the first query or component. A
			// report states its basis in the frontmatter `description` instead —
			// that line is what travels with the PDF, so it counts.
			const body = text.replace(/^---[\s\S]*?\n---\n/, '');
			const frontmatter = text.slice(0, text.length - body.length);
			if ((frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim().length >= 40) return [];

			const intro = body.split(/```|^<[A-Z]/m)[0].replace(/^#+ .*/gm, '').trim();
			return intro.length < 40
				? [{ line: frontmatter.split('\n').length, message: 'No context sentence. State what the page measures and what it excludes ("excluding cancelled orders") before the first number, or put it in the frontmatter description — a reader who does not know the basis cannot use the figure.' }]
				: [];
		}
	},
	{
		id: 'numbers-wear-formats',
		level: 'warn',
		check: ({ masked }) => {
			const out = [];
			for (const m of masked.matchAll(/<(Column|BigValue)\b[\s\S]*?\/>/g)) {
				const block = m[0];
				const id = block.match(/\b(?:id|value)\s*=\s*["']?([\w.]+)/)?.[1];
				if (id && namesAMeasure(id) && !/\bfmt\s*=/.test(block)) {
					out.push({
						line: lineAt(masked, m.index),
						message: `Measure "${id}" has no fmt. Pick a format once per measure (usd0, usd0k, pct1, num0) and reuse it everywhere — this project never ships a raw float.`
					});
				}
			}
			return out;
		}
	},
	{
		id: 'flint-needs-semantics',
		level: 'error',
		check: ({ masked }) => {
			const out = [];
			for (const m of masked.matchAll(/<FlintChart[\s\S]*?\/>/g)) {
				const at = lineAt(masked, m.index);
				if (!/\btypes\s*=/.test(m[0])) {
					out.push({ line: at, message: 'FlintChart without types={{…}}. Semantic types are what Flint reasons from — without them it falls back to sniffing raw values, and the scale, zero-baseline and colour-scheme decisions become guesses.' });
				}
				if (!/\btitle\s*=/.test(m[0])) {
					out.push({ line: at, message: 'FlintChart without a title. The headline is where the measure gets named; a chart of bare numbers names nothing on its own.' });
				}
			}
			return out;
		}
	},
	{
		id: 'flint-chart-type-exists',
		level: 'error',
		check: ({ masked, chartTypes }) => {
			const out = [];
			for (const m of masked.matchAll(/chartType\s*=\s*["']([^"']+)["']/g)) {
				if (!chartTypes.has(m[1])) {
					const word = m[1].toLowerCase().split(' ')[0];
					const near = [...chartTypes].filter((t) => t.toLowerCase().includes(word)).slice(0, 3);
					out.push({
						line: lineAt(masked, m.index),
						message: `"${m[1]}" is not a Flint chart type.${near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(', ')}?` : ''} See .claude/skills/flint-chart/references/chart-catalog.md.`
					});
				}
			}
			return out;
		}
	},
	{
		id: 'flint-semantic-type-exists',
		level: 'warn',
		check: ({ masked, semanticTypes }) => {
			const out = [];
			for (const block of masked.matchAll(/types\s*=\s*\{\{[\s\S]*?\}\}/g)) {
				for (const m of block[0].matchAll(/:\s*['"]([A-Za-z]+)['"]/g)) {
					if (!semanticTypes.has(m[1])) {
						out.push({
							line: lineAt(masked, block.index + m.index),
							message: `"${m[1]}" is not a Flint semantic type — it is ignored and the column sniffed instead. See .claude/skills/flint-chart/references/semantic-types.md.`
						});
					}
				}
			}
			return out;
		}
	},
	{
		id: 'daterange-bounds',
		level: 'error',
		check: ({ masked, text }) => {
			const out = [];
			for (const m of masked.matchAll(/<DateRange[\s\S]*?\/>/g)) {
				const block = m[0];
				const query = block.match(/\bdata\s*=\s*\{(\w+)\}/)?.[1];
				const column = block.match(/\bdates\s*=\s*["']?(\w+)/)?.[1];
				if (!query || !column) continue;

				// The backing query lives in a fenced block, which `masked` blanked out.
				const fence = text.match(new RegExp('```sql\\s+' + query + '\\b([\\s\\S]*?)```'));
				if (!fence) continue;
				const sql = fence[1];

				// DateRange runs min()/max() over the single column named by dates=. A
				// query that returns the two bounds as two columns of one row hands it a
				// column containing one value, so its min and its max are the same day
				// and every relative default ("Last 30 Days") selects a window ending
				// where the data starts. The bounds have to share one column — two rows,
				// via union all.
				const hasMin = /\bmin\s*\(/i.test(sql);
				const hasMax = /\bmax\s*\(/i.test(sql);
				if (hasMin && hasMax && !/\bunion\b/i.test(sql)) {
					out.push({
						line: lineAt(masked, m.index),
						message: `DateRange reads "${column}" from {${query}}, which returns min() and max() as separate columns — so the picker sees one date and every relative default anchors to the start of the data. Return both bounds in one column: "select min(d) as d from … union all select max(d) from …".`
					});
				}
			}
			return out;
		}
	},
	{
		id: 'filters-in-one-row',
		level: 'warn',
		check: ({ lines }) => {
			const inputs = [];
			lines.forEach((line, i) => {
				if (/<(Dropdown|DateRange|TextInput|ButtonGroup|Slider)\b/.test(line)) inputs.push(i);
			});
			if (inputs.length < 2) return [];
			// Filters scattered through the page instead of gathered above the charts.
			const spread = inputs[inputs.length - 1] - inputs[0];
			return spread > inputs.length * 8
				? [{ line: inputs[0] + 1, message: `${inputs.length} filters spread over ${spread} lines. Filters live in one row above the charts and apply top-down — a filter below a chart it controls reads as a filter that does not.` }]
				: [];
		}
	}
];

/* ------------------------------------------------------------------ runner -- */

const loadFlintVocabulary = async () => {
	try {
		const flint = await import('flint-chart');
		return {
			chartTypes: new Set(flint.ecAllTemplateDefs.map((t) => t.chart)),
			semanticTypes: new Set(Object.values(flint.SemanticTypes))
		};
	} catch {
		// Without the library the two Flint rules cannot run; every other rule still can.
		return { chartTypes: null, semanticTypes: null };
	}
};

const auditPage = (file, context) => {
	const text = fs.readFileSync(file, 'utf8');
	const masked = maskCode(text);
	const view = { text, masked, lines: text.split('\n'), maskedLines: masked.split('\n') };

	// A page can opt out of a rule with `<!-- audit-ignore: rule-id, rule-id -->`.
	// The escape hatch is deliberate and narrow: a component gallery demonstrating
	// a bare BigValue is not the same mistake as a dashboard shipping one, and a
	// loop with no way to say so never converges. It names rules, never "all".
	const ignored = new Set(
		[...text.matchAll(/<!--\s*audit-ignore:\s*([^>]+?)\s*-->/g)].flatMap((m) =>
			m[1].split(',').map((s) => s.trim())
		)
	);

	const findings = [];
	for (const rule of RULES) {
		if (ignored.has(rule.id)) continue;
		if (rule.id.startsWith('flint-') && !context.chartTypes) continue;
		for (const f of rule.check({ ...view, ...context })) {
			findings.push({ rule: rule.id, level: rule.level, file: path.relative(ROOT, file), ...f });
		}
	}
	return findings;
};

const collectPages = (targets) => {
	if (targets.length) return targets.map((t) => path.resolve(ROOT, t));
	const out = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.md')) out.push(full);
		}
	};
	walk(path.join(ROOT, 'pages'));
	return out.sort();
};

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const targets = argv.filter((a) => !a.startsWith('--'));

const context = { allowed: allowedColours(), ...(await loadFlintVocabulary()) };
const pages = collectPages(targets);

const byPage = new Map();
let errors = 0;
let warns = 0;

for (const page of pages) {
	const findings = auditPage(page, context);
	if (findings.length) byPage.set(path.relative(ROOT, page), findings);
	errors += findings.filter((f) => f.level === 'error').length;
	warns += findings.filter((f) => f.level === 'warn').length;
}

// A score, so successive passes of the loop are comparable. Errors are weighted
// three to one because they are the ones that make a page wrong rather than weak.
const score = Math.max(0, 100 - errors * 3 - warns);

if (asJson) {
	console.log(JSON.stringify({ score, errors, warns, pages: pages.length, findings: [...byPage.values()].flat() }, null, 2));
} else {
	for (const [page, findings] of byPage) {
		console.log(`\n${page}`);
		for (const f of findings.sort((a, b) => a.line - b.line)) {
			const tag = f.level === 'error' ? 'ERROR' : 'warn ';
			console.log(`  ${tag} ${String(f.line).padStart(4)}  [${f.rule}] ${f.message}`);
		}
	}
	console.log(
		`\n${pages.length} page(s) · ${errors} error(s) · ${warns} warning(s) · score ${score}/100` +
			(errors === 0 && warns === 0 ? '  — clean' : '')
	);
}

process.exit(errors > 0 ? 1 : 0);
