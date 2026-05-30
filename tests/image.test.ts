import { describe, it, expect } from "vitest";
import { computeDownscaleSize } from "@/lib/image";

describe("computeDownscaleSize", () => {
  it("maxEdge 以下ならそのまま(整数化)", () => {
    expect(computeDownscaleSize(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });

  it("横長は長辺(幅)を maxEdge に合わせ比率維持", () => {
    expect(computeDownscaleSize(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
  });

  it("縦長は長辺(高さ)を maxEdge に合わせ比率維持", () => {
    expect(computeDownscaleSize(1000, 2000, 1000)).toEqual({ width: 500, height: 1000 });
  });

  it("0 や負のサイズは 0x0", () => {
    expect(computeDownscaleSize(0, 600, 1024)).toEqual({ width: 0, height: 0 });
    expect(computeDownscaleSize(800, -1, 1024)).toEqual({ width: 0, height: 0 });
  });

  it("極端な縮小でも最小 1px を割らない", () => {
    const s = computeDownscaleSize(10000, 1, 100);
    expect(s.width).toBe(100);
    expect(s.height).toBe(1);
  });
});
