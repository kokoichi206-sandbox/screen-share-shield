import { describe, it, expect } from "vitest";
import {
  buildSnapshot,
  cssHint,
  formatElementLine,
  type ElementMeta,
} from "@/lib/dom-snapshot";

describe("cssHint", () => {
  it("id があれば #id", () => {
    expect(cssHint({ tag: "div", id: "balance" })).toBe("#balance");
  });

  it("id が無ければ tag + 先頭3クラス", () => {
    expect(
      cssHint({ tag: "span", classes: ["a", "b", "c", "d"] }),
    ).toBe("span.a.b.c");
  });

  it("クラスも無ければ tag のみ", () => {
    expect(cssHint({ tag: "td" })).toBe("td");
  });
});

describe("formatElementLine", () => {
  it("属性とテキストを1行に整形", () => {
    const m: ElementMeta = {
      tag: "input",
      id: "email",
      inputType: "email",
      ariaLabel: "メールアドレス",
      text: "",
    };
    const line = formatElementLine(m);
    expect(line).toContain("#email");
    expect(line).toContain("type=email");
    expect(line).toContain('aria="メールアドレス"');
  });

  it("長いテキストは切り詰めて … を付ける", () => {
    const long = "x".repeat(200);
    const line = formatElementLine({ tag: "p", text: long });
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(120);
  });

  it("空白を畳む", () => {
    const line = formatElementLine({ tag: "p", text: "  a\n\n  b  " });
    expect(line).toContain('text="a b"');
  });
});

describe("buildSnapshot", () => {
  it("1要素1行で連結", () => {
    const snap = buildSnapshot(
      [{ tag: "div", id: "a" }, { tag: "div", id: "b" }],
      1000,
    );
    expect(snap).toBe("#a\n#b");
  });

  it("maxChars を超えたら以降を切り捨てる", () => {
    const metas: ElementMeta[] = Array.from({ length: 100 }, (_, i) => ({
      tag: "div",
      id: `id${i}`,
    }));
    const snap = buildSnapshot(metas, 20);
    expect(snap.length).toBeLessThanOrEqual(20);
    expect(snap.startsWith("#id0")).toBe(true);
  });
});
