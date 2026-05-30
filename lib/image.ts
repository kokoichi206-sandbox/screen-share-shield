// 画像縮小サイズの計算（純関数）。長辺を maxEdge 以下に収めつつアスペクト比を保つ。
// 段階2の canvas フレームを縮小して dataURL 化する際に使う。

export interface Size {
  width: number;
  height: number;
}

export function computeDownscaleSize(
  w: number,
  h: number,
  maxEdge: number,
): Size {
  if (w <= 0 || h <= 0 || maxEdge <= 0) return { width: 0, height: 0 };
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: Math.round(w), height: Math.round(h) };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}
