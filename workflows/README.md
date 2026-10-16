# SV workflows

`~/.claude/sv-mode.md` (キットの `sv-mode.md`) の実装。SV (スーパーバイザー) がユーザとの対話を担い、決定的に動く workflow 群を組み合わせて案件を進めるための実行基盤。

> **SV が wf を起動する時は必ず `USAGE.md` を先に Read すること。** 共通 args 契約、wf 別引数、起動例、よくある間違いが記載されている。

## このシステムの位置づけ

SV モードは、以下の課題を **決定的なスクリプト** に落とすことで構造的に解決する:

- サブエージェントの出力がメインチャットに流れ込むと、ユーザと SV の 1x1 対話が保てない
- 案件ごとにチーム編成やレビュー起動を SV が判断すると、粒度・抜け漏れがブレる
- 「レビュー起動忘れ」など、経験的に繰り返される抜けを構造で防ぐ必要がある

## 基本方針

- **対話は SV、決定的実施は wf** — 対話・タスク分解・結果統合を SV が担い、fan-out / 修正ループ / 品質ゲートは wf 内部で決定的に回す
- **品質ゲート内蔵** — レビューやチェック観点は wf 内部に埋め込み、SV が忘れても構造で担保する
- **SV コンテキスト保護** — wf 内部エージェントの出力はメインチャットに流さず、成果物は作業ディレクトリに保存して path 参照で受け渡す
- **モデル継承デフォルト** — 判断・批判系は SV のセッションモデル継承、実行系のみ `sonnet` 明示。将来 SV のモデルが変わっても判断系は自動追従
- **段階的な自律・エスカレーション** — 要件合意後は自律進行、判断困難時は選択肢付き判断書でユーザに戻す

## SV の責務 (概要)

`~/.claude/sv-mode.md` (キットの `sv-mode.md`) に詳細。要点のみ:

- **A. 対話フェーズ** — 要望の掘り下げ、意図確認、案件規模の見極め、チェックポイント宣言の合意
- **B. 実施フェーズ** — 適切な wf を選定・起動、結果を評価して次アクション判断、割り込み対応
- **B'. チェックポイント** — ユーザが宣言したフェーズ完了時に必ず停止・報告
- **C. エスカレーション** — ブロッカー時は選択肢 2〜4 の判断書を作成してユーザに戻す
- **D. 品質担保・振り返り** — wf 結果を鵜呑みにせず重要箇所を SV 直読、作業完了時の振り返り

## ユーザから見た挙動

ユーザの操作は「〜作りたい」と伝えて SV モードを承諾するだけ。裏で SV は、Agent ツールでサブエージェントを直接起動するのではなく、Workflow ツール経由で wf を起動して進める。

そのほかの特徴:

- チャットが静か (wf 内部エージェントの出力が漏れない)
- 進捗確認は `/workflows` コマンドで確認できる。使えない環境では SV に聞けば答える
- チェックポイント宣言 (「設計終わったら見せて」等) を対話で伝えれば wf が該当地点で停止する

## 設計判断の根拠

システム設計時に対話ベースで決めた核となる判断と根拠は `design-docs/_common.md §18「設計判断の記録」` に集約。構造を触り直すときはそちらを参照。

## 一覧

| wf 名 | 目的 |
|---|---|
| `sv-investigate` | 曖昧な要望・特定領域の状態把握 (並列 fan-out) |
| `sv-explore-approach` | 仕様確定前のアプローチ比較 (Judge panel) |
| `sv-prototype-ui` | HTML プロトタイプ制作 + デザインレビュー |
| `sv-design` | 要件から設計 + 独立レビュー + 修正ループ |
| `sv-implement` | 設計から依存順のバッチ単位で並列実装 + テスト + commit (レビューは後段の sv-comprehensive-review) |
| `sv-comprehensive-review` | 変更セット全体の多観点レビュー |
| `sv-review-plan` | SV 自作計画の独立レビュー |
| `sv-review-changes` | 手元変更の単発コードレビュー |

## 共通引数

全 wf は以下の形で `args` を受け取る:

```json
{
  "tmp_base_dir": "作業ディレクトリ (決め方は sv-mode.md「対話の基本」)",
  "project_root": "実行中プロジェクトのルートパス",
  "project_memory_path": "プロジェクトの規約・memory 類のディレクトリ (任意)",
  "stacks": ["rails"],
  "run_id": "SV 採番の run-id (例: 20260706-234512-a3f9x1)",
  "checkpoint_declarations": ["designed", "implemented"],
  "complexity_profile": "light | standard | deep",
  "model_overrides": { "reviewer": "opus" },
  "wf_specific": { /* wf 固有引数 */ }
}
```

## 共通返り値

```json
{
  "status": "success" | "escalation" | "checkpoint_stop" | "rejected",
  "summary": "SV への短い要約 (1〜3 文)",
  "outputPath": "tmp/... (単一 md をそのまま返す wf のとき)",
  "runDir": "<run ディレクトリ> (escalation のとき、成果物の基点として)",
  "<wf 固有キー>": "wf ごとに componentOutputs / lensMdPaths / areaMdPaths 等の path 配列を返す",
  "escalation": { /* status=escalation のとき */ },
  "checkpoint": { /* status=checkpoint_stop のとき */ },
  "rejection": { /* status=rejected のとき (レビュー系 wf のセルフチェック証跡不備) */ }
}
```

SV は返り値の path 群を Read して総括する。`status` の意味と `checkpoint_declarations` に使える名前は `USAGE.md` を参照。詳細スキーマは `~/.claude/workflows/design-docs/_common.md` を参照。

## モデル方針

- **明示指定は `sonnet` だけ**、判断・批判系は SV セッションモデル継承
- 対話で `complexity_profile` または `model_overrides` で調整可能
- 詳細は各 script 内の `modelFor()` を参照

## 共通ヘルパ (Prelude)

Workflow スクリプトは他ファイルを import できないため、共通ヘルパは各 script 冒頭に重複記述する。ヘルパの正本は `_prelude.js.md` (参照用) を参照。レビュー系 wf がコピーする共有ヘルパ (レビュー観点カタログ・コード diff レビュー用ヘルパ・セルフチェック確認) も正本は同ファイル。正本と複製の一致は `check-prelude.sh` で確かめる。

## 出力先

各 wf の実行結果は `<tmp_base_dir>/wf-<wf-name>/<run-id>/` に保存する (作業ディレクトリの決め方は sv-mode.md「対話の基本」)。

各 run ディレクトリ配下:
- `agents/`: 中間エージェントの成果物 (最終レビュー md はここに置かれる)
- `loop/`: 修正ループの記録 (round-N-output.md / round-N-review.md)

SV は返り値中の path (`outputPath` / `componentOutputs` / `lensMdPaths` 等) を Read して総括する。
