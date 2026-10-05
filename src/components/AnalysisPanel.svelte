<script lang="ts">
  import { wb } from '../lib/wb.svelte.ts';
  import { fmt } from '../lib/engine/analyze';
  import type { Issue } from '../lib/engine/types';
  import type { DiffStatus, NumSide } from '../lib/snapshot';

  let tab = $state<'issues' | 'mna' | 'kcl' | 'power' | 'snapshot'>('issues');

  // 仅在错误“新出现”时自动跳到诊断页，避免在对照页编辑时被反复抢走焦点
  let prevErrorCount = 0;
  $effect(() => {
    const errCountNow = wb.result.issues.filter((i) => i.kind === 'error').length;
    if (errCountNow > 0 && prevErrorCount === 0) tab = 'issues';
    prevErrorCount = errCountNow;
  });

  const result = $derived(wb.result);
  const compName = (id: string) => wb.circuit.comps.find((c) => c.id === id)?.name;
  const nodeName = (id: string) => wb.circuit.nodes.find((n) => n.id === id)?.name;

  // ---------- 对照快照 ----------
  const diff = $derived(wb.snapshotDiff);
  let onlyChanged = $state(true);

  const statusOrder: Record<DiffStatus, number> = { changed: 0, added: 1, removed: 2, same: 3 };
  const statusLabel: Record<DiffStatus, string> = {
    changed: '变化',
    added: '新增',
    removed: '删除',
    same: '不变',
  };
  const visibleNodes = $derived(
    [...diff.nodes]
      .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name))
      .filter((r) => !onlyChanged || r.status !== 'same'),
  );
  const visibleComps = $derived(
    [...diff.comps]
      .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name))
      .filter((r) => !onlyChanged || r.status !== 'same'),
  );

  /** 诊断 refs 的名字：优先当前电路，找不到再查基准电路（对象可能已被删除） */
  function refName(id: string): string {
    return compName(id) ?? nodeName(id) ?? wb.snapshot?.circuit.comps.find((c) => c.id === id)?.name
      ?? wb.snapshot?.circuit.nodes.find((n) => n.id === id)?.name ?? id;
  }

  function hoverDiff(kind: 'node' | 'comp', id: string, status: DiffStatus | null) {
    if (!status || status === 'removed') {
      wb.highlight = { compIds: [], nodeIds: [] };
      return;
    }
    if (kind === 'node') {
      wb.highlight = wb.circuit.nodes.some((n) => n.id === id)
        ? { compIds: [], nodeIds: [id] }
        : { compIds: [], nodeIds: [] };
    } else {
      wb.highlight = wb.circuit.comps.some((c) => c.id === id)
        ? { compIds: [id], nodeIds: [] }
        : { compIds: [], nodeIds: [] };
    }
  }

  function clickDiff(kind: 'node' | 'comp', id: string, status: DiffStatus) {
    if (status === 'removed') return; // 已删除对象无法在当前电路图中选中
    wb.selection = { kind, id };
  }

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
</script>

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
    <button class:active={tab === 'snapshot'} onclick={() => (tab = 'snapshot')}>
      对照快照
      {#if diff.hasSnapshot}
        <span class="badge" class:changed={diff.counts.changed + diff.counts.added + diff.counts.removed > 0}>
          {diff.counts.changed + diff.counts.added + diff.counts.removed}
        </span>
      {/if}
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
    {:else if tab === 'snapshot'}
      {#if !diff.hasSnapshot}
        <div class="snap-empty">
          <div class="placeholder">
            尚未保存对照基准。点击下方按钮，把<b>当前电路与求解摘要冻结为只读快照</b>；
            之后继续编辑，就能在本页按接点与元件查看电位 / 电流 / 功率变化。
          </div>
          <button class="primary snap-btn" disabled={wb.snapshotBusy} onclick={() => void wb.takeSnapshot()}>
            📸 保存当前为对照快照
          </button>
          <div class="muted small">快照随本工程存入 IndexedDB，重开工程后仍可对照；不会影响其他工程。</div>
        </div>
      {:else}
        {@const snap = wb.snapshot!}
        <div class="snap-head">
          <div class="snap-meta">
            <span class="snap-pin">📌 只读基准</span>
            保存于 {new Date(snap.createdAt).toLocaleString('zh-CN')}
            · 基准电路 {snap.circuit.nodes.length} 接点 / {snap.circuit.comps.length} 元件
          </div>
          <div class="snap-actions">
            <button disabled={wb.snapshotBusy} onclick={() => void wb.takeSnapshot()}>↻ 用当前电路替换基准</button>
            <button
              class="danger"
              onclick={() => {
                if (confirm('清除对照快照？当前电路不会被改动。')) void wb.clearSnapshot();
              }}>清除快照</button
            >
          </div>
        </div>

        <div class="snap-sides">
          <div class="side-card" class:bad={!diff.baseOk}>
            <b>基准侧</b>
            {#if diff.baseOk}<span class="tag ok">可求解</span>{:else}<span class="tag bad">无法求解</span>{/if}
            {#if !diff.baseOk}
              <ul class="diag-list">
                {#each diff.baseIssues.filter((x) => x.kind === 'error') as issue (issue.code + issue.message)}
                  <li title={issue.refs.map(refName).join('、')}>{issue.message}</li>
                {/each}
              </ul>
            {/if}
          </div>
          <div class="side-arrow">→</div>
          <div class="side-card" class:bad={!diff.nowOk}>
            <b>当前侧</b>
            {#if result.ok}<span class="tag ok">可求解</span>{:else}<span class="tag bad">无法求解</span>{/if}
            {#if !result.ok}
              <ul class="diag-list">
                {#each result.issues.filter((x) => x.kind === 'error') as issue (issue.code + issue.message)}
                  <li title={issue.refs.map(refName).join('、')}>{issue.message}</li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
        {#if !diff.baseOk || !diff.nowOk}
          <div class="snap-note">
            任一侧无法求解时，该侧数值留空（<span class="mono">—</span>）且差值不计算，诊断保留在上方，绝不以 NaN 冒充差值。
          </div>
        {/if}

        <div class="snap-summary">
          <span class="pill changed">变化 {diff.counts.changed}</span>
          <span class="pill added">新增 {diff.counts.added}</span>
          <span class="pill removed">删除 {diff.counts.removed}</span>
          <span class="pill same">不变 {diff.counts.same}</span>
          <label class="filter-row">
            <input type="checkbox" bind:checked={onlyChanged} />
            仅看有变化的对象
          </label>
        </div>

        <h4 class="sec-title">接点电位（V）</h4>
        <table class="data diff-table">
          <thead>
            <tr><th>状态</th><th>接点</th><th>基准电位</th><th>当前电位</th><th>Δ（当前−基准）</th></tr>
          </thead>
          <tbody>
            {#each visibleNodes as nd (nd.kind + nd.id)}
              <tr
                class="row-{nd.status}"
                tabindex="0"
                onmouseenter={() => hoverDiff('node', nd.id, nd.status)}
                onmouseleave={() => hoverDiff('node', nd.id, null)}
                onclick={() => clickDiff('node', nd.id, nd.status)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') clickDiff('node', nd.id, nd.status);
                }}
              >
                <td><span class="status {nd.status}">{statusLabel[nd.status]}</span></td>
                <td>{nd.name}{nd.ground.base || nd.ground.now ? ' ⏚' : ''}</td>
                <td class="mono">{cell(nd.voltage, true)}</td>
                <td class="mono">{cell(nd.voltage, false)}</td>
                <td class="mono">{deltaCell(nd.voltage)}</td>
              </tr>
            {/each}
            {#if visibleNodes.length === 0}
              <tr><td colspan="5" class="muted">无符合条件的接点</td></tr>
            {/if}
          </tbody>
        </table>

        <h4 class="sec-title">元件支路（电位 V / 电流 A / 功率 W）</h4>
        <table class="data diff-table">
          <thead>
            <tr>
              <th>状态</th><th>元件</th>
              <th title="元件参数：R 为 Ω，V 为 V，I 为 A">参数</th>
              <th>V（基准）</th><th>V（当前）</th><th>ΔV</th>
              <th>I（基准）</th><th>I（当前）</th><th>ΔI</th>
              <th>P（基准）</th><th>P（当前）</th><th>ΔP</th>
            </tr>
          </thead>
          <tbody>
            {#each visibleComps as cd (cd.kind + cd.id)}
              <tr
                class="row-{cd.status}"
                tabindex="0"
                onmouseenter={() => hoverDiff('comp', cd.id, cd.status)}
                onmouseleave={() => hoverDiff('comp', cd.id, null)}
                onclick={() => clickDiff('comp', cd.id, cd.status)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') clickDiff('comp', cd.id, cd.status);
                }}
              >
                <td><span class="status {cd.status}">{statusLabel[cd.status]}</span></td>
                <td>{cd.name} <span class="muted small">{cd.type}</span></td>
                <td class="mono">
                  {#if cd.type === 'wire'}
                    <span class="na">导线</span>
                  {:else}
                    {cell(cd.value, true)}
                    <span class="muted small">{cd.type === 'R' ? 'Ω' : cd.type === 'V' ? 'V' : 'A'}</span>
                  {/if}
                </td>
                <td class="mono">{cell(cd.v)}</td>
                <td class="mono">{cell(cd.v, false)}</td>
                <td class="mono">{deltaCell(cd.v)}</td>
                <td class="mono">{cell(cd.i)}</td>
                <td class="mono">{cell(cd.i, false)}</td>
                <td class="mono delta-cell">{deltaCell(cd.i)}</td>
                <td class="mono">{cell(cd.power)}</td>
                <td class="mono">{cell(cd.power, false)}</td>
                <td class="mono">{deltaCell(cd.power)}</td>
              </tr>
            {/each}
            {#if visibleComps.length === 0}
              <tr><td colspan="12" class="muted">无符合条件的元件</td></tr>
            {/if}
          </tbody>
        </table>
        <div class="muted small snap-foot">
          参考方向全程一致：元件 a→b 为电流正方向，吸收功率 P=V·I（负为发出）。
          被删除对象的基准值仍完整保留在表中；新增对象的基准侧标记为“—”。
        </div>
      {/if}
    {/if}
  </div>
</section>

{#snippet cell(s: NumSide, base = true)}
  {#if (base ? s.base : s.now) === null}
    <span class="na">{(base ? s.baseStatus : s.nowStatus) === 'missing' ? '—' : '无解'}</span>
  {:else}
    {fmt(base ? s.base! : s.now!)}
  {/if}
{/snippet}

{#snippet deltaCell(s: NumSide)}
  {#if s.delta === null}
    <span class="na">—</span>
  {:else if Math.abs(s.delta) <= 1e-9}
    <span class="zero">0</span>
  {:else}
    <span class:pos={s.delta > 0} class:neg={s.delta < 0}>{s.delta > 0 ? '+' : ''}{fmt(s.delta)}</span>
  {/if}
{/snippet}

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

  /* ---------- 对照快照 ---------- */
  .tabs .badge.changed {
    background: rgba(251, 191, 36, 0.2);
    color: var(--warn);
  }
  .snap-empty {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
  }
  .snap-btn {
    padding: 8px 18px;
    font-weight: 700;
    background: #0369a1;
    border-color: var(--accent);
    color: #e0f2fe;
  }
  .snap-btn:hover {
    background: #075985;
  }
  .snap-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .snap-meta {
    color: var(--muted);
    font-size: 11.5px;
  }
  .snap-pin {
    color: var(--warn);
    font-weight: 700;
    margin-right: 6px;
  }
  .snap-actions {
    display: flex;
    gap: 6px;
  }
  .snap-sides {
    display: flex;
    gap: 10px;
    align-items: stretch;
    margin-bottom: 6px;
  }
  .side-card {
    flex: 1;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px 10px;
    background: var(--panel-2);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .side-card.bad {
    border-color: var(--err);
  }
  .side-arrow {
    align-self: center;
    color: var(--muted);
    font-size: 16px;
  }
  .tag {
    font-size: 11px;
    border-radius: 9px;
    padding: 0 8px;
    margin-left: 6px;
  }
  .tag.ok {
    color: var(--ok);
    background: rgba(52, 211, 153, 0.14);
  }
  .tag.bad {
    color: var(--err);
    background: rgba(248, 113, 113, 0.14);
  }
  .diag-list {
    margin: 2px 0 0;
    padding-left: 16px;
    color: var(--err);
    font-size: 11.5px;
    line-height: 1.5;
  }
  .snap-note {
    color: var(--warn);
    font-size: 11.5px;
    margin-bottom: 6px;
  }
  .snap-summary {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 6px 0 8px;
    flex-wrap: wrap;
  }
  .pill {
    font-size: 11px;
    border-radius: 10px;
    padding: 1px 9px;
    background: var(--panel-2);
  }
  .pill.changed {
    color: var(--warn);
  }
  .pill.added {
    color: var(--ok);
  }
  .pill.removed {
    color: var(--err);
  }
  .pill.same {
    color: var(--muted);
  }
  .filter-row {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 11.5px;
    margin-left: auto;
  }
  .filter-row input {
    width: auto;
  }
  .sec-title {
    margin: 10px 0 5px;
    font-size: 12.5px;
    color: #7dd3fc;
  }
  .diff-table th,
  .diff-table td {
    white-space: nowrap;
  }
  .diff-table tbody tr {
    cursor: pointer;
  }
  tr.row-added {
    background: rgba(52, 211, 153, 0.07);
  }
  tr.row-removed {
    background: rgba(248, 113, 113, 0.07);
    opacity: 0.85;
  }
  tr.row-changed {
    background: rgba(251, 191, 36, 0.06);
  }
  .status {
    font-size: 10.5px;
    border-radius: 9px;
    padding: 0 7px;
    white-space: nowrap;
  }
  .status.changed {
    color: var(--warn);
    background: rgba(251, 191, 36, 0.16);
  }
  .status.added {
    color: var(--ok);
    background: rgba(52, 211, 153, 0.16);
  }
  .status.removed {
    color: var(--err);
    background: rgba(248, 113, 113, 0.16);
  }
  .status.same {
    color: var(--muted);
    background: var(--panel-2);
  }
  .na {
    color: #475569;
  }
  .zero {
    color: var(--muted);
  }
  .pos {
    color: var(--ok);
  }
  .neg {
    color: var(--err);
  }
  .snap-foot {
    margin-top: 8px;
    line-height: 1.6;
  }
</style>
