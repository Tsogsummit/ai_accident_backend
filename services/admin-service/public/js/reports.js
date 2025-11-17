let reportFilters = {
  startDate: null,
  endDate: null,
};

async function initReportsPage() {
  if (!checkAuth()) return;

  initUserInfo();
  initLogoutButton();
  startSessionCheck();
  setActiveNav('reports');

  initFilterDefaults();
  bindReportEvents();
  await loadReportsData();
}

function initFilterDefaults() {
  const endInput = document.getElementById('end-date');
  const startInput = document.getElementById('start-date');
  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - 29);

  endInput.value = formatInputDate(today);
  startInput.value = formatInputDate(start);

  reportFilters.startDate = startInput.value;
  reportFilters.endDate = endInput.value;

  updatePeriodLabel();
}

function bindReportEvents() {
  document.getElementById('apply-filter-btn')?.addEventListener('click', () => {
    if (updateFiltersFromInputs()) {
      loadReportsData();
    }
  });

  document.getElementById('refresh-reports')?.addEventListener('click', () => {
    loadReportsData();
    showToast('Тайлан шинэчлэгдлээ', 'success');
  });

  document.querySelectorAll('[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-range]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyQuickRange(parseInt(btn.dataset.range, 10));
    });
  });

  document.querySelectorAll('[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => handleReportExport(btn.dataset.export));
  });
}

function applyQuickRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));

  document.getElementById('start-date').value = formatInputDate(start);
  document.getElementById('end-date').value = formatInputDate(end);

  if (updateFiltersFromInputs()) {
    loadReportsData();
  }
}

function updateFiltersFromInputs() {
  const start = document.getElementById('start-date').value;
  const end = document.getElementById('end-date').value;

  if (!start || !end) {
    showToast('Огноо бүрэн оруулна уу', 'warning');
    return false;
  }

  if (new Date(start) > new Date(end)) {
    showToast('Эхлэх огноо дуусах огнооноос хойш байж болохгүй', 'danger');
    return false;
  }

  reportFilters.startDate = start;
  reportFilters.endDate = end;
  updatePeriodLabel();
  return true;
}

function updatePeriodLabel() {
  const label = document.getElementById('selected-period');
  if (!label) return;
  if (!reportFilters.startDate || !reportFilters.endDate) {
    label.textContent = '--';
    return;
  }
  label.textContent = `Хугацаа: ${reportFilters.startDate} - ${reportFilters.endDate}`;
}

async function loadReportsData() {
  if (!reportFilters.startDate || !reportFilters.endDate) return;

  setSectionsLoading();

  try {
    const [statsRes, userRes, aiRes] = await Promise.all([
      api.getReportStatistics(reportFilters),
      api.getReportUserActivity({ limit: 8 }),
      api.getReportAiAccuracy(reportFilters),
    ]);

    if (statsRes.success) {
      renderSummary(statsRes.data);
      renderBreakdowns(statsRes.data);
      renderDailyStats(statsRes.data.dailyStats);
      renderTopLocations(statsRes.data.topLocations);
      renderCameraStats(statsRes.data.cameraStats);
    } else {
      throw new Error(statsRes.error || 'Тайлангийн өгөгдөл олдсонгүй');
    }

    if (userRes.success) {
      renderUserActivity(userRes.data);
    } else {
      renderUserActivity([]);
    }

    if (aiRes.success) {
      renderAiSummary(aiRes.data);
    } else {
      renderAiSummary(null);
    }
  } catch (error) {
    console.error('Report load error:', error);
    showToast(error.message || 'Тайлан ачааллахад алдаа гарлаа', 'danger');
    renderErrorState();
  }
}

function setSectionsLoading() {
  document.getElementById('severity-list').innerHTML = '<li>Ачааллаж байна...</li>';
  document.getElementById('status-list').innerHTML = '<li>Ачааллаж байна...</li>';
  document.getElementById('source-list').innerHTML = '<li>Ачааллаж байна...</li>';

  setTableLoading('daily-stats-body', 5);
  setTableLoading('top-locations-body', 3);
  setTableLoading('camera-stats-body', 3);
  setTableLoading('user-activity-body', 4);

  const aiSummary = document.getElementById('ai-accuracy-summary');
  if (aiSummary) {
    aiSummary.innerHTML = '<div class="loading"><div class="spinner"></div><p>Ачааллаж байна...</p></div>';
  }
}

function setTableLoading(id, colspan) {
  const el = document.getElementById(id);
  if (el) {
    el.innerHTML = `<tr><td colspan="${colspan}" class="text-center">Ачааллаж байна...</td></tr>`;
  }
}

function renderSummary(data) {
  const total = data.summary?.totalAccidents || 0;
  const severe = data.summary?.bySeverity?.severe || 0;
  const confirmed = data.summary?.byStatus?.confirmed || 0;
  const falseAlarm = data.summary?.byStatus?.false_alarm || 0;

  document.getElementById('summary-total').textContent = formatNumber(total);
  document.getElementById('summary-severe').textContent = formatNumber(severe);
  document.getElementById('summary-confirmed').textContent = formatNumber(confirmed);
  document.getElementById('summary-false').textContent = formatNumber(falseAlarm);
}

function renderBreakdowns(data) {
  const severityList = document.getElementById('severity-list');
  const statusList = document.getElementById('status-list');
  const sourceList = document.getElementById('source-list');

  severityList.innerHTML = buildListHtml(data.summary?.bySeverity);
  statusList.innerHTML = buildListHtml(data.summary?.byStatus, true);
  sourceList.innerHTML = buildListHtml(data.summary?.bySource);
}

function buildListHtml(obj = {}, showBadge = false) {
  const entries = Object.entries(obj);
  if (!entries.length) {
    return '<li>Өгөгдөл байхгүй</li>';
  }
  return entries
    .map(([key, value]) => {
      const label = translateKey(key);
      const badge = showBadge ? getStatusBadge(key) : '';
      return `<li><span>${label}</span><span>${badge || formatNumber(value)}</span></li>`;
    })
    .join('');
}

function translateKey(key) {
  const map = {
    severe: 'Хүнд',
    moderate: 'Дунд',
    minor: 'Хөнгөн',
    reported: 'Мэдээлсэн',
    confirmed: 'Баталгаажсан',
    resolved: 'Шийдвэрлэгдсэн',
    false_alarm: 'Худал',
    user: 'Хэрэглэгч',
    camera: 'Камер',
    ai: 'AI',
  };
  return map[key] || key || '-';
}

function renderDailyStats(rows = []) {
  const body = document.getElementById('daily-stats-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="text-center">Өгөгдөл байхгүй</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${formatDate(row.date)}</td>
        <td>${formatNumber(row.total)}</td>
        <td>${formatNumber(row.severe)}</td>
        <td>${formatNumber(row.moderate)}</td>
        <td>${formatNumber(row.minor)}</td>
      </tr>
    `
    )
    .join('');
}

function renderTopLocations(rows = []) {
  const body = document.getElementById('top-locations-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="3" class="text-center">Өгөгдөл байхгүй</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map(
      (row, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${row.lat}, ${row.lng}</td>
        <td>${formatNumber(row.count)}</td>
      </tr>
    `
    )
    .join('');
}

function renderCameraStats(rows = []) {
  const body = document.getElementById('camera-stats-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="3" class="text-center">Өгөгдөл байхгүй</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${row.name}</td>
        <td>${formatNumber(row.accident_count)}</td>
        <td>${formatNumber(row.recent_accidents)}</td>
      </tr>
    `
    )
    .join('');
}

function renderUserActivity(rows = []) {
  const body = document.getElementById('user-activity-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="text-center">Өгөгдөл байхгүй</td></tr>';
    return;
  }

  body.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${row.name || row.phone || '-'}</td>
        <td>${formatNumber(row.total_reports)}</td>
        <td>${formatNumber(row.confirmed_reports)}</td>
        <td>${formatNumber(row.false_alarms)}</td>
      </tr>
    `
    )
    .join('');
}

function renderAiSummary(data) {
  const container = document.getElementById('ai-accuracy-summary');
  if (!container) return;

  if (!data) {
    container.innerHTML = '<p class="text-center" style="color: var(--secondary);">AI тайлан олдсонгүй</p>';
    return;
  }

  container.innerHTML = `
    <div class="ai-summary-row"><span>Нийт боловсруулсан</span><strong>${formatNumber(data.processing.totalVideos || 0)}</strong></div>
    <div class="ai-summary-row"><span>Өндөр итгэлцүүр</span><strong>${formatNumber(data.processing.highConfidence || 0)}</strong></div>
    <div class="ai-summary-row"><span>Дунд итгэлцүүр</span><strong>${formatNumber(data.processing.mediumConfidence || 0)}</strong></div>
    <div class="ai-summary-row"><span>Бага итгэлцүүр</span><strong>${formatNumber(data.processing.lowConfidence || 0)}</strong></div>
    <div class="ai-summary-row"><span>Дундаж confidence</span><strong>${Number(data.confidence.average || 0).toFixed(2)}</strong></div>
    <div class="ai-summary-row"><span>Баталгаажсан осол</span><strong>${formatNumber(data.detection.confirmed || 0)}</strong></div>
    <div class="ai-summary-row"><span>Худал осол</span><strong>${formatNumber(data.detection.falseAlarms || 0)}</strong></div>
    <div class="ai-summary-row"><span>Нарийвчлал</span><strong>${data.detection.accuracy || '0%'}</strong></div>
  `;
}

function renderErrorState() {
  ['daily-stats-body', 'top-locations-body', 'camera-stats-body', 'user-activity-body'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      const colspan = id === 'daily-stats-body' ? 5 : id === 'user-activity-body' ? 4 : 3;
      el.innerHTML = `<tr><td colspan="${colspan}" class="text-center">Өгөгдөл ачааллахад алдаа гарлаа</td></tr>`;
    }
  });
  const aiSummary = document.getElementById('ai-accuracy-summary');
  if (aiSummary) {
    aiSummary.innerHTML = '<p class="text-center" style="color: var(--danger);">AI тайлан ачаалагдсангүй</p>';
  }
}

function formatInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function handleReportExport(type) {
  try {
    const params = new URLSearchParams({
      type,
      startDate: reportFilters.startDate,
      endDate: reportFilters.endDate,
    });

    const response = await fetch(`/admin/reports/export?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${api.token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error || 'Тайлан татахад алдаа гарлаа');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    const contentDisposition = response.headers.get('Content-Disposition');
    const filename = contentDisposition
      ? contentDisposition.split('filename=')[1]?.replace(/"/g, '') || 'report.csv'
      : 'report.csv';

    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    showToast('Тайлан татагдлаа', 'success');
  } catch (error) {
    console.error('Export error:', error);
    showToast(error.message || 'Тайлан татахад алдаа гарлаа', 'danger');
  }
}

document.addEventListener('DOMContentLoaded', initReportsPage);
window.initReportsPage = initReportsPage;

