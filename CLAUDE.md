# CLAUDE.md — Screen Share Shield

開発者（および Claude）向けの内部設計メモ。why と不変条件・gotcha のみ。導入・コマンドは README / package.json を参照。

## 踏み抜きやすい罠（先に読む）

- **WXT の `browser` はネイティブ `chrome` そのもの（polyfill 無し）**。ネイティブ Chrome の `onMessage` は
  Promise 返却での非同期応答に非対応なので、background は `sendResponse + return true` を使わざるを得ない。
- **MAIN world (`inject.content.ts`) では `chrome.*` / `browser.*` が使えない**。拡張側とのやり取りは
  bridge(ISOLATED world)経由で、inject ↔ bridge は `window.postMessage` の名前空間付きエンベロープ
  （`lib/messages.ts` の判別共用体で型付け）に限られる。`chrome.runtime` を触れるのは bridge と background だけ。
- **arm しないとクロスタブの rect は publish されない**。共有される側のタブに手動セレクタを入れるか
  「今すぐ検知」して初めて rect が出る。知らないと「別タブ共有でマスクされない」を不具合と誤認する。
- **拡張リロード時は関係タブ（共有元・共有先）も必ずリロード**。孤児 content script が残ると原因不明の挙動になる。

## 中心モデル

`navigator.mediaDevices.getDisplayMedia` を差し替え、元 stream を非表示 `<video>` → `<canvas>` で
1フレームずつ加工してマスクし、`canvas.captureStream()` の加工後 stream をアプリ（Meet/Zoom 等）へ返す。

```
getDisplayMedia()
  └ 元stream ─▶ <video>(非表示) ─▶ <canvas> 描画+マスク ─▶ canvas.captureStream() ─▶ アプリ(=相手)へ
```

肝は「相手に届くのは加工後 stream」という非対称性。相手の映像とアプリ内セルフプレビューはマスクされ、
無加工で見えるのは手元で操作している本物のタブ画面だけ。この差し替えが拡張全体の成立条件であり、
ゆえに inject は MAIN world（ページ自身の JS 文脈）に居る必要がある（下記トレードオフ）。

## 設計方針（why / 不変条件）

- **fail-closed**: 構築失敗時は生 stream を返さず例外を投げる。共有は失敗するが機密が無加工で漏れる事態を選ばない。検知エラー時も既存の自動マスクは外さない。
- **暗黙 fallback 禁止（契約）**: Nano 利用不可 / モデル未DL / 段階失敗は必ず popup に表面化させる。
  空配列や `skipped` / `unavailable` で握りつぶさない。
- **Nano は background(SW) に集約**: 拡張 service worker が origin trial 不要で `self.LanguageModel` を
  使える唯一のコンテキストだから。content 側へ移すと動かない。

## クロスタブ協調（別タブ共有時の要素マスク）

`getDisplayMedia` を呼ぶ document（meet.google.com）と共有される surface（別タブ）は別物で、ブラウザは
プライバシー上「どのタブを共有したか」を呼び出し元に教えない。そこで source を1つに賭けず、armed な全タブ
（自分以外）の rect を正規化座標で background 経由で配り、capturer は ローカル DOM ∪ リモート rect を当てる。

- **トレードオフ**: 単一の機密タブ運用なら過不足なし。複数同時 armed では過剰マスク（安全側の劣化として受容）。
- background は「自分以外の capturer がいる armed タブ」を live として通知し、live のときだけ自動再検知させる。
- `displaySurface` がタブ以外（ウィンドウ/画面全体）なら popup に警告し、黙って劣化させない。

マスク粒度の能力境界（要素 → 映像ピクセルの座標対応が正確なのは `displaySurface === "browser"` のときだけ）:

| 共有対象 | 要素単位マスク | 全面マスク |
| --- | --- | --- |
| 自タブ（`displaySurface === "browser"`） | 可（ローカル DOM・遅延ゼロ） | 可 |
| 別タブ（Chrome タブ共有） | 可（クロスタブ協調・要 arm） | 可 |
| ウィンドウ / 画面全体 | 不可（DOM → 映像の座標対応が取れない） | 可 |

## 受容した弱点・トレードオフ

- **自動再検知の fail-open の窓**: 機密が描画されてから再検知完了までの数秒は未マスク。操作後に出る型なら
  ギャップは小さいが、初期 HTML インライン機密は見えうる。原理的に残る穴で、手動検知 or 全面マスクで補う。
- **MAIN world の宿命**: 差し替えに MAIN が必須ゆえ inject ↔ bridge の `postMessage` はそのページ JS から
  観測・偽造され得る。ただし inject が出す DOM/フレームスナップショットは自ページの window に出るだけで、
  ページは元々自分の中身に full access を持つので新規漏洩ではない。新たに増える流れは「共有される側の rect
  座標が共有元へ渡る」点のみ（位置情報のみ・中身なし・低リスク）。完全隔離は差し替え不成立を意味するため受容。
- **過剰選択ゲート**: Nano がページ全体コンテナ（`#root` 等）を返しても、ビューポートの大半を覆う rect は実行時に弾く（自動検知のみ・手動は尊重）。全面マスク化の暴発を防ぐため。

## テスト戦略の線引き（why）

DOM/Chrome 非依存の純粋ロジックは `lib/` に分離して単体テストする。自動再検知・クロスタブの結線は
イベント/DOM/タイミング駆動でユニット化が困難なため、ビルド + 手動確認で担保する。Nano は対応 Chrome・
ハード要件・モデル DL が要るため自動テスト不能で、手動確認に回す。
