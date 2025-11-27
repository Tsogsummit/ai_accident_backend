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

function renderStats(data) {
  document.getElementById('active-accidents').textContent = formatNumber(data.accidents.active);
  document.getElementById('total-users').textContent = formatNumber(data.users.total);
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