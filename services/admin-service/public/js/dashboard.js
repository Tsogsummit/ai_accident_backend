let statsData = null;
let refreshInterval = null;

async function initDashboard() {
  if (!checkAuth()) return;
  initUserInfo();
  initLogoutButton();
  startSessionCheck();
  await loadDashboardStats();
  refreshInterval = setInterval(loadDashboardStats, 30000);
  setActiveNav('dashboard');
}

async function loadDashboardStats() {
  try {
    const result = await api.getDashboardStats();
    if (result.success) {
      statsData = result.data;
      renderStats(statsData);
    } else {
      showToast('Статистик ачааллахад алдаа гарлаа', 'danger');
    }
  } catch (error) {
    showToast('Статистик ачааллахад алдаа гарлаа', 'danger');
  }
}

async function renderStats(data) {
  // Үндсэн статистик
  document.getElementById('active-accidents').textContent = formatNumber(data.accidents.active);
  document.getElementById('total-users').textContent = formatNumber(data.users.total);

  // Нэмэлт статистик - баталгаажсан болон хуурмаг мэдээлэл
  try {
    const accidentsResult = await api.getAccidents();
    const accidents = accidentsResult.data || [];

    const confirmed = accidents.filter(a => a.status === 'confirmed').length;
    const falseReports = accidents.filter(a => a.status === 'false_alarm').length;

    document.getElementById('confirmed-accidents').textContent = formatNumber(confirmed);
    document.getElementById('false-reports').textContent = formatNumber(falseReports);

    // Өнөөдрийн статистик
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayAccidents = accidents.filter(a => {
      const accDate = new Date(a.accident_time);
      accDate.setHours(0, 0, 0, 0);
      return accDate.getTime() === today.getTime();
    });

    const todayReported = todayAccidents.filter(a => a.status === 'reported').length;
    const todayConfirmed = todayAccidents.filter(a => a.status === 'confirmed').length;
    const todayFalse = todayAccidents.filter(a => a.status === 'false_alarm').length;

    document.getElementById('today-reports').textContent = formatNumber(todayReported);
    document.getElementById('today-confirmed').textContent = formatNumber(todayConfirmed);
    document.getElementById('today-false').textContent = formatNumber(todayFalse);

    // Өнөөдрийн идэвхтэй хэрэглэгчид (өнөөдөр осол мэдээлсэн)
    const uniqueUsers = new Set(todayAccidents.map(a => a.user_id).filter(Boolean));
    document.getElementById('today-users').textContent = formatNumber(uniqueUsers.size);

  } catch (error) {
    console.error('Error loading additional stats:', error);
  }

  document.getElementById('last-refresh').textContent = `Сүүлд шинэчилсэн: ${formatTime(new Date())}`;
}

async function handleRefresh() {
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }
  await loadDashboardStats();
  if (refreshBtn) {
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
  }
  showToast('Мэдээлэл шинэчлэгдлээ', 'success');
}

window.addEventListener('beforeunload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});

document.addEventListener('DOMContentLoaded', initDashboard);
window.initDashboard = initDashboard;
window.loadDashboardStats = loadDashboardStats;
window.handleRefresh = handleRefresh;