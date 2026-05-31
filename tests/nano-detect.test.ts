import { describe, it, expect } from "vitest";
import {
  SELECTOR_SCHEMA,
  buildMultimodalPrompt,
  buildTextPrompt,
  getAvailability,
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

describe("buildMultimodalPrompt", () => {
  it("スナップショットを本文に埋め込む", () => {
    const snap = "#card-number text=\"4242\"";
    const prompt = buildMultimodalPrompt(snap);
    expect(prompt).toContain(snap);
    expect(prompt).toContain("selectors");
  });

  it("画像を視覚的文脈として使う指示を含む", () => {
    expect(buildMultimodalPrompt("x")).toContain("画像");
  });

  it("一覧に実在するセレクタのみ返す grounding 指示を含む", () => {
    // ピクセルからのセレクタ当てずっぽうを禁じる中核ルール。
    expect(buildMultimodalPrompt("x")).toContain("実在する");
  });
});

describe("runDetection (LanguageModel 不在=node)", () => {
  it("画像なし要求でも不在を握りつぶさず明示する", async () => {
    const r = await runDetection({ snapshot: "#x", dataUrl: null });
    expect(r.selectors).toEqual([]);
    expect(r.ran).toBe(false);
    expect(r.availability).toBe("unavailable");
    expect(r.error).toBe("Gemini Nano が利用できません");
    expect(r.image.used).toBe(false);
    expect(r.image.reason).toBeTruthy();
  });

  it("画像あり要求でも不在なら明示エラー(空で握りつぶさない)", async () => {
    const r = await runDetection({
      snapshot: "#x",
      dataUrl: "data:image/jpeg;base64,/9j/",
    });
    expect(r.selectors).toEqual([]);
    expect(r.ran).toBe(false);
    expect(r.availability).toBe("unavailable");
    expect(r.image.used).toBe(false);
    expect(r.error).toBeTruthy();
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
