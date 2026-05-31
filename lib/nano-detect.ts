// Gemini Nano(Prompt API)による機密要素の自動検知。background service worker で動かす。
// LanguageModel への参照は全て関数内に閉じ込め、純粋部分(schema/prompt)だけを
// 副作用なく export してテスト可能にする。
//
// 画像があるときは DOM スナップショット + 画像を1回のマルチモーダル呼び出しに統合する。
// 画像は「どの要素が視覚的に機密に見えるか」の文脈に使い、返すセレクタは DOM 一覧に実在する
// ものに限定する（ピクセルからのセレクタ当てずっぽうを排除する）。
//
// 契約: 検知できない/利用不可は「エラーを握りつぶして空を返す」のではなく、
//       availability / image.reason に明示して返す（暗黙 fallback 禁止）。

import type { ImageUsage, NanoReport, NanoState } from "@/lib/messages";
import { parseSelectorResponse } from "@/lib/nano-parse";
import { computeDownscaleSize } from "@/lib/image";

// --- 純粋: 構造化出力スキーマ / プロンプト ---

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
- ページ全体を覆うコンテナ（#root, #app, #__next, ラッパー要素など）は返さない。機密を含む
  「個々の入力欄やテキスト要素」をできるだけ絞って指す（カード番号欄、メール欄、金額表示など）。
- 確実に機密と判断できるものだけ。最大50件。

形式: {"selectors": ["#id", "tag.class", ...]}

要素一覧:
${snapshot}`;
}

// DOM スナップショット + スクリーンショットを1回で渡すときのプロンプト。
// 画像は「どれが機密に見えるか」の判断材料に使い、返すセレクタは一覧に実在するものに限定する。
export function buildMultimodalPrompt(snapshot: string): string {
  return `次は共有中ページの要素一覧と、そのページのスクリーンショット画像です。
各行は「CSSヒント␣属性␣テキスト断片」の形式で、先頭の CSSヒント部分だけが CSS セレクタです。
画像は「どの要素が視覚的に機密に見えるか」を判断するための文脈として使ってください。

機密情報を含む要素を、画像の見た目も手がかりにして選び、その要素を指す CSS セレクタを JSON で返してください。
重要なルール:
- 返すセレクタは必ず下の要素一覧に実在する先頭の CSS セレクタ部分のみ。画像から推測した、
  一覧に無いセレクタは返さない（画像はあくまで視覚的な裏付けに使う）。
- role=, type=, name=, aria=, data=, text= などの注釈は含めない。
- body/main/div/span のような広すぎる素のセレクタ、ページ全体を覆うコンテナ(#root 等)は返さない。
- 確実に機密と判断できるものだけ。最大50件。

形式: {"selectors": ["#id", "tag.class", ...]}

要素一覧:
${snapshot}`;
}

// --- 副作用あり: LanguageModel 呼び出し（background でのみ実行） ---

const TEXT_OPTS: LanguageModelCreateOptions = {
  expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
  expectedOutputs: [{ type: "text", languages: ["ja", "en"] }],
  initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
};

const MULTIMODAL_OPTS: LanguageModelCreateOptions = {
  expectedInputs: [
    { type: "text", languages: ["ja", "en"] },
    { type: "image" },
  ],
  expectedOutputs: [{ type: "text", languages: ["ja", "en"] }],
  initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
};

// 呼び出しのハード上限。これを超えたら中断し error として明示する（沈黙のハング防止）。
const STAGE_TIMEOUT_MS = 45000;
// Nano に渡すフレームの長辺上限（コスト抑制のため縮小する）。
const FRAME_MAX_EDGE = 1024;

function hasApi(): boolean {
  return typeof LanguageModel !== "undefined" && LanguageModel != null;
}

export async function getAvailability(): Promise<{
  text: NanoState;
  image: NanoState;
}> {
  if (!hasApi()) return { text: "unavailable", image: "unavailable" };
  const api = LanguageModel as LanguageModelStatic;
  const text = await api.availability(TEXT_OPTS);
  const image = await api.availability(MULTIMODAL_OPTS);
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

// タイムアウト用 AbortSignal。早期に終わったら clear() でタイマーを即時解放する。
// （AbortSignal.timeout は呼び出しが早く終わってもタイマーが満了まで残るため、
//  SW で繰り返すと孤立タイマーが積む。AbortController + clearTimeout で即時解放する）
function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("検知がタイムアウトしました", "TimeoutError")),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// テキストのみの検知呼び出し。例外はそのまま投げ、呼び出し側で error 報告する。
async function runTextCall(
  api: LanguageModelStatic,
  snapshot: string,
): Promise<string[]> {
  let session: LanguageModelSession | null = null;
  const dl = deadline(STAGE_TIMEOUT_MS);
  try {
    session = await api.create({ ...TEXT_OPTS, signal: dl.signal });
    const raw = await session.prompt(buildTextPrompt(snapshot), {
      responseConstraint: SELECTOR_SCHEMA,
      signal: dl.signal,
    });
    return parseSelectorResponse(raw);
  } finally {
    dl.clear();
    session?.destroy();
  }
}

// DOM + 画像を1回のマルチモーダル呼び出しに統合した検知。
async function runUnifiedCall(
  api: LanguageModelStatic,
  snapshot: string,
  dataUrl: string,
): Promise<string[]> {
  let session: LanguageModelSession | null = null;
  let bitmap: ImageBitmap | null = null;
  const dl = deadline(STAGE_TIMEOUT_MS);
  try {
    bitmap = await decodeDownscaled(dataUrl);
    session = await api.create({ ...MULTIMODAL_OPTS, signal: dl.signal });
    const raw = await session.prompt(
      [
        {
          role: "user",
          content: [
            { type: "text", value: buildMultimodalPrompt(snapshot) },
            { type: "image", value: bitmap },
          ],
        },
      ],
      { responseConstraint: SELECTOR_SCHEMA, signal: dl.signal },
    );
    return parseSelectorResponse(raw);
  } finally {
    dl.clear();
    bitmap?.close(); // decodeDownscaled が返した bitmap の所有権はここ。close は1回だけ。
    session?.destroy();
  }
}

// dataURL を長辺 FRAME_MAX_EDGE 以下へ縮小して ImageBitmap 化（Nano のコスト抑制）。
// 返した ImageBitmap の close は呼び出し側(runUnifiedCall)が行う。ここで close するのは
// リサイズした場合に中間生成した full のみ（返り値は閉じない）。
async function decodeDownscaled(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  const full = await createImageBitmap(blob);
  const { width, height } = computeDownscaleSize(
    full.width,
    full.height,
    FRAME_MAX_EDGE,
  );
  if (width >= full.width && height >= full.height) return full;
  try {
    return await createImageBitmap(full, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: "medium",
    });
  } finally {
    full.close();
  }
}

function fatalReport(error: string, availability: NanoState): NanoReport {
  return {
    selectors: [],
    ran: false,
    availability,
    image: { used: false, reason: error },
    count: 0,
    error,
  };
}

// 検知本体。テキストモデルの availability で全体をゲートし、画像が使えるときだけ統合呼び出しにする。
// dataUrl が無い/画像モデル非対応のときは image.reason に理由を明示してテキストのみで続行する。
export async function runDetection(input: {
  snapshot: string;
  dataUrl: string | null;
  imageSkipReason?: string | null;
}): Promise<NanoReport> {
  if (!hasApi()) {
    return fatalReport("Gemini Nano が利用できません", "unavailable");
  }
  const api = LanguageModel as LanguageModelStatic;

  let textAvail: NanoState;
  try {
    textAvail = await api.availability(TEXT_OPTS);
  } catch (e) {
    return fatalReport(String(e), "unavailable");
  }
  if (textAvail !== "available") {
    const error =
      textAvail === "unavailable"
        ? "このデバイスでは利用できません"
        : "モデル未ダウンロード（popup から有効化してください）";
    return {
      selectors: [],
      ran: false,
      availability: textAvail,
      image: { used: false, reason: "テキスト検知が走らないため画像も未使用" },
      count: 0,
      error,
    };
  }

  // 画像を統合呼び出しに使えるか判定（使えない理由は必ず明示する）。
  let image: ImageUsage;
  let useImage = false;
  if (input.dataUrl) {
    let imageAvail: NanoState = "unavailable";
    try {
      imageAvail = await api.availability(MULTIMODAL_OPTS);
    } catch {
      imageAvail = "unavailable";
    }
    if (imageAvail === "available") {
      useImage = true;
      image = { used: true, reason: null };
    } else {
      image = {
        used: false,
        reason: `画像モデルが利用不可(${imageAvail})のためテキストのみ`,
      };
    }
  } else {
    image = {
      used: false,
      reason: input.imageSkipReason ?? "画像未取得のためテキストのみ",
    };
  }

  try {
    const selectors =
      useImage && input.dataUrl
        ? await runUnifiedCall(api, input.snapshot, input.dataUrl)
        : await runTextCall(api, input.snapshot);
    return {
      selectors,
      ran: true,
      availability: "available",
      image,
      count: selectors.length,
      error: null,
    };
  } catch (e) {
    // fail-closed: 呼び出し失敗時は空セレクタ + error を返す。bridge は ran && !error の
    // ときだけ自動枠を更新するので、既存マスクは外れない。
    return {
      selectors: [],
      ran: true,
      availability: "available",
      image,
      count: 0,
      error: String(e),
    };
  }
}
