// Dashboard Page Logic
// Load and display dashboard statistics and charts

let statsData = null;
let refreshInterval = null;

// Initialize dashboard
async function initDashboard() {
  // Check authentication
  if (!checkAuth()) return;

  // Initialize user info
  initUserInfo();
  initLogoutButton();
  startSessionCheck();

  // Load dashboard data
  await loadDashboardStats();

  // Set up auto-refresh (every 30 seconds)
  refreshInterval = setInterval(loadDashboardStats, 30000);

  // Set active nav item
  setActiveNav('dashboard');
}

// Load dashboard statistics
async function loadDashboardStats() {
  try {
    const result = await api.getDashboardStats();

    if (result.success) {
      statsData = result.data;
      renderStats(statsData);
    } else {
      console.error('Failed to load stats:', result.error);
      showToast('Статистик ачааллахад алдаа гарлаа', 'danger');
    }
  } catch (error) {
    console.error('Error loading stats:', error);
    showToast('Статистик ачааллахад алдаа гарлаа', 'danger');
  }
}

// Render statistics
function renderStats(data) {
  // Accidents stats
  document.getElementById('total-accidents').textContent = formatNumber(data.accidents.total);
  document.getElementById('active-accidents').textContent = formatNumber(data.accidents.active);
  document.getElementById('today-accidents').textContent = formatNumber(data.accidents.today);

  // Users stats
  document.getElementById('total-users').textContent = formatNumber(data.users.total);
  document.getElementById('active-users').textContent = formatNumber(data.users.active);

  // Cameras stats
  document.getElementById('total-cameras').textContent = formatNumber(data.cameras.total);
  document.getElementById('online-cameras').textContent = formatNumber(data.cameras.online);

  // Videos stats
  document.getElementById('total-videos').textContent = formatNumber(data.videos.total);
  document.getElementById('pending-videos').textContent = formatNumber(data.videos.pending);

  // AI stats
  document.getElementById('ai-accuracy').textContent = data.ai.accuracy;
  document.getElementById('ai-confidence').textContent = data.ai.avgConfidence;

  // Update last refresh time
  const now = new Date();
  document.getElementById('last-refresh').textContent = `Сүүлд шинэчилсэн: ${formatTime(now)}`;
}

// Set active navigation item
function setActiveNav(page) {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });

  const activeLink = document.querySelector(`[data-page="${page}"]`);
  if (activeLink) {
    activeLink.classList.add('active');
  }
}

// Manual refresh handler
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

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initDashboard);

// Export functions
window.initDashboard = initDashboard;
window.loadDashboardStats = loadDashboardStats;
window.handleRefresh = handleRefresh;