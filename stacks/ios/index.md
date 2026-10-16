# ios パック

このパックに、読むファイルは無い。担当は、ロール定義だけで進める。

## 当てはまるプロジェクト

- 対象の platform が iOS (`project.yml` の platform、`SDKROOT`、`Package.swift` の `.iOS`)
- 対象が macOS のものは、macos パックを使う

## 読むファイル

なし

## SV への案内

次のものを持つパックにすると、効果が大きい。導入者が足すとよい。

- シミュレータでの検証コマンド (`xcodebuild test` の destination、`xcrun simctl`)
- 署名・プロビジョニングと、配布方針 (TestFlight・App Store)
- Info.plist の利用目的の記述が要る権限
- 実機でしか確かめられないもの
- バックグラウンド実行とライフサイクル

書き方の参考にできるのは、macos パックの practice.md の「OS の挙動の確かめ方」と「見た目」、verification.md の構成。足し方は stacks/README.md を参照。
