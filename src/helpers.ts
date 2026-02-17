export function closeEventToError(event: CloseEvent): Error {
    if (event.reason) return new Error(`WebSocket closed: ${event.code} ${event.reason}`);
    return new Error(`WebSocket closed: ${event.code}`);
}

export function toError(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) return reason;
    if (typeof reason === "string" && reason.length > 0) return new Error(reason);
    return new Error(fallbackMessage);
}

export type MaybePromise<T> = T | Promise<T>;
