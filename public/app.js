const state = {
  config: null,
  db: {},
  activeTab: '',
  affected: {}
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), message.length > 40 ? 4200 : 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const mergedNote = item.mergedFromSiteId
    ? `<div class="meta">样点归并：原编号 ${escapeHtml(siteCode(item.mergedFromSiteId))}，本记录已写入保留样点（原编号仍可回查）</div>`
    : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${mergedNote}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

/* ---------- 样点归并（页面层，判断逻辑在 mergeDomain.js） ---------- */

function siteLabel(id) {
  const site = (state.db.sites || []).find((entry) => entry.id === id);
  if (!site) return id || '未知样点';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

function siteCode(id) {
  const site = (state.db.sites || []).find((entry) => entry.id === id);
  return site ? site.pointCode : id;
}

// 待生效方案占用的待并入样点 → 占用方案，用于表单禁用与提示
function pendingMergeBySite() {
  const map = {};
  for (const plan of state.db.siteMerges || []) {
    if (plan.status !== '待生效') continue;
    for (const siteId of plan.mergeSiteIds || []) map[siteId] = plan;
  }
  return map;
}

function mergeSiteOptions(selectedIds) {
  const occupied = pendingMergeBySite();
  return (state.db.sites || []).map((site) => {
    const holder = occupied[site.id];
    const selected = selectedIds.includes(site.id);
    const disabled = holder && !selected ? 'disabled' : '';
    const suffix = holder && !selected ? `（待并入方案 ${holder.effectiveDate} 生效）` : '';
    const label = [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
    return `<option value="${site.id}" ${selected ? 'selected' : ''} ${disabled}>${escapeHtml(label + suffix)}</option>`;
  }).join('');
}

function mergePlanText(plan) {
  return `保留 ${siteLabel(plan.keepSiteId)}；并入 ${(plan.mergeSiteIds || []).map(siteLabel).join('、')}；生效 ${plan.effectiveDate}；${plan.note || ''}`;
}

function renderMergeList(view) {
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db.siteMerges || [])];
  if (query) items = items.filter((plan) => mergePlanText(plan).includes(query));
  if (status) items = items.filter((plan) => plan.status === status);
  return items.length ? items.map(renderMergeCard).join('') : '<div class="empty">暂无归并方案</div>';
}

function affectedHtml(plan) {
  const data = state.affected[plan.id];
  if (!data) return '';
  if (!data.rows.length) return '<div class="empty">暂无受影响巡测</div>';
  const rows = data.rows.map((row) => {
    const where = row.route === 'redirected'
      ? `原 ${escapeHtml(row.originalCode)} → 已写入保留样点 ${escapeHtml(row.siteCode)}`
      : `原编号 ${escapeHtml(row.siteCode)}`;
    return `<div class="affected-row">
      <span>${escapeHtml(row.date || '-')}</span>
      <span>${escapeHtml(row.surveyor || '-')}</span>
      <span>${where}</span>
      ${pill(row.status, toneFor(row.status))}
    </div>`;
  }).join('');
  return `<div class="affected"><div class="meta">受影响巡测 ${data.total} 条 · 原编号 ${data.originalCodes.map(escapeHtml).join('、')} 仍可回查</div>${rows}</div>`;
}

function renderMergeCard(plan) {
  const pending = plan.status === '待生效';
  const mergeLabels = (plan.mergeSiteIds || []).map((id) => `<li>${escapeHtml(siteLabel(id))}</li>`).join('');
  const dateEditor = pending
    ? `<div class="date-edit"><input type="date" value="${escapeHtml(plan.effectiveDate)}" data-merge-date="${plan.id}"><button class="ghost" data-merge-save="${plan.id}">改期</button></div>`
    : '';
  return `<article class="card">
    <div class="card-head"><h3>保留 ${escapeHtml(siteLabel(plan.keepSiteId))}</h3>${pill(plan.status, toneFor(plan.status))}</div>
    <div class="meta">生效日期：${escapeHtml(plan.effectiveDate)}${plan.activatedAt ? ` · 生效于 ${fmtDate(plan.activatedAt)}` : ''}</div>
    <ul class="merge-list">${mergeLabels}</ul>
    ${plan.note ? `<p>${escapeHtml(plan.note)}</p>` : ''}
    ${dateEditor}
    <div class="actions">
      <button class="ghost" data-affected="${plan.id}">受影响巡测</button>
      ${pending ? `<button class="danger" data-action="merge-cancel" data-id="${plan.id}">撤销方案</button>` : ''}
    </div>
    ${affectedHtml(plan)}
    ${historyHtml(plan)}
  </article>`;
}

function renderMergeView(view) {
  const occupied = pendingMergeBySite();
  const keepOptions = (state.db.sites || []).map((site) => {
    const holder = occupied[site.id];
    const suffix = holder ? '（已被待生效方案占用）' : '';
    const label = [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
    return `<option value="${site.id}" ${holder ? 'disabled' : ''}>${escapeHtml(label + suffix)}</option>`;
  }).join('');
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-merge-form data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">
          <label class="wide">保留样点（归并后巡测写入此处）
            <select name="keepSiteId" required><option value="">请选择</option>${keepOptions}</select>
          </label>
          <fieldset class="wide merge-pick">
            <legend>待并入样点（每个样点同一时间只能出现在一个待生效方案中）</legend>
            <div class="merge-picked" id="merge-picked"></div>
            <select id="merge-pick"><option value="">选择样点加入…</option>${mergeSiteOptions([])}</select>
          </fieldset>
          <label>生效日期<input type="date" name="effectiveDate" required></label>
          <label>备注<input name="note" placeholder="判定依据、经办人"></label>
        </div>
        <div class="actions"><button>${escapeHtml(view.submitLabel)}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder)}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${(view.statusOptions || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderMergeList(view)}</div>
      </div>
    </div>
  </section>`;
}

function syncMergePicked() {
  const box = $('#merge-picked');
  if (!box) return;
  const ids = $$('input[name="mergeSiteIds"]', box).map((input) => input.value);
  $('#merge-pick').innerHTML = `<option value="">选择样点加入…</option>${mergeSiteOptions(ids)}`;
}

function addMergePick(siteId) {
  const box = $('#merge-picked');
  if (!box || !siteId) return;
  if ($$('input[name="mergeSiteIds"]', box).some((input) => input.value === siteId)) return;
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.innerHTML = `<input type="hidden" name="mergeSiteIds" value="${escapeHtml(siteId)}">${escapeHtml(siteLabel(siteId))}<button type="button" class="chip-x" aria-label="移除">×</button>`;
  $('.chip-x', chip).addEventListener('click', () => {
    chip.remove();
    syncMergePicked();
  });
  box.appendChild(chip);
  syncMergePicked();
}

async function toggleAffected(planId, container) {
  if (state.affected[planId]) {
    delete state.affected[planId];
  } else {
    state.affected[planId] = await api(`/api/site-merges/${planId}/affected`);
  }
  const view = state.config.views.find((entry) => entry.id === 'merges');
  container.innerHTML = renderMergeList(view);
}

async function saveMergeDate(planId, input) {
  const effectiveDate = input.value;
  if (!effectiveDate) return toast('请选择生效日期');
  try {
    await api(`/api/siteMerges/${planId}`, {
      method: 'PATCH',
      body: JSON.stringify({ effectiveDate, historyAction: '调整生效日期' })
    });
    await load();
    toast('生效日期已调整，待执行方案已重排');
  } catch (error) {
    toast(error.message);
  }
}

/* ---------- 渲染入口 ---------- */

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'merge') return renderMergeView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const affectedBtn = event.target.closest('[data-affected]');
  const mergeSave = event.target.closest('[data-merge-save]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (affectedBtn) {
    try {
      await toggleAffected(affectedBtn.dataset.affected, affectedBtn.closest('.list'));
    } catch (error) {
      toast(error.message);
    }
  }
  if (mergeSave) {
    const input = $(`input[data-merge-date="${mergeSave.dataset.mergeSave}"]`);
    if (input) await saveMergeDate(mergeSave.dataset.mergeSave, input);
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (!view) return;
  $(`#list-${view.id}`).innerHTML = view.type === 'merge' ? renderMergeList(view) : renderList(view);
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'merge-pick') {
    addMergePick(event.target.value);
    event.target.value = '';
  }
});

document.addEventListener('submit', async (event) => {
  const mergeForm = event.target.closest('[data-merge-form]');
  if (mergeForm) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(mergeForm).entries());
    payload.mergeSiteIds = new FormData(mergeForm).getAll('mergeSiteIds');
    // 页面预检与服务端校验共用同一份判断逻辑
    const precheck = window.MergeDomain?.validatePlan(state.db, payload, { now: new Date() });
    if (precheck && !precheck.ok) {
      toast(precheck.error);
      return;
    }
    try {
      await api('/api/siteMerges', { method: 'POST', body: JSON.stringify(payload) });
      await load();
      toast('归并方案已保存');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
