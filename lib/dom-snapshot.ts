// DOM スナップショットの整形（純関数）。
// inject(MAIN) が DOM から候補要素のメタ情報を集め、ここで 1 行 1 要素のコンパクトな
// テキストに整形して Nano(段階1)へ渡す。DOM 走査自体は inject 側、整形ロジックはここ。

export interface ElementMeta {
  tag: string;
  id?: string;
  classes?: string[];
  role?: string;
  ariaLabel?: string;
  name?: string;
  inputType?: string;
  dataKeys?: string[];
  text?: string;
}

const MAX_TEXT = 80;
const MAX_CLASSES = 3;
const MAX_DATA_KEYS = 5;

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// 要素を一意に指しやすい CSS ヒント。id があれば #id、なければ tag + 先頭クラス。
export function cssHint(m: ElementMeta): string {
  if (m.id) return `#${m.id}`;
  const cls = (m.classes ?? [])
    .slice(0, MAX_CLASSES)
    .map((c) => `.${c}`)
    .join("");
  return m.tag + cls;
}

// 1 要素を 1 行のテキストに整形。
export function formatElementLine(m: ElementMeta): string {
  const parts: string[] = [cssHint(m)];
  if (m.role) parts.push(`role=${m.role}`);
  if (m.inputType) parts.push(`type=${m.inputType}`);
  if (m.name) parts.push(`name=${m.name}`);
  if (m.ariaLabel) parts.push(`aria="${truncate(m.ariaLabel, MAX_TEXT)}"`);
  if (m.dataKeys?.length) {
    parts.push(`data=[${m.dataKeys.slice(0, MAX_DATA_KEYS).join(",")}]`);
  }
  if (m.text) parts.push(`text="${truncate(m.text, MAX_TEXT)}"`);
  return parts.join(" ");
}

// 要素メタ配列を maxChars 以内のスナップショット文字列に整形する。
// 上限を超えたら以降を切り捨てる（contextWindow 超過を避ける）。
export function buildSnapshot(metas: ElementMeta[], maxChars: number): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of metas) {
    const line = formatElementLine(m);
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}
