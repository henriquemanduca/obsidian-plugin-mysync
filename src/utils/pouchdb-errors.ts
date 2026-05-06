export function isPouchConflict(error: unknown) {
	return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}

export function isPouchNotFound(error: unknown) {
	return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}
