import {
  CHANNEL,
  isRuntimeMessage,
  type NanoAvailabilityResponse,
  type NanoDownloadResponse,
  type NanoReport,
  type PageCommand,
  type RuntimeMessage,
} from "@/lib/messages";
import type { NormRect } from "@/lib/masking";
import { pickSourceTab, type SourceEntry } from "@/lib/match-source";
import {
  getAvailability,
  runDetection,
  startDownload,
} from "@/lib/nano-detect";

// service worker。3つの役割:
//  1) ホットキー(commands)をアクティブタブの bridge へ転送。
//  2) Gemini Nano(LanguageModel)の実行。拡張 SW は origin trial 不要で self.LanguageModel が使える。
//  3) クロスタブ協調: 各タブが publish する正規化 rect を集約し、共有元(capturer)へ対応ソースの rect を配る。
//
// 注意: WXT の `browser` はネイティブ chrome そのもの(polyfill 無し)。
// ネイティブ Chrome の onMessage は Promise 返却での非同期応答に非対応なので、
// 非同期応答が要る箇所は sendResponse + 同期 `return true` を使う。

const COMMAND_TO_PAGE: Record<string, PageCommand> = {
  "toggle-mask": { type: "toggle-enabled" },
  "panic-mask-all": { type: "toggle-force-all" },
};

// --- クロスタブ rect レジストリ（SW 内メモリ。揮発しても各タブが再 publish するので回復する）---
interface TabRectsEntry {
  rects: NormRect[];
  aspect: number;
  armed: boolean;
  ts: number;
}
const tabRects = new Map<number, TabRectsEntry>();
const capturers = new Map<number, { captureAspect: number | null }>();
const lastPushed = new Map<number, string>(); // capturerTabId -> 直前に配った rects の JSON
let seq = 0; // 単調増加の擬似タイムスタンプ（最新判定用）

export default defineBackground(() => {
  // --- ホットキー転送 ---
  browser.commands.onCommand.addListener(async (command) => {
    const cmd = COMMAND_TO_PAGE[command];
    if (!cmd) return;
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return;
    const message: RuntimeMessage = { channel: CHANNEL, kind: "command", cmd };
    void browser.tabs.sendMessage(tab.id, message).catch(() => {});
  });

  // タブが閉じたらレジストリから除去し、残る capturer を更新。
  // 閉じたタブは source でも capturer でもなくなるので両 Map から消すのが正しい。
  browser.tabs.onRemoved.addListener((tabId) => {
    tabRects.delete(tabId);
    capturers.delete(tabId);
    lastPushed.delete(tabId);
    for (const capturerTabId of capturers.keys()) pushRemoteRects(capturerTabId);
  });

  // --- runtime メッセージ ---
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRuntimeMessage(message)) return;

    switch (message.kind) {
      // ---- Nano（非同期応答: sendResponse + return true）----
      case "detect":
        respond(
          runDetection({ snapshot: message.snapshot, dataUrl: message.dataUrl }),
          sendResponse,
          (e): NanoReport => ({
            selectors: [],
            text: { ran: false, availability: "unavailable", count: 0, error: String(e) },
            image: { ran: false, availability: "skipped", count: 0, error: null },
            error: String(e),
          }),
        );
        return true;
      case "nano-availability":
        respond(
          getAvailability(),
          sendResponse,
          (): NanoAvailabilityResponse => ({ text: "unavailable", image: "unavailable" }),
        );
        return true;
      case "nano-download":
        respond(
          startDownload(),
          sendResponse,
          (e): NanoDownloadResponse => ({ availability: "unavailable", error: String(e) }),
        );
        return true;

      // ---- クロスタブ（応答不要・fire and forget）----
      case "publish-rects": {
        const tabId = sender.tab?.id;
        if (tabId == null) return;
        tabRects.set(tabId, {
          rects: message.rects,
          aspect: message.aspect,
          armed: message.armed,
          ts: ++seq,
        });
        // ソースが更新されたので全 capturer を再評価して配り直す。
        for (const capturerTabId of capturers.keys()) pushRemoteRects(capturerTabId);
        return;
      }
      case "subscribe-rects": {
        const tabId = sender.tab?.id;
        if (tabId == null) return;
        capturers.set(tabId, { captureAspect: message.captureAspect });
        pushRemoteRects(tabId);
        return;
      }
      case "unsubscribe-rects": {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          capturers.delete(tabId);
          lastPushed.delete(tabId);
        }
        return;
      }

      // command / query-status は content script(bridge) が tabs.sendMessage 経由で処理する。
      default:
        return;
    }
  });
});

// capturer がキャプチャしている surface に対応するソースタブの rect を配る。
function pushRemoteRects(capturerTabId: number): void {
  const capturer = capturers.get(capturerTabId);
  if (!capturer) return;

  const entries: SourceEntry[] = [...tabRects.entries()].map(([tabId, e]) => ({
    tabId,
    armed: e.armed,
    aspect: e.aspect,
    ts: e.ts,
  }));
  const sourceTabId = pickSourceTab(entries, capturerTabId, capturer.captureAspect);
  // リモートソースが見つかった = 別タブ共有。capturer はローカル DOM マスクを使わず remote のみ。
  const crossTab = sourceTabId != null;
  const rects = sourceTabId != null ? (tabRects.get(sourceTabId)?.rects ?? []) : [];

  // この capturer に前回配った内容と同じなら送らない（無駄な再送を抑制）。
  const key = JSON.stringify({ crossTab, rects });
  if (lastPushed.get(capturerTabId) === key) return;
  lastPushed.set(capturerTabId, key);

  const message: RuntimeMessage = {
    channel: CHANNEL,
    kind: "command",
    cmd: { type: "set-remote-rects", rects, crossTab },
  };
  void browser.tabs.sendMessage(capturerTabId, message).catch(() => {});
}

// Promise の結果を sendResponse へ。reject 時は必ず fallback を返してチャネルを閉じない。
function respond<T>(
  promise: Promise<T>,
  sendResponse: (response: T) => void,
  fallback: (error: unknown) => T,
): void {
  promise.then(sendResponse, (error: unknown) => sendResponse(fallback(error)));
}
