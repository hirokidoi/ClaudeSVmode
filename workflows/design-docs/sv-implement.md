# wf: sv-implement

## 1. 目的・想定利用シーン

設計に基づく実装。複数コンポーネントを依存順のバッチ単位で並列に実装し、変更済みファイル一覧と個別 impl md への path を返す。品質担保は後段の sv-comprehensive-review に一本化する (per-component レビューは持たない)。

- 設計が確定した後の実装フェーズ
- 複数ファイル/コンポーネントに変更が必要
- sv-mode.md の wf カタログの `sv-implement` にあたる

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "design_path": "設計書 md のパス (sv-design の outputPath 等)",
  "components": [
    {
      "name": "コンポーネント名 (エージェント区別用。ファイル名になる値で、文字・数字で始まり、文字・数字・. _ - だけ)",
      "files": ["変更対象ファイルパス"],
      "description": "このコンポーネントで実現する変更",
      "dependencies": ["先行完了が必要な他コンポーネント名"]
    }
  ],
  "run_tests_after": true,
  "test_commands": [
    "<プロジェクトのテストコマンド>",
    { "command": "<ビルドのコマンド>", "kind": "build | test | launch", "cwd": "<実行場所の絶対パス>" }
  ],
  "test_timing": "post-pipeline | per-component",
  "commit_strategy": "per-component | all-at-once | none"
}
```

- `components` を分けることで並列実装可能
- `dependencies` で順序制約を表現 (空なら独立実装可)
- 各要素の `name` と `description` は必須。`name` が重複している、または `dependencies` に存在しない `name` があると、args 構造不足の escalation を返す
- `files` は省略可。省略時、実装担当は設計書から、テスト担当は対象を「未指定」として、commit 担当は実装 md の「変更ファイル一覧」から対象を特定する
- `test_commands` は `run_tests_after=true` のとき必須 (未指定または空は args 構造不足の escalation)。要素は文字列か `{ command, kind, cwd }`。文字列は `{ command: <文字列>, kind: 'test' }` と同じ。`kind` は `build` / `test` / `launch` (省略時 `test`)、`cwd` は実行場所の絶対パス (省略時は `project_root`、それも無ければ作業ディレクトリ)。`command` が空・`kind` が許容外・`cwd` が絶対パスでない・知らないキー・文字列でもオブジェクトでもない要素は args 構造不足
- `test_timing` — test 実行タイミング (詳細は _common.md §20)
  - `post-pipeline` (デフォルト): 全コンポーネントの実装完了後にまとめて 1 回
  - `per-component`: 各コンポーネントの impl 直後に実行 (依存無し前提)
- `commit_strategy` — wf 内で git commit まで行うか
  - `per-component`: コンポーネントごとに 1 commit
  - `all-at-once`: 全体で 1 commit
  - `none`: SV が後で commit (デフォルト)

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation' | 'checkpoint_stop',
  summary: 'N コンポーネント実装完了',
  componentOutputs: [
    {
      name: 'コンポーネント名',
      succeeded: true | false,
      implMdPath: '<run-dir>/loop/<name>-round-1-impl.md' | null,   // 実装担当が失敗した (impl_failed) コンポーネントは null
      perComponentTestMdPath: '<run-dir>/agents/test-<name>.md' | null,
      error: 'impl_failed' | 'design_mismatch' | 'test_failed' | null,
    },
    ...
  ],
  postPipelineTestMdPath: '<run-dir>/agents/test-all.md' | null,
  commitMdPath: '<run-dir>/agents/commit.md' | null,   // commit_strategy='none'、または commit 担当が null を返したとき null
  escalation: {...},   // status=escalation のとき
  checkpoint: {...},   // status=checkpoint_stop のとき
}
```

SV は各 `implMdPath` を Read して変更内容を確認し、`postPipelineTestMdPath` でテスト結果を確認する。集約 md は作らない。

コンポーネントの失敗で escalation を返すときも `componentOutputs` を含める (成功分の `implMdPath` と、失敗分の `error` が分かる)。`design_mismatch` のコンポーネントも `implMdPath` を返し、乖離の理由はその md の判定 JSON にある。

**各 impl md の構成 (実装担当が生成):**
- ## 担当コンポーネント
- ## 変更ファイル一覧 (追加/削除行数)
- ## 変更内容の要約 (Before/After)
- ## 未解決事項 (あれば)
- ## 判定 JSON: `{component, files_changed, design_mismatch, design_mismatch_reason}`

## 4. 内部エージェント構成

```
[バッチ実行] コンポーネントを依存の段ごとにバッチ化し、バッチ内は並列、バッチ間は直列で実行
  各コンポーネント:
    [実装フェーズ]
      └─ agent: 実装担当 x 1
         ロール: implementer.md
         入力: design_path + component 情報
         出力: 実ファイルへの変更 + loop/<name>-round-1-impl.md (変更サマリ)

    (test_timing='per-component' の場合)
    [テストフェーズ (per-component)]
      └─ agent: テスト実行担当 x 1
         ロール: verifier.md
         入力: test_commands (正規化した手順)
         出力: agents/test-<name>.md

[全コンポーネント完了後]
  [テストフェーズ (post-pipeline)] run_tests_after=true かつ test_timing='post-pipeline' (デフォルト) のとき
    └─ agent: テスト実行担当 x 1
       ロール: verifier.md
       入力: test_commands (正規化した手順)
       出力: agents/test-all.md

  [commit フェーズ] commit_strategy != 'none' のとき
    └─ agent: commit 担当 x 1
       Bash 使用可
       戦略に応じて git add + git commit
```

**品質担保の分担:**

per-component のレビューは持たない。品質は以下で担保する:
- 実装担当の self-check (プロンプトで必須項目を明示)
- post-pipeline テスト実行 (テスト failure で escalation)
- 実装後の sv-comprehensive-review (SV が別 wf として起動)

**test_timing の使い分け** (詳細は _common.md §20):
- デフォルト `post-pipeline`: 依存を持つコンポーネント同士でも false-fail が出ない
- `per-component`: 全コンポーネントが完全に独立している場合のみ選択

**並列度:**

- 依存関係のないコンポーネントは同時実行 (Workflow の `parallel`)
- dependencies を尊重して、依存の段ごとにバッチ化する。バッチ内は並列、バッチ間は前のバッチの完了を待つ

## 5. エスカレ条件 (wf 固有)

- **設計書と実装対象ファイルの乖離** — 実装担当が「設計書に記載のないファイルが変更対象になっている」を検出 (`design_mismatch=true`)。バッチ数に関係なく、検出したバッチの完了時点で即エスカレ
  → 設計フェーズに戻すべき (エスカレで再設計推奨)。理由に該当コンポーネント名を示す
- **テスト失敗** — per-component / post-pipeline のどちらかで test が失敗。判定はテスト担当の構造化出力 (`pass`) で行う
  → 判断書に「実装は完了、テスト失敗」を明示 (実装のやり直しか、テスト側の見直しかを SV に選択させる)。componentOutputs と postPipelineTestMdPath も返す
- **commit 失敗** — commit 担当が null を返すか pass=false を報告したとき。runDir・componentOutputs・postPipelineTestMdPath・commitMdPath (commit 担当が null のときは null) を返す
- **post-pipeline テストが実行されない** — テスト担当が null を返したとき。テスト未実施のまま commit に進まず、componentOutputs を返してエスカレ
- **コンポーネントの失敗** — 複数バッチのときは失敗したバッチで後続をスキップしてエスカレ。バッチが 1 つでも、失敗したコンポーネントがあればテストと commit に進まずエスカレ (summary に失敗したコンポーネント名)
- **循環依存** — components の dependencies に循環を検出したら即エスカレ
- **test_commands 未指定・不正** — `run_tests_after=true` で test_commands が無いとき、または要素の形が不正なときは args 構造不足

## 6. `meta` ブロック

```javascript
export const meta = {
  name: 'sv-implement',
  description: '設計から依存順のバッチ単位で並列に実装し、コンポーネント別 md 一覧と post-pipeline テスト結果 md を返す',
  whenToUse: '設計確定後の実装フェーズ',
  phases: [
    { title: '実装' },
    { title: 'テスト' },
    { title: 'コミット' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (擬似コード)

```javascript
const { design_path, components, run_tests_after, test_commands, test_timing, commit_strategy } = svArgs.wf_specific
const dir = runDir(_WF_NAME)

const { steps: testSteps, errors: testCommandErrors } = normalizeTestCommands(test_commands || [])   // 文字列は { command, kind: 'test' }。要素の形の不正をエラーにする
const wfSpecificErrors = <components の name の重複 + name のファイル名検査 (fileNameErrors) + dependencies に存在しない name + run_tests_after=true なのに test_commands が空> + testCommandErrors
if (wfSpecificErrors.length > 0) return argsValidationEscalation(wfSpecificErrors)
const testTiming = test_timing || 'post-pipeline'
const batches = topoSortToBatches(components)   // dependencies を尊重

async function implementComponent(comp) {
  const impl = await svAgent(buildImplementerPrompt({ comp, design_path, dir }),
    'implementer', `impl-${comp.name}`, { schema: IMPLEMENTER_SCHEMA })   // design_mismatch: boolean を必須で返させる
  if (impl == null) return { comp, error: 'impl_failed' }
  if (impl.design_mismatch) return { comp, error: 'design_mismatch', implMdPath: <impl md のパス> }   // 乖離の理由は impl md の判定 JSON。バッチ完了時にエスカレ

  let testResult = null
  if (run_tests_after && testTiming === 'per-component') {
    testResult = await svAgent(buildTestRunnerPrompt({ testSteps, comp, dir }),
      'test_runner', `test-${comp.name}`, { schema: TEST_RUNNER_SCHEMA })   // pass: boolean を必須で返させる
    if (testResult == null) return { comp, error: 'test_failed', implMdPath: <impl md のパス> }
  }
  return { comp, succeeded: true, testResult, implMdPath: `${dir}/loop/${comp.name}-round-1-impl.md` }
}

const componentResults = []
const buildComponentOutputs = () => componentResults.map(r => ({
  name: r.comp.name,
  succeeded: !!r.succeeded,
  implMdPath: r.implMdPath || null,
  perComponentTestMdPath: r.testResult ? `${dir}/agents/test-${r.comp.name}.md` : null,
  error: r.error || null,
}))

for (const batch of batches) {
  const batchResults = (await parallel(batch.map(comp => () => implementComponent(comp))))
    .map((r, i) => r ?? { comp: batch[i], error: 'impl_failed' })   // parallel() は失敗した thunk を null で返す
  componentResults.push(...batchResults)
  if (<バッチ内に design_mismatch あり>) return escalation(..., buildComponentOutputs())   // バッチ数に関係なく即エスカレ
  if (batchResults.some(r => !r.succeeded) && batches.length > 1) return escalation(..., buildComponentOutputs())   // 後続バッチをスキップ
}

if (componentResults.some(r => !r.succeeded)) return escalation(..., buildComponentOutputs())   // 失敗したコンポーネント名を summary に。テストと commit は行わない

// post-pipeline test
let postPipelineTestResult = null
let postPipelineTestMdPath = null
if (run_tests_after && testTiming === 'post-pipeline') {
  postPipelineTestResult = await svAgent(buildTestRunnerPrompt({ testSteps, dir }), 'test_runner', 'test-all', { schema: TEST_RUNNER_SCHEMA })   // pass: boolean を必須で返させる
  if (postPipelineTestResult == null) return escalation(..., { componentOutputs: buildComponentOutputs() })   // テスト未実施のまま commit に進まない
  postPipelineTestMdPath = `${dir}/agents/test-all.md`
}

// テスト失敗はテスト担当の構造化出力 (pass=false) で判定する
if (<per-component か post-pipeline のテスト結果に pass=false>) {
  return escalation(..., { componentOutputs: buildComponentOutputs(), postPipelineTestMdPath })   // 実装は完了、テスト失敗
}

const componentOutputs = buildComponentOutputs()

// commit
let commitMdPath = null
if (commit_strategy && commit_strategy !== 'none') {
  const commitResult = await svAgent(buildCommitPrompt({ componentResults, commit_strategy, dir }), 'committer', 'commit', { schema: COMMITTER_SCHEMA })   // pass: boolean を必須で返させる
  commitMdPath = `${dir}/agents/commit.md`
  if (commitResult == null || !commitResult.pass) return escalation(..., { runDir: dir, componentOutputs, postPipelineTestMdPath, commitMdPath: commitResult == null ? null : commitMdPath })   // 実装は完了、commit 失敗
}

if (svArgs.checkpoint_declarations?.includes('implemented')) {
  return { status: 'checkpoint_stop', summary: '実装完了、ユーザ確認待ち', componentOutputs, postPipelineTestMdPath, commitMdPath, checkpoint: { name: 'implemented', reason: 'ユーザ宣言のチェックポイント' } }
}
return { status: 'success', summary: `${components.length} コンポーネント実装完了`, componentOutputs, postPipelineTestMdPath, commitMdPath }
```

**topoSortToBatches の想定:**

- 入力: `components` 配列 (`dependencies` フィールド付き)
- 出力: 実行可能な batch の配列 (batch 内は並列、batch 間は順次)
- 循環依存を検出したら例外

## 8. wf 固有の追加考慮事項

**commit メッセージ生成:**

- commit 担当エージェントは導入先の CLAUDE.md・プロジェクト規約に従ってメッセージを書く (規約が無ければ直近の commit の書式に合わせる)

**ファイル競合の回避:**

- 同一ファイルを 2 コンポーネントが変更する可能性がある場合、SV が依存関係で順序を明示するか、`components` 定義時に統合する (wf は競合を検出しない)

**components 分割の目安:**

- 2〜3 個を上限として粗く切る。細かく分けると agent 数が線形に増え、per-component の text 生成コストが積み上がる
- 依存関係のフラットな 1 バッチで並列実行できる粒度を狙う
