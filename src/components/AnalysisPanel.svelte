<script lang="ts">
  import { wb } from '../lib/wb.svelte.ts';
  import { fmt } from '../lib/engine/analyze';
  import { differs, type DiffStatus } from '../lib/snapshot';
  import { TYPE_LABEL, UNIT } from '../lib/factory';
  import type { Issue } from '../lib/engine/types';

  let tab = $state<'issues' | 'mna' | 'kcl' | 'power' | 'diff'>('issues');

  $effect(() => {
    if (wb.result.issues.some((i) => i.kind === 'error')) tab = 'issues';
  });

  const result = $derived(wb.result);
  const compName = (id: string) => wb.circuit.comps.find((c) => c.id === id)?.name;
  const nodeName = (id: string) => wb.circuit.nodes.find((n) => n.id === id)?.name;

  function hoverIssue(issue: Issue | null) {
    if (!issue) {
      wb.highlight = { compIds: [], nodeIds: [] };
      return;
    }
    const compIds = issue.refs.filter((id) => wb.circuit.comps.some((c) => c.id === id));
    const nodeIds = issue.refs.filter((id) => wb.circuit.nodes.some((n) => n.id === id));
    wb.highlight = { compIds, nodeIds };
  }

  function clickIssue(issue: Issue) {
    const comp = issue.refs.find((id) => wb.circuit.comps.some((c) => c.id === id));
    const node = issue.refs.find((id) => wb.circuit.nodes.some((n) => n.id === id));
    if (comp) wb.selection = { kind: 'comp', id: comp };
    else if (node) wb.selection = { kind: 'node', id: node };
  }

  // 矩阵单元格悬停溯源
  let activeCell = $state<{ r: number; c: number } | null>(null);
  $effect(() => {
    if (!activeCell || !result.trace) {
      if (!activeCell) wb.highlight = { compIds: [], nodeIds: [] };
      return;
    }
    const t = result.trace[activeCell.r]?.[activeCell.c];
    if (t) wb.highlight = { compIds: t.map((x) => x.compId), nodeIds: [] };
  });

  const errCount = $derived(result.issues.filter((i) => i.kind === 'error').length);
  const warnCount = $derived(result.issues.filter((i) => i.kind === 'warning').length);

  // 对照快照
  const snap = $derived(wb.snapshot);
  const diff = $derived(wb.snapshotDiff);
  const diffCount = $derived(diff ? diff.counts.changed + diff.counts.added + diff.counts.removed : 0);
  const curErrors = $derived(result.issues.filter((i) => i.kind === 'error'));
  const fmtDelta = (d: number) => `${d > 0 ? '+' : ''}${fmt(d)}`;
  const fmtQty = (x: number | null) => (x === null ? '—' : fmt(x));

  function hoverRow(kind: 'comp' | 'node', id: string, gone: boolean) {
    // 已删除的对象不在当前电路中，无法高亮
    if (gone) return;
    wb.highlight = kind === 'comp' ? { compIds: [id], nodeIds: [] } : { compIds: [], nodeIds: [id] };
  }
</script>

{#snippet statusBadge(status: DiffStatus)}
  {#if status === 'added'}<span class="badge added">新增</span>
  {:else if status === 'removed'}<span class="badge removed">已删除</span>
  {:else if status === 'changed'}<span class="badge changed">有变化</span>
  {:else}<span class="muted">—</span>{/if}
{/snippet}

{#snippet qty(base: number | null, cur: number | null)}
  {#if base === null && cur === null}
    <span class="muted">—</span>
  {:else if base !== null && cur !== null && !differs(base, cur)}
    <span class="mono">{fmt(base)}</span>
  {:else}
    <span class="mono">{fmtQty(base)}</span>
    <span class="arrow">→</span>
    <span class="mono hl">{fmtQty(cur)}</span>
    {#if base !== null && cur !== null}
      <span class="mono delta">{fmtDelta(cur - base)}</span>
    {/if}
  {/if}
{/snippet}

<section class="panel">
  <nav class="tabs">
    <button class:active={tab === 'issues'} onclick={() => (tab = 'issues')}>
      诊断
      {#if errCount > 0}<span class="badge error">{errCount}</span>{/if}
      {#if warnCount > 0}<span class="badge warning">{warnCount}</span>{/if}
      {#if result.ok && errCount === 0 && warnCount === 0}<span class="badge ok">✓</span>{/if}
    </button>
    <button class:active={tab === 'mna'} onclick={() => (tab = 'mna')}>MNA 方程与溯源</button>
    <button class:active={tab === 'kcl'} onclick={() => (tab = 'kcl')}>节点 KCL</button>
    <button class:active={tab === 'power'} onclick={() => (tab = 'power')}>功率平衡</button>
    <button class:active={tab === 'diff'} onclick={() => (tab = 'diff')}>
      对照快照
      {#if snap && diffCount > 0}<span class="badge warning">{diffCount}</span>{/if}
      {#if snap && diffCount === 0}<span class="badge ok">✓</span>{/if}
    </button>
  </nav>

  <div class="content scroll">
    {#if tab === 'issues'}
      <div class="issues">
        {#if result.issues.length === 0}
          <div class="ok-line">✓ 方程可解，未发现结构性问题（残差 {fmt(result.power?.relative ?? 0, 2)} 量级）</div>
        {/if}
        {#each result.issues as issue (issue.code + issue.message)}
          <div
            class="issue {issue.kind}"
            role="button"
            tabindex="0"
            onmouseenter={() => hoverIssue(issue)}
            onmouseleave={() => hoverIssue(null)}
            onclick={() => clickIssue(issue)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') clickIssue(issue);
            }}
          >
            <span class="badge {issue.kind}">{issue.kind === 'error' ? '错误' : '警告'}</span>
            <div class="issue-body">
              <div class="msg">{issue.message}</div>
              {#if issue.detail}<div class="detail">{issue.detail}</div>{/if}
              {#if issue.refs.length > 0}
                <div class="refs">
                  关联：
                  {#each issue.refs as ref, k (ref + k)}
                    <span class="ref">{compName(ref) ?? nodeName(ref) ?? ref}</span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
        {#if !result.ok}
          <div class="edit-note">电路未被修改，所有参数仍可继续编辑；修正后会立即重新求解（不会出现 NaN）。</div>
        {/if}
      </div>
    {:else if tab === 'mna'}
      {#if result.A}
        <div class="mna-wrap">
          <div class="eq-note">
            矩阵形式 <b class="mono">A · x = z</b>。悬停任意系数格可在原理图上高亮贡献该格的元件；每行右侧标注其物理来源。
          </div>
          <table class="matrix" onmouseleave={() => (activeCell = null)}>
            <thead>
              <tr>
                <th></th>
                {#each result.vars as v, j (v.id)}
                  <th class="mono">{v.label}</th>
                {/each}
                <th></th>
                <th></th>
                <th class="left">方程来源</th>
              </tr>
            </thead>
            <tbody>
              {#each result.A as row, i (i)}
                <tr>
                  <td class="rowlabel mono">{result.rows[i]?.label}</td>
                  {#each row as a, j (j)}
                    {@const traces = result.trace?.[i]?.[j]}
                    <td
                      class="cell mono"
                      class:zero={Math.abs(a) < 1e-12}
                      class:traced={!!traces}
                      onmouseenter={() => (activeCell = { r: i, c: j })}
                      title={traces ? traces.map((t) => `${compName(t.compId) ?? t.compId}: ${fmt(t.weight)}`).join('\n') : ''}
                    >
                      {Math.abs(a) < 1e-12 ? '·' : fmt(a)}
                    </td>
                  {/each}
                  <td class="eq mono">=</td>
                  <td class="rhs mono" title={result.rhsTrace?.[i]?.map((t) => `${compName(t.compId) ?? t.compId}: ${fmt(t.weight)}`).join('\n')}>
                    {fmt(result.z![i])}
                  </td>
                  <td class="source">
                    {#if result.rows[i]?.kind === 'kcl'}
                      KCL：所有接出该超节点的支路电流代数和 = 0
                    {:else}
                      电压约束：<b>{compName(result.rows[i]!.refId!)}</b> 两端电位差 = {fmt(result.z![i])} V
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="legend">
            <span><i class="dot g"></i> 电导项 G=1/R（电阻）</span>
            <span><i class="dot v"></i> ±1（电压源电流变量/电压约束）</span>
            <span>z 列：电流源注入（KCL 行）或设定电压（约束行）</span>
          </div>
        </div>
      {:else}
        <div class="placeholder">方程未建立：请先解决“诊断”中的错误（电路与参数均保留可编辑）。</div>
      {/if}
    {:else if tab === 'kcl'}
      {#if result.ok}
        <table class="data">
          <thead>
            <tr><th>超节点（零阻收缩后）</th><th>电位 (V)</th><th>KCL 残差 ΣI流出 (A)</th><th>校验</th></tr>
          </thead>
          <tbody>
            {#each result.netKcls as k (k.netId)}
              <tr
                onmouseenter={() => wb.highlight = { compIds: [], nodeIds: k.nodeIds }}
                onmouseleave={() => (wb.highlight = { compIds: [], nodeIds: [] })}
              >
                <td>#{k.netId} {k.nodeIds.map(nodeName).join('=')}{k.netId === result.groundNet ? '（参考地）' : ''}</td>
                <td class="mono">{k.voltage === null ? '—' : fmt(k.voltage)}</td>
                <td class="mono">{k.indeterminate ? '含不唯一零阻电流' : fmt(k.residual)}</td>
                <td>{k.indeterminate ? '—' : Math.abs(k.residual) <= 1e-7 * Math.max(1, k.scale) ? '✓' : '✗'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <div class="placeholder">无解：先处理诊断中的约束矛盾。</div>
      {/if}
    {:else if tab === 'power'}
      {#if result.power}
        {@const p = result.power}
        <div class="power">
          <div class="power-sum">
            <div>
              <div class="muted">Σ 所有元件吸收功率（无源符号约定）</div>
              <div class="mono big" class:ok={p.relative < 1e-6} class:bad={p.relative >= 1e-6}>
                {fmt(p.residual)} W
              </div>
              <div class="muted small">相对残差 {p.relative.toExponential(2)}（理论值 0）</div>
            </div>
            <div class="cols">
              <div>
                <h4>发出功率（P吸收 &lt; 0）</h4>
                {#each p.delivered as d (d.compId)}
                  <div class="pow-row" role="presentation" onmouseenter={() => (wb.highlight = { compIds: [d.compId], nodeIds: [] })} onmouseleave={() => (wb.highlight = { compIds: [], nodeIds: [] })}>
                    <span>{d.name}</span><b class="mono neg">{fmt(d.watts)} W</b>
                  </div>
                {/each}
                <div class="pow-row total"><span>合计发出</span><b class="mono">{fmt(p.delivered.reduce((s, x) => s + x.watts, 0))} W</b></div>
              </div>
              <div>
                <h4>吸收功率（电阻等）</h4>
                {#each p.absorbed as d (d.compId)}
                  <div class="pow-row" role="presentation" onmouseenter={() => (wb.highlight = { compIds: [d.compId], nodeIds: [] })} onmouseleave={() => (wb.highlight = { compIds: [], nodeIds: [] })}>
                    <span>{d.name}</span><b class="mono pos">{fmt(d.watts)} W</b>
                  </div>
                {/each}
                <div class="pow-row total"><span>合计吸收</span><b class="mono">{fmt(p.absorbed.reduce((s, x) => s + x.watts, 0))} W</b></div>
              </div>
            </div>
          </div>
        </div>
      {:else}
        <div class="placeholder">无解：功率平衡在求解成功后给出。</div>
      {/if}
    {:else if tab === 'diff'}
      {#if !snap}
        <div class="diff-empty">
          <p>
            <b>对照快照</b>：把当前电路与求解结果保存为<b>只读基准</b>；继续修改后，在此按元件和接点对比
            <b>电位 / 电流 / 功率</b>的变化，新增或删除的对象会单独标识。
          </p>
          <p class="muted">
            基准随工程存入 IndexedDB，重开工程仍可对照；若基准或当前任一侧无法求解，其诊断会被保留，差值不会用
            NaN 冒充。
          </p>
          <button class="primary" onclick={() => wb.takeSnapshot()}>📸 保存当前为对照基准</button>
        </div>
      {:else if diff}
        <div class="diff">
          <div class="diff-head">
            <div class="diff-meta">
              <b>基准：{snap.circuitTitle}</b>
              <span class="muted">拍于 {new Date(snap.createdAt).toLocaleString('zh-CN')}</span>
              {#if !diff.baseOk}<span class="badge error">基准不可解</span>{/if}
              {#if !diff.curOk}<span class="badge error">当前不可解</span>{/if}
            </div>
            <div class="diff-actions">
              <span class="muted">
                {#if diffCount === 0}
                  与基准一致（电气量无变化）
                {:else}
                  {diff.counts.changed} 项变化 · {diff.counts.added} 新增 · {diff.counts.removed} 已删除
                {/if}
                · Σ吸收功率：{fmtQty(diff.basePower)} → {fmtQty(diff.curPower)} W
              </span>
              <button onclick={() => wb.takeSnapshot()} title="丢弃旧基准，以当前电路与求解结果重新拍照">
                ↻ 以当前重拍基准
              </button>
              <button
                class="danger"
                onclick={() => wb.clearSnapshot()}
                title="只删除基准快照：不改变当前电路，也不影响其他工程"
              >
                清除快照
              </button>
            </div>
          </div>

          {#if !diff.baseOk}
            <div class="diag-box">
              <div class="diag-title">
                基准保存时电路无法求解，其诊断已完整保留（基准量值显示为 —，不以 NaN 冒充）：
              </div>
              {#each snap.issues as issue, k (k)}
                <div class="issue {issue.kind}">
                  <span class="badge {issue.kind}">{issue.kind === 'error' ? '错误' : '警告'}</span>
                  <div class="issue-body">
                    <div class="msg">{issue.message}</div>
                    {#if issue.detail}<div class="detail">{issue.detail}</div>{/if}
                    {#if issue.refNames.length > 0}
                      <div class="refs">
                        关联：
                        {#each issue.refNames as r, j (j)}
                          <span class="ref">{r}</span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          {#if !diff.curOk}
            <div class="diag-box">
              <div class="diag-title">
                当前电路无法求解——当前侧量值显示为 —（完整诊断见“诊断”页签）：
              </div>
              {#each curErrors as issue, k (k)}
                <div class="diag-line">• {issue.message}</div>
              {/each}
            </div>
          {/if}

          <h4 class="diff-sub">元件对照（V = Va−Vb，I 沿 a→b，P 为吸收功率）</h4>
          <table class="data diff-table">
            <thead>
              <tr>
                <th>元件</th>
                <th>状态</th>
                <th>参数</th>
                <th>V (V)<br /><span class="th-sub">基准 → 当前（Δ）</span></th>
                <th>I (A)<br /><span class="th-sub">基准 → 当前（Δ）</span></th>
                <th>P (W)<br /><span class="th-sub">基准 → 当前（Δ）</span></th>
              </tr>
            </thead>
            <tbody>
              {#each diff.comps as row (row.compId)}
                <tr
                  class={row.status}
                  onmouseenter={() => hoverRow('comp', row.compId, row.status === 'removed')}
                  onmouseleave={() => (wb.highlight = { compIds: [], nodeIds: [] })}
                >
                  <td>
                    <b>{row.name}</b>
                    <span class="muted small">
                      {TYPE_LABEL[row.type]} · {row.curEndpoints ?? row.baseEndpoints}
                    </span>
                    {#if row.connChanged}
                      <span class="badge changed" title="基准时：{row.baseEndpoints}">接线/极性已变</span>
                    {/if}
                    {#if row.cur?.note || row.base?.note}
                      <div class="small muted">{row.cur?.note ?? row.base?.note}</div>
                    {/if}
                  </td>
                  <td>{@render statusBadge(row.status)}</td>
                  <td class="mono">
                    {#if row.type === 'wire'}
                      —
                    {:else if row.status === 'added'}
                      {fmt(row.curValue!)}{UNIT[row.type]}
                    {:else if row.status === 'removed'}
                      {fmt(row.baseValue!)}{UNIT[row.type]}
                    {:else if row.flags.value}
                      {fmt(row.baseValue!)} → <b>{fmt(row.curValue!)}{UNIT[row.type]}</b>
                    {:else}
                      {fmt(row.curValue!)}{UNIT[row.type]}
                    {/if}
                  </td>
                  <td class="mono">{@render qty(row.base?.v ?? null, row.cur?.v ?? null)}</td>
                  <td class="mono">{@render qty(row.base?.i ?? null, row.cur?.i ?? null)}</td>
                  <td class="mono">{@render qty(row.base?.p ?? null, row.cur?.p ?? null)}</td>
                </tr>
              {/each}
            </tbody>
          </table>

          <h4 class="diff-sub">接点对照（电位，参考地为 0 V）</h4>
          <table class="data diff-table">
            <thead>
              <tr>
                <th>接点</th>
                <th>状态</th>
                <th>电位 (V)<br /><span class="th-sub">基准 → 当前（Δ）</span></th>
              </tr>
            </thead>
            <tbody>
              {#each diff.nodes as row (row.nodeId)}
                <tr
                  class={row.status}
                  onmouseenter={() => hoverRow('node', row.nodeId, row.status === 'removed')}
                  onmouseleave={() => (wb.highlight = { compIds: [], nodeIds: [] })}
                >
                  <td>
                    {row.name}{row.curGround ? ' ⏚' : ''}
                    {#if row.baseGround && !row.curGround}<span class="muted small">（基准时为 ⏚）</span>{/if}
                  </td>
                  <td>{@render statusBadge(row.status)}</td>
                  <td class="mono">{@render qty(row.baseV, row.curV)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .panel {
    height: 250px;
    min-height: 180px;
    background: var(--panel);
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 6px 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    border-radius: 6px 6px 0 0;
    border-bottom: none;
    padding: 6px 12px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .content {
    flex: 1;
    padding: 10px 12px;
    overflow: auto;
  }
  .issues {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .issue {
    display: flex;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--panel-2);
    border-left: 3px solid var(--line);
    cursor: pointer;
  }
  .issue.error {
    border-left-color: var(--err);
  }
  .issue.warning {
    border-left-color: var(--warn);
  }
  .msg {
    font-weight: 600;
  }
  .detail {
    color: var(--muted);
    margin-top: 3px;
    line-height: 1.5;
  }
  .refs {
    margin-top: 5px;
    color: var(--muted);
    font-size: 11.5px;
  }
  .ref {
    background: #0f1c30;
    padding: 1px 7px;
    border-radius: 9px;
    margin-right: 4px;
    color: #bfdbfe;
  }
  .ok-line {
    color: var(--ok);
    font-weight: 600;
  }
  .edit-note {
    color: var(--muted);
    font-size: 11.5px;
    margin-top: 4px;
  }
  .mna-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .eq-note {
    color: var(--muted);
  }
  table.matrix {
    border-collapse: separate;
    border-spacing: 0;
  }
  .matrix th,
  .matrix td {
    padding: 3px 9px;
    text-align: center;
    min-width: 58px;
  }
  .matrix thead th {
    color: #7dd3fc;
    border-bottom: 1px solid var(--line);
  }
  .cell.traced {
    background: rgba(56, 189, 248, 0.08);
    border-radius: 4px;
    cursor: help;
  }
  .cell.traced:hover {
    background: rgba(244, 114, 182, 0.22);
  }
  .cell.zero {
    color: #475569;
  }
  .rowlabel {
    text-align: right !important;
    color: var(--muted);
    padding-right: 10px;
    white-space: nowrap;
  }
  .left {
    text-align: left !important;
  }
  .source {
    color: var(--muted);
    text-align: left;
    white-space: nowrap;
    padding-left: 14px;
  }
  .eq {
    color: var(--muted);
  }
  .rhs {
    color: #fcd34d;
  }
  .legend {
    display: flex;
    gap: 18px;
    color: var(--muted);
    font-size: 11.5px;
    margin-top: 4px;
  }
  .dot {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 2px;
    margin-right: 4px;
  }
  .dot.g {
    background: #7dd3fc;
  }
  .dot.v {
    background: #f0abfc;
  }
  table.data {
    border-collapse: collapse;
  }
  table.data th,
  table.data td {
    border: 1px solid var(--line);
    padding: 5px 12px;
    text-align: left;
  }
  table.data tbody tr:hover {
    background: var(--panel-2);
  }
  .placeholder {
    color: var(--muted);
    padding: 8px;
  }
  .power-sum {
    display: flex;
    gap: 30px;
    align-items: flex-start;
  }
  .big {
    font-size: 22px;
  }
  .ok {
    color: var(--ok);
  }
  .bad {
    color: var(--err);
  }
  .cols {
    display: flex;
    gap: 40px;
  }
  .cols h4 {
    margin: 0 0 6px;
  }
  .pow-row {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    padding: 2px 6px;
    border-radius: 5px;
  }
  .pow-row:hover {
    background: var(--panel-2);
  }
  .pow-row.total {
    border-top: 1px solid var(--line);
    margin-top: 4px;
    font-weight: 700;
  }
  .pos {
    color: var(--ok);
  }
  .neg {
    color: var(--err);
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 11px;
  }
  .diff-empty {
    padding: 6px 8px;
    line-height: 1.8;
  }
  .diff-empty .primary {
    background: #0369a1;
    border-color: var(--accent);
    padding: 7px 16px;
    font-weight: 700;
    margin-top: 4px;
  }
  .diff {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .diff-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .diff-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .diff-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .diff-sub {
    margin: 4px 0 -4px;
    color: #7dd3fc;
    font-size: 12.5px;
  }
  .diag-box {
    border: 1px solid var(--line);
    border-left: 3px solid var(--err);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--panel-2);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .diag-title {
    color: var(--warn);
    font-weight: 600;
  }
  .diag-line {
    color: var(--text);
  }
  .diff-table th {
    vertical-align: bottom;
  }
  .th-sub {
    color: var(--muted);
    font-weight: 400;
    font-size: 10.5px;
  }
  .diff-table tr.changed td {
    background: rgba(251, 191, 36, 0.07);
  }
  .diff-table tr.added td {
    background: rgba(52, 211, 153, 0.07);
  }
  .diff-table tr.removed td {
    background: rgba(248, 113, 113, 0.07);
  }
  .badge.added {
    background: rgba(52, 211, 153, 0.16);
    color: var(--ok);
  }
  .badge.removed {
    background: rgba(248, 113, 113, 0.16);
    color: var(--err);
  }
  .badge.changed {
    background: rgba(251, 191, 36, 0.16);
    color: var(--warn);
  }
  .arrow {
    color: var(--muted);
    padding: 0 3px;
  }
  .hl {
    color: #fcd34d;
  }
  .delta {
    color: var(--warn);
    padding-left: 6px;
  }
</style>
