import { ReconnectingWebSocketRpcSession } from "../src/index.js";
import { TestTarget } from "./testUtil.js";

const session = new ReconnectingWebSocketRpcSession<TestTarget>({
    createWebSocket: (() => {
        throw new Error("typecheck only");
    }) as () => WebSocket,
    reconnectOptions: { enabled: false },
});

const rpcAsPromise: Promise<unknown> = session.getRPC();
void rpcAsPromise;

session.stop();
