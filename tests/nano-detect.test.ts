import { describe, it, expect } from "vitest";
import {
  SELECTOR_SCHEMA,
  buildTextPrompt,
  getAvailability,
  mergeSelectors,
  runDetection,
  startDownload,
} from "@/lib/nano-detect";

// Node には LanguageModel グローバルが無いので hasApi()=false の経路を検証できる。
// 目的: 利用不可を「空配列で握りつぶさず明示する」契約(エラー方針)の回帰防止。

describe("SELECTOR_SCHEMA", () => {
  it("{selectors:string[]} を強制する JSON Schema", () => {
    expect(SELECTOR_SCHEMA.type).toBe("object");
    expect(SELECTOR_SCHEMA.required).toContain("selectors");
    expect(SELECTOR_SCHEMA.properties.selectors.type).toBe("array");
    expect(SELECTOR_SCHEMA.properties.selectors.maxItems).toBe(50);
    expect(SELECTOR_SCHEMA.properties.selectors.items.maxLength).toBe(200);
    expect(SELECTOR_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("buildTextPrompt", () => {
  it("スナップショットを本文に埋め込む", () => {
    const snap = "#balance text=\"¥1,234\"";
    const prompt = buildTextPrompt(snap);
    expect(prompt).toContain(snap);
    expect(prompt).toContain("selectors");
  });

  it("広すぎるセレクタ禁止の指示を含む", () => {
    expect(buildTextPrompt("x")).toContain("広すぎる");
  });
});

describe("mergeSelectors", () => {
  it("2配列を結合し重複を除去(順序維持)", () => {
    expect(mergeSelectors([".a", ".b"], [".b", ".c"])).toEqual([".a", ".b", ".c"]);
  });

  it("空同士は空", () => {
    expect(mergeSelectors([], [])).toEqual([]);
  });
});

describe("runDetection (LanguageModel 不在=node)", () => {
  it("dataUrl 無しは画像段階を skipped と明示し、不在を握りつぶさない", async () => {
    const r = await runDetection({ snapshot: "#x", dataUrl: null });
    expect(r.selectors).toEqual([]);
    expect(r.text.ran).toBe(false);
    expect(r.text.availability).toBe("unavailable");
    expect(r.text.error).toBeTruthy();
    expect(r.image.ran).toBe(false);
    expect(r.image.availability).toBe("skipped"); // unavailable とは区別する
    expect(r.error).toBe("Gemini Nano が利用できません");
  });

  it("dataUrl 有りでも不在なら両段階が明示エラー(空で握りつぶさない)", async () => {
    const r = await runDetection({
      snapshot: "#x",
      dataUrl: "data:image/jpeg;base64,/9j/",
    });
    expect(r.text.availability).toBe("unavailable");
    expect(r.image.availability).toBe("unavailable"); // runImageStage を通る
    expect(r.image.error).toBeTruthy();
    expect(r.selectors).toEqual([]);
  });
});

describe("getAvailability / startDownload (LanguageModel 不在=node)", () => {
  it("getAvailability は両方 unavailable", async () => {
    expect(await getAvailability()).toEqual({
      text: "unavailable",
      image: "unavailable",
    });
  });

  it("startDownload は unavailable とエラーを明示", async () => {
    const r = await startDownload();
    expect(r.availability).toBe("unavailable");
    expect(r.error).toBeTruthy();
  });
});
