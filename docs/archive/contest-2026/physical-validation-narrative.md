# Contest 2026 physical validation narrative

```text
HISTORICAL EVIDENCE — NOT CURRENT PRODUCT AUTHORITY
```

This document preserves the Contest 2026 Windows end-to-end, iPad, and
Chromebook physical-validation narrative that previously lived in
`README.md`/`README_ja.md`. It was moved here unchanged (numbers, PASS/FAIL
labels, commit hashes, and browser/OS versions are not altered) to keep the
current README focused on current product and development-harness behavior.
For the current summary and pointer back to this evidence, see the "Contest
2026 physical validation" section of [`README.md`](../../../README.md) /
[`README_ja.md`](../../../README_ja.md).

The final Contest physical validation authority is Viewer commit
`80a9cd308cb3c6c5a1ccc27241cd645803675921`. The tested tree was clean. Any
documentation commit after that point does not change the runtime source
validated by this narrative.

## Windows end-to-end path

The validated Windows path was:

```text
VAMeter-Edu -> D2B -> Windows test-only Relay -> Viewer
```

It used Windows build 26100 and Chrome 151.0.7922.108 (64-bit). The result was
`PLAN_N_WINDOWS_E2E_PASS` and `LIVE_PHYSICAL_DEMO_PASS`. The observed run
received 5,996 binary frames and retained 5,995 samples in one segment. A
physical voltage change from 0 V to 2.4325 V was displayed. The two
device-drop counters were 0/0, and the Relay error/overflow/drop/timeout
counters were 0/0/0/0 for this run. These observations are not a zero-loss
guarantee or a long-duration production qualification.

## iPad path

Safari on an iPad Pro 11-inch (M1), running iPadOS 26.5, displayed the real
live V/I stream through a temporary Windows bridge. READY and STREAMING
passed, the sample count increased, one segment was shown, and a physical
voltage response of approximately 2.6-2.9 V appeared in the Viewer. Stop and
Close also passed on a clean lifecycle retry. The preserved result labels are
`P5_IPAD_VIEWER_HTTP_PASS`, `P5_IPAD_WEBSOCKET_READY_PASS`,
`P5_IPAD_LIVE_DATA_PASS`, `P8_IPAD_LIVE_PHYSICAL_PASS`, and
`IPAD_VIEWER_VIA_WINDOWS_PASS`.

## Chromebook path

The Viewer was also confirmed to display and operate successfully on a Lenovo
CT-X636F Chromebook running Chrome through the temporary Windows bridge
(ChromeOS board/version krane 150.16700.0, Chrome 150.0.7871.222). This is not
a claim of formal Chromebook end-to-end qualification.

The iPad and Chromebook path was:

```text
VAMeter-Edu -> D2B -> Windows test-only Relay -> Windows temporary bridge
             -> iPad Safari / Chromebook Chrome Viewer
```

## Scope of the temporary Windows bridge

The Windows bridge was used only for Contest integration and browser-device
validation. It is not intended as the final classroom architecture, is not
owned by this repository, and is not a requirement of the Viewer by design.
These results do not demonstrate direct iPad/Chromebook-to-VAMeter
communication, no-PC-required operation, multi-client support, or
production-ready tablet/Chromebook support.

The device-hosted product Viewer shipped in VAMeter-Edu `v2.0.0-beta.1`
supersedes this Windows-Relay-and-bridge topology for the classroom
architecture: the device serves the Viewer bundle directly and no Windows PC,
Relay, or bridge is required. See
[`docs/product/beta1-device-hosted-viewer-contract.md`](../../product/beta1-device-hosted-viewer-contract.md)
for the current device-hosted contract.

## Japanese summary (preserved as originally recorded)

Contest 2026のWindows最終検証では、次の経路で実V/IデータをViewerへ送りました。

```text
VAMeter-Edu
→ D2B
→ Windows test-only Relay
→ Viewer
```

Windows build 26100、Chrome 151.0.7922.108 64-bitで、`PLAN_N_WINDOWS_E2E_PASS`
および`LIVE_PHYSICAL_DEMO_PASS`を確認しました。観測結果はbinary frame 5,996、
sample 5,995、segment 1、実回路のVoltage変化0 V → 2.4325 Vです。このrunでは
device drop counterが0/0、Relayのerror / overflow / drop / timeoutが
0/0/0/0でした。これらは当該runの観測値であり、zero packet loss保証、均一で
保証された25 Hz、長時間production qualificationを意味しません。

iPadとChromebookでは、Windows上の一時ブリッジを追加した次の経路を使用しました。

```text
VAMeter-Edu
→ D2B
→ Windows test-only Relay
→ Windows temporary bridge
→ iPad Safari / Chromebook Chrome Viewer
```

iPad Pro 11-inch (M1)、iPadOS 26.5、Safariで、Windowsの一時ブリッジを経由して
実V/I streamを表示しました。`READY`、`STREAMING`、sample数の増加、segment 1を
確認し、実回路のVoltage変化に対応して約2.6–2.9 Vのグラフ変化を確認しました。
clean lifecycle retryではStop / CloseもPASSしました。保存するresult labelは
次のとおりです。

```text
P5_IPAD_VIEWER_HTTP_PASS
P5_IPAD_WEBSOCKET_READY_PASS
P5_IPAD_LIVE_DATA_PASS
P8_IPAD_LIVE_PHYSICAL_PASS
IPAD_VIEWER_VIA_WINDOWS_PASS
```

Lenovo CT-X636F、ChromeOS board/version `krane 150.16700.0`、Chrome
150.0.7871.222でも、同じWindows一時ブリッジを経由してViewerの表示・live動作が
良好であることを確認しました。この記録は、formal Chromebook end-to-end
qualificationを主張するものではありません。

この検証経路はContestの統合・ブラウザーデバイス検証用です。Viewerが設計上
Windowsを必要とするという意味ではありません。ただし、これはiPad/Chromebookから
VAMeter-Eduへ直接接続した試験ではありません。Windows bridgeはContestの統合・
ブラウザーデバイス検証だけに使用したもので、最終的な授業用architectureでは
ありません。bridge/Relayの実装はこのViewer repositoryの責務にも含めません。
