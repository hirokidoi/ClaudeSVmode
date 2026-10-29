export const meta = {
  name: 'sv-comprehensive-review',
  description: '変更セット全体を複数観点でレビューして総合判定を返す',
  whenToUse: '実装完了後の総合レビュー (SV から自動起動想定)',
  phases: [
    { title: 'セルフチェック確認' },
    { title: 'レビュー' },
  ],
  argsSchema: {
    wf_specific: {
      change_scope: {
        type: 'object',
        required: true,
        description: '変更範囲 (files + commit_range)',
        properties: { files: { type: 'array', required: true, items: { type: 'string' } }, commit_range: { type: 'string', required: false } },
      },
      selfcheck_path: { type: 'string', required: true, description: 'SV がレビュー前に実施したセルフチェックの証跡 md のパス' },
      spec_paths: { type: 'array', required: false, items: { type: 'string' }, description: '仕様書・要件書・設計書のパス配列' },
      documentation_paths: { type: 'array', required: false, items: { type: 'string' }, description: '更新対象ドキュメントのパス配列' },
      test_paths: { type: 'array', required: false, items: { type: 'string' }, description: '関連テストファイルのパス配列' },
      review_lenses: { type: 'array', required: false, items: { type: 'enum', values: ['correctness', 'docs', 'policy', 'security', 'consistency', 'spec-coverage', 'spec-existence'] }, description: 'デフォルト [correctness, docs, policy]。consistency / spec-coverage / spec-existence / security も独立した観点として指定可' },
      optimize_for: { type: 'enum', values: ['wall_clock', 'tokens'], required: false, description: "デフォルト 'wall_clock'。'wall_clock' は lens ごとに並列 agent + Read 対象絞り込み。'tokens' は単一 agent が全観点を 1 パスで実施 (token 消費が少ないが wall clock は長くなる)" },
    },
  },
}

// 本体からは meta を参照できないため meta.name と同じ値を持つ
const _WF_NAME = 'sv-comprehensive-review'

// 本体からは meta を参照できないため同じスキーマを持つ。meta.argsSchema と必ず同期させる
const _WF_ARGS_SCHEMA = {
  wf_specific: {
    change_scope: {
      type: 'object',
      required: true,
      properties: { files: { type: 'array', required: true, items: { type: 'string' } }, commit_range: { type: 'string', required: false } },
    },
    selfcheck_path: { type: 'string', required: true },
    spec_paths: { type: 'array', required: false, items: { type: 'string' } },
    documentation_paths: { type: 'array', required: false, items: { type: 'string' } },
    test_paths: { type: 'array', required: false, items: { type: 'string' } },
    review_lenses: { type: 'array', required: false, items: { type: 'enum', values: ['correctness', 'docs', 'policy', 'security', 'consistency', 'spec-coverage', 'spec-existence'] } },
    optimize_for: { type: 'enum', values: ['wall_clock', 'tokens'], required: false },
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

const {
  change_scope,
  selfcheck_path,
  spec_paths,
  documentation_paths,
  test_paths,
  review_lenses,
  optimize_for,
} = svArgs.wf_specific
const dir = runDir(_WF_NAME)

const lenses = review_lenses && review_lenses.length ? review_lenses : ['correctness', 'docs', 'policy']
const _dupLenses = lenses.filter((l, i) => lenses.indexOf(l) !== i)
if (_dupLenses.length > 0) {
  return argsValidationEscalation([`args.wf_specific.review_lenses が重複: ${[...new Set(_dupLenses)].join(', ')}`])
}
const optimizeFor = optimize_for || 'wall_clock'

const lensSpecialization = {
  correctness: [
    '変更ファイル間の呼び出し関係を Read で追い、型整合性・データフロー整合性を確認',
    'spec_paths の要件を 1 項目ずつリストアップし、変更で実現されているか照合',
    '変更後の public API (アクション・メソッド) について対応する自動テストが存在するかを列挙',
  ].join('\n  - '),
  docs: 'documentation_paths を Read し、変更内容と乖離している記述・削除済み識別子の残存を検出。導入先の CLAUDE.md・プロジェクト規約に記載ルールがあれば、それに沿っているかも確認',
  policy: svArgs.project_memory_path
    ? `導入先の CLAUDE.md・プロジェクト規約と ${svArgs.project_memory_path} 内の規約・memory 類に照らして、変更ファイル全体が準拠しているかを一件ずつ確認`
    : '導入先の CLAUDE.md・プロジェクト規約に照らして、変更ファイル全体が準拠しているかを一件ずつ確認',
  security: '認証・認可・入力検証・インジェクション等、対象に該当する攻撃面の観点でチェック',
  consistency: '変更ファイル間の呼び出し関係を Read で追い、型整合性・データフロー整合性を確認',
  'spec-coverage': 'spec_paths の要件を 1 項目ずつリストアップし、変更で実現されているか照合',
  'spec-existence': '変更後の public API について対応する自動テストの有無を列挙',
}

const LENS_CHECKS = {
  correctness: ['n_plus_1', 'dry', 'semantic', 'callee_behavior', 'hot_path', 'spec', 'consumers'],
  docs: ['docs'],
  policy: ['policy', 'progress'],
}

const scopeJudgmentBlock = `
# スコープ判定 (必須・最初に実施)
本レビューはコード diff 対象。レビュー本体に入る前に以下を必ず実施すること:
1. 変更の取得と、規模・種別の確認:
${diffScopeInstruction(change_scope)}
2. 次の判定表に基づき、本観点と担当するチェック観点について適用か対象外かを先に決める:
${SCOPE_JUDGMENT_TABLE}
3. 対象外とした観点は判定結果 md にも "na + 一言理由" で記録すること (無言スキップ禁止)
`.trim()

const progressNote = `
progress の確認材料: セルフチェック証跡 (${selfcheck_path}) と spec_paths に示された前工程の証跡。
渡された入力から必要な前工程 (設計・計画レビュー等) の実施と証跡が確認できない場合は must_fix とし、確認できなかった内容を detail に書くこと。
`.trim()

const severityBlock = `${SEVERITY_RULE}
- findings の各要素に severity (blocker / must_fix / suggestion) を持たせる`

// lens ごとに Read 対象ファイルを絞ることで per-agent の Read overhead を減らす
const allFiles = change_scope.files
const isDocFile = f => /\.(md|txt|rst)$/i.test(f)
const isCodeFile = f => !isDocFile(f)

const lensFocusFiles = {
  correctness: allFiles.filter(isCodeFile).concat(spec_paths || [], test_paths || []),
  docs: allFiles.filter(isDocFile).concat(documentation_paths || []),
  policy: allFiles,
  security: allFiles.filter(isCodeFile),
  consistency: allFiles.filter(isCodeFile),
  'spec-coverage': allFiles.filter(isCodeFile).concat(spec_paths || []),
  'spec-existence': allFiles.filter(isCodeFile).concat(test_paths || []),
}

const focusFilesFor = lens => {
  const files = [...new Set(lensFocusFiles[lens] || [])]
  return files.length ? files : allFiles
}

phase('セルフチェック確認')

const gateResult = await runSelfcheckGate(
  selfcheck_path,
  `変更セット (${change_scope.commit_range || 'uncommitted'}) / ファイル: ${allFiles.join(', ')}`,
)
if (gateResult) return gateResult

phase('レビュー')

const TOKENS_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    overall_pass: { type: 'boolean' },
    md_written: { type: 'boolean' },
    upstream_precondition_failed: { type: 'boolean' },
  },
  required: ['overall_pass', 'md_written', 'upstream_precondition_failed'],
}

const LENS_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    md_written: { type: 'boolean' },
    upstream_precondition_failed: { type: 'boolean' },
  },
  required: ['pass', 'md_written', 'upstream_precondition_failed'],
}

if (optimizeFor === 'tokens') {
  // 単一 agent が全観点を 1 パスで処理。Read が 1 回で済むが reasoning が観点数に比例して長くなる。
  const reviewOutputPath = `${dir}/agents/review.md`
  const lensesBlock = lenses.map(l => `- **${l}**: ${lensSpecialization[l] || '一般的なレビュー'}`).join('\n')
  const prompt = `
あなたは総合レビュー担当エージェントです。1 パスで複数観点をまとめて判定してください。

${roleSection('reviewer')}

${policyReferenceBlock(svArgs.project_memory_path)}

# レビュー対象
変更範囲:
- ファイル: ${allFiles.join(', ')}
- git 範囲: ${change_scope.commit_range || 'uncommitted'}

参考資料:
- 仕様書: ${(spec_paths || []).join(', ') || 'なし'}
- ドキュメント: ${(documentation_paths || []).join(', ') || 'なし'}
- テスト: ${(test_paths || []).join(', ') || 'なし'}
- セルフチェック証跡: ${selfcheck_path}

# 早期打ち切り (最初に判定)
対象がレビューできる状態に無いとき (変更が空・断片的で意図が読み取れない、変更が参考資料や設計書と明らかに一致しない など、reviewer.md の「意味・価値」の判定を満たさない) は upstream_precondition_failed=true とし、観点ごとのチェックは行わず overall_pass=false で、理由を upstream_precondition_reason と総合評価に書く。md は総合評価・判定 JSON・早期打ち切り判断の 3 節だけでよい。

# 観点 (全て 1 パスで実施)
${lensesBlock}

${scopeJudgmentBlock}

# チェック観点 (スコープ判定で適用となった観点は省略しない。対象外も理由付きで記載)
${reviewChecksBlock(Object.keys(REVIEW_CHECKS))}

${progressNote}

# 効率的な進め方
- 対象ファイルの Read は 1 回だけ。複数の観点を頭の中で並行に適用する
- Read は可能な限り 1 メッセージ内で並列 (multi-tool-use) で発行し、往復回数を減らす

# 出力
以下パスに md 保存:
${reviewOutputPath}

**md 構成の絶対順序 (この順で書く。順序変更・判定 JSON 文末配置は禁止):**
1. \`# タイトル\`
2. \`## 総合評価\` (overall_pass yes/no + 1〜3 行サマリ) — タイトル直下
3. \`## 判定 JSON\` (下記 schema の JSON をコードブロックで貼る) — **総合評価の直下に必ず配置。文末不可**
4. \`## 早期打ち切り判断\` (upstream_precondition_failed=true のときのみ。判定 JSON の直後)
5. \`## 観点別サマリ\` (${lenses.join(' / ')} ごとに pass/NG と 1 行要約)
6. \`## スコープ判定\` (対象種別と各チェック観点の適用/対象外)
7. \`## 観点別詳細\` (${lenses.join(' / ')} の各セクション、発見事項 重大度別)
8. \`## チェック観点の結果\` (観点キーごとに ok / issue / na + 詳細)
9. \`## 必要な追加対応\` (優先度別)

判定 JSON:
{
  "overall_pass": true|false,
  "upstream_precondition_failed": true|false,
  "upstream_precondition_reason": "..." | null,
  "lens_pass": { ${lenses.map(l => `"${l}": bool`).join(', ')} },
  "checks": {<観点キー>: {"status": "ok|issue|na", "detail": "..."}},
  "findings": [{"lens": "...", "severity": "blocker|must_fix|suggestion", "location": "...", "detail": "..."}]
}

${severityBlock}
- overall_pass は findings に blocker か must_fix が 1 件でもあれば false。lens_pass も lens ごとに同じ規則で出す

# 制約
- 対象ファイルを Read で確認してから判定 (推測禁止)
- 最終応答は「総合レビュー完了 (overall_pass=<bool>)」の 1 文で良い

# 最終応答
md を保存した後、Read で存在を確認してから StructuredOutput で md_written=true を返してください。
overall_pass と upstream_precondition_failed は md の判定 JSON と一致させてください。
`.trim()

  const review = await svAgent(prompt, 'reviewer', 'review', { schema: TOKENS_RESULT_SCHEMA })
  if (review == null) {
    return {
      status: 'escalation',
      summary: 'レビュー実行失敗',
      escalation: {
        reason: 'レビュー担当エージェントが null を返した',
        options: [
          { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
          { title: 'optimize_for=wall_clock で再実行', description: '並列 agent で観点別レビュー', tradeoffs: 'トークン増', effort: '小' },
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
      summary: '総合レビュー成果物 md が保存されていない',
      escalation: {
        reason: 'レビュー担当が成果物 md を保存できなかった',
        options: [
          { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
        ],
        recommendation: 0,
        reasoning: '一時的な失敗の可能性',
      },
      runDir: dir,
    }
  }

  return {
    status: 'success',
    summary: `総合レビュー完了 (${lenses.length} 観点, optimize_for=tokens, overall_pass=${review.overall_pass}${review.upstream_precondition_failed === true ? ', 前提不成立' : ''})`,
    outputPath: reviewOutputPath,
  }
}

// optimizeFor === 'wall_clock' — lens ごとに並列 agent + Read 対象絞り込み
const reviews = await parallel(lenses.map(lens => () => {
  const reviewOutputPath = `${dir}/agents/review-${lens}.md`
  const focusFiles = focusFilesFor(lens)
  const assignedChecks = LENS_CHECKS[lens] || []
  const checksBlock = assignedChecks.length
    ? `# 担当するチェック観点 (省略しない。対象外は理由付き)
${reviewChecksBlock(assignedChecks)}
${assignedChecks.includes('progress') ? `\n${progressNote}` : ''}`
    : ''
  const prompt = `
あなたはレビュー担当エージェント (観点: ${lens}) です。

${roleSection('reviewer')}

${policyReferenceBlock(svArgs.project_memory_path)}

# レビュー対象
変更範囲全体:
- ファイル: ${allFiles.join(', ')}
- git 範囲: ${change_scope.commit_range || 'uncommitted'}

参考資料:
- 仕様書: ${(spec_paths || []).join(', ') || 'なし'}
- ドキュメント: ${(documentation_paths || []).join(', ') || 'なし'}
- テスト: ${(test_paths || []).join(', ') || 'なし'}
- セルフチェック証跡: ${selfcheck_path}

# 早期打ち切り (最初に判定)
対象がレビューできる状態に無いとき (変更が空・断片的で意図が読み取れない、変更が参考資料や設計書と明らかに一致しない など、reviewer.md の「意味・価値」の判定を満たさない) は upstream_precondition_failed=true とし、観点ごとのチェックは行わず pass=false で、理由を upstream_precondition_reason と総合評価に書く。md は総合評価・判定 JSON・早期打ち切り判断の 3 節だけでよい。

# 観点特化指示
観点「${lens}」:
${lensSpecialization[lens] || '一般的なレビュー'}

# 重点 Read 対象 (この観点に必要なファイル)
${focusFiles.map(f => `- ${f}`).join('\n')}

- 上記の重点 Read 対象を優先して読む。それ以外のファイルは cross-reference で必要になったときのみ Read する
- Read は可能な限り 1 メッセージ内で並列 (multi-tool-use) で発行し、往復回数を減らす

${scopeJudgmentBlock}

${checksBlock}

# 出力
以下パスに md 保存:
${reviewOutputPath}

**md 構成の絶対順序 (この順で書く。順序変更・判定 JSON 文末配置は禁止):**
1. \`# タイトル (観点: ${lens})\`
2. \`## 総合評価\` (pass / NG + 1〜3 行サマリ) — タイトル直下
3. \`## 判定 JSON\` (下記 schema の JSON をコードブロックで貼る) — **総合評価の直下に必ず配置。文末不可**
4. \`## 早期打ち切り判断\` (upstream_precondition_failed=true のときのみ。判定 JSON の直後)
5. \`## スコープ判定\` (対象種別と本観点・チェック観点の適用/対象外)
6. \`## 発見事項\` (重大度別)
${assignedChecks.length ? '7. `## チェック観点の結果` (観点キーごとに ok / issue / na + 詳細)\n' : ''}
判定 JSON:
{
  "lens": "${lens}",
  "pass": true|false,
  "upstream_precondition_failed": true|false,
  "upstream_precondition_reason": "..." | null,
  "checks": ${assignedChecks.length ? '{<担当観点のキー>: {"status": "ok|issue|na", "detail": "..."}}' : '{}'},
  "findings": [{"severity": "blocker|must_fix|suggestion", "location": "...", "detail": "..."}]
}

${severityBlock}
- pass は findings に blocker か must_fix が 1 件でもあれば false

# 制約
- 対象ファイルを Read で確認してから判定
- 最終応答は「レビュー完了 (lens=${lens})」の 1 文で良い

# 最終応答
md を保存した後、Read で存在を確認してから StructuredOutput で md_written=true を返してください。
pass と upstream_precondition_failed は md の判定 JSON と一致させてください。
`.trim()

  return svAgent(prompt, 'reviewer', `review:${lens}`, { schema: LENS_RESULT_SCHEMA })
}))

const lensMdPaths = lenses.map((l, i) => ({ lens: l, mdPath: `${dir}/agents/review-${l}.md`, succeeded: reviews[i] != null && reviews[i].md_written === true }))
const failedLenses = lensMdPaths.filter(p => !p.succeeded).map(p => p.lens)
const failedAssignedLenses = failedLenses.filter(l => LENS_CHECKS[l])
const ngLenses = lenses.filter((l, i) => lensMdPaths[i].succeeded && reviews[i].pass === false)
const preconditionFailedLenses = lenses.filter((l, i) => lensMdPaths[i].succeeded && reviews[i].upstream_precondition_failed === true)
const preconditionNote = preconditionFailedLenses.length ? `, 前提不成立: ${preconditionFailedLenses.join(', ')}` : ''

if (failedAssignedLenses.length > 0) {
  return {
    status: 'escalation',
    summary: `チェック観点を担当する観点でレビュー失敗 (${failedAssignedLenses.join(', ')})`,
    lensMdPaths,
    escalation: {
      reason: `チェック観点を担当する lens が失敗し、観点が未確認: ${failedAssignedLenses.map(l => `${l} (未確認の観点: ${LENS_CHECKS[l].join(', ')})`).join(' / ')}`,
      options: [
        { title: '失敗した lens を指定して再実行', description: `review_lenses に ${failedAssignedLenses.join(', ')} を指定して再走`, tradeoffs: 'トークン消費増', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性。観点が欠けたまま合格にしない',
    },
    runDir: dir,
  }
}

if (failedLenses.length > lenses.length / 2) {
  return {
    status: 'escalation',
    summary: `${failedLenses.length}/${lenses.length} 観点でレビュー失敗 (${failedLenses.join(', ')})`,
    lensMdPaths,
    escalation: {
      reason: 'レビュー担当の過半数が失敗した (null を返した、または md を保存できなかった)',
      options: [
        { title: '再実行', description: 'wf を再起動', tradeoffs: 'トークン消費増', effort: '中' },
        { title: '観点を絞って再実行', description: '失敗した観点だけ再走', tradeoffs: '網羅性やや低下', effort: '小' },
      ],
      recommendation: 0,
      reasoning: '一時的な失敗の可能性',
    },
    runDir: dir,
  }
}

return {
  status: 'success',
  summary: failedLenses.length
    ? `総合レビュー完了 (${lenses.length} 観点中 ${failedLenses.length} 観点失敗: ${failedLenses.join(', ')}, 不合格: ${ngLenses.join(', ') || 'なし'}${preconditionNote})`
    : `総合レビュー完了 (${lenses.length} 観点, 不合格: ${ngLenses.join(', ') || 'なし'}${preconditionNote})`,
  lensMdPaths,
}
