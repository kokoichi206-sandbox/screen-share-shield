// マスク矩形の座標計算（純関数）。DOM/canvas に依存しないので単体テストできる。
// 役割: ビューポート座標(getBoundingClientRect)を映像(canvas)ピクセルへ写像し、
//       描画可能な範囲にクランプする。

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ビューポート比(0..1)で表したマスク矩形。タブ間を解像度非依存で運ぶための表現。
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// getBoundingClientRect 互換の最小形。
export interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

// 要素がビューポート内に少しでも見えているか。
// 自タブ共有では「ビューポートに映っているもの = 共有フレームに映るもの」なので、
// 画面外の要素はマスク対象から外してよい。
export function isRectInViewport(
  r: ViewportRect,
  viewportW: number,
  viewportH: number,
): boolean {
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.bottom < 0 || r.top > viewportH || r.right < 0 || r.left > viewportW) {
    return false;
  }
  return true;
}

// ビューポート座標 -> canvas(映像)ピクセル矩形。
// scale は canvas.width / window.innerWidth 等。DPR は scale に織り込まれている前提。
export function scaleViewportRect(
  r: Pick<ViewportRect, "left" | "top" | "width" | "height">,
  scaleX: number,
  scaleY: number,
): Rect {
  return {
    x: r.left * scaleX,
    y: r.top * scaleY,
    w: r.width * scaleX,
    h: r.height * scaleY,
  };
}

// canvas 範囲にクランプし整数化する。描画不能(面積0以下)なら null。
export function clampRectToCanvas(
  r: Rect,
  canvasW: number,
  canvasH: number,
): Rect | null {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.min(canvasW - x, Math.ceil(r.w));
  const h = Math.min(canvasH - y, Math.ceil(r.h));
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

// ビューポート座標 -> 正規化(0..1)。ビューポート外にはみ出す分はクランプ。
// クロスタブ共有で「共有される側」が自分の機密 rect を解像度非依存で送るのに使う。
export function toNormalizedRect(
  r: ViewportRect,
  viewportW: number,
  viewportH: number,
): NormRect | null {
  if (viewportW <= 0 || viewportH <= 0) return null;
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(viewportW, r.right);
  const bottom = Math.min(viewportH, r.bottom);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  return { x: left / viewportW, y: top / viewportH, w: w / viewportW, h: h / viewportH };
}

// 正規化(0..1) -> canvas ピクセル。「共有元」がキャプチャ映像へ適用するのに使う。
// キャプチャ映像 = 共有される側のビューポートそのものなので、比がそのまま乗る。
export function fromNormalizedRect(
  n: NormRect,
  canvasW: number,
  canvasH: number,
): Rect {
  return { x: n.x * canvasW, y: n.y * canvasH, w: n.w * canvasW, h: n.h * canvasH };
}

// ビューポートの大半を覆う rect（#root 等のページ全体コンテナ）を「広すぎる」と判定する。
// 機密フィールドは画面の一部なので、可視部分の面積が viewport 面積の maxAreaRatio 以上なら true。
// AI 検知が誤ってページ全体を選んでも、これで全面マスク化を防ぐ。
export function isRectTooBroad(
  r: ViewportRect,
  viewportW: number,
  viewportH: number,
  maxAreaRatio = 0.8,
): boolean {
  if (viewportW <= 0 || viewportH <= 0) return false;
  const w = Math.min(r.right, viewportW) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, viewportH) - Math.max(r.top, 0);
  if (w <= 0 || h <= 0) return false;
  return w * h >= maxAreaRatio * viewportW * viewportH;
}
