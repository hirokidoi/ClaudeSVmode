export const meta = {
  name: 'sv-investigate',
  description: '複数領域を並列に調査して構造化された結果を返す',
  whenToUse: '曖昧な要望・複数領域の状態把握が必要な時',
  phases: [
    { title: '調査' },
    { title: '網羅性チェック' },
  ],
  argsSchema: {
    wf_specific: {
      areas: {
        type: 'array',
        required: true,
        description: '調査対象領域の配列 (各要素は name/scope/questions を持つ)',
        items: { type: 'object', properties: { name: { type: 'string', required: true }, scope: { type: 'string', required: true }, questions: { type: 'array', required: false, items: { type: 'string' } } } },
      },
      context: { type: 'string', required: false, description: '全領域共通の背景情報' },
      completeness_check: { type: 'boolean', required: false, description: '網羅性チェックを回すか (既定 true)。調査範囲がユーザ決定で閉じている場合は false' },
    },
  },
}

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    areas: { type: 'array', required: true, items: { type: 'object', properties: { name: { type: 'string', required: true }, scope: { type: 'string', required: true }, questions: { type: 'array', required: false, items: { type: 'string' } } } } },
    context: { type: 'string', required: false },
    completeness_check: { type: 'boolean', required: false },
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
// <<< sv-prelude:core

// ============================================================================
// Main
// ============================================================================

const { areas, context, completeness_check } = svArgs.wf_specific
const dir = runDir('sv-investigate')
const runCompletenessCheck = completeness_check !== false

const _areaNames = areas.map(a => a.name)
const _dupAreaNames = _areaNames.filter((n, i) => _areaNames.indexOf(n) !== i)
const _areaErrors = []
if (_dupAreaNames.length > 0) {
  _areaErrors.push(`args.wf_specific.areas の name が重複: ${[...new Set(_dupAreaNames)].join(', ')}`)
}
areas.forEach((a, i) => _areaErrors.push(...fileNameErrors(`args.wf_specific.areas[${i}].name`, a.name)))
if (_areaErrors.length > 0) {
  return argsValidationEscalation(_areaErrors)
}

phase('調査')

const investigations = await parallel(areas.map(area => () => {
  const outputPath = `${dir}/agents/investigator-${area.name}.md`
  const prompt = `
あなたは調査担当エージェントです。

${roleSection('investigator')}

# 領域: ${area.name}
# 調査対象: ${area.scope}

# 答えを出したい問い
${(area.questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n')}

# 全体背景
${context || '特に背景情報なし'}

# 出力
以下パスに md 保存:
${outputPath}

構成:
- ## 調査対象 (スコープの確認)
- ## 主要な発見
- ## 問いへの回答 (問いごとに Q/A 形式)
- ## 参照ファイル (file:line 形式)
- ## アクセス不能領域 (該当あれば列挙、なければ「なし」)
- ## 範囲外で気になった点 (あれば。なければ省略可)

# 制約
- 推測は避け、確認したファイル・コマンド出力を根拠として記載
- 判断に迷ったら決定せず、成果物に明記
- 最終応答は「調査完了 (${area.name})」の 1 文で良い
`.trim()

  return agent(prompt, agentOpts('investigator', `investigate:${area.name}`, { agentType: 'general-purpose' }))
}))

const validInvestigations = investigations.filter(r => r != null)
const areaMdPaths = areas.map((a, i) => ({ area: a.name, mdPath: `${dir}/agents/investigator-${a.name}.md`, succeeded: investigations[i] != null }))
const failedAreaNames = areas.filter((_, i) => investigations[i] == null).map(a => a.name)

if (validInvestigations.length < areas.length / 2) {
  return {
    status: 'escalation',
    summary: `${failedAreaNames.length}/${areas.length} 領域で調査失敗 (失敗: ${failedAreaNames.join(', ')})`,
    runDir: dir,
    areaMdPaths,
    escalation: {
      reason: '調査担当エージェントの過半数が null を返した',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
        { title: '領域を絞って再実行', description: '失敗領域だけ再走', tradeoffs: '網羅性やや低下', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性',
    },
  }
}

const succeededAreas = areas.filter((_, i) => investigations[i] != null)

// 網羅性チェックは「調査観点として抜けている領域はないか」という開いた問いを投げる。
// 調査範囲が既に決まっている場合、この問いは範囲を開け直す方向にしか働かないため回さない。
let critiquePath = null
if (runCompletenessCheck) {
  phase('網羅性チェック')

  critiquePath = `${dir}/agents/completeness-critic.md`
  const critiquePrompt = `
あなたは網羅性クリティックエージェントです。

${roleSection('reviewer')}

# タスク
以下の調査結果を確認し、「調査観点として抜けている領域はないか」を検討してください。

# 調査領域
${succeededAreas.map(a => `- ${a.name}: ${a.scope}`).join('\n')}
${failedAreaNames.length ? `
# 調査に失敗した領域 (SV 把握済み。抜けとして扱わず、追加調査推奨にも挙げない)
${failedAreaNames.map(n => `- ${n}`).join('\n')}
` : ''}
# 全体背景
${context || 'なし'}

# 各領域の調査結果 (Read で確認)
${succeededAreas.map(a => `- ${a.name}: ${dir}/agents/investigator-${a.name}.md`).join('\n')}

# 出力
以下パスに md 保存:
${critiquePath}

構成:
- ## 抜けと判断されたポイント (該当あれば)
- ## 追加調査推奨 (領域名 + 理由)
- ## アクセス不能領域の集約 (各領域の結果から)
- ## 判定 JSON

判定 JSON:
{
  "additional_areas_recommended": [{"name": "...", "scope": "...", "reason": "..."}],
  "access_blocker": {"areas": [...], "reason": "..."} | null
}

# 制約
- 合否・重大度・観点チェックはこの wf では使わない。抜けの指摘だけを行う
- 判定 JSON の access_blocker は、いずれかの領域で「アクセス不能領域」が報告されていれば必ず埋める
- 最終応答は「網羅性チェック完了」の 1 文で良い
`.trim()

  const critique = await agent(critiquePrompt, agentOpts('critique', 'completeness-critic'))
  if (critique == null) critiquePath = null
}

// SV は areaMdPaths と critiquePath を Read して総括する

const failedNote = failedAreaNames.length ? ` (失敗: ${failedAreaNames.join(', ')})` : ''

if (svArgs.checkpoint_declarations && svArgs.checkpoint_declarations.includes('investigated')) {
  return {
    status: 'checkpoint_stop',
    summary: `調査完了 (${succeededAreas.length}/${areas.length} 領域${failedNote})、ユーザ確認待ち`,
    areaMdPaths,
    critiquePath,
    checkpoint: {
      name: 'investigated',
      reason: 'ユーザ宣言のチェックポイント',
    },
  }
}

return {
  status: 'success',
  summary: `${succeededAreas.length}/${areas.length} 領域を調査完了${failedNote}${runCompletenessCheck ? '' : ' (網羅性チェックなし)'}`,
  areaMdPaths,
  critiquePath,
}
