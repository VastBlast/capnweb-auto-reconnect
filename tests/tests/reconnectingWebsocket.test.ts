import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { newWebSocketRpcSession } from "capnweb";
import { TestTarget } from "./testUtil.js";
import {
    ReconnectingWebSocketRpcSession,
    type ReconnectingWebSocketRpcCloseEvent,
} from "../../src/index.js";

type TestRpcApi = Pick<TestTarget, "square" | "throwError" | "makeCounter">;

let httpServer: http.Server;
let wsServer: WebSocketServer;
let wsUrl = "";
let acceptedConnectionCount = 0;
let sockets = new Set<NodeWebSocket>();
let firstConnectionForcedCloseDelayMs: number | undefined;
const createTestWebSocket = () => new WebSocket(wsUrl);

beforeEach(async () => {
    acceptedConnectionCount = 0;
    sockets = new Set<NodeWebSocket>();
    firstConnectionForcedCloseDelayMs = undefined;

    httpServer = http.createServer();
    wsServer = new WebSocketServer({ server: httpServer });

    wsServer.on("connection", socket => {
        acceptedConnectionCount++;
        sockets.add(socket);
        socket.on("close", () => {
            sockets.delete(socket);
        });

        if (acceptedConnectionCount === 1 && firstConnectionForcedCloseDelayMs !== undefined) {
            setTimeout(() => {
                if (socket.readyState === NodeWebSocket.OPEN) {
                    socket.close(1012, "forced first-connection close");
                }
            }, firstConnectionForcedCloseDelayMs);
        }

        // The `ws` package's WebSocket type doesn't match DOM's type declaration.
        newWebSocketRpcSession(socket as any, new TestTarget());
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.listen(0, "127.0.0.1", () => resolve());
        httpServer.once("error", reject);
    });

    const address = httpServer.address();
    if (address === null || typeof address === "string") {
        throw new Error("Failed to resolve HTTP server address.");
    }
    wsUrl = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
    for (const socket of sockets) {
        socket.terminate();
    }
    sockets.clear();

    await new Promise<void>(resolve => {
        wsServer.close(() => resolve());
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.close(err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for condition.");
        }
        await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}

async function stopSessionUsingFakeTimers(
    session: ReconnectingWebSocketRpcSession<TestRpcApi>,
    ...pendingStarts: Array<Promise<void> | undefined>
): Promise<void> {
    session.stop(new Error("end test"));
    await vi.runOnlyPendingTimersAsync();
    for (const pendingStart of pendingStarts) {
        if (pendingStart) await pendingStart;
    }
    vi.useRealTimers();
}

class RaceyOpenWebSocket extends EventTarget {
    #readyState = 0; // CONNECTING
    #readCount = 0;

    get readyState() {
        this.#readCount++;
        if (this.#readCount === 2) {
            // Simulate a transition to OPEN that happened right before open listeners are attached.
            this.#readyState = 1; // OPEN
            return 0; // CONNECTING for this read
        }
        return this.#readyState;
    }

    send(_message: string): void { }

    close(_code?: number, _reason?: string): void {
        this.#readyState = 3; // CLOSED
        this.dispatchEvent(new Event("close"));
    }
}

class NeverOpenWebSocket extends EventTarget {
    #readyState = 0; // CONNECTING

    constructor() {
        super();
        queueMicrotask(() => {
            this.#readyState = 3; // CLOSED
            this.dispatchEvent(new Event("close"));
        });
    }

    get readyState() {
        return this.#readyState;
    }

    send(_message: string): void { }

    close(_code?: number, _reason?: string): void {
        this.#readyState = 3; // CLOSED
        this.dispatchEvent(new Event("close"));
    }
}

describe("ReconnectingWebSocketRpcSession", () => {
    const fastReconnectOptions = { reconnectOptions: { delayMs: 5, maxDelayMs: 25 } } as const;
    const immediateReconnectOptions = { reconnectOptions: { delayMs: 0, maxDelayMs: 0 } } as const;
    const noReconnectOptions = { reconnectOptions: { enabled: false } } as const;
    const noReconnectImmediateOptions = { reconnectOptions: { enabled: false, delayMs: 0, maxDelayMs: 0 } } as const;

    it.each([
        { reconnectOptions: { delayMs: -1 }, message: "reconnectOptions.delayMs" },
        { reconnectOptions: { delayMs: Number.NaN }, message: "reconnectOptions.delayMs" },
        { reconnectOptions: { delayMs: 10, maxDelayMs: 5 }, message: "reconnectOptions.maxDelayMs" },
        { reconnectOptions: { backoffFactor: 0.9 }, message: "reconnectOptions.backoffFactor" },
        { reconnectOptions: { backoffFactor: Number.POSITIVE_INFINITY }, message: "reconnectOptions.backoffFactor" },
    ])("validates reconnect options: $message", ({ reconnectOptions, message }) => {
        expect(() => new ReconnectingWebSocketRpcSession<TestRpcApi>({ createWebSocket: () => createTestWebSocket(), reconnectOptions })).toThrow(message);
    });

    it("tracks isStopped and isConnected across start/stop lifecycle", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            expect(session.isStopped).toBe(false);
            expect(session.isConnected).toBe(false);

            const rpc1 = await session.start();
            expect(await rpc1.square(1)).toBe(1);
            expect(session.isStopped).toBe(false);
            expect(session.isConnected).toBe(true);

            session.stop();
            expect(session.isStopped).toBe(true);
            expect(session.isConnected).toBe(false);

            const rpc2 = await session.start();
            expect(await rpc2.square(2)).toBe(4);
            expect(session.isStopped).toBe(false);
            expect(session.isConnected).toBe(true);
        } finally {
            session.stop();
        }
    });

    it("retries when createWebSocket returns a rejected promise", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                if (attempts < 3) return Promise.reject(new Error(`temporary rejection ${attempts}`));
                return createTestWebSocket();
            },
            ...immediateReconnectOptions,
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(25)).toBe(625);
            expect(attempts).toBe(3);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("returns stop reason for a pending start() when stopped during retries", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                throw new Error("always fail while start() is pending");
            },
            reconnectOptions: { delayMs: 500, maxDelayMs: 500 },
        });

        const pendingStart = session.start();
        await waitFor(() => attempts >= 1);

        session.stop(new Error("manual stop while start pending"));

        await expect(pendingStart).rejects.toThrow("manual stop while start pending");
        expect(attempts).toBe(1);
    });

    it("returns string stop reason for a pending start() when stopped during retries", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                throw new Error("always fail while start() is pending");
            },
            reconnectOptions: { delayMs: 500, maxDelayMs: 500 },
        });

        const pendingStart = session.start();
        await waitFor(() => attempts >= 1);

        session.stop("manual stop string reason");

        await expect(pendingStart).rejects.toThrow("manual stop string reason");
        expect(attempts).toBe(1);
    });

    it("uses fallback stop reason for a pending start() when stop reason is not an Error/string", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                throw new Error("always fail while start() is pending");
            },
            reconnectOptions: { delayMs: 500, maxDelayMs: 500 },
        });

        const pendingStart = session.start();
        await waitFor(() => attempts >= 1);

        session.stop({ reason: "object stop reason" });

        await expect(pendingStart).rejects.toThrow("RPC session is stopped.");
        expect(attempts).toBe(1);
    });

    it("returns stop reason for a pending start() when stopped during an in-flight createWebSocket", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
        let pendingStart: Promise<unknown> | undefined;
        let pendingStartSettled: Promise<void> | undefined;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => new Promise<WebSocket>(resolve => {
                setTimeout(() => resolve(new NeverOpenWebSocket() as unknown as WebSocket), 50);
            }),
            reconnectOptions: { delayMs: 0, maxDelayMs: 0 },
        });

        try {
            session.stop(new Error("pause auto-start"));
            pendingStart = session.start();
            pendingStartSettled = pendingStart.then(() => { }, () => { });
            await Promise.resolve();

            session.stop(new Error("manual stop during in-flight createWebSocket"));
            await vi.advanceTimersByTimeAsync(50);

            await expect(pendingStart).rejects.toThrow("manual stop during in-flight createWebSocket");
        } finally {
            await stopSessionUsingFakeTimers(session, pendingStartSettled);
        }
    });

    it("auto-starts and can call getRPC() from onOpen without an explicit initial getRPC()", async () => {
        let resolveOpened: (() => void) | undefined;
        const opened = new Promise<void>(resolve => {
            resolveOpened = resolve;
        });
        const values: number[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        session.onOpen(async () => {
            const rpc = await session.getRPC();
            values.push(await rpc.square(20));
            if (resolveOpened) resolveOpened();
        });

        try {
            await Promise.race([
                opened,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(() => reject(new Error("onOpen did not fire from auto-start")), 500);
                }),
            ]);
            expect(values).toStrictEqual([400]);
        } finally {
            session.stop();
        }
    });

    it("supports promise-pipelined getRPC() calls", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            expect(await session.getRPC().square(12)).toBe(144);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("supports multiple pipelined calls from a single unresolved getRPC handle", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            const rpc = session.getRPC();
            const [left, right] = await Promise.all([rpc.square(3), rpc.square(4)]);
            expect(left).toBe(9);
            expect(right).toBe(16);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("behaves like a promise when passed to Promise.resolve()", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            const resolved = await Promise.resolve(session.getRPC());
            const started = await session.start();
            expect(resolved).toBe(started);
            expect(await resolved.square(6)).toBe(36);
        } finally {
            session.stop();
        }
    });

    it("supports primitive coercion without triggering pipelined call rejections", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on("unhandledRejection", onUnhandledRejection);

        try {
            const pipelinedRpc = session.getRPC();
            const stringify = (value: any) => String(value);
            const interpolate = (value: any) => `${value}`;
            const toNumber = (value: any) => Number(value);
            const rawPipelinedRpc: any = pipelinedRpc;

            expect(stringify(pipelinedRpc)).toBe("[object Promise]");
            expect(interpolate(pipelinedRpc)).toBe("[object Promise]");
            expect(toNumber(pipelinedRpc)).toBeNaN();
            expect(rawPipelinedRpc.toString()).toBe("[object Promise]");
            expect(rawPipelinedRpc.valueOf()).toBe(pipelinedRpc);

            const rpc = await pipelinedRpc;
            expect(await rpc.square(6)).toBe(36);

            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(unhandledRejections).toStrictEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandledRejection);
            session.stop();
        }
    });

    it("supports pipelined property reads", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            expect(await session.getRPC().makeCounter(9).value).toBe(9);
        } finally {
            session.stop();
        }
    });

    it("supports catch/finally on pipelined getRPC call failures", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        let finallyCalled = false;

        try {
            const message = await session.getRPC().throwError()
                .catch((error: unknown) => error instanceof Error ? error.message : String(error))
                .finally(() => {
                    finallyCalled = true;
                });

            expect(message).toContain("test error");
            expect(finallyCalled).toBe(true);
        } finally {
            session.stop();
        }
    });

    it("still returns the live stub when awaiting getRPC()", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            const fromAwait = await session.getRPC();
            const fromStart = await session.start();
            expect(fromAwait).toBe(fromStart);
            expect(await fromAwait.square(5)).toBe(25);
        } finally {
            session.stop();
        }
    });

    it("preserves pipelining through RPC promises returned by methods", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            expect(await session.getRPC().makeCounter(4).increment(3)).toBe(7);
        } finally {
            session.stop();
        }
    });

    it("calls onOpen immediately if listener is added after already connected", async () => {
        let resolveOpened: (() => void) | undefined;
        const opened = new Promise<void>(resolve => {
            resolveOpened = resolve;
        });
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(21)).toBe(441);

            session.onOpen(() => {
                if (resolveOpened) resolveOpened();
            });

            await Promise.race([
                opened,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(() => reject(new Error("late onOpen listener did not receive current open state")), 300);
                }),
            ]);
        } finally {
            session.stop();
        }
    });

    it("deduplicates repeated onOpen registrations for the same callback", async () => {
        const openConnectionIds: number[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        const onOpen = (event: { connectionId: number }) => {
            openConnectionIds.push(event.connectionId);
        };
        const off1 = session.onOpen(onOpen);
        const off2 = session.onOpen(onOpen);
        let off3 = () => { };

        try {
            let rpc = await session.getRPC();
            expect(await rpc.square(34)).toBe(1156);
            expect(openConnectionIds).toStrictEqual([1]);
            off3 = session.onOpen(onOpen);
            expect(openConnectionIds).toStrictEqual([1]);

            for (const socket of sockets) {
                socket.close(1012, "forced reconnect for onOpen dedupe");
            }
            await waitFor(() => acceptedConnectionCount >= 2);

            rpc = await session.getRPC();
            expect(await rpc.square(35)).toBe(1225);
            expect(openConnectionIds).toStrictEqual([1, 2]);

            off1();
            for (const socket of sockets) {
                socket.close(1012, "forced reconnect after onOpen off");
            }
            await waitFor(() => acceptedConnectionCount >= 3);

            rpc = await session.getRPC();
            expect(await rpc.square(36)).toBe(1296);
            expect(openConnectionIds).toStrictEqual([1, 2]);
        } finally {
            off1();
            off2();
            off3();
            session.stop();
        }
    });

    it("does not auto-start if stopped before constructor microtask runs", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.stop(new Error("stop before auto-start"));

        try {
            await new Promise<void>(resolve => setTimeout(resolve, 40));
            expect(acceptedConnectionCount).toBe(0);

            const rpc = await session.start();
            expect(await rpc.square(24)).toBe(576);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("does not call onOpen until onFirstOpen completes", async () => {
        let initStarted = false;
        let resolveInit: (() => void) | undefined;
        const initGate = new Promise<void>(resolve => {
            resolveInit = resolve;
        });
        let openCalls = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
            onFirstOpen: async () => {
                initStarted = true;
                await initGate;
            },
        });

        try {
            await waitFor(() => initStarted);
            session.onOpen(() => {
                openCalls++;
            });

            await new Promise<void>(resolve => setTimeout(resolve, 30));
            expect(openCalls).toBe(0);

            if (resolveInit) resolveInit();
            await waitFor(() => openCalls === 1);
        } finally {
            if (resolveInit) resolveInit();
            session.stop();
        }
    });

    it("keeps getRPC() pending while onFirstOpen is still running", async () => {
        let initStarted = false;
        let resolveInit: (() => void) | undefined;
        const initGate = new Promise<void>(resolve => {
            resolveInit = resolve;
        });
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
            onFirstOpen: async () => {
                initStarted = true;
                await initGate;
            },
        });
        let rpcSettled = false;

        try {
            await waitFor(() => initStarted);
            const pendingRpc = session.getRPC().then(rpc => {
                rpcSettled = true;
                return rpc;
            }, error => {
                rpcSettled = true;
                throw error;
            });

            await new Promise<void>(resolve => setTimeout(resolve, 30));
            expect(rpcSettled).toBe(false);

            if (resolveInit) resolveInit();

            const rpc = await pendingRpc;
            expect(await rpc.square(26)).toBe(676);
        } finally {
            if (resolveInit) resolveInit();
            session.stop();
        }
    });

    it("keeps pipelined getRPC() calls pending while onFirstOpen is still running", async () => {
        let initStarted = false;
        let resolveInit: (() => void) | undefined;
        const initGate = new Promise<void>(resolve => {
            resolveInit = resolve;
        });
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
            onFirstOpen: async () => {
                initStarted = true;
                await initGate;
            },
        });
        let callSettled = false;

        try {
            await waitFor(() => initStarted);
            const pendingCall = session.getRPC().square(28).then((value: number) => {
                callSettled = true;
                return value;
            }, (error: unknown) => {
                callSettled = true;
                throw error;
            });

            await new Promise<void>(resolve => setTimeout(resolve, 30));
            expect(callSettled).toBe(false);

            if (resolveInit) resolveInit();

            expect(await pendingCall).toBe(784);
        } finally {
            if (resolveInit) resolveInit();
            session.stop();
        }
    });

    it("keeps start() pending while onFirstOpen is still running", async () => {
        let initStarted = false;
        let resolveInit: (() => void) | undefined;
        const initGate = new Promise<void>(resolve => {
            resolveInit = resolve;
        });
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
            onFirstOpen: async () => {
                initStarted = true;
                await initGate;
            },
        });
        let startSettled = false;

        try {
            await waitFor(() => initStarted);
            const pendingStart = session.start().then(rpc => {
                startSettled = true;
                return rpc;
            }, error => {
                startSettled = true;
                throw error;
            });

            await new Promise<void>(resolve => setTimeout(resolve, 30));
            expect(startSettled).toBe(false);

            if (resolveInit) resolveInit();

            const rpc = await pendingStart;
            expect(await rpc.square(27)).toBe(729);
        } finally {
            if (resolveInit) resolveInit();
            session.stop();
        }
    });

    it("deduplicates concurrent getRPC calls", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        try {
            const [rpc1, rpc2, rpc3] = await Promise.all([session.getRPC(), session.getRPC(), session.getRPC()]);
            expect(rpc1).toBe(rpc2);
            expect(rpc2).toBe(rpc3);
            expect(await rpc1.square(11)).toBe(121);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("supports an async createWebSocket factory", async () => {
        let factoryCalls = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: async () => {
                factoryCalls++;
                await new Promise<void>(resolve => setTimeout(resolve, 5));
                return createTestWebSocket();
            },
            ...fastReconnectOptions,
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(10)).toBe(100);
            expect(factoryCalls).toBe(1);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("retries connection creation failures until success", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                if (attempts < 3) {
                    throw new Error(`temporary failure ${attempts}`);
                }
                return createTestWebSocket();
            },
            ...immediateReconnectOptions,
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(12)).toBe(144);
            expect(attempts).toBe(3);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("does not retry initial connection when reconnect=false", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                throw new Error("always fails");
            },
            ...noReconnectImmediateOptions,
        });

        await expect(session.getRPC()).rejects.toThrow("always fails");
        expect(attempts).toBe(1);
    });

    it("resolves when socket opens between state check and open-listener registration", async () => {
        const fakeSocket = new RaceyOpenWebSocket();
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => fakeSocket as unknown as WebSocket,
            ...noReconnectOptions,
        });

        try {
            const rpc = await Promise.race([
                session.getRPC(),
                new Promise<never>((_resolve, reject) => {
                    setTimeout(() => reject(new Error("timed out waiting for getRPC")), 200);
                }),
            ]);
            expect(rpc).toBeDefined();
        } finally {
            session.stop();
        }
    });

    it("calls onFirstOpen exactly once", async () => {
        let firstOpenCalls = 0;

        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
            onFirstOpen: async rpc => {
                firstOpenCalls++;
                expect(await rpc.square(3)).toBe(9);
            },
        });

        try {
            const rpc1 = await session.getRPC();
            expect(await rpc1.square(5)).toBe(25);

            const rpc2 = await session.getRPC();
            expect(rpc2).toBe(rpc1);
            expect(await rpc2.square(7)).toBe(49);
            expect(firstOpenCalls).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("retries first-open hook when onFirstOpen fails transiently", async () => {
        let firstOpenCalls = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...immediateReconnectOptions,
            onFirstOpen: async rpc => {
                firstOpenCalls++;
                if (firstOpenCalls === 1) {
                    throw new Error("transient first-open failure");
                }
                expect(await rpc.square(30)).toBe(900);
            },
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(31)).toBe(961);
            expect(firstOpenCalls).toBe(2);
            expect(acceptedConnectionCount).toBeGreaterThanOrEqual(2);
        } finally {
            session.stop();
        }
    });

    it("does not block getRPC on async onOpen listeners", async () => {
        let resolveOpenListener: (() => void) | undefined;
        const openListenerGate = new Promise<void>(resolve => {
            resolveOpenListener = resolve;
        });

        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.onOpen(() => openListenerGate);

        try {
            const rpc = await Promise.race([
                session.getRPC(),
                new Promise<never>((_resolve, reject) => {
                    setTimeout(() => reject(new Error("getRPC blocked on onOpen listener")), 300);
                }),
            ]);
            expect(await rpc.square(18)).toBe(324);
        } finally {
            if (resolveOpenListener) {
                resolveOpenListener();
            }
            session.stop();
        }
    });

    it("keeps connection alive when onOpen listener throws", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.onOpen(() => {
            throw new Error("open listener failure");
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(19)).toBe(361);
            expect(acceptedConnectionCount).toBe(1);
        } finally {
            session.stop();
        }
    });

    it("reconnects on disconnect and allows listener unregistration", async () => {
        const closeEvents: ReconnectingWebSocketRpcCloseEvent[] = [];
        const openConnectionIds: number[] = [];

        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });

        const offOpen = session.onOpen(event => {
            openConnectionIds.push(event.connectionId);
        });
        const offClose = session.onClose(event => {
            closeEvents.push(event);
        });

        try {
            let rpc = await session.getRPC();
            expect(await rpc.square(4)).toBe(16);
            expect(openConnectionIds.length).toBe(1);
            expect(acceptedConnectionCount).toBe(1);
            expect(sockets.size).toBeGreaterThan(0);

            for (const socket of sockets) {
                socket.close(1012, "forced disconnect");
            }

            await waitFor(() => acceptedConnectionCount >= 2);
            await waitFor(() => openConnectionIds.length >= 2);

            rpc = await session.getRPC();
            expect(await rpc.square(6)).toBe(36);
            expect(closeEvents.some(event => !event.intentional && event.wasConnected)).toBe(true);

            offOpen();
            offClose();
            const openCount = openConnectionIds.length;
            const closeCount = closeEvents.length;

            session.stop(new Error("manual stop for restart test"));
            rpc = await session.start();
            expect(await rpc.square(8)).toBe(64);
            expect(openConnectionIds.length).toBe(openCount);
            expect(closeEvents.length).toBe(closeCount);
        } finally {
            session.stop();
        }
    });

    it("keeps reconnect behavior when onClose listeners throw or reject", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.onClose(() => {
            throw new Error("sync close listener failure");
        });
        session.onClose(async () => {
            throw new Error("async close listener failure");
        });

        try {
            let rpc = await session.getRPC();
            expect(await rpc.square(32)).toBe(1024);

            for (const socket of sockets) {
                socket.close(1012, "forced disconnect for close-listener failure test");
            }

            await waitFor(() => acceptedConnectionCount >= 2);
            rpc = await session.getRPC();
            expect(await rpc.square(33)).toBe(1089);
        } finally {
            session.stop();
        }
    });

    it("stops reconnecting after stop() and can start again", async () => {
        const closeEvents: ReconnectingWebSocketRpcCloseEvent[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.onClose(event => {
            closeEvents.push(event);
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(2)).toBe(4);
            expect(acceptedConnectionCount).toBe(1);

            session.stop(new Error("manual stop for test"));
            await waitFor(() => closeEvents.length > 0);
            expect(closeEvents[closeEvents.length - 1].intentional).toBe(true);

            for (const socket of sockets) {
                socket.close(1012, "forced disconnect after stop");
            }

            await new Promise<void>(resolve => setTimeout(resolve, 50));
            expect(acceptedConnectionCount).toBe(1);
            const restartedRpc = await session.start();
            expect(await restartedRpc.square(5)).toBe(25);
            await waitFor(() => acceptedConnectionCount >= 2);
        } finally {
            session.stop();
        }
    });

    it("returns stop reason when stopped while waiting to retry", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                throw new Error("always fail while retrying");
            },
            reconnectOptions: { delayMs: 500, maxDelayMs: 500 },
        });

        const pending = session.getRPC();
        await waitFor(() => attempts >= 1);

        session.stop(new Error("manual stop while retrying"));

        await expect(pending).rejects.toThrow("manual stop while retrying");
        expect(attempts).toBe(1);
    });

    it("rejects pipelined getRPC calls with stop reason when stopped while retrying", async () => {
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                throw new Error("always fail while retrying");
            },
            reconnectOptions: { delayMs: 500, maxDelayMs: 500 },
        });

        const pending = session.getRPC().square(3);
        await waitFor(() => attempts >= 1);

        session.stop(new Error("manual stop while pipelined getRPC call is pending"));

        await expect(pending).rejects.toThrow("manual stop while pipelined getRPC call is pending");
        expect(attempts).toBe(1);
    });

    it("resets retry backoff after a manual stop/start", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
        let firstStart: Promise<void> | undefined;
        let secondStart: Promise<void> | undefined;
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                throw new Error("always fail");
            },
            reconnectOptions: { delayMs: 100, maxDelayMs: 400, backoffFactor: 2 },
        });

        const trackedStart = () => session.start().then(
            () => { throw new Error("start() unexpectedly resolved"); },
            () => { },
        );

        try {
            // Prevent constructor auto-start from affecting this assertion sequence.
            session.stop(new Error("pause auto-start"));

            firstStart = trackedStart();
            await Promise.resolve();
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(100);
            expect(attempts).toBe(2);

            await vi.advanceTimersByTimeAsync(200);
            expect(attempts).toBe(3);

            session.stop(new Error("manual restart"));

            secondStart = trackedStart();
            await Promise.resolve();
            expect(attempts).toBe(4);

            await vi.advanceTimersByTimeAsync(100);
            expect(attempts).toBe(5);
        } finally {
            await stopSessionUsingFakeTimers(session, firstStart, secondStart);
        }
    });

    it("waits only the remaining delay after a quick failed attempt", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        let pendingStart: Promise<void> | undefined;
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                return new Promise<WebSocket>((_resolve, reject) => {
                    setTimeout(() => reject(new Error("quick failure")), 40);
                });
            },
            reconnectOptions: { delayMs: 100, maxDelayMs: 100, backoffFactor: 1 },
        });

        const trackStart = () => session.start().then(
            () => { throw new Error("start() unexpectedly resolved"); },
            () => { },
        );

        try {
            session.stop(new Error("pause auto-start"));
            pendingStart = trackStart();
            await Promise.resolve();
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(40);
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(59);
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(attempts).toBe(2);
        } finally {
            await stopSessionUsingFakeTimers(session, pendingStart);
        }
    });

    it("does not add extra retry delay when an attempt fails after the delay window", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        let pendingStart: Promise<void> | undefined;
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                return new Promise<WebSocket>((_resolve, reject) => {
                    setTimeout(() => reject(new Error("slow failure")), 150);
                });
            },
            reconnectOptions: { delayMs: 100, maxDelayMs: 100, backoffFactor: 1 },
        });

        const trackStart = () => session.start().then(
            () => { throw new Error("start() unexpectedly resolved"); },
            () => { },
        );

        try {
            session.stop(new Error("pause auto-start"));
            pendingStart = trackStart();
            await Promise.resolve();
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(149);
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(attempts).toBe(2);
        } finally {
            await stopSessionUsingFakeTimers(session, pendingStart);
        }
    });

    it("uses Date-based elapsed time for retry delay when system time jumps", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        let pendingStart: Promise<void> | undefined;
        let attempts = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                attempts++;
                return new Promise<WebSocket>((_resolve, reject) => {
                    setTimeout(() => reject(new Error("quick failure")), 40);
                });
            },
            reconnectOptions: { delayMs: 100, maxDelayMs: 100, backoffFactor: 1 },
        });

        const trackStart = () => session.start().then(
            () => { throw new Error("start() unexpectedly resolved"); },
            () => { },
        );

        try {
            session.stop(new Error("pause auto-start"));
            pendingStart = trackStart();
            await Promise.resolve();
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(20);
            vi.setSystemTime(Date.now() + 60_000);

            await vi.advanceTimersByTimeAsync(20);
            expect(attempts).toBe(2);

            await vi.advanceTimersByTimeAsync(59);
            expect(attempts).toBe(2);

            await vi.advanceTimersByTimeAsync(1);
            expect(attempts).toBe(2);
        } finally {
            await stopSessionUsingFakeTimers(session, pendingStart);
        }
    });

    it("waits before reconnecting when a connection drops immediately after opening", async () => {
        firstConnectionForcedCloseDelayMs = 0;
        const closeEvents: ReconnectingWebSocketRpcCloseEvent[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            reconnectOptions: { delayMs: 500, maxDelayMs: 500 },
        });
        session.onClose(event => {
            closeEvents.push(event);
        });

        try {
            await waitFor(() => acceptedConnectionCount >= 1);
            await waitFor(() => closeEvents.length >= 1);
            expect(closeEvents[0].wasConnected).toBe(true);

            await new Promise<void>(resolve => setTimeout(resolve, 120));
            expect(acceptedConnectionCount).toBe(1);

            await waitFor(() => acceptedConnectionCount >= 2, 1500);
        } finally {
            session.stop();
        }
    });

    it("does not auto-reconnect after disconnect when reconnect=false", async () => {
        const closeEvents: ReconnectingWebSocketRpcCloseEvent[] = [];
        const openConnectionIds: number[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...noReconnectImmediateOptions,
        });
        session.onClose(event => {
            closeEvents.push(event);
        });
        session.onOpen(event => {
            openConnectionIds.push(event.connectionId);
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(3)).toBe(9);
            expect(openConnectionIds).toStrictEqual([1]);

            for (const socket of sockets) {
                socket.close(1012, "forced disconnect without reconnect");
            }

            await waitFor(() => closeEvents.length > 0);
            await new Promise<void>(resolve => setTimeout(resolve, 60));
            expect(openConnectionIds).toStrictEqual([1]);
            expect(closeEvents.some(event => !event.intentional && event.wasConnected)).toBe(true);
        } finally {
            session.stop();
        }
    });

    it("does not throttle manual reconnect after disconnect when reconnect=false", async () => {
        const closeEvents: ReconnectingWebSocketRpcCloseEvent[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            reconnectOptions: { enabled: false, delayMs: 1000, maxDelayMs: 1000 },
        });
        session.onClose(event => {
            closeEvents.push(event);
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(4)).toBe(16);
            expect(acceptedConnectionCount).toBe(1);

            for (const socket of sockets) {
                socket.close(1012, "forced disconnect for manual reconnect");
            }

            await waitFor(() => closeEvents.length >= 1);
            const reconnectStartedAtMs = Date.now();
            const restart = session.start();

            await waitFor(() => acceptedConnectionCount >= 2, 500);
            expect(Date.now() - reconnectStartedAtMs).toBeLessThan(500);

            const restartedRpc = await restart;
            expect(await restartedRpc.square(5)).toBe(25);
        } finally {
            session.stop();
        }
    });

    it("does not emit onClose for attempts that never reach open", async () => {
        let attempts = 0;
        const closeEvents: ReconnectingWebSocketRpcCloseEvent[] = [];
        const session = new ReconnectingWebSocketRpcSession({
            createWebSocket: () => {
                attempts++;
                return new NeverOpenWebSocket() as unknown as WebSocket;
            },
            reconnectOptions: { delayMs: 5, maxDelayMs: 5 },
        });
        session.onClose(event => {
            closeEvents.push(event);
        });

        try {
            await waitFor(() => attempts >= 3);
            session.stop();
            await new Promise<void>(resolve => setTimeout(resolve, 30));
            expect(closeEvents).toStrictEqual([]);
        } finally {
            session.stop();
        }
    });

    it("marks only the first open event as firstConnection", async () => {
        const flags: boolean[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.onOpen(event => {
            flags.push(event.firstConnection);
        });

        try {
            let rpc = await session.getRPC();
            expect(await rpc.square(13)).toBe(169);
            expect(flags[0]).toBe(true);

            for (const socket of sockets) {
                socket.close(1012, "force reconnect");
            }

            await waitFor(() => acceptedConnectionCount >= 2);
            await waitFor(() => flags.length >= 2);

            rpc = await session.getRPC();
            expect(await rpc.square(14)).toBe(196);
            expect(flags[1]).toBe(false);
        } finally {
            session.stop();
        }
    });

    it("retries if the connection closes during onOpen hooks", async () => {
        let openCalls = 0;
        const firstConnectionFlags: boolean[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.onOpen(async event => {
            firstConnectionFlags.push(event.firstConnection);
            openCalls++;
            if (openCalls === 1) {
                for (const socket of sockets) {
                    socket.close(1012, "closed during onOpen");
                }
                await new Promise<void>(resolve => setTimeout(resolve, 10));
            }
        });

        try {
            await session.getRPC();
            await waitFor(() => acceptedConnectionCount >= 2);

            const rpc = await session.getRPC();
            expect(await rpc.square(17)).toBe(289);
            expect(openCalls).toBeGreaterThanOrEqual(2);
            expect(firstConnectionFlags[0]).toBe(true);
            expect(firstConnectionFlags[1]).toBe(false);
        } finally {
            session.stop();
        }
    });

    it("can stop then start while initial connection attempt is still in-flight", async () => {
        let resolveFirstAttempt: ((socket: WebSocket) => void) | undefined;
        let createCalls = 0;
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                createCalls++;
                if (createCalls === 1) {
                    return new Promise<WebSocket>(resolve => {
                        resolveFirstAttempt = resolve;
                    });
                }
                return createTestWebSocket();
            },
            ...immediateReconnectOptions,
        });

        const firstAttempt = session.start();
        session.stop(new Error("manual stop while connecting"));
        const secondAttempt = session.start();

        if (!resolveFirstAttempt) {
            throw new Error("First connection attempt did not initialize.");
        }
        resolveFirstAttempt(createTestWebSocket());

        await expect(firstAttempt).rejects.toThrow("cancelled");
        const rpc = await secondAttempt;
        expect(await rpc.square(15)).toBe(225);
        expect(createCalls).toBe(2);
        session.stop();
    });

    it("deduplicates concurrent start() calls while connecting", async () => {
        let resolveFirstAttempt: ((socket: WebSocket) => void) | undefined;
        let createCalls = 0;
        const openConnectionIds: number[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => {
                createCalls++;
                if (createCalls === 1) {
                    return new Promise<WebSocket>(resolve => {
                        resolveFirstAttempt = resolve;
                    });
                }
                return createTestWebSocket();
                },
            ...immediateReconnectOptions,
        });
        session.onOpen(event => {
            openConnectionIds.push(event.connectionId);
        });

        session.stop(new Error("pause auto-start for start() dedupe test"));
        const start1 = session.start();
        const start2 = session.start();
        const start3 = session.start();

        if (!resolveFirstAttempt) throw new Error("Connection attempt was not created.");
        resolveFirstAttempt(createTestWebSocket());

        const [rpc1, rpc2, rpc3] = await Promise.all([start1, start2, start3]);
        expect(rpc1).toBe(rpc2);
        expect(rpc2).toBe(rpc3);
        expect(await rpc1.square(22)).toBe(484);
        expect(createCalls).toBe(1);
        expect(openConnectionIds).toStrictEqual([1]);
        session.stop();
    });

    it("does not reconnect when start() is called on an already connected session", async () => {
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        const openConnectionIds: number[] = [];
        session.onOpen(event => {
            openConnectionIds.push(event.connectionId);
        });

        try {
            const rpc1 = await session.start();
            const [rpc2, rpc3] = await Promise.all([session.start(), session.start()]);
            expect(rpc1).toBe(rpc2);
            expect(rpc2).toBe(rpc3);
            expect(await rpc1.square(23)).toBe(529);
            expect(openConnectionIds).toStrictEqual([1]);
        } finally {
            session.stop();
        }
    });

    it("stop() is idempotent and emits intentional close once", async () => {
        const closeEvents: ReconnectingWebSocketRpcCloseEvent[] = [];
        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
        });
        session.onClose(event => {
            closeEvents.push(event);
        });

        const rpc = await session.getRPC();
        expect(await rpc.square(16)).toBe(256);

        session.stop(new Error("first stop"));
        session.stop(new Error("second stop"));

        await waitFor(() => closeEvents.length > 0);
        await new Promise<void>(resolve => setTimeout(resolve, 40));

        expect(closeEvents.length).toBe(1);
        expect(closeEvents[0].intentional).toBe(true);
    });

    it("does not return a dead RPC when first connection drops during init", async () => {
        firstConnectionForcedCloseDelayMs = 1;
        const openIds: number[] = [];
        const closeIds: number[] = [];

        const session = new ReconnectingWebSocketRpcSession<TestRpcApi>({
            createWebSocket: () => createTestWebSocket(),
            ...fastReconnectOptions,
            onFirstOpen: async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 20));
            },
        });
        session.onOpen(event => {
            openIds.push(event.connectionId);
        });
        session.onClose(event => {
            closeIds.push(event.connectionId);
        });

        try {
            const rpc = await session.getRPC();
            expect(await rpc.square(9)).toBe(81);
            expect(acceptedConnectionCount).toBeGreaterThanOrEqual(2);
            expect(openIds.length).toBe(1);
            expect(closeIds).toStrictEqual([]);

            session.stop();
            await waitFor(() => closeIds.length === 1);
            expect(closeIds[0]).toBe(openIds[0]);
        } finally {
            session.stop();
        }
    });
});
