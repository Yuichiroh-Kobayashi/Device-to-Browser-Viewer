# Node環境とViewer生成物の受渡し

## 目的

Related to #16。Node候補はHOSTテスト用途だけに採用する。
設定元は [`tools/build-env/node-toolchain.json`](../../tools/build-env/node-toolchain.json)。
製品builderは既存の [Build Environment V1](../../tools/build-env/README.md) を維持する。

## 準備

Linux x64、Python 3.12、gpgvと専用worktreeを用意する。
公式keyringの固定SHA、署名付きchecksum、archive SHAを確認してproject-localに展開する。
既存runtimeは上書きしない。keyring変更時は検証入力をレビューする。

```bash
python3 tools/build-env/node.py install
python3 tools/build-env/node.py check
```

## 操作

```bash
python3 tools/product-repro/materialize-source-export.py
python3 tools/build-env/node.py exec -- node --test src/product/p2-sp/tests/*.test.mjs
python3 tools/build-env/node.py exec -- node tests/node-self-tests.mjs
python3 tools/build-env/node.py exec -- node tests/live-gate-regressions.mjs
```

専用の非デプロイHOST CIも同じ設定を読む。既存builder workflow、Python、webpack、
terser、圧縮設定、製品JS、コピー済みD2B referenceは変更していない。
物理通信clientとWindows-nativeのruntimeはこの移行範囲外。

## 確認結果

2026-09-11、同一のclean source `81226e7b39410ac673c1b46a9b76eab6084a4f19` を使用。
既存image内の `/usr/bin/node` だけを公式候補binaryへread-only bindする比較を各2回行った。
Ubuntu 24.04.4 x64、Python 3.12.3、webpack 5.76.1、terser-webpack-plugin 5.3.7、
terser 5.19.2、`NODE_PATH=/usr/share/nodejs` は共通。containerはnetworkなし。

| 項目 | 基準 Node 18.19.1 | 候補 Node 24.21.0 |
|---|---|---|
| npm実測 | 未インストール | 11.19.0 |
| 製品HOST tests | 74 PASS × 2 | 74 PASS × 2 |
| protocol / live-gate | 30 + 13 PASS × 2 | 30 + 13 PASS × 2 |
| builder | exit 0 × 2 | exit 1 × 2 |
| 圧縮asset / manifest | 決定的出力 | 生成完了せず |

基準bundleは `be563812df74534c09d15bd67c5015519da3eca551e9e8812f6096a3343a58cb`、
index 573、manifest 1364、CSS gzip 2385、JS gzip 25809、計30131 bytes。
[比較記録](node-comparison-2026-09-11.json) にhashと結果を残す。
候補の失敗位置はDebianパッケージの `enhanced-resolve/lib/ResolverFactory.js:235`。
`process.config.variables.node_relative_path.split` に必要な変数が公式Nodeではundefinedだった。
この既存distro依存と公式runtimeの組合せは非互換。Node一般や製品JSの不具合とは断定しない。

## 失敗時の行動

builder用途はHOLD。既存builderにダミーのNode設定を注入したり、Python/圧縮設定を変えて
一致扱いにしない。後続の環境修正をレビューし、同じsource・入力で再比較する。
Stackchanの生成PASSはViewer builderのPASSを意味しない。

VAMeterへの受渡しは、最終clean commit/tree、runtime/toolchain、builder入力、
全asset長/SHA、manifest/bundle、2回一致結果を入力manifestへ記録する。
今回の比較bundleは固定比較sourceの証拠であり、このPR最終HEADの取込みcandidateではない。
後続のtracked commitは新しいmanifest/bundleを必要とする。
Firmware側の固定slot、期待SHAとrouteもレビューし、新しいAssetPoolと対応づける。
長さ一致だけで既存製品へ取り込まない。

## 終了と保存

失敗のstderrとexit、成功側の全出力を別々に保存する。原本logは公開しない。
実ブラウザ、実AP、Windows保存先、Firmware/AssetPool生成・書込み・配信は未実施。
[共通観測 Issue #8](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming/issues/8)
と [VAMeter受入れ Issue #23](https://github.com/Yuichiroh-Kobayashi/VAMeter-Edu/issues/23) を参照する。
