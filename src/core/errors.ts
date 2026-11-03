/** Errors the client caused or can act on. Each carries the HTTP status that says so. */
export class NotFoundError extends Error {
	readonly status = 404;
}

export class InvalidInputError extends Error {
	readonly status = 400;
}

/** The request is fine but the task is not in a state to take it. */
export class ConflictError extends Error {
	readonly status = 409;
}

/** The HTTP status for any thrown value: its own `status` when it has one, else 500. */
export function statusOf(error: unknown): number {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}
