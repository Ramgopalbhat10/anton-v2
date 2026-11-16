export class NotFoundError extends Error {
	readonly status = 404;
}

export class InvalidInputError extends Error {
	readonly status = 400;
}

export class ConflictError extends Error {
	readonly status = 409;
}

export function statusOf(error: unknown): number {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}
