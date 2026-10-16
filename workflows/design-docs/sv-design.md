# wf: sv-design

## 1. 目的・想定利用シーン

要件から設計・実行計画を作り、独立レビューを通した承認済み設計書を返す。

- 要件が合意されている案件で、設計フェーズを wf に委任する時
- `sv-investigate` の結果を踏まえた設計が必要な時

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "requirements": "確定済み要件 (自然言語 or 構造化)",
  "constraints": ["制約 1", "制約 2"],
  "investigation_result_path": "調査結果 md のパス (あれば)",
  "scope": {
    "target_paths": ["変更対象のディレクトリ or ファイル"],
    "out_of_scope": ["対象外 (明示的除外)"]
  },
  "design_style_preference": "aggressive | conservative (デフォルト: conservative)"
}
```

- `design_style_preference` — 設計担当への指示に反映
  - `conservative`: 既存構造を尊重、小さく変える
  - `aggressive`: 抜本的なリファクタも検討

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation' | 'checkpoint_stop',
  summary: '設計完了 (N ラウンド)',
  outputPath: '<run-dir>/loop/round-N-output.md',   // 最終ラウンドの設計 md
  reviewMdPaths: ['<run-dir>/loop/round-1-review.md', ...],  // 全ラウンドのレビュー md
  escalation: {...},   // status=escalation のとき
  checkpoint: {...},   // status=checkpoint_stop のとき
}
```

SV は `outputPath` を Read して設計を確認する。レビュー履歴が必要なときは `reviewMdPaths` を Read する。集約 md は作らない。

**escalation の返り値:** 担当エージェントを起動した後の escalation は、`runDir` と、その時点で存在する成果物の path (`outputPath` = 直近の設計 md、`reviewMdPaths` = それまでのレビュー md) を返す。初回の設計担当が失敗した場合は成果物が無いため `runDir` のみ。args 検証の escalation は成果物が無いので返さない (_common.md §1)。

**レビュー md の判定 JSON (主要キー):**

- `pass`、`review_mode` (full / focused)
- 打ち切りフラグ: `upstream_precondition_failed`、`structural_rethink_required`、`revision_count_high`、`designer_stuck` (round 2 以降)。各フラグには理由を添える
- `checks`: 観点キーごとの `status` (ok / issue / na) と詳細
- `revision_required`: blocker / must_fix の指摘 (severity・location・instruction)
- `additional_findings`: suggestion の指摘 (location・detail)

重大度の語彙と合否の対応は _common.md §5 を正とする。

**設計 md の構成 (設計担当が生成):**

```markdown
# 設計書: <案件名>

## 総合評価
設計成立 / precondition_failed / contradiction_detected + 1〜3 行サマリ

## 判定 JSON
(contradiction_detected / design_precondition_failed 等を含む JSON)

## 早期打ち切り理由
(precondition_failed / contradiction_detected 時のみ)

## 要件 (再掲)

## スコープ
- 対象: <target_paths>
- 対象外: <out_of_scope>

## 設計方針 (全体アプローチ)

## 変更計画 (変更ごとに Before/After/理由)

## 依存関係と実装順序 (並列可 / 順次必要)

## 想定リスクと対応

## テスト計画 (新規テスト / 既存テストへの影響)
```

レビューの記録は設計 md に含めず、ラウンドごとのレビュー md (`reviewMdPaths`) に残る。

## 4. 内部エージェント構成

```
[設計フェーズ]
  └─ agent: 設計担当 x 1
     agentType: general-purpose
     ロール: designer.md
     入力: requirements, constraints, investigation_result, scope
     出力: loop/round-<N>-output.md

[設計レビューフェーズ]
  └─ agent: 設計レビュー担当 x 1
     agentType: general-purpose
     ロール: reviewer.md (_common.md §5 の `progress` 以外の観点 + 設計固有チェック)
     入力: 設計案 + project_memory_path (任意)
     出力: loop/round-<N>-review.md
     判定: pass / revision_required
     round 1 はフル監査。round 2 以降は focused 再レビュー (下記)

[修正ループ]
  レビュー指摘があれば、設計担当を再起動して修正 → 再レビュー
  最大 3 回。上限到達で escalation
```

- 全体は _common.md §7 のパターンに沿った独自ループ。設計担当の出力の後と各レビューの後に、早期打ち切りの判定を挟む
- 修正ラウンドの設計担当は、前版を複製して指摘箇所だけを Edit する (focused 再レビューの前提)
- **focused 再レビュー**: round 2 以降のレビューは前ラウンドとの `diff` を取り、指摘の解消確認に絞る。差分が局所的かつ指摘全件解消なら focused pass、広範・構造的ならフル監査に fall back (_common.md §7)。判定 JSON に `review_mode` を含める
- ループ各ラウンドの記録は `loop/round-<N>-*.md` に保存 (_common.md §12)
- 最終ラウンドの設計 md をそのまま `outputPath` として返す (集約 md は作らない)

## 5. エスカレ条件 (wf 固有)

共通の「修正ループ上限到達」以外に、実装は次の場合に打ち切って escalation を返す。

- **設計担当の矛盾検出 (全ラウンド)**
  - 要件 X と要件 Y が両立不能、などを検出
  - → 要件の優先順位または見直しをユーザに求める
- **設計担当の前提不足 (全ラウンド)**
  - 要件が曖昧、スコープが広すぎる、調査結果が不足、技術的に実現困難、のいずれか
  - → 要件の具体化、`sv-investigate` の追加起動、スコープ分割を提示
- **レビュー担当の upstream_precondition_failed / structural_rethink_required (全ラウンド)**
  - 設計が実質を持たない、または根本的な見直しが必要
  - → 上流 (要件・調査) に戻る選択肢を提示
- **revision_count_high (round 2 以降、指摘件数が前回以上)**
  - 初回の指摘が多いだけでは打ち切らず、修正を経ても件数が減らないときに前工程の質を疑う
- **designer_stuck (round 2 以降)**
  - 前回指摘の過半数が未解消
- **担当の実行失敗**
  - 設計担当・レビュー担当が結果を返さない
- **上限到達**
  - 修正ループの上限までにレビューを通過しない

## 6. `meta` ブロック案

```javascript
export const meta = {
  name: 'sv-design',
  description: '要件から設計を作り独立レビューを通した承認済み設計書を返す',
  whenToUse: '要件確定後、実装に入る前に設計を wf に委任する時',
  phases: [
    { title: '設計' },
    { title: 'レビュー' },
    { title: '修正ループ' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (処理の順序)

プロンプトの正本は実装 (`sv-design.js`)。ここでは分岐の順序のみを述べる。

1. args 検証 (共通の Prelude)
2. round 1 の設計担当を起動する。結果が得られなければ escalation
3. 設計担当の打ち切りフラグ (矛盾検出・前提不足) を判定し、該当すれば escalation
4. レビュー担当を起動する。結果が得られなければ escalation
5. レビュー担当の打ち切りフラグを次の順で判定し、該当すれば escalation
   1. `upstream_precondition_failed`
   2. `structural_rethink_required`
   3. `revision_count_high` (round 2 以降、指摘件数が前回以上)
   4. `designer_stuck` (round 2 以降)
6. `pass` なら成功としてループを抜ける
7. 上限ラウンドに達していれば上限到達の escalation
8. 設計担当を修正ラウンドとして起動する。結果が得られなければ escalation。得られたら 3 と同じ打ち切りフラグ判定を行い、4 に戻る
9. 成功時は、`designed` チェックポイントの宣言があれば `checkpoint_stop`、なければ `success` を返す
