const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const mergeDomain = require('./mergeDomain');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const MERGE_COLLECTION = 'siteMerges';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// 判断层脚本共享给页面（与存档层同一份逻辑）
app.get('/mergeDomain.js', (req, res) => res.sendFile(path.join(__dirname, 'mergeDomain.js')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
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

function sortByEffectiveDate(a, b) {
  const byDate = String(a.effectiveDate || '').localeCompare(String(b.effectiveDate || ''));
  if (byDate !== 0) return byDate;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

// 存档层：到期方案结算为「已生效」，返回是否有变更（不写库，由调用方落盘）
function settleMerges(db) {
  const changes = mergeDomain.settleDuePlans(db);
  if (!changes.length) return false;
  const now = new Date().toISOString();
  for (const change of changes) {
    const plan = db[MERGE_COLLECTION].find((entry) => entry.id === change.id);
    if (!plan) continue;
    plan.status = change.to;
    plan.activatedAt = now;
    plan.updatedAt = now;
    plan.history = plan.history || [];
    plan.history.unshift(stamp('归并生效', `生效日期 ${plan.effectiveDate} 到期，新巡测写入保留样点`));
  }
  return true;
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  const settled = settleMerges(db);
  for (const key of Object.keys(db)) {
    if (!Array.isArray(db[key])) continue;
    db[key].sort(key === MERGE_COLLECTION ? sortByEffectiveDate : sortNewest);
  }
  if (settled) await writeDb(db);
  res.json(db);
});

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  settleMerges(db);
  const now = new Date().toISOString();

  if (collection === MERGE_COLLECTION) {
    const check = mergeDomain.validatePlan(db, req.body, { now: new Date() });
    if (!check.ok) return res.status(409).json({ error: check.error, conflicts: check.conflicts || [] });
    const item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      keepSiteId: req.body.keepSiteId,
      mergeSiteIds: req.body.mergeSiteIds,
      effectiveDate: req.body.effectiveDate,
      note: req.body.note || '',
      status: '待生效',
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建归并方案', `生效日期 ${req.body.effectiveDate}`)]
    };
    db[MERGE_COLLECTION].push(item);
    db[MERGE_COLLECTION] = mergeDomain.reorderPending(db[MERGE_COLLECTION]);
    await writeDb(db);
    return res.status(201).json(item);
  }

  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  if (collection === 'surveys') {
    // 归并已生效：新巡测写入保留样点，原编号留在 mergedFromSiteId 供回查
    const resolved = mergeDomain.resolveSurveySite(db, item.siteId, item.date);
    if (resolved.merged) {
      const original = db.sites.find((site) => site.id === resolved.originalSiteId);
      item.siteId = resolved.siteId;
      item.mergedFromSiteId = resolved.originalSiteId;
      item.history.unshift(
        stamp('样点归并', `原样点 ${original?.pointCode || resolved.originalSiteId} 已并入，本记录写入保留样点`)
      );
    }
  }
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  settleMerges(db);
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;

  if (collection === MERGE_COLLECTION) {
    // 方案三要素（保留样点/待并入样点/生效日期）仅在待生效时可改，且需通过占用校验
    const shapeTouched =
      req.body.keepSiteId !== undefined ||
      req.body.mergeSiteIds !== undefined ||
      (req.body.effectiveDate !== undefined && req.body.effectiveDate !== item.effectiveDate);
    if (shapeTouched) {
      if (item.status !== '待生效') {
        return res.status(409).json({ error: `方案已${item.status}，归并内容不可再改` });
      }
      const check = mergeDomain.validatePlan(
        db,
        {
          keepSiteId: req.body.keepSiteId ?? item.keepSiteId,
          mergeSiteIds: req.body.mergeSiteIds ?? item.mergeSiteIds,
          effectiveDate: req.body.effectiveDate ?? item.effectiveDate
        },
        { now: new Date(), excludePlanId: item.id }
      );
      if (!check.ok) return res.status(409).json({ error: check.error, conflicts: check.conflicts || [] });
      if (req.body.effectiveDate && req.body.effectiveDate !== item.effectiveDate) {
        item.history = item.history || [];
        item.history.unshift(stamp('调整生效日期', `${item.effectiveDate} → ${req.body.effectiveDate}，待执行方案已重排`));
      }
    }
  }

  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  if (collection === MERGE_COLLECTION) {
    db[MERGE_COLLECTION] = mergeDomain.reorderPending(db[MERGE_COLLECTION]);
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

// 查看某归并方案受影响的巡测记录
app.get('/api/site-merges/:id/affected', async (req, res) => {
  const db = await readDb();
  if (settleMerges(db)) await writeDb(db);
  const plan = (db[MERGE_COLLECTION] || []).find((entry) => entry.id === req.params.id);
  if (!plan) return res.status(404).json({ error: 'not found' });
  res.json(mergeDomain.affectedSurveys(db, plan));
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
