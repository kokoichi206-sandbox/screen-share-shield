// Gemini Nano(Prompt API)による機密要素の自動検知。background service worker で動かす。
// LanguageModel への参照は全て関数内に閉じ込め、純粋部分(schema/prompt/merge)だけを
// 副作用なく export してテスト可能にする。
//
// 契約: 検知できない/利用不可は「エラーを握りつぶして空を返す」のではなく、
//       StageReport に availability と error を明示して返す（暗黙 fallback 禁止）。

import type {
  NanoReport,
  NanoState,
  StageAvailability,
  StageReport,
} from "@/lib/messages";
import { parseSelectorResponse } from "@/lib/nano-parse";

// --- 純粋: 構造化出力スキーマ / プロンプト / マージ ---

export const SELECTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selectors"],
  properties: {
    selectors: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
} as const;

export const SYSTEM_PROMPT =
  "あなたは画面共有時のプライバシー保護アシスタントです。与えられた情報から、" +
  "画面共有で他人に見せるべきでない機密情報（メールアドレス、電話番号、住所、氏名、" +
  "口座/カード番号、残高/金額、APIキー、パスワード、個人ID 等）を含む要素を特定し、" +
  "それらをマスクするための CSS セレクタを返します。確実に機密と判断できるものだけを返し、" +
  "body/main/html のような広すぎるセレクタは絶対に返さないこと。";

export function buildTextPrompt(snapshot: string): string {
  return `次は共有中ページの要素一覧です。各行は「CSSヒント␣属性␣テキスト断片」の形式で、
先頭の CSSヒント部分（例: #id や tag.class）だけが CSS セレクタです。

機密情報を含む要素だけを選び、その要素を指す CSS セレクタを JSON で返してください。
重要なルール:
- 返すのは各行の先頭の CSS セレクタ部分のみ。role=, type=, name=, aria=, data=, text= などの
  注釈は絶対に含めない（例: "div.title text=\\"a@b.com\\"" ではなく "div.title" を返す）。
- body/main/div/span のような広すぎる素のセレクタは返さない。
- 確実に機密と判断できるものだけ。最大50件。

形式: {"selectors": ["#id", "tag.class", ...]}

要素一覧:
${snapshot}`;
}

export const IMAGE_PROMPT_TEXT =
  "これは画面共有のスクリーンショットです。他人に見せるべきでない機密情報" +
  "（金額/残高、口座/カード番号、メール、氏名、住所、ID/パスワード等）が写っている領域を探し、" +
  "各領域に最も近い CSS セレクタを推定して JSON で返してください。" +
  '形式: {"selectors": [...]}。確実なものだけ。';

export function mergeSelectors(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...a, ...b]) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// --- 副作用あり: LanguageModel 呼び出し（background でのみ実行） ---

const TEXT_OPTS: LanguageModelCreateOptions = {
  expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
  expectedOutputs: [{ type: "text", languages: ["ja", "en"] }],
  initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
};

const IMAGE_OPTS: LanguageModelCreateOptions = {
  expectedInputs: [
    { type: "text", languages: ["ja", "en"] },
    { type: "image" },
  ],
  expectedOutputs: [{ type: "text", languages: ["ja", "en"] }],
  initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
};

// 各段階のハード上限。これを超えたら中断し「timeout」エラーとして明示する（沈黙のハング防止）。
const STAGE_TIMEOUT_MS = 45000;

interface StageResult {
  report: StageReport;
  selectors: string[];
}

function hasApi(): boolean {
  return typeof LanguageModel !== "undefined" && LanguageModel != null;
}

function notAvailableReport(
  availability: StageAvailability,
  error: string | null,
): StageResult {
  return { report: { ran: false, availability, count: 0, error }, selectors: [] };
}

export async function getAvailability(): Promise<{
  text: NanoState;
  image: NanoState;
}> {
  if (!hasApi()) return { text: "unavailable", image: "unavailable" };
  const api = LanguageModel as LanguageModelStatic;
  const text = await api.availability(TEXT_OPTS);
  const image = await api.availability(IMAGE_OPTS);
  return { text, image };
}

// popup の user gesture から呼ぶ。downloadable/downloading なら create で DL を開始する。
export async function startDownload(
  onProgress?: (loaded: number) => void,
): Promise<{ availability: NanoState; error: string | null }> {
  if (!hasApi()) {
    return { availability: "unavailable", error: "LanguageModel API がありません" };
  }
  const api = LanguageModel as LanguageModelStatic;
  try {
    const before = await api.availability(TEXT_OPTS);
    if (before === "unavailable") {
      return { availability: "unavailable", error: "このデバイスでは利用できません" };
    }
    if (before === "available") return { availability: "available", error: null };

    let session: LanguageModelSession | null = null;
    try {
      session = await api.create({
        ...TEXT_OPTS,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => {
            onProgress?.((e as ProgressEvent).loaded);
          });
        },
      });
    } finally {
      session?.destroy();
    }
    const after = await api.availability(TEXT_OPTS);
    return { availability: after, error: null };
  } catch (e) {
    return { availability: "downloadable", error: String(e) };
  }
}

async function runTextStage(snapshot: string): Promise<StageResult> {
  if (!hasApi()) {
    return notAvailableReport("unavailable", "LanguageModel API がありません");
  }
  const api = LanguageModel as LanguageModelStatic;
  let availability: NanoState;
  try {
    availability = await api.availability(TEXT_OPTS);
  } catch (e) {
    return notAvailableReport("unavailable", String(e));
  }
  if (availability !== "available") {
    const error =
      availability === "unavailable"
        ? "このデバイスでは利用できません"
        : "モデル未ダウンロード（popup から有効化してください）";
    return notAvailableReport(availability, error);
  }
  let session: LanguageModelSession | null = null;
  try {
    const signal = AbortSignal.timeout(STAGE_TIMEOUT_MS);
    session = await api.create({ ...TEXT_OPTS, signal });
    const raw = await session.prompt(buildTextPrompt(snapshot), {
      responseConstraint: SELECTOR_SCHEMA,
      signal,
    });
    const selectors = parseSelectorResponse(raw);
    return { report: { ran: true, availability, count: selectors.length, error: null }, selectors };
  } catch (e) {
    return { report: { ran: true, availability, count: 0, error: String(e) }, selectors: [] };
  } finally {
    session?.destroy();
  }
}

async function runImageStage(dataUrl: string): Promise<StageResult> {
  if (!hasApi()) {
    return notAvailableReport("unavailable", "LanguageModel API がありません");
  }
  const api = LanguageModel as LanguageModelStatic;
  let availability: NanoState;
  try {
    availability = await api.availability(IMAGE_OPTS);
  } catch (e) {
    return notAvailableReport("unavailable", String(e));
  }
  if (availability !== "available") {
    const error =
      availability === "unavailable"
        ? "画像検知はこのデバイス/Chrome では利用できません"
        : "画像モデル未ダウンロード";
    return notAvailableReport(availability, error);
  }
  let session: LanguageModelSession | null = null;
  let bitmap: ImageBitmap | null = null;
  try {
    const signal = AbortSignal.timeout(STAGE_TIMEOUT_MS);
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
    session = await api.create({ ...IMAGE_OPTS, signal });
    const raw = await session.prompt(
      [
        {
          role: "user",
          content: [
            { type: "text", value: IMAGE_PROMPT_TEXT },
            { type: "image", value: bitmap },
          ],
        },
      ],
      { responseConstraint: SELECTOR_SCHEMA, signal },
    );
    const selectors = parseSelectorResponse(raw);
    return { report: { ran: true, availability, count: selectors.length, error: null }, selectors };
  } catch (e) {
    return { report: { ran: true, availability, count: 0, error: String(e) }, selectors: [] };
  } finally {
    bitmap?.close();
    session?.destroy();
  }
}

// 2 段階検知のオーケストレーション。
// 段階2(画像)は dataUrl があるときだけ走らせる。無ければ "skipped" を明示する。
// （画像段階を使うかどうかの判断は inject 側=dataUrl を作るか否か に一元化されている）
export async function runDetection(input: {
  snapshot: string;
  dataUrl: string | null;
}): Promise<NanoReport> {
  const text = await runTextStage(input.snapshot);

  const image: StageResult = input.dataUrl
    ? await runImageStage(input.dataUrl)
    : notAvailableReport("skipped", "フレーム未取得のため画像検知をスキップ");

  const selectors = mergeSelectors(text.selectors, image.selectors);
  const fatal =
    !text.report.ran && text.report.availability === "unavailable"
      ? "Gemini Nano が利用できません"
      : null;

  return { selectors, text: text.report, image: image.report, error: fatal };
}
