# wf: sv-review-changes

## 1. 目的・想定利用シーン

手元の変更 (未 commit or 特定コミット範囲) をコードレビューする単発 wf。

- SV モード中に SV が直接編集した後 (割り込み対応など) の独立レビュー (sv-mode.md のレビュー必須の実装)
- 割り込み対応で SV が小さな変更を入れた後
- `sv-comprehensive-review` ほど大掛かりでないが、独立視点は必要な時
- ユーザから「これレビューして」と指示された時

`sv-comprehensive-review` との違い: 単一のレビュー担当によるコードレビュー。仕様書との網羅的な照合や、観点ごとの並列レビューは行わない。

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "change_scope": {
    "files": ["変更ファイル一覧"],
    "commit_range": "git の範囲指定 (省略か 'uncommitted' で作業ツリーの未 commit 変更。未追跡の新規ファイルを含む)"
  },
  "selfcheck_path": "セルフチェック証跡 md のパス",
  "context": "変更の意図・背景 (自然言語)",
  "focus_areas": ["特に重点的に見てほしい観点 (自由記述、省略可)"]
}
```

- `commit_range` — 対象が git 管理外のときは無視し、`files` の全文をレビューする (変更の中身は `context` とセルフチェック証跡で伝える)
- `selfcheck_path` — SV がレビュー前に実施したセルフチェックの証跡 md (必須)。確認方法は §4、作成手順は sv-mode.md の「実施上の原則」のレビュー必須

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation' | 'rejected',
  summary: '変更レビュー完了 (pass=...)',
  outputPath: '<run-dir>/agents/code-review.md',   // レビュー担当が書いた md
  escalation: {...},                                // 担当起動後は runDir も返す
  rejection: { reason, selfcheck_path },
}
```

`status=rejected` はセルフチェック証跡の不備でレビュー本体を実施していないことを表す (`rejection.reason` に理由)。

SV は `outputPath` を Read してレビュー結果と判定 JSON を確認する。集約 md は作らない。

**code-review.md の構成の参考:**

```markdown
# タイトル

## 総合評価
pass / NG + 1〜3 行サマリ

## 判定 JSON
{ "pass": bool, "upstream_precondition_failed": bool, "upstream_precondition_reason": "..." | null, "scope": {...}, "checks": {観点キー: ...}, "revision_required": [blocker / must_fix の指摘], "additional_findings": [suggestion の指摘] }
(変更が大きい場合は "change_size_too_large": true と file_count / line_count を含む)

## 早期打ち切り判断
upstream_precondition_failed=true のときのみ。観点ごとのチェックは行わず pass=false

## スコープ判定
対象種別と各観点の適用 / 対象外

## チェック観点
観点キーごとに ok / issue / na + 詳細

## 追加所見
提案 (suggestion)

## 修正指示
blocker / must_fix。該当あれば
```

重大度の語彙・pass との対応・観点キーの定義は `_common.md §5` を参照。

## 4. 内部エージェント構成

```
[セルフチェック確認フェーズ]
  └─ agent: セルフチェック確認担当 x 1 (role: selfcheck_gate)
     入力: selfcheck_path, レビュー対象の概要
     判定: 実施したことが読み取れ、対象の規模に対して妥当か (内容の正しさは検証しない)
     不備: レビューフェーズに進まず status=rejected を返す

[レビューフェーズ]
  └─ agent: コードレビュー担当 x 1
     ロール: reviewer.md
     プロンプト: チェック観点 (全観点、スコープ判定表で絞る) + focus_areas + context 反映
     入力: change_scope, selfcheck_path, project_root (git の実行場所), project_memory_path (任意)
     出力: agents/code-review.md (wf 返り値の outputPath として返す)
     最終応答: md の保存を確認したうえで pass と md_written と upstream_precondition_failed を schema で返す
```

**修正ループなし** — 単発レビュー。SV が結果を受けて次アクション判断。

## 5. エスカレ条件 (wf 固有)

- **レビュー担当の null 返し** — 実行失敗として escalation
- **レビュー担当が md を保存できなかった (`md_written=false`)** — escalation。選択肢は再実行の 1 件
- 変更範囲が大きい場合 (閾値は wf のプロンプトを正とする) は wf としてはエスカレしない。レビュー担当が判定 JSON に `change_size_too_large` を記録し、SV が読んで `sv-comprehensive-review` への切り替えを判断する

## 6. `meta` ブロック案

```javascript
export const meta = {
  name: 'sv-review-changes',
  description: '手元の変更を単発レビューして判定を返す (SV 直接編集後や割り込み対応後)',
  whenToUse: 'SV 直接編集後、または軽微な変更後の独立レビュー',
  phases: [
    { title: 'セルフチェック確認' },
    { title: 'レビュー' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (擬似コード)

```javascript
const { change_scope, selfcheck_path, context, focus_areas } = svArgs.wf_specific
const dir = runDir('sv-review-changes')

phase('セルフチェック確認')
const gateResult = await runSelfcheckGate(selfcheck_path, <レビュー対象の概要>)
if (gateResult) return gateResult   // 不備なら rejected、確認担当の失敗なら escalation

phase('レビュー')
const review = await agent(buildChangeReviewerPrompt({
  change_scope,
  context,
  focus_areas,
  project_memory_path: svArgs.project_memory_path,
  dir,
}), agentOpts('reviewer', 'code-review', { schema: REVIEW_RESULT_SCHEMA }))

if (review == null) {
  return {
    status: 'escalation',
    summary: 'レビュー実行失敗',
    escalation: {
      reason: 'レビュー担当エージェントが null を返した',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性',
    },
    runDir: dir,
  }
}

if (review.md_written !== true) {
  return /* 同形の escalation (runDir を付ける) */
}

// 判定 (pass / upstream_precondition_failed / change_size_too_large 等) は md 内の判定 JSON に書かれ、SV が outputPath を Read して読む
return {
  status: 'success',
  summary: review.upstream_precondition_failed === true ? '変更レビュー完了 (pass=false, 前提不成立: レビュー md を参照)' : `変更レビュー完了 (pass=${review.pass})`,
  outputPath: `${dir}/agents/code-review.md`,
}
```

**buildChangeReviewerPrompt の指示コア:**

`_prelude.js.md` の「コード diff レビュー用プロンプト」(reviewerPromptCore) を基本とし、以下を追加:

```
# 変更の背景 (レビュー時に考慮)
{{context}}

# 特に重点的に見てほしい観点
{{focus_areas を箇条書き、なければ「特になし」}}

# 変更範囲
- ファイル: {{change_scope.files}}
- git 範囲: {{change_scope.commit_range || 'uncommitted (作業ツリー)'}}

スコープ判定の手順で変更を確認してから、チェック観点と focus_areas の観点でレビューしてください。

# 大規模変更の判定
変更ファイル数または行数が閾値 (wf のプロンプトを正とする) を超える場合、
change_size_too_large=true を判定 JSON に含めてください (SV に sv-comprehensive-review を提案するため)。
```
