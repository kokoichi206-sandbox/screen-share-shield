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
import {
  getAvailability,
  runDetection,
  startDownload,
} from "@/lib/nano-detect";

// service worker。3つの役割:
//  1) ホットキー(commands)をアクティブタブの bridge へ転送。
//  2) Gemini Nano(LanguageModel)の実行。拡張 SW は origin trial 不要で self.LanguageModel が使える。
//  3) クロスタブ協調: 各タブが publish する正規化 rect を集約し、共有元(capturer)へ
//     「armed な全タブの rect」を配る。capturer は ローカル∪リモート を当てる(fail-closed)。
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
  armed: boolean;
}
const tabRects = new Map<number, TabRectsEntry>();
const capturers = new Set<number>();
const lastPushed = new Map<number, string>(); // capturerTabId -> 直前に配った rects の JSON
const liveSources = new Map<number, boolean>(); // sourceTabId -> 直前に通知した live 状態

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

  // タブが閉じたらレジストリから除去し、残る capturer / live source を更新。
  browser.tabs.onRemoved.addListener((tabId) => {
    tabRects.delete(tabId);
    capturers.delete(tabId);
    lastPushed.delete(tabId);
    liveSources.delete(tabId);
    for (const capturerTabId of capturers) pushRemoteRects(capturerTabId);
    updateLiveSources();
  });

  // --- runtime メッセージ ---
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRuntimeMessage(message)) return;

    switch (message.kind) {
      // ---- Nano（非同期応答: sendResponse + return true）----
      case "detect":
        // 画像フレームは inject の canvas でなく、送信元タブの可視内容を
        // captureVisibleTab で独立取得する（armed な機密タブでも画像が乗る）。
        respond(
          detectForRequest(message, sender.tab?.id ?? null, sender.tab?.windowId ?? null),
          sendResponse,
          (e): NanoReport => ({
            selectors: [],
            ran: false,
            availability: "unavailable",
            image: { used: false, reason: "検知に失敗" },
            count: 0,
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
        tabRects.set(tabId, { rects: message.rects, armed: message.armed });
        // ソースが更新されたので全 capturer を再評価して配り直す。
        for (const capturerTabId of capturers) pushRemoteRects(capturerTabId);
        updateLiveSources();
        return;
      }
      case "subscribe-rects": {
        const tabId = sender.tab?.id;
        if (tabId == null) return;
        capturers.add(tabId);
        pushRemoteRects(tabId);
        updateLiveSources();
        return;
      }
      case "unsubscribe-rects": {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          capturers.delete(tabId);
          lastPushed.delete(tabId);
        }
        updateLiveSources();
        return;
      }

      // command / query-status は content script(bridge) が tabs.sendMessage 経由で処理する。
      default:
        return;
    }
  });
});

// 送信元タブの可視内容を JPEG dataURL でキャプチャする。captureVisibleTab は
// 「その window で今可視のタブ」を撮るため、送信元タブが今アクティブでないと DOM
// スナップショット(送信元タブ)と別タブの画像が混ざる。混ぜず、テキストのみへ倒す
// （fail-closed: 不確かな画像で誤検知させない）。レート制限・権限失敗も理由を返す。
async function captureFrame(
  tabId: number | null,
  windowId: number | null,
): Promise<{ dataUrl: string | null; reason: string | null }> {
  if (tabId == null || windowId == null) {
    return { dataUrl: null, reason: "送信元タブが不明（テキストのみ）" };
  }
  let activeId: number | undefined;
  try {
    const [active] = await browser.tabs.query({ active: true, windowId });
    activeId = active?.id;
  } catch (e) {
    return { dataUrl: null, reason: `アクティブタブ確認に失敗: ${String(e)}` };
  }
  if (activeId !== tabId) {
    return { dataUrl: null, reason: "送信元タブが非アクティブのため画像なし（テキストのみ）" };
  }
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 80,
    });
    return { dataUrl, reason: null };
  } catch (e) {
    return { dataUrl: null, reason: `画面キャプチャ失敗: ${String(e)}` };
  }
}

// detect 依頼を処理する。wantImage のときだけフレームを取り、DOM+画像を統合検知する。
// 画像が取れない/未要求のときは理由を明示してテキストのみで検知する（暗黙 fallback 禁止）。
function detectForRequest(
  message: Extract<RuntimeMessage, { kind: "detect" }>,
  tabId: number | null,
  windowId: number | null,
): Promise<NanoReport> {
  if (!message.wantImage) {
    return runDetection({
      snapshot: message.snapshot,
      dataUrl: null,
      imageSkipReason: "画像リクエストなし（テキストのみ）",
    });
  }
  return captureFrame(tabId, windowId).then(({ dataUrl, reason }) =>
    runDetection({
      snapshot: message.snapshot,
      dataUrl,
      imageSkipReason: reason,
    }),
  );
}

// capturer へ「armed な全タブ(自分以外)の rect を集約したもの」を配る。
// どのタブを映しているか特定できないため、1つに賭けず全 armed タブ分を当てる(fail-closed)。
// 単一の armed タブ運用なら過不足なし。複数 armed なら過剰マスク(安全側)になる。
function pushRemoteRects(capturerTabId: number): void {
  if (!capturers.has(capturerTabId)) return;

  const rects: NormRect[] = [];
  for (const [tabId, entry] of tabRects) {
    if (tabId === capturerTabId || !entry.armed) continue;
    rects.push(...entry.rects);
  }

  // この capturer に前回配った内容と同じなら送らない（無駄な再送を抑制）。
  const json = JSON.stringify(rects);
  if (lastPushed.get(capturerTabId) === json) return;
  lastPushed.set(capturerTabId, json);

  const message: RuntimeMessage = {
    channel: CHANNEL,
    kind: "command",
    cmd: { type: "set-remote-rects", rects },
  };
  void browser.tabs.sendMessage(capturerTabId, message).catch(() => {});
}

// 各 armed source タブに「今 capturer に共有されているか(live)」を通知する。
// live のときだけ source 側で自動再検知が走る（非共有時の Nano 起動を抑える）。
// source T が live = T が armed かつ T 以外の capturer が存在する（全 armed を全 capturer に配るため）。
function updateLiveSources(): void {
  const hasOtherCapturer = (tabId: number): boolean => {
    for (const c of capturers) if (c !== tabId) return true;
    return false;
  };
  const relevant = new Set<number>([...tabRects.keys(), ...liveSources.keys()]);
  for (const tabId of relevant) {
    const live = !!tabRects.get(tabId)?.armed && hasOtherCapturer(tabId);
    if (liveSources.get(tabId) === live) continue;
    liveSources.set(tabId, live);
    const message: RuntimeMessage = {
      channel: CHANNEL,
      kind: "command",
      cmd: { type: "set-shared-live", live },
    };
    void browser.tabs.sendMessage(tabId, message).catch(() => {});
  }
}

// Promise の結果を sendResponse へ。reject 時は必ず fallback を返してチャネルを閉じない。
function respond<T>(
  promise: Promise<T>,
  sendResponse: (response: T) => void,
  fallback: (error: unknown) => T,
): void {
  promise.then(sendResponse, (error: unknown) => sendResponse(fallback(error)));
}
