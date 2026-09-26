// 样点归并 · 判断层（纯逻辑，不读写数据，服务端与页面共用）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MergeDomain = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const MERGE_COLLECTION = 'siteMerges';

  function asDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function planLabel(plan, sites) {
    const keeper = (sites || []).find((site) => site.id === plan.keepSiteId);
    const code = keeper ? keeper.pointCode : plan.keepSiteId;
    return `${plan.id}（保留 ${code || '?'}，生效 ${plan.effectiveDate || '?'}）`;
  }

  // 校验归并方案：保留/并入样点合法、生效日期合法，
  // 且每个待并入样点在所有尚未生效的方案中只能出现一次。
  // now 可传 Date 或 ISO 字符串，便于测试与页面预检。
  function validatePlan(db, input, options = {}) {
    const sites = db.sites || [];
    const plans = db[MERGE_COLLECTION] || [];
    const keepSiteId = input.keepSiteId;
    const mergeSiteIds = Array.isArray(input.mergeSiteIds) ? input.mergeSiteIds.filter(Boolean) : [];
    const effectiveDate = input.effectiveDate;
    const now = asDate(options.now) || new Date();

    if (!keepSiteId) return { ok: false, error: '请选择保留样点' };
    if (keepSiteId === '__none__') return { ok: false, error: '保留样点已失效，请重新选择' };
    const keepSite = sites.find((site) => site.id === keepSiteId);
    if (!keepSite) return { ok: false, error: '保留样点不存在' };
    if (!mergeSiteIds.length) return { ok: false, error: '请至少选择一个待并入样点' };
    if (new Set(mergeSiteIds).size !== mergeSiteIds.length) {
      return { ok: false, error: '待并入样点重复选择，请检查' };
    }
    if (mergeSiteIds.includes(keepSiteId)) {
      return { ok: false, error: `待并入样点不能是保留样点（${keepSite.pointCode}）` };
    }
    for (const id of mergeSiteIds) {
      if (!sites.some((site) => site.id === id)) {
        return { ok: false, error: `待并入样点不存在：${id}` };
      }
    }
    if (!DATE_ONLY.test(effectiveDate || '')) {
      return { ok: false, error: '生效日期格式应为 YYYY-MM-DD' };
    }
    const eff = asDate(`${effectiveDate}T00:00:00`);
    if (!eff) return { ok: false, error: '生效日期无效' };
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (eff < today) return { ok: false, error: '生效日期不能早于今天' };

    // 占用检查：只看尚未生效的方案（生效日期 > 今天），已生效/已撤销的不挡；
    // excludePlanId 用于改期时排除方案自身
    const conflicts = [];
    for (const plan of plans) {
      if (plan.status !== '待生效') continue;
      if (options.excludePlanId && plan.id === options.excludePlanId) continue;
      const planEff = asDate(`${plan.effectiveDate}T00:00:00`);
      if (!planEff || planEff <= today) continue;
      const hit = (plan.mergeSiteIds || []).filter((id) => mergeSiteIds.includes(id));
      if (hit.length) conflicts.push({ planId: plan.id, planLabel: planLabel(plan, sites), mergeSiteIds: hit });
    }
    if (conflicts.length) {
      const codes = (id) => sites.find((site) => site.id === id)?.pointCode || id;
      const detail = conflicts
        .map((c) => `样点 ${c.mergeSiteIds.map(codes).join('、')} 已被方案 ${c.planLabel} 占用`)
        .join('；');
      return { ok: false, error: `待并入样点重复：${detail}`, conflicts };
    }
    return { ok: true };
  }

  // 登记巡测时解析目标样点：命中已生效方案则写入保留样点，并记录原编号。
  function resolveSurveySite(db, siteId, surveyDate) {
    const plans = db[MERGE_COLLECTION] || [];
    const date = surveyDate || new Date().toISOString().slice(0, 10);
    const hit = plans.find(
      (plan) => plan.status === '已生效' && (plan.mergeSiteIds || []).includes(siteId) && plan.effectiveDate <= date
    );
    if (!hit) return { siteId, merged: false };
    return { siteId: hit.keepSiteId, merged: true, originalSiteId: siteId, mergeId: hit.id };
  }

  // 按生效日期重排待执行方案（早的排前，同日按创建时间），已生效/已撤销记录不动。
  function reorderPending(plans) {
    const pending = plans
      .filter((plan) => plan.status === '待生效')
      .sort((a, b) => {
        const byDate = String(a.effectiveDate).localeCompare(String(b.effectiveDate));
        if (byDate !== 0) return byDate;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
    const rest = plans.filter((plan) => plan.status !== '待生效');
    return [...pending, ...rest];
  }

  // 到期方案结算：status 仍为「待生效」且生效日期 <= 参考日的置为「已生效」。
  // 返回变更说明列表，不改动 db。
  function settleDuePlans(db, referenceDate) {
    const plans = db[MERGE_COLLECTION] || [];
    const today = referenceDate || new Date().toISOString().slice(0, 10);
    const changes = [];
    for (const plan of plans) {
      if (plan.status === '待生效' && plan.effectiveDate <= today) {
        changes.push({ id: plan.id, from: '待生效', to: '已生效', effectiveDate: plan.effectiveDate });
      }
    }
    return changes;
  }

  // 查看受影响巡测：待生效方案按原样点查，已生效方案原编号 + 重定向后的新记录都算。
  function affectedSurveys(db, plan) {
    const surveys = db.surveys || [];
    const sites = db.sites || [];
    const codeOf = (id) => sites.find((site) => site.id === id)?.pointCode || id;
    const originals = plan.mergeSiteIds || [];
    const originalCodes = originals.map(codeOf);
    const rows = [];
    for (const survey of surveys) {
      const hitOriginal = originals.includes(survey.siteId);
      const hitMerged =
        plan.status === '已生效' &&
        survey.mergedFromSiteId &&
        originals.includes(survey.mergedFromSiteId) &&
        survey.siteId === plan.keepSiteId;
      if (!hitOriginal && !hitMerged) continue;
      rows.push({
        id: survey.id,
        date: survey.date,
        surveyor: survey.surveyor,
        status: survey.status,
        siteId: survey.siteId,
        siteCode: codeOf(survey.siteId),
        originalSiteId: hitMerged ? survey.mergedFromSiteId : null,
        originalCode: hitMerged ? codeOf(survey.mergedFromSiteId) : null,
        route: hitMerged ? 'redirected' : 'original'
      });
    }
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { total: rows.length, originalCodes, rows };
  }

  return { validatePlan, resolveSurveySite, reorderPending, settleDuePlans, affectedSurveys, planLabel };
});
