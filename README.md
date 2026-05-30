# NanoShield

画面共有中だけ、**相手に届く映像**に映る機密情報をマスクする Chrome 拡張。
自分が作業している本物の画面はそのまま、共有ストリームだけを加工する。

TypeScript + [WXT](https://wxt.dev) で構築。

## 仕組み

`navigator.mediaDevices.getDisplayMedia` を差し替え、返ってきた映像を `<canvas>` で
1フレームずつ加工してマスクをかけ、加工後の `MediaStream` をアプリ(Meet / Zoom 等)へ返す。

```
getDisplayMedia()
  └─ 元stream ──▶ <video>(非表示) ──▶ <canvas> 描画 + マスク ──▶ canvas.captureStream()
                                                                      └─▶ アプリへ返す(=相手に届く)
```

- 相手の映像と、アプリ内の自分のセルフプレビューはマスクされる。
- マスクされないのは「実際に作業している本物のタブ画面」だけ。

### world / プロセス構成

| 実行場所 | 役割 | 制約 |
| --- | --- | --- |
| `entrypoints/inject.content.ts` (MAIN world) | `getDisplayMedia` 差し替え + canvas 加工 + DOM/フレーム収集 | `chrome.*` 不可 |
| `entrypoints/bridge.content.ts` (ISOLATED world) | inject ↔ 拡張側のメッセージ中継 + 設定永続化 | `getDisplayMedia` 差し替え不可 |
| `entrypoints/background.ts` (service worker) | ホットキー転送 + Gemini Nano 実行 | DOM 無し |

- inject ↔ bridge: `window.postMessage` の名前空間付きエンベロープ。
- bridge ↔ background/popup: `chrome.runtime` / `chrome.tabs` メッセージ。
- 全メッセージは `lib/messages.ts` の判別共用体（discriminated union）で型付け。

> 注: WXT の `browser` はネイティブ `chrome` そのもの（polyfill 無し）。ネイティブ Chrome の
> `onMessage` は Promise 返却での非同期応答に非対応なので、background は `sendResponse + return true` を使う。

### AI 自動検知 (Phase 2 / Gemini Nano)

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

- 構造化出力（`responseConstraint`）で `{selectors: string[]}` を強制し、さらに `parseSelectorResponse` で安全網。
- 画像段階は縮小フレームの dataURL があるときだけ走る（無ければ `skipped` と明示）。
- **暗黙 fallback 禁止**: Nano 利用不可 / モデル未DL / 段階失敗はすべて popup に明示。空配列で握りつぶさない。
- **fail-closed**: 検知がエラーのときは既存の自動マスクを維持する（共有中に外さない）。

### クロスタブ協調（Meet/Zoom で別タブ共有時の要素マスク）

`getDisplayMedia` を呼ぶ document（meet.google.com）と、共有される surface（別タブの Gmail 等）は別物で、
ブラウザはプライバシー上「どのタブを共有したか」を呼び出し元に教えない。そこで全タブで協調する:

```
armed な各タブ inject: 自分の機密要素を正規化座標(0..1)で publish
  └─ bridge ─ runtime ─▶ background(タブ毎の rect + armed を集約)
共有元(capturer) inject: subscribe ◀─ set-remote-rects(armed な全タブの rect 集約) ─┘
  └─ 加工パイプラインが ローカル DOM ∪ リモート rect を「正規化 × フレーム寸法」で適用
```

| シナリオ | 要素単位マスク | 緊急の全面マスク |
| --- | --- | --- |
| 自タブ共有（`preferCurrentTab`） | **可能**（ローカル DOM・遅延ゼロ） | 可能 |
| Meet 等で別タブを共有 | **可能**（クロスタブ協調） | 可能 |
| ウィンドウ / 画面全体 | 不可(DOM→映像の座標対応が取れない) | 可能 |

- **fail-closed な対応付け**: ブラウザは「どのタブを映しているか」を教えないため、source を1つに賭けず
  **armed な全タブ(自分以外)の rect を配り、capturer は ローカル∪リモート を当てる**。
  単一の機密タブ運用なら過不足なし。**複数の機密タブが同時に開いていると過剰マスク（=安全側の劣化）**になる。
- **共有される側を arm する必要**: そのタブに手動セレクタを入れる or 「今すぐ検知」を走らせて初めて rect が publish される。
- スクロール等の変化はイベント＋低頻度 tick で追従するため、わずかな遅延が出る。
- `displaySurface` がタブ以外のときは popup に警告を出す（黙って劣化させない）。

### プライバシー上の既知の制約（MAIN world の宿命）

`getDisplayMedia` を差し替えるには inject が **MAIN world（＝ページ自身の JS 文脈）** に居る必要がある。
このため inject ↔ bridge 間の `window.postMessage` は**そのページの JS から観測・偽造され得る**:

- inject が出す `detect-payload`（自ページのスクショ/DOM スナップショット）は**そのページ自身の window** に出るだけ。
  ページは元々自分の中身に full access を持つので、これは新規の情報漏洩ではない。
- 新たに増える流れは「共有される側の rect 座標が共有元(meet)へ渡る」点のみ（位置情報のみ・中身は含まない、低リスク）。
- 悪意あるページが偽の `set-enabled:false` 等を送ってマスクを無効化し得るが、攻撃者が得をする筋ではない（自分のページの話）。

完全な隔離には MAIN world を使わない設計が必要だが、それでは `getDisplayMedia` 差し替えが成立しない。トレードオフとして受容している。

### 安全側の設計

パイプライン構築に失敗した場合、加工前の生 stream は **返さず例外を投げる**。
共有自体が失敗するが、機密情報がマスクなしで漏れることはない（fail-closed）。

## 開発

```sh
pnpm install        # 依存導入（postinstall で wxt prepare が走り型を生成）
pnpm dev            # .output/chrome-mv3 を自動リロード付きで生成
pnpm compile        # tsc --noEmit による型検査
pnpm test           # vitest（純粋ロジックの単体テスト）
pnpm check          # prepare + tsc + test + build を一括実行
pnpm build          # 本番ビルド
pnpm zip            # 配布用 zip
```

テスト対象（DOM/Chrome 非依存の純粋ロジック）: 座標マッピング(`lib/masking`)、
画像縮小(`lib/image`)、DOM整形(`lib/dom-snapshot`)、Nano応答パース(`lib/nano-parse`)、
検知オーケストレーションのエラー方針(`lib/nano-detect`)、メッセージ型ガード(`lib/messages`)。

## 導入（拡張の読み込み）

1. `pnpm build`（または `pnpm dev`）を実行
2. `chrome://extensions/` を開く
3. 右上「デベロッパーモード」を ON
4. 「パッケージ化されていない拡張機能を読み込む」→ **`.output/chrome-mv3`** を選択

## テスト手順（自タブ共有）

1. 適当なページ（例: 残高や ID を含む自分のダッシュボード）を開く
2. 拡張アイコンから popup を開き、「マスクする要素」に CSS セレクタを追加
   （例: `.balance`, `#email`）
3. 同じタブで画面共有を開始するアプリで **「Chrome タブ」** を選び、**このタブ** を共有
4. 相手側（または共有プレビュー）で対象要素がぼかし/黒塗りになることを確認
5. ホットキー `Ctrl+Shift+M` でマスクの ON/OFF、`Ctrl+Shift+K` で全面マスクを確認

### 単体での簡易確認（アプリ不要・自タブ共有）

対象ページの DevTools Console で以下を実行し、ピッカーで **このタブ** を選ぶと、
`getDisplayMedia` 経由の加工後映像（マスク済み）が右半分に重なって見える。

```js
const s = await navigator.mediaDevices.getDisplayMedia({
  video: true,
  preferCurrentTab: true, // 自タブ共有を優先
});
const v = Object.assign(document.createElement("video"), {
  srcObject: s, autoplay: true, style: "position:fixed;inset:0;z-index:99999;width:50vw",
});
document.body.append(v);
```

事前に popup でマスク対象セレクタ（例: `.balance`）を追加しておくと、
重なって見える加工後映像の該当箇所がぼかし/黒塗りになる。

## Gemini Nano の手動動作確認

オンデバイス Nano は対応 Chrome・ハード要件・モデルDLが必要で、自動テストでは検証できない。
実機では次を確認する:

1. `chrome://on-device-internals`（または `chrome://components`）でモデル状態を確認
2. 拡張の service worker コンソールで `await LanguageModel.availability({expectedInputs:[{type:'text'}]})` を実行し
   `'available'` / `'downloadable'` 等が返るか確認
3. popup「モデルを有効化」でDL → 「今すぐ検知」→ `detect-result` にセレクタ件数が出るか確認
4. 検知されたセレクタが自タブ共有中にマスクされるか確認

利用不可環境でも、手動セレクタ・全面マスク・ホットキーは従来通り動作する（AI 検知のみ無効）。

## ファイル構成

```
wxt.config.ts          manifest 定義 + WXT 設定
tsconfig.json          strict（noUncheckedIndexedAccess 等を追加）
vitest.config.ts       テスト設定（@/ エイリアス解決）
types/
  prompt-api.d.ts      LanguageModel(Prompt API) のアンビエント型
lib/                   DOM/Chrome 非依存の純粋ロジック（単体テスト対象）
  messages.ts          メッセージ契約（判別共用体）。全エントリ共通のコントラクト層
  masking.ts           座標マッピング / クランプ / 正規化(クロスタブ)
  image.ts             フレーム縮小サイズ計算
  dom-snapshot.ts      DOM スナップショット整形
  nano-parse.ts        Nano 応答のセレクタ抽出（安全網）
  nano-detect.ts       Nano 2段階検知のオーケストレーション（純粋部分 + SW 実行部分）
entrypoints/
  inject.content.ts    MAIN world: getDisplayMedia 差し替え + canvas 加工 + DOM/フレーム収集
  bridge.content.ts    ISOLATED world: メッセージ中継 + 設定永続化
  background.ts        ホットキー中継 + Nano 実行(service worker)
  popup/
    index.html / main.ts / style.css
tests/                 vitest（純粋ロジック）
public/
  icon-128.png
```

## Meet/Zoom での手動確認（クロスタブ）

1. Gmail 等の「共有される側」タブで、popup に機密要素のセレクタを追加（例 `span.bqe`）するか「今すぐ検知」で arm する
2. 別タブの Meet/Zoom で「タブを共有」→ その Gmail タブを選ぶ
3. 相手側（または共有プレビュー）で、arm した要素がマスクされるか確認
4. うまく対応付かない場合は「機密 rect を持つタブ」を1つに絞る（複数同時共有は対応付けが不安定）

## ロードマップ

- [x] Phase 1: 画面共有検知 + Stream 加工マスク + 手動セレクタ + ホットキー + UI
- [x] Phase 2: Gemini Nano による自動マスク対象検知（2段階: DOMテキスト → canvas フレーム画像）
- [x] クロスタブ協調（Meet/Zoom で別タブ共有時の要素マスク）
- [ ] Phase 3: 本格ブラウザエージェント（別プロジェクト）

### 既知の課題 / 将来

- クロスタブは「armed な全タブの rect を配る」fail-closed 方式。複数の機密タブが同時に開いていると過剰マスクになる。
- 検知の再実行トリガ（MutationObserver / 定期 re-scan）は未実装。現状は手動「今すぐ検知」のみ。
- 段階2の「視覚領域 → CSS セレクタ」推定精度は実測前提。
```
