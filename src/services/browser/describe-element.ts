/*
 * Runs inside the Browser panel's page, through the Chrome DevTools Protocol,
 * with `this` the element picked (or a text node in it). Kept apart so tests
 * can run it against a DOM. A plain string, as it is sent to the page as is.
 */

/** What the element is, where it sits, and the React components around it. */
export const DESCRIBE_ELEMENT = `function () {
	const el = this.nodeType === 1 ? this : this.parentElement;
	if (!el) return null;
	const parts = [];
	for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
		let part = node.localName;
		if (node.id) { parts.unshift(part + '#' + CSS.escape(node.id)); break; }
		part += [...node.classList].slice(0, 2).map((name) => '.' + CSS.escape(name)).join('');
		const parent = node.parentElement;
		if (parent) {
			const same = [...parent.children].filter((child) => child.localName === node.localName);
			if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
		}
		parts.unshift(part);
	}
	const box = el.getBoundingClientRect();
	const computed = getComputedStyle(el);
	const styles = {};
	for (const name of ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'gap']) {
		styles[name] = computed.getPropertyValue(name);
	}
	// React keeps each element's fiber on a property; its parents up the tree are the components that rendered it.
	const components = [];
	const fiberKey = Object.keys(el).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
	const appFrame = (stack) => {
		const lines = String(stack || '').split('\\n').slice(1);
		for (const line of lines) {
			const match = /\\(?((?:https?|file|webpack-internal|rsc):\\/\\/[^)\\s]+?):(\\d+):\\d+\\)?\\s*$/.exec(line);
			if (!match || /node_modules|react-dom|react\\.development|react-jsx|scheduler/.test(match[1])) continue;
			return match[1].replace(/^https?:\\/\\/[^/]+/, '').replace(/\\?[^:]*$/, '') + ':' + match[2];
		}
		return null;
	};
	let fiber = fiberKey ? el[fiberKey] : null;
	for (let steps = 0; fiber && steps < 300 && components.length < 6; steps++, fiber = fiber.return) {
		const type = fiber.type;
		const fn = typeof type === 'function' ? type : type && typeof type === 'object' ? type.render || type.type : null;
		if (!fn && !(type && type.displayName)) continue;
		const name = (type && type.displayName) || (fn && (fn.displayName || fn.name));
		if (!name || /^(Anonymous|_c\\d*)$/.test(name) || components[components.length - 1]?.name === name) continue;
		const source = fiber._debugSource ? fiber._debugSource.fileName + ':' + fiber._debugSource.lineNumber : appFrame(fiber._debugStack && fiber._debugStack.stack);
		components.push({ name, source });
	}
	const html = el.outerHTML;
	return {
		tag: el.localName,
		selector: parts.join(' > '),
		text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300),
		html: html.length > 4000 ? html.slice(0, 4000) + '…' : html,
		rect: { x: box.x, y: box.y, width: box.width, height: box.height },
		styles,
		components,
		url: location.href,
		title: document.title,
	};
}`;

