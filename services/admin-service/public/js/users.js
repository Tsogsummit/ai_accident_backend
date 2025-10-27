// Users Page Logic
// Load and manage user accounts

let usersData = [];
let pagination = null;
let currentFilters = {
  page: 1,
  limit: 50
};

// Initialize users page
async function initUsers() {
  if (!checkAuth()) return;
  
  initUserInfo();
  initLogoutButton();
  setActiveNav('users');

  // Initialize pagination
  pagination = new Pagination('pagination-container', {
    page: 1,
    totalPages: 1,
    onPageChange: (page) => {
      currentFilters.page = page;
      loadUsers();
    }
  });

  // Load users
  await loadUsers();
}

// Load users list
async function loadUsers() {
  showLoading('users-table-body');

  try {
    const params = {
      page: currentFilters.page,
      limit: currentFilters.limit
    };

    const result = await api.getUsers(params);

    if (result.success) {
      usersData = result.data;
      renderUsersTable(usersData);

      // Update pagination
      if (result.pagination) {
        pagination.update(result.pagination.page, result.pagination.totalPages);
      }
    } else {
      throw new Error(result.error || 'Failed to load users');
    }
  } catch (error) {
    console.error('Error loading users:', error);
    document.getElementById('users-table-body').innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="padding: 2rem; color: var(--danger);">
          <i class="fas fa-exclamation-circle" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
          <p>Хэрэглэгчийн мэдээлэл ачааллахад алдаа гарлаа</p>
        </td>
      </tr>
    `;
  }
}

// Render users table
function renderUsersTable(users) {
  const tbody = document.getElementById('users-table-body');

  if (!users || users.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center" style="padding: 2rem; color: var(--secondary);">
          <i class="fas fa-inbox" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
          <p>Хэрэглэгч олдсонгүй</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = users.map(user => `
    <tr>
      <td>${user.id}</td>
      <td>
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <div class="user-avatar" style="width: 36px; height: 36px; font-size: 0.9rem;">
            ${(user.name || 'U').charAt(0).toUpperCase()}
          </div>
          <div>
            <div style="font-weight: 600;">${escapeHtml(user.name || '-')}</div>
            <div style="font-size: 0.875rem; color: var(--secondary);">${user.phone || '-'}</div>
          </div>
        </div>
      </td>
      <td>${user.email || '-'}</td>
      <td>${getUserStatusBadge(user.status)}</td>
      <td>
        <div style="text-align: center;">
          <div style="font-weight: 600; color: var(--primary);">${user.total_reports || 0}</div>
          <div style="font-size: 0.75rem; color: var(--success);">✓ ${user.confirmed_reports || 0}</div>
        </div>
      </td>
      <td>${formatDate(user.created_at)}</td>
      <td>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-sm btn-primary" onclick="viewUserDetails(${user.id})" title="Дэлгэрэнгүй">
            <i class="fas fa-eye"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

// View user details
function viewUserDetails(id) {
  const user = usersData.find(u => u.id === id);
  if (!user) return;

  const modalHTML = `
    <div class="modal" id="user-modal" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center;">
      <div class="modal-content" style="background: white; padding: 2rem; border-radius: 12px; max-width: 600px; width: 90%; max-height: 90vh; overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
          <h3 style="margin: 0;">Хэрэглэгчийн дэлгэрэнгүй #${user.id}</h3>
          <button onclick="closeModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--secondary);">&times;</button>
        </div>
        
        <div style="text-align: center; margin-bottom: 1.5rem;">
          <div class="user-avatar" style="width: 80px; height: 80px; font-size: 2rem; margin: 0 auto 1rem;">
            ${(user.name || 'U').charAt(0).toUpperCase()}
          </div>
          <h4 style="margin: 0 0 0.5rem 0;">${escapeHtml(user.name || '-')}</h4>
          <p style="color: var(--secondary); margin: 0;">${user.phone || '-'}</p>
        </div>

        <table style="width: 100%; border-collapse: collapse;">
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600; width: 40%;">ID:</td>
            <td style="padding: 0.75rem;">${user.id}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Имэйл:</td>
            <td style="padding: 0.75rem;">${user.email || '-'}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Төлөв:</td>
            <td style="padding: 0.75rem;">${getUserStatusBadge(user.status)}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Эрх:</td>
            <td style="padding: 0.75rem;">${user.role === 'admin' ? 'Админ' : 'Хэрэглэгч'}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Нийт мэдээлэл:</td>
            <td style="padding: 0.75rem;">${user.total_reports || 0}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Баталгаажсан:</td>
            <td style="padding: 0.75rem;">${user.confirmed_reports || 0}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Худал мэдээлэл:</td>
            <td style="padding: 0.75rem;">${user.false_reports_made || 0}</td>
          </tr>
          <tr>
            <td style="padding: 0.75rem; font-weight: 600;">Бүртгэлсэн:</td>
            <td style="padding: 0.75rem;">${formatDateTime(user.created_at)}</td>
          </tr>
        </table>
        
        <div style="margin-top: 1.5rem; display: flex; gap: 0.5rem; justify-content: flex-end;">
          <button class="btn btn-secondary" onclick="closeModal()">Хаах</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// Close modal
function closeModal() {
  const modal = document.getElementById('user-modal');
  if (modal) {
    modal.remove();
  }
}

// Export users to CSV
function exportUsers() {
  if (!usersData || usersData.length === 0) {
    showToast('Экспортлох өгөгдөл байхгүй', 'warning');
    return;
  }

  const exportData = usersData.map(user => ({
    'ID': user.id,
    'Нэр': user.name || '',
    'Утас': user.phone || '',
    'Имэйл': user.email || '',
    'Төлөв': user.status,
    'Эрх': user.role,
    'Нийт мэдээлэл': user.total_reports || 0,
    'Баталгаажсан': user.confirmed_reports || 0,
    'Худал мэдээлэл': user.false_reports_made || 0,
    'Бүртгэлсэн': formatDateTime(user.created_at)
  }));

  const filename = `users_${formatDate(new Date())}.csv`;
  exportToCSV(exportData, filename);
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initUsers);

// Export functions
window.initUsers = initUsers;
window.viewUserDetails = viewUserDetails;
window.closeModal = closeModal;
window.exportUsers = exportUsers;