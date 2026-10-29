# wf: sv-comprehensive-review

## 1. 目的・想定利用シーン

変更セット全体の整合性・網羅性・ポリシー準拠を複数の観点でチェックする。既定では観点ごとに独立したレビュー担当を並列で立て、`optimize_for: 'tokens'` のときは単一のレビュー担当が全観点を 1 パスで判定する。

- sv-mode.md の wf カタログの `sv-comprehensive-review` にあたる
- `sv-implement` 完了後に SV が起動 (per-component レビューは持たないので、実装後のレビューはここが唯一)
- 変更セット全体としての整合性を確認する場所

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "change_scope": {
    "files": ["変更ファイル一覧"],
    "commit_range": "git の範囲指定 (例: <base>..HEAD)。省略か 'uncommitted' で作業ツリーの未 commit 変更 (未追跡の新規ファイルを含む)"
  },
  "selfcheck_path": "セルフチェック証跡 md のパス",
  "spec_paths": ["仕様書・要件書・設計書のパス"],
  "documentation_paths": ["更新対象のドキュメント (README, docs/*)"],
  "test_paths": ["関連テストファイル"],
  "review_lenses": ["correctness", "docs", "policy"],
  "optimize_for": "wall_clock | tokens"
}
```

- `commit_range` — 対象が git 管理外のときは無視し、`files` の全文をレビューする (変更の中身はセルフチェック証跡で伝える)
- `selfcheck_path` — SV がレビュー前に実施したセルフチェックの証跡 md (必須)。確認方法は §4、作成手順は sv-mode.md の「実施上の原則」のレビュー必須
- `review_lenses` — 判定に含める観点の配列。デフォルト (未指定・空配列) は `correctness` / `docs` / `policy` の 3 観点
- 許容値は既定 3 観点と `consistency` / `spec-coverage` / `spec-existence` / `security`。どれも独立した観点として 1 担当ずつレビューする (`consistency` / `spec-coverage` / `spec-existence` は correctness の一部を切り出したもの、`security` は独自の観点)
- 許容値外の観点や、重複した観点は args 構造不足の escalation
- チェック観点 (`_common.md §5`) は既定 3 観点で分担する。この 3 つのどれかを外すと、その観点が担うチェックも外れる (§4)
- `optimize_for` — レビューフェーズの構成 (§4)。デフォルトは `wall_clock`

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation' | 'rejected',
  summary: '総合レビュー完了 (N 観点, 不合格: ..., 前提不成立があれば観点を列挙)',
  lensMdPaths: [{ lens, mdPath, succeeded }],   // optimize_for=wall_clock のとき: 観点ごとのレビュー md (succeeded=false は担当が失敗した観点。md が無いか不完全)
  outputPath: '<run-dir>/agents/review.md',   // optimize_for=tokens のとき: 全観点をまとめた md
  escalation: {...},   // status=escalation のとき。担当起動後は runDir も返す
  rejection: { reason, selfcheck_path },   // status=rejected のとき
}
```

`status=rejected` はセルフチェック証跡の不備でレビュー本体を実施していないことを表す (`rejection.reason` に理由)。

SV は `lensMdPaths` の各 md (または `outputPath`) を Read して総合判定を確認する。集約 md は作らない。

**観点ごとの md (wall_clock) の構成:**
- ## 総合評価 (pass / NG + 1〜3 行サマリ)
- ## 判定 JSON: `{lens, pass, upstream_precondition_failed, upstream_precondition_reason, checks, findings}` (findings の各要素に重大度を持つ。重大度の語彙と pass の対応は `_common.md §5`)
- ## 早期打ち切り判断 (`upstream_precondition_failed=true` のときのみ。観点ごとのチェックは行わず pass=false)
- ## スコープ判定
- ## 発見事項 (重大度別)
- ## チェック観点の結果 (担当する観点がある lens のみ)

**review.md (tokens) の構成:**
- ## 総合評価 (overall_pass yes/no + 1〜3 行サマリ)
- ## 判定 JSON: `{overall_pass, upstream_precondition_failed, upstream_precondition_reason, lens_pass: {...}, checks, findings}` (重大度の扱いは観点ごとの md と同じ)
- ## 早期打ち切り判断 (`upstream_precondition_failed=true` のときのみ。全体で 1 つ)
- ## 観点別サマリ
- ## スコープ判定
- ## 観点別詳細 (発見事項 重大度別)
- ## チェック観点の結果
- ## 必要な追加対応 (優先度別)

## 4. 内部エージェント構成

```
[セルフチェック確認フェーズ]
  └─ agent: セルフチェック確認担当 x 1 (role: selfcheck_gate)
     入力: selfcheck_path, レビュー対象の概要
     判定: 実施したことが読み取れ、対象の規模に対して妥当か (内容の正しさは検証しない)
     不備: レビューフェーズに進まず status=rejected を返す

[レビューフェーズ: optimize_for=wall_clock (デフォルト)]
  └─ agent: 観点別レビュー担当 x 観点数 (並列)
     ロール: reviewer.md
     プロンプト: 担当観点の specialization + lens に割り当てたチェック観点
     入力: change_scope, selfcheck_path, project_root (git の実行場所), 観点ごとに絞った重点 Read 対象, spec_paths / documentation_paths / test_paths (参考資料として全観点に提示), project_memory_path (任意)
     出力: agents/review-<lens>.md
     最終応答: md の保存を確認したうえで pass と md_written と upstream_precondition_failed を schema で返す

[レビューフェーズ: optimize_for=tokens]
  └─ agent: 総合レビュー担当 x 1 (全観点を 1 パスで判定)
     ロール: reviewer.md
     プロンプト: 全観点の specialization をブロックで羅列 + 全チェック観点 (スコープ判定表で絞る)
     入力: change_scope, selfcheck_path, project_root, spec_paths, documentation_paths, test_paths, project_memory_path (任意)
     出力: agents/review.md
     最終応答: md の保存を確認したうえで overall_pass と md_written と upstream_precondition_failed を schema で返す
```

修正ループは持たない。修正は SV 側の判断で対応。

**lens ごとのチェック観点の割当 (wall_clock):**

| lens | 割り当てる観点 |
|---|---|
| correctness | n_plus_1, dry, semantic, callee_behavior, hot_path, spec, consumers |
| docs | docs |
| policy | policy, progress |
| security / consistency / spec-coverage / spec-existence | なし (各 lens 固有の観点のみ) |

- 既定の 3 lens で全観点を分担し、観点の重複実施を避ける。tokens は単一担当が全観点を持つ
- 観点の定義は `_common.md §5`。`progress` はセルフチェック証跡と spec_paths から前工程の証跡を確認し、確認できなければ `must_fix`

**2 つの構成の使い分け:**

- `wall_clock` — 観点ごとに独立した担当が並列に見るため、待ち時間が短く、観点間で視点が独立する。観点ごとに重点 Read 対象を拡張子で絞り、同じ context を何度も読む負担を抑える
- `tokens` — 対象ファイルの Read が 1 回で済み、トークン消費が少ない。代わりに 1 担当の reasoning が観点数に比例して長くなる

## 5. エスカレ条件 (wf 固有)

- **レビュー agent の null 返し** — tokens では担当が null なら escalation。wall_clock では過半数の観点が null なら escalation。過半数に満たない失敗は success のまま summary と `lensMdPaths[].succeeded` に失敗した観点を出す
- **成果物 md の未保存** — 担当が md を保存できなかった場合は失敗として扱う (tokens は escalation、wall_clock は lens の失敗)
- **チェック観点を割り当てた lens の失敗** — wall_clock で割当のある lens が 1 つでも失敗したら、失敗数が半数以下でも escalation。未確認になる観点を理由に示す。選択肢は失敗した lens を指定した再実行の 1 件
- 仕様書の欠落や commit_range の誤りは wf としてはエスカレしない。レビュー担当が判定 md に記載し、SV が読んで対応する

## 6. `meta` ブロック

```javascript
export const meta = {
  name: 'sv-comprehensive-review',
  description: '変更セット全体を複数観点でレビューして総合判定を返す',
  whenToUse: '実装完了後の総合レビュー (SV から自動起動想定)',
  phases: [
    { title: 'セルフチェック確認' },
    { title: 'レビュー' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (擬似コード)

```javascript
const { change_scope, selfcheck_path, spec_paths, documentation_paths, test_paths, review_lenses, optimize_for } = svArgs.wf_specific
const dir = runDir(_WF_NAME)

const lenses = review_lenses && review_lenses.length ? review_lenses : ['correctness', 'docs', 'policy']
if (<lenses に重複>) return argsValidationEscalation([<重複した観点>])
const optimizeFor = optimize_for || 'wall_clock'

phase('セルフチェック確認')
const gateResult = await runSelfcheckGate(selfcheck_path, <レビュー対象の概要>)
if (gateResult) return gateResult   // 不備なら rejected、確認担当の失敗なら escalation

phase('レビュー')

if (optimizeFor === 'tokens') {
  const outputPath = `${dir}/agents/review.md`
  const review = await svAgent(buildComprehensiveReviewerPrompt({ lenses, change_scope, spec_paths, documentation_paths, test_paths, outputPath }), 'reviewer', 'review', { schema: <overall_pass と md_written と upstream_precondition_failed> })
  if (review == null || review.md_written !== true) return { status: 'escalation', summary: 'レビュー実行失敗', escalation: {...}, runDir: dir }
  return { status: 'success', summary: `総合レビュー完了 (${lenses.length} 観点, optimize_for=tokens, overall_pass=...)`, outputPath }
}

const reviews = await parallel(lenses.map(lens => () =>
  svAgent(buildLensReviewerPrompt({ lens, change_scope, focusFiles: lensFocusFiles[lens], spec_paths, documentation_paths, test_paths, outputPath: `${dir}/agents/review-${lens}.md` }), 'reviewer', `review:${lens}`, { schema: <pass と md_written と upstream_precondition_failed> })
))
const lensMdPaths = lenses.map((lens, i) => ({ lens, mdPath: `${dir}/agents/review-${lens}.md`, succeeded: reviews[i] != null && reviews[i].md_written === true }))
const failedLenses = lensMdPaths.filter(p => !p.succeeded).map(p => p.lens)

if (<failedLenses にチェック観点を割り当てた lens を含む>) {
  return { status: 'escalation', summary: '<失敗した lens と未確認の観点>', lensMdPaths, escalation: {...}, runDir: dir }
}

if (failedLenses.length > lenses.length / 2) {
  return { status: 'escalation', summary: '過半数の観点でレビュー失敗 (失敗した観点を列挙)', lensMdPaths, escalation: {...}, runDir: dir }
}

return { status: 'success', summary: '総合レビュー完了 (失敗した観点・不合格の観点があれば列挙)', lensMdPaths }
```

**観点ごとの specialize:**

- `correctness`: 変更ファイル間の呼び出し関係・型整合性・データフロー整合性、spec_paths 要件との照合、public API に対応する自動テストの有無。チェック観点は上記の割当表に従う
- `docs`: documentation_paths を Read し、変更内容と乖離している記述・削除済み識別子の残存を検出。導入先の CLAUDE.md・プロジェクト規約に記載ルールがあれば、それに沿っているかも確認
- `policy`: 導入先の CLAUDE.md・プロジェクト規約と、project_memory_path (指定時) 内の規約・memory 類に照らして、変更ファイル全体が準拠しているかを一件ずつ確認

tokens では「対象ファイルの Read は 1 回だけ。複数観点を頭の中で並行適用する」ことを指示する。どちらの構成でも Read は 1 メッセージ内で並列 (multi-tool-use) 発行して往復回数を減らす。
