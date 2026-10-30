# ClaudeSVmode

Claude Code で、ちょっと大きめの作業をチームっぽく進めるための SV（スーパーバイザー）モード一式。

ユーザと話すのは SV だけ。SV は要望を掘り下げて合意を取ったら、調査・設計・実装・レビューを決まった手順で動く workflow（wf）に任せ、結果を取りまとめて報告する。サブエージェントのやり取りでチャットが埋まることもなく、「レビューし忘れた」も仕組みで防ぐ。

---

## 特徴

- **対話は SV、作業は wf**：SV はユーザとの 1 対 1 の対話と取りまとめに専念し、手を動かす部分は wf の中で進む
- **自律進行シグナル**：SV が「あと何を決めれば任せてもらえるか」を推奨案付きで示す。OK と返すだけで決まっていき、揃ったら自律進行に入る
- **チェックポイント**：「設計が終わったら見せて」のように頼んでおけば、その地点で止まって報告する
- **用途別の wf**：調査・案の比較・議論・UI プロトタイプ・設計・計画レビュー・実装・総合レビュー・単発レビュー
- **レビュー必須**：変更のあとは、省略を頼まない限り独立したレビューを通す。SV のセルフチェックの証跡が無ければレビュー側が差し戻す
- **エスカレーション**：前提が崩れたときや判断が割れたときは、選択肢と推奨を添えた判断書で止まる
- **スタックパック**：Rails・macOS など、技術スタックごとの補足知識を wf の担当に読ませられる。自分で足すこともできる
- **利用者の追記**：SV と担当への自分用の規則を、更新で上書きされないファイルに書ける

---

## 動作環境

- Claude Code の Workflow 機能が使えること（プランによっては `/config` で有効にする必要がある）
- macOS または Linux

---

## セットアップ

このリポジトリを `git clone` するか、[ZIP でダウンロード](https://github.com/hirokidoi/ClaudeSVmode/archive/refs/heads/master.zip) して展開し、そのフォルダで作業する。詳しい手順と注意点は [INSTALL.md](INSTALL.md) にまとめてある。流れは次のとおり。

1. **配置**：`sv-mode.md` と `workflows`・`roles`・`stacks` を `~/.claude/` の下にコピーする
2. **CLAUDE.md への書き足し**：`CLAUDE.snippet.md` の内容を `~/.claude/CLAUDE.md` に足す
3. **許可設定**：`settings.snippet.json` の許可ルールを `~/.claude/settings.json` に足す
4. **フック設定**：`settings.snippet.json` のフックを `~/.claude/settings.json` に足す（連絡帳を使う場合）
5. **確認**：Claude Code を再起動し、小さなプロジェクトで試運転する

---

## 使い方

- いつもどおり Claude Code に作業を頼む。複数のファイルや工程にまたがりそうな作業なら、SV が SV モードを提案する
- 承諾すると対話フェーズに入る。SV の質問と推奨案に答えて、やること・やらないこと・止まる場所を決める
- 「🟢 自律進行できます」と出たら、内容を確かめて OK と返す。あとは完了（またはチェックポイント）まで SV が進める
- 進行中の wf は `/workflows` で確認できる。途中で別件の質問や軽い修正を頼めば、SV がその場で対応する
- wf の実行中も、SV に頼めば担当に追加の指示を届けられる（連絡帳）

更新するときは [UPDATING.md](UPDATING.md) を参照。

進め方のルールは [sv-mode.md](sv-mode.md)、wf の仕組みと一覧は [workflows/README.md](workflows/README.md)、スタックパックの作り方は [stacks/README.md](stacks/README.md) を参照。

---

## License

- MIT License. See [LICENSE](LICENSE) for details.
