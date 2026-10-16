# wf: sv-prototype-ui

## 1. 目的・想定利用シーン

UI を伴う案件で、実装前にデザインをユーザに確認するための HTML プロトタイプを作成する。

- 新規画面追加・UI 変更を伴う案件
- ワイヤーフレームレベルではなく、実際に触れる HTML でユーザ確認したい時
- sv-mode.md の wf カタログの `sv-prototype-ui` にあたる

## 2. 引数スキーマ (`wf_specific`)

```json
{
  "ui_requirements": "UI 要件 (自然言語)",
  "usage_scenarios": [
    { "actor": "ユーザ種別", "goal": "達成したいこと", "steps": ["ステップ 1", "..."] }
  ],
  "existing_ui_references": ["参考にすべき既存画面のパス or URL"],
  "constraints": {
    "responsive": true,
    "dark_mode": true,
    "framework": "vanilla | react | vue (デフォルト: vanilla)"
  },
  "output_base_dir": "プロトタイプ HTML の保存先ディレクトリ (デフォルト: run ディレクトリ配下の prototype)"
}
```

- 外部 CDN / フォント / 画像は禁止 (必要なら data: URI で inline)。ただし `framework` が vanilla 以外のときは、そのフレームワーク本体に限り、バージョンを固定した CDN の読み込みを許可する

## 3. 返り値スキーマ

```javascript
{
  status: 'success' | 'escalation' | 'checkpoint_stop',
  summary: 'UI プロトタイプ完成 (N ラウンド)',
  prototypeDir: '<output_base_dir、未指定なら run ディレクトリ配下>',
  reviewMdPaths: ['<run-dir>/loop/round-N-review.md', ...],
  escalation: {...},
  checkpoint: {...},
}
```

SV は `prototypeDir` の HTML を実機で確認し、必要に応じて `reviewMdPaths` を Read する。集約 md は作らない。

デザイン担当は `prototypeDir` に HTML / CSS を作成するだけで、まとめの md は作らない。レビューの記録はラウンドごとのレビュー md (`reviewMdPaths`) に残る。

**escalation の返り値:** 担当エージェントを起動した後の escalation は、`runDir` と、その時点で存在する成果物の path (`prototypeDir`、それまでのレビュー md を示す `reviewMdPaths`) を返す。args 検証の escalation は成果物が無いので返さない (_common.md §1)。

## 4. 内部エージェント構成

```
[デザインフェーズ]
  └─ agent: デザイン担当 x 1
     agentType: general-purpose
     ロール: designer.md (制作物が設計書以外の場合の適用範囲) + プロンプト内で「HTML/CSS プロトタイプ制作」を指示
     入力: ui_requirements, usage_scenarios, existing_ui_references, constraints
     成果物: <output_base_dir>/*.html + CSS
     Read/Write ツールを使ってファイル作成
     修正ラウンドは現行プロトタイプを Read して、指摘箇所だけを直す

[デザインレビューフェーズ]
  └─ agent: デザインレビュー担当 x 1
     agentType: general-purpose
     ロール: reviewer.md + プロンプト内で「UX / 整合性 / アクセシビリティ観点」を強調
     入力: プロトタイプの全 HTML/CSS, ui_requirements, usage_scenarios
     出力: loop/round-<N>-review.md
     チェック観点 (UI 固有):
       - シナリオ網羅性
       - アクセシビリティ (色コントラスト・キーボード操作)
       - レスポンシブ動作の妥当性 (CSS を読んで判定)
       - ダークモード対応 (constraints.dark_mode = true の場合。prefers-color-scheme に対応し、手動の切り替えを持たせる場合はそれと矛盾させない)
       - 既存 UI との整合性 (existing_ui_references と照合)
     補助の観点 (_common.md §5): dry / semantic / policy
     round 1 はフル監査。round 2 以降は focused 再レビュー (下記)

[修正ループ] 最大 3 回
```

- **focused 再レビュー**: round 2 以降は前回指摘の解消確認に絞る。プロトタイプはラウンド別スナップショットを持たないため diff ではなく指摘項目の解消検証を根拠にし、修正が局所的かつ指摘全件解消なら focused pass、広範・構造的ならフル UI 監査に fall back (_common.md §7)。判定 JSON に `review_mode` を含める

## 5. エスカレ条件 (wf 固有)

共通の「修正ループ上限到達」以外に、実装は次の場合に打ち切って escalation を返す。

- **デザイン担当の前提不足 (全ラウンド)**
  - UI 要件が曖昧、スコープが広すぎる、参考実装が不足、シナリオ間の矛盾、のいずれか
- **レビュー担当の upstream_precondition_failed / structural_rethink_required (全ラウンド)**
  - 「既存 UI との整合が根本的に取れない」は structural_rethink_required に含まれる
- **revision_count_high (round 2 以降、指摘件数が前回以上)**
- **designer_stuck (round 2 以降)** — 前回指摘の過半数が未解消
- **担当の実行失敗** — デザイン担当・レビュー担当が結果を返さない
- **上限到達** — 修正ループの上限までにレビューを通過しない

## 6. `meta` ブロック案

```javascript
export const meta = {
  name: 'sv-prototype-ui',
  description: 'HTML プロトタイプを制作してデザインレビューを通した承認済み UI を返す',
  whenToUse: 'UI を伴う案件で実装前にデザイン確認したい時',
  phases: [
    { title: 'デザイン' },
    { title: 'レビュー' },
    { title: '修正ループ' },
  ],
  argsSchema: { ... },   // wf_specific の検証スキーマ (_common.md §19)
}
```

## 7. スクリプト骨格 (処理の順序)

プロンプトの正本は実装 (`sv-prototype-ui.js`)。ここでは分岐の順序のみを述べる。

1. args 検証 (共通の Prelude)
2. round 1 のデザイン担当を起動する。結果が得られなければ escalation
3. デザイン担当の前提不足フラグを判定し、該当すれば escalation
4. レビュー担当を起動する。結果が得られなければ escalation
5. レビュー担当の打ち切りフラグを次の順で判定し、該当すれば escalation
   1. `upstream_precondition_failed`
   2. `structural_rethink_required`
   3. `revision_count_high` (round 2 以降、指摘件数が前回以上)
   4. `designer_stuck` (round 2 以降)
6. `pass` なら成功としてループを抜ける
7. 上限ラウンドに達していれば上限到達の escalation
8. デザイン担当を修正ラウンドとして起動する。結果が得られなければ escalation。得られたら 3 と同じ前提不足フラグ判定を行い、4 に戻る
9. 成功時は、`ui_prototyped` チェックポイントの宣言があれば `checkpoint_stop`、なければ `success` を返す
