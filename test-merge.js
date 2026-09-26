// 样点归并端到端验证：判断层（mergeDomain）+ 存档层（server API）
// 运行：node test-merge.js
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const mergeDomain = require('./mergeDomain');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function datePlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function api(pathName, options = {}) {
  const res = await fetch(`${BASE}${pathName}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function seedDb() {
  const mk = (id, code) => ({
    id,
    cave: '北麓三号洞',
    zone: '滴水帘区',
    pointCode: code,
    route: '西线巡测',
    sensitivity: '中',
    protectedStatus: '常规观察',
    baselineTemp: 16,
    baselineHumidity: 90,
    baselineCo2: 700,
    note: '',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    history: []
  });
  const survey = (id, siteId, date) => ({
    id,
    siteId,
    surveyor: '沈宁',
    date,
    temperature: 17,
    humidity: 88,
    co2: 900,
    dripRate: 10,
    disturbance: '',
    photoUrl: '',
    status: '正常',
    reviewNote: '',
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`,
    history: []
  });
  return {
    sites: [mk('site-a', 'D-01'), mk('site-b', 'D-02'), mk('site-c', 'D-03'), mk('site-d', 'D-04')],
    surveys: [survey('survey-old-b', 'site-b', '2026-06-10'), survey('survey-old-c', 'site-c', '2026-06-11')],
    siteMerges: []
  };
}

async function waitForServer(retries = 50) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/config`);
      if (res.ok) return;
    } catch (_) {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function run() {
  // ---------- 判断层单元验证 ----------
  console.log('判断层（mergeDomain）');
  const unitDb = seedDb();
  unitDb.siteMerges = [
    { id: 'p-old', keepSiteId: 'site-a', mergeSiteIds: ['site-b'], effectiveDate: '2020-01-01', status: '已生效' },
    { id: 'p-pending', keepSiteId: 'site-a', mergeSiteIds: ['site-c'], effectiveDate: '2099-01-01', status: '待生效' }
  ];
  const now = new Date('2026-09-26T08:00:00');
  let r = mergeDomain.validatePlan(unitDb, { keepSiteId: 'site-a', mergeSiteIds: ['site-b'], effectiveDate: '2026-10-01' }, { now });
  check('已生效方案不占用样点', r.ok === true);
  r = mergeDomain.validatePlan(unitDb, { keepSiteId: 'site-a', mergeSiteIds: ['site-c'], effectiveDate: '2026-10-01' }, { now });
  check('待生效方案占用样点被退回', r.ok === false && r.conflicts[0].planId === 'p-pending');
  check('退回信息指出占用方案', (r.error || '').includes('p-pending'));
  r = mergeDomain.validatePlan(unitDb, { keepSiteId: 'site-a', mergeSiteIds: ['site-a'], effectiveDate: '2026-10-01' }, { now });
  check('保留样点不可并入自身', r.ok === false);
  r = mergeDomain.validatePlan(unitDb, { keepSiteId: 'site-a', mergeSiteIds: ['site-d'], effectiveDate: '2020-01-01' }, { now });
  check('生效日期早于今天被退回', r.ok === false);

  const reordered = mergeDomain.reorderPending([
    { id: 'p1', status: '待生效', effectiveDate: '2026-10-05', createdAt: '1' },
    { id: 'p2', status: '已生效', effectiveDate: '2026-01-01', createdAt: '2' },
    { id: 'p3', status: '待生效', effectiveDate: '2026-10-01', createdAt: '3' }
  ]);
  check('待执行方案按生效日期重排', reordered.map((p) => p.id).join(',') === 'p3,p1,p2');

  const settled = mergeDomain.settleDuePlans({ siteMerges: [
    { id: 'p1', status: '待生效', effectiveDate: '2026-09-26' },
    { id: 'p2', status: '待生效', effectiveDate: '2026-09-27' }
  ] }, '2026-09-26');
  check('到期方案结算、未到期不动', settled.length === 1 && settled[0].id === 'p1');

  // ---------- 存档层 API 验证 ----------
  console.log('存档层（server API）');
  const tmpFile = path.join(os.tmpdir(), `merge-test-${Date.now()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify(seedDb(), null, 2));
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_FILE: tmpFile },
    stdio: 'ignore'
  });
  try {
    await waitForServer();

    // 1. 创建方案 P1：保留 A，并入 B，明天生效
    let res = await api('/api/siteMerges', {
      method: 'POST',
      body: JSON.stringify({ keepSiteId: 'site-a', mergeSiteIds: ['site-b'], effectiveDate: datePlus(1), note: '同一钟乳石群' })
    });
    check('创建待生效方案', res.status === 201 && res.body.status === '待生效');
    const p1 = res.body.id;

    // 2. 重复占用：B 已在 P1 中
    res = await api('/api/siteMerges', {
      method: 'POST',
      body: JSON.stringify({ keepSiteId: 'site-a', mergeSiteIds: ['site-b', 'site-c'], effectiveDate: datePlus(2) })
    });
    check('重复并入被退回(409)', res.status === 409);
    check('退回指出占用方案与样点', (res.body.error || '').includes(p1) && (res.body.error || '').includes('D-02'), res.body.error);

    // 3. 合法方案 P2：并入 C，后天生效
    res = await api('/api/siteMerges', {
      method: 'POST',
      body: JSON.stringify({ keepSiteId: 'site-a', mergeSiteIds: ['site-c'], effectiveDate: datePlus(2) })
    });
    check('第二方案创建成功', res.status === 201);
    const p2 = res.body.id;

    // 4. 待执行队列按生效日期排序
    let db = (await api('/api/db')).body;
    check('待执行方案按生效日期排序', db.siteMerges.map((p) => p.id).join(',') === `${p1},${p2}`);

    // 5. 改动 P2 生效日期为今天 → 重排到 P1 前
    res = await api(`/api/siteMerges/${p2}`, {
      method: 'PATCH',
      body: JSON.stringify({ effectiveDate: datePlus(0), historyAction: '调整生效日期' })
    });
    check('改动生效日期成功', res.status === 200);
    db = (await api('/api/db')).body;
    check('改期后待执行方案重排', db.siteMerges.map((p) => p.id).join(',') === `${p2},${p1}`);
    check('到期方案自动生效', db.siteMerges.find((p) => p.id === p2).status === '已生效');

    // 6. 已生效记录不可再改期
    res = await api(`/api/siteMerges/${p2}`, {
      method: 'PATCH',
      body: JSON.stringify({ effectiveDate: datePlus(5) })
    });
    check('已生效方案改期被退回', res.status === 409);

    // 7. 生效日期不可早于今天
    res = await api(`/api/siteMerges/${p1}`, {
      method: 'PATCH',
      body: JSON.stringify({ effectiveDate: datePlus(-1) })
    });
    check('生效日期早于今天被退回', res.status === 409);

    // 8. 到期后新巡测写入保留样点，原编号留痕
    res = await api('/api/surveys', {
      method: 'POST',
      body: JSON.stringify({ siteId: 'site-c', surveyor: '沈宁', date: datePlus(0), temperature: 17, humidity: 88, co2: 900, dripRate: 10, status: '正常' })
    });
    check('新巡测重定向到保留样点', res.status === 201 && res.body.siteId === 'site-a');
    check('原编号留痕 mergedFromSiteId', res.body.mergedFromSiteId === 'site-c');

    // 9. 未生效方案的样点不重定向
    res = await api('/api/surveys', {
      method: 'POST',
      body: JSON.stringify({ siteId: 'site-b', surveyor: '沈宁', date: datePlus(0), temperature: 17, humidity: 88, co2: 900, dripRate: 10, status: '正常' })
    });
    check('未生效方案样点照常写入', res.status === 201 && res.body.siteId === 'site-b' && !res.body.mergedFromSiteId);

    // 10. 旧记录仍按原编号查
    db = (await api('/api/db')).body;
    const oldC = db.surveys.find((s) => s.id === 'survey-old-c');
    check('旧巡测记录保持原编号', oldC.siteId === 'site-c' && !oldC.mergedFromSiteId);

    // 11. 受影响巡测：旧记录(原编号) + 新记录(重定向)
    res = await api(`/api/site-merges/${p2}/affected`);
    check('受影响巡测含新旧两类', res.body.total === 2 && res.body.rows.some((row) => row.route === 'redirected') && res.body.rows.some((row) => row.route === 'original'));
    check('受影响巡测给出原编号', res.body.originalCodes.includes('D-03'));

    // 12. 撤销待生效方案后，样点可被新方案占用
    res = await api(`/api/action/merge-cancel/${p1}`, { method: 'POST' });
    check('撤销待生效方案', res.status === 200 && res.body.status === '已撤销');
    res = await api('/api/siteMerges', {
      method: 'POST',
      body: JSON.stringify({ keepSiteId: 'site-a', mergeSiteIds: ['site-b'], effectiveDate: datePlus(3) })
    });
    check('撤销后样点可再次归并', res.status === 201);

    // 13. 已生效方案不可撤销
    res = await api(`/api/action/merge-cancel/${p2}`, { method: 'POST' });
    check('已生效方案不可撤销', res.status === 409);
  } finally {
    server.kill();
    await fs.unlink(tmpFile).catch(() => {});
  }

  console.log(`\n${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
