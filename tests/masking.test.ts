import { describe, it, expect } from "vitest";
import {
  clampRectToCanvas,
  fromNormalizedRect,
  isRectInViewport,
  isRectTooBroad,
  scaleViewportRect,
  toNormalizedRect,
  type ViewportRect,
} from "@/lib/masking";

function vr(
  left: number,
  top: number,
  width: number,
  height: number,
): ViewportRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe("isRectTooBroad", () => {
  const VW = 1000;
  const VH = 800;

  it("ビューポート全体を覆う要素(#root 相当)は too broad", () => {
    expect(isRectTooBroad(vr(0, 0, 1000, 800), VW, VH)).toBe(true);
  });

  it("ビューポートを超える要素も可視面積で判定して too broad", () => {
    expect(isRectTooBroad(vr(-50, -50, 1200, 1000), VW, VH)).toBe(true);
  });

  it("小さな機密フィールドは too broad ではない", () => {
    expect(isRectTooBroad(vr(100, 100, 200, 40), VW, VH)).toBe(false);
  });

  it("片側カラムのフォーム(45%×70%)は too broad ではない", () => {
    expect(isRectTooBroad(vr(500, 50, 450, 560), VW, VH)).toBe(false);
  });

  it("閾値ちょうど(80%面積)は too broad", () => {
    // 800x800 = 640000 = 0.8 * 1000*800
    expect(isRectTooBroad(vr(0, 0, 800, 800), VW, VH)).toBe(true);
  });

  it("ビューポート 0 は false", () => {
    expect(isRectTooBroad(vr(0, 0, 100, 100), 0, VH)).toBe(false);
  });
});

describe("isRectInViewport", () => {
  const VW = 1000;
  const VH = 800;

  it("ビューポート内に完全に収まる要素は対象", () => {
    expect(isRectInViewport(vr(100, 100, 200, 50), VW, VH)).toBe(true);
  });

  it("一部だけ見えている(上にはみ出し)要素も対象", () => {
    expect(isRectInViewport(vr(100, -20, 200, 50), VW, VH)).toBe(true);
  });

  it("完全に上に隠れた要素は対象外", () => {
    expect(isRectInViewport(vr(100, -80, 200, 50), VW, VH)).toBe(false);
  });

  it("完全に下に隠れた要素は対象外", () => {
    expect(isRectInViewport(vr(100, 820, 200, 50), VW, VH)).toBe(false);
  });

  it("完全に右に隠れた要素は対象外", () => {
    expect(isRectInViewport(vr(1010, 100, 50, 50), VW, VH)).toBe(false);
  });

  it("面積0(width=0)は対象外", () => {
    expect(isRectInViewport(vr(100, 100, 0, 50), VW, VH)).toBe(false);
  });
});

describe("scaleViewportRect", () => {
  it("scale=1 はそのまま", () => {
    expect(scaleViewportRect(vr(10, 20, 30, 40), 1, 1)).toEqual({
      x: 10,
      y: 20,
      w: 30,
      h: 40,
    });
  });

  it("DPR=2 相当(scale=2)で2倍にスケール", () => {
    expect(scaleViewportRect(vr(10, 20, 30, 40), 2, 2)).toEqual({
      x: 20,
      y: 40,
      w: 60,
      h: 80,
    });
  });

  it("X/Y で異なるスケールを独立に適用", () => {
    expect(scaleViewportRect(vr(10, 10, 10, 10), 1.5, 3)).toEqual({
      x: 15,
      y: 30,
      w: 15,
      h: 30,
    });
  });
});

describe("clampRectToCanvas", () => {
  const CW = 1000;
  const CH = 800;

  it("canvas 内の矩形はそのまま(整数化のみ)", () => {
    expect(clampRectToCanvas({ x: 10.2, y: 20.8, w: 30.1, h: 40.9 }, CW, CH)).toEqual(
      { x: 10, y: 20, w: 31, h: 41 },
    );
  });

  it("負の座標は0にクランプ", () => {
    const r = clampRectToCanvas({ x: -50, y: -30, w: 200, h: 100 }, CW, CH);
    expect(r).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it("canvas 右下にはみ出す幅/高さを切り詰める", () => {
    const r = clampRectToCanvas({ x: 900, y: 700, w: 300, h: 300 }, CW, CH);
    expect(r).toEqual({ x: 900, y: 700, w: 100, h: 100 });
  });

  it("canvas 完全に外(右下)は null", () => {
    expect(clampRectToCanvas({ x: 1000, y: 800, w: 50, h: 50 }, CW, CH)).toBeNull();
  });

  it("面積0以下は null", () => {
    expect(clampRectToCanvas({ x: 10, y: 10, w: 0, h: 50 }, CW, CH)).toBeNull();
  });
});

describe("toNormalizedRect / fromNormalizedRect (クロスタブ)", () => {
  it("ビューポート内の rect を 0..1 に正規化", () => {
    expect(toNormalizedRect(vr(100, 50, 200, 100), 1000, 500)).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2,
    });
  });

  it("ビューポート外へのはみ出しはクランプして正規化", () => {
    // left=-100 は 0 に、幅は可視分(=100..1000は超えないが left clamp で 300->...)
    const n = toNormalizedRect(vr(-100, 0, 300, 100), 1000, 500);
    expect(n).toEqual({ x: 0, y: 0, w: 0.2, h: 0.2 });
  });

  it("完全に画面外は null", () => {
    expect(toNormalizedRect(vr(-200, 0, 100, 100), 1000, 500)).toBeNull();
  });

  it("ビューポート 0 は null", () => {
    expect(toNormalizedRect(vr(0, 0, 10, 10), 0, 500)).toBeNull();
  });

  it("正規化 -> canvas ピクセル", () => {
    expect(fromNormalizedRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 1000, 500)).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 200,
    });
  });

  it("round-trip: 正規化して別解像度の canvas に戻すと比が保たれる", () => {
    // 共有される側(1000x500) -> 正規化 -> 共有元のフレーム(2000x1000=DPR2相当)
    const n = toNormalizedRect(vr(100, 50, 200, 100), 1000, 500);
    expect(n).not.toBeNull();
    expect(fromNormalizedRect(n!, 2000, 1000)).toEqual({
      x: 200,
      y: 100,
      w: 400,
      h: 200,
    });
  });
});
