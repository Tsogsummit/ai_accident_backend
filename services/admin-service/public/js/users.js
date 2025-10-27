// Users Logic
let usersData = [];
let pagination = null;
let currentFilters = { page: 1, limit: 50 };

async function initUsers() {
  if (!checkAuth()) return;
  initUserInfo();
  initLogoutButton();
  setActiveNav('users');

  pagination = new Pagination('pagination-container', {
    page: 1, totalPages: 1,
    onPageChange: (page) => {
      currentFilters.page = page;
      loadUsers();
    }
  });

  await loadUsers();
}

async function loadUsers() {
  showLoading('users-table-body');
  try {
    const result = await api.getUsers(currentFilters);
    if (result.success) {
      usersData = result.data;
      renderUsersTable(usersData);
      if (result.pagination) pagination.update(result.pagination.page, result.pagination.totalPages);
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    document.getElementById('users-table-body').innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 2rem; color: var(--danger);"><i class="fas fa-exclamation-circle" style="font-size: 2rem;"></i><p>Хэрэглэгчийн мэдээлэл ачааллахад алдаа гарлаа</p></td></tr>';
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('users-table-body');
  if (!users || !users.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 2rem;"><i class="fas fa-inbox" style="font-size: 2rem;"></i><p>Хэрэглэгч олдсонгүй</p></td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.id}</td>
      <td><div style="display: flex; align-items: center; gap: 0.75rem;">
        <div class="user-avatar" style="width: 36px; height: 36px; font-size: 0.9rem;">${(u.name || 'U').charAt(0).toUpperCase()}</div>
        <div><div style="font-weight: 600;">${escapeHtml(u.name || '-')}</div><div style="font-size: 0.875rem; color: var(--secondary);">${u.phone || '-'}</div></div>
      </div></td>
      <td>${u.email || '-'}</td>
      <td>${getUserStatusBadge(u.status)}</td>
      <td><div style="text-align: center;"><div style="font-weight: 600; color: var(--primary);">${u.total_reports || 0}</div><div style="font-size: 0.75rem; color: var(--success);">✓ ${u.confirmed_reports || 0}</div></div></td>
      <td>${formatDate(u.created_at)}</td>
      <td><button class="btn btn-sm btn-primary" onclick="viewUserDetails(${u.id})"><i class="fas fa-eye"></i></button></td>
    </tr>
  `).join('');
}

function viewUserDetails(id) {
  const u = usersData.find(x => x.id === id);
  if (!u) return;
  alert(`Хэрэглэгч #${u.id}\nНэр: ${u.name}\nУтас: ${u.phone}\nИмэйл: ${u.email || '-'}\nМэдээлэл: ${u.total_reports || 0}`);
}

function exportUsers() {
  if (!usersData || !usersData.length) {
    showToast('Өгөгдөл байхгүй', 'warning');
    return;
  }
  const exportData = usersData.map(u => ({
    'ID': u.id,
    'Нэр': u.name || '',
    'Утас': u.phone || '',
    'Имэйл': u.email || '',
    'Төлөв': u.status
  }));
  exportToCSV(exportData, `users_${formatDate(new Date())}.csv`);
}

document.addEventListener('DOMContentLoaded', initUsers);
window.initUsers = initUsers;
window.viewUserDetails = viewUserDetails;
window.exportUsers = exportUsers;
