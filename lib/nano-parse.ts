// Nano(Prompt API)の応答テキストから CSS セレクタ配列を頑健に取り出す純関数群。
// responseConstraint(構造化出力)を使っても、フェンスや散文混入に備えた安全網として機能する。
//
// 設計上の契約:
//  - パースできない/該当なしのときは空配列を返す（例外を握りつぶすのではなく「検知0件」を表す）。
//  - 呼び出し側は「空配列 = 自動検知の追加対象なし」として扱える。

const MAX_SELECTORS = 50;
const MAX_SELECTOR_LEN = 200;

export interface SelectorResponse {
  selectors: string[];
}

// スナップショット注釈(` role=` ` type=` ` name=` ` aria="` ` data=[` ` text="`)の手前で切る。
// いずれも「空白 + key=」形なので、子孫結合子(`#a .b`)や属性セレクタ(`input[type="text"]`)は壊さない。
const ANNOTATION_RE = /\s+(?:role|type|name|aria|data|text)=/;

// 素の汎用タグ/構造セレクタは画面の広範囲を覆い過剰マスクになるので除外する。
const BROAD_RE =
  /^(?:\*|:root|html|head|body|main|header|footer|nav|section|article|aside|div|span|p|a|ul|ol|li|table|thead|tbody|tr|td|th|form|label|button|input)$/i;

// SPA のアプリ全体コンテナ id。これらは大抵ページ全体を覆うので除外する
// （実行時の面積ゲートでも弾くが、popup の一覧にも出さないよう parse でも落とす）。
const BROAD_ID_RE = /^#(?:root|app|__next|__nuxt|gatsby-focus-wrapper|svelte)$/i;

function cleanSelector(s: string): string {
  const m = s.match(ANNOTATION_RE);
  return (m ? s.slice(0, m.index) : s).trim();
}

// ```json ... ``` や ``` ... ``` のコードフェンスを剥がす。
function stripCodeFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence?.[1] ?? text;
}

// 文字列から最初の JSON 値([...] か {...})を取り出して parse を試みる。
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 前後に散文がある場合、最初の配列/オブジェクトらしき範囲を抜き出す
    const start = trimmed.search(/[[{]/);
    if (start < 0) return undefined;
    const open = trimmed[start];
    const close = open === "[" ? "]" : "}";
    const end = trimmed.lastIndexOf(close);
    if (end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

// parse 済みの値から selectors 配列の候補を取り出す。
function extractSelectorArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { selectors?: unknown }).selectors)
  ) {
    return (parsed as { selectors: unknown[] }).selectors;
  }
  return [];
}

// 非文字列・空・長すぎ・広すぎを除去し、注釈を刈り取り、トリム・重複排除・件数上限を課す。
function sanitizeSelectors(candidates: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const sel = cleanSelector(c.trim());
    if (!sel || sel.length > MAX_SELECTOR_LEN) continue;
    if (BROAD_RE.test(sel) || BROAD_ID_RE.test(sel)) continue; // 過剰マスクになるので除外
    if (seen.has(sel)) continue;
    seen.add(sel);
    out.push(sel);
    if (out.length >= MAX_SELECTORS) break;
  }
  return out;
}

// 応答テキスト -> 正規化済みセレクタ配列。失敗時は空配列。
export function parseSelectorResponse(raw: string): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const parsed = tryParseJson(stripCodeFences(raw));
  if (parsed === undefined) return [];
  return sanitizeSelectors(extractSelectorArray(parsed));
}
