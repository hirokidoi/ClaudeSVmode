export const meta = {
  name: 'sv-prototype-ui',
  description: 'HTML プロトタイプを制作してデザインレビューを通した承認済み UI を返す',
  whenToUse: 'UI を伴う案件で実装前にデザイン確認したい時',
  phases: [
    { title: 'デザイン' },
    { title: 'レビュー' },
    { title: '修正ループ' },
  ],
  argsSchema: {
    wf_specific: {
      ui_requirements: { type: 'string', required: true, description: 'UI 要件 (自然言語)' },
      usage_scenarios: { type: 'array', required: false, items: { type: 'object', properties: { actor: { type: 'string', required: true }, goal: { type: 'string', required: true }, steps: { type: 'array', required: false, items: { type: 'string' } } } }, description: 'actor/goal/steps を持つオブジェクト配列' },
      existing_ui_references: { type: 'array', required: false, items: { type: 'string' }, description: '参考にすべき既存画面のパス or URL 配列' },
      constraints: { type: 'object', required: false, description: 'responsive/dark_mode/framework の指定' },
      output_base_dir: { type: 'string', required: false, description: 'プロトタイプ HTML の保存先ディレクトリ' },
    },
  },
}

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    ui_requirements: { type: 'string', required: true },
    usage_scenarios: { type: 'array', required: false, items: { type: 'object', properties: { actor: { type: 'string', required: true }, goal: { type: 'string', required: true }, steps: { type: 'array', required: false, items: { type: 'string' } } } } },
    existing_ui_references: { type: 'array', required: false, items: { type: 'string' } },
    constraints: { type: 'object', required: false },
    output_base_dir: { type: 'string', required: false },
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

const MAX_REVISION_LOOP = 3
// 設計値。revision_required がこの件数以上のとき revision_count_high を立てる
const REVISION_COUNT_HIGH_THRESHOLD = 5

// >>> sv-prelude:review-checks
// ============================================================================
// Review check catalog — copied into review wfs
// ============================================================================

const REVIEW_CHECKS = {
  n_plus_1: 'N+1 問題 (DB / API / ディスク走査などをループの中で繰り返していないか)',
  dry: 'DRY・共通化の漏れ・デッドコード',
  semantic: 'セマンティック設計の 4 つの問い (呼び出し側 / 名前 / 責務 / 抽象化の完全性)',
  callee_behavior: '呼び出し先の内部実装と非自明挙動 (暗黙の型変換・null の扱い・文字コードや照合順序や時刻の変換等の前提)',
  hot_path: 'ホットパスの効率 (高頻度の処理で重い操作を毎回実行していないか)',
  spec: '自動テストの存在と実効性 (呼び出しでなく動作を検証しているか、定数の中身に依存していないか)',
  consumers: '全消費者・全レイヤーへの影響',
  docs: 'ドキュメント・コメントの整合と、導入先の CLAUDE.md・プロジェクト規約にある記載ルール',
  policy: 'プロジェクトポリシー (導入先の CLAUDE.md・プロジェクト規約と、project_memory_path 内の規約・memory 類)',
  progress: 'プロジェクト進行の証跡 (前工程とそのレビューが実施されているか)',
}

function reviewChecksBlock(keys) {
  return keys.map(k => `- ${k}: ${REVIEW_CHECKS[k]}`).join('\n')
}

function policyReferenceBlock(memoryPath) {
  const memoryPart = memoryPath
    ? `加えて、以下ディレクトリ内の規約・memory 類をすべて確認し、過去の指摘が今回の対象で再現していないか確認してください:
- ${memoryPath}
ディレクトリが存在しない・空のときは、その旨を policy 観点の detail に書いてください。`
    : `project_memory_path は指定されていません。memory 類の確認は行わず、上記の規約だけで policy 観点を判定してください。規約も見当たらなければ policy は na とし、理由を書いてください。`
  return `
# プロジェクトポリシー参照 (必読)
導入先の CLAUDE.md とプロジェクトの規約文書を確認してください。
${memoryPart}
`.trim()
}

const SEVERITY_RULE = `
# 重大度と合否
- blocker: ブロッカー (リリース不可) / must_fix: 要修正 (品質上問題あり) / suggestion: 提案 (改善余地)
- blocker か must_fix が 1 件でもあれば pass=false。suggestion だけなら pass=true
- 重大度を落として合格にしない
`.trim()

const FINDINGS_PLACEMENT_RULE = `
- revision_required: blocker と must_fix の指摘 (severity / location / instruction)
- additional_findings: suggestion の指摘 (location / detail)
`.trim()
// ============================================================================
// <<< sv-prelude:review-checks

// ============================================================================
// Schemas (StructuredOutput enforcement)
// ============================================================================

const DESIGNER_SCHEMA = {
  type: 'object',
  properties: {
    round: { type: 'number' },
    precondition_failed: { type: 'boolean' },
    precondition_reason: { type: 'string' },
  },
  required: ['round', 'precondition_failed'],
}

const REVIEWER_R1_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    review_mode: { type: 'string' },
    upstream_precondition_failed: { type: 'boolean' },
    upstream_precondition_reason: { type: 'string' },
    structural_rethink_required: { type: 'boolean' },
    structural_rethink_reason: { type: 'string' },
    revision_count_high: { type: 'boolean' },
    checks: { type: 'object' },
    ui_checks: { type: 'object' },
    revision_required: { type: 'array', items: { type: 'object' } },
    additional_findings: { type: 'array', items: { type: 'object' } },
  },
  required: ['pass', 'upstream_precondition_failed', 'structural_rethink_required', 'revision_count_high', 'revision_required'],
}

const REVIEWER_R2_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    review_mode: { type: 'string' },
    upstream_precondition_failed: { type: 'boolean' },
    upstream_precondition_reason: { type: 'string' },
    structural_rethink_required: { type: 'boolean' },
    structural_rethink_reason: { type: 'string' },
    revision_count_high: { type: 'boolean' },
    designer_stuck: { type: 'boolean' },
    designer_stuck_reason: { type: 'string' },
    revision_items_resolved: { type: 'array', items: { type: 'object' } },
    unresolved_from_previous: { type: 'array', items: { type: 'object' } },
    checks: { type: 'object' },
    ui_checks: { type: 'object' },
    revision_required: { type: 'array', items: { type: 'object' } },
    additional_findings: { type: 'array', items: { type: 'object' } },
  },
  required: ['pass', 'upstream_precondition_failed', 'structural_rethink_required', 'revision_count_high', 'designer_stuck', 'revision_required'],
}

// ============================================================================
// Main
// ============================================================================

const {
  ui_requirements,
  usage_scenarios,
  existing_ui_references,
  constraints,
  output_base_dir,
} = svArgs.wf_specific
const dir = runDir('sv-prototype-ui')
const prototypeDir = output_base_dir || `${dir}/prototype`

const scenarioBlock = (usage_scenarios || [])
  .map(s => `- ${s.actor}: ${s.goal}\n${(s.steps || []).map((step, i) => `  ${i + 1}. ${step}`).join('\n')}`)
  .join('\n')

const darkModeEnabled = constraints?.dark_mode !== false
const framework = constraints?.framework || 'vanilla'
const CDN_EXCEPTION = framework === 'vanilla' ? '' : `ただしフレームワーク (${framework}) 本体に限り、バージョンを固定した CDN の読み込みを許可`

const constraintBlock = `
- レスポンシブ: ${constraints?.responsive !== false}
- ダークモード: ${darkModeEnabled}${darkModeEnabled ? ' (prefers-color-scheme に対応。手動の切り替えを持たせる場合はそれと矛盾させない)' : ''}
- フレームワーク: ${framework}
- 外部 CDN / フォント / 画像は禁止 (必要なら data: URI で inline)${CDN_EXCEPTION ? `。${CDN_EXCEPTION}` : ''}
- ダミーテキストに Lorem ipsum は使わない
`.trim()

async function designerAgent(round) {
  phase(round === 1 ? 'デザイン' : '修正ループ')
  const label = round === 1 ? 'design-r1' : `design-r${round}`
  const prevReviewPath = `${dir}/loop/round-${round - 1}-review.md`
  const revisionBlock = round >= 2 ? `
# 修正手順
1. 前回レビュー ${prevReviewPath} と、現行のプロトタイプ (${prototypeDir}) を Read で確認する。
2. 前回レビューの revision_required が指す箇所だけを修正する。指摘外の作り直し・整形はしない (focused 再レビューの前提)。
`.trim() : ''

  const prompt = `
あなたはデザイン担当エージェントです。

${roleSection('designer', '成果物は HTML / CSS のみで md は作らない。designer.md の「制作物が設計書以外の場合」に従う。')}

# UI 要件
${ui_requirements}

# 想定シナリオ
${scenarioBlock || 'なし'}

# 参考実装
${(existing_ui_references || []).map(r => `- ${r}`).join('\n') || 'なし'}

# 制約
${constraintBlock}

# 出力
以下ディレクトリにファイル作成:
${prototypeDir}
- index.html (メイン)
- その他必要な HTML / CSS

${revisionBlock}

# 制約
- シナリオが全て HTML 上で辿れる状態にすること
- ダミーデータは使ってよいが、シナリオに沿った現実的なテキストを入れる
- 最終応答は「プロトタイプ完了 (round=${round})」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して schema に従った判定オブジェクトを返してください。required フィールド (round / precondition_failed) は必ず含めること。

# 早期打ち切りシグナル (全ラウンドで判定)
round 1 は着手前の判断。round 2 以降は修正中に新たに発覚した場合のみ true にする。
以下いずれかに該当し「今の入力のままでは適切なプロトタイプが作れない」と判断した場合、無理に HTML を作らず precondition_failed=true として返してください。round 1 ではプロトタイプディレクトリは空でよい。
- UI 要件が曖昧すぎてデザイン判断が下せない
- シナリオ間で矛盾する要件が含まれている
- スコープが広すぎて 1 つの HTML に収まらない
- 前提となる参考実装 (existing_ui_references) 情報が不足していて判断根拠を持てない

# 早期打ち切り時の出力最小化
precondition_failed=true の場合、HTML の作成・修正は一切行わず理由の 1〜数行のみ返す。判断書を作らない。
`.trim()

  return agent(prompt, agentOpts('ui_designer', label, { schema: DESIGNER_SCHEMA, agentType: 'general-purpose' }))
}

// round 1 はフル監査、round 2 以降は前回指摘の解消確認
async function reviewerAgent(round) {
  phase('レビュー')
  const outputPath = `${dir}/loop/round-${round}-review.md`
  const prevReviewPath = `${dir}/loop/round-${round - 1}-review.md`

  const fullReviewBlock = `
# UI 固有チェック観点
- シナリオ網羅性 (全シナリオが HTML 上で辿れるか)
- アクセシビリティ (色コントラスト、キーボード操作、alt/aria)
- レスポンシブ動作の妥当性 (CSS の @media から判定)
- ダークモード対応 (constraints.dark_mode=${constraints?.dark_mode !== false})
- 既存 UI との整合性 (existing_ui_references と照合)
- 外部リソース (CDN・フォント等) を使っていないか${CDN_EXCEPTION ? ` (${CDN_EXCEPTION})` : ''}

# チェック観点 (省略しない。UI 固有チェックを主とし、以下は補助として確認する)
${reviewChecksBlock(['dry', 'semantic', 'policy'])}
`.trim()

  const prompt = round === 1 ? `
あなたはデザインレビュー担当エージェントです。

${roleSection('reviewer')}

${policyReferenceBlock(svArgs.project_memory_path)}

# レビュー対象
プロトタイプディレクトリ: ${prototypeDir} (Read で確認)

# UI 要件と想定シナリオ (再掲)
${ui_requirements}

シナリオ:
${scenarioBlock || 'なし'}

${fullReviewBlock}

# 早期打ち切りシグナル (判定 JSON に必ず含める)
以下に該当すると判断した場合、修正ループでは解消不能な可能性が高いため即座に SV へエスカレーションする材料として明示する。
- **upstream_precondition_failed: true** — 対象プロトタイプが「意味・価値」の判定 (reviewer.md 参照) を満たさない (HTML 空 / 要件を反映していない / SV が次工程に進めない)
- **structural_rethink_required: true** — 情報設計・レイアウト方針・スコープレベルの根本見直しが必要 (feedback で修正可能な粒度を超える)

upstream_precondition_failed / structural_rethink_required のどちらかが true なら判定は pass=false かつ SV への警告として理由を明示する。

以下は件数に関するシグナル。
- **revision_count_high: true** — revision_required が ${REVISION_COUNT_HIGH_THRESHOLD} 件以上。round 1 では打ち切らず修正ループで引き受ける (round 2 以降、件数が前回以上なら打ち切りの材料になる)

# 早期打ち切り時の出力最小化 (upstream_precondition_failed / structural_rethink_required が true の場合)
- UI 固有チェック / チェック観点の詳細列挙は省略し、md には以下のみを含める:
  - ## 総合評価 (pass=false + 早期打ち切り理由の要約)
  - ## 判定 JSON (総合評価の直下)
  - ## 早期打ち切り判断
- 「なぜ feedback ループで解消できないか」を簡潔に伝えることに徹する

# 出力
以下パスに md 保存:
${outputPath}

**md 構成の絶対順序 (この順で書く。順序変更・判定 JSON 文末配置は禁止):**
1. \`# タイトル\`
2. \`## 総合評価\` (pass / NG + 1〜3 行サマリ) — タイトル直下
3. \`## 判定 JSON\` (下記 schema の JSON をコードブロックで貼る) — **総合評価の直下に必ず配置。文末不可**
4. \`## 早期打ち切り判断\` (upstream_precondition_failed / structural_rethink_required / revision_count_high 該当時のみ)
5. \`## UI 固有チェック\` (各観点 OK/NG + 詳細)
6. \`## チェック観点\` (補助。観点キーごとに ok / issue / na + 詳細)
7. \`## 追加所見\` (suggestion)
8. \`## 修正指示\` (blocker / must_fix)

判定 JSON:
{
  "pass": true|false,
  "review_mode": "full",
  "upstream_precondition_failed": bool,
  "upstream_precondition_reason": "...",
  "structural_rethink_required": bool,
  "structural_rethink_reason": "...",
  "revision_count_high": bool,
  "ui_checks": {...},
  "checks": {"<観点キー>": {"status": "ok|issue|na", "detail": "..."}},
  "revision_required": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}]
}

${SEVERITY_RULE}
${FINDINGS_PLACEMENT_RULE}

# 制約
- プロトタイプ HTML/CSS を Read で確認してから判定
- 最終応答は「レビュー完了 (pass=<bool>)」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して schema に従った判定オブジェクトを返してください。required フィールド (pass / upstream_precondition_failed / structural_rethink_required / revision_count_high / revision_required) は必ず含めること。md への判定 JSON は StructuredOutput の内容と必ず一致させること。
`.trim() : `
あなたはデザインレビュー担当エージェントです (round ${round} の focused 再レビュー)。

${roleSection('reviewer')}

${policyReferenceBlock(svArgs.project_memory_path)}

# 背景
round ${round - 1} のレビュー指摘をデザイン担当が修正しました。全文フル監査ではなく focused 再レビューを行います。
目的は「指摘が解消されたか」と「その修正が新たな破綻を生んでいないか」の確認です。

# 入力 (すべて Read で確認)
- 前回レビュー (指摘一覧): ${prevReviewPath}
- 現在のプロトタイプ: ${prototypeDir}

# UI 要件と想定シナリオ (再掲)
${ui_requirements}

シナリオ:
${scenarioBlock || 'なし'}

# 手順
1. 前回レビューの revision_required 各項目が現行プロトタイプで解消されたか検証する (解消/未解消 + 根拠)。
2. 修正が指摘範囲に限定的で局所的か判定する。
   大幅なレイアウト刷新・新規画面/セクション追加・広範な作り直しがあれば「局所ではない」と判断する。
3. モード分岐:
   - 局所的 かつ revision_required 全件が解消 → focused pass。
     指摘に関連する箇所と、その修正が壊しうる周辺のみ確認すればよく、全シナリオ/アクセシビリティ/レスポンシブのフル再監査はしない。
   - 広範・構造的、または未解消/新規破綻あり → フル UI 監査に切替え、下記観点を全て実施する。

--- フル監査に切り替えた場合のみ実施 ---
${fullReviewBlock}
---

# 早期打ち切りシグナル (判定 JSON に必ず含める)
前回と同じ・類似の指摘が繰り返される場合、デザイン担当が feedback ループでは対処不能な可能性が高い。以下を明示する。
- **unresolved_from_previous**: 前回の revision_required のうち、今回も未解消 or 別表現で同じ問題が再発している項目
- **designer_stuck: true** — 前回指摘の過半数が未解消、または前回と本質的に同じ指摘が新たに再出現している場合
- **structural_rethink_required: true** — round 1 と同じ判定基準。本 round で新たに気付いた場合も true
- **upstream_precondition_failed: true** — round 1 と同じ判定基準。本 round で新たに気付いた場合も true
- **revision_count_high: true** — revision_required が ${REVISION_COUNT_HIGH_THRESHOLD} 件以上 (wf が前回件数と比べて打ち切りを判断する)

upstream_precondition_failed / structural_rethink_required / designer_stuck のいずれかを true にした場合は pass=false にする。revision_count_high は打ち切りの判断材料として立てるだけで、pass と出力最小化には影響させない (打ち切るかどうかは wf が前回件数と比べて決める)。

# 早期打ち切り時の出力最小化 (upstream_precondition_failed / structural_rethink_required / designer_stuck のいずれかが true の場合)
- 指摘解消の検証詳細の列挙は省略し、md には以下のみを含める:
  - ## 総合評価 (pass=false + 早期打ち切り理由の要約)
  - ## 判定 JSON (総合評価の直下)
  - ## 早期打ち切り判断
- 「なぜ feedback ループを続けても解消しないか」を簡潔に伝えることに徹する

# 出力
以下パスに md 保存:
${outputPath}

**md 構成の絶対順序 (この順で書く。順序変更・判定 JSON 文末配置は禁止):**
1. \`# タイトル\`
2. \`## 総合評価\` (pass / NG + レビューモード (focused / full) + 1〜3 行サマリ) — タイトル直下
3. \`## 判定 JSON\` (下記 schema の JSON をコードブロックで貼る) — **総合評価の直下に必ず配置。文末不可**
4. \`## 早期打ち切り判断\` (upstream_precondition_failed / designer_stuck / structural_rethink_required / revision_count_high 該当時のみ)
5. \`## 指摘解消の検証\` (revision_required 各項目)
6. \`## 追加所見\` (suggestion)
7. \`## 修正指示\` (blocker / must_fix)

判定 JSON:
{
  "pass": true|false,
  "review_mode": "focused" | "full",
  "upstream_precondition_failed": bool,
  "upstream_precondition_reason": "...",
  "structural_rethink_required": bool,
  "structural_rethink_reason": "...",
  "revision_count_high": bool,
  "designer_stuck": bool,
  "designer_stuck_reason": "...",
  "revision_items_resolved": [{"item": "...", "resolved": true|false, "evidence": "..."}],
  "unresolved_from_previous": [{"item": "...", "reason": "..."}],
  "ui_checks": {...},
  "checks": {"<観点キー>": {"status": "ok|issue|na", "detail": "..."}},
  "revision_required": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}]
}

${SEVERITY_RULE}
${FINDINGS_PLACEMENT_RULE}

# 制約
- 前回レビューとプロトタイプを Read で確認してから判定
- focused でも修正が指摘外の箇所を壊していないかは確認する
- 最終応答は「レビュー完了 (pass=<bool>, mode=<focused|full>)」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して schema に従った判定オブジェクトを返してください。required フィールド (pass / upstream_precondition_failed / structural_rethink_required / revision_count_high / designer_stuck / revision_required) は必ず含めること。md への判定 JSON は StructuredOutput の内容と必ず一致させること。
`.trim()

  const schema = round === 1 ? REVIEWER_R1_SCHEMA : REVIEWER_R2_SCHEMA
  return agent(prompt, agentOpts('ui_reviewer', `review-r${round}`, { schema, agentType: 'general-purpose' }))
}

function reviewMdPathsUpTo(n) {
  return Array.from({ length: n }, (_, i) => `${dir}/loop/round-${i + 1}-review.md`)
}

// デザイン担当の打ち切りフラグ (全ラウンドで判定)。該当すれば escalation、なければ null
// schema 経由で designOutput はパース済み object
function designerEarlyExitUI(designOutput, roundNum) {
  if (designOutput.precondition_failed !== true) return null
  const reason = designOutput.precondition_reason || '(理由不明)'
  return {
    status: 'escalation',
    summary: 'デザイン前提が不足しておりプロトタイプ制作不能と判定',
    prototypeDir,
    reviewMdPaths: reviewMdPathsUpTo(roundNum - 1),
    runDir: dir,
    escalation: {
      reason: `デザイン担当が前提不足を検出: ${reason}`,
      options: [
        { title: 'UI 要件を具体化', description: 'ui_requirements / usage_scenarios を具体化してから再度 wf 起動', tradeoffs: 'ユーザ再対話', effort: '中' },
        { title: '参考実装を追加', description: 'existing_ui_references を追加して再度 wf 起動', tradeoffs: '調査時間', effort: '小' },
        { title: 'スコープを狭める', description: 'スコープを分割して段階的にプロトタイプ制作', tradeoffs: '複数フェーズ', effort: '中' },
      ],
      recommendation: 0,
      reasoning: '前提不足のまま制作しても手戻り確実。上流に戻るのが効率的',
    },
  }
}

// 修正ループ
let round = 1
let designOutput = await designerAgent(round)
if (designOutput == null) {
  return {
    status: 'escalation',
    summary: 'デザイン初回実行失敗',
    prototypeDir,
    runDir: dir,
    escalation: {
      reason: 'デザイン担当エージェントが null を返した',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性',
    },
  }
}

const firstDesignExit = designerEarlyExitUI(designOutput, round)
if (firstDesignExit) return firstDesignExit

// schema 経由で reviewerOutput はパース済み object
function earlyExitFromReviewUI(reviewOutput, roundNum, prevRevisionCount) {
  const withReason = (base, detail) => detail ? `${base}: ${detail}` : base
  if (reviewOutput.upstream_precondition_failed === true) return { kind: 'upstream_failed', reason: withReason('レビュー対象プロトタイプが意味・価値を満たさない (HTML 空 / 要件を反映していない)。前工程 = 要件・シナリオのやり直しが必要', reviewOutput.upstream_precondition_reason) }
  if (reviewOutput.structural_rethink_required === true) return { kind: 'structural', reason: withReason('情報設計・レイアウト方針・スコープの根本見直しが必要と判定されました', reviewOutput.structural_rethink_reason) }
  // 件数だけを根拠に上流へ差し戻さない。初回の指摘が多いのは修正ループが引き受ける状態であり、
  // 上流の質を疑う根拠になるのは修正を経ても件数が減らないこと。
  const revisionCount = (reviewOutput.revision_required || []).length
  if (reviewOutput.revision_count_high === true && roundNum >= 2 && prevRevisionCount != null && revisionCount >= prevRevisionCount) {
    return { kind: 'revision_high', reason: `revision_required が ${REVISION_COUNT_HIGH_THRESHOLD} 件以上で、前回 ${prevRevisionCount} 件から今回 ${revisionCount} 件と減っていない。要件・シナリオの質に問題がある可能性が高い` }
  }
  if (reviewOutput.designer_stuck === true && roundNum >= 2) return { kind: 'stuck', reason: withReason('前回指摘の過半数が未解消。designer が feedback ループでは対処不能と判定', reviewOutput.designer_stuck_reason) }
  return null
}

function earlyExitEscalationUI(kind, reason, roundNum) {
  const optionsByKind = {
    upstream_failed: [
      { title: 'UI 要件を具体化', description: 'ui_requirements / usage_scenarios を具体化して再度 wf 起動', tradeoffs: 'ユーザ再対話', effort: '中' },
      { title: '参考実装を追加', description: 'existing_ui_references を追加して再度 wf 起動', tradeoffs: '調査時間', effort: '小' },
      { title: 'スコープを狭める', description: 'スコープを分割して段階的に制作', tradeoffs: '複数フェーズ', effort: '中' },
    ],
    structural: [
      { title: 'UI 要件・シナリオを見直す', description: '情報設計レベルで要件を再定義', tradeoffs: 'ユーザ再対話', effort: '中' },
      { title: '参考実装を追加', description: '判断基準となる既存 UI を追加', tradeoffs: '時間増', effort: '小' },
      { title: 'スコープを分割', description: 'スコープを狭めて段階制作', tradeoffs: '複数フェーズ', effort: '中' },
    ],
    revision_high: [
      { title: 'UI 要件を見直す', description: '要件が曖昧 / シナリオが矛盾していないか再確認', tradeoffs: 'ユーザ再対話', effort: '中' },
      { title: '参考実装で判断基準を明確化', description: 'existing_ui_references を追加', tradeoffs: '時間増', effort: '小' },
      { title: 'スコープを狭める', description: '段階的にプロトタイプ制作', tradeoffs: '複数フェーズ', effort: '小' },
    ],
    stuck: [
      { title: 'UI 要件・シナリオに戻る', description: 'designer が対処不能な指摘は前工程の質問題の可能性大', tradeoffs: '時間増', effort: '中' },
      { title: '参考実装を追加', description: '既存 UI を参考に判断基準を強化', tradeoffs: '時間増', effort: '小' },
      { title: '現状で受け入れ', description: '最終ラウンドの案を採用', tradeoffs: '品質基準未達', effort: '小' },
    ],
  }
  return {
    status: 'escalation',
    summary: `Round ${roundNum} で早期打ち切り: ${reason}`,
    prototypeDir,
    reviewMdPaths: reviewMdPathsUpTo(roundNum),
    runDir: dir,
    escalation: {
      reason,
      options: optionsByKind[kind] || [],
      recommendation: 0,
      reasoning: '手戻り工数が大きい場合、feedback ループを繰り返すより上流に戻るのが効率的',
    },
  }
}

let lastReview = null
let loopSucceeded = false
let prevRevisionCount = null
while (round <= MAX_REVISION_LOOP) {
  lastReview = await reviewerAgent(round)
  if (lastReview == null) {
    return {
      status: 'escalation',
      summary: `Round ${round} のレビュー実行失敗`,
      prototypeDir,
      reviewMdPaths: reviewMdPathsUpTo(round - 1),
      runDir: dir,
      escalation: {
        reason: 'レビュー担当エージェントが null を返した',
        options: [
          { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
        ],
        recommendation: 0,
        reasoning: '一時的な失敗の可能性',
      },
    }
  }
  // schema 経由で lastReview はパース済み object
  const earlyExit = earlyExitFromReviewUI(lastReview, round, prevRevisionCount)
  if (earlyExit) {
    return earlyExitEscalationUI(earlyExit.kind, earlyExit.reason, round)
  }
  if (lastReview.pass === true) {
    loopSucceeded = true
    break
  }
  prevRevisionCount = (lastReview.revision_required || []).length

  if (round === MAX_REVISION_LOOP) break
  round++
  designOutput = await designerAgent(round)
  if (designOutput == null) {
    return {
      status: 'escalation',
      summary: `Round ${round} の再デザイン失敗`,
      prototypeDir,
      reviewMdPaths: reviewMdPathsUpTo(round - 1),
      runDir: dir,
      escalation: {
        reason: 'デザイン担当エージェントが null を返した',
        options: [
          { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
        ],
        recommendation: 0,
        reasoning: '一時的な失敗の可能性',
      },
    }
  }
  const redesignExit = designerEarlyExitUI(designOutput, round)
  if (redesignExit) return redesignExit
}

// SV は prototypeDir と reviewMdPaths を Read して確認する

const reviewMdPaths = reviewMdPathsUpTo(round)

if (!loopSucceeded) {
  return {
    status: 'escalation',
    summary: `修正ループ ${round} 回で通過せず`,
    prototypeDir,
    reviewMdPaths,
    runDir: dir,
    escalation: {
      reason: `修正ループ上限 (${MAX_REVISION_LOOP} 回) に達しても品質基準を満たせず`,
      options: [
        { title: '要件見直し', description: 'UI 要件をユーザと再検討', tradeoffs: 'ユーザ再対話', effort: '中' },
        { title: '現状で受け入れ', description: '最終ラウンドの案を採用', tradeoffs: '品質基準未達', effort: '小' },
        { title: 'デザインスタイル変更', description: '違うアプローチで再挑戦', tradeoffs: '時間・トークン増', effort: '中' },
      ],
      recommendation: 0,
      reasoning: `${MAX_REVISION_LOOP} 回で通過しない場合、要件側の問題の可能性`,
    },
  }
}

if (svArgs.checkpoint_declarations && svArgs.checkpoint_declarations.includes('ui_prototyped')) {
  return {
    status: 'checkpoint_stop',
    summary: 'UI プロトタイプ完成、ユーザ確認待ち',
    prototypeDir,
    reviewMdPaths,
    checkpoint: {
      name: 'ui_prototyped',
      reason: 'ユーザ宣言のチェックポイント',
    },
  }
}

return {
  status: 'success',
  summary: `UI プロトタイプ完成 (${round} ラウンド)。${prototypeDir} に保存`,
  prototypeDir,
  reviewMdPaths,
}
