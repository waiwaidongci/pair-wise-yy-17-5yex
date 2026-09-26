// 样点归并的判断与存档逻辑。页面在 public/app.js，HTTP 路由在 server.js。

function todayStr(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function siteLabel(site) {
  if (!site) return '未知样点';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

function planName(plan) {
  return `「${plan.title || plan.id}」（生效日期 ${plan.effectiveDate}）`;
}

function mergeSiteIds(plan) {
  return Array.isArray(plan.mergeSiteIds) ? plan.mergeSiteIds : [];
}

function findPlanWithSite(db, siteId, status, excludePlanId) {
  return (db.merges || []).find((plan) =>
    plan.id !== excludePlanId &&
    plan.status === status &&
    mergeSiteIds(plan).includes(siteId)
  );
}

// 判断：校验一份归并方案能否保存，返回错误列表（空数组表示通过）
function validatePlan(db, input, excludePlanId) {
  const errors = [];
  const sites = db.sites || [];
  const keep = sites.find((site) => site.id === input.keepSiteId);
  if (!keep) {
    errors.push('保留样点不存在');
  } else {
    const mergedAway = findPlanWithSite(db, keep.id, '已生效', excludePlanId);
    if (mergedAway) errors.push(`保留样点 ${siteLabel(keep)} 已在 ${planName(mergedAway)} 中并入他处，不能作为保留样点`);
  }
  const ids = [...new Set((Array.isArray(input.mergeSiteIds) ? input.mergeSiteIds : []).filter(Boolean))];
  if (!ids.length) errors.push('至少选择一个待并入样点');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate || '')) errors.push('生效日期格式不正确');
  for (const id of ids) {
    const site = sites.find((entry) => entry.id === id);
    if (!site) {
      errors.push('待并入样点不存在');
      continue;
    }
    if (keep && id === keep.id) {
      errors.push(`待并入样点 ${siteLabel(site)} 与保留样点相同`);
      continue;
    }
    const occupying = findPlanWithSite(db, id, '待生效', excludePlanId);
    if (occupying) errors.push(`待并入样点 ${siteLabel(site)} 重复，已被 ${planName(occupying)} 占用`);
    const merged = findPlanWithSite(db, id, '已生效', excludePlanId);
    if (merged) errors.push(`待并入样点 ${siteLabel(site)} 已在 ${planName(merged)} 中生效归并`);
  }
  return errors;
}

// 存档：到期方案落为已生效，并给方案、样点补历史（已生效记录不再改动）
function activateDuePlans(db, today = todayStr()) {
  const activated = [];
  for (const plan of db.merges || []) {
    if (plan.status !== '待生效' || !plan.effectiveDate || plan.effectiveDate > today) continue;
    const at = new Date().toISOString();
    const keep = (db.sites || []).find((site) => site.id === plan.keepSiteId);
    plan.status = '已生效';
    plan.activatedAt = at;
    plan.updatedAt = at;
    plan.history = plan.history || [];
    plan.history.unshift({ at, action: '归并生效', note: `保留 ${keep?.pointCode || plan.keepSiteId}` });
    for (const siteId of mergeSiteIds(plan)) {
      const site = (db.sites || []).find((entry) => entry.id === siteId);
      if (!site) continue;
      site.mergedInto = plan.keepSiteId;
      site.updatedAt = at;
      site.history = site.history || [];
      site.history.unshift({ at, action: '样点归并', note: `并入 ${keep?.pointCode || plan.keepSiteId}，原编号保留可查` });
    }
    activated.push(plan);
  }
  return activated;
}

// 判断：新巡测应写入哪个样点（到期后写入保留样点，原编号留痕）
function resolveSurveySite(db, siteId) {
  const plan = (db.merges || []).find((entry) => entry.status === '已生效' && mergeSiteIds(entry).includes(siteId));
  if (!plan) return { redirected: false, siteId };
  const from = (db.sites || []).find((site) => site.id === siteId);
  return {
    redirected: true,
    siteId: plan.keepSiteId,
    originalSiteId: siteId,
    originalPointCode: from?.pointCode || '',
    planId: plan.id
  };
}

// 判断：方案影响了哪些巡测（旧记录挂在原样点上，新记录带原编号）
function affectedSurveys(db, plan) {
  const ids = mergeSiteIds(plan);
  return (db.surveys || []).filter((survey) => ids.includes(survey.siteId) || ids.includes(survey.originalSiteId));
}

// 存档顺序：待执行方案按生效日期先近后远，改动日期即重排；已生效按生效时间新到旧
function sortPlans(plans) {
  const rank = { '待生效': 0, '已生效': 1 };
  return [...(plans || [])].sort((a, b) => {
    const diff = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (diff) return diff;
    if (a.status === '待生效') return String(a.effectiveDate).localeCompare(String(b.effectiveDate));
    return String(b.activatedAt || b.updatedAt || '').localeCompare(String(a.activatedAt || a.updatedAt || ''));
  });
}

module.exports = {
  todayStr,
  siteLabel,
  validatePlan,
  activateDuePlans,
  resolveSurveySite,
  affectedSurveys,
  sortPlans,
  mergeSiteIds
};
