/**
 * Turn an explored view back into Evidence markdown.
 *
 * Exploration surfaces usually end at a screenshot. This project is BI-as-code,
 * so the useful exit is source: a `sql` block and a component, ready to paste
 * into a page and be reviewed, versioned and governed like everything else.
 * Discovery stays interactive; the result becomes code.
 */

import { pillLabel } from './spec.js';

/** Which Evidence component draws each mark, and the props it needs. */
const COMPONENT_FOR_MARK = {
	bar: 'BarChart',
	hbar: 'BarChart',
	line: 'LineChart',
	area: 'AreaChart',
	point: 'ScatterPlot',
	heatmap: 'Heatmap',
	table: 'DataTable',
	bigvalue: 'BigValue'
};

const indent = (text, spaces = 2) =>
	text
		.split('\n')
		.map((line) => (line.trim() ? ' '.repeat(spaces) + line : line))
		.join('\n');

/**
 * @param {object} args
 * @param {import('./types.js').Catalog} args.catalog
 * @param {import('./types.js').Spec} args.spec
 * @param {{ sql: string, columns: object[] }} args.compiled
 * @param {string} args.mark
 * @param {string} [args.queryName]
 * @returns {string}
 */
export const toEvidenceMarkdown = ({ catalog, spec, compiled, mark, queryName = 'explored' }) => {
	if (!compiled?.sql) return '';

	const dims = compiled.columns.filter((c) => c.role === 'dimension');
	const measures = compiled.columns.filter((c) => c.role === 'measure');

	const colorColumn = spec.color ? compiled.columns.find((c) => c.pill.key === spec.color.key) : null;
	const axis = dims.find((c) => c !== colorColumn) ?? dims[0];

	const component = COMPONENT_FOR_MARK[mark] ?? 'DataTable';
	const lines = [`\`\`\`sql ${queryName}`, compiled.sql, '```', ''];

	// A one-line note on provenance, because a pasted chart with no context is
	// how numbers lose their meaning.
	const described = [
		...spec.columns.map((p) => pillLabel(catalog, p)),
		...spec.rows.map((p) => pillLabel(catalog, p))
	];
	if (described.length) {
		lines.push(`<!-- noodle: ${described.join(' × ')} -->`, '');
	}

	if (component === 'DataTable') {
		lines.push(`<DataTable data={${queryName}} rows=20>`);
		for (const column of compiled.columns) {
			lines.push(
				`  <Column id=${column.alias} title="${escapeAttr(column.label ?? column.alias)}"` +
					(column.format ? ` fmt=${column.format}` : '') +
					`/>`
			);
		}
		lines.push('</DataTable>');
		return lines.join('\n');
	}

	if (component === 'BigValue') {
		const measure = measures[0];
		if (!measure) return lines.join('\n');
		lines.push(
			`<BigValue data={${queryName}} value=${measure.alias}` +
				` title="${escapeAttr(measure.label ?? measure.alias)}"` +
				(measure.format ? ` fmt=${measure.format}` : '') +
				`/>`
		);
		return lines.join('\n');
	}

	if (component === 'ScatterPlot') {
		const [x, y] = measures;
		if (!x || !y) return lines.join('\n');
		lines.push(
			`<ScatterPlot data={${queryName}} x=${x.alias} y=${y.alias}` +
				(spec.size ? ` size=${compiled.columns.find((c) => c.pill.key === spec.size.key)?.alias}` : '') +
				(colorColumn ? ` series=${colorColumn.alias}` : '') +
				(axis ? ` tooltipTitle=${axis.alias}` : '') +
				`/>`
		);
		return lines.join('\n');
	}

	if (component === 'Heatmap') {
		const measure = measures[0];
		const [x, y] = dims;
		if (!measure || !x || !y) return lines.join('\n');
		lines.push(`<Heatmap data={${queryName}} x=${x.alias} y=${y.alias} value=${measure.alias}` +
			(measure.format ? ` valueFmt=${measure.format}` : '') + `/>`);
		return lines.join('\n');
	}

	// Bar / line / area
	const measure = measures[0];
	if (!axis || !measure) return lines.join('\n');

	const attrs = [
		`data={${queryName}}`,
		`x=${axis.alias}`,
		`y=${measure.alias}`,
		measure.format ? `yFmt=${measure.format}` : null,
		colorColumn ? `series=${colorColumn.alias}` : null,
		mark === 'hbar' ? 'swapXY=true' : null,
		spec.stacked === false && colorColumn ? 'type=grouped' : null
	].filter(Boolean);

	const title = describeTitle(catalog, spec);
	if (title) attrs.push(`title="${escapeAttr(title)}"`);

	lines.push(`<${component} ${attrs.join(' ')}/>`);
	return lines.join('\n');
};

const describeTitle = (catalog, spec) => {
	const measure = spec.rows.find((p) => p.role === 'measure') ?? spec.columns.find((p) => p.role === 'measure');
	const dimension = spec.columns.find((p) => p.role === 'dimension') ?? spec.rows.find((p) => p.role === 'dimension');
	if (!measure || !dimension) return null;
	return `${pillLabel(catalog, measure)} by ${pillLabel(catalog, dimension)}`;
};

const escapeAttr = (value) => String(value ?? '').replace(/"/g, '&quot;');

export { indent };
