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

export const openPage = async (url, { port = 9333, width = 1500, height = 1400 } = {}) => {
	const chrome = spawn(
		CHROME,
		[
			'--headless',
			'--disable-gpu',
			'--no-sandbox',
			'--hide-scrollbars',
			`--remote-debugging-port=${port}`,
			`--window-size=${width},${height}`,
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
