import { newWebSocketRpcSession, type RpcSessionOptions } from "capnweb";
import { closeEventToError, MaybePromise, toError } from "./helpers.js";

type DisposableRpcStub = { [Symbol.dispose](): void, onRpcBroken(callback: (error: unknown) => void): void };
type RpcShape<T> = T extends object ? { [K in keyof T]: any } : Record<string, any>;
export type DynamicRpcStub = DisposableRpcStub & Record<string, any>;
export type ReconnectingWebSocketRpc<T = Record<string, never>> = RpcShape<T> & DisposableRpcStub;
type WebSocketSource = { createWebSocket: () => WebSocket | Promise<WebSocket> };

export type ReconnectingWebSocketRpcOpenEvent<T = Record<string, never>> = {
    connectionId: number,
    firstConnection: boolean,
    rpc: ReconnectingWebSocketRpc<T>,
};

export type ReconnectingWebSocketRpcCloseEvent = {
    connectionId: number,
    error: unknown,
    intentional: boolean,
    wasConnected: boolean,
};

export type ReconnectingWebSocketRpcReconnectOptions = {
    enabled?: boolean,
    delayMs?: number,
    maxDelayMs?: number,
    backoffFactor?: number,
};

export type ReconnectingWebSocketRpcSessionOptions<T = Record<string, never>> = WebSocketSource & {
    localMain?: any,
    rpcSessionOptions?: RpcSessionOptions,
    reconnectOptions?: ReconnectingWebSocketRpcReconnectOptions,
    onFirstInit?: (rpc: ReconnectingWebSocketRpc<T>) => MaybePromise<void>,
};

type OpenListener<T> = (event: ReconnectingWebSocketRpcOpenEvent<T>) => MaybePromise<void>;
type CloseListener = (event: ReconnectingWebSocketRpcCloseEvent) => MaybePromise<void>;

type ActiveConnection<T> = {
    id: number,
    webSocket: WebSocket,
    rpc: ReconnectingWebSocketRpc<T>,
    firstConnection: boolean,
    opened: boolean,
    closed: boolean,
    removeTransportListeners: () => void,
};

const READY_STATE_OPEN = 1;
const READY_STATE_CLOSING = 2;
const READY_STATE_CLOSED = 3;

class ConnectionAttemptCancelledError extends Error {
    constructor() {
        super("Connection attempt was cancelled by stop or replacement.");
    }
}

export class ReconnectingWebSocketRpcSession<T = Record<string, never>> {
    #connectPromise?: Promise<ReconnectingWebSocketRpc<T>>;
    #activeConnection?: ActiveConnection<T>;
    #connectionId = 0;
    #lifecycleToken = 0;
    #started = false;
    #stopReason: unknown = new Error("RPC session stopped.");
    #firstInitDone = false;
    #openedConnectionCount = 0;
    #retryDelayWait?: { timer: ReturnType<typeof setTimeout>, resolve: () => void };
    readonly #openListeners = new Set<OpenListener<T>>();
    readonly #closeListeners = new Set<CloseListener>();
    readonly #reconnect: boolean;
    readonly #reconnectDelayMs: number;
    readonly #reconnectDelayMaxMs: number;
    readonly #reconnectBackoffFactor: number;
    #nextReconnectDelayMs: number;

    constructor(readonly options: ReconnectingWebSocketRpcSessionOptions<T>) {
        const reconnectOptions = options.reconnectOptions;
        this.#reconnect = reconnectOptions?.enabled ?? true;
        this.#reconnectDelayMs = reconnectOptions?.delayMs ?? 250;
        this.#reconnectDelayMaxMs = reconnectOptions?.maxDelayMs ?? 5000;
        this.#reconnectBackoffFactor = reconnectOptions?.backoffFactor ?? 2;
        this.#nextReconnectDelayMs = this.#reconnectDelayMs;

        if (!Number.isFinite(this.#reconnectDelayMs) || this.#reconnectDelayMs < 0) throw new RangeError("reconnectOptions.delayMs must be a finite number >= 0.");
        if (!Number.isFinite(this.#reconnectDelayMaxMs) || this.#reconnectDelayMaxMs < this.#reconnectDelayMs) throw new RangeError("reconnectOptions.maxDelayMs must be >= reconnectOptions.delayMs.");
        if (!Number.isFinite(this.#reconnectBackoffFactor) || this.#reconnectBackoffFactor < 1) throw new RangeError("reconnectOptions.backoffFactor must be a finite number >= 1.");

        // Start immediately after construction so onOpen/onClose hooks can drive app behavior
        // without requiring an initial getRPC() call.
        this.#started = true;
        queueMicrotask(() => {
            if (!this.#started) return;
            void this.#ensureConnected().catch(() => { });
        });
    }

    get isStopped(): boolean {
        return !this.#started;
    }

    get isConnected(): boolean {
        const connection = this.#activeConnection;
        return connection !== undefined && connection.opened && !connection.closed;
    }

    onOpen(listener: OpenListener<T>): () => void {
        this.#openListeners.add(listener);

        const connection = this.#activeConnection;
        if (connection && connection.opened && !connection.closed) {
            const event = { connectionId: connection.id, firstConnection: connection.firstConnection, rpc: connection.rpc };
            try {
                Promise.resolve(listener(event)).catch(() => { });
            } catch { }
        }

        return () => this.#openListeners.delete(listener);
    }

    onClose(listener: CloseListener): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    async getRPC(): Promise<ReconnectingWebSocketRpc<T>> {
        const connection = this.#activeConnection;
        if (connection && connection.opened && !connection.closed) return connection.rpc;
        return this.start();
    }

    async start(): Promise<ReconnectingWebSocketRpc<T>> {
        this.#started = true;
        return this.#ensureConnected();
    }

    stop(reason: unknown = new Error("RPC session was stopped by the application.")): void {
        this.#stopReason = reason;
        this.#started = false;
        this.#lifecycleToken++;
        this.#interruptRetryDelay();
        this.#nextReconnectDelayMs = this.#reconnectDelayMs;
        const connection = this.#activeConnection;
        if (connection) this.#disconnectConnection(connection, reason, true);
        this.#connectPromise = undefined;
    }

    #ensureConnected(): Promise<ReconnectingWebSocketRpc<T>> {
        const connection = this.#activeConnection;
        if (connection && connection.opened && !connection.closed) return Promise.resolve(connection.rpc);
        if (this.#connectPromise) return this.#connectPromise;

        const token = this.#lifecycleToken;
        const promise = this.#connectUntilReady(token);
        this.#connectPromise = promise;
        // This promise is shared by concurrent getRPC() calls.
        // Clear it on both resolve and reject so future calls can start a fresh attempt.
        // The identity check avoids clearing a newer attempt from an older settled promise.
        const clearConnectPromise = () => { if (this.#connectPromise === promise) this.#connectPromise = undefined; };
        promise.then(clearConnectPromise, clearConnectPromise);
        return promise;
    }

    async #connectUntilReady(token: number): Promise<ReconnectingWebSocketRpc<T>> {
        while (true) {
            if (!this.#started) throw toError(this.#stopReason, "RPC session is stopped.");
            // Any stop() bumps this token and cancels prior in-flight attempts.
            if (token !== this.#lifecycleToken) throw new ConnectionAttemptCancelledError();

            try {
                const rpc = await this.#connectOnce(token);
                if (!this.#started) throw toError(this.#stopReason, "RPC session is stopped.");
                if (token !== this.#lifecycleToken) throw new ConnectionAttemptCancelledError();

                const activeConnection = this.#activeConnection;
                // Guard against races where a connection dies between setup completion and return.
                if (!activeConnection || activeConnection.closed || activeConnection.rpc !== rpc) throw new Error("Connection became unavailable before it was returned.");

                this.#nextReconnectDelayMs = this.#reconnectDelayMs;
                return rpc;
            } catch (err) {
                if (!this.#started) throw toError(this.#stopReason, "RPC session is stopped.");
                if (err instanceof ConnectionAttemptCancelledError) throw err;
                if (!this.#reconnect) throw err;

                const delay = this.#nextReconnectDelayMs;
                this.#nextReconnectDelayMs = Math.min(this.#reconnectDelayMaxMs, Math.ceil(this.#nextReconnectDelayMs * this.#reconnectBackoffFactor));

                try {
                    await this.#waitForRetryDelay(delay, token);
                } catch (waitError) {
                    if (!this.#started) throw toError(this.#stopReason, "RPC session is stopped.");
                    throw waitError;
                }
            }
        }
    }

    async #connectOnce(token: number): Promise<ReconnectingWebSocketRpc<T>> {
        const webSocket = await this.#createWebSocket();
        if (!this.#started || token !== this.#lifecycleToken) {
            this.#closeWebSocket(webSocket, "Connection attempt was replaced.");
            throw new ConnectionAttemptCancelledError();
        }

        const rpc = newWebSocketRpcSession(webSocket, this.options.localMain, this.options.rpcSessionOptions) as unknown as ReconnectingWebSocketRpc<T>;
        const connection = this.#installConnection(webSocket, rpc);
        this.#activeConnection = connection;
        const throwIfCancelled = () => {
            if (this.#started && token === this.#lifecycleToken) return;
            const error = new ConnectionAttemptCancelledError();
            this.#disconnectConnection(connection, error, true);
            throw error;
        };

        try {
            await this.#waitUntilSocketOpen(webSocket);
            if (connection.closed) throw new Error("WebSocket connection closed while opening.");
            throwIfCancelled();

            if (!this.#firstInitDone && this.options.onFirstInit) {
                await this.options.onFirstInit(connection.rpc);
                this.#firstInitDone = true;
            }

            if (connection.closed) throw new Error("WebSocket connection closed during initialization.");
            throwIfCancelled();

            // Mark as opened only when this connection is fully ready and about to emit onOpen.
            connection.opened = true;
            connection.firstConnection = this.#openedConnectionCount === 0;
            this.#openedConnectionCount++;
            // Open listeners are non-blocking; they can kick off background subscription setup.
            this.#emitOpen({ connectionId: connection.id, firstConnection: connection.firstConnection, rpc: connection.rpc });

            if (connection.closed) throw new Error("WebSocket connection closed during open listeners.");
            throwIfCancelled();
            return connection.rpc;
        } catch (err) {
            this.#disconnectConnection(connection, err, false);
            throw err;
        }
    }

    #installConnection(webSocket: WebSocket, rpc: ReconnectingWebSocketRpc<T>): ActiveConnection<T> {
        const connection: ActiveConnection<T> = { id: ++this.#connectionId, webSocket, rpc, firstConnection: false, opened: false, closed: false, removeTransportListeners: () => { } };
        const closeListener = (event: CloseEvent) => this.#disconnectConnection(connection, closeEventToError(event), false);
        const errorListener = () => this.#disconnectConnection(connection, new Error("WebSocket connection failed."), false);

        webSocket.addEventListener("close", closeListener);
        webSocket.addEventListener("error", errorListener);
        connection.removeTransportListeners = () => {
            webSocket.removeEventListener("close", closeListener);
            webSocket.removeEventListener("error", errorListener);
        };
        rpc.onRpcBroken(error => this.#disconnectConnection(connection, error, false));
        return connection;
    }

    #disconnectConnection(connection: ActiveConnection<T>, error: unknown, intentional: boolean) {
        if (connection.closed) return;
        connection.closed = true;
        connection.removeTransportListeners();
        if (this.#activeConnection?.id === connection.id) this.#activeConnection = undefined;
        const wasConnected = connection.opened;

        this.#closeWebSocket(connection.webSocket, "RPC session reconnecting.");
        try {
            connection.rpc[Symbol.dispose]();
        } catch { }

        // onClose is a lifecycle signal (one close per opened connection), not a per-attempt failure signal.
        if (wasConnected) this.#emitClose({ connectionId: connection.id, error, intentional, wasConnected });
        // Unexpected disconnects trigger reconnect in the background if enabled.
        if (wasConnected && !intentional && this.#started && this.#reconnect) void this.#ensureConnected().catch(() => { });
    }

    #emitOpen(event: ReconnectingWebSocketRpcOpenEvent<T>): void {
        for (const listener of this.#openListeners) {
            try {
                // Listener failures should not bring down a healthy connection.
                Promise.resolve(listener(event)).catch(() => { });
            } catch { }
        }
    }

    #emitClose(event: ReconnectingWebSocketRpcCloseEvent): void {
        for (const listener of this.#closeListeners) {
            try {
                Promise.resolve(listener(event)).catch(() => { });
            } catch { }
        }
    }

    async #createWebSocket(): Promise<WebSocket> {
        return this.options.createWebSocket();
    }

    async #waitUntilSocketOpen(webSocket: WebSocket): Promise<void> {
        if (webSocket.readyState === READY_STATE_OPEN) return;
        if (webSocket.readyState === READY_STATE_CLOSING || webSocket.readyState === READY_STATE_CLOSED) throw new Error("WebSocket is already closed.");

        await new Promise<void>((resolve, reject) => {
            const openListener = () => {
                cleanup();
                resolve();
            };
            const closeListener = (event: CloseEvent) => {
                cleanup();
                reject(closeEventToError(event));
            };
            const errorListener = () => {
                cleanup();
                reject(new Error("WebSocket connection failed."));
            };
            const cleanup = () => {
                webSocket.removeEventListener("open", openListener);
                webSocket.removeEventListener("close", closeListener);
                webSocket.removeEventListener("error", errorListener);
            };

            webSocket.addEventListener("open", openListener);
            webSocket.addEventListener("close", closeListener);
            webSocket.addEventListener("error", errorListener);

            // Re-check after listener registration to avoid missing a fast state transition.
            if (webSocket.readyState === READY_STATE_OPEN) {
                cleanup();
                resolve();
            } else if (webSocket.readyState === READY_STATE_CLOSING || webSocket.readyState === READY_STATE_CLOSED) {
                cleanup();
                reject(new Error("WebSocket is already closed."));
            }
        });
    }

    async #waitForRetryDelay(delayMs: number, token: number): Promise<void> {
        if (delayMs <= 0) {
            if (token !== this.#lifecycleToken) throw new ConnectionAttemptCancelledError();
            return;
        }

        await new Promise<void>((resolve) => {
            // Keep a single in-flight backoff wait and guard with identity checks so an old timer
            // can never clear or resolve a newer wait after stop/start churn.
            const wait = {
                timer: setTimeout(() => {
                    if (this.#retryDelayWait !== wait) return;
                    this.#retryDelayWait = undefined;
                    wait.resolve();
                }, delayMs), resolve
            };
            this.#retryDelayWait = wait;
        });

        // Token might have changed while waiting (stop during backoff).
        if (token !== this.#lifecycleToken) throw new ConnectionAttemptCancelledError();
    }

    #interruptRetryDelay(): void {
        const wait = this.#retryDelayWait;
        if (!wait) return;
        this.#retryDelayWait = undefined;
        clearTimeout(wait.timer);
        wait.resolve();
    }

    #closeWebSocket(webSocket: WebSocket, reason: string): void {
        if (webSocket.readyState === READY_STATE_CLOSING || webSocket.readyState === READY_STATE_CLOSED) return;
        try {
            webSocket.close(3000, reason.slice(0, 120));
        } catch { }
    }
}

