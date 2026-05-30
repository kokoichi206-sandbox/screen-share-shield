import {
  CHANNEL,
  DEFAULT_SETTINGS,
  isToContentMessage,
  isRuntimeMessage,
  type DetectResponse,
  type NanoReport,
  type PageCommand,
  type PageEvent,
  type QueryStatusResponse,
  type Settings,
  type ShareStatus,
  type ToPageMessage,
} from "@/lib/messages";

// ISOLATED world のブリッジ。MAIN world の inject と、拡張側(popup/background)を繋ぐ。
// inject は chrome.* を使えず、ここは window の getDisplayMedia を差し替えられない。
// 役割分担: inject=映像加工 / background=Nano 実行 / bridge=両者と popup の中継・設定永続化。

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    // inject が最後に通知した状態（popup が開いたとき即返すためのキャッシュ）
    let lastStatus: ShareStatus | null = null;
    // background が返した直近の Nano 検知結果（popup 表示用）
    let lastNanoReport: NanoReport | null = null;

    // --- inject(MAIN) -> bridge ---
    window.addEventListener("message", (e: MessageEvent) => {
      if (e.source !== window) return;
      if (!isToContentMessage(e.data)) return;
      const evt = e.data.evt;

      switch (evt.type) {
        case "status":
          lastStatus = evt.status;
          break;
        case "ready":
          void pushSavedSettings();
          break;
        case "share-started":
          // クロスタブ: タブ共有なら、armed な全タブの rect を background に要求する。
          if (evt.surface === "browser") startRectSubscription();
          break;
        case "share-ended":
          stopRectSubscription();
          break;
        case "publish-rects":
          // このタブ(共有される側)の rect を background へ。popup には流さない。
          void browser.runtime
            .sendMessage({
              channel: CHANNEL,
              kind: "publish-rects",
              rects: evt.rects,
              armed: evt.armed,
            })
            .catch(() => {});
          return;
        case "detect-payload":
          // 大きい dataURL を含むので popup には転送せず、ここで background に渡す。
          void handleDetectPayload(evt);
          return;
      }

      // popup が開いていれば届く。閉じていれば receiver なしで reject するので握りつぶす。
      void browser.runtime.sendMessage({ channel: CHANNEL, evt }).catch(() => {});
    });

    // --- 拡張側(popup/background) -> bridge -> inject ---
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isRuntimeMessage(message)) return;

      if (message.kind === "query-status") {
        const res: QueryStatusResponse = {
          status: lastStatus,
          nano: lastNanoReport,
        };
        sendResponse(res);
        return;
      }
      if (message.kind === "command") {
        // 新しい検知の開始時は直近結果を捨てる。popup のポーリングが
        // 前回の古いレポートを掴む(stale read)のを防ぐ。null = 検知中。
        if (message.cmd.type === "run-detection") lastNanoReport = null;
        toPage(message.cmd);
        sendResponse({ ok: true });
        return;
      }
      // detect / nano-* は background 宛。bridge は関与しない。
    });

    function toPage(cmd: PageCommand): void {
      const msg: ToPageMessage = { channel: CHANNEL, dir: "to-page", cmd };
      window.postMessage(msg, "*");
    }

    // クロスタブ: 共有中は subscribe を定期的に送り直す。MV3 の Service Worker が
    // アイドルで揮発すると capturers レジストリが消えるため、1回きりの subscribe では
    // 復帰後に rect 配信が止まる。定期再送で購読を維持する。
    let subscribeTick: number | null = null;
    function startRectSubscription(): void {
      stopRectSubscription();
      const send = () =>
        void browser.runtime
          .sendMessage({ channel: CHANNEL, kind: "subscribe-rects" })
          .catch(() => {});
      send();
      subscribeTick = window.setInterval(send, 1000);
    }
    function stopRectSubscription(): void {
      if (subscribeTick !== null) {
        clearInterval(subscribeTick);
        subscribeTick = null;
      }
      void browser.runtime
        .sendMessage({ channel: CHANNEL, kind: "unsubscribe-rects" })
        .catch(() => {});
    }

    // 段階1/2 のペイロードを background(Nano) に渡し、結果を inject へ反映する。
    async function handleDetectPayload(
      evt: Extract<PageEvent, { type: "detect-payload" }>,
    ): Promise<void> {
      try {
        const report = (await browser.runtime.sendMessage({
          channel: CHANNEL,
          kind: "detect",
          snapshot: evt.snapshot,
          dataUrl: evt.dataUrl,
        })) as DetectResponse | undefined;
        if (!report) return;
        lastNanoReport = report;
        // fail-closed: いずれかの段階が「実行され、かつエラー無し」のときだけ自動枠を更新する。
        // 検知が成功して 0 件 → 空に更新(正当)。利用不可/prompt失敗 → 既存マスクを維持(外さない)。
        const succeeded =
          (report.text.ran && report.text.error == null) ||
          (report.image.ran && report.image.error == null);
        if (succeeded) {
          toPage({ type: "set-auto-selectors", selectors: report.selectors });
        }
      } catch (e) {
        // fail-closed: 検知失敗時は inject の autoSelectors を「触らない」。
        // ここで空に同期すると共有中の既存マスクを外してしまう(=fail-open)ため。
        // エラーは lastNanoReport に記録し popup へ明示する。
        lastNanoReport = {
          selectors: [],
          text: { ran: false, availability: "unavailable", count: 0, error: String(e) },
          image: { ran: false, availability: "skipped", count: 0, error: null },
          error: String(e),
        };
      }
    }

    async function pushSavedSettings(): Promise<void> {
      const stored = await browser.storage.local.get("settings");
      const settings = stored.settings as Settings | undefined;
      if (!settings) return;
      toPage({ type: "set-style", style: settings.style, blurPx: settings.blurPx });
      toPage({ type: "set-selectors", selectors: settings.selectors });
      toPage({ type: "set-enabled", enabled: settings.enabled !== false });
    }

    // 初回起動時に既定設定を用意（inject 未ロードでも storage は埋める）。
    void browser.storage.local.get("settings").then(({ settings }) => {
      if (!settings) void browser.storage.local.set({ settings: DEFAULT_SETTINGS });
    });
  },
});
