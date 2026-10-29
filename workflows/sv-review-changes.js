export const meta = {
  name: 'sv-review-changes',
  description: '手元の変更を単発レビューして判定を返す (SV 直接編集後や割り込み対応後)',
  whenToUse: 'SV 直接編集後、または軽微な変更後の独立レビュー',
  phases: [
    { title: 'セルフチェック確認' },
    { title: 'レビュー' },
  ],
  argsSchema: {
    wf_specific: {
      change_scope: {
        type: 'object',
        required: true,
        description: 'files 配列と commit_range を含む変更範囲',
        properties: { files: { type: 'array', required: true, items: { type: 'string' } }, commit_range: { type: 'string', required: false } },
      },
      selfcheck_path: { type: 'string', required: true, description: 'SV がレビュー前に実施したセルフチェックの証跡 md のパス' },
      context: { type: 'string', required: false, description: '変更の意図・背景 (自然言語)' },
      focus_areas: { type: 'array', required: false, items: { type: 'string' }, description: '重点観点の配列' },
    },
  },
}

// 本体からは meta を参照できないため meta.name と同じ値を持つ
const _WF_NAME = 'sv-review-changes'

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    change_scope: {
      type: 'object',
      required: true,
      properties: { files: { type: 'array', required: true, items: { type: 'string' } }, commit_range: { type: 'string', required: false } },
    },
    selfcheck_path: { type: 'string', required: true },
    context: { type: 'string', required: false },
    focus_areas: { type: 'array', required: false, items: { type: 'string' } },
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

// >>> sv-prelude:diff-review-helpers
// ============================================================================
// Code diff review helpers — copied into sv-review-changes / sv-comprehensive-review
// ============================================================================

const SCOPE_JUDGMENT_TABLE = `
| 変更の種別 | 適用する観点 |
|---|---|
| プロダクションコードを含む | 全観点 |
| テストのみ | dry, semantic, spec, policy, progress |
| コメント / ドキュメントのみ | docs, policy |
| 依存 bump / 設定のみ | n_plus_1, consumers, docs, policy |

目安。混在時は、観点が対象に意味を持つかで判断する。
`.trim()

function diffScopeInstruction(changeScope) {
  const shq = v => `'${String(v).replace(/'/g, "'\\''")}'`
  const files = changeScope.files.map(shq).join(' ')
  const range = changeScope.commit_range
  const uncommitted = !range || range === 'uncommitted'
  const gitSteps = uncommitted
    ? `   - \`git diff --stat HEAD -- ${files}\` と \`git diff HEAD -- ${files}\` で規模と差分を確認する
   - \`git status --porcelain -- ${files}\` で未追跡 (\`??\`) のファイルを特定する。未追跡の新規ファイルは diff に出ないので Read で全文確認する`
    : `   - \`git diff --stat ${shq(range)} -- ${files}\` と \`git diff ${shq(range)} -- ${files}\` で規模と差分を確認する`
  return `
- 実行場所: ${svArgs.project_root || '作業ディレクトリ'}。git コマンドには -C オプションを付けない (許可設定のルールに一致させるため)。最初に \`git rev-parse --is-inside-work-tree\` を実行する
- git 管理外 (上記が失敗) の場合は git コマンドを使わず、次の手順に切り替える:
   - 対象ファイルを Read で全文確認する。変更前の版は得られないので、ファイル全体をレビュー対象とし、変更の中身は渡された資料 (背景情報・セルフチェック証跡等) から把握する
   - 規模と種別は各ファイルの種別 (プロダクションコード / テスト / コメント・ドキュメント / 設定) から判断する
   - commit_range は無視する。git 管理外として扱ったことを md のスコープ判定節に書く
- git 管理下の場合:
${gitSteps}
   - 規模と種別 (プロダクションコード / テスト / コメント・ドキュメント / 設定) を確認する
`.trim()
}
// ============================================================================
// <<< sv-prelude:diff-review-helpers

// >>> sv-prelude:diff-review-prompt
function reviewerPromptCore({ project_memory_path, target_description, artifact_path, output_path, change_scope, selfcheck_path }) {
  return `
${roleSection('reviewer')}

${policyReferenceBlock(project_memory_path)}

# レビュー対象
${target_description}
成果物パス: ${artifact_path}

# 早期打ち切り (最初に判定)
対象がレビューできる状態に無いとき (変更が空・断片的で意図が読み取れない、変更が「変更の背景」や設計書と明らかに一致しない など、reviewer.md の「意味・価値」の判定を満たさない) は upstream_precondition_failed=true とし、観点ごとのチェックは行わず pass=false で、理由を upstream_precondition_reason と総合評価に書く。md は総合評価・判定 JSON・早期打ち切り判断の 3 節だけでよい。

# スコープ判定 (必須・最初に実施)
本レビューはコード diff 対象。レビュー本体に入る前に以下を必ず実施すること:
1. 変更の取得と、規模・種別の確認:
${diffScopeInstruction(change_scope)}
2. 次の判定表に基づき、チェック観点の各キーについて適用か対象外かを先に決める:
${SCOPE_JUDGMENT_TABLE}
3. 対象外とした観点は判定結果 md にも "na + 一言理由" で記録すること (無言スキップ禁止)

# チェック観点 (スコープ判定で適用となった観点は省略しない。対象外も理由付きで記載)
${reviewChecksBlock(Object.keys(REVIEW_CHECKS))}

progress の確認材料: セルフチェック証跡 (${selfcheck_path}) と、下記「変更の背景」に示された前工程の証跡。
渡された入力から必要な前工程 (設計・計画レビュー等) の実施と証跡が確認できない場合は must_fix とし、確認できなかった内容を detail に書くこと。

# 出力
以下パスに md 保存し、判定 JSON を含めてください:
${output_path}

**md 構成の絶対順序 (この順で書く。順序変更・判定 JSON 文末配置は禁止):**
1. \`# タイトル\`
2. \`## 総合評価\` (pass / NG + 1〜3 行サマリ) — タイトル直下
3. \`## 判定 JSON\` (下記 schema の JSON をコードブロックで貼る) — **総合評価の直下に必ず配置。文末不可**
4. \`## 早期打ち切り判断\` (upstream_precondition_failed=true のときのみ。判定 JSON の直後)
5. \`## スコープ判定\` (対象種別と各観点の適用/対象外)
6. \`## チェック観点\` (観点キーごとに ok / issue / na + 詳細)
7. \`## 追加所見\` (提案 = suggestion)
8. \`## 修正指示\` (blocker / must_fix。該当あれば)

判定 JSON の構造:
{
  "pass": true|false,
  "upstream_precondition_failed": true|false,
  "upstream_precondition_reason": "..." | null,
  "scope": {"target_kind": "code|spec_only|comment_only|docs_only|config_only|mixed", "applied_checks": [<観点キー>], "na_checks": [<観点キー>]},
  "checks": {<観点キー>: {"status": "ok|issue|na", "detail": "..."}},
  "revision_required": [{"severity": "blocker|must_fix", "location": "...", "instruction": "..."}],
  "additional_findings": [{"location": "...", "detail": "..."}]
}

${SEVERITY_RULE}
${FINDINGS_PLACEMENT_RULE}
`.trim()
}
// <<< sv-prelude:diff-review-prompt

// >>> sv-prelude:selfcheck-gate
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
// <<< sv-prelude:selfcheck-gate

// ============================================================================
// Main
// ============================================================================

const { change_scope, selfcheck_path, context, focus_areas } = svArgs.wf_specific
const changedFiles = change_scope.files
const dir = runDir(_WF_NAME)

phase('セルフチェック確認')

const gateResult = await runSelfcheckGate(
  selfcheck_path,
  `手元の変更 (${change_scope.commit_range || 'uncommitted'}) / ファイル: ${changedFiles.join(', ')}`,
)
if (gateResult) return gateResult

phase('レビュー')

const reviewOutputPath = `${dir}/agents/code-review.md`

const REVIEW_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    md_written: { type: 'boolean' },
    upstream_precondition_failed: { type: 'boolean' },
  },
  required: ['pass', 'md_written', 'upstream_precondition_failed'],
}

const reviewPrompt = `
あなたはコードレビュー担当エージェントです。

${reviewerPromptCore({
  project_memory_path: svArgs.project_memory_path,
  target_description: `手元の変更 (${change_scope.commit_range || 'uncommitted'})`,
  artifact_path: changedFiles.join(', '),
  output_path: reviewOutputPath,
  change_scope,
  selfcheck_path,
})}

# 変更の背景 (レビュー時に考慮)
${context || '特に背景情報なし'}

# 特に重点的に見てほしい観点
${focus_areas && focus_areas.length ? focus_areas.map(a => `- ${a}`).join('\n') : '特になし'}

# 変更範囲
- ファイル: ${changedFiles.join(', ')}
- git 範囲: ${change_scope.commit_range || 'uncommitted (作業ツリー)'}

スコープ判定の手順で変更を確認してから、チェック観点と focus_areas の観点でレビューしてください。

# 大規模変更の判定
変更ファイル数が 100 超、または行数が 3000 超の場合、
成果物 md の判定 JSON に "change_size_too_large": true と file_count / line_count を含めてください。
(SV に sv-comprehensive-review を提案するため)

# 最終応答
md を保存した後、Read で存在を確認してから StructuredOutput で md_written=true を返してください。
pass と upstream_precondition_failed は md の判定 JSON と一致させてください。
`.trim()

const review = await svAgent(reviewPrompt, 'reviewer', 'code-review', { schema: REVIEW_RESULT_SCHEMA })

if (review == null) {
  return {
    status: 'escalation',
    summary: 'レビュー実行失敗 (エージェントが null を返した)',
    escalation: {
      reason: 'レビュー担当エージェントが null を返した (実行失敗)',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性が高い',
    },
    runDir: dir,
  }
}

if (review.md_written !== true) {
  return {
    status: 'escalation',
    summary: 'レビュー成果物 md が保存されていない',
    escalation: {
      reason: 'レビュー担当が成果物 md を保存できなかった',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性が高い',
    },
    runDir: dir,
  }
}

// レビュー agent が書いた md をそのまま outputPath として返す。SV はこの md を Read して判定 JSON を読み取る。

return {
  status: 'success',
  summary: review.upstream_precondition_failed === true
    ? '変更レビュー完了 (pass=false, 前提不成立: レビュー md を参照)'
    : `変更レビュー完了 (pass=${review.pass})`,
  outputPath: reviewOutputPath,
}
