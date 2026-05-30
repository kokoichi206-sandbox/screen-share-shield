import { describe, it, expect } from "vitest";
import {
  CHANNEL,
  isRuntimeMessage,
  isToContentMessage,
  isToPageMessage,
} from "@/lib/messages";

describe("isToPageMessage", () => {
  it("正しい to-page エンベロープを受理", () => {
    expect(
      isToPageMessage({
        channel: CHANNEL,
        dir: "to-page",
        cmd: { type: "toggle-enabled" },
      }),
    ).toBe(true);
  });

  it("dir 違いは拒否", () => {
    expect(
      isToPageMessage({ channel: CHANNEL, dir: "to-content", evt: { type: "ready" } }),
    ).toBe(false);
  });

  it("channel 違いは拒否", () => {
    expect(isToPageMessage({ channel: "other", dir: "to-page" })).toBe(false);
  });

  it("非オブジェクト/null は拒否", () => {
    expect(isToPageMessage(null)).toBe(false);
    expect(isToPageMessage("x")).toBe(false);
    expect(isToPageMessage(undefined)).toBe(false);
  });
});

describe("isToContentMessage", () => {
  it("正しい to-content エンベロープを受理", () => {
    expect(
      isToContentMessage({
        channel: CHANNEL,
        dir: "to-content",
        evt: { type: "ready" },
      }),
    ).toBe(true);
  });

  it("to-page は拒否", () => {
    expect(
      isToContentMessage({ channel: CHANNEL, dir: "to-page", cmd: { type: "get-status" } }),
    ).toBe(false);
  });
});

describe("isRuntimeMessage", () => {
  it("channel が一致すれば受理", () => {
    expect(isRuntimeMessage({ channel: CHANNEL, kind: "query-status" })).toBe(true);
    expect(
      isRuntimeMessage({ channel: CHANNEL, kind: "command", cmd: { type: "toggle-enabled" } }),
    ).toBe(true);
  });

  it("channel 不一致/非オブジェクトは拒否", () => {
    expect(isRuntimeMessage({ channel: "nope", kind: "query-status" })).toBe(false);
    expect(isRuntimeMessage(42)).toBe(false);
  });
});
