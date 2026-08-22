# Device-to-Browser Viewer

[English](README.md)

## 概要

Device-to-Browser Viewerは、`d2b-stream/0.1`のストリームをブラウザーで受信・再生し、`vi-measurement`のVoltageとCurrentをデバイス時刻に基づいて表示する、依存パッケージ不要の静的Viewerです。

現在のViewerは、接続状態、プロトコル状態、デコード結果、診断情報、ライフサイクル操作を詳しく確認できる、開発・プロトコル検証向けのUIです。これは統合検証のために意図した設計であり、最終的な生徒向け授業UIではありません。

## VAMeter-Edu Liveでの利用

Contest 2026のWindows最終検証では、次の経路で実V/IデータをViewerへ送りました。

```text
VAMeter-Edu
→ D2B
→ Windows test-only Relay
→ Viewer
```

iPadとChromebookでは、Windows上の一時ブリッジを追加した次の経路を使用しました。

```text
VAMeter-Edu
→ D2B
→ Windows test-only Relay
→ Windows temporary bridge
→ iPad Safari / Chromebook Chrome Viewer
```

この検証経路はContestの統合・ブラウザーデバイス検証用です。Viewerが設計上Windowsを必要とするという意味ではありません。

## Device-to-Browser Data Streamingとの関係

Viewerが参照するD2B authorityは、[Device-to-Browser Data Streaming](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming)のcommit `5411ba59a12882345d32218eda367bd6ba35ef5d`、protocol `d2b-stream/0.1`です。

`src/protocol/d2b-reference/`は、このauthorityのbrowser reference parserをbyte-for-byteでコピーしたものです。Viewer独自の簡略parserには置き換えていません。32-byte envelope、sequence、device timestamp、validity、gap、stream lifecycleの意味も変更していません。

## 対応するV/Iストリーム

Live WebSocket modeでは、VAMeter-Eduの`live-vi` streamを`vi-measurement` profileとして扱います。VoltageとCurrentを個別のグラフへ表示し、最新のデコード値、sample数、segment、gap、overflow/drop、invalidなどの状態も確認できます。

ViewerにはLive WebSocketのほか、synthetic previewと保存captureのreplayがあります。synthetic/capture fixtureは決定論的なテストデータであり、実機検証の証拠とは区別されます。

## Viewerの主要機能

- Voltage / Currentの最新値とグラフ表示
- device timeに基づくX軸
- Live WebSocket、capture replay、synthetic preview
- 接続状態と`CONNECTED → READY → STREAMING → READY/CLOSED`の確認
- デコードされたrecord、sequence、device timestampの確認
- invalid、segment、gap、producer overflow、output queue dropの可視化
- `Open` / `Start` / `Stop` / `Close`による明示的なライフサイクル操作
- 有界なrecord、marker、diagnostic保持

## 測定時刻・sequenceの扱い

sequenceとdevice timestampは、安全な整数精度を失わないよう、必要な箇所でJavaScriptの`BigInt`として保持します。グラフへ変換するときも、まずdevice-time originとの差分を求めてから相対値を`Number`へ変換します。

X軸はデコードしたdevice timeです。ブラウザーへの到着時刻はcapture replayのスケジューリング情報には使われますが、測定値のX座標には使いません。sequenceの振り直しやtimestampの圧縮も行いません。

## invalid / gap の扱い

invalidなVoltageまたはCurrentを0へ置き換えません。欠けた測定値を生成せず、hold-last-valueや補間でgapを消しません。segment境界、sequence gap、timebase change、reconnect、stream change、invalid期間をまたいでグラフ線を接続しません。

新しいstreamやreconnectでは表示viewportを新しいstreamのepochへ切り替え、以前のstreamの測定値が新しい表示へ混入しないようにします。producer側とoutput queue側のdrop原因も同一視せず、区別して表示します。

## Open / Start / Stop / Close

- `Open`: 選択したsourceを開きます。Live WebSocketではendpointへ接続して`hello`を送り、`welcome`を受信すると`READY`になります。`READY`になるまでは`Start`できません。
- `Start`: 対応する`live-vi` / `vi-measurement` streamを要求し、`stream_started`確認後に`STREAMING`としてbinary frameを受信します。
- `Stop`: `stop_stream`を送信し、`STREAM_END`と`stream_stopped`を確認して`READY`へ戻ります。
- `Close`: transportとsessionを閉じ、capture replayでは再生計画も破棄します。reopen後に新しいstreamが受理されると新しいviewport epochが始まり、以前のstreamを新しい表示へ混在させません。

操作可否はプロトコル状態に合わせて制御されます。未完了の操作を先にUI状態へ反映しない、transactionalな扱いです。

## Windowsでの起動

Windows PowerShellでrepository rootを開き、次を実行します。

```powershell
py -3 tools\serve.py
```

Viewerのlocal URLは次です。

```text
http://127.0.0.1:8080/
```

Contest 2026のvalidated Windows Relay topologyでは、ViewerのLive WebSocket endpointに次を指定しました。

```text
ws://127.0.0.1:8765/
```

`tools/serve.py`は標準libraryだけを使うlocal development serverで、既定では`127.0.0.1`だけにbindします。production用LAN serverではありません。

## Contest 2026で検証した構成

実機最終検証のViewer authorityはcommit `80a9cd308cb3c6c5a1ccc27241cd645803675921`です。検証時のtreeはcleanでした。以後のdocs-only commitではruntime sourceを変更していません。

Windows build 26100、Chrome 151.0.7922.108 64-bitで、`PLAN_N_WINDOWS_E2E_PASS`および`LIVE_PHYSICAL_DEMO_PASS`を確認しました。観測結果はbinary frame 5,996、sample 5,995、segment 1、実回路のVoltage変化0 V → 2.4325 Vです。このrunではdevice drop counterが0/0、Relayのerror / overflow / drop / timeoutが0/0/0/0でした。

これらは当該runの観測値であり、zero packet loss保証、均一で保証された25 Hz、長時間production qualificationを意味しません。

## iPadでの検証結果

iPad Pro 11-inch (M1)、iPadOS 26.5、Safariで、Windowsの一時ブリッジを経由して実V/I streamを表示しました。`READY`、`STREAMING`、sample数の増加、segment 1を確認し、実回路のVoltage変化に対応して約2.6–2.9 Vのグラフ変化を確認しました。clean lifecycle retryではStop / CloseもPASSしました。

保存するresult labelは次のとおりです。

```text
P5_IPAD_VIEWER_HTTP_PASS
P5_IPAD_WEBSOCKET_READY_PASS
P5_IPAD_LIVE_DATA_PASS
P8_IPAD_LIVE_PHYSICAL_PASS
IPAD_VIEWER_VIA_WINDOWS_PASS
```

## Chromebookでの確認結果

Lenovo CT-X636F、ChromeOS board/version `krane 150.16700.0`、Chrome 150.0.7871.222でも、同じWindows一時ブリッジを経由してViewerの表示・live動作が良好であることを確認しました。

この記録は、formal Chromebook end-to-end qualificationを主張するものではありません。

## temporary Windows bridgeについて

最終Contest検証では、Windows上のE2E経路に加えて、Windowsの一時ブリッジを経由したiPad Safari上で実V/Iデータを表示し、実回路の電圧変化に対応してグラフが変化することを確認しました。

ChromebookのChromeでも同じViewerの表示・動作を確認しています。

ただし、これはiPad/ChromebookからVAMeter-Eduへ直接接続した試験ではありません。Windows bridgeはContestの統合・ブラウザーデバイス検証だけに使用したもので、最終的な授業用architectureではありません。bridge/Relayの実装はこのViewer repositoryの責務にも含めません。

## 現在の制約

- direct iPad/Chromebook-to-VAMeter通信は未検証です。
- Chromebookは表示・live動作の確認であり、iPadと同じ全lifecycle gateを保存したformal E2E qualificationではありません。
- no-PC-required、multi-client、production-ready tablet/Chromebook supportは主張しません。
- long soak、heap trend、capacity edge、production releaseは未実施です。
- CSV/export、device asset serving、GitHub Pagesは未実施です。
- frozen runtime page内のvalidation noteは最終実機試験より前の文言です。実機検証済みsourceとのbyte-for-byte equivalenceを保つため変更せず、最終authorityとscopeはこのREADMEに記録します。

## 今後の教育用Viewerへの改修

現在のViewerはdeveloper-orientedで、protocolとintegrationを検証するために詳細な状態を意図的に表示しています。次の大きなUI作業は、測定・時刻・invalid/gap・lifecycleの意味を保ったまま、education-oriented Viewerへ発展させることです。

今後の候補は次のとおりです。

- Voltage / Current値の大型表示
- より大きく見やすいグラフ
- protocol/diagnostic操作の整理
- 生徒向けに簡潔なStart / Stop操作
- 測定状態を理解しやすいindicator
- 授業に適したauto-scaling
- tablet / Chromebook向けlayout
- 大型display / presentation mode
- 電気現象の理解に役立つ情報へのfocus

これらはfuture workであり、今回のdocs-only finalizationでは実装しません。

## 関連Repository

- [Device-to-Browser Data Streaming](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming)
- [VAMeter-Edu](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu)
