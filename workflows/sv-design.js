export const meta = {
  name: 'sv-design',
  description: '要件から設計を作り独立レビューを通した承認済み設計書を返す',
  whenToUse: '要件確定後、実装に入る前に設計を wf に委任する時',
  phases: [
    { title: '設計' },
    { title: 'レビュー' },
    { title: '修正ループ' },
  ],
  argsSchema: {
    wf_specific: {
      requirements: { type: 'string', required: true, description: '確定済み要件' },
      constraints: { type: 'array', required: false, items: { type: 'string' }, description: '制約の配列' },
      investigation_result_path: { type: 'string', required: false, description: '調査結果 md のパス' },
      scope: { type: 'object', required: false, description: 'target_paths と out_of_scope', properties: { target_paths: { type: 'array', required: false, items: { type: 'string' } }, out_of_scope: { type: 'array', required: false, items: { type: 'string' } } } },
      design_style_preference: { type: 'enum', values: ['aggressive', 'conservative'], required: false, description: 'デフォルト conservative' },
    },
  },
}

// 本体からは meta を参照できないため meta.name と同じ値を持つ
const _WF_NAME = 'sv-design'

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    requirements: { type: 'string', required: true },
    constraints: { type: 'array', required: false, items: { type: 'string' } },
    investigation_result_path: { type: 'string', required: false },
    scope: { type: 'object', required: false, properties: { target_paths: { type: 'array', required: false, items: { type: 'string' } }, out_of_scope: { type: 'array', required: false, items: { type: 'string' } } } },
    design_style_preference: { type: 'enum', values: ['aggressive', 'conservative'], required: false },
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
    contradiction_detected: { type: 'boolean' },
    contradiction_reason: { type: 'string' },
    design_precondition_failed: { type: 'boolean' },
    design_precondition_reason: { type: 'string' },
  },
  required: ['round', 'contradiction_detected', 'design_precondition_failed'],
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
    revision_required: { type: 'array', items: { type: 'object' } },
    additional_findings: { type: 'array', items: { type: 'object' } },
  },
  required: ['pass', 'upstream_precondition_failed', 'structural_rethink_required', 'revision_count_high', 'designer_stuck', 'revision_required'],
}

// ============================================================================
// Main
// ============================================================================

const {
  requirements,
  constraints,
  investigation_result_path,
  scope,
  design_style_preference,
} = svArgs.wf_specific
const dir = runDir(_WF_NAME)
const style = design_style_preference || 'conservative'

async function designerAgent(round, feedback, previousDesignPath) {
  phase(round === 1 ? '設計' : '修正ループ')
  const outputPath = `${dir}/loop/round-${round}-output.md`
  const label = `design-r${round}`

  // round 2 以降は全文再生成せず「前版コピー + 指摘箇所のみ Edit」の増分修正。
  // diff が指摘対応の最小範囲に収まることで、reviewer 側の focused 再レビューが機能する。
  if (round >= 2) {
    const incrementalPrompt = `
あなたは設計担当エージェントです (round ${round}: レビュー指摘の増分修正)。

${roleSection('designer')}

# タスク
round ${round - 1} の設計案に対するレビュー指摘 (revision_required) を、全文書き直しではなく差分修正で反映します。
再レビューは diff ベースの focused レビューで行われるため、diff を指摘対応の最小範囲に保つことが品質要件です。

# 入力 (Read で確認)
- 直前のレビュー (revision_required を含む): ${feedback}
- 直前の設計案: ${previousDesignPath}

# 手順 (厳守)
1. Bash で \`cp ${previousDesignPath} ${outputPath}\` を実行する。
2. ${outputPath} に対し、revision_required の各項目が指す箇所だけを Edit で修正する。
   - 指摘対応として必要な新規小節の追加は可
   - 指摘と無関係なセクションの書き換え・再構成・整形・文言調整は禁止
3. 判定 JSON の "round" を ${round} に更新する (contradiction / precondition は修正中に新たに発覚した場合のみ true。true にした場合は設計を無理に仕上げず、理由を具体的に書く)。
4. 修正内容の正しさの担保に必要な範囲で、下記の要件・制約・調査結果を参照する。

# 参考情報 (修正判断に必要な範囲で参照)
## 要件
${requirements}

## 制約
${(constraints || []).map(c => `- ${c}`).join('\n') || 'なし'}

## スコープ
- 対象パス: ${(scope?.target_paths || []).join(', ') || '未指定'}
- 対象外: ${(scope?.out_of_scope || []).join(', ') || 'なし'}

${investigation_result_path ? `## 既存調査結果\n${investigation_result_path}` : ''}

# 制約
- 判断に迷ったら決定せず、成果物に明記
- 最終応答は「設計修正完了 (round=${round}, 修正箇所: <セクション名の列挙>)」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して以下 schema に従った判定オブジェクトを返してください。md 内の判定 JSON と必ず一致させること。

schema フィールド:
- round: number (${round})
- contradiction_detected: bool
- contradiction_reason: string
- design_precondition_failed: bool
- design_precondition_reason: string
`.trim()
    return svAgent(incrementalPrompt, 'designer', label, { schema: DESIGNER_SCHEMA, agentType: 'general-purpose', mailbox: 'design' })
  }

  const prompt = `
あなたは設計担当エージェントです。

${roleSection('designer')}

# 要件
${requirements}

# 制約
${(constraints || []).map(c => `- ${c}`).join('\n') || 'なし'}

# スコープ
- 対象パス: ${(scope?.target_paths || []).join(', ') || '未指定'}
- 対象外: ${(scope?.out_of_scope || []).join(', ') || 'なし'}

# 設計スタイル指定
${style}
- conservative: 既存構造を尊重し、必要最小限の変更で目的を達成
- aggressive: 抜本的リファクタも視野に、より良い構造を目指す

${investigation_result_path ? `# 既存調査結果\n以下ファイルを Read で確認して活用してください:\n${investigation_result_path}` : ''}

# 出力
以下パスに md 保存:
${outputPath}

**md 構成の絶対順序 (この順で書く。順序変更・判定 JSON 文末配置は禁止):**
1. \`# タイトル\` (1 行)
2. \`## 総合評価\` (設計成立 / precondition_failed / contradiction_detected + 1〜3 行サマリ) — タイトル直下
3. \`## 判定 JSON\` (下記 schema の JSON をコードブロックで貼る) — **総合評価の直下に必ず配置。文末不可**
4. \`## 早期打ち切り理由\` (precondition_failed / contradiction_detected 時のみ)
5. \`## 要件 (再掲)\`
6. \`## スコープ\`
7. \`## 設計方針 (全体アプローチ)\`
8. \`## 変更計画 (変更ごとに Before/After/理由)\`
9. \`## 依存関係と実装順序 (並列可 / 順次必要)\`
10. \`## 想定リスクと対応\`
11. \`## テスト計画 (新規テスト / 既存テストへの影響)\`

判定 JSON:
{
  "round": ${round},
  "contradiction_detected": false | true,
  "contradiction_reason": "...",
  "design_precondition_failed": false | true,
  "design_precondition_reason": "..."
}

要件同士に矛盾があると判断した場合は contradiction_detected=true にしてください。

以下いずれかに該当し「今の入力のままでは適切な設計ができない」と判断した場合、変更計画等を無理に埋めず design_precondition_failed=true として即座に SV に戻してください (全ラウンドで判定する)。
- 要件が曖昧すぎて設計判断が下せない
- スコープが広すぎて一度の設計に収まらない
- 前提となる調査結果が不足していて設計判断の根拠が持てない
- そもそも技術的に実現困難な要件が含まれている

# 早期打ち切り時の出力最小化 (contradiction_detected / design_precondition_failed が true の場合)
- 設計本文 (変更計画・依存関係・リスク分析・テスト計画) は書かず、md には以下のみを含める:
  - ## 総合評価 (precondition_failed / contradiction_detected + 1〜3 行サマリ)
  - ## 判定 JSON (総合評価の直下)
  - ## 早期打ち切り理由 (数行の要約)
  - ## 要件 (再掲)
- 「設計不能な理由」だけを簡潔に伝えることに徹する。分析文書を書き上げようとしない

# 制約
- 判断に迷ったら決定せず、成果物に明記
- 最終応答は「設計完了 (round=${round})」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して以下 schema に従った判定オブジェクトを返してください。schema で required 指定されているフィールドは必ず含めること (欠落すると framework が再試行を要求する)。md への判定 JSON は StructuredOutput の内容と必ず一致させること。

schema フィールド:
- round: number (${round})
- contradiction_detected: bool
- contradiction_reason: string
- design_precondition_failed: bool
- design_precondition_reason: string
`.trim()

  return svAgent(prompt, 'designer', label, { schema: DESIGNER_SCHEMA, agentType: 'general-purpose', mailbox: 'design' })
}

// round 1 はフル監査。round 2 以降は前ラウンドとの diff を取り、指摘の解消確認に絞る
// focused 再レビュー (差分が広範・構造的なら自動でフル監査に fall back)。
async function reviewerAgent(round) {
  phase('レビュー')
  const designPath = `${dir}/loop/round-${round}-output.md`
  const outputPath = `${dir}/loop/round-${round}-review.md`
  const prevReviewPath = `${dir}/loop/round-${round - 1}-review.md`
  const prevDesignPath = `${dir}/loop/round-${round - 1}-output.md`

  const fullReviewBlock = `
# チェック観点 (省略しない。設計に該当しない観点は na + 理由)
${reviewChecksBlock(Object.keys(REVIEW_CHECKS).filter(k => k !== 'progress'))}

# 設計固有チェック
- 責務分割の妥当性
- 依存関係の適切性 (循環依存なし)
- スコープ (対象パス) 内に変更が収まっているか
- 抽象化レベル
`.trim()

  const prompt = round === 1 ? `
あなたは設計レビュー担当エージェントです。

${roleSection('reviewer')}

${policyReferenceBlock(svArgs.project_memory_path)}

# レビュー対象
設計案 md: ${designPath} (Read で確認)

${fullReviewBlock}

# 早期打ち切りシグナル (判定 JSON に必ず含める)
以下に該当すると判断した場合、修正ループでは解消不能と考えられるため即座に SV へエスカレーションする材料として明示する。
- **upstream_precondition_failed: true** — 対象設計 md が「意味・価値」の判定 (reviewer.md 参照) を満たさない (実質的な変更計画を含まない / Q&A 差し戻しのみ / SV が次工程に進めない)
- **structural_rethink_required: true** — 責務分割・スコープ・設計方針レベルの根本見直しが必要 (feedback で修正可能な粒度を超える)

upstream_precondition_failed / structural_rethink_required のどちらかが true なら判定は pass=false かつ SV への警告として理由を明示する。

以下は件数に関するシグナル。
- **revision_count_high: true** — revision_required が ${REVISION_COUNT_HIGH_THRESHOLD} 件以上。round 1 では打ち切らず修正ループで引き受ける (round 2 以降、件数が前回以上なら打ち切りの材料になる)

# 早期打ち切り時の出力最小化 (upstream_precondition_failed / structural_rethink_required が true の場合)
- チェック観点 / 設計固有チェックの詳細列挙は省略し、md には以下のみを含める:
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
5. \`## チェック観点\`
6. \`## 設計固有チェック\`
7. \`## 追加所見\` (suggestion)
8. \`## 修正指示\` (blocker / must_fix)

判定 JSON schema (上記 3. で貼る内容):
{
  "pass": true|false,
  "review_mode": "full",
  "upstream_precondition_failed": bool,
  "upstream_precondition_reason": "...",
  "structural_rethink_required": bool,
  "structural_rethink_reason": "...",
  "revision_count_high": bool,
  "checks": {"<観点キー>": {"status": "ok|issue|na", "detail": "..."}},
  "revision_required": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}]
}

${SEVERITY_RULE}
${FINDINGS_PLACEMENT_RULE}

# 制約
- 設計 md を Read で確認してから判定
- 最終応答は「レビュー完了 (pass=<bool>)」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して schema に従った判定オブジェクトを返してください。required フィールド (pass / upstream_precondition_failed / structural_rethink_required / revision_count_high / revision_required) は必ず含めること。md への判定 JSON は StructuredOutput の内容と必ず一致させること。
`.trim() : `
あなたは設計レビュー担当エージェントです (round ${round} の focused 再レビュー)。

${roleSection('reviewer')}

${policyReferenceBlock(svArgs.project_memory_path)}

# 背景
round ${round - 1} のレビュー指摘を設計担当が修正しました。全文フル監査ではなく focused 再レビューを行います。
目的は「指摘が解消されたか」と「その修正が新たな問題を生んでいないか」の確認です。

# 入力 (すべて Read で確認)
- 前回レビュー (指摘一覧): ${prevReviewPath}
- 前回設計案: ${prevDesignPath}
- 今回設計案: ${designPath}

# 手順
1. Bash で \`diff ${prevDesignPath} ${designPath}\` を実行し変更差分を把握する。
2. 前回レビューの revision_required 各項目が今回設計で解消されたか検証する (解消/未解消 + 根拠)。
3. 差分が「指摘項目への対応 + その直接の波及範囲」に収まり機械的・局所的か判定する。
   前回 revision_required が明示的に要求している新規小節の追加は「局所」として扱う。
   それ以外の新規セクション追加・設計方針/依存関係/責務分割の変更・指摘と無関係な広範な書き換えがあれば「局所ではない」と判断する。
4. モード分岐:
   - 差分が局所的 かつ revision_required 全件が解消 → focused pass。
     diff に現れた箇所についてのみ新規問題がないか確認すればよく、変更のない箇所は前回 pass を信頼して再監査しない。
   - 差分が広範・構造的、または未解消/新規問題あり → フル監査に切替え、下記チェックを全て実施する。

--- フル監査に切り替えた場合のみ実施 ---
${fullReviewBlock}
---

# 早期打ち切りシグナル (判定 JSON に必ず含める)
Round 1 と同じ・類似の指摘が繰り返される場合、designer が feedback ループでは対処不能な可能性が高い。以下を明示する。
- **unresolved_from_previous**: 前回の revision_required のうち、今回も未解消 or 別表現で同じ問題が再発している項目
- **designer_stuck: true** — 前回指摘の過半数 (半分以上) が未解消、または前回と本質的に同じ指摘が新たに再出現している場合 (feedback で改善できないシグナル)
- **structural_rethink_required: true** — round 1 と同じ判定基準。この round で新たに気付いた場合も true にする
- **revision_count_high: true** — revision_required が ${REVISION_COUNT_HIGH_THRESHOLD} 件以上 (wf が前回件数と比べて打ち切りを判断する)
- **upstream_precondition_failed: true** — round 1 と同じ判定基準。この round で新たに気付いた場合も true にする

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

判定 JSON schema (上記 3. で貼る内容):
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
  "checks": {"<観点キー>": {"status": "ok|issue|na", "detail": "..."}},
  "revision_required": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}]
}

${SEVERITY_RULE}
${FINDINGS_PLACEMENT_RULE}

# 制約
- diff と 3 ファイルを Read してから判定
- focused でも「変更が離れた箇所に副作用を及ぼしていないか」は diff 全体を見て確認する (diff に現れない箇所は前回 pass を信頼)
- 最終応答は「レビュー完了 (pass=<bool>, mode=<focused|full>)」の 1 文で良い

# StructuredOutput の呼び出し (必須)
最終応答テキストを返す前に、**必ず StructuredOutput ツール**を呼び出して schema に従った判定オブジェクトを返してください。required フィールド (pass / upstream_precondition_failed / structural_rethink_required / revision_count_high / designer_stuck / revision_required) は必ず含めること。md への判定 JSON は StructuredOutput の内容と必ず一致させること。
`.trim()

  const schema = round === 1 ? REVIEWER_R1_SCHEMA : REVIEWER_R2_SCHEMA
  return svAgent(prompt, 'reviewer', `review-r${round}`, { schema, agentType: 'general-purpose', mailbox: 'review' })
}

function reviewMdPathsUpTo(n) {
  return Array.from({ length: n }, (_, i) => `${dir}/loop/round-${i + 1}-review.md`)
}

// 設計担当の打ち切りフラグ (全ラウンドで判定)。該当すれば escalation、なければ null
function designerEarlyExit(designOutput, roundNum) {
  const paths = {
    runDir: dir,
    outputPath: `${dir}/loop/round-${roundNum}-output.md`,
    reviewMdPaths: reviewMdPathsUpTo(roundNum - 1),
  }
  if (designOutput.contradiction_detected === true) {
    return {
      status: 'escalation',
      summary: '要件の矛盾を検出',
      ...paths,
      escalation: {
        reason: `設計担当が要件同士の矛盾を検出: ${designOutput.contradiction_reason || '(理由未記載)'}`,
        options: [
          { title: '要件優先順位を決定', description: 'どちらを優先するかユーザに判断依頼', tradeoffs: '片方の要件が犠牲', effort: '小' },
          { title: '要件そのものを見直し', description: '両立可能な形に再定義', tradeoffs: '再対話', effort: '中' },
        ],
        recommendation: 0,
        reasoning: '判断は SV とユーザで',
      },
    }
  }
  if (designOutput.design_precondition_failed === true) {
    return {
      status: 'escalation',
      summary: '設計前提が不足しており設計不能と判定',
      ...paths,
      escalation: {
        reason: `設計担当が「要件曖昧 / スコープ広すぎ / 前提調査不足 / 技術的に実現困難」のいずれかを検出: ${designOutput.design_precondition_reason || '(理由未記載)'}`,
        options: [
          { title: '要件を具体化', description: '要件を具体化・明確化してから再度設計 wf を起動', tradeoffs: 'ユーザ再対話', effort: '中' },
          { title: '調査からやり直し', description: 'sv-investigate で前提情報を補ってから設計に戻る', tradeoffs: '時間増', effort: '中' },
          { title: 'スコープを狭める', description: 'スコープを分割して段階的に設計 wf を起動', tradeoffs: '複数フェーズ', effort: '中' },
        ],
        recommendation: 0,
        reasoning: '設計不能状態で reviewer を回すのは無駄。上流に戻るのが効率的',
      },
    }
  }
  return null
}

let round = 1
let designOutput = await designerAgent(round)
if (designOutput == null) {
  return {
    status: 'escalation',
    summary: '設計初回実行失敗',
    runDir: dir,
    escalation: {
      reason: '設計担当エージェントが null を返した',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性',
    },
  }
}

// schema 経由で designerOutput はパース済み object。テキストパースは不要
const firstDesignExit = designerEarlyExit(designOutput, round)
if (firstDesignExit) return firstDesignExit

// schema 経由で reviewerOutput はパース済み object
function earlyExitFromReview(reviewOutput, roundNum, prevRevisionCount) {
  const withReason = (base, detail) => detail ? `${base}: ${detail}` : base
  if (reviewOutput.upstream_precondition_failed === true) return { kind: 'upstream_failed', reason: withReason('レビュー対象に具体的な設計内容が含まれていない (判断書・差し戻し・要件確認要求のみ)。前工程 = 要件・設計判断のやり直しが必要', reviewOutput.upstream_precondition_reason) }
  if (reviewOutput.structural_rethink_required === true) return { kind: 'structural', reason: withReason('設計方針・責務分割・スコープの根本見直しが必要と判定されました', reviewOutput.structural_rethink_reason) }
  // 件数だけを根拠に上流へ差し戻さない。初回の指摘が多いのは修正ループが引き受ける状態であり、
  // 上流の質を疑う根拠になるのは修正を経ても件数が減らないこと。
  const revisionCount = (reviewOutput.revision_required || []).length
  if (reviewOutput.revision_count_high === true && roundNum >= 2 && prevRevisionCount != null && revisionCount >= prevRevisionCount) {
    return { kind: 'revision_high', reason: `revision_required が ${REVISION_COUNT_HIGH_THRESHOLD} 件以上で、前回 ${prevRevisionCount} 件から今回 ${revisionCount} 件と減っていない。前工程 (要件・調査) の質に問題がある可能性が高い` }
  }
  if (reviewOutput.designer_stuck === true && roundNum >= 2) return { kind: 'stuck', reason: withReason('前回指摘の過半数が未解消。designer が feedback ループでは対処不能と判定', reviewOutput.designer_stuck_reason) }
  return null
}

function earlyExitEscalation(kind, reason, roundNum, outputPath, reviewMdPaths) {
  const optionsByKind = {
    upstream_failed: [
      { title: '要件を具体化', description: '要件を具体的な受け入れ条件に落として再度設計 wf を起動', tradeoffs: 'ユーザ再対話', effort: '中' },
      { title: '調査からやり直し', description: 'sv-investigate で前提情報を補ってから設計に戻る', tradeoffs: '時間増', effort: '中' },
      { title: 'スコープを狭める', description: 'スコープを分割して段階的に設計 wf を起動', tradeoffs: '複数フェーズ', effort: '中' },
    ],
    structural: [
      { title: '要件・調査からやり直し', description: 'sv-investigate か要件見直しに戻る', tradeoffs: '時間増', effort: '中' },
      { title: '設計スタイル切替', description: 'design_style_preference を反対にして再試行', tradeoffs: '別リスク', effort: '中' },
      { title: '要件を分割して段階設計', description: 'スコープを狭めて別 wf で個別対応', tradeoffs: '複数フェーズ', effort: '中' },
    ],
    revision_high: [
      { title: '要件を見直す', description: '要件そのものが曖昧 / 相互矛盾していないか再確認', tradeoffs: 'ユーザ再対話', effort: '中' },
      { title: '調査からやり直し', description: '前提情報が不足の可能性、sv-investigate に戻る', tradeoffs: '時間増', effort: '中' },
      { title: '設計スコープを狭める', description: 'スコープを絞って再設計', tradeoffs: '別途対応が残る', effort: '小' },
    ],
    stuck: [
      { title: '要件・調査に戻る', description: 'designer が対処不能な指摘は前工程の質問題の可能性大', tradeoffs: '時間増', effort: '中' },
      { title: '設計スタイル切替', description: 'aggressive/conservative 反対で試す', tradeoffs: '別リスク', effort: '中' },
      { title: '現状で受け入れ', description: '最終ラウンドの案を採用', tradeoffs: '品質基準未達', effort: '小' },
    ],
  }
  return {
    status: 'escalation',
    summary: `Round ${roundNum} で早期打ち切り: ${reason}`,
    outputPath,
    reviewMdPaths,
    runDir: dir,
    escalation: {
      reason,
      options: optionsByKind[kind] || [],
      recommendation: 0,
      reasoning: '手戻り工数が大きい場合、feedback ループを繰り返すより上流に戻るのが効率的',
    },
  }
}

let loopSucceeded = false
let lastReviewPath = null
let prevRevisionCount = null
while (round <= MAX_REVISION_LOOP) {
  const reviewOutput = await reviewerAgent(round)
  if (reviewOutput == null) {
    return {
      status: 'escalation',
      summary: `Round ${round} のレビュー実行失敗`,
      runDir: dir,
      outputPath: `${dir}/loop/round-${round}-output.md`,
      reviewMdPaths: reviewMdPathsUpTo(round - 1),
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
  lastReviewPath = `${dir}/loop/round-${round}-review.md`
  const earlyExit = earlyExitFromReview(reviewOutput, round, prevRevisionCount)
  if (earlyExit) {
    const outputPath = `${dir}/loop/round-${round}-output.md`
    return earlyExitEscalation(earlyExit.kind, earlyExit.reason, round, outputPath, reviewMdPathsUpTo(round))
  }
  if (reviewOutput.pass === true) {
    loopSucceeded = true
    break
  }
  prevRevisionCount = (reviewOutput.revision_required || []).length

  if (round === MAX_REVISION_LOOP) break
  const nextRound = round + 1
  const nextDesign = await designerAgent(nextRound, lastReviewPath, `${dir}/loop/round-${round}-output.md`)
  if (nextDesign == null) {
    return {
      status: 'escalation',
      summary: `Round ${nextRound} の再設計失敗`,
      runDir: dir,
      outputPath: `${dir}/loop/round-${round}-output.md`,
      reviewMdPaths: reviewMdPathsUpTo(round),
      escalation: {
        reason: '設計担当エージェントが null を返した',
        options: [
          { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
        ],
        recommendation: 0,
        reasoning: '一時的な失敗の可能性',
      },
    }
  }
  const redesignExit = designerEarlyExit(nextDesign, nextRound)
  if (redesignExit) return redesignExit
  round = nextRound
}

// 最終ラウンドの設計 md をそのまま outputPath として返す。SV はこの path を Read する。

const outputPath = `${dir}/loop/round-${round}-output.md`
const reviewMdPaths = reviewMdPathsUpTo(round)

if (!loopSucceeded) {
  return {
    status: 'escalation',
    summary: `修正ループ ${round} 回で通過せず`,
    outputPath,
    reviewMdPaths,
    runDir: dir,
    escalation: {
      reason: `修正ループ上限 (${MAX_REVISION_LOOP} 回) に達しても品質基準を満たせず`,
      options: [
        { title: '要件見直し', description: 'ユーザと要件を再検討', tradeoffs: 'ユーザ再対話', effort: '中' },
        { title: 'design_style_preference 変更', description: 'aggressive/conservative を切替えて再試行', tradeoffs: '別のリスク', effort: '中' },
        { title: '現状で受け入れ', description: '最終ラウンドの案を採用', tradeoffs: '品質基準未達', effort: '小' },
      ],
      recommendation: 0,
      reasoning: `${MAX_REVISION_LOOP} 回で通過しない場合、要件側の問題の可能性`,
    },
  }
}

if (svArgs.checkpoint_declarations && svArgs.checkpoint_declarations.includes('designed')) {
  return {
    status: 'checkpoint_stop',
    summary: '設計完了 (ユーザ確認待ち)',
    outputPath,
    reviewMdPaths,
    checkpoint: {
      name: 'designed',
      reason: 'ユーザ宣言のチェックポイント',
    },
  }
}

return {
  status: 'success',
  summary: `設計完了 (${round} ラウンド)`,
  outputPath,
  reviewMdPaths,
}
