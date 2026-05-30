// クロスタブ共有で「共有元(capturer)」がキャプチャしている surface に対応する
// 「共有される側(source)」のタブを推定する純関数。
//
// 原理的制約: ブラウザは「どのタブをキャプチャしたか」を呼び出し元に教えない。
// そのためヒューリスティックで対応付ける:
//  1) 候補 = armed(機密セレクタ保持) かつ capturer 自身でないタブ。
//     rect 数ではなく armed で見るのは、スクロールで機密要素が一時的に画面外でも
//     ソースを維持し、capturer がローカルマスクに切り替わってしまうのを防ぐため。
//  2) 候補が1つなら確定（= 機密タブを1つだけ共有、という想定で確実）。
//  3) 複数なら、キャプチャ映像のアスペクト比に最も近いソースを選び、同点は最新更新を優先。

export interface SourceEntry {
  tabId: number;
  armed: boolean; // 機密セレクタを持つか
  aspect: number | null; // source ビューポートの幅/高さ
  ts: number; // 最終更新の連番/時刻（外から渡す）
}

export function pickSourceTab(
  candidates: SourceEntry[],
  capturerTabId: number,
  captureAspect: number | null,
): number | null {
  const eligible = candidates.filter(
    (c) => c.tabId !== capturerTabId && c.armed,
  );
  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0]!.tabId;

  const scored = [...eligible].sort((a, b) => {
    if (captureAspect != null) {
      const da = a.aspect != null ? Math.abs(a.aspect - captureAspect) : Infinity;
      const db = b.aspect != null ? Math.abs(b.aspect - captureAspect) : Infinity;
      if (da !== db) return da - db;
    }
    return b.ts - a.ts; // 同点は最新を優先
  });
  return scored[0]!.tabId;
}
