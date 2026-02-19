import { describe, expect, it } from "vitest";
import { closeEventToError, toError } from "../../src/helpers.js";

describe("helpers", () => {
    it("formats close event errors with a reason", () => {
        const error = closeEventToError({ code: 1012, reason: "server restart" } as CloseEvent);
        expect(error.message).toBe("WebSocket closed: 1012 server restart");
    });

    it("formats close event errors without a reason", () => {
        const error = closeEventToError({ code: 1000, reason: "" } as CloseEvent);
        expect(error.message).toBe("WebSocket closed: 1000");
    });

    it("returns existing Error objects from toError", () => {
        const original = new Error("already normalized");
        expect(toError(original, "fallback")).toBe(original);
    });

    it("normalizes string and fallback stop reasons", () => {
        expect(toError("manual stop", "fallback").message).toBe("manual stop");
        expect(toError("", "fallback").message).toBe("fallback");
        expect(toError({ reason: "object" }, "fallback").message).toBe("fallback");
    });
});
