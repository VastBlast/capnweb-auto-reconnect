# capnweb-auto-reconnect

Small reconnecting WebSocket RPC session support for [`capnweb`](https://github.com/cloudflare/capnweb).

I built this for my personal projects and decided to publish it in case anyone else needs it.

- npm: https://www.npmjs.com/package/capnweb-auto-reconnect
- capnweb: https://github.com/cloudflare/capnweb

## Install

```bash
npm i capnweb-auto-reconnect
```

## Quick start

```ts
import { ReconnectingWebSocketRpcSession } from "capnweb-auto-reconnect";

type MyApi = {
  square(i: number): Promise<number>;
};

const session = new ReconnectingWebSocketRpcSession<MyApi>({
    // `createWebSocket` must return a new socket each attempt.
    createWebSocket: () => new WebSocket("wss://example.com/rpc"),
});

const rpc = await session.getRPC();
console.log(await rpc.square(12)); // 144

// with this pattern, it will use the same connection if still open, or reconnect if it got disconnected:
console.log(await (await session.getRPC()).square(12)); // 144
```

## What it does

- Keeps a capnweb RPC session connected over WebSocket.
- Automatically reconnects after disconnects (configurable delay, max delay, and backoff factor).
- Emits connection lifecycle hooks with connection IDs (`onOpen`/`onClose`).
- Runs optional one-time startup logic with `onFirstOpen` before the first open event.
- Deduplicates concurrent `start()`/`getRPC()` calls while connecting.
- Lets you pause/resume reconnecting with `stop()` and `start()`.

## Example: lifecycle hooks

```ts
const session = new ReconnectingWebSocketRpcSession({
    createWebSocket: () => new WebSocket("wss://example.com/rpc"),
    reconnectOptions: { delayMs: 250, maxDelayMs: 5000, backoffFactor: 2 },
    onFirstOpen: async rpc => {
        // Runs once after first successful open (every time it reconnects)
        await rpc.someWarmupFunction();
    },
});

const offOpen = session.onOpen(({ connectionId, firstConnection }) => {
    console.log("open", connectionId, { firstConnection });
});

const offClose = session.onClose(({ connectionId, intentional, error }) => {
    console.log("close", connectionId, { intentional, error });
});

// Later, when done:
offOpen();
offClose();
session.stop("app shutdown");
```

## Example: Node + `ws`

```ts
import { WebSocket } from "ws";
import { ReconnectingWebSocketRpcSession } from "capnweb-auto-reconnect";

const session = new ReconnectingWebSocketRpcSession({
    createWebSocket: () => new WebSocket("ws://127.0.0.1:8787"),
});

const rpc = await session.start();
await rpc.ping?.();
```

## API notes

- `getRPC()` returns a live stub, connecting/reconnecting as needed.
- `start()` resumes connection attempts if you previously called `stop()`.
- `stop(reason?)` closes the current connection and pauses reconnecting.
