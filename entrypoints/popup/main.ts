import {
  CHANNEL,
  DEFAULT_SETTINGS,
  type NanoAvailabilityResponse,
  type NanoDownloadResponse,
  type NanoReport,
  type NanoState,
  type PageCommand,
  type QueryStatusResponse,
  type RuntimeMessage,
  type Settings,
  type ShareStatus,
} from "@/lib/messages";

// UI。アクティブタブの bridge とやり取りし、設定を storage に保存する。
// 設定の真実は storage(settings)。popup は storage を更新しつつ、即時反映のため bridge にも送る。
// Nano 関連(availability/download)は background に runtime メッセージで直接問い合わせる。

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} が見つかりません`);
  return el as T;
}

const els = {
  shareState: byId<HTMLSpanElement>("share-state"),
  warning: byId<HTMLParagraphElement>("warning"),
  enabled: byId<HTMLInputElement>("enabled"),
  forceAll: byId<HTMLInputElement>("force-all"),
  style: byId<HTMLSelectElement>("style"),
  blurRow: byId<HTMLDivElement>("blur-row"),
  blur: byId<HTMLInputElement>("blur"),
  blurVal: byId<HTMLSpanElement>("blur-val"),
  selectorInput: byId<HTMLInputElement>("selector-input"),
  addSelector: byId<HTMLButtonElement>("add-selector"),
  selectorList: byId<HTMLUListElement>("selector-list"),
  imageStage: byId<HTMLInputElement>("image-stage"),
  enableNano: byId<HTMLButtonElement>("enable-nano"),
  runDetect: byId<HTMLButtonElement>("run-detect"),
  nanoState: byId<HTMLParagraphElement>("nano-state"),
  detectResult: byId<HTMLParagraphElement>("detect-result"),
  autoSelectorList: byId<HTMLUListElement>("auto-selector-list"),
};

let settings: Settings = { ...DEFAULT_SETTINGS };

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function sendCommand(cmd: PageCommand): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId == null) return;
  const message: RuntimeMessage = { channel: CHANNEL, kind: "command", cmd };
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch {
    // content 未注入のタブ
  }
}

async function queryStatus(): Promise<QueryStatusResponse | null> {
  const tabId = await getActiveTabId();
  if (tabId == null) return null;
  const message: RuntimeMessage = { channel: CHANNEL, kind: "query-status" };
  try {
    return (await browser.tabs.sendMessage(
      tabId,
      message,
    )) as QueryStatusResponse;
  } catch {
    return null;
  }
}

async function saveSettings(): Promise<void> {
  await browser.storage.local.set({ settings });
}

// --- 描画 ---
function render(): void {
  els.enabled.checked = settings.enabled;
  els.style.value = settings.style;
  els.blur.value = String(settings.blurPx);
  els.blurVal.textContent = `${settings.blurPx}px`;
  els.blurRow.classList.toggle("hidden", settings.style !== "blur");
  els.imageStage.checked = settings.imageStage;
  renderSelectors();
}

function renderSelectors(): void {
  els.selectorList.replaceChildren();
  for (const sel of settings.selectors) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = sel;
    const del = document.createElement("button");
    del.textContent = "×";
    del.className = "del";
    del.addEventListener("click", () => void removeSelector(sel));
    li.append(code, del);
    els.selectorList.append(li);
  }
}

// Nano が検知したセレクタ一覧を表示（手動分と区別して「AI が何を選んだか」を可視化）。
function renderAutoSelectors(autoSelectors: string[] | undefined): void {
  els.autoSelectorList.replaceChildren();
  if (!autoSelectors || autoSelectors.length === 0) {
    const li = document.createElement("li");
    li.className = "muted-line";
    li.textContent = "（まだ無し）";
    els.autoSelectorList.append(li);
    return;
  }
  for (const sel of autoSelectors) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = sel;
    li.append(code);
    els.autoSelectorList.append(li);
  }
}

function renderStatus(status: ShareStatus | null): void {
  if (!status || !status.sharing) {
    els.shareState.textContent = "未共有";
    els.shareState.className = "badge badge-idle";
    els.warning.classList.add("hidden");
    if (status) els.forceAll.checked = status.forceAll;
    return;
  }
  els.shareState.textContent =
    status.surface === "browser" ? "タブ共有中" : `共有中 (${status.surface})`;
  els.shareState.className = "badge badge-live";
  els.forceAll.checked = status.forceAll;

  if (status.surface && status.surface !== "browser") {
    els.warning.textContent =
      "タブ共有以外では要素マスクは効きません。緊急の全面マスクのみ有効です。";
    els.warning.classList.remove("hidden");
  } else {
    els.warning.classList.add("hidden");
  }
}

const AVAILABILITY_LABEL: Record<NanoState, string> = {
  available: "利用可",
  downloadable: "未DL(有効化が必要)",
  downloading: "ダウンロード中",
  unavailable: "利用不可",
};

function renderNanoAvailability(a: NanoAvailabilityResponse): void {
  els.nanoState.textContent = `テキスト: ${AVAILABILITY_LABEL[a.text]} / 画像: ${AVAILABILITY_LABEL[a.image]}`;
  // DL が必要なときだけ有効化ボタンを目立たせる
  els.enableNano.disabled = a.text === "available" || a.text === "unavailable";
}

function renderNanoReport(report: NanoReport | null, autoCount: number): void {
  if (!report) {
    els.detectResult.textContent =
      autoCount > 0 ? `自動検知: ${autoCount}件適用中` : "";
    return;
  }
  // 検知失敗時はマスクを維持する設計。0件適用と誤解させないよう明示する。
  if (!report.ran || report.error) {
    const why = report.error ?? AVAILABILITY_LABEL[report.availability];
    els.detectResult.textContent = `検知失敗: ${why}（既存マスクは維持）`;
    return;
  }
  // 画像を実際に使えたか/使わなかった理由を必ず明示する（暗黙 fallback 禁止）。
  const image = report.image.used
    ? "画像: 使用"
    : `画像: 不使用(${report.image.reason ?? "理由不明"})`;
  els.detectResult.textContent = `自動検知: ${report.count}件適用 / ${image}`;
}

// --- 操作ハンドラ ---
els.enabled.addEventListener("change", () => {
  settings.enabled = els.enabled.checked;
  void saveSettings();
  void sendCommand({ type: "set-enabled", enabled: settings.enabled });
});

els.forceAll.addEventListener("change", () => {
  void sendCommand({ type: "set-force-all", forceAll: els.forceAll.checked });
});

els.style.addEventListener("change", () => {
  const style = els.style.value === "black" ? "black" : "blur";
  settings.style = style;
  els.blurRow.classList.toggle("hidden", style !== "blur");
  void saveSettings();
  void sendCommand({ type: "set-style", style, blurPx: settings.blurPx });
});

els.blur.addEventListener("input", () => {
  els.blurVal.textContent = `${els.blur.value}px`;
});
els.blur.addEventListener("change", () => {
  settings.blurPx = Number(els.blur.value);
  void saveSettings();
  void sendCommand({
    type: "set-style",
    style: settings.style,
    blurPx: settings.blurPx,
  });
});

els.addSelector.addEventListener("click", () => void addSelectorFromInput());
els.selectorInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void addSelectorFromInput();
});

els.imageStage.addEventListener("change", () => {
  settings.imageStage = els.imageStage.checked;
  void saveSettings();
});

els.enableNano.addEventListener("click", () => void enableNano());
els.runDetect.addEventListener("click", () => void runDetect());

async function addSelectorFromInput(): Promise<void> {
  const sel = els.selectorInput.value.trim();
  if (!sel || settings.selectors.includes(sel)) return;
  settings.selectors.push(sel);
  els.selectorInput.value = "";
  renderSelectors();
  await saveSettings();
  await sendCommand({ type: "add-selector", selector: sel });
}

async function removeSelector(sel: string): Promise<void> {
  settings.selectors = settings.selectors.filter((s) => s !== sel);
  renderSelectors();
  await saveSettings();
  await sendCommand({ type: "remove-selector", selector: sel });
}

async function checkNano(): Promise<void> {
  try {
    const a = (await browser.runtime.sendMessage({
      channel: CHANNEL,
      kind: "nano-availability",
    })) as NanoAvailabilityResponse;
    renderNanoAvailability(a);
  } catch (e) {
    els.nanoState.textContent = `状態取得に失敗: ${String(e)}`;
  }
}

async function enableNano(): Promise<void> {
  els.enableNano.disabled = true;
  els.nanoState.textContent = "モデルを準備中…（初回は時間がかかります）";
  try {
    const r = (await browser.runtime.sendMessage({
      channel: CHANNEL,
      kind: "nano-download",
    })) as NanoDownloadResponse;
    if (r.error) {
      els.nanoState.textContent = `有効化に失敗: ${r.error}`;
    } else {
      els.nanoState.textContent = `モデル状態: ${AVAILABILITY_LABEL[r.availability]}`;
    }
  } catch (e) {
    els.nanoState.textContent = `有効化に失敗: ${String(e)}`;
  } finally {
    await checkNano();
  }
}

async function runDetect(): Promise<void> {
  els.runDetect.disabled = true;
  els.detectResult.textContent = "検知中…";
  try {
    // bridge は run-detection 受信時に lastNanoReport を null にする(検知中)。
    // そのため null = 進行中、非 null = 新しい結果、と判定できる(stale read を回避)。
    await sendCommand({
      type: "run-detection",
      includeImage: settings.imageStage,
    });
    // 結果は inject->bridge->background->bridge と非同期に反映される。
    // 初回はモデル準備でかなり遅い場合があるので最大 ~60秒待ち、経過秒を見せる。
    for (let i = 0; i < 60; i++) {
      await delay(1000);
      els.detectResult.textContent = `検知中…（${i + 1}秒）初回はモデル準備で時間がかかります`;
      const res = await queryStatus();
      if (res?.nano) {
        renderStatus(res.status);
        renderNanoReport(res.nano, res.status?.autoSelectors.length ?? 0);
        renderAutoSelectors(res.status?.autoSelectors);
        return;
      }
    }
    els.detectResult.textContent =
      "時間内に結果が返りませんでした。SW コンソールのログを確認するか、もう一度お試しください（2回目以降は速くなります）。";
  } finally {
    els.runDetect.disabled = false;
  }
}

// --- 初期化 ---
async function init(): Promise<void> {
  const stored = await browser.storage.local.get("settings");
  const saved = stored.settings as Settings | undefined;
  settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  render();

  const res = await queryStatus();
  renderStatus(res?.status ?? null);
  renderNanoReport(res?.nano ?? null, res?.status?.autoSelectors.length ?? 0);
  renderAutoSelectors(res?.status?.autoSelectors);
  void checkNano();
}

void init();
