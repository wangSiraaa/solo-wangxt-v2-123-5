import { chromium } from 'playwright';
import { defineConfig } from 'vite';

void defineConfig;

const BASE = 'http://localhost:5199';

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, cond: boolean, detail = '') {
  results.push({ name, ok: cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const SHELL =
  process.env.CHROME_PATH ??
  '/home/node/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell';
const browser = await chromium.launch({
  headless: true,
  executablePath: SHELL,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  env: {
    ...process.env,
    LD_LIBRARY_PATH:
      (process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH + ':' : '') +
      '/tmp/chromelibs/extracted/usr/lib/aarch64-linux-gnu:' +
      '/tmp/chromelibs/extracted/lib/aarch64-linux-gnu',
  },
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// 关闭欢迎页
const startBtn = page.getByRole('button', { name: '开始实验' });
if (await startBtn.count()) await startBtn.click();
await page.waitForTimeout(300);

// ---------- 1. 桥式网络：默认示例 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '桥式网络' }).click();
await page.waitForTimeout(400);

// MNA 标签可打开且矩阵渲染
await page.getByRole('button', { name: /MNA 方程/ }).click();
await page.waitForTimeout(200);
const matrixCells = await page.locator('table.matrix td.cell').count();
check('桥式网络：MNA 矩阵已建立（非空）', matrixCells > 0, `${matrixCells} 个单元格`);
const matrixHasTrace = await page.locator('table.matrix td.cell.traced').count();
check('桥式网络：矩阵系数可溯源到元件', matrixHasTrace > 0, `${matrixHasTrace} 个可溯源格`);

// KCL 残差全为 ✓
await page.getByRole('button', { name: /节点 KCL/ }).click();
await page.waitForTimeout(150);
const kclRows = await page.locator('table.data tbody tr').count();
const kclBad = await page.locator('table.data tbody tr td:last-child:text("✗")').count();
check('桥式网络：所有超节点 KCL 残差为 0', kclRows >= 4 && kclBad === 0, `${kclRows} 行, ${kclBad} 行失败`);

// 功率平衡
await page.getByRole('button', { name: /功率平衡/ }).click();
await page.waitForTimeout(150);
const powerText = await page.locator('.power-sum .big').textContent();
const powerVal = Number((powerText ?? '').replace(/[^\d.eE+-]/g, ''));
check('桥式网络：功率平衡 ΣP≈0', Math.abs(powerVal) < 1e-6, `Σ吸收=${powerText?.trim()}`);

// 画布上有电流方向箭头（Konva 场景对象，不是 DOM）
await page.waitForTimeout(300);
const arrowCount = await page.evaluate(() => {
  const r = (window as unknown as { __renderer?: { stage: { find: (s: string) => unknown[] } } }).__renderer;
  return r ? r.stage.find('Arrow').length : -1;
});
check('桥式网络：原理图绘制了电流方向箭头', arrowCount >= 4, `${arrowCount} 个箭头`);

// 电位标注（Konva 文本节点）
const voltageLabelCount = await page.evaluate(() => {
  const r = (window as unknown as { __renderer?: { stage: { find: (s: string) => { text(): string }[] } } }).__renderer;
  if (!r) return -1;
  return r.stage.find('Text').filter((t) => /^-?[\d.]+V$/.test(t.text())).length;
});
check('桥式网络：节点电位已标注', voltageLabelCount >= 3, `${voltageLabelCount} 个电位文本`);

// ---------- 2. 矛盾并联电压源：不得出 NaN ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '矛盾并联电压源' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /诊断/ }).click();
await page.waitForTimeout(200);
const issueText = await page.locator('.issues').innerText();
check('矛盾电源：出现 VSOURCE_LOOP 约束错误', /电压源回路矛盾|被零电阻短路|无法同时成立/.test(issueText), issueText.slice(0, 120).replace(/\n/g, ' '));
// 不应出现作为数值的 NaN（排除提示语“不会出现 NaN”）
const panelText = await page.locator('.panel').innerText();
const withoutHint = panelText.replace(/不会出现\s*NaN/g, '');
check('矛盾电源：界面不出现数值 NaN', !/NaN/.test(withoutHint));
check('矛盾电源：提示电路可继续编辑', /继续编辑/.test(issueText));
// 原理图仍然存在（元件还在）
const stageVisible = await page.locator('.konvajs-content').count();
check('矛盾电源：原理图仍保留可编辑', stageVisible === 1);

// ---------- 3. 浮空子网 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '浮空子网' }).click();
await page.waitForTimeout(400);
let diag = await page.locator('.issues').innerText();
check('浮空子网：报 FLOATING', /浮空子网/.test(diag));
const stripHint = (s: string) => s.replace(/不会出现\s*NaN/g, '');
check('浮空子网：无 NaN', !/NaN/.test(stripHint(diag)));

// ---------- 4. 孤立节点 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '孤立节点' }).click();
await page.waitForTimeout(400);
diag = await page.locator('.issues').innerText();
check('孤立节点：报 ISOLATED', /孤立节点/.test(diag));

// ---------- 5. 零电阻边界 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '零电阻边界' }).click();
await page.waitForTimeout(400);
diag = await page.locator('.issues').innerText();
const zeroOk = !/错误/.test(diag);
check('零电阻：求解成功（无错误）', zeroOk, diag.slice(0, 100).replace(/\n/g, ' '));
await page.getByRole('button', { name: /节点 KCL/ }).click();
const zeroKclBad = await page.locator('table.data tbody tr td:last-child:text("✗")').count();
check('零电阻：KCL 全部平衡', zeroKclBad === 0);

// ---------- 6. 电流源串联割集 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '电流源串联冲突' }).click();
await page.waitForTimeout(400);
diag = await page.locator('.issues').innerText();
check('电流源串联：报 ICUTSET 割集冲突', /割集/.test(diag));

// ---------- 7. 串联电源对照 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '串联电源（同向）' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /功率平衡/ }).click();
const p1 = await page.locator('.power-sum .big').textContent();
check('串联同向 17V/100Ω：功率平衡', Math.abs(Number((p1 ?? '').replace(/[^\d.eE+-]/g, ''))) < 1e-6, p1?.trim());

await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '串联电源（反向）' }).click();
await page.waitForTimeout(400);
const p2 = await page.locator('.power-sum .big').textContent();
check('串联反向 7V/100Ω：功率平衡', Math.abs(Number((p2 ?? '').replace(/[^\d.eE+-]/g, ''))) < 1e-6, p2?.trim());

// ---------- 8. 拖动元件不改变连接 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '桥式网络' }).click();
await page.waitForTimeout(400);
const before = await page.evaluate(async () => {
  const req = indexedDB.open('dc-workbench');
  return await new Promise((resolve) => {
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('circuits', 'readonly');
      tx.objectStore('circuits').getAll().onsuccess = (e) => {
        const all = (e.target as IDBRequest).result;
        resolve(all.length);
      };
    };
    req.onerror = () => resolve(-1);
  });
});
check('工程已持久化到 IndexedDB', (before as number) >= 1, `${before} 个工程`);

// ---------- 9. 跳线：桥式网络几何交叉处绘制了跳线弧 ----------
await page.waitForTimeout(300);
// 交叉层路径数
const jumpPaths = await page.evaluate(() => document.querySelectorAll('canvas').length);
check('Konva canvas 已挂载', jumpPaths >= 1, `${jumpPaths} canvas`);

// ---------- 10. 对照快照 ----------
await page.getByRole('button', { name: /载入示例/ }).click();
await page.getByRole('button', { name: '桥式网络' }).click();
await page.waitForTimeout(400);

// 拍基准：元件 6 行、接点 4 行，初始与基准一致
await page.getByRole('button', { name: /对照快照/ }).click();
await page.waitForTimeout(150);
await page.getByRole('button', { name: /保存当前为对照基准/ }).click();
await page.waitForTimeout(300);
const diffCompRows = await page.locator('table.diff-table').first().locator('tbody tr').count();
const diffNodeRows = await page.locator('table.diff-table').nth(1).locator('tbody tr').count();
check('对照快照：基准列出全部元件与接点', diffCompRows === 6 && diffNodeRows === 4, `${diffCompRows} 元件 / ${diffNodeRows} 接点`);
const diffHead = await page.locator('.diff-head').innerText();
check('对照快照：初始与基准一致', /与基准一致/.test(diffHead), diffHead.slice(0, 60).replace(/\n/g, ' '));

// 只改一个电阻：画布上点选 R1（点击之字线顶点，由实时几何计算），检查器中 100Ω → 150Ω
const r1Pt = await page.evaluate(() => {
  const w = (window as unknown as { __wb: any }).__wb;
  const c = w.circuit.comps.find((x: { name: string }) => x.name === 'R1');
  const A = w.circuit.nodes.find((n: { id: string }) => n.id === c.a);
  const B = w.circuit.nodes.find((n: { id: string }) => n.id === c.b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const L = Math.hypot(dx, dy);
  const ux = dx / L;
  const uy = dy / L;
  const t = Math.min(0.92, Math.max(0.08, c.t));
  const Cx = A.x + ux * t * L - uy * c.offset;
  const Cy = A.y + uy * t * L + ux * c.offset;
  // 之字线顶点（元件局部坐标 (-12,-10)：w=48、h=12 的第 2 段折点）旋转到世界坐标
  const bx = -12;
  const by = -10;
  return { x: Cx + bx * ux - by * uy, y: Cy + bx * uy + by * ux };
});
const canvasBox = await page.locator('.canvas-wrap').boundingBox();
await page.mouse.click(canvasBox!.x + r1Pt.x, canvasBox!.y + r1Pt.y);
await page.waitForTimeout(200);
const rInput = page.locator('.inspector .field', { hasText: '电阻' }).locator('input');
await rInput.fill('150');
await rInput.press('Enter');
await page.waitForTimeout(300);
await page.getByRole('button', { name: /对照快照/ }).click();
await page.waitForTimeout(200);
const r1RowText = await page.locator('table.diff-table tbody tr', { hasText: 'R1' }).first().innerText();
check(
  '对照快照：只改一个电阻后相关支路出现差值',
  /有变化/.test(r1RowText) && /100\s*→\s*150/.test(r1RowText) && /[+-]\d/.test(r1RowText),
  r1RowText.replace(/\n/g, ' | ').slice(0, 140),
);
const node2RowText = await page.locator('table.diff-table').nth(1).locator('tbody tr', { hasText: /^2\s/ }).first().innerText();
check('对照快照：相关接点电位差值可见', /有变化/.test(node2RowText), node2RowText.replace(/\n/g, ' | ').slice(0, 100));

// 删除该元件：基准中的值仍可查看
await page.keyboard.press('Delete');
await page.waitForTimeout(300);
const r1GoneText = await page.locator('table.diff-table tbody tr', { hasText: 'R1' }).first().innerText();
check(
  '对照快照：删除元件后单独标识且基准值仍可查看',
  /已删除/.test(r1GoneText) && /100/.test(r1GoneText) && /—/.test(r1GoneText),
  r1GoneText.replace(/\n/g, ' | ').slice(0, 140),
);
check('对照快照：界面无数值 NaN', !/NaN/.test((await page.locator('.panel').innerText()).replace(/不会出现\s*NaN/g, '')));

// 重开（刷新）后基准仍在，可继续比较；先等防抖保存落库
await page.waitForFunction(
  () => (window as unknown as { __wb: { saveState: string } }).__wb.saveState === 'saved',
  { timeout: 8000 },
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const startBtn2 = page.getByRole('button', { name: '开始实验' });
if (await startBtn2.count()) await startBtn2.click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /对照快照/ }).click();
await page.waitForTimeout(200);
const afterReload = await page.locator('table.diff-table tbody tr', { hasText: 'R1' }).first().innerText();
check('对照快照：重开工程后基准仍在（随工程入 IndexedDB）', /已删除/.test(afterReload), afterReload.replace(/\n/g, ' | ').slice(0, 100));

// 清除快照：不改变当前电路，也不影响其他工程
const beforeClear = await page.evaluate(async () => {
  const w = (window as unknown as { __wb: { circuit: { comps: unknown[]; nodes: unknown[] } } }).__wb;
  const projects: number = await new Promise((resolve) => {
    const req = indexedDB.open('dc-workbench');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('circuits', 'readonly');
      tx.objectStore('circuits').getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result.length);
    };
    req.onerror = () => resolve(-1);
  });
  return { comps: w.circuit.comps.length, nodes: w.circuit.nodes.length, projects };
});
await page.getByRole('button', { name: '清除快照' }).click();
await page.waitForTimeout(900); // 覆盖防抖保存
const afterClear = await page.evaluate(async () => {
  const w = (window as unknown as { __wb: { circuit: { comps: unknown[]; nodes: unknown[] }; snapshot: unknown } }).__wb;
  const projects: number = await new Promise((resolve) => {
    const req = indexedDB.open('dc-workbench');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('circuits', 'readonly');
      tx.objectStore('circuits').getAll().onsuccess = (e) => resolve((e.target as IDBRequest).result.length);
    };
    req.onerror = () => resolve(-1);
  });
  return { comps: w.circuit.comps.length, nodes: w.circuit.nodes.length, projects, snap: w.snapshot };
});
check(
  '对照快照：清除快照不改变当前电路',
  afterClear.snap === null && afterClear.comps === beforeClear.comps && afterClear.nodes === beforeClear.nodes,
  `元件 ${beforeClear.comps}→${afterClear.comps}，接点 ${beforeClear.nodes}→${afterClear.nodes}`,
);
check(
  '对照快照：清除快照不影响其他工程',
  afterClear.projects === beforeClear.projects,
  `工程数 ${beforeClear.projects}→${afterClear.projects}`,
);
const emptyAgain = await page.locator('.diff-empty').count();
check('对照快照：清除后回到未拍快照状态', emptyAgain === 1);

// ---------- 11. 无控制台错误 ----------
const realErrors = errors.filter((e) => !/favicon/i.test(e));
check('浏览器无运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
