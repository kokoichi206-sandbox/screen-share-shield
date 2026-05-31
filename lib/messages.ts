// メッセージ契約（content / inject / popup / background 共通のコントラクト層）。
// type ごとに必要なフィールドを判別共用体で固定し、payload の取りこぼしを型で防ぐ。

import type { NormRect } from "@/lib/masking";

export const CHANNEL = "screen-share-shield" as const;

export type MaskStyle = "blur" | "black";

// Nano(Prompt API)の availability 4 値。types/prompt-api.d.ts の NanoAvailability と同値。
export type NanoState =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

// storage に永続化する設定（forceAll は一時状態なので含めない）。
export interface Settings {
  enabled: boolean;
  style: MaskStyle;
  blurPx: number;
  selectors: string[];
  // 手動「今すぐ検知」で画像も使うか（DOM+画像のマルチモーダル統合検知）。
  // 自動再検知は常にテキストのみで、このフラグの影響を受けない。
  imageStage: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  style: "blur",
  blurPx: 18,
  selectors: [],
  imageStage: true,
};

// inject が通知する現在の共有状態。
export interface ShareStatus {
  sharing: boolean;
  enabled: boolean;
  forceAll: boolean;
  style: MaskStyle;
  blurPx: number;
  surface: string | null;
  selectors: string[]; // 手動セレクタ
  autoSelectors: string[]; // Nano 自動検知セレクタ（手動とは別枠）
}

// 画像(マルチモーダル)を実際に検知へ使えたか。used=false のときは理由を必ず持つ。
// （暗黙 fallback 禁止: 「画像を使わなかった」事実と理由を popup へ明示するため）
export interface ImageUsage {
  used: boolean;
  reason: string | null;
}

// AI 自動検知の結果。DOM スナップショット(+任意で画像)を1回の呼び出しで処理する。
export interface NanoReport {
  selectors: string[];
  ran: boolean; // モデルが結果を返したか（availability ゲートを通過したか）
  availability: NanoState; // テキストモデルの可用性（検知全体のゲート）
  image: ImageUsage; // 画像を使えたか / 使わなかった理由
  count: number;
  error: string | null; // 呼び出しエラー（ran=true でも失敗ならここに入る）
}

// --- page(inject) を操作するコマンド: content/popup/background -> inject ---
export type PageCommand =
  | { type: "set-enabled"; enabled: boolean }
  | { type: "toggle-enabled" }
  | { type: "set-force-all"; forceAll: boolean }
  | { type: "toggle-force-all" }
  | { type: "set-style"; style: MaskStyle; blurPx?: number }
  | { type: "add-selector"; selector: string }
  | { type: "remove-selector"; selector: string }
  | { type: "set-selectors"; selectors: string[] }
  | { type: "clear-selectors" }
  // AI 自動検知トリガ: inject に DOM スナップショット(と任意で現フレーム)を集めさせる
  | { type: "run-detection"; includeImage: boolean }
  // 自動検知結果の反映（手動 selectors とは別枠）。id は検知の世代で、inject 側で
  // 最新の検知に対する結果だけを採用し、順序逆転による古い結果の適用を防ぐ。
  | { type: "set-auto-selectors"; selectors: string[]; id: number }
  | { type: "clear-auto-selectors" }
  // クロスタブ: 共有元(capturer)が、armed な全タブの正規化 rect(集約)を受け取り適用する。
  // capturer は常に「ローカル DOM ∪ これらの remote rect」をマスクする(fail-closed)。
  | { type: "set-remote-rects"; rects: NormRect[] }
  // クロスタブ: background が「このタブは今 capturer に共有されている(live)」を通知。
  // live のときだけ自動再検知を走らせ、非共有時の Nano 起動を抑える。
  | { type: "set-shared-live"; live: boolean }
  | { type: "get-status" };

// --- page(inject) からの通知イベント: inject -> content ---
export type PageEvent =
  | { type: "ready" }
  | { type: "status"; status: ShareStatus }
  | { type: "share-started"; surface: string }
  | { type: "share-ended" }
  // クロスタブ: このタブ(共有される側)の機密 rect を正規化座標で publish。
  // armed = 機密セレクタを持つか（スクロールで rect が一時的に空でも source として集約対象に残す）。
  | { type: "publish-rects"; rects: NormRect[]; armed: boolean }
  // AI 自動検知の入力(DOM スナップショット)。wantImage=true のとき background が
  // captureVisibleTab でフレームを取り、DOM+画像を1回のマルチモーダル呼び出しに統合する。
  // id は検知の世代。結果(set-auto-selectors)に同じ id を載せて順序逆転を防ぐ。
  | { type: "detect-payload"; snapshot: string; wantImage: boolean; id: number }
  | { type: "warning"; code: string; surface: string; message: string }
  | { type: "error"; where: string; message: string };

// --- window.postMessage で運ぶエンベロープ（MAIN world <-> ISOLATED world）---
export interface ToPageMessage {
  channel: typeof CHANNEL;
  dir: "to-page";
  cmd: PageCommand;
}
export interface ToContentMessage {
  channel: typeof CHANNEL;
  dir: "to-content";
  evt: PageEvent;
}

export function isToPageMessage(v: unknown): v is ToPageMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { channel?: unknown }).channel === CHANNEL &&
    (v as { dir?: unknown }).dir === "to-page"
  );
}
export function isToContentMessage(v: unknown): v is ToContentMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { channel?: unknown }).channel === CHANNEL &&
    (v as { dir?: unknown }).dir === "to-content"
  );
}

// --- chrome.runtime メッセージ（popup/background <-> content）---
export type RuntimeMessage =
  // popup/background -> bridge -> inject へのコマンド転送
  | { channel: typeof CHANNEL; kind: "command"; cmd: PageCommand }
  // popup -> bridge: 現在の共有状態 + 直近の Nano 結果を問い合わせ
  | { channel: typeof CHANNEL; kind: "query-status" }
  // bridge -> background: AI 検知の実行依頼。wantImage=true なら background が
  // captureVisibleTab でフレームを取り、DOM+画像を統合して検知する。
  | {
      channel: typeof CHANNEL;
      kind: "detect";
      snapshot: string;
      wantImage: boolean;
    }
  // popup -> background: Nano の利用可否問い合わせ
  | { channel: typeof CHANNEL; kind: "nano-availability" }
  // popup(=user gesture) -> background: モデルDL開始
  | { channel: typeof CHANNEL; kind: "nano-download" }
  // クロスタブ: 共有される側 -> background へ正規化 rect を publish（sender.tab.id で識別）
  | {
      channel: typeof CHANNEL;
      kind: "publish-rects";
      rects: NormRect[];
      armed: boolean;
    }
  // クロスタブ: 共有元 -> background へ「キャプチャ開始、armed な全タブの rect をくれ」
  | { channel: typeof CHANNEL; kind: "subscribe-rects" }
  // クロスタブ: 共有元 -> background へ購読解除
  | { channel: typeof CHANNEL; kind: "unsubscribe-rects" };

export interface QueryStatusResponse {
  status: ShareStatus | null;
  nano: NanoReport | null;
}

// kind:'detect' の応答は NanoReport そのもの。
export type DetectResponse = NanoReport;

export interface NanoAvailabilityResponse {
  text: NanoState;
  image: NanoState;
}

export interface NanoDownloadResponse {
  availability: NanoState;
  error: string | null;
}

export function isRuntimeMessage(v: unknown): v is RuntimeMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { channel?: unknown }).channel === CHANNEL
  );
}
