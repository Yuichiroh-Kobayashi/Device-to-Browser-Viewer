# デバイスAPでのブラウザ・WebSocket確認

## 目的

デバイスが配信するViewerについて、AP参加、HTTP取得、WebSocket、表示のどこで
止まったかを区別する。[共通の観測・時計・保存手順][common-observation]
と製品の操作手順を併用する。rootの開発用harnessと、`src/product/p2-sp/`の
device-hosted Viewerは別物である。
共通手順は[D2B PR #9](https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming/pull/9)の
未merge文書をcommit固定で参照する。運用時は承認された文書revisionを実行設定へ指定する。

- [ ] 製品、Firmware、Viewer bundle、端末・OS・browser版を記録した。
- [ ] 必要なページ・手順・開始／中止／保存の操作を端末へ用意した。
- [ ] 一つのシリアル観測器があり、browserはそのportを所有しない。
- [ ] 人待ちと通信期限、総収録の時間・容量上限を区別した。
- [ ] 実機操作の許可と、異常時に止める条件を確認した。

## 準備

製品が指定するAPとURLを非公開の実行設定へ記録する。インターネットのないAPでも
動作を続けられるよう、runtimeや追加資料は接続前に取得する。
AP切替後にクラウドAIへ連絡できることを続行条件にしない。

Windowsで観測する場合は、Windows-nativeの保存先と常駐する観測processを接続前に用意する。
WSLからWindowsを起動し直すことを必須にせず、ローカルの開始・中止・保存方法を確認する。
担当者のFirmware未変更申告は、その確認時刻と根拠を記録する。同一起動の証明や
binary readbackとは区別し、UTCとuptimeの差だけで起動の連続性を判断しない。

| Browser | 接続前と試験中の操作 | 保存方法と限界 |
| --- | --- | --- |
| Windows Edge | F12でDevToolsを開き、NetworkのPreserve logを有効にする。HTTP requestとWSのMessagesを分けて見る。製品URLを通常tabで開き、前面を保つ | 必要な時系列とerror/closeを保存する。HARやrequestには秘密が入り得るため、原本は非公開。DevToolsが使えない場合はその観測を未実施とする |
| iPad Safari | 「設定」→「Wi-Fi」で製品APへ参加後、通常のSafariで製品URLを明示的に開く。自動表示された接続案内画面だけで試験を終えない。試験中は前面を保つ | 通常のiPad単体ではEdge相当のWS frame一覧を取得できない。画面の状態と操作時刻を保存し、WS受信内容は別途許可されたclient記録で補う。別clientの結果をiPad自身のframe受信の証拠にはしない。画面だけでerror-before-closeを合格にしない |

端末が既知Wi-Fiへ自動的に戻る可能性を準備時に確認する。設定変更が必要なら対象network、
管理者の許可、元の設定、復元操作を記録する。管理された端末の設定を無断で変更しない。

## 操作

| 操作 | 確認結果 | 満たさない場合 |
| --- | --- | --- |
| 製品手順でAPを起動し、端末を参加させる | AP associationと端末のIP取得 | 人の接続準備として扱い、HTTP/WS試験を開始しない |
| 製品が指定するViewer URLを開く | HTTP statusとHTML/asset取得 | URL、接続先、cache、HTTP statusを記録して止める |
| bootstrap完了を確認する | bundle/manifestと製品statusが整合し、操作画面が表示される | `identity-unavailable`等はbootstrap失敗として保存する。別bundleや開発harnessへ置換しない |
| 試験開始を記録し、Startを一度押す | WS upgrade、hello/welcome、開始応答、data受信、表示を個別に観測 | 二度押しや再接続で上書きせず、最初に欠けた段階を記録 |
| 正常停止を一度実行する | `STREAM_END`、`stream_stopped`、画面状態 | 単なるsocket closeと通常停止を区別する |
| 宣言した接続終了と再接続を確認する | 前のowner解放と、新しいsessionの開始 | 前の失敗を保存してから、許可された別の試行として行う |

同じ試験に複数browserを同時接続しない。複数clientの試験が目的なら、製品のowner規則を
明示した別の試験として行う。device-hosted Viewerに任意のWS endpointやrelayを追加しない。

## 確認結果

「インターネットなし」の表示は、APとの通信失敗そのものではない。
association、IP、HTTP、WS、アプリ開始、data、表示を別々に記録し、最初に失敗した層を示す。
シリアル側のstation参加・離脱、HTTP/WS記録と、browserの操作・error・closeを時系列で
対応付ける。station reason code一つからFirmware起因と断定しない。

error frameの受信、close event、製品ownerの解放は別の確認項目である。
表示停止だけではsocket切断を証明できず、socket切断だけではowner解放を証明できない。
送信戻り値の成功も、browserで受信した証拠の代わりにはならない。

## 失敗時の行動

| 状況 | 残す情報と次の行動 |
| --- | --- |
| APから離脱した／別Wi-Fiへ切り替わった | network切替とstation時系列を保存し、通信失敗の原因は未確定とする |
| pageのbackground化や画面lock後に止まった | foreground状態・操作時刻・WS状態を保存する。Firmwareの処理失敗と混同しない |
| HTTP成功後にWSだけ失敗した | upgrade結果、error/close順序、製品ログを対応付ける。認証やOrigin規則を緩めない |
| data受信後に表示だけ更新されない | frame受信と表示の時系列を分け、Viewer表示の調査材料として残す |
| 観測器や保存が失敗した | 観測不成立として中止・保存し、製品合格にも不合格にも転用しない |

人待ちtimeoutを外しても、外側の収録上限が待機中に進むなら無期限ではない。
例えば20分収録の18分を接続待ちに使った場合、残り2分で5分の試験は開始しない。
通信期限は試験の該当操作から測り、接続待ちと混ぜない。
上限到達時はローカル中止・保存を行い、後続項目をNOT RUNと記録する。

## 終了と保存

宣言した判定対象区間の終了と理由を記録し、正常停止・owner解放を期限・停止条件まで観測する。
同じ記録単位に含める、許可済みの端末設定復元・後片付けとその記録を完了する。
その後は[共通手順の「終了と保存」][common-finalization]に従い、新規取得の停止、
有効な書込みhandleでのfinalization、writer・最終summaryの終了確認、inventory/checksum・照合・封印を行う。
active fileは追尾せず、強制終了や保存失敗は不完全な記録として残す。
封印後に端末設定を戻す設計なら、その結果を封印対象外の別記録へ保存すると事前に定める。
再接続や再実行は新しい記録とし、過去の失敗を書き換えない。

公開例に認証値、SSID/password、個体識別子、個人path、学校情報を含めない。
この手順書の文書確認やHOST試験は、Edge/iPadと実機の確認を完了したという意味ではない。
HOST確認、build確認、実browser・実機未確認を分けて報告する。

[common-observation]: https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming/blob/08751ca9b2201916c817096925286f1e675e0bf2/docs/qualification/practical-observation.md
[common-finalization]: https://github.com/Yuichiroh-Kobayashi/Device-to-Browser-Data-Streaming/blob/08751ca9b2201916c817096925286f1e675e0bf2/docs/qualification/practical-observation.md#終了と保存
