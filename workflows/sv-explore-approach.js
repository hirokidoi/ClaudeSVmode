export const meta = {
  name: 'sv-explore-approach',
  description: '異なる観点で複数アプローチを生成・比較して SV に返す',
  whenToUse: '仕様確定前にユーザに選択肢を提示したい時',
  phases: [
    { title: '生成' },
    { title: '審査' },
  ],
  argsSchema: {
    wf_specific: {
      goal: { type: 'string', required: true, description: 'ユーザの要望 (自然言語)' },
      constraints: { type: 'array', required: false, items: { type: 'string' }, description: '制約の配列' },
      perspectives: { type: 'array', required: false, items: { type: 'string' }, description: 'デフォルト [mvp, risk, scalability, user-experience]' },
      background: { type: 'string', required: false, description: '関連する既存実装や過去の判断' },
    },
  },
}

// 本体からは meta を参照できないため meta.name と同じ値を持つ
const _WF_NAME = 'sv-explore-approach'

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    goal: { type: 'string', required: true },
    constraints: { type: 'array', required: false, items: { type: 'string' } },
    perspectives: { type: 'array', required: false, items: { type: 'string' } },
    background: { type: 'string', required: false },
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

パックはロール定義を補う知識です。ロール定義・利用者の追記・本プロンプトの指定と食い違うときは、そちらに従ってください。
index.md が存在しないスタックは読まずに続け、成果物に「スタックパック未配置: <スタック名>」と書いてください。
`.trim()
}

// role はロールファイル名 (拡張子なし)
function roleSection(role, note) {
  const head = `
# ロール定義 (必読)
以下ファイルを Read で全文読み、指示を全て守ってください。出力形式は本プロンプトの指定を正とします:
- ${KIT_DIR}/roles/${role}.md

続けて、利用者の追記を次の順に Read してください。無いのが通常の状態なので、無いファイルは飛ばし、読めなかったことは成果物のどこ (アクセス不能領域を含む) にも書きません:
1. ${KIT_DIR}/roles/local/_all.md
2. ${KIT_DIR}/roles/local/${role}.md

追記はロール定義に優先し、2 つが食い違うときは 2 に従ってください。本プロンプトの指定は追記にも優先します。
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

作業を始める前に、inbox.md と outbox.md を Read してください。無いのが通常の状態なので、無いファイルは飛ばし、読めなかったことは成果物のどこ (アクセス不能領域を含む) にも書きません。続けて規則 ${KIT_DIR}/workflows/mailbox/rules.md を Read し、従ってください。
`.trim()
}

// extra.mailbox は label と担当名が一致しない場合の担当名
function svAgent(prompt, role, label, extra) {
  const { mailbox, ...rest } = extra || {}
  const name = mailbox || label.replace(/:/g, '-')
  return agent(`${prompt}\n\n${mailboxBlock(name)}`, agentOpts(role, label, rest))
}
// <<< sv-prelude:core

// ============================================================================
// Main
// ============================================================================

const { goal, constraints, perspectives, background } = svArgs.wf_specific
const dir = runDir(_WF_NAME)
const activePerspectives = perspectives && perspectives.length ? perspectives : ['mvp', 'risk', 'scalability', 'user-experience']
const _dupPerspectives = activePerspectives.filter((x, i) => activePerspectives.indexOf(x) !== i)
const _perspectiveErrors = []
if (_dupPerspectives.length > 0) {
  _perspectiveErrors.push(`args.wf_specific.perspectives が重複: ${[...new Set(_dupPerspectives)].join(', ')}`)
}
activePerspectives.forEach((p, i) => _perspectiveErrors.push(...fileNameErrors(`args.wf_specific.perspectives[${i}]`, p)))
if (_perspectiveErrors.length > 0) {
  return argsValidationEscalation(_perspectiveErrors)
}

const perspectiveGuide = {
  mvp: '最小実装で価値を早く出す。将来拡張は後回し',
  risk: 'リスクを最小化し、失敗時の影響を局所化する',
  scalability: '将来の拡張・スケール変化を先取り',
  'user-experience': 'ユーザ体験の質を最優先する',
}

phase('生成')

const proposals = await parallel(activePerspectives.map(p => () => {
  const outputPath = `${dir}/agents/proposal-${p}.md`
  const prompt = `
あなたはアプローチ提案担当エージェントです。

${roleSection('designer')}

# 要望
${goal}

# 制約
${(constraints || []).map(c => `- ${c}`).join('\n') || 'なし'}

# 背景
${background || 'なし'}

# 観点 (この観点に集中してください)
${p}: ${perspectiveGuide[p] || '独自の観点で案を作成'}

他の観点の案は他エージェントが担当します。あなたはこの観点だけに集中してください。

# 出力
以下パスに md 保存:
${outputPath}

構成:
- ## 観点: ${p}
- ## 案タイトル (要約)
- ## 概要
- ## 具体的な実装イメージ
- ## 想定シナリオ
- ## リスク
- ## 工数感 (小/中/大)
- ## 判定 JSON (末尾)

判定 JSON:
{
  "perspective": "${p}",
  "title": "案タイトル",
  "summary": "概要",
  "tradeoffs": {"pro": "...", "con": "..."},
  "effort": "小|中|大",
  "constraints_unmet": ["満たせない制約 (なければ空配列)"],
  "precondition_failed": true|false,
  "precondition_reason": "..." | null
}

# 制約
- この wf は探索が目的なので、制約を満たせない場合も案は書き、満たせない制約と理由を本文と constraints_unmet に明記する (制約の未充足は打ち切りの理由にしない)
- 要望が曖昧すぎて、この観点で具体的な案にできない (要望の言い換えや質問しか書けない) ときだけ precondition_failed=true とし、案の本文は書かず理由だけを書く
- 最終応答は「提案完了 (${p})」の 1 文で良い
`.trim()

  return svAgent(prompt, 'designer', `propose:${p}`, { schema: COMPLETION_SCHEMA })
}))

const validProposals = proposals.filter(r => r != null)
const proposalMdPathsWith = judgedSet => activePerspectives.map((p, i) => ({
  perspective: p,
  proposalMdPath: `${dir}/agents/proposal-${p}.md`,
  judgeMdPath: judgedSet.includes(p) ? `${dir}/agents/judge-${p}.md` : null,
  succeeded: proposals[i] != null,
}))

if (validProposals.length < activePerspectives.length / 2) {
  const failedPerspectives = activePerspectives.filter((_, i) => proposals[i] == null)
  return {
    status: 'escalation',
    summary: `${failedPerspectives.length}/${activePerspectives.length} 案の生成失敗 (失敗: ${failedPerspectives.join(', ')})`,
    runDir: dir,
    proposalMdPaths: proposalMdPathsWith([]),
    escalation: {
      reason: '提案生成の過半数が失敗',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
        { title: 'perspectives 再選定', description: 'より具体的な観点で再指定', tradeoffs: 'ユーザとの追加対話', effort: '小' },
      ],
      recommendation: 1,
      reasoning: '提案失敗は観点の抽象度不足の可能性',
    },
  }
}

phase('審査')

const succeededPerspectives = activePerspectives.filter((_, i) => proposals[i] != null)

const judgments = await parallel(succeededPerspectives.map(p => () => {
  const outputPath = `${dir}/agents/judge-${p}.md`
  const proposalPath = `${dir}/agents/proposal-${p}.md`
  const prompt = `
あなたは独立審査担当エージェントです。

${roleSection('reviewer')}

# タスク
以下の提案を、実現性・拡張性・ユーザ価値の 3 軸で評価してください。
判定は下しますが、案を「棄却」する権限はありません。あくまで比較材料の提供です。
この wf では合否・重大度・観点チェックは使わず、3 軸の評価のみを行う。

# 対象提案
提案 md: ${proposalPath} (Read で確認)
観点: ${p}

# 要望・制約 (参照用)
要望: ${goal}
制約: ${(constraints || []).map(c => `- ${c}`).join('\n') || 'なし'}

# 出力
以下パスに md 保存:
${outputPath}

構成:
- ## 総合評価 (総合コメント)
- ## 判定 JSON (総合評価の直下)
- ## 評価対象
- ## 実現性 (5 段階 + 根拠)
- ## 拡張性 (5 段階 + 根拠)
- ## ユーザ価値 (5 段階 + 根拠)

判定 JSON:
{
  "perspective": "${p}",
  "scores": {"feasibility": 1-5, "scalability": 1-5, "user_value": 1-5},
  "total": <三軸合計>,
  "substantive": true|false,
  "notes": "総合コメント"
}

substantive: 提案が具体的なアプローチになっておらず、要望の言い換えや質問だけのときは false

# 制約
- 提案 md を Read で確認してから評価
- 最終応答は「審査完了 (${p})」の 1 文で良い
`.trim()

  return svAgent(prompt, 'judge', `judge:${p}`, { schema: COMPLETION_SCHEMA })
}))

// SV は proposalMdPaths の各 md を Read して比較表を作成する

const judgedPerspectives = succeededPerspectives.filter((_, j) => judgments[j] != null)
const proposalMdPaths = proposalMdPathsWith(judgedPerspectives)

return {
  status: 'success',
  summary: `${validProposals.length}/${activePerspectives.length} 案を生成、${judgedPerspectives.length} 案を独立審査済み`,
  proposalMdPaths,
}
