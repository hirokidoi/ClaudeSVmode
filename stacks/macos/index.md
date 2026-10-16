# macos パック

## 当てはまるプロジェクト

- `*.xcodeproj`、`project.yml` (XcodeGen)、`Package.swift` のいずれかがあり、対象の platform が macOS
- 対象が iOS のものは、ios パックを使う

## 読むファイル

| ファイル | 読み手 | 条件 |
|---|---|---|
| practice.md | investigator, designer, implementer, reviewer | 常に |
| measurement.md | investigator, designer, reviewer, verifier | 性能・CPU・電力を測るか比べるとき |
| verification.md | verifier | 常に |
| pitfalls/swiftui-appkit.md | investigator, designer, implementer, reviewer | `import SwiftUI` か `import AppKit` で UI を持つとき |
| pitfalls/webkit.md | investigator, designer, implementer, reviewer | `WKWebView` を使うとき |
| pitfalls/avfoundation.md | investigator, designer, implementer, reviewer | AVFoundation で映像・音声を読み書きするとき |
| pitfalls/helper-processes.md | investigator, designer, implementer, reviewer | 子プロセスや常駐 (デーモン・ヘルパ) を起動するとき |
| pitfalls/coreaudio.md | investigator, designer, implementer, reviewer | CoreAudio を使うとき |
| pitfalls/vscode-swift.md | investigator, implementer, verifier | VS Code の Swift 拡張を使う環境のとき (パッケージのルートに索引用のビルド生成物が出る) |

## SV への案内

- 配布方針 (ad-hoc 署名 / Developer ID と公証 / App Store) がプロジェクトから読み取れなければ、対話で確かめて要件に書く
- 許可ダイアログ・画面の見た目・音の確認は、人に頼む実機確認になる。検証コマンドには入れない
- 検証コマンドは verification.md の「検証コマンド」節から選ぶ
