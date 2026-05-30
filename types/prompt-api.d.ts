// Chrome 内蔵 Prompt API (Gemini Nano) の最小アンビエント型。
// TS の標準 lib にまだ含まれないため、本拡張が使う範囲だけ宣言する。
// 参照: Chrome for Developers "Prompt API"（2026 時点の現行世代）。

type NanoAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

interface LanguageModelExpectedInput {
  type: "text" | "image" | "audio";
  languages?: string[];
}

interface LanguageModelExpectedOutput {
  type: "text";
  languages?: string[];
}

interface LanguageModelMessageContentPart {
  type: "text" | "image" | "audio";
  // text は string、image は ImageBitmapSource 系/Blob、audio は Blob 等。
  value: string | ImageBitmap | Blob | ImageData | ArrayBuffer | ArrayBufferView;
}

interface LanguageModelMessage {
  role: "system" | "user" | "assistant";
  content: string | LanguageModelMessageContentPart[];
}

interface LanguageModelCreateOptions {
  initialPrompts?: LanguageModelMessage[];
  temperature?: number;
  topK?: number;
  expectedInputs?: LanguageModelExpectedInput[];
  expectedOutputs?: LanguageModelExpectedOutput[];
  signal?: AbortSignal;
  // monitor の引数は EventTarget。'downloadprogress' で ProgressEvent(loaded 0..1) が飛ぶ。
  monitor?: (m: EventTarget) => void;
}

interface LanguageModelPromptOptions {
  responseConstraint?: object;
  omitResponseConstraintInput?: boolean;
  signal?: AbortSignal;
}

interface LanguageModelSession {
  prompt(
    input: string | LanguageModelMessage[],
    options?: LanguageModelPromptOptions,
  ): Promise<string>;
  readonly contextUsage: number;
  readonly contextWindow: number;
  destroy(): void;
}

interface LanguageModelParams {
  defaultTopK: number;
  maxTopK: number;
  defaultTemperature: number;
  maxTemperature: number;
}

interface LanguageModelStatic {
  availability(options?: LanguageModelCreateOptions): Promise<NanoAvailability>;
  create(options?: LanguageModelCreateOptions): Promise<LanguageModelSession>;
  params(): Promise<LanguageModelParams>;
}

declare const LanguageModel: LanguageModelStatic | undefined;
