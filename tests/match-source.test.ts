import { describe, it, expect } from "vitest";
import { pickSourceTab, type SourceEntry } from "@/lib/match-source";

function e(
  tabId: number,
  armed: boolean,
  aspect: number | null,
  ts: number,
): SourceEntry {
  return { tabId, armed, aspect, ts };
}

describe("pickSourceTab", () => {
  it("候補なしは null", () => {
    expect(pickSourceTab([], 1, 1.6)).toBeNull();
  });

  it("armed でないタブは候補外", () => {
    expect(pickSourceTab([e(2, false, 1.6, 1)], 1, 1.6)).toBeNull();
  });

  it("armed なら rect が一時的に空でも候補（スクロール対策）", () => {
    expect(pickSourceTab([e(2, true, 1.6, 1)], 1, 1.6)).toBe(2);
  });

  it("capturer 自身は候補外", () => {
    expect(pickSourceTab([e(1, true, 1.6, 1)], 1, 1.6)).toBeNull();
  });

  it("armed 候補が1つなら確定", () => {
    expect(pickSourceTab([e(2, true, 1.6, 1)], 1, 1.6)).toBe(2);
  });

  it("複数候補はアスペクト比が最も近いものを選ぶ", () => {
    const cands = [e(2, true, 1.0, 1), e(3, true, 1.6, 1), e(4, true, 2.2, 1)];
    expect(pickSourceTab(cands, 1, 1.55)).toBe(3);
  });

  it("アスペクト同点は最新(ts 大)を優先", () => {
    const cands = [e(2, true, 1.6, 5), e(3, true, 1.6, 9)];
    expect(pickSourceTab(cands, 1, 1.6)).toBe(3);
  });

  it("captureAspect が null なら最新を優先", () => {
    const cands = [e(2, true, 1.6, 2), e(3, true, 1.0, 7)];
    expect(pickSourceTab(cands, 1, null)).toBe(3);
  });
});
