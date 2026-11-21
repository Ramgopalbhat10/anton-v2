/** An async queue: push from callbacks, read with `for await`. Reads after close drain what was pushed, then end. */
export function channel<T>() {
	const items: T[] = [];
	const waiters: ((result: IteratorResult<T>) => void)[] = [];
	let closed = false;
	return {
		push(item: T) {
			if (closed) return;
			const waiter = waiters.shift();
			if (waiter) waiter({ value: item, done: false });
			else items.push(item);
		},
		close() {
			closed = true;
			for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
		},
		[Symbol.asyncIterator](): AsyncIterator<T> {
			return {
				next: () => {
					if (items.length) return Promise.resolve({ value: items.shift()!, done: false });
					if (closed) return Promise.resolve({ value: undefined, done: true });
					return new Promise((resolve) => waiters.push(resolve));
				},
			};
		},
	};
}
