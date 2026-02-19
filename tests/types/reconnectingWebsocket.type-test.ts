import { RpcStub, RpcTarget } from "capnweb";
import { ReconnectingWebSocketRpcSession } from "../../src/index.js";

type Equal<A, B> = (
    (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2) ? true : false
);
type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? false : true;

class BasicArithmetic extends RpcTarget {
    add(x: number, y: number): number {
        return x + y;
    }

    async subtract(x: number, y: number): Promise<number> {
        return x - y;
    }
}

class RpcServer extends RpcTarget {
    basicArithmetic() {
        return new BasicArithmetic();
    }

    async square(x: number): Promise<number> {
        return x * x;
    }
}

const createWebSocket = () => null as unknown as WebSocket;

const session = new ReconnectingWebSocketRpcSession<RpcServer>({
    createWebSocket,
    onFirstOpen: (rpc) => {
        const _: RpcStub<RpcServer> = rpc;
        void _;
    },
});

const getRpcResult = session.getRPC();
const _: RpcStub<RpcServer> & Promise<RpcStub<RpcServer>> = getRpcResult;
void _;

const basicArithmetic = session.getRPC().basicArithmetic();
type _basicArithmeticNotAny = Expect<NotAny<typeof basicArithmetic>>;
type _basicArithmeticAwaited = Expect<Equal<Awaited<typeof basicArithmetic>, RpcStub<BasicArithmetic>>>;

const addResult = session.getRPC().basicArithmetic().add(5, 7);
const subtractResult = session.getRPC().basicArithmetic().subtract(10, 3);
const squareResult = session.getRPC().square(9);

type _addNotAny = Expect<NotAny<typeof addResult>>;
type _subtractNotAny = Expect<NotAny<typeof subtractResult>>;
type _squareNotAny = Expect<NotAny<typeof squareResult>>;
type _addAwaitedType = Expect<Equal<Awaited<typeof addResult>, number>>;
type _subtractAwaitedType = Expect<Equal<Awaited<typeof subtractResult>, number>>;
type _squareAwaitedType = Expect<Equal<Awaited<typeof squareResult>, number>>;

const started = session.start();
type _startReturnType = Expect<Equal<Awaited<typeof started>, RpcStub<RpcServer>>>;

session.onOpen((event) => {
    const rpc: RpcStub<RpcServer> = event.rpc;
    void rpc;
});

// @ts-expect-error - unknown method is not callable.
session.getRPC().basicArithmetic().multiply(2, 3);

// @ts-expect-error - argument types must match.
void session.getRPC().basicArithmetic().add("5", 7);
