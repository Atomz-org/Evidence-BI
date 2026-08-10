/**
 * A minimal Chrome DevTools Protocol driver.
 *
 * The noodle surface is entirely client-side — catalog introspection, query
 * execution and chart rendering all happen in the browser — so a DOM dump
 * proves almost nothing. This drives a real page: collects console output,
 * evaluates expressions and dispatches input.
 */
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A port nothing is listening on.
 *
 * A fixed debugging port is an attach-to-whatever-is-there instruction. When an
 * earlier run leaves Chrome alive, the new `spawn` cannot bind, its launch URL
 * is never visited, and this driver silently attaches to a browser still
 * showing an old page. From the outside that is a suite passing against a build
 * from several iterations ago — the DOM is stale while a `fetch()` from inside
 * the same page returns the current document, a contradiction nobody thinks to
 * check for. Found the hard way: a literal string put into a component could
 * not be found in the DOM it was supposed to be rendering into.
 *
 * Binding the port here first means the browser under test is the one this
 * process started.
 */
const freePort = async (start) => {
	const net = await import('node:net');
	for (let candidate = start; candidate < start + 200; candidate += 1) {
		const free = await new Promise((resolve) => {
			const probe = net.createServer();
			probe.once('error', () => resolve(false));
			probe.once('listening', () => probe.close(() => resolve(true)));
			probe.listen(candidate, '127.0.0.1');
		});
		if (free) return candidate;
	}
	throw new Error(`no free debugging port near ${start}`);
};

export const openPage = async (url, { port, width = 1500, height = 1400, colorScheme = 'light' } = {}) => {
	port ??= await freePort(9400 + (process.pid % 400));
	const chrome = spawn(
		CHROME,
		[
			'--headless',
			'--disable-gpu',
			'--no-sandbox',
			'--hide-scrollbars',
			`--remote-debugging-port=${port}`,
			`--window-size=${width},${height}`,
			// Shared, and deliberately so. A throwaway profile per run looks tidier
			// and is what stops Chrome restoring form state between runs — but a
			// profile Chrome has never seen sends it into first-run work that
			// replaces the tab this driver is attached to about eight seconds in.
			// Every `evaluate` after that hangs forever, which reads as a slow test
			// rather than a broken one. The staleness this was meant to solve was
			// really the fixed-port attach above; with that fixed, one profile is
			// correct.
			'--user-data-dir=/tmp/noodle-cdp-profile',
			url
		],
		{ stdio: 'ignore' }
	);

	// Wait for the debugging endpoint and the page target to appear.
	let target = null;
	for (let i = 0; i < 60 && !target; i++) {
		await sleep(250);
		try {
			const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
			target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
		} catch {
			/* not up yet */
		}
	}
	if (!target) {
		chrome.kill();
		throw new Error('Chrome did not expose a page target');
	}

	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});

	let nextId = 1;
	const pending = new Map();
	const consoleLines = [];
	const pageErrors = [];

	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			message.error ? reject(new Error(message.error.message)) : resolve(message.result);
			return;
		}
		if (message.method === 'Runtime.consoleAPICalled') {
			consoleLines.push(
				`[${message.params.type}] ` +
					message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
			);
		}
		if (message.method === 'Runtime.exceptionThrown') {
			pageErrors.push(
				message.params.exceptionDetails.exception?.description ??
					message.params.exceptionDetails.text
			);
		}
	};

	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});

	await send('Runtime.enable');
	await send('Page.enable');

	// Pin the colour scheme.
	//
	// Evidence follows `prefers-color-scheme`, and several assertions in this
	// suite are about which palette got drawn — "the light page did not draw the
	// dark palette" cannot be evaluated on a machine that has just rolled over
	// into dark mode. Without this the same commit passes in the afternoon and
	// fails at three in the morning, which teaches everyone to ignore the suite.
	// Tests that care about the other surface pass `colorScheme: 'dark'`.
	await send('Emulation.setEmulatedMedia', {
		features: [{ name: 'prefers-color-scheme', value: colorScheme }]
	});

	// Fail loudly if the page under the driver is not the page that was asked
	// for. Chrome opens `about:blank` first and navigates a moment later, so this
	// polls — but it does give up, because silently testing whatever happens to
	// be loaded is the failure the free port above exists to prevent.
	const wanted = url.split('#')[0];
	let href = '';
	for (let i = 0; i < 100; i += 1) {
		const landed = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
		href = String(landed.result?.value ?? '');
		if (href.startsWith(wanted)) break;
		await sleep(100);
	}
	if (!href.startsWith(wanted)) {
		chrome.kill();
		throw new Error(`the page under the driver is ${href || 'unknown'}, not ${url}`);
	}

	/** Evaluate an expression in the page and return its JSON value. */
	const evaluate = async (expression) => {
		const result = await send('Runtime.evaluate', {
			expression: `(async () => { ${expression} })()`,
			awaitPromise: true,
			returnByValue: true
		});
		if (result.exceptionDetails) {
			throw new Error(
				result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
			);
		}
		return result.result.value;
	};

	const screenshot = async (path) => {
		const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
		const { writeFileSync } = await import('node:fs');
		writeFileSync(path, Buffer.from(data, 'base64'));
	};

	const close = () => {
		try {
			ws.close();
		} catch {
			/* already gone */
		}
		chrome.kill();
	};

	return { evaluate, screenshot, close, consoleLines, pageErrors, send, sleep };
};
