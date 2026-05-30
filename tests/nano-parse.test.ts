import { describe, it, expect } from "vitest";
import { parseSelectorResponse } from "@/lib/nano-parse";

describe("parseSelectorResponse", () => {
  it("素の {selectors:[...]} JSON を解釈", () => {
    expect(
      parseSelectorResponse('{"selectors":[".balance","#email"]}'),
    ).toEqual([".balance", "#email"]);
  });

  it("配列直の JSON も解釈", () => {
    expect(parseSelectorResponse('[".a", ".b"]')).toEqual([".a", ".b"]);
  });

  it("```json フェンス付きを解釈", () => {
    const raw = "```json\n{\"selectors\":[\".secret\"]}\n```";
    expect(parseSelectorResponse(raw)).toEqual([".secret"]);
  });

  it("前後に散文があっても JSON 部分を抽出", () => {
    const raw =
      'はい、以下が対象です:\n{"selectors":["#card-number"]}\nご確認ください。';
    expect(parseSelectorResponse(raw)).toEqual(["#card-number"]);
  });

  it("非文字列要素を除去", () => {
    expect(
      parseSelectorResponse('{"selectors":[".a", 123, null, ".b"]}'),
    ).toEqual([".a", ".b"]);
  });

  it("空白のみ要素を除去しトリム", () => {
    expect(
      parseSelectorResponse('{"selectors":["  .a  ", "   ", ".b"]}'),
    ).toEqual([".a", ".b"]);
  });

  it("重複を排除", () => {
    expect(
      parseSelectorResponse('{"selectors":[".a", ".a", ".b"]}'),
    ).toEqual([".a", ".b"]);
  });

  it("壊れた JSON は空配列", () => {
    expect(parseSelectorResponse("{selectors: [.a,]")).toEqual([]);
  });

  it("空文字/空白入力は空配列", () => {
    expect(parseSelectorResponse("")).toEqual([]);
    expect(parseSelectorResponse("   ")).toEqual([]);
  });

  it("selectors を持たないオブジェクトは空配列", () => {
    expect(parseSelectorResponse('{"foo":"bar"}')).toEqual([]);
  });

  it("件数上限(50)を超えない", () => {
    const many = Array.from({ length: 80 }, (_, i) => `.c${i}`);
    const res = parseSelectorResponse(JSON.stringify({ selectors: many }));
    expect(res.length).toBe(50);
    expect(res[0]).toBe(".c0");
  });

  it("長すぎるセレクタ(>200文字)を除去", () => {
    const long = ".".concat("x".repeat(250));
    expect(
      parseSelectorResponse(JSON.stringify({ selectors: [long, ".ok"] })),
    ).toEqual([".ok"]);
  });

  it("スナップショット注釈(text=)を刈り取って有効CSSにする", () => {
    expect(
      parseSelectorResponse(
        '{"selectors":["div.ReadOnlyFormField-title text=\\"a@b.com\\""]}',
      ),
    ).toEqual(["div.ReadOnlyFormField-title"]);
  });

  it("role= / data= 注釈も刈り取る", () => {
    expect(
      parseSelectorResponse(
        '{"selectors":["#cardNumber role=textbox", "span.x data=[data-foo] text=\\"y\\""]}',
      ),
    ).toEqual(["#cardNumber", "span.x"]);
  });

  it("子孫結合子(空白)は壊さない", () => {
    expect(parseSelectorResponse('{"selectors":["#form .secret"]}')).toEqual([
      "#form .secret",
    ]);
  });

  it("属性セレクタは壊さない", () => {
    expect(
      parseSelectorResponse('{"selectors":["input[type=\\"text\\"]"]}'),
    ).toEqual(['input[type="text"]']);
  });

  it("素の汎用タグ/構造セレクタは過剰マスク防止で除外", () => {
    expect(
      parseSelectorResponse(
        '{"selectors":["div","span","*","body","main","#ok",".keep"]}',
      ),
    ).toEqual(["#ok", ".keep"]);
  });

  it("注釈刈り取り後に素タグだけになる場合も除外", () => {
    expect(
      parseSelectorResponse('{"selectors":["div text=\\"x\\""]}'),
    ).toEqual([]);
  });
});
