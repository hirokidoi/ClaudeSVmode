export const meta = {
  name: 'sv-implement',
  description: '設計から依存順のバッチ単位で並列に実装し、コンポーネント別 md 一覧と post-pipeline テスト結果 md を返す',
  whenToUse: '設計確定後の実装フェーズ',
  phases: [
    { title: '実装' },
    { title: 'テスト' },
    { title: 'コミット' },
  ],
  argsSchema: {
    wf_specific: {
      design_path: { type: 'string', required: true, description: '設計書 md のパス (sv-design の outputPath 等)' },
      components: {
        type: 'array',
        required: true,
        description: 'name/files/description/dependencies を持つオブジェクト配列',
        items: { type: 'object', properties: { name: { type: 'string', required: true }, files: { type: 'array', required: false, items: { type: 'string' } }, description: { type: 'string', required: true }, dependencies: { type: 'array', required: false, items: { type: 'string' } } } },
      },
      run_tests_after: { type: 'boolean', required: false, description: 'テスト実行するか (デフォルト false)' },
      test_commands: { type: 'array', required: false, description: 'run_tests_after=true のとき実行する手順の配列。要素は文字列か { command, kind: build|test|launch, cwd }。文字列は kind=test。cwd の既定は project_root' },
      test_timing: { type: 'enum', values: ['post-pipeline', 'per-component'], required: false, description: 'デフォルト post-pipeline (全 impl 完了後に 1 回)' },
      commit_strategy: { type: 'enum', values: ['per-component', 'all-at-once', 'none'], required: false, description: 'デフォルト none' },
    },
  },
}

// 本体からは meta を参照できないため meta.name と同じ値を持つ
const _WF_NAME = 'sv-implement'

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    design_path: { type: 'string', required: true },
    components: { type: 'array', required: true, items: { type: 'object', properties: { name: { type: 'string', required: true }, files: { type: 'array', required: false, items: { type: 'string' } }, description: { type: 'string', required: true }, dependencies: { type: 'array', required: false, items: { type: 'string' } } } } },
    run_tests_after: { type: 'boolean', required: false },
    test_commands: { type: 'array', required: false },
    test_timing: { type: 'enum', values: ['post-pipeline', 'per-component'], required: false },
    commit_strategy: { type: 'enum', values: ['per-component', 'all-at-once', 'none'], required: false },
  },
}

// >>> sv-prelude:core
// ============================================================================
// SV workflow prelude
// ============================================================================

// 呼び出し側の渡し方の揺れ (オブジェクト / JSON 文字列 / 二重エンコード) を吸収する
function parseSvArgs(raw) {
  let value = raw
  try {
    while (typeof value === 'string') value = JSON.parse(value)
  } catch (e) {
    return null
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

const svArgs = parseSvArgs(args)

const KIT_DIR = '~/.claude'

const CHECKPOINT_NAMES = ['investigated', 'ui_prototyped', 'designed', 'implemented']

const COMMON_ARGS_SCHEMA = {
  tmp_base_dir: { type: 'string', required: true },
  run_id: { type: 'string', required: true },
  project_memory_path: { type: 'string', required: false },
  project_root: { type: 'string', required: false },
  stacks: { type: 'array', required: false, items: { type: 'string' } },
  checkpoint_declarations: { type: 'array', required: false, items: { type: 'enum', values: CHECKPOINT_NAMES } },
  complexity_profile: { type: 'enum', values: ['light', 'standard', 'deep'], required: false },
  model_overrides: { type: 'object', required: false },
  wf_specific: { type: 'object', required: true },
}

const TYPE_CHECKS = {
  string: v => typeof v === 'string',
  number: v => typeof v === 'number',
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => typeof v === 'object' && !Array.isArray(v),
}

const ROLE_MODEL_DEFAULTS = {
  investigator: 'sonnet',
  designer: undefined,
  implementer: 'sonnet',
  reviewer: undefined,
  critique: undefined,
  judge: undefined,
  ui_designer: undefined,
  ui_reviewer: undefined,
  committer: 'sonnet',
  test_runner: 'sonnet',
  selfcheck_gate: 'sonnet',
}

// ファイル名とシェルの引数にそのまま埋め込む値の許容文字
const FILE_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u

function fileNameErrors(path, value) {
  if (typeof value === 'string' && FILE_NAME_PATTERN.test(value)) return []
  return [`${path}=${JSON.stringify(value)} はファイル名に使えない (使える文字: 文字・数字・. _ -。先頭は文字か数字)`]
}

function validateArgs(schema) {
  const errors = []
  const checkOne = (path, val, spec) => {
    if (spec.required && (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0))) errors.push(`${path} が不足 (required)`)
    if (val === undefined || val === null) return
    if (spec.type === 'enum') {
      if (!spec.values.includes(val)) errors.push(`${path}=${JSON.stringify(val)} は許容値 ${spec.values.join('|')} 外`)
      return
    }
    if (TYPE_CHECKS[spec.type] && !TYPE_CHECKS[spec.type](val)) {
      errors.push(`${path} の型が ${spec.type} ではない`)
      return
    }
    for (const [key, sub] of Object.entries(spec.properties || {})) {
      checkOne(`${path}.${key}`, val[key], sub)
    }
    if (spec.items) val.forEach((el, i) => checkOne(`${path}[${i}]`, el, { ...spec.items, required: true }))
  }
  for (const [key, spec] of Object.entries(COMMON_ARGS_SCHEMA)) {
    checkOne(`args.${key}`, svArgs[key], spec)
  }
  const wfSpecificSchema = (schema && schema.wf_specific) || {}
  const wfSpecificVal = svArgs.wf_specific || {}
  for (const [key, spec] of Object.entries(wfSpecificSchema)) {
    checkOne(`args.wf_specific.${key}`, wfSpecificVal[key], spec)
  }
  if (typeof svArgs.run_id === 'string') errors.push(...fileNameErrors('args.run_id', svArgs.run_id))
  if (Array.isArray(svArgs.stacks)) {
    const names = svArgs.stacks.filter(n => typeof n === 'string')
    names.forEach(n => errors.push(...fileNameErrors('args.stacks', n)))
    const dups = names.filter((n, i) => names.indexOf(n) !== i)
    if (dups.length > 0) errors.push(`args.stacks に重複: ${[...new Set(dups)].join(', ')}`)
  }
  const overrides = svArgs.model_overrides
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const roles = Object.keys(ROLE_MODEL_DEFAULTS)
    for (const key of Object.keys(overrides)) {
      if (!roles.includes(key)) errors.push(`args.model_overrides.${key} は未知の役割 (許容: ${roles.join('|')})`)
    }
  }
  return errors
}

function argsValidationEscalation(errors) {
  return {
    status: 'escalation',
    summary: `args 構造不足: ${errors.length} 件`,
    escalation: {
      reason: 'wf 起動引数のスキーマ検証エラー',
      details: errors,
      options: [
        { title: 'args を修正して再起動', description: '不足キー・型・enum 違反を補って再送', tradeoffs: 'SV での args 組み立て見直し', effort: '小' },
      ],
      recommendation: 0,
      reasoning: 'スキーマ不足は SV 側の args 組み立てミス',
    },
  }
}

const _validationErrors = svArgs
  ? validateArgs(_WF_ARGS_SCHEMA)
  : ['args を JSON オブジェクトとして解釈できない (args はオブジェクトをそのまま渡す。USAGE.md「起動契約」参照)']
if (_validationErrors.length > 0) {
  return argsValidationEscalation(_validationErrors)
}

function modelFor(role) {
  if (svArgs.complexity_profile === 'light') return 'sonnet'
  if (svArgs.complexity_profile === 'deep') return undefined
  if (svArgs.model_overrides && role in svArgs.model_overrides) {
    return svArgs.model_overrides[role] || undefined
  }
  return ROLE_MODEL_DEFAULTS[role]
}

function agentOpts(role, label, extra) {
  const opts = { label, ...(extra || {}) }
  const m = modelFor(role)
  if (m) opts.model = m
  return opts
}

function runDir(wfName) {
  return `${svArgs.tmp_base_dir}/wf-${wfName}/${svArgs.run_id}`
}

function stackPackBlock(reader) {
  const stacks = svArgs.stacks || []
  if (stacks.length === 0) return ''
  return `
# スタックパック (必読)
このプロジェクトの技術スタック: ${stacks.join(', ')}

ロール定義を読んだあと、スタックごとに次を行ってください:
1. ${KIT_DIR}/stacks/<スタック名>/index.md を Read する
2. index.md の「読むファイル」の表のうち、読み手が ${reader} の行のファイルを、index.md と同じディレクトリから Read する。条件が付いた行は、条件の目印を対象のプロジェクトで確かめ、当てはまるときだけ読む

パックはロール定義を補う知識です。ロール定義や本プロンプトの指定と食い違うときは、そちらに従ってください。
index.md が存在しないスタックは読まずに続け、成果物に「スタックパック未配置: <スタック名>」と書いてください。
`.trim()
}

// role はロールファイル名 (拡張子なし)
function roleSection(role, note) {
  const head = `
# ロール定義 (必読)
以下ファイルを Read で全文読み、指示を全て守ってください。出力形式は本プロンプトの指定を正とします:
- ${KIT_DIR}/roles/${role}.md
`.trim()
  return [head, note, stackPackBlock(role)].filter(Boolean).join('\n\n')
}

// 返り値の形式を持たない担当にも、返り値を提出させるための最小の形式
const COMPLETION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
}

function mailboxDir(name) {
  return `${runDir(_WF_NAME)}/mailbox/${name}`
}

function mailboxBlock(name) {
  const dir = mailboxDir(name)
  return `
# 連絡帳 (必読)
- 担当名: ${name}
- 連絡帳のフォルダ: ${dir}
  - inbox.md: SV から担当への連絡
  - outbox.md: 担当から SV への連絡

作業を始める前に、inbox.md と outbox.md を Read してください (無いファイルは飛ばす)。続けて規則 ${KIT_DIR}/workflows/mailbox/rules.md を Read し、従ってください。
`.trim()
}

// extra.mailbox は label と担当名が一致しない場合の担当名
function svAgent(prompt, role, label, extra) {
  const { mailbox, ...rest } = extra || {}
  const name = mailbox || label.replace(/:/g, '-')
  return agent(`${prompt}\n\n${mailboxBlock(name)}`, agentOpts(role, label, rest))
}
// <<< sv-prelude:core

// トポロジカルソートで dependencies を尊重した batch を作る
function topoSortToBatches(components) {
  const name2comp = {}
  for (const c of components) name2comp[c.name] = c
  const remaining = new Set(components.map(c => c.name))
  const batches = []
  while (remaining.size > 0) {
    const batch = []
    for (const name of remaining) {
      const c = name2comp[name]
      const deps = c.dependencies || []
      if (deps.every(d => !remaining.has(d))) batch.push(c)
    }
    if (batch.length === 0) {
      throw new Error(`Circular dependency detected among: ${Array.from(remaining).join(', ')}`)
    }
    for (const c of batch) remaining.delete(c.name)
    batches.push(batch)
  }
  return batches
}

const TEST_STEP_KINDS = ['build', 'test', 'launch']
const TEST_STEP_KEYS = ['command', 'kind', 'cwd']

function normalizeTestCommands(list) {
  const steps = []
  const errors = []
  list.forEach((el, i) => {
    const path = `args.wf_specific.test_commands[${i}]`
    if (typeof el === 'string') {
      if (el === '') errors.push(`${path} が空文字`)
      else steps.push({ command: el, kind: 'test', cwd: null })
      return
    }
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      errors.push(`${path} は文字列か { command, kind, cwd } ではない`)
      return
    }
    const before = errors.length
    const unknownKeys = Object.keys(el).filter(k => !TEST_STEP_KEYS.includes(k))
    if (unknownKeys.length > 0) errors.push(`${path} に未知のキー ${unknownKeys.join(', ')} (許容: ${TEST_STEP_KEYS.join('|')})`)
    if (typeof el.command !== 'string' || el.command === '') errors.push(`${path}.command が不足 (空でない文字列が必要)`)
    const kind = el.kind === undefined ? 'test' : el.kind
    if (!TEST_STEP_KINDS.includes(kind)) errors.push(`${path}.kind=${JSON.stringify(el.kind)} は許容値 ${TEST_STEP_KINDS.join('|')} 外`)
    if (el.cwd !== undefined && (typeof el.cwd !== 'string' || !el.cwd.startsWith('/'))) errors.push(`${path}.cwd は絶対パスが必要`)
    if (errors.length === before) steps.push({ command: el.command, kind, cwd: el.cwd || null })
  })
  return { steps, errors }
}

// ============================================================================
// Main
// ============================================================================

const {
  design_path,
  components,
  run_tests_after,
  test_commands,
  test_timing,
  commit_strategy,
} = svArgs.wf_specific
const dir = runDir(_WF_NAME)
const testTiming = test_timing || 'post-pipeline'

const _compNames = components.map(c => c.name)
const _wfSpecificErrors = []
const _dupCompNames = _compNames.filter((n, i) => _compNames.indexOf(n) !== i)
if (_dupCompNames.length > 0) _wfSpecificErrors.push(`args.wf_specific.components の name が重複: ${[...new Set(_dupCompNames)].join(', ')}`)
components.forEach((c, i) => _wfSpecificErrors.push(...fileNameErrors(`args.wf_specific.components[${i}].name`, c.name)))
for (const c of components) {
  const unknown =(c.dependencies || []).filter(d => !_compNames.includes(d))
  if (unknown.length > 0) _wfSpecificErrors.push(`args.wf_specific.components[${c.name}].dependencies に存在しない name: ${unknown.join(', ')}`)
}
if (run_tests_after === true && (!Array.isArray(test_commands) || test_commands.length === 0)) {
  _wfSpecificErrors.push('args.wf_specific.test_commands が不足 (run_tests_after=true のとき required)')
}
const _testCommands = normalizeTestCommands(test_commands || [])
_wfSpecificErrors.push(..._testCommands.errors)
const testSteps = _testCommands.steps
if (_wfSpecificErrors.length > 0) {
  return argsValidationEscalation(_wfSpecificErrors)
}

let batches
try {
  batches = topoSortToBatches(components)
} catch (e) {
  return {
    status: 'escalation',
    summary: 'コンポーネント依存関係に循環あり',
    runDir: dir,
    escalation: {
      reason: e.message,
      options: [
        { title: 'コンポーネント再定義', description: '循環を解消して分割し直す', tradeoffs: '設計フェーズに戻る', effort: '中' },
      ],
      recommendation: 0,
      reasoning: '循環依存は解消しないと実装不可',
    },
  }
}

const IMPLEMENTER_SCHEMA = {
  type: 'object',
  properties: {
    design_mismatch: { type: 'boolean' },
  },
  required: ['design_mismatch'],
}

const TEST_RUNNER_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    failed_tests: { type: 'array', items: { type: 'string' } },
    not_run_steps: { type: 'array', items: { type: 'number' } },
  },
  required: ['pass'],
}

const COMMITTER_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    commit_count: { type: 'number' },
  },
  required: ['pass'],
}

const implMdPathFor = comp => `${dir}/loop/${comp.name}-round-1-impl.md`

async function implementerAgent(comp) {
  phase('実装')
  const outputPath = implMdPathFor(comp)
  const label = `impl-${comp.name}`

  const prompt = `
あなたは実装担当エージェントです。

${roleSection('implementer')}

# 設計書
以下ファイルを Read で確認して従ってください:
- ${design_path}

# 担当コンポーネント
- 名前: ${comp.name}
- 対象ファイル: ${(comp.files || []).join(', ') || '未指定 (設計書から特定)'}
- 変更内容: ${comp.description}

# 出力
実ファイルへの変更を実施 (Edit/Write ツール使用)。
変更サマリを以下パスに md 保存:
${outputPath}

構成:
- ## 担当コンポーネント
- ## 変更ファイル一覧 (追加/削除行数)
- ## 変更内容の要約 (Before/After)
- ## 未解決事項 (あれば)
- ## 判定 JSON (末尾)

判定 JSON:
{
  "component": "${comp.name}",
  "files_changed": [...],
  "design_mismatch": false | true,
  "design_mismatch_reason": "..."
}

設計書に記載のないファイルの変更、または設計書が指示していないファイルの削除が必要と判断した時点で、そのファイルは変更・削除せずに design_mismatch=true とし、必要な変更と理由を md に書いてください。

# 制約
- 判断に迷ったら決定せず、成果物に明記
- 最終応答は「実装完了 (${comp.name})」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して判定オブジェクト (design_mismatch: bool) を返してください。md 内の判定 JSON と必ず一致させること。乖離の理由は md の判定 JSON の design_mismatch_reason に書くこと。
`.trim()

  return svAgent(prompt, 'implementer', label, { schema: IMPLEMENTER_SCHEMA })
}

async function testRunnerAgent(scope) {
  // scope: { mode: 'per-component', comp } or { mode: 'post-pipeline', components }
  phase('テスト')
  const isPerComp = scope.mode === 'per-component'
  const outputPath = isPerComp
    ? `${dir}/agents/test-${scope.comp.name}.md`
    : `${dir}/agents/test-all.md`
  const label = isPerComp ? `test-${scope.comp.name}` : 'test-all'
  const scopeBlock = isPerComp
    ? `対象コンポーネント: ${scope.comp.name} (ファイル: ${(scope.comp.files || []).join(', ') || '未指定'})`
    : `対象: 全コンポーネントの impl 完了状態\n${(scope.components || []).map(c => `- ${c.name} (files: ${(c.files || []).join(', ') || '未指定'})`).join('\n')}`
  const jsonKey = isPerComp ? `"component": "${scope.comp.name}"` : `"scope": "all"`

  const stepsBlock = testSteps
    .map((s, i) => `${i + 1}. 種別: ${s.kind} / 実行場所: ${s.cwd || svArgs.project_root || '作業ディレクトリ'} / コマンド: ${s.command}`)
    .join('\n')

  // Bash は呼び出しごとに cwd が戻るため、cd を同じ呼び出しに含める
  const prompt = `
あなたはテスト実行担当エージェントです。

${roleSection('verifier')}

# タスク
以下の手順を番号順に Bash で実行し、結果を報告してください。
${stepsBlock}

# 実行のしかた
- 実行場所が現在の作業ディレクトリと違う手順は、\`cd <実行場所> && <コマンド>\` の形で 1 回の Bash 呼び出しにする
- build の手順が失敗したら後続の手順は実行せず、未実行の手順として md に書く
- launch の手順は、起動 → 状態の確認 → 起動したプロセスの停止までを 1 つのコマンドで終える約束。終わらない・起動したプロセスが残る手順は失敗として報告し、自分で kill して取り繕わない

# 対象
${scopeBlock}

# 出力
以下パスに md 保存:
${outputPath}

構成:
- ## 実行した手順 (種別・実行場所・コマンド・終了コード)
- ## 結果 (pass / fail)
- ## 詳細ログ (失敗した手順は失敗行を含めて引用する)
- ## 判定 JSON (末尾)

判定 JSON:
{
  ${jsonKey},
  "pass": true|false,
  "failed_tests": [...],
  "not_run_steps": [...]
}

# 制約
- 最終応答は「テスト完了 (pass=<bool>)」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して判定オブジェクト (pass: bool、failed_tests: string の配列、not_run_steps: 未実行の手順の番号の配列) を返してください。md 内の判定 JSON と必ず一致させること。pass は全手順が実行されて成功したときだけ true とし、実行できなかった手順があれば pass=false とする。
`.trim()

  return svAgent(prompt, 'test_runner', label, { schema: TEST_RUNNER_SCHEMA })
}

async function implementComponent(comp) {
  const impl = await implementerAgent(comp)
  if (impl == null) return { comp, error: 'impl_failed' }
  if (impl.design_mismatch) {
    return { comp, error: 'design_mismatch', implMdPath: implMdPathFor(comp) }
  }

  let testResult = null
  if (run_tests_after && testTiming === 'per-component') {
    testResult = await testRunnerAgent({ mode: 'per-component', comp })
    if (testResult == null) return { comp, error: 'test_failed', implMdPath: implMdPathFor(comp) }
  }

  return { comp, succeeded: true, testResult, implMdPath: implMdPathFor(comp) }
}

const componentResults = []
const buildComponentOutputs = () => componentResults.map(r => ({
  name: r.comp.name,
  succeeded: !!r.succeeded,
  implMdPath: r.implMdPath || null,
  perComponentTestMdPath: r.testResult ? `${dir}/agents/test-${r.comp.name}.md` : null,
  error: r.error || null,
}))

function designMismatchEscalation(mismatched) {
  return {
    status: 'escalation',
    summary: `${mismatched.length} コンポーネントで設計書との乖離を検出`,
    runDir: dir,
    componentOutputs: buildComponentOutputs(),
    escalation: {
      reason: `実装担当が「設計書に記載のないファイルが変更対象」と検出: ${mismatched.map(r => r.comp.name).join(', ')}`,
      options: [
        { title: '設計フェーズに戻る', description: '設計書を更新して再実装', tradeoffs: '時間増', effort: '中' },
        { title: '設計書に追記して継続', description: 'SV が設計書を更新して再実装', tradeoffs: '設計の整合性リスク', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '設計から作り直す方が後の品質が保てる',
    },
  }
}

for (const batch of batches) {
  const batchResults = (await parallel(batch.map(comp => () => implementComponent(comp))))
    .map((r, i) => r ?? { comp: batch[i], error: 'impl_failed' })
  componentResults.push(...batchResults)

  const batchMismatches = batchResults.filter(r => r.error === 'design_mismatch')
  if (batchMismatches.length > 0) return designMismatchEscalation(batchMismatches)

  const failed = batchResults.filter(r => r.error || !r.succeeded)
  if (failed.length > 0 && batches.length > 1) {
    return {
      status: 'escalation',
      summary: `バッチ内で ${failed.length} コンポーネント失敗、後続バッチをスキップ`,
      runDir: dir,
      componentOutputs: buildComponentOutputs(),
      escalation: {
        reason: '先行バッチのコンポーネントに失敗があり、後続に進めない',
        options: [
          { title: '失敗コンポーネントを再実行', description: '成功分は保持して失敗のみ再走', tradeoffs: '手動操作が必要', effort: '中' },
          { title: '全体を再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '大' },
          { title: '設計フェーズに戻る', description: 'コンポーネント分割を見直し', tradeoffs: '時間増', effort: '大' },
        ],
        recommendation: 0,
        reasoning: '部分成功を活かすのが効率的',
      },
    }
  }
}

const failedComponents = componentResults.filter(r => !r.succeeded)
if (failedComponents.length > 0) {
  return {
    status: 'escalation',
    summary: `${failedComponents.length}/${componentResults.length} コンポーネントで失敗 (${failedComponents.map(r => `${r.comp.name}: ${r.error}`).join(', ')})、テストと commit は実施せず`,
    runDir: dir,
    componentOutputs: buildComponentOutputs(),
    escalation: {
      reason: 'コンポーネントの実装 (または per-component テスト) に失敗があり、テストと commit に進めない',
      options: [
        { title: '失敗コンポーネントを再実行', description: '成功分は保持して失敗のみ再走', tradeoffs: '手動操作が必要', effort: '中' },
        { title: '全体を再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '大' },
      ],
      recommendation: 0,
      reasoning: '部分成功を活かすのが効率的',
    },
  }
}

let postPipelineTestResult = null
let postPipelineTestMdPath = null
if (run_tests_after && testTiming === 'post-pipeline') {
  postPipelineTestResult = await testRunnerAgent({ mode: 'post-pipeline', components: componentResults.map(r => r.comp) })
  if (postPipelineTestResult == null) {
    return {
      status: 'escalation',
      summary: 'テスト担当が結果を返さなかった (実装は完了、commit は実施せず)',
      runDir: dir,
      componentOutputs: buildComponentOutputs(),
      escalation: {
        reason: 'post-pipeline テスト担当エージェントが null を返した',
        options: [
          { title: 'テストを再実行', description: 'SV が test_commands を実行して結果を確認', tradeoffs: '手動作業', effort: '小' },
          { title: 'wf を再実行', description: 'wf を再起動', tradeoffs: '再実装のトークン消費', effort: '大' },
        ],
        recommendation: 0,
        reasoning: '実装は完了しているので、テストだけ確認するのが効率的',
      },
    }
  }
  postPipelineTestMdPath = `${dir}/agents/test-all.md`
}

const testFailedPerComp = componentResults.filter(r => r.testResult && r.testResult.pass === false)
const testFailedPost = postPipelineTestResult != null && postPipelineTestResult.pass === false

if (testFailedPerComp.length > 0 || testFailedPost) {
  const summary = testFailedPost
    ? '実装完了後のテスト実行で失敗を検出'
    : `${testFailedPerComp.length} コンポーネントでテスト失敗 (per-component)`
  return {
    status: 'escalation',
    summary,
    runDir: dir,
    componentOutputs: buildComponentOutputs(),
    postPipelineTestMdPath,
    escalation: {
      reason: '実装は完了したがテスト失敗を検出',
      options: [
        { title: '実装側を再修正', description: 'テストが正しく、実装に問題', tradeoffs: '追加ループ', effort: '中' },
        { title: 'テスト側の問題を修正', description: '実装は正しく、テスト側が古い可能性', tradeoffs: 'テスト仕様の変更', effort: '中' },
        { title: '仕様変更として扱う', description: 'テスト・実装両方を仕様に合わせる', tradeoffs: '仕様確認が必要', effort: '大' },
      ],
      recommendation: 0,
      reasoning: 'テストが失敗した場合は実装側の修正から検討するのが基本',
    },
  }
}

const componentOutputs = buildComponentOutputs()

let commitMdPath = null
if (commit_strategy && commit_strategy !== 'none') {
  phase('コミット')
  const commitPrompt = `
あなたは commit 担当エージェントです。

# タスク
commit_strategy=${commit_strategy} に従って git commit してください。

# 対象コンポーネント
${componentResults.map(r => `- ${r.comp.name}: files=${(r.comp.files || []).join(',') || '未指定: 実装 md の「変更ファイル一覧」から特定'}, impl_md=${r.implMdPath}, description=${r.comp.description}`).join('\n')}

# 戦略
- per-component: コンポーネントごとに 1 commit。メッセージはコンポーネント description をベースに。
- all-at-once: 全体で 1 commit。メッセージは全コンポーネントを網羅する要約。

# 制約
- commit メッセージの言語・書式・署名行 (Co-Authored-By 等) は、導入先の CLAUDE.md とプロジェクトの規約に従う。規約が無ければ、リポジトリの直近の commit の書式に合わせる
- --no-verify や --no-gpg-sign は使わない
- 秘密が含まれる .env 等は commit しない
- 具体ファイル名で add (git add -A は避ける)

# 出力
- 実際に git commit を実行
- 実行結果を以下パスに md 保存: ${dir}/agents/commit.md
  構成: 実行コマンド / 各 commit の sha と message / 判定 JSON
- 判定 JSON: {"commits": [{"sha": "...", "message": "..."}], "pass": true|false}

# 制約
- 最終応答は「commit 完了 (N commits)」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して判定オブジェクト (pass: bool、commit_count: number) を返してください。md 内の判定 JSON と必ず一致させること。
`.trim()

  const commitResult = await svAgent(commitPrompt, 'committer', 'commit', { schema: COMMITTER_SCHEMA })
  commitMdPath = `${dir}/agents/commit.md`
  if (commitResult == null || !commitResult.pass) {
    return {
      status: 'escalation',
      summary: commitResult == null ? 'commit 実行失敗 (実装は完了)' : 'commit 担当が失敗を報告 (実装は完了)',
      runDir: dir,
      componentOutputs,
      postPipelineTestMdPath,
      commitMdPath: commitResult == null ? null : commitMdPath,
      escalation: {
        reason: commitResult == null ? 'commit 担当エージェントが null を返した' : 'commit 担当が pass=false を返した',
        options: [
          { title: 'SV が手動 commit', description: 'SV が git status を確認して手動 commit', tradeoffs: '手動作業', effort: '小' },
          { title: 'wf 再実行', description: 'wf を再起動', tradeoffs: '再実装のリスク', effort: '大' },
        ],
        recommendation: 0,
        reasoning: '実装は成功、commit のみ失敗なら手動対応が安全',
      },
    }
  }
}

if (svArgs.checkpoint_declarations && svArgs.checkpoint_declarations.includes('implemented')) {
  return {
    status: 'checkpoint_stop',
    summary: `実装完了 (${componentResults.length} コンポーネント)、ユーザ確認待ち`,
    componentOutputs,
    postPipelineTestMdPath,
    commitMdPath,
    checkpoint: {
      name: 'implemented',
      reason: 'ユーザ宣言のチェックポイント',
    },
  }
}

return {
  status: 'success',
  summary: `${componentResults.length} コンポーネント実装完了`,
  componentOutputs,
  postPipelineTestMdPath,
  commitMdPath,
}
