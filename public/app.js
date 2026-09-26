const state = {
  config: null,
  db: {},
  activeTab: ''
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
  setTimeout(() => el.classList.remove('show'), 1800);
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
    items = items.filter((item) =>
      view.searchFields.some((field) => String(item[field] || '').includes(query)) ||
      (view.relation && relationLabel(view.relation, item[view.relation.localKey]).includes(query))
    );
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

function findSite(id) {
  return (state.db.sites || []).find((site) => site.id === id);
}

function siteLabel(site) {
  return site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '未知样点';
}

function renderMergeCard(plan) {
  const mergeIds = plan.mergeSiteIds || [];
  const mergedLabels = mergeIds.map((id) => siteLabel(findSite(id)));
  const affectedCount = (state.db.surveys || []).filter((survey) =>
    mergeIds.includes(survey.siteId) || mergeIds.includes(survey.originalSiteId)
  ).length;
  const pending = plan.status === '待生效';
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(plan.title || '归并方案')}</h3>${pill(plan.status, toneFor(plan.status))}</div>
    <div class="meta">保留样点：${escapeHtml(siteLabel(findSite(plan.keepSiteId)))}</div>
    <div class="meta">待并入样点：${mergedLabels.map(escapeHtml).join('；') || '-'}</div>
    ${plan.note ? `<p>${escapeHtml(plan.note)}</p>` : ''}
    <div class="detail">
      <div>生效日期<br><strong>${escapeHtml(plan.effectiveDate || '-')}</strong></div>
      <div>受影响巡测<br><strong>${affectedCount}</strong></div>
      <div>并入数量<br><strong>${mergeIds.length}</strong></div>
    </div>
    <div class="actions">
      <button class="ghost" data-affected="${plan.id}">查看受影响巡测</button>
      ${pending ? `<input type="date" id="reschedule-${plan.id}" value="${escapeHtml(plan.effectiveDate || '')}"><button class="ghost" data-reschedule="${plan.id}">调整日期</button><button class="danger" data-merge-delete="${plan.id}">撤销方案</button>` : ''}
    </div>
    <div class="affected" id="affected-${plan.id}" hidden></div>
    ${historyHtml(plan)}
  </article>`;
}

function renderMergeView(view) {
  const sites = state.db.sites || [];
  const plans = state.db.merges || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-merge-form>
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">
          <label class="wide">保留样点<select name="keepSiteId" required>${optionList(sites, ['cave', 'zone', 'pointCode'])}</select></label>
          <div class="wide merge-sites">
            <span>待并入样点</span>
            <div class="check-list">${sites.map((site) => `<label class="check"><input type="checkbox" name="mergeSiteIds" value="${site.id}">${escapeHtml(siteLabel(site))}</label>`).join('')}</div>
          </div>
          <label class="wide">生效日期<input type="date" name="effectiveDate" required></label>
          <label class="wide">备注<textarea name="note" placeholder="判定依据、口头结论来源等"></textarea></label>
        </div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存方案')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <p class="meta">待执行方案按生效日期先近后远排列；到期后新巡测自动写入保留样点，旧记录仍按原编号查。</p>
        <div class="list" id="list-merges">${plans.length ? plans.map(renderMergeCard).join('') : '<div class="empty">暂无归并方案</div>'}</div>
      </div>
    </div>
  </section>`;
}

async function toggleAffected(planId) {
  const box = $(`#affected-${planId}`);
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  const list = await api(`/api/merges/${planId}/affected`);
  box.innerHTML = list.length ? list.map((survey) => {
    const origin = survey.originalPointCode ? `原编号 ${survey.originalPointCode} → ` : '';
    return `<div class="affected-item"><span>${escapeHtml(survey.date)} · ${escapeHtml(survey.surveyor)}</span><span>${escapeHtml(origin + siteLabel(findSite(survey.siteId)))} · ${escapeHtml(survey.status)}</span></div>`;
  }).join('') : '<div class="empty">暂无受影响巡测</div>';
  box.hidden = false;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'merges') return renderMergeView(view);
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
  const rescheduleBtn = event.target.closest('[data-reschedule]');
  const mergeDeleteBtn = event.target.closest('[data-merge-delete]');
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
      await toggleAffected(affectedBtn.dataset.affected);
    } catch (error) {
      toast(error.message);
    }
  }
  if (rescheduleBtn) {
    const id = rescheduleBtn.dataset.reschedule;
    const effectiveDate = $(`#reschedule-${id}`)?.value;
    try {
      await api(`/api/merges/${id}/reschedule`, { method: 'POST', body: JSON.stringify({ effectiveDate }) });
      await load();
      toast('生效日期已调整，待执行方案已重排');
    } catch (error) {
      toast(error.message);
    }
  }
  if (mergeDeleteBtn) {
    if (!confirm('撤销该归并方案？撤销后待并入样点可被其他方案使用。')) return;
    try {
      await api(`/api/merges/${mergeDeleteBtn.dataset.mergeDelete}`, { method: 'DELETE' });
      await load();
      toast('方案已撤销');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const mergeForm = event.target.closest('[data-merge-form]');
  if (mergeForm) {
    event.preventDefault();
    const data = new FormData(mergeForm);
    const payload = {
      keepSiteId: data.get('keepSiteId'),
      mergeSiteIds: data.getAll('mergeSiteIds'),
      effectiveDate: data.get('effectiveDate'),
      note: data.get('note') || ''
    };
    try {
      await api('/api/merges', { method: 'POST', body: JSON.stringify(payload) });
      mergeForm.reset();
      await load();
      toast('方案已保存');
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
