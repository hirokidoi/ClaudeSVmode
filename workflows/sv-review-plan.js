export const meta = {
  name: 'sv-review-plan',
  description: 'SV 自作の計画・設計を独立レビューして通過判定を返す',
  whenToUse: 'SV が対話中に計画を立てた後、実装に入る前 (設計スキップ時の必須ステップ)',
  phases: [
    { title: 'セルフチェック確認' },
    { title: 'レビュー' },
  ],
  argsSchema: {
    wf_specific: {
      plan_path: { type: 'string', required: true, description: 'SV が起草した計画・設計 md のパス' },
      selfcheck_path: { type: 'string', required: true, description: 'SV がレビュー前に実施したセルフチェックの証跡 md のパス' },
      plan_type: { type: 'enum', values: ['design', 'implementation-plan', 'refactor-plan'], required: true },
      context: { type: 'object', required: false, description: '対話で合意した要件・制約 (requirements/constraints/affected_files 等)' },
      prev_plan_path: { type: 'string', required: false, description: '前バージョン計画 md のパス。指定時は diff モードで起動' },
      prev_run_id: { type: 'string', required: false, description: '前回 sv-review-plan 実行の run_id。指定時は前回スナップショットを prev_plan_path として自動採用 (prev_plan_path 明示指定があればそちらを優先)' },
    },
  },
}

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    plan_path: { type: 'string', required: true },
    selfcheck_path: { type: 'string', required: true },
    plan_type: { type: 'enum', values: ['design', 'implementation-plan', 'refactor-plan'], required: true },
    context: { type: 'object', required: false },
    prev_plan_path: { type: 'string', required: false },
    prev_run_id: { type: 'string', required: false },
  },
}

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

const CHECKPOINT_NAMES = ['investigated', 'ui_prototyped', 'designed', 'implemented']

const COMMON_ARGS_SCHEMA = {
  tmp_base_dir: { type: 'string', required: true },
  run_id: { type: 'string', required: true },
  project_memory_path: { type: 'string', required: false },
  project_root: { type: 'string', required: false },
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

// ============================================================================
// Self-check gate — copied into review wfs
// ============================================================================

const SELFCHECK_GATE_SCHEMA = {
  type: 'object',
  properties: {
    performed: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['performed', 'reason'],
}

async function runSelfcheckGate(selfcheckPath, targetDescription) {
  const prompt = `
あなたはレビュー前に依頼者が作成したセルフチェック証跡を確認する担当です。

# 確認対象
- セルフチェック証跡: ${selfcheckPath}
- レビュー対象: ${targetDescription}
- プロジェクトルート: ${svArgs.project_root || '不明 (作業ディレクトリを使用)'}

# 手順
1. 証跡を Read する。存在しない・空なら performed=false
2. レビュー対象の規模を把握する (git diff --stat や対象ファイルの Read 程度でよい)
3. 証跡から「依頼者がレビュー前に自分で確認を実施したこと」が読み取れ、内容が対象の規模に対して妥当なら performed=true

# 判定の目安
- 何を確認し、結果がどうだったかが具体的に書かれていれば実施ありとみなす。書式・見出しは問わない
- 濃さは規模に応じてよい (ドキュメント 1 行の変更なら数行で足りる)
- 「確認した」「問題なし」だけで、何をどう確認したかが読み取れないものは実施なしとみなす
- 確認内容の正しさの検証や再実行はしない

# 出力
performed と、判定理由 (1〜2 文) を返す
`.trim()

  const gate = await agent(prompt, agentOpts('selfcheck_gate', 'selfcheck-gate', { schema: SELFCHECK_GATE_SCHEMA }))
  if (gate == null) {
    return {
      status: 'escalation',
      summary: 'セルフチェック確認の実行失敗',
      escalation: {
        reason: '確認担当エージェントが null を返した',
        options: [
          { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
        ],
        recommendation: 0,
        reasoning: '一時的な失敗の可能性',
      },
    }
  }
  if (!gate.performed) {
    return {
      status: 'rejected',
      summary: `セルフチェック証跡不備のためレビュー未実施: ${gate.reason}`,
      rejection: { reason: gate.reason, selfcheck_path: selfcheckPath },
    }
  }
  return null
}
// ============================================================================

// ============================================================================
// Main
// ============================================================================

const { plan_path, selfcheck_path, plan_type, context, prev_plan_path, prev_run_id } = svArgs.wf_specific
const dir = runDir('sv-review-plan')

if (prev_run_id != null) {
  const prevRunIdErrors = fileNameErrors('args.wf_specific.prev_run_id', prev_run_id)
  if (prevRunIdErrors.length > 0) return argsValidationEscalation(prevRunIdErrors)
}

phase('セルフチェック確認')

const gateResult = await runSelfcheckGate(selfcheck_path, `計画 md: ${plan_path} (計画種別: ${plan_type})`)
if (gateResult) return gateResult

phase('レビュー')

const reviewOutputPath = `${dir}/agents/plan-review.md`
const snapshotDir = `${dir}/agents`
const snapshotPath = `${snapshotDir}/plan-snapshot.md`

// diff モードの入力解決 (パス構築は文字列連結のみ、実在確認は agent が Bash 経由で行う)。
// prev_plan_path 明示指定を prev_run_id 経由より優先する。
let resolvedPrevPlanPath = null
let resolvedPrevReviewPath = null
if (prev_plan_path) {
  resolvedPrevPlanPath = prev_plan_path
  const slashIdx = prev_plan_path.lastIndexOf('/')
  const prevDir = slashIdx >= 0 ? prev_plan_path.slice(0, slashIdx) : '.'
  resolvedPrevReviewPath = `${prevDir}/plan-review.md`
} else if (prev_run_id) {
  const prevAgentsDir = `${svArgs.tmp_base_dir}/wf-sv-review-plan/${prev_run_id}/agents`
  resolvedPrevPlanPath = `${prevAgentsDir}/plan-snapshot.md`
  resolvedPrevReviewPath = `${prevAgentsDir}/plan-review.md`
}
const diffMode = resolvedPrevPlanPath != null

const planTypeSpecialization = {
  design: `
主眼:
- 責務分割: 各モジュール/クラスが単一責務か
- 依存関係: 循環依存はないか、依存方向は妥当か
- 抽象化: 過剰抽象・過小抽象がないか
`.trim(),
  'implementation-plan': `
主眼:
- 変更順序: 依存を尊重しているか
- 変更範囲の網羅性: 影響ファイルの列挙は十分か
- 途中状態の妥当性: 中間状態でシステムが壊れないか
`.trim(),
  'refactor-plan': `
主眼:
- 振る舞い保存: 外部から見える振る舞いが変わらないか
- テストによる裏付け: リファクタ前後でテストが通り続けるか
- 影響範囲: 隠れた依存はないか
`.trim(),
}

const planChecksBlock = `
# チェック観点 (省略しない。計画に該当しない観点は na + 理由)
${reviewChecksBlock(Object.keys(REVIEW_CHECKS).filter(k => k !== 'progress'))}
`.trim()

const verdictRuleBlock = `
# verdict と重大度の対応
- NG: blocker がある、または upstream_precondition_failed / plan_path_unreadable が true
- conditional-pass: must_fix だけで、いずれも局所的な追記・修正で解消できる
- pass: suggestion だけ
- NG と conditional-pass はどちらも不合格 (SEVERITY_RULE の pass=false に相当)。SV は修正してから diff モードで再レビューする
- upstream_precondition_failed: 計画の前提となる上流 (要件・上位設計等) が成立していないとき true。詳細レビューは行わず、理由を upstream_precondition_reason に書く

${SEVERITY_RULE}
- revisions: blocker と must_fix の指摘 (severity / location / instruction)
- additional_findings: suggestion の指摘 (location / detail)
`.trim()

const REVIEW_PLAN_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    md_written: { type: 'boolean' },
  },
  required: ['verdict', 'md_written'],
}

const resultInstruction = `
# 最終応答
md を保存した後、Read で存在を確認してから StructuredOutput で md_written=true を返してください。
verdict は md の判定 JSON と一致させてください。
`.trim()

// 次回の prev_run_id で参照するため毎回残す。失敗しても判定には影響させない
const snapshotInstruction = `
# 最初に実施: スナップショット保存
次回以降の diff レビューのため、本題のレビューに入る前に Bash で以下を実行してください:
\`mkdir -p ${snapshotDir} && cp ${plan_path} ${snapshotPath}\`
失敗しても判定には影響させず、ログにのみ残してください。
`.trim()

const reviewPrompt = !diffMode ? `
あなたは計画レビュー担当エージェントです。

# ロール定義 (必読)
以下を Read で全文読み、指示を全て守ってください:
- ~/.claude/roles/reviewer.md

${policyReferenceBlock(svArgs.project_memory_path)}

# レビュー対象
計画 md: ${plan_path}
計画種別: ${plan_type}

# 最初に確認: plan_path の可読性
まず ${plan_path} を Read してください。読めない場合 (パス誤り等) は、以降のレビュー手順を行わず、
判定 JSON の \`plan_path_unreadable\` を true にし、verdict を "NG" とした上で理由のみを記載した md を出力してください。

# 対話で合意した要件・制約
${JSON.stringify(context || {}, null, 2)}

# 計画種別に応じた観点
${planTypeSpecialization[plan_type]}

${snapshotInstruction}

${planChecksBlock}

# 出力
以下パスに md 保存:
${reviewOutputPath}

構成:
- ## 判定 (pass / conditional-pass / NG。定義は下記 verdict と重大度の対応)
- ## 判定 JSON (判定の直下)
- ## 対象計画のサマリ
- ## 計画種別観点別詳細
- ## チェック観点
- ## 追加所見 (suggestion)
- ## 修正指示

判定 JSON:
{
  "verdict": "pass" | "conditional-pass" | "NG",
  "checks": {<観点キー>: {"status": "ok|issue|na", "detail": "..."}},
  "revisions": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}],
  "upstream_precondition_failed": true|false,
  "upstream_precondition_reason": "..." | null,
  "plan_type_mismatch": true|false,
  "plan_path_unreadable": true|false,
  "review_mode": "full"
}

${verdictRuleBlock}

# 制約
- 計画 md を Read で確認してから判定
- 「知っている」で済ませない
- plan_type と実際の内容が乖離しているなら plan_type_mismatch=true にする
- 最終応答は「レビュー完了 (verdict=<...>)」の 1 文で良い

${resultInstruction}
`.trim() : `
あなたは計画レビュー担当エージェントです (前回計画との diff レビュー)。

# ロール定義 (必読)
以下を Read で全文読み、指示を全て守ってください:
- ~/.claude/roles/reviewer.md

${policyReferenceBlock(svArgs.project_memory_path)}

# レビュー対象
計画 md: ${plan_path}
計画種別: ${plan_type}
前回計画 md (diff 元): ${resolvedPrevPlanPath}
前回レビュー結果 md: ${resolvedPrevReviewPath}

# 最初に確認: plan_path の可読性
まず ${plan_path} を Read してください。読めない場合 (パス誤り等) は、以降のレビュー手順を行わず、
判定 JSON の \`plan_path_unreadable\` を true にし、verdict を "NG" とした上で理由のみを記載した md を出力してください。

# 対話で合意した要件・制約
${JSON.stringify(context || {}, null, 2)}

# 計画種別に応じた観点
${planTypeSpecialization[plan_type]}

${snapshotInstruction}

# 背景
SV は前回の sv-review-plan 結果を信頼している前提で diff レビューを依頼しています。
目的は「前回指摘が解消されたか」と「今回の変更が新たな問題を生んでいないか」の確認です。
全文フル監査ではなく、局所的な差分であれば diff 箇所のみの focused レビューで済ませます。

# 手順
1. 前回計画 md (${resolvedPrevPlanPath}) を Read で読めるか確認する。
   読めない場合 (パス誤り・スナップショット未生成等) は diff を諦め、
   下記「--- フル監査に切り替えた場合のみ実施 ---」を全て実施した上で、
   判定 JSON の \`prev_run_lookup_error\` に読めなかった理由を記録してください。
2. 読める場合、Bash で \`diff ${resolvedPrevPlanPath} ${plan_path}\` を実行し変更差分を把握する。
3. 前回レビュー結果 (${resolvedPrevReviewPath}) を Read で確認する。
   読めない場合、または前回の判定 JSON で plan_path_unreadable か upstream_precondition_failed が true の場合は、
   前回の監査範囲を信頼できないので、フル監査に切り替えて \`prev_run_lookup_error\` に理由を記録する。
   読めて信頼できる場合は、その revisions 各項目が今回の diff で解消されているか個別に検証する (解消/未解消 + 根拠)。
4. 差分が「指摘への対応 + その直接の波及範囲」に収まり局所的か判定する。
   新規セクション追加・方針変更・広範な書き換えがあれば「局所的ではない」と判断する。
5. モード分岐:
   - 局所的 → diff に現れた箇所のみ新規監査する。それ以外の箇所は前回 pass を信頼し、再監査しない。
   - 局所的でない、前回計画 md が読めない、または手順 3 で前回結果を信頼できない → フル監査に切り替え、下記チェックを全て実施する。

--- フル監査に切り替えた場合のみ実施 ---
${planChecksBlock}
---

# 出力
以下パスに md 保存:
${reviewOutputPath}

構成:
- ## 判定 (pass / conditional-pass / NG。定義は下記 verdict と重大度の対応)
- ## 判定 JSON (判定の直下)
- ## 対象計画のサマリ
- ## 計画種別観点別詳細
- ## チェック観点
- ## 指摘解消の検証 (前回 revisions 各項目の解消状況 + 根拠。前回レビュー結果を実際に参照できた場合のみ)
- ## 追加所見 (suggestion)
- ## 修正指示

判定 JSON:
{
  "verdict": "pass" | "conditional-pass" | "NG",
  "checks": {<観点キー>: {"status": "ok|issue|na", "detail": "..."}},
  "revisions": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}],
  "upstream_precondition_failed": true|false,
  "upstream_precondition_reason": "..." | null,
  "plan_type_mismatch": true|false,
  "plan_path_unreadable": true|false,
  "review_mode": "diff" | "full",
  "revision_items_resolved": [{"instruction": "...", "resolved": true|false, "evidence": "..."}],
  "prev_run_lookup_error": "..." | null
}

${verdictRuleBlock}

# 制約
- 計画 md (今回・前回とも読める場合は前回も) を Read で確認してから判定
- 「知っている」で済ませない
- plan_type と実際の内容が乖離しているなら plan_type_mismatch=true にする
- diff に現れない箇所を探しに行く監査はしない (前回 pass を信頼する)。ただし作業中に気づいた問題は additional_findings に記載する (重大なら revisions)。diff 箇所が離れた箇所に副作用を及ぼしていないかは diff 全体を見て確認する
- \`prev_run_lookup_error\` は前回計画 md (${resolvedPrevPlanPath}) と前回レビュー結果の読み取り可否、および前回結果を信頼できない理由を記録する (revisions には計画内容そのものへの指摘のみを含める)
- 最終応答は「レビュー完了 (verdict=<...>, mode=<diff|full>)」の 1 文で良い

${resultInstruction}
`.trim()

const review = await agent(reviewPrompt, agentOpts('reviewer', `plan-review:${plan_type}${diffMode ? ':diff' : ''}`, { schema: REVIEW_PLAN_RESULT_SCHEMA }))

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
  return {
    status: 'escalation',
    summary: '計画レビュー成果物 md が保存されていない',
    escalation: {
      reason: 'レビュー担当が成果物 md を保存できなかった',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性',
    },
    runDir: dir,
  }
}

// レビュー agent が書いた md をそのまま outputPath として返す。SV はこの path を Read する。

return {
  status: 'success',
  summary: `計画レビュー完了 (verdict=${review.verdict})`,
  outputPath: reviewOutputPath,
}
