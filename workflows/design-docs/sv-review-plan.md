# wf: sv-review-plan

## 1. 目的・想定利用シーン

SV 自身が対話中に立てた計画・設計を、独立レビュー担当が検証する。SV 自己レビュー禁止の担保。

- SV が対話中に「じゃあ、こう変えましょう」と実装計画を立てた場合
- 設計 wf をスキップして SV 自作の計画で進めるとき、必ずこの wf を通す
- sv-mode.md の「設計を省ける条件」の実装

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "plan_path": "SV が起草した計画・設計 md のパス",
  "selfcheck_path": "セルフチェック証跡 md のパス",
  "plan_type": "design | implementation-plan | refactor-plan",
  "context": {
    "requirements": "対話で合意した要件",
    "constraints": ["制約"],
    "affected_files": ["変更対象ファイル"]
  },
  "prev_plan_path": "前バージョン計画 md のパス (省略可)",
  "prev_run_id": "前回 sv-review-plan 実行の run_id (省略可。ファイル名になる値。文字・数字で始まり、文字・数字・. _ - だけ)"
}
```

- `selfcheck_path` — SV がレビュー前に実施したセルフチェックの証跡 md (必須)。確認方法は §4、作成手順は sv-mode.md の「実施上の原則」のレビュー必須
- `plan_type` は観点を specialize するため
  - `design`: 設計としての妥当性 (責務分割・依存関係)
  - `implementation-plan`: 実装計画としての完全性 (変更手順・順序)
  - `refactor-plan`: リファクタリング計画としての安全性 (振る舞い保存)
- `prev_plan_path` / `prev_run_id` は diff レビューモードの起動条件
  - `prev_plan_path` を明示指定すると、そのパスを前バージョンとして diff モードで起動する
  - `prev_plan_path` 未指定で `prev_run_id` を指定すると、前回実行が自動保存したスナップショット (§4 参照) を前バージョンとして採用する
  - `prev_plan_path` 明示指定がある場合はそちらを優先する (`prev_run_id` より優先)
  - 両方とも未指定ならフルモード (毎回フル監査)
  - 前バージョンが Read で読めない場合 (パス誤り・スナップショット未生成など) は、レビュー担当がその場でフルモードにフォールバックする (§5 参照)。SV 側での事前存在確認は不要

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation' | 'rejected',
  summary: '計画レビュー完了 (verdict=...)',
  outputPath: '<run-dir>/agents/plan-review.md',   // レビュー担当が書いた md
  escalation: {...},   // 担当起動後は runDir も返す
  rejection: { reason, selfcheck_path },
}
```

`status=rejected` はセルフチェック証跡の不備でレビュー本体を実施していないことを表す (`rejection.reason` に理由)。

SV は `outputPath` を Read してレビュー結果と判定 JSON を確認する。集約 md は作らない。

**plan-review.md の構成の参考 (フルモード):**

~~~markdown
# 計画レビュー結果: <案件名>

## 判定
- 通過: pass / conditional-pass / NG
- pass: 提案 (suggestion) だけ。そのまま実装可
- conditional-pass: 要修正 (must_fix) だけで、いずれも局所的な追記・修正で解消できる。不合格として扱う
- NG: ブロッカー (blocker) がある、または上流の前提不成立・計画ファイル読取不可。不合格として扱う
- NG と conditional-pass は、SV が修正してから diff モードで再レビューする

## 判定 JSON
```json
{
  "verdict": "pass" | "conditional-pass" | "NG",
  "checks": {観点キー: {"status": "ok|issue|na", "detail": "..."}},
  "revisions": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}],
  "upstream_precondition_failed": true | false,
  "upstream_precondition_reason": "..." | null,
  "plan_type_mismatch": true | false,
  "plan_path_unreadable": true | false,
  "review_mode": "full"
}
```

## 対象計画のサマリ
(plan_path の要約)

## 計画種別観点別詳細
### plan_type に応じた観点
- 責務分割の妥当性 (design)
- 実装順序の妥当性 (implementation-plan)
- 振る舞い保存性 (refactor-plan)

## チェック観点
観点キーごとに ok / issue / na + 詳細 (観点は `_common.md §5`。計画に該当しない観点は na + 理由)

## 修正指示
- 場所: <plan_path 内の該当箇所>
- 指摘: ...
- 修正案: ...

~~~

**diff モード起動時の追加差分:**

- `prev_plan_path` / `prev_run_id` のいずれかで前バージョンが解決された場合、レビュー担当は §4 の手順に従い diff の範囲に絞ったレビューを行う (局所的でないと判断すればフル監査にフォールバックする)
- 前回レビュー結果 md (前回指摘一覧) を参照できた場合のみ、「チェック観点」と「修正指示」の間に「## 指摘解消の検証」節を追加し、前回指摘の各項目について解消/未解消と根拠を記載する。参照できなければこの節は出力しない
- 判定 JSON には `review_mode: "diff" | "full"` (局所的でなければ agent 判断で `"full"` にフォールバックする) と `prev_run_lookup_error: string | null` (前バージョンが読めなかった理由。読めた場合は `null`) を追加する。前回レビュー結果 md を参照できた場合のみ `revision_items_resolved: [{ instruction, resolved, evidence }]` も追加する

```json
{
  "verdict": "pass" | "conditional-pass" | "NG",
  "checks": {観点キー: {"status": "ok|issue|na", "detail": "..."}},
  "revisions": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}],
  "upstream_precondition_failed": true | false,
  "upstream_precondition_reason": "..." | null,
  "plan_type_mismatch": true | false,
  "plan_path_unreadable": true | false,
  "review_mode": "diff" | "full",
  "revision_items_resolved": [{"instruction": "...", "resolved": true | false, "evidence": "..."}],
  "prev_run_lookup_error": "..." | null
}
```

## 4. 内部エージェント構成

```
[セルフチェック確認フェーズ]
  └─ agent: セルフチェック確認担当 x 1 (role: selfcheck_gate)
     入力: selfcheck_path, レビュー対象の概要
     判定: 実施したことが読み取れ、対象の規模に対して妥当か (内容の正しさは検証しない)
     不備: レビューフェーズに進まず status=rejected を返す

[レビューフェーズ]
  └─ agent: 計画レビュー担当 x 1
     ロール: reviewer.md
     プロンプト: plan_type に応じた specialize + チェック観点 (diffモードは追加手順あり、下記)
     入力: plan_path (Read で内容取得), context, project_memory_path (任意),
           (diff モード時) prev_plan_path または prev_run_id から解決した前バージョンパス
     出力: agents/plan-review.md (wf 返り値の outputPath として返す)
           agents/plan-snapshot.md (次回以降の diff レビュー用スナップショット)
     最終応答: md の保存を確認したうえで verdict と md_written を schema で返す
```

**修正ループなし** — 計画のレビューであって、修正は SV に返して SV が対応。

**plan_path 可読性確認 (モード共通・最初のステップ):**

レビュー担当は他の手順に入る前に `plan_path` を Read で確認する。読めない場合はレビューを行わず、判定 JSON の `plan_path_unreadable` に true を、verdict に `"NG"` を設定し、理由のみを記載した md を出力する (§5「エスカレ条件」参照)。

**スナップショット保存 (モード共通、plan_path が読めた場合の次のステップ):**

レビュー担当は本題のレビューに入る前に、Bash で `mkdir -p <snapshot_dir> && cp <plan_path> <snapshot_path>` (コマンド置換を使わない形) を実行し、`plan_path` の内容を `agents/plan-snapshot.md` にコピーする。次回以降の `prev_run_id` 指定による自動 diff モード起動のために、モードによらず毎回実施する。コピーに失敗しても判定には影響させず、ログにのみ残す (wf 側に FS API がなく成否を検証できないため)。

**diff モード時のレビュー手順:**

1. 前バージョン計画 md が Read で読めるか確認する。読めなければフルモードにフォールバックし (チェック観点を含むフル監査を実施)、判定 JSON の `prev_run_lookup_error` に理由を記録する
2. Bash で `diff <前バージョン> <plan_path>` を実行し変更差分を把握する
3. 前回レビュー結果 md (`prev_plan_path` と同じディレクトリの `plan-review.md`、または `prev_run_id` に対応する run の `plan-review.md`) が読めれば、前回指摘 (`revisions`) の各項目が今回の diff で解消されているかを個別に検証する (解消/未解消 + 根拠)。読めない場合、または前回の判定 JSON で `plan_path_unreadable` か `upstream_precondition_failed` が true の場合は、前回の監査範囲を信頼できないので、フル監査に切り替えて `prev_run_lookup_error` に理由を記録する
4. 差分が「指摘への対応 + その直接の波及範囲」に収まり局所的かを判定する。新規セクション追加・方針変更・広範な書き換えがあれば局所的ではないと判断する
5. 局所的なら diff に現れた箇所のみ新規監査し、それ以外の箇所は前回 pass を信頼して再監査しない (前バージョン計画 md 自体は今回入力にないため、SV が前回の sv-review-plan 結果を信頼している前提)。局所的でない、前バージョン計画 md が読めない、または前回結果を信頼できない場合は、チェック観点を含むフル監査に切り替える。diff に現れない箇所を探しに行く監査はしないが、作業中に気づいた問題は `additional_findings` に記載する (重大なら `revisions`)

## 5. エスカレ条件 (wf 固有)

- **plan_path が読めない** — レビュー担当が判定 JSON の `plan_path_unreadable` に true を記録して verdict を NG とする。SV は `outputPath` を Read した際にこれを確認し、plan_path を確認要求する
- **plan_type と実際の内容が乖離** — レビュアーが「これは design ではなく implementation-plan では?」と判断
  → SV に plan_type の再確認を求める
- **前バージョン計画 md が読めない (`prev_plan_path` 直接指定・`prev_run_id` 経由のいずれの場合も含む)、または前回結果を信頼できない** — エスカレしない。レビュー担当がその場でフル監査にフォールバックし、判定 JSON の `prev_run_lookup_error` に理由を記録する
- **上流の前提不成立** — レビュー担当が判定 JSON の `upstream_precondition_failed` に true を記録して verdict を NG とする。SV は `outputPath` を Read した際にこれを確認する
- **レビュー担当が md を保存できなかった (`md_written=false`)** — escalation。選択肢は再実行の 1 件

## 6. `meta` ブロック案

```javascript
export const meta = {
  name: 'sv-review-plan',
  description: 'SV 自作の計画・設計を独立レビューして通過判定を返す',
  whenToUse: 'SV が対話中に計画を立てた後、実装に入る前 (設計スキップ時の必須ステップ)',
  phases: [
    { title: 'セルフチェック確認' },
    { title: 'レビュー' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (擬似コード)

```javascript
const { plan_path, selfcheck_path, plan_type, context, prev_plan_path, prev_run_id } = svArgs.wf_specific
const dir = runDir('sv-review-plan')
if (prev_run_id != null && <fileNameErrors('args.wf_specific.prev_run_id', prev_run_id) が空でない>) return argsValidationEscalation(<そのエラー>)

phase('セルフチェック確認')
const gateResult = await runSelfcheckGate(selfcheck_path, <レビュー対象の概要>)
if (gateResult) return gateResult   // 不備なら rejected、確認担当の失敗なら escalation
const snapshotDir = `${dir}/agents`
const snapshotPath = `${snapshotDir}/plan-snapshot.md`

// diff モードの入力解決 (パス構築は文字列連結のみ、実在確認はレビュー担当が Bash 経由で行う)。
// prev_plan_path 明示指定を prev_run_id 経由より優先する。
let resolvedPrevPlanPath = null
let resolvedPrevReviewPath = null
if (prev_plan_path) {
  resolvedPrevPlanPath = prev_plan_path
  resolvedPrevReviewPath = `${dirname(prev_plan_path)}/plan-review.md`
} else if (prev_run_id) {
  const prevAgentsDir = `${svArgs.tmp_base_dir}/wf-sv-review-plan/${prev_run_id}/agents`
  resolvedPrevPlanPath = `${prevAgentsDir}/plan-snapshot.md`
  resolvedPrevReviewPath = `${prevAgentsDir}/plan-review.md`
}
const diffMode = resolvedPrevPlanPath != null

phase('レビュー')
const review = await agent(buildPlanReviewerPrompt({
  plan_path,
  plan_type,
  context,
  project_memory_path: svArgs.project_memory_path,
  snapshotPath,
  resolvedPrevPlanPath,   // null ならフルモード
  resolvedPrevReviewPath, // 前回指摘解消確認の入力 (読めなければ検証省略)
  dir,
}), agentOpts('reviewer', `plan-review:${plan_type}${diffMode ? ':diff' : ''}`, { schema: <verdict と md_written> }))

if (review == null) {
  return {
    status: 'escalation',
    summary: '計画レビュー実行失敗',
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

// verdict は schema で受け取り summary に出す。詳細は outputPath の判定 JSON を SV が Read して確認する
return {
  status: 'success',
  summary: `計画レビュー完了 (verdict=${review.verdict})`,
  outputPath: `${dir}/agents/plan-review.md`,
}
```

**buildPlanReviewerPrompt の plan_type 別 specialize:**

- `design`:
  - 責務分割: 各モジュール/クラスが単一責務か
  - 依存関係: 循環依存はないか、依存方向は妥当か
  - 抽象化: 過剰抽象・過小抽象がないか
- `implementation-plan`:
  - 変更順序: 依存を尊重しているか
  - 変更範囲の網羅性: 影響ファイルの列挙は十分か
  - 途中状態の妥当性: 中間状態でシステムが壊れないか
- `refactor-plan`:
  - 振る舞い保存: 外部から見える振る舞いが変わらないか
  - テストによる裏付け: リファクタ前後でテストが通り続けるか
  - 影響範囲: 隠れた依存はないか

いずれの plan_type でも `_common.md §5` の観点 (`progress` 以外の全観点) をチェック観点として含める。

**buildPlanReviewerPrompt のモード分岐:**

- 共通の最初の指示として、`plan_path` の可読性確認 (読めなければ `plan_path_unreadable: true` で即 NG、§5 参照) と、`snapshotPath` への `mkdir -p` + `cp` (§4「スナップショット保存」参照) を両モードとも指示する
- `resolvedPrevPlanPath` が null ならフルモード用プロンプト (§3 の節構成 + `review_mode: "full"`)
- `resolvedPrevPlanPath` があれば diff モード用プロンプト (§4「diff モード時のレビュー手順」の 5 ステップを指示し、`resolvedPrevReviewPath` の有無で「## 指摘解消の検証」節と `revision_items_resolved` の要否を切り替える)
