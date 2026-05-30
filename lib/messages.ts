// メッセージ契約（content / inject / popup / background 共通のコントラクト層）。
// type ごとに必要なフィールドを判別共用体で固定し、payload の取りこぼしを型で防ぐ。

import type { NormRect } from "@/lib/masking";

export const CHANNEL = "nanoshield" as const;

export type MaskStyle = "blur" | "black";

// Nano(Prompt API)の availability 4 値。types/prompt-api.d.ts の NanoAvailability と同値。
export type NanoState =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

// 検知段階の状態。availability 4 値に加え、入力不足で段階を実行しなかった "skipped" を持つ。
// （"skipped" は「このデバイスが非対応」ではなく「フレーム未取得等で今回は走らせなかった」を意味する）
export type StageAvailability = NanoState | "skipped";

// storage に永続化する設定（forceAll は一時状態なので含めない）。
export interface Settings {
  enabled: boolean;
  style: MaskStyle;
  blurPx: number;
  selectors: string[];
  // 共有開始時に AI 自動検知を走らせるか（既定 off: 予期せぬモデルDLを避ける）。
  autoDetectOnShare: boolean;
  // 段階2(画像)検知を使うか。
  imageStage: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  style: "blur",
  blurPx: 18,
  selectors: [],
  autoDetectOnShare: false,
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

// AI 自動検知の各段階の結果。
export interface StageReport {
  ran: boolean;
  availability: StageAvailability;
  count: number;
  error: string | null;
}

// AI 自動検知の総合結果。
export interface NanoReport {
  selectors: string[];
  text: StageReport;
  image: StageReport;
  error: string | null;
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
  // 自動検知結果の反映（手動 selectors とは別枠）
  | { type: "set-auto-selectors"; selectors: string[] }
  | { type: "clear-auto-selectors" }
  // クロスタブ: 共有元(capturer)が、共有される側の正規化 rect を受け取り適用する。
  // crossTab=true は「別タブ共有（リモートソースあり）」を意味し、このとき capturer は
  // 自分のローカル DOM マスクを使わず remote rect のみを適用する（自分の DOM は共有内容と無関係）。
  | { type: "set-remote-rects"; rects: NormRect[]; crossTab: boolean }
  | { type: "get-status" };

// --- page(inject) からの通知イベント: inject -> content ---
export type PageEvent =
  | { type: "ready" }
  | { type: "status"; status: ShareStatus }
  // videoW/videoH は capturer のソースタブ対応付け(アスペクト一致)に使う
  | { type: "share-started"; surface: string; videoW: number; videoH: number }
  | { type: "share-ended" }
  // クロスタブ: このタブ(共有される側)の機密 rect を正規化座標で publish。
  // aspect = ビューポートの幅/高さ（対応付けの手がかり）。
  // armed = 機密セレクタを持つか（スクロールで rect が一時的に空でもソース候補を維持するため）。
  | { type: "publish-rects"; rects: NormRect[]; aspect: number; armed: boolean }
  // AI 自動検知の入力(DOM スナップショット + 任意の縮小フレーム dataURL)
  // dataUrl があるときだけ段階2(画像)を走らせる。null なら段階2はスキップ。
  | { type: "detect-payload"; snapshot: string; dataUrl: string | null }
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
  // bridge -> background: AI 検知の実行依頼（dataUrl があれば段階2も走る）
  | {
      channel: typeof CHANNEL;
      kind: "detect";
      snapshot: string;
      dataUrl: string | null;
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
      aspect: number;
      armed: boolean;
    }
  // クロスタブ: 共有元 -> background へ「キャプチャ開始、対応ソースの rect をくれ」
  | { channel: typeof CHANNEL; kind: "subscribe-rects"; captureAspect: number | null }
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
