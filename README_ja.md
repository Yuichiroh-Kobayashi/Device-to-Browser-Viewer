# Device-to-Browser Viewer

[English](README.md)

このrepositoryには、性質の異なる2つのものが含まれています。読む・拡張する際は明確に区別してください。

1. **device-hosted product Viewer source lineage**(`src/product/p2-sp/`) —
   このlineageからqualifiedされたStudent / Professional release sourceが
   VAMeter-Edu安定版`v2.0.0`でリリースされました。deviceがそのrelease bundleを
   直接配信するため、PC・cloud account・relayは不要です。
   詳細は[device-hosted product Viewer](#device-hosted-product-viewer)を参照してください。
2. **development / validation harness**(このrepositoryのroot `index.html`、
   `src/`、`tools/serve.py`) — `d2b-stream/0.1`の`vi-measurement`処理を開発・
   検証するための、依存パッケージ不要でdeveloper-orientedなViewerです。
   synthetic生成、保存captureのreplay、任意endpointへの生Live WebSocket接続を
   持ちます。device-hosted product bundleではなく、これらdevelopment専用機能は
   意図的にproduct bundleから除外されています。詳細は
   [development / validation harness](#development--validation-harness)を
   参照してください。

## device-hosted product Viewer

Source: [`src/product/p2-sp/`](src/product/p2-sp/)。現在のdeployed-product contract:
[VAMeter-Edu device-hosted Viewer contract](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/blob/main/docs/product/device-hosted-viewer-contract.md)。
historical beta.1 contract:
[`docs/product/beta1-device-hosted-viewer-contract.md`](docs/product/beta1-device-hosted-viewer-contract.md)。
theme/colour presentation contract:
[`docs/product/theme-and-color-contract.md`](docs/product/theme-and-color-contract.md)。
source/build provenance:
[`docs/viewer-source-authority.md`](docs/viewer-source-authority.md)、
[`docs/provenance/`](docs/provenance/)。

2026-09-02に公開された安定版
[VAMeter-Edu `v2.0.0` release](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/releases/tag/v2.0.0)は、
次のexact Viewer authorityをdevice配信します。

- source commit `e1ebdb1cde8585a37447a66f4c8183654f4c3cda`
- source tree `8f8426e9af1649f68e66e4f8f432d1b91452e38d`
- bundle `4422530b6e1ba9549dd4bef2e3bb2c183d8fced49ed2d8d695d2a04a4aa7c2af`

このrepositoryの現在の`main`には、このrelease authorityより新しい変更が含まれる
場合があります。後続のViewer source変更だけでは、公開済み`v2.0.0` bundleは
変わりません。別のViewerがdevice配信されるのは、Firmware Viewer/AssetPool
intakeを別途reviewし、後続VAMeter-Edu releaseに含めた後だけです。
VAMeter-Eduでは、Windows Edge 151および第7世代iPad
(iPadOS 18.7.9 Safari)でこのdevice-hosted architectureの実機検証を記録して
います(VAMeter-Eduの`docs/product/device-hosted-viewer-contract.md`参照)。
現在の挙動:

- Student / Professionalのみで、presentation modeはありません。
- Student modeはdeviceの厳密な`display_name`に従います。`Voltage`はVoltage
  のみ、`Current`はCurrentのみ、`Both`は両方を表示します。`display_name`が
  欠落・不正・未知・大文字小文字違いの場合はfail closedとなり、`Both`への
  暗黙fallbackはありません。
- Professional modeは常にVoltage / Current両方のgraphを表示します。
- release済みViewerは不正なPublic Statusをfail closedとし、review済みの
  Public Status Standard R1 `validatePublicStatus()` reference sourceで検証します。
- Voltage / Current波形はdevice timestampを使用し、gapを保持し、invalidな
  測定値を0へ置き換えません。
- device-time display windowは10 / 30 / 60秒のみで、default 60秒、streamの
  reconnect/restart無しで変更できます。
- themeはdefaultでsystemのLight/Dark preferenceに従い、reload後には保持されない
  page-lifetimeのmanual overrideを提供します。
- live-frame更新でaction DOMのnode identityは安定しており、人間によるStop
  押下がnode置換で失われることはありません。
- deviceがViewerを配信する構成では、cloud account・インターネット接続・
  別PCは不要です。

synthetic生成、capture replay、replay speed、任意WebSocket endpointは、この
device-hosted bundleから意図的に除外されています。これらは以下のharnessの
development専用機能として残ります。

productの不足import treeは、pinned Git historyから再現できます。clean checkoutで
次を実行します。

```sh
python3 tools/product-repro/materialize-source-export.py
node --test src/product/p2-sp/tests/*.test.mjs
```

生成される`src/product/source-export/`はhistorical `80a9cd...:src` baseと
current HEADのtracked D2B reference subtreeを合成します。ignore対象であり、
source authorityではありません。すべてのtracked変更をcommitしたclean final
HEADから、current candidateを次で決定論的にbuildできます。

```sh
python3 tools/product-repro/build-current-product.py
```

historical beta.1のexact reproductionは別の操作です。

```sh
python3 tools/product-repro/verify-beta1-reproduction.py
```

verifierはrecovered builderのtracked bytesを維持し、beta.1 `app.css`で検証済みの
historical CRLF representationをdisposable inputだけに適用して、complete resultを
accepted Firmware identityと照合します。current/future product sourceへCRLFを
強制しません。正確なauthorityとrepresentation境界は
[`tools/product-repro/README.md`](tools/product-repro/README.md)と
[`docs/viewer-source-authority.md`](docs/viewer-source-authority.md)を参照してください。
このhistorical reproduction materialはpublish済みbeta.1 runtimeや実機検証を
変更しません。同様に、後続Viewer source変更だけでは安定版`v2.0.0` bundleは
更新されません。別identityを配信するには、Firmware Viewer/AssetPool intakeの
別途reviewと後続VAMeter-Edu releaseが必要です。

このViewerのfuture workは、リンクの無いroadmap文言ではなく、GitHub Issueで
管理します。

- [Device-to-Browser-Viewer Issue #1](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/1) —
  Student modeを単一のStart/Stop操作へ簡素化し、actionsをabove the foldに
  保つ。
- [Device-to-Browser-Viewer Issue #4](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Viewer/issues/4) —
  device-hosted product ViewerのGit-source reproducibility repairと
  clean-checkout acceptance criteriaを記録する。
- [VAMeter-Edu Issue #8](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/8) —
  既存のone-active-owner D2B safety契約を超えるmulti-client product policy。
  frozenなD2B policy(one active stream owner、wrong-owner rejection、relay
  safety)はVAMeter-Edu側にあるため、このIssueもVAMeter-Eduが所有します。
- [VAMeter-Edu Issue #9](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/9) —
  アナログ計器の答え合わせ用表示補正(analog-meter answer-check display
  correction)。答え合わせ時の表示値だけを補正するpresentation-only correction
  で、CSV・D2B measurement value・measurement pipelineは変更しません。
  VAMeter-Eduが所有します。historical beta.1境界のprovenanceは
  [`docs/product/beta1-device-hosted-viewer-contract.md`](docs/product/beta1-device-hosted-viewer-contract.md)
  を参照してください。

## development / validation harness

`d2b-stream/0.1`の`vi-measurement`データを受信・再生する、依存パッケージ不要で
developer-orientedなViewerです。VoltageとCurrentをdevice時刻に基づいて表示し、
sequenceとdevice timestampを必要な箇所で`BigInt`として保持し、lossとinvalidity
を可視のままにします。これは、上記のdevice-hosted product Viewerが構築される
元となったprotocol処理を開発・検証するためのharnessであり、deviceから配信され
るものではありません。

### Windowsでの起動

Windows PowerShellでrepository rootを開き、次を実行します。

```powershell
py -3 tools\serve.py
```

Viewerのlocal URLは次です。

```text
http://127.0.0.1:8080/
```

`tools/serve.py`は標準libraryだけを使うlocal development serverで、既定では
`127.0.0.1`だけにbindします。production用LAN serverではありません。

## VAMeter-Edu LiveでのContest 2026実機検証(harness)

harnessのlive-WebSocket modeは、Contest 2026でViewer commit
`80a9cd308cb3c6c5a1ccc27241cd645803675921`にて、次の経路で実V/Iデータを受信し
実機検証されました。

```text
VAMeter-Edu -> D2B -> Windows test-only Relay -> Viewer
```

(`PLAN_N_WINDOWS_E2E_PASS`、`LIVE_PHYSICAL_DEMO_PASS`)。また、Windows上の
一時ブリッジを介してiPad SafariおよびChromebook Chromeでも表示・動作を確認
しました。このWindows Relay+bridge構成は最終的な授業用architectureではなく、
device-hosted product Viewer(上記)がこれに置き換わりました — deviceが直接
Viewerを配信するため、PC・Relay・bridgeは不要です。

詳細な数値・result labelは変更せずに
[`docs/archive/contest-2026/physical-validation-narrative.md`](docs/archive/contest-2026/physical-validation-narrative.md)
に保存しています。

## Device-to-Browser Data Streamingとの関係

current Viewer sourceが参照するD2B authorityは、[Device-to-Browser Data Streaming](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming)のcommit `b30ad676922af73448952d5a9cac312467a944f9`、protocol `d2b-stream/0.1`、Public Status Standard R1です。historical beta.1 reproductionは旧authority `5411ba59a12882345d32218eda367bd6ba35ef5d`を維持します。

`src/protocol/d2b-reference/`は、このcurrent authorityのbrowser reference
source全treeをbyte-for-byteでコピーしたものです。Viewer独自の簡略parserや
public-status validatorには置き換えていません。32-byte envelope、sequence、
device timestamp、validity、gap、stream lifecycleの意味も変更していません。

## 対応するV/Iストリーム(harness)

harnessのLive WebSocket modeでは、VAMeter-Eduの`live-vi` streamを
`vi-measurement` profileとして扱います。VoltageとCurrentを個別のグラフへ表示
し、最新のデコード値、sample数、segment、gap、overflow/drop、invalidなどの
状態も確認できます。

harnessにはLive WebSocketのほか、synthetic previewと保存captureのreplayが
あります。これらはdevice-hosted product bundleには含まれない
development専用機能です。synthetic/capture fixtureは決定論的なテストデータで
あり、実機検証の証拠とは区別されます。

## 測定時刻・sequenceの扱い

sequenceとdevice timestampは、安全な整数精度を失わないよう、必要な箇所でJavaScriptの`BigInt`として保持します。グラフへ変換するときも、まずdevice-time originとの差分を求めてから相対値を`Number`へ変換します。

X軸はデコードしたdevice timeです。ブラウザーへの到着時刻はcapture replayのスケジューリング情報には使われますが、測定値のX座標には使いません。sequenceの振り直しやtimestampの圧縮も行いません。

## invalid / gap の扱い

invalidなVoltageまたはCurrentを0へ置き換えません。欠けた測定値を生成せず、hold-last-valueや補間でgapを消しません。segment境界、sequence gap、timebase change、reconnect、stream change、invalid期間をまたいでグラフ線を接続しません。

新しいstreamやreconnectでは表示viewportを新しいstreamのepochへ切り替え、以前のstreamの測定値が新しい表示へ混入しないようにします。producer側とoutput queue側のdrop原因も同一視せず、区別して表示します。

## Open / Start / Stop / Close(harness)

- `Open`: 選択したsourceを開きます。Live WebSocketではendpointへ接続して`hello`を送り、`welcome`を受信すると`READY`になります。`READY`になるまでは`Start`できません。
- `Start`: 対応する`live-vi` / `vi-measurement` streamを要求し、`stream_started`確認後に`STREAMING`としてbinary frameを受信します。
- `Stop`: `stop_stream`を送信し、`STREAM_END`と`stream_stopped`を確認して`READY`へ戻ります。
- `Close`: transportとsessionを閉じ、capture replayでは再生計画も破棄します。reopen後に新しいstreamが受理されると新しいviewport epochが始まり、以前のstreamを新しい表示へ混在させません。

操作可否はプロトコル状態に合わせて制御されます。未完了の操作を先にUI状態へ反映しない、transactionalな扱いです。

## 現在の制約

### harness

- direct iPad/Chromebook-to-VAMeter通信は未検証です。
- Chromebookは表示・live動作の確認であり、iPadと同じ全lifecycle gateを保存したformal E2E qualificationではありません。
- no-PC-required、multi-client、production-ready tablet/Chromebook supportは主張しません(これはWindows Relay+bridge経路についての記述であり、device-hosted product Viewerはそもそもこの経路を使いません)。
- long soak、heap trend、capacity edge、production releaseは未実施です。
- CSV/export、device asset serving、GitHub Pagesは未実施です。
- frozen runtime page内のvalidation noteは最終実機試験より前の文言です。実機検証済みsourceとのbyte-for-byte equivalenceを保つため変更せず、最終authorityとscopeはこのREADMEに記録します。

### device-hosted product

multi-client policyや数値表示スタイルなど、device-hosted productの現在の制約は
[`docs/product/beta1-device-hosted-viewer-contract.md`](docs/product/beta1-device-hosted-viewer-contract.md)
を参照してください。

## 関連Repository

- [Device-to-Browser Data Streaming](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming)
- [VAMeter-Edu](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu)
