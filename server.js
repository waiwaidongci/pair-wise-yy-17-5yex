const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const merge = require('./merge');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  for (const key of ['sites', 'surveys', 'merges']) db[key] = db[key] || [];
  return db;
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  if (merge.activateDuePlans(db).length) await writeDb(db);
  for (const key of Object.keys(db)) {
    if (!Array.isArray(db[key])) continue;
    db[key] = key === 'merges' ? merge.sortPlans(db[key]) : db[key].sort(sortNewest);
  }
  res.json(db);
});

// 新建归并方案：判断层校验，待并入样点在待生效方案中只能出现一次
app.post('/api/merges', async (req, res) => {
  const db = await readDb();
  merge.activateDuePlans(db);
  const input = {
    keepSiteId: req.body.keepSiteId,
    mergeSiteIds: req.body.mergeSiteIds,
    effectiveDate: req.body.effectiveDate,
    note: req.body.note || ''
  };
  const errors = merge.validatePlan(db, input);
  if (errors.length) return res.status(409).json({ error: errors.join('；') });
  const now = new Date().toISOString();
  const keep = db.sites.find((site) => site.id === input.keepSiteId);
  const mergedCodes = input.mergeSiteIds.map((id) => db.sites.find((site) => site.id === id)?.pointCode).filter(Boolean);
  const plan = {
    id: `merges-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    title: `${keep.pointCode} 归并方案`,
    keepSiteId: input.keepSiteId,
    mergeSiteIds: [...new Set(input.mergeSiteIds)],
    effectiveDate: input.effectiveDate,
    note: input.note,
    status: '待生效',
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建方案', `保留 ${keep.pointCode}，并入 ${mergedCodes.join('、')}`)]
  };
  db.merges.push(plan);
  merge.activateDuePlans(db);
  await writeDb(db);
  res.status(201).json(plan);
});

// 改动生效日期：仅待生效方案可改，已生效记录不动；保存后待执行方案按日期重排
app.post('/api/merges/:id/reschedule', async (req, res) => {
  const db = await readDb();
  merge.activateDuePlans(db);
  const plan = db.merges.find((entry) => entry.id === req.params.id);
  if (!plan) return res.status(404).json({ error: '方案不存在' });
  if (plan.status !== '待生效') return res.status(409).json({ error: '方案已生效，生效日期不可改动' });
  const date = req.body.effectiveDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: '生效日期格式不正确' });
  plan.effectiveDate = date;
  plan.updatedAt = new Date().toISOString();
  plan.history = plan.history || [];
  plan.history.unshift(stamp('调整生效日期', `生效日期改为 ${date}`));
  merge.activateDuePlans(db);
  await writeDb(db);
  res.json(plan);
});

// 撤销待生效方案，释放待并入样点占用；已生效方案不可撤销
app.delete('/api/merges/:id', async (req, res) => {
  const db = await readDb();
  merge.activateDuePlans(db);
  const plan = db.merges.find((entry) => entry.id === req.params.id);
  if (!plan) return res.status(404).json({ error: '方案不存在' });
  if (plan.status !== '待生效') return res.status(409).json({ error: '方案已生效，不可撤销' });
  db.merges = db.merges.filter((entry) => entry.id !== plan.id);
  await writeDb(db);
  res.status(204).end();
});

// 查看方案受影响的巡测
app.get('/api/merges/:id/affected', async (req, res) => {
  const db = await readDb();
  const plan = db.merges.find((entry) => entry.id === req.params.id);
  if (!plan) return res.status(404).json({ error: '方案不存在' });
  res.json(merge.affectedSurveys(db, plan).sort(sortNewest));
});

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  let redirectNote = '';
  if (collection === 'surveys') {
    merge.activateDuePlans(db);
    const decision = merge.resolveSurveySite(db, req.body.siteId);
    if (decision.redirected) {
      req.body.siteId = decision.siteId;
      req.body.originalSiteId = decision.originalSiteId;
      req.body.originalPointCode = decision.originalPointCode;
      redirectNote = `原编号 ${decision.originalPointCode} 已归并，写入保留样点`;
    }
  }
  const now = new Date().toISOString();
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  if (redirectNote) item.history.unshift(stamp('样点归并', redirectNote));
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
