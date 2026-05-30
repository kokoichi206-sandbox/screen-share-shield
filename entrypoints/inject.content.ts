import {
  CHANNEL,
  isToPageMessage,
  type MaskStyle,
  type PageCommand,
  type PageEvent,
  type ShareStatus,
} from "@/lib/messages";
import {
  clampRectToCanvas,
  fromNormalizedRect,
  isRectInViewport,
  scaleViewportRect,
  toNormalizedRect,
  type NormRect,
  type Rect,
} from "@/lib/masking";
import { buildSnapshot, type ElementMeta } from "@/lib/dom-snapshot";
import { computeDownscaleSize } from "@/lib/image";

// MAIN world で動く本体。
// navigator.mediaDevices.getDisplayMedia を差し替え、返ってきた映像を <canvas> で
// 1フレームずつ加工してマスクをかけ、加工後の MediaStream をアプリ(Meet/Zoom 等)へ返す。
//
//  - アプリに渡すのは加工後 stream。相手の映像と Meet のセルフプレビューはマスクされる。
//    マスクされないのは "実際に作業している本物のタブ画面" だけ。
//  - 要素 -> 映像ピクセルの座標対応は自タブ共有(displaySurface === 'browser')でのみ正確。
//  - 構築失敗時は生 stream を返さず例外を投げる(fail-closed)。漏れるより共有失敗を選ぶ。
//
// MAIN world なので chrome.* / browser.* は使えない。通信は window.postMessage のみ。

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    const state = {
      sharing: false,
      enabled: true,
      forceAll: false,
      style: "blur" as MaskStyle,
      blurPx: 18,
      selectors: new Set<string>(), // 手動セレクタ
      autoSelectors: new Set<string>(), // Nano 自動検知セレクタ（別枠）
      surface: null as string | null,
      remoteRects: [] as NormRect[], // armed な他タブから届いた正規化 rect(集約)
      sharedLive: false, // background が通知する「今 capturer に共有されている」状態
    };

    // 段階2(画像)検知のために、稼働中パイプラインの canvas を参照しておく。
    let currentCanvas: HTMLCanvasElement | null = null;

    // AI 自動再検知。手動「今すぐ検知」で arm され、以降は遷移/DOM変化/操作で再検知する。
    let autoDetectArmed = false;
    let autoIncludeImage = false;
    let lastDetectSnapshot = "";
    let domObserver: MutationObserver | null = null;
    let detectSeq = 0; // 検知の世代カウンタ
    let lastEmittedDetectId = 0; // 最後に emit した検知 id（古い結果を捨てる判定に使う）

    // leading + trailing throttle。scroll 中の publish を間引く。
    function throttle(fn: () => void, ms: number): () => void {
      let last = 0;
      let timer: number | null = null;
      return () => {
        const now = performance.now();
        const wait = ms - (now - last);
        if (wait <= 0) {
          last = now;
          fn();
        } else if (timer === null) {
          timer = window.setTimeout(() => {
            timer = null;
            last = performance.now();
            fn();
          }, wait);
        }
      };
    }

    // trailing debounce（maxWait 付き）。連続イベントが落ち着いてから実行するが、
    // 鳴り続ける場合でも最初の呼び出しから最大 maxWait で1回は発火する（starvation 防止）。
    function debounce(
      fn: () => void,
      ms: number,
      maxWait = Infinity,
    ): () => void {
      let timer: number | null = null;
      let firstCallAt = 0;
      return () => {
        const now = performance.now();
        if (timer === null) firstCallAt = now;
        else clearTimeout(timer);
        const wait = Math.min(ms, Math.max(0, maxWait - (now - firstCallAt)));
        timer = window.setTimeout(() => {
          timer = null;
          fn();
        }, wait);
      };
    }

    function emit(evt: PageEvent): void {
      window.postMessage({ channel: CHANNEL, dir: "to-content", evt }, "*");
    }

    function emitStatus(): void {
      const status: ShareStatus = {
        sharing: state.sharing,
        enabled: state.enabled,
        forceAll: state.forceAll,
        style: state.style,
        blurPx: state.blurPx,
        surface: state.surface,
        selectors: [...state.selectors],
        autoSelectors: [...state.autoSelectors],
      };
      emit({ type: "status", status });
    }

    // 文字ノードの直下テキストだけを取る（子孫の全文連結を避けてノイズを減らす）。
    function directText(el: Element): string {
      let t = "";
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) t += node.textContent ?? "";
      }
      return t.trim();
    }

    // 段階1: ビューポート内の候補要素から DOM スナップショットを作る。
    // Nano の初回応答を速く保つため小さめに抑える（大きいほど遅い）。
    function collectDomSnapshot(maxChars = 3500): string {
      const metas: ElementMeta[] = [];
      if (!document.body) return "";
      // TreeWalker で前方から走査し、上限で打ち切る。querySelectorAll('*') と違い
      // 巨大 DOM でも全要素の NodeList を作らずに済む。
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
      );
      let scanned = 0;
      for (
        let node = walker.nextNode();
        node && scanned < 1200 && metas.length < 120;
        node = walker.nextNode()
      ) {
        const el = node as Element;
        scanned++;
        const rect = el.getBoundingClientRect();
        if (!isRectInViewport(rect, window.innerWidth, window.innerHeight)) {
          continue;
        }
        const tag = el.tagName.toLowerCase();
        const isInput =
          tag === "input" || tag === "textarea" || tag === "select";
        const text = directText(el);
        const id = el.id || undefined;
        const dataKeys = el
          .getAttributeNames()
          .filter((n) => n.startsWith("data-"));
        const ariaLabel = el.getAttribute("aria-label") ?? undefined;
        // 機密の手がかりが何も無い要素は除外（ノイズ削減）
        const hasSignal =
          isInput ||
          !!id ||
          dataKeys.length > 0 ||
          !!ariaLabel ||
          (!!text && text.length <= 120);
        if (!hasSignal) continue;
        metas.push({
          tag,
          id,
          classes: el.classList.length ? [...el.classList] : undefined,
          role: el.getAttribute("role") ?? undefined,
          ariaLabel,
          name: el.getAttribute("name") ?? undefined,
          inputType: isInput ? (el.getAttribute("type") ?? tag) : undefined,
          dataKeys: dataKeys.length ? dataKeys : undefined,
          text: text && text.length <= 120 ? text : undefined,
        });
      }
      return buildSnapshot(metas, maxChars);
    }

    // 段階2: 稼働中 canvas を縮小して JPEG dataURL 文字列にする（runtime 経由で運ぶため）。
    // 未共有(canvas 無し)/tainted の場合は null を返し、段階2をスキップさせる。
    function sampleFrame(maxEdge = 1024): string | null {
      if (!currentCanvas?.width || !currentCanvas.height) return null;
      const { width, height } = computeDownscaleSize(
        currentCanvas.width,
        currentCanvas.height,
        maxEdge,
      );
      if (!width || !height) return null;
      const off = document.createElement("canvas");
      off.width = width;
      off.height = height;
      const octx = off.getContext("2d");
      if (!octx) return null;
      octx.drawImage(currentCanvas, 0, 0, width, height);
      try {
        return off.toDataURL("image/jpeg", 0.7);
      } catch {
        return null; // tainted canvas 等は段階2をスキップ
      }
    }

    window.addEventListener("message", (e: MessageEvent) => {
      if (e.source !== window) return;
      if (!isToPageMessage(e.data)) return;
      handleCommand(e.data.cmd);
    });

    function handleCommand(cmd: PageCommand): void {
      // 高頻度コマンドは status を撒かない（早期 return）。
      if (cmd.type === "set-remote-rects") {
        state.remoteRects = cmd.rects;
        return;
      }
      if (cmd.type === "set-shared-live") {
        state.sharedLive = cmd.live;
        return;
      }

      switch (cmd.type) {
        case "set-enabled":
          state.enabled = cmd.enabled;
          break;
        case "toggle-enabled":
          state.enabled = !state.enabled;
          break;
        case "set-force-all":
          state.forceAll = cmd.forceAll;
          break;
        case "toggle-force-all":
          state.forceAll = !state.forceAll;
          break;
        case "set-style":
          state.style = cmd.style;
          if (typeof cmd.blurPx === "number") state.blurPx = cmd.blurPx;
          break;
        case "add-selector":
          state.selectors.add(cmd.selector);
          updatePublishing();
          break;
        case "remove-selector":
          state.selectors.delete(cmd.selector);
          updatePublishing();
          break;
        case "set-selectors":
          state.selectors = new Set(cmd.selectors);
          updatePublishing();
          break;
        case "clear-selectors":
          state.selectors.clear();
          updatePublishing();
          break;
        case "run-detection": {
          // 手動検知。以降の自動再検知を arm し、今回は強制実行する。
          armAutoDetect(cmd.includeImage);
          emitDetect(true);
          break;
        }
        case "set-auto-selectors":
          // 最新の検知に対する結果だけ採用（順序逆転で古い結果が新ページに乗るのを防ぐ）。
          if (cmd.id !== lastEmittedDetectId) break;
          state.autoSelectors = new Set(cmd.selectors);
          updatePublishing();
          break;
        case "clear-auto-selectors":
          state.autoSelectors.clear();
          updatePublishing();
          break;
        case "get-status":
          break;
      }
      emitStatus();
    }

    // ---- クロスタブ: このタブ(共有される側)の機密 rect を publish する ----
    function computeNormalizedRects(): NormRect[] {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const out: NormRect[] = [];
      for (const sel of new Set([...state.selectors, ...state.autoSelectors])) {
        let els: NodeListOf<Element>;
        try {
          els = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (!isRectInViewport(r, vw, vh)) continue;
          const n = toNormalizedRect(r, vw, vh);
          if (n) out.push(n);
        }
      }
      return out;
    }

    function isArmed(): boolean {
      return state.selectors.size > 0 || state.autoSelectors.size > 0;
    }

    // 直前に publish した内容の JSON。変化したときだけ送る（churn 抑制 + 空配信漏れ防止）。
    let lastPublishedJson = "";
    function publishRects(): void {
      const armed = isArmed();
      const rects = computeNormalizedRects();
      const json = JSON.stringify({ armed, rects });
      if (json === lastPublishedJson) return; // 変化が無ければ送らない
      lastPublishedJson = json;
      emit({ type: "publish-rects", rects, armed });
    }

    const schedulePublish = throttle(publishRects, 120);
    let publishTick: number | null = null;
    // 機密セレクタを持つ間だけ低頻度 tick を回す。無くなったら空を1回送って停止。
    function updatePublishing(): void {
      if (isArmed()) {
        publishRects();
        if (publishTick === null) {
          publishTick = window.setInterval(publishRects, 600);
        }
      } else {
        if (publishTick !== null) {
          clearInterval(publishTick);
          publishTick = null;
        }
        publishRects(); // 空を送って capturer 側のリモートマスクを消す
      }
    }

    // ---- AI 自動再検知 ----
    const LOCATION_EVENT = "nanoshield:locationchange";
    const HISTORY_PATCH_KEY = Symbol.for("nanoshield.historyPatched");

    // 検知ペイロードを送る。force でなければ DOM スナップショットが前回と同じなら送らない
    // （Nano の無駄打ちを防ぐ）。id を採番し、結果はこの id と一致するものだけ採用する。
    function emitDetect(force: boolean): void {
      const snapshot = collectDomSnapshot();
      if (!force && snapshot === lastDetectSnapshot) return;
      lastDetectSnapshot = snapshot;
      const dataUrl = autoIncludeImage ? sampleFrame() : null;
      lastEmittedDetectId = ++detectSeq;
      emit({ type: "detect-payload", snapshot, dataUrl, id: lastEmittedDetectId });
    }

    // 遷移/変化/操作が落ち着いてから、共有中(自タブ or 被共有)かつ可視のときだけ再検知する。
    // maxWait で「mutation が鳴り続けると永遠に発火しない(starvation)」を防ぐ。
    // 残存リスク: 機密が描画されてから検知完了までの数秒は未マスク（fail-open の窓・手動で即時化可）。
    const runAutoDetect = debounce(
      () => {
        if (!autoDetectArmed || document.hidden) return;
        if (!state.sharing && !state.sharedLive) return; // 共有中のときだけ Nano を起動
        emitDetect(false);
      },
      1000,
      4000,
    );

    // SPA 遷移: pushState/replaceState はイベントを出さないので一度だけパッチし、
    // 全インスタンスが拾える custom event を発火する（Symbol.for で page-global に二重パッチ防止）。
    function patchHistory(): void {
      const h = history as History & { [HISTORY_PATCH_KEY]?: true };
      if (h[HISTORY_PATCH_KEY]) return;
      Object.defineProperty(h, HISTORY_PATCH_KEY, { value: true });
      const fire = () => window.dispatchEvent(new Event(LOCATION_EVENT));
      const origPush = h.pushState;
      h.pushState = function (this: History, data, unused, url) {
        const ret = origPush.call(this, data, unused, url);
        fire();
        return ret;
      };
      const origReplace = h.replaceState;
      h.replaceState = function (this: History, data, unused, url) {
        const ret = origReplace.call(this, data, unused, url);
        fire();
        return ret;
      };
    }

    function armAutoDetect(includeImage: boolean): void {
      autoIncludeImage = includeImage;
      if (autoDetectArmed) return;
      autoDetectArmed = true;
      patchHistory();
      window.addEventListener(LOCATION_EVENT, runAutoDetect);
      window.addEventListener("popstate", runAutoDetect);
      window.addEventListener("hashchange", runAutoDetect);
      window.addEventListener("pageshow", runAutoDetect);
      // ユーザー操作。機密が「操作後に表示される」ケースに最も効く。
      window.addEventListener("click", runAutoDetect, { capture: true, passive: true });
      window.addEventListener("focusin", runAutoDetect, { passive: true });
      // 大きな DOM 変化。debounce(+maxWait) + スナップショット差分 + live ゲートで無駄打ちを抑える。
      if (domObserver === null && document.body) {
        domObserver = new MutationObserver(runAutoDetect);
        domObserver.observe(document.body, { childList: true, subtree: true });
      }
    }

    window.addEventListener("scroll", schedulePublish, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", schedulePublish, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      schedulePublish();
      runAutoDetect();
    });

    // ---- パイプライン ----
    interface Pipeline {
      outStream: MediaStream;
      stop: () => void;
      started: Promise<void>;
    }
    let pipeline: Pipeline | null = null;

    function startPipeline(srcStream: MediaStream): Pipeline {
      const videoTrack = srcStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("video track が見つかりません");
      const settings = videoTrack.getSettings();
      state.surface = settings.displaySurface ?? "unknown";

      const video = document.createElement("video");
      video.srcObject = new MediaStream([videoTrack]);
      video.muted = true;
      video.playsInline = true;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("2D コンテキストを取得できません");
      currentCanvas = canvas;

      const fps = Math.min(settings.frameRate ?? 30, 30);
      let rvfcHandle: number | null = null;
      let rafHandle: number | null = null;
      let running = true;

      function sizeToVideo(): void {
        if (
          video.videoWidth &&
          (canvas.width !== video.videoWidth ||
            canvas.height !== video.videoHeight)
        ) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
      }

      // 表示中の要素のマスク矩形(canvas ピクセル系)。
      // タブ共有時のみ、ビューポート/正規化座標 -> 映像ピクセルへマッピングできる。
      // fail-closed: ローカル DOM(自タブの機密) ∪ リモート(armed な他タブの rect) を常に適用する。
      //  - 自タブ共有: ローカルがこのタブ自身の機密を覆う。リモートは他に armed タブがあれば過剰側に乗るだけ。
      //  - 別タブ共有: リモートが共有される側の機密を覆う。ローカルはこのタブ(capturer)に機密が無ければ空。
      function maskRects(): Rect[] {
        if (state.surface !== "browser") return [];
        const rects: Rect[] = [];

        // (A) ローカル DOM: このタブ自身の機密要素（手動 + 自動）。
        const scaleX = canvas.width / window.innerWidth;
        const scaleY = canvas.height / window.innerHeight;
        for (const sel of new Set([...state.selectors, ...state.autoSelectors])) {
          let els: NodeListOf<Element>;
          try {
            els = document.querySelectorAll(sel);
          } catch {
            continue; // 不正なセレクタはスキップ
          }
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (!isRectInViewport(r, window.innerWidth, window.innerHeight)) {
              continue;
            }
            rects.push(scaleViewportRect(r, scaleX, scaleY));
          }
        }

        // (B) リモート: armed な他タブから届いた正規化 rect。
        for (const n of state.remoteRects) {
          rects.push(fromNormalizedRect(n, canvas.width, canvas.height));
        }
        return rects;
      }

      function applyMask(rc: Rect): void {
        const c = clampRectToCanvas(rc, canvas.width, canvas.height);
        if (!c) return;

        if (state.style === "black") {
          ctx!.fillStyle = "#000";
          ctx!.fillRect(c.x, c.y, c.w, c.h);
          return;
        }
        // blur: 対象領域だけクリップしてぼかしフィルタで映像を再描画
        ctx!.save();
        ctx!.filter = `blur(${state.blurPx}px)`;
        ctx!.beginPath();
        ctx!.rect(c.x, c.y, c.w, c.h);
        ctx!.clip();
        ctx!.drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx!.restore();
      }

      function drawFrame(): void {
        if (!running) return;
        sizeToVideo();
        if (canvas.width && canvas.height) {
          ctx!.filter = "none";
          ctx!.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (state.enabled) {
            if (state.forceAll) {
              applyMask({ x: 0, y: 0, w: canvas.width, h: canvas.height });
            } else {
              for (const rc of maskRects()) applyMask(rc);
            }
          }
        }
        scheduleNext();
      }

      function scheduleNext(): void {
        if (!running) return;
        if (typeof video.requestVideoFrameCallback === "function") {
          rvfcHandle = video.requestVideoFrameCallback(drawFrame);
        } else {
          rafHandle = requestAnimationFrame(drawFrame);
        }
      }

      const outStream = canvas.captureStream(fps);
      for (const audio of srcStream.getAudioTracks()) outStream.addTrack(audio);

      function stop(): void {
        running = false;
        if (rvfcHandle !== null && video.cancelVideoFrameCallback) {
          video.cancelVideoFrameCallback(rvfcHandle);
        }
        if (rafHandle !== null) cancelAnimationFrame(rafHandle);
        for (const t of outStream.getVideoTracks()) t.stop();
        // 元のキャプチャ stream も停止する。パイプライン差し替え時に古い capture
        // セッション/音声トラックが生き残るのを防ぐ。
        for (const t of srcStream.getTracks()) t.stop();
        video.srcObject = null;
        if (currentCanvas === canvas) currentCanvas = null;
      }

      // ユーザーがブラウザUIから共有停止 -> 元トラックが ended -> 後始末
      videoTrack.addEventListener("ended", () => {
        state.sharing = false;
        state.remoteRects = []; // 共有終了でリモートマスクを破棄
        stop();
        emit({ type: "share-ended" });
        emitStatus();
      });

      const started = video
        .play()
        .then(() => {
          sizeToVideo();
          scheduleNext();
        })
        .catch((err: unknown) => {
          stop();
          throw new Error(`video.play failed: ${String(err)}`);
        });

      return { outStream, stop, started };
    }

    // ---- getDisplayMedia 差し替え ----
    const md = navigator.mediaDevices;
    if (md && typeof md.getDisplayMedia === "function") {
      const original = md.getDisplayMedia.bind(md);

      md.getDisplayMedia = async function (
        constraints?: DisplayMediaStreamOptions,
      ): Promise<MediaStream> {
        const srcStream = await original(constraints);

        // 音声のみ共有(画面トラックなし)はそのまま通す
        if (srcStream.getVideoTracks().length === 0) return srcStream;

        try {
          if (pipeline) pipeline.stop();
          pipeline = startPipeline(srcStream);
          await pipeline.started; // play 失敗ならここで throw
          state.sharing = true;
          emit({ type: "share-started", surface: state.surface ?? "unknown" });
          emitStatus();
          if (state.surface !== "browser") {
            emit({
              type: "warning",
              code: "non-tab-surface",
              surface: state.surface ?? "unknown",
              message:
                "タブ共有以外では要素単位のマスクはできません。緊急の全面マスクのみ有効です。",
            });
          }
          return pipeline.outStream;
        } catch (err) {
          // fail-closed: 生 stream は返さず共有を失敗させる
          for (const t of srcStream.getTracks()) t.stop();
          state.sharing = false;
          emit({ type: "error", where: "startPipeline", message: String(err) });
          emitStatus();
          throw err;
        }
      };

      emit({ type: "ready" });
      // bridge(ISOLATED) が後にロードして 'ready' を取りこぼす競合に備え、もう一度送る
      setTimeout(() => emit({ type: "ready" }), 0);
    } else {
      emit({
        type: "error",
        where: "init",
        message: "getDisplayMedia が見つかりません",
      });
    }
  },
});
