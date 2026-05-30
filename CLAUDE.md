# CLAUDE.md — Screen Share Shield 開発・アーキテクチャ

開発者（および Claude）向けの内部設計ドキュメント。ユーザー向けの説明は [README.md](./README.md) / [README.ja.md](./README.ja.md)。

TypeScript + [WXT](https://wxt.dev)（Vite ベースの Chrome 拡張フレームワーク）で構築。パッケージ管理は pnpm。

## 開発コマンド

```sh
pnpm install        # 依存導入（postinstall で wxt prepare が走り型を生成）
pnpm dev            # .output/chrome-mv3 を自動リロード付きで生成
pnpm compile        # tsc --noEmit による型検査
pnpm test           # vitest（純粋ロジックの単体テスト）
pnpm check          # prepare + tsc + test + build を一括実行
pnpm build          # 本番ビルド（.output/chrome-mv3）
pnpm zip            # 配布用 zip
```

ビルド出力は `.output/chrome-mv3`。`chrome://extensions/` の「パッケージ化されていない拡張機能を読み込む」で指定する。

## 仕組み（コア）

`navigator.mediaDevices.getDisplayMedia` を差し替え、返ってきた映像を `<canvas>` で
1フレームずつ加工してマスクをかけ、加工後の `MediaStream` をアプリ(Meet / Zoom 等)へ返す。

```
getDisplayMedia()
  └─ 元stream ──▶ <video>(非表示) ──▶ <canvas> 描画 + マスク ──▶ canvas.captureStream()
                                                                      └─▶ アプリへ返す(=相手に届く)
```

アプリに渡るのは加工後 stream。相手の映像とアプリ内のセルフプレビューはマスクされ、マスクされないのは
「実際に作業している本物のタブ画面」だけ。

## world / プロセス構成

| 実行場所 | 役割 | 制約 |
| --- | --- | --- |
| `entrypoints/inject.content.ts` (MAIN world) | `getDisplayMedia` 差し替え + canvas 加工 + DOM/フレーム収集 + 自動再検知 | `chrome.*` 不可 |
| `entrypoints/bridge.content.ts` (ISOLATED world) | inject ↔ 拡張側のメッセージ中継 + 設定永続化 | `getDisplayMedia` 差し替え不可 |
| `entrypoints/background.ts` (service worker) | ホットキー転送 + Gemini Nano 実行 + クロスタブ rect 集約 | DOM 無し |

- inject ↔ bridge: `window.postMessage` の名前空間付きエンベロープ（`channel: "screen-share-shield"`）。
- bridge ↔ background/popup: `chrome.runtime` / `chrome.tabs` メッセージ。
- 全メッセージは `lib/messages.ts` の判別共用体（discriminated union）で型付け。

> 注: WXT の `browser` はネイティブ `chrome` そのもの（polyfill 無し）。ネイティブ Chrome の
> `onMessage` は Promise 返却での非同期応答に非対応なので、background は `sendResponse + return true` を使う。

## 主要な設計方針

- **fail-closed**: パイプライン構築に失敗したら、加工前の生 stream は返さず例外を投げる。共有自体は失敗するが
  機密が無加工で漏れることはない。検知エラー時も既存の自動マスクは外さない。
- **暗黙 fallback 禁止**: Nano 利用不可 / モデル未DL / 段階失敗は popup に明示。空配列で握りつぶさない。
- **コントラクト層を厳密に**: メッセージは判別共用体で型付けし、純粋ロジックは `lib/` に分離して単体テストする。

## AI 検知 (Gemini Nano)

オンデバイスの Prompt API (`self.LanguageModel`) で機密要素を 2 段階検知し、マスク対象セレクタを得る。
拡張 service worker は origin trial 不要で利用できる唯一のコンテキストなので、Nano は background に集約する。

```
popup「今すぐ検知」
  └─ run-detection ─▶ inject: DOM スナップショット + (任意で)縮小フレームdataURL を収集
        └─ detect-payload ─▶ bridge ─ runtime ─▶ background
              段階1: DOMテキスト  ─▶ Nano(responseConstraint) ─▶ セレクタ
              段階2: フレーム画像  ─▶ Nano(マルチモーダル)      ─▶ セレクタ
              └─ union ─▶ bridge ─▶ inject(set-auto-selectors / 手動分とは別枠)
```

- 構造化出力（`responseConstraint`）で `{selectors: string[]}` を強制し、`parseSelectorResponse` で安全網
  （注釈混入セレクタの刈り取り、素の汎用タグ・SPA ルート id(`#root` 等)の除外）。
- 画像段階は縮小フレームの dataURL があるときだけ走る（無ければ `skipped` と明示）。
- **過剰選択ゲート**: Nano がページ全体コンテナ(`#root` 等)を返しても、ビューポートの大半を覆う rect は
  実行時に弾く（`isRectTooBroad`、自動検知のみ・手動は尊重）。全面マスク化を防ぐ。

### 自動再検知

「今すぐ検知」を一度押すとそのタブが arm され、以降は内容変化に追従して自動で再検知する。

- **トリガ（すべて ~1秒 debounce / maxWait 付き）**: SPA 遷移（`pushState`/`replaceState` はパッチして拾う、
  `popstate`/`hashchange`）、`pageshow`、可視化、大きな DOM 変化（MutationObserver）、ユーザー操作（click/focus）。
- **共有中のときだけ**実行（自タブ共有 or background が live と通知した被共有タブ）かつ**可視時のみ**。
  非共有の通常ブラウジングでは Nano を起動しない。
- **DOM スナップショットが前回と変わった時だけ** Nano を呼ぶ。`maxWait` で連続変化時の starvation を防止。
  検知結果は id 照合で最新のみ採用（順序逆転防止）。
- **残存リスク（fail-open の窓）**: 機密が描画されてから再検知が完了するまでの数秒は未マスク。
  操作後に表示されるタイプならギャップは小さいが、初期HTMLインライン機密では見えうる。手動検知 or 全面マスクで補う。

## クロスタブ協調（別タブ共有時の要素マスク）

`getDisplayMedia` を呼ぶ document（meet.google.com）と共有される surface（別タブ）は別物で、
ブラウザはプライバシー上「どのタブを共有したか」を呼び出し元に教えない。そこで全タブで協調する:

```
armed な各タブ inject: 自分の機密要素を正規化座標(0..1)で publish
  └─ bridge ─ runtime ─▶ background(タブ毎の rect + armed を集約)
共有元(capturer) inject: subscribe ◀─ set-remote-rects(armed な全タブの rect 集約) ─┘
  └─ 加工パイプラインが ローカル DOM ∪ リモート rect を「正規化 × フレーム寸法」で適用
```

| シナリオ | 要素単位マスク | 緊急の全面マスク |
| --- | --- | --- |
| 自タブ共有（`preferCurrentTab`） | 可能（ローカル DOM・遅延ゼロ） | 可能 |
| Meet 等で別タブを共有 | 可能（クロスタブ協調） | 可能 |
| ウィンドウ / 画面全体 | 不可(DOM→映像の座標対応が取れない) | 可能 |

- **fail-closed な対応付け**: source を1つに賭けず、armed な全タブ(自分以外)の rect を配り、capturer は
  ローカル∪リモートを当てる。単一の機密タブ運用なら過不足なし、複数同時だと過剰マスク（安全側の劣化）。
- **arm が必要**: 共有される側のタブに手動セレクタを入れる or「今すぐ検知」を走らせて初めて rect が publish される。
- background は「自分以外の capturer がいる armed タブ」を live として各 source に通知し、live のときだけ自動再検知させる。
- `displaySurface` がタブ以外のときは popup に警告（黙って劣化させない）。

## プライバシー上の既知の制約（MAIN world の宿命）

`getDisplayMedia` を差し替えるには inject が MAIN world（ページ自身の JS 文脈）に居る必要がある。
このため inject ↔ bridge 間の `window.postMessage` はそのページの JS から観測・偽造され得る:

- inject が出す `detect-payload`（自ページのスクショ/DOM スナップショット）は**そのページ自身の window** に出るだけ。
  ページは元々自分の中身に full access を持つので新規の漏洩ではない。
- 新たに増える流れは「共有される側の rect 座標が共有元へ渡る」点のみ（位置情報のみ・中身なし・低リスク）。
- 悪意ページが偽コマンドでマスクを無効化し得るが、攻撃者が得をする筋ではない（自分のページの話）。

完全な隔離には MAIN world を使わない設計が必要だが、それでは `getDisplayMedia` 差し替えが成立しない。トレードオフとして受容。

## ファイル構成

```
wxt.config.ts          manifest 定義 + WXT 設定
tsconfig.json          strict（noUncheckedIndexedAccess 等を追加）
vitest.config.ts       テスト設定（@/ エイリアス解決）
types/
  prompt-api.d.ts      LanguageModel(Prompt API) のアンビエント型
lib/                   DOM/Chrome 非依存の純粋ロジック（単体テスト対象）
  messages.ts          メッセージ契約（判別共用体）。全エントリ共通のコントラクト層
  masking.ts           座標マッピング / クランプ / 正規化 / 過剰選択ゲート(クロスタブ)
  image.ts             フレーム縮小サイズ計算
  dom-snapshot.ts      DOM スナップショット整形
  nano-parse.ts        Nano 応答のセレクタ抽出（安全網・注釈刈り取り・広すぎる除外）
  nano-detect.ts       Nano 2段階検知のオーケストレーション（純粋部分 + SW 実行部分）
entrypoints/
  inject.content.ts    MAIN world: getDisplayMedia 差し替え + canvas 加工 + DOM/フレーム収集 + 自動再検知
  bridge.content.ts    ISOLATED world: メッセージ中継 + 設定永続化
  background.ts        ホットキー中継 + Nano 実行 + クロスタブ rect 集約(service worker)
  popup/
    index.html / main.ts / style.css
tests/                 vitest（純粋ロジック）
docs/                  README 用スクリーンショット
public/
  icon-128.png
```

## テスト方針

- 単体テストは DOM/Chrome 非依存の**純粋ロジック**を対象（座標/正規化/縮小/過剰選択ゲート/DOM整形/応答パース/検知のエラー方針/メッセージ型ガード）。
- 自動再検知やクロスタブの結線はイベント/DOM/タイミング駆動のため、ビルド + 後述の手動確認で担保する。

### Gemini Nano の手動確認

オンデバイス Nano は対応 Chrome・ハード要件・モデルDLが必要で、自動テストでは検証できない。

1. `chrome://on-device-internals`（または `chrome://components`）でモデル状態を確認。
2. service worker コンソールで `await LanguageModel.availability({expectedInputs:[{type:'text'}]})` が
   `'available'` / `'downloadable'` 等を返すか確認。
3. popup「モデルを有効化」でDL → 「今すぐ検知」→ 検知一覧にセレクタが出るか確認。

### クロスタブの手動確認

1. 機密が載るタブ（例: 決済ページ・ログイン画面）で「今すぐ検知」して arm する。
2. 別タブの Meet/Zoom で「Chrome タブ」共有 → そのタブを選ぶ。
3. 相手側で検知された要素がマスクされるか確認。
4. 拡張をリロードしたら関係タブ（共有元・共有先）も必ずリロードする（孤児 content script 対策）。
