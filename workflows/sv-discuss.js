export const meta = {
  name: 'sv-discuss',
  description: '立場を分けた論者に議論させ、判断材料か結論の md と議事録を SV に返す',
  whenToUse: '問い・選択肢・論点が出ていて、立場を戦わせて比べたい・結論を詰めたい時',
  phases: [
    { title: '初めの主張' },
    { title: '議論' },
    { title: 'まとめ' },
  ],
  argsSchema: {
    wf_specific: {
      question: { type: 'string', required: true, description: '議論する問い' },
      options: { type: 'array', required: false, items: { type: 'string' }, description: '選択肢。無ければ論者が初めの主張で案を出す' },
      stances: { type: 'array', required: false, items: { type: 'object', properties: { name: { type: 'string', required: true }, position: { type: 'string', required: true } } }, description: '論者の立場。省略時は自動で割り振る' },
      mode: { type: 'enum', values: ['present', 'consensus'], required: true, description: 'present は判断材料を並べる、consensus は結論まで詰める' },
      format: { type: 'enum', values: ['sequential', 'parallel'], required: false, description: 'デフォルト sequential (1 人ずつ順に発言)。parallel はラウンド内を並行' },
      max_rounds: { type: 'number', required: false, description: '議論のラウンドの上限 (初めの主張は数えない)' },
      deadline_epoch_sec: { type: 'number', required: false, description: '締め切りの UNIX 時刻 (秒)。過ぎたら次のラウンドに入らない' },
      context: { type: 'string', required: false, description: '論者に共通の背景・材料 (md のパスを含めてよい)' },
      speech_rules: { type: 'string', required: false, description: '論者全員に守らせる発言の形式・縛り' },
    },
  },
}

// 本体からは meta を参照できないため meta.name と同じ値を持つ
const _WF_NAME = 'sv-discuss'

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    question: { type: 'string', required: true },
    options: { type: 'array', required: false, items: { type: 'string' } },
    stances: { type: 'array', required: false, items: { type: 'object', properties: { name: { type: 'string', required: true }, position: { type: 'string', required: true } } } },
    mode: { type: 'enum', values: ['present', 'consensus'], required: true },
    format: { type: 'enum', values: ['sequential', 'parallel'], required: false },
    max_rounds: { type: 'number', required: false },
    deadline_epoch_sec: { type: 'number', required: false },
    context: { type: 'string', required: false },
    speech_rules: { type: 'string', required: false },
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

作業を始める前に、inbox.md と outbox.md を Read ツールで 1 つずつ読んでください。パスは上のフォルダに続けて完全に書き、Bash やシェル変数では読みません。無いのが通常の状態なので、無いファイルは飛ばし、読めなかったことは成果物のどこ (アクセス不能領域を含む) にも書きません。続けて規則 ${KIT_DIR}/workflows/mailbox/rules.md を Read し、従ってください。
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
// Constants
// ============================================================================

// 要件から来る設計値
const MAX_DEBATERS = 5
const MIN_DEBATERS = 2
const PROPOSER_COUNT = 3
const CRITIC_OPTIONS_MAX = 2
const DEFAULT_MAX_ROUNDS = 10
const MAX_ROUNDS_LIMIT = 20

// 設計値
const SUMMARY_MAX_LINES = 5

const DEBATER_ROLE_NOTE = 'このロール定義は、論者の主張と反論に意味を持つ範囲で適用する。割り振られた立場から始めるが、反論に納得したら譲歩・修正・立場の変更をしてよい。複数案の検討は、初めの主張で自分の案を出すときに当てる'
const SUMMARIZER_ROLE_NOTE = 'このロール定義は振る舞いの原則だけを使う。合否・重大度・観点チェックは使わない。論者の発言に無い主張を足さない'

const STOP_REASON_LABELS = {
  consensus: '全員が同じ結論に合意した',
  exhausted: '出尽くし (誰も立場を変えず、新しい論点も出なかった)',
  max_rounds: 'ラウンドの上限',
  deadline: '時間の上限',
}

// ============================================================================
// Schemas
// ============================================================================

const OPENING_SCHEMA = {
  type: 'object',
  properties: {
    precondition_failed: { type: 'boolean' },
    precondition_reason: { type: 'string' },
    finished_at_epoch_sec: { type: 'number' },
    finished_at_hm: { type: 'string' },
  },
  required: ['precondition_failed', 'finished_at_epoch_sec', 'finished_at_hm'],
}

function debaterSchema(isConsensus) {
  const properties = {
    changed_position: { type: 'boolean' },
    new_points: { type: 'boolean' },
    finished_at_epoch_sec: { type: 'number' },
    finished_at_hm: { type: 'string' },
  }
  const required = ['changed_position', 'new_points', 'finished_at_epoch_sec', 'finished_at_hm']
  if (isConsensus) {
    properties.endorsed_position = { type: 'string' }
    required.push('endorsed_position')
  }
  return { type: 'object', properties, required }
}

const MINUTES_SCHEMA = {
  type: 'object',
  properties: {
    exit_code: { type: 'number' },
    detail: { type: 'string' },
  },
  required: ['exit_code'],
}

// ============================================================================
// Main (引数の取り出しと検査)
// ============================================================================

const { question, options, stances, mode, format, max_rounds, deadline_epoch_sec, context, speech_rules } = svArgs.wf_specific
const dir = runDir(_WF_NAME)
const runMode = mode
const runFormat = format || 'sequential'
const maxRounds = max_rounds == null ? DEFAULT_MAX_ROUNDS : max_rounds
const hasDeadline = deadline_epoch_sec != null
const hasStances = Array.isArray(stances)
const opts = options || []
const modeLabel = runMode === 'consensus' ? '合意モード' : '提示モード'
const formatLabel = runFormat === 'parallel' ? '並行ラウンド制' : '順番制'

const _discussErrors = []
if (max_rounds != null && !(Number.isInteger(max_rounds) && max_rounds >= 1 && max_rounds <= MAX_ROUNDS_LIMIT)) {
  _discussErrors.push(`args.wf_specific.max_rounds=${JSON.stringify(max_rounds)} は 1 以上 ${MAX_ROUNDS_LIMIT} 以下の整数ではない`)
}
if (hasDeadline && !(Number.isInteger(deadline_epoch_sec) && deadline_epoch_sec > 0)) {
  _discussErrors.push(`args.wf_specific.deadline_epoch_sec=${JSON.stringify(deadline_epoch_sec)} は正の整数 (UNIX 時刻・秒) ではない`)
}
if (hasStances) {
  if (stances.length < MIN_DEBATERS || stances.length > MAX_DEBATERS) {
    _discussErrors.push(`args.wf_specific.stances の数 ${stances.length} は ${MIN_DEBATERS} 以上 ${MAX_DEBATERS} 以下ではない`)
  }
  const stanceNames = stances.map(s => s.name)
  const dupStanceNames = stanceNames.filter((n, i) => stanceNames.indexOf(n) !== i)
  if (dupStanceNames.length > 0) {
    _discussErrors.push(`args.wf_specific.stances の name が重複: ${[...new Set(dupStanceNames)].join(', ')}`)
  }
  stances.forEach((s, i) => _discussErrors.push(...fileNameErrors(`args.wf_specific.stances[${i}].name`, s.name)))
} else {
  const dupOptions = opts.filter((o, i) => opts.indexOf(o) !== i)
  if (dupOptions.length > 0) {
    _discussErrors.push(`args.wf_specific.options が重複: ${[...new Set(dupOptions)].join(', ')}`)
  }
  if (opts.length > MAX_DEBATERS) {
    _discussErrors.push(`args.wf_specific.options の数 ${opts.length} が論者の上限 ${MAX_DEBATERS} を超える (stances で論者を絞るか、選択肢を減らす)`)
  }
}
if (_discussErrors.length > 0) {
  return argsValidationEscalation(_discussErrors)
}

const DEBATER_SCHEMA = debaterSchema(runMode === 'consensus')

// ============================================================================
// State
// ============================================================================

function buildDebaters() {
  if (hasStances) return stances.map(s => ({ name: s.name, stance: s.position }))
  if (opts.length === 0) {
    return Array.from({ length: PROPOSER_COUNT }, (_, i) => ({ name: `proposer-${i + 1}`, stance: '初めの主張で、自分が最善と考える案を出して擁護する' }))
  }
  const list = opts.map((_, i) => ({ name: `advocate-${i + 1}`, stance: `選択肢 ${i + 1} を擁護する` }))
  if (opts.length <= CRITIC_OPTIONS_MAX) list.push({ name: 'critic', stance: 'どの選択肢にも穴を探す' })
  return list
}

const isProposer = !hasStances && opts.length === 0
const debaters = buildDebaters().map(d => ({ ...d, active: true }))
// 起動した順の発言の時系列 (result が null は失敗)
const speeches = []

function activeNames() {
  return debaters.filter(d => d.active).map(d => d.name)
}

function speechId(round, name) {
  return `round-${round}-${name}`
}

function speechPath(round, name) {
  return `${dir}/loop/${speechId(round, name)}.md`
}

function roundRecords() {
  return speeches.map(s => ({ round: s.round, debater: s.debater, mdPath: s.mdPath, succeeded: s.succeeded }))
}

function debaterSummary() {
  return debaters.map(d => ({ name: d.name, stance: d.stance, active: d.active }))
}

// ============================================================================
// Pure helpers
// ============================================================================

function shq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function speakingOrder(names, round, prevLastSpeaker) {
  const n = names.length
  const shift = n > 0 ? round % n : 0
  const order = [...names.slice(shift), ...names.slice(0, shift)]
  if (n >= 2 && prevLastSpeaker != null && order[0] === prevLastSpeaker) {
    [order[0], order[1]] = [order[1], order[0]]
  }
  return order
}

function readingList(speaker, round) {
  const ok = speeches.filter(s => s.succeeded)
  let full
  if (runFormat === 'sequential') {
    let lastOwn = -1
    ok.forEach((s, i) => { if (s.debater === speaker) lastOwn = i })
    full = ok.slice(lastOwn + 1)
  } else {
    full = ok.filter(s => s.round === round - 1)
  }
  const fullNames = new Set(full.map(s => s.debater))
  const summaryOnly = []
  for (const d of debaters) {
    if (!d.active || fullNames.has(d.name)) continue
    const latest = ok.filter(s => s.debater === d.name).pop()
    if (latest) summaryOnly.push(latest)
  }
  return { full, summaryOnly }
}

function consensusHolder(results) {
  const names = Object.keys(results)
  if (names.length === 0 || names.some(n => results[n] == null)) return null
  const target = results[names[0]].endorsed_position
  if (!names.includes(target)) return null
  if (names.some(n => results[n].endorsed_position !== target)) return null
  return results[target].changed_position === false ? target : null
}

function isExhausted(results) {
  const names = Object.keys(results)
  if (names.length === 0 || names.some(n => results[n] == null)) return false
  return names.every(n => results[n].changed_position === false && results[n].new_points === false)
}

function roundEndEpoch(results) {
  const epochs = Object.keys(results)
    .map(n => results[n])
    .filter(r => r != null && Number.isFinite(r.finished_at_epoch_sec))
    .map(r => r.finished_at_epoch_sec)
  return epochs.length > 0 ? Math.max(...epochs) : null
}

function deadlineReached(results) {
  const end = roundEndEpoch(results)
  return hasDeadline && end != null && end >= deadline_epoch_sec
}

function endorsementTally(results) {
  const names = Object.keys(results)
  const counts = new Map()
  let none = 0
  let failed = 0
  for (const n of names) {
    const r = results[n]
    if (r == null) { failed += 1; continue }
    if (names.includes(r.endorsed_position)) counts.set(r.endorsed_position, (counts.get(r.endorsed_position) || 0) + 1)
    else none += 1
  }
  const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `- ${n}: ${c} 人`)
  lines.push(`- 支持なし: ${none} 人`)
  if (failed > 0) lines.push(`- このラウンドに失敗: ${failed} 人`)
  return lines.join('\n')
}

function displayHm(result) {
  const hm = result && result.finished_at_hm
  return typeof hm === 'string' && /^\d{2}:\d{2}$/.test(hm) ? hm : '--:--'
}

// ============================================================================
// Minutes
// ============================================================================

function minutesCommand() {
  const out = `${dir}/agents/minutes.md`
  const lines = []
  const say = text => lines.push(`printf '%s\\n' ${shq(text)}`)
  say('# 議事録')
  say('')
  say(`- 問い: ${question}`)
  say(`- モード: ${modeLabel}`)
  say(`- 進め方: ${formatLabel}`)
  say('- 論者:')
  debaters.forEach(d => say(`  - ${d.name}: ${d.stance}${d.active ? '' : ' (初めの主張に失敗し、以後は不参加)'}`))
  const epochOf = s => (s.result && Number.isFinite(s.result.finished_at_epoch_sec) ? s.result.finished_at_epoch_sec : Infinity)
  const lastRound = speeches.reduce((m, s) => Math.max(m, s.round), 0)
  for (let r = 0; r <= lastRound; r++) {
    const inRound = speeches.filter(s => s.round === r)
    const ordered = runFormat === 'parallel'
      ? [
          ...inRound.filter(s => s.succeeded).sort((a, b) => (epochOf(a) < epochOf(b) ? -1 : epochOf(a) > epochOf(b) ? 1 : 0)),
          ...inRound.filter(s => !s.succeeded),
        ]
      : inRound
    say('')
    say(r === 0 ? '## ラウンド 0 (初めの主張)' : `## ラウンド ${r}`)
    say(runFormat === 'parallel'
      ? 'このラウンドの論者は並行して書き、同じラウンドの他の論者の発言を見ていない。並びは書き終えた時刻の順'
      : `1 人ずつ順に発言。各論者はそれまでの発言を読んでから書いた。発言順: ${inRound.map(s => s.debater).join(' → ')}`)
    for (const s of ordered) {
      say('')
      if (s.succeeded) {
        say(`### ${displayHm(s.result)} ${s.debater} (${s.id})`)
        lines.push(`cat ${shq(s.mdPath)}`)
        lines.push("printf '\\n'")
      } else {
        say(`（${s.debater} はこのラウンドの発言なし）`)
      }
    }
  }
  return ['set -e', `mkdir -p ${shq(`${dir}/agents`)}`, '{', ...lines, `} > ${shq(out)}`].join('\n')
}

// ============================================================================
// Prompts
// ============================================================================

function speechRulesBlock() {
  if (!speech_rules) return ''
  return `
# 発言の決まり (必ず守る)
${speech_rules}

この決まりは \`#### 発言\` の本文 (応答先の行の後) に適用する。
`.trim()
}

function debateContextBlock() {
  const optionLines = opts.length > 0 ? opts.map((o, i) => `${i + 1}. ${o}`).join('\n') : 'なし (論者が初めの主張で案を出す)'
  const modeText = runMode === 'consensus'
    ? '合意モード: 論者同士で同じ結論に至ることを目指す。納得したら譲歩・修正してよい。'
    : '提示モード: 結論は出さない。議論を通じて、各案の強み・弱み・争点・それぞれを選ぶ条件を明らかにする。'
  const formatText = runFormat === 'parallel'
    ? '並行ラウンド制: 同じラウンドの論者は並行して書く。同じラウンドの他の論者の発言は読めず、反論は次のラウンドで行う。'
    : '順番制: 論者が 1 人ずつ順に発言する。各論者は、前回の自分の発言より後の全員の発言を読んでから書く。ラウンド (全員が 1 回ずつ発言する 1 周) ごとに発言の順番を回す。'
  return `
# 議論の枠組み
## 問い
${question}

## 選択肢
${optionLines}

## 背景
${context || 'なし'}

## モード
${modeText}

## 進め方
${formatText}

## 論者 (この並びが組み立て順)
${debaters.filter(d => d.active).map(d => `- ${d.name}: ${d.stance}`).join('\n')}
`.trim()
}

function readingLines(list, markLast) {
  return list.map((s, i) => `- ${s.id}: ${s.mdPath}${markLast && i === list.length - 1 ? ' ← 直前の発言' : ''}`).join('\n')
}

function summaryOnlyBlock(reading) {
  if (reading.summaryOnly.length === 0) return ''
  return `
## 要約の節だけ読む md
各 md の \`#### 現在の立場の要約\` の節だけを読む (残りは読まない):
${readingLines(reading.summaryOnly, false)}
`.trim()
}

function outputBlock(d, round) {
  const isOpening = round === 0
  return `
# 出力
以下パスに md を Write で保存:
${speechPath(round, d.name)}

md の見出しは h4 (\`####\`) にし、タイトル行は付けない。この順で書く:
1. \`#### 現在の立場の要約\` (${SUMMARY_MAX_LINES} 行以内。他の論者がこの節だけを読むことがある)
2. \`#### 判定 JSON\` (返り値と同じ内容。ただし finished_at_* は md を書き終えてから得る値なので含めない)
3. \`#### 発言\`: 1 行目に \`応答先: <応答する発言の ID を列挙>\` (応答する発言が無いときは \`応答先: なし\`)。本文は段落ごとに先頭へ \`→ <発言 ID> への反論\` / \`譲歩\` / \`修正\` / \`応答\` のいずれかを付ける${isOpening ? ' (応答先が無い初めの主張は付けない)' : ''}
4. \`#### 新しい論点\` (あれば)
`.trim()
}

function returnValueBlock(round) {
  const timeRule = `
- finished_at_epoch_sec / finished_at_hm: md を書き終えた直後に Bash で \`date '+%s %H:%M'\` を 1 回実行し、出力の 2 つの値 (UNIX 時刻・秒 / 時:分) をそのまま返り値に入れる。推測の値を入れない
`.trim()
  if (round === 0) {
    return `
# 返り値 (StructuredOutput)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して schema に従った判定オブジェクトを返してください。required フィールドは必ず含めること。md の判定 JSON は finished_at_* を除き、StructuredOutput の内容と一致させること。
- precondition_failed: 問いが曖昧すぎて、割り振られた立場で具体的な主張にできない (問いの言い換えや質問しか書けない) ときだけ true。true のときは md に \`#### 現在の立場の要約\` (理由を書く) と \`#### 判定 JSON\` だけを書き、発言の本文は書かない
- precondition_reason: precondition_failed が true のときの理由
${timeRule}
`.trim()
  }
  const endorsed = `
- endorsed_position: 結論として受け入れる立場の持ち主の論者名。次の 2 段で 1 つに決める
  1. 結論として受け入れる立場が無ければ空文字
  2. 受け入れる立場と同じ内容の立場を持つ論者 (自分を含む。他の論者は読んだ時点の最新の立場、自分はこの発言の後の立場) のうち、「論者」の節の並び (組み立て順) で最も先の論者の名前。自分の名前になるのは、受け入れる立場が自分だけのものか、同じ内容の持ち主の中で自分が組み立て順で最も先のとき
`.trim()
  const lines = [
    '# 返り値 (StructuredOutput)',
    '最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して schema に従った判定オブジェクトを返してください。required フィールドは必ず含めること。md の判定 JSON は finished_at_* を除き、StructuredOutput の内容と一致させること。',
    '- changed_position: この発言で自分の立場を変えた・修正した。立場の要約の主張が変わったときだけ true (言い回しの変更は当たらない)',
    '- new_points: この発言で、これまで誰も出していない論点を出した (既出の論点の補強は当たらない)',
    runMode === 'consensus' ? endorsed : null,
    timeRule,
  ]
  return lines.filter(Boolean).join('\n')
}

function debaterHeader(d, round) {
  return `
あなたは論者エージェントです。

${roleSection('designer', DEBATER_ROLE_NOTE)}

${debateContextBlock()}

${speechRulesBlock()}

# あなたの割り当て
- 名前: ${d.name}
- 立場: ${d.stance}
- この発言の ID: ${speechId(round, d.name)}
`.trim().replace(/\n{3,}/g, '\n\n')
}

function openingPrompt(d, reading) {
  const noParallelRead = '同じラウンドの他の論者の発言は存在しないか書きかけなので読まない。'
  let readSection
  let task
  if (runFormat === 'parallel') {
    readSection = `# 読む発言\n先に読む発言は無い。${noParallelRead}「応答先: なし」の初めの主張として書く。`
    task = isProposer ? '独立に、自分が最善と考える案を出して擁護する。' : '割り振られた立場から、問いに対する具体的な初めの主張を書く。'
  } else if (reading.full.length === 0) {
    readSection = '# 読む発言\n先に読む発言は無い。「応答先: なし」の初めの主張として書く。'
    task = isProposer ? '自分が最善と考える案を出して擁護する。' : '割り振られた立場から、問いに対する具体的な初めの主張を書く。'
  } else {
    readSection = `
# 読む発言
先に発言した論者の発言を、時系列の順に全文で読んでから書く (最後の 1 件が直前の発言):
${readingLines(reading.full, true)}
`.trim()
    task = isProposer
      ? '先に出た案を読み、違う案を出す。先の案が最善と考えるなら、その案を擁護すると明記する。'
      : '割り振られた立場から、問いに対する具体的な初めの主張を書く。先の発言に応答すべき点があれば応答先に挙げる。'
  }
  return `
${debaterHeader(d, 0)}

# タスク: 初めの主張 (ラウンド 0)
${task}

${readSection}

${outputBlock(d, 0)}

${returnValueBlock(0)}

# 制約
- 判断に迷ったら決定せず、md に明記
- 最終応答は「発言完了 (${speechId(0, d.name)})」の 1 文で良い
`.trim()
}

function roundPrompt(d, round, reading) {
  let readSection
  if (reading.full.length > 0) {
    readSection = `
## 全文を読む発言 (時系列順)
${runFormat === 'sequential' ? '同じラウンドで先に話した論者の発言も含む。最後の 1 件が直前の発言。' : '前のラウンドの全員の発言。同じラウンドの他の論者の発言は存在しないか書きかけなので読まない。'}
${readingLines(reading.full, runFormat === 'sequential')}
`.trim()
  } else {
    readSection = '## 全文を読む発言\n前回のあなたの発言の後に新しい発言は無い (間の論者の発言が失敗した)。下の要約の節で読む各論者の最新の立場に反論・応答してよい。\n'
  }
  return `
${debaterHeader(d, round)}

# タスク: ラウンド ${round} の発言
他の論者の主張を読み、反論・譲歩・修正・応答を書く。割り振られた立場から始めるが、納得したら立場を変えてよい。

# 読む発言
${readSection}

${summaryOnlyBlock(reading)}

${outputBlock(d, round)}

${returnValueBlock(round)}

# 制約
- 判断に迷ったら決定せず、md に明記
- 最終応答は「発言完了 (${speechId(round, d.name)})」の 1 文で良い
`.trim().replace(/\n{3,}/g, '\n\n')
}

function summarizerPrompt(stopReason, roundsCompleted, extra) {
  const okSpeeches = speeches.filter(s => s.succeeded)
  const latestPerDebater = debaters
    .map(d => okSpeeches.filter(s => s.debater === d.name).pop())
    .filter(Boolean)
  const structure = runMode === 'present'
    ? `
# 判断メモ
## 打ち切りの理由
## 各案
## 争点
## 議論の経過

各節に書くこと:
- 各案: 案ごとに強み・弱み・それを選ぶ条件
- 議論の経過: 立場の変化を短く、発言 ID を添える
- 結論・推奨は書かない
`.trim()
    : stopReason === 'consensus'
      ? `
# 判断メモ
## 打ち切りの理由
## 合意の内容
## 根拠
## 退けた案と理由

各節に書くこと:
- 合意の内容: 合意した立場の持ち主の最新の発言の要約を起点にする
`.trim()
      : `
# 判断メモ
## 打ち切りの理由
## 未合意
## 合意できた点
## 残った対立
## 暫定の結論

各節に書くこと:
- 未合意: 合意に至らなかったことを明記する
- 暫定の結論: 最も支持の強い案と、支持をどう数えたか。決めるのは SV であり、暫定であることを明記する
`.trim()
  const rules = speech_rules ? `\n# 論者に課した決まり\n${speech_rules}\n\nこの決まりのための語句を論点として扱わない。\n` : ''
  return `
あなたはまとめ役エージェントです (議論には加わっていません)。

${roleSection('reviewer', SUMMARIZER_ROLE_NOTE)}

${debateContextBlock()}
${rules}
# 打ち切り
- 理由: ${STOP_REASON_LABELS[stopReason]}
- 完了したラウンド数: ${roundsCompleted} (初めの主張は数えない)
${extra ? `\n${extra}\n` : ''}
# 読む発言
## 全文を読む (各論者の最新の発言)
${readingLines(latestPerDebater, false)}

## 全発言 (必要な箇所だけ読む)
${readingLines(okSpeeches, false)}

# 出力
以下パスに md 保存:
${dir}/agents/summarizer.md

構成:
${structure}

# 制約
- 論者の発言に無い主張を足さない
- 合否・重大度・観点チェックは使わない
- 最終応答は「まとめ完了」の 1 文で良い
`.trim().replace(/\n{3,}/g, '\n\n')
}

function minutesPrompt(command) {
  return `
あなたは書記エージェントです。判断を伴わない機械的な作業だけを行います。

# 手順
下のコマンドを Bash で 1 回だけ、1 字も変えずに実行してください。出力ファイルを開いたり直したりしないでください。実行後、終了コードと、失敗したときは標準エラーの要点を返します。

--- コマンドここから (この行は含めない) ---
${command}
--- コマンドここまで (この行は含めない) ---

# 返り値 (StructuredOutput)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出してください。
- exit_code: コマンドの終了コード
- detail: 失敗したときの標準エラーの要点 (成功したときは空でよい)
`.trim()
}

// ============================================================================
// Rounds
// ============================================================================

function launchSpeech(name, round, reading) {
  const d = debaters.find(x => x.name === name)
  const prompt = round === 0 ? openingPrompt(d, reading) : roundPrompt(d, round, reading)
  return agent(prompt, agentOpts('designer', `debate-r${round}:${name}`, { schema: round === 0 ? OPENING_SCHEMA : DEBATER_SCHEMA }))
}

function recordSpeech(round, name, result) {
  speeches.push({ round, debater: name, id: speechId(round, name), mdPath: speechPath(round, name), succeeded: result != null, result })
}

async function runRound(round) {
  const names = activeNames()
  const results = {}
  if (runFormat === 'sequential') {
    const prev = speeches.filter(s => s.round === round - 1 && s.succeeded).pop()
    for (const name of speakingOrder(names, round, prev ? prev.debater : null)) {
      const result = await launchSpeech(name, round, readingList(name, round))
      recordSpeech(round, name, result)
      results[name] = result
    }
  } else {
    const readings = names.map(name => readingList(name, round))
    const outs = await parallel(names.map((name, i) => () => launchSpeech(name, round, readings[i])))
    names.forEach((name, i) => {
      recordSpeech(round, name, outs[i])
      results[name] = outs[i]
    })
  }
  return results
}

function partialState() {
  return { runDir: dir, roundMdPaths: roundRecords(), debaters: debaterSummary() }
}

// ============================================================================
// Main (議論の進行)
// ============================================================================

phase('初めの主張')

const openingResults = await runRound(0)
debaters.forEach(d => { d.active = openingResults[d.name] != null })
const openingOk = debaters.filter(d => d.active)
log(`初めの主張: 成功 ${openingOk.length} 人 / 失敗 ${debaters.length - openingOk.length} 人`)

if (openingOk.length < MIN_DEBATERS || openingOk.length < debaters.length / 2) {
  return {
    status: 'escalation',
    summary: `初めの主張の失敗: ${openingOk.length}/${debaters.length} 人が成功`,
    ...partialState(),
    escalation: {
      reason: '初めの主張が論者の過半数、または議論に必要な人数で失敗',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
        { title: '論者を減らして再起動', description: 'stances か options を絞る', tradeoffs: '議論の幅が狭まる', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性が高く、まず再実行で確かめる',
    },
  }
}

const preconditionFailedCount = openingOk.filter(d => openingResults[d.name].precondition_failed === true).length
if (preconditionFailedCount * 2 > openingOk.length) {
  return {
    status: 'escalation',
    summary: `問いの具体化が要る: ${preconditionFailedCount}/${openingOk.length} 人が具体的な主張にできないと報告`,
    ...partialState(),
    escalation: {
      reason: '成功した論者の過半数が、問いが曖昧で具体的な主張にできないと報告',
      options: [
        { title: '問いを具体化して再起動', description: '問い・選択肢・背景を補って wf を再起動', tradeoffs: 'ユーザとの追加対話が要る場合がある', effort: '小' },
        { title: 'sv-investigate で材料を補う', description: '問いに必要な事実を調査してから再起動', tradeoffs: '調査のトークン消費', effort: '中' },
      ],
      recommendation: 0,
      reasoning: '問いの曖昧さは SV 側の入力の見直しで解消できることが多い',
    },
  }
}

let stopReason = null
let roundsCompleted = 0
let lastResults = openingResults
let consensusTarget = null
if (deadlineReached(openingResults)) stopReason = 'deadline'

if (stopReason == null) phase('議論')
let round = 0
while (stopReason == null) {
  round += 1
  const results = await runRound(round)
  const names = activeNames()
  const okResults = names.map(n => results[n]).filter(r => r != null)
  log(`ラウンド ${round}: 立場を変えた ${okResults.filter(r => r.changed_position === true).length} 人 / 新しい論点 ${okResults.filter(r => r.new_points === true).length} 人 / 失敗 ${names.length - okResults.length} 人`)
  if (okResults.length < MIN_DEBATERS || okResults.length < names.length / 2) {
    return {
      status: 'escalation',
      summary: `ラウンド ${round} の失敗: ${okResults.length}/${names.length} 人が成功`,
      ...partialState(),
      escalation: {
        reason: '議論のラウンドで成功した論者が、議論に必要な人数か参加中の論者の半数に満たない',
        options: [
          { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
          { title: 'その時点の記録を SV が読む', description: 'roundMdPaths の記録から SV が判断材料を作る', tradeoffs: '判断メモと議事録は無い', effort: '中' },
        ],
        recommendation: 0,
        reasoning: '一時的な失敗の可能性が高く、まず再実行で確かめる',
      },
    }
  }
  roundsCompleted = round
  lastResults = results
  if (runMode === 'consensus' && consensusHolder(results) != null) {
    stopReason = 'consensus'
    consensusTarget = consensusHolder(results)
  } else if (isExhausted(results)) {
    stopReason = 'exhausted'
  } else if (round >= maxRounds) {
    stopReason = 'max_rounds'
  } else if (deadlineReached(results)) {
    stopReason = 'deadline'
  }
}

phase('まとめ')

let summarizerExtra = ''
if (runMode === 'consensus') {
  if (stopReason === 'consensus') summarizerExtra = `合意した立場の持ち主: ${consensusTarget}`
  else if (roundsCompleted > 0) summarizerExtra = `最後のラウンドの endorsed_position の集計 (論者名ごとの支持の数。空文字は支持なし)。すべて支持なしか最多が同数なら、発言の内容から判断し、その根拠を「暫定の結論」に書く:\n${endorsementTally(lastResults)}`
  else summarizerExtra = '議論のラウンドは行っていない (初めの主張のみ)。endorsed_position の集計は無いので、初めの主張の内容から判断し、その根拠を「暫定の結論」に書く'
}

const [summarizer, minutes] = await parallel([
  () => svAgent(summarizerPrompt(stopReason, roundsCompleted, summarizerExtra), 'judge', 'summarizer', { schema: COMPLETION_SCHEMA }),
  () => agent(minutesPrompt(minutesCommand()), agentOpts('judge', 'minutes', { schema: MINUTES_SCHEMA })),
])

const summarizerPath = `${dir}/agents/summarizer.md`
const minutesPath = minutes != null && minutes.exit_code === 0 ? `${dir}/agents/minutes.md` : null

if (summarizer == null) {
  return {
    status: 'escalation',
    summary: 'まとめ役の実行失敗 (議論は終了済み)',
    ...partialState(),
    minutesPath,
    escalation: {
      reason: 'まとめ役エージェントが null を返した',
      options: [
        { title: 'wf を再実行', description: '議論を最初からやり直す', tradeoffs: '全ラウンドのトークンを再び消費する', effort: '大' },
        { title: 'SV が記録と議事録を読んでまとめる', description: 'roundMdPaths と minutesPath の md から SV が判断材料を作る', tradeoffs: 'SV のコンテキストを使う', effort: '中' },
      ],
      recommendation: 1,
      reasoning: '議論は終わっており、再実行は全ラウンドをやり直すことになる',
    },
  }
}

return {
  status: 'success',
  summary: `${modeLabel}・${formatLabel}: ${STOP_REASON_LABELS[stopReason]} (${roundsCompleted} ラウンド、論者 ${activeNames().length} 人)${minutesPath == null ? '。議事録の作成に失敗' : ''}`,
  outputPath: summarizerPath,
  minutesPath,
  stopReason,
  roundsCompleted,
  debaters: debaterSummary(),
  roundMdPaths: roundRecords(),
}
