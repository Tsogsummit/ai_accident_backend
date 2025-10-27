// Accidents Page Logic
// Load and manage accident reports

let accidentsData = [];
let pagination = null;
let currentFilters = {
  page: 1,
  limit: 50,
  status: '',
  severity: '',
  source: ''
};

// Initialize accidents page
async function initAccidents() {
  if (!checkAuth()) return;
  
  initUserInfo();
  initLogoutButton();
  setActiveNav('accidents');

  // Initialize pagination
  pagination = new Pagination('pagination-container', {
    page: 1,
    totalPages: 1,
    onPageChange: (page) => {
      currentFilters.page = page;
      loadAccidents();
    }
  });

  // Setup filter handlers
  setupFilters();

  // Load accidents
  await loadAccidents();
}

// Setup filter event handlers
function setupFilters() {
  const statusFilter = document.getElementById('status-filter');
  const severityFilter = document.getElementById('severity-filter');
  const sourceFilter = document.getElementById('source-filter');

  if (statusFilter) {
    statusFilter.addEventListener('change', (e) => {
      currentFilters.status = e.target.value;
      currentFilters.page = 1;
      loadAccidents();
    });
  }

  if (severityFilter) {
    severityFilter.addEventListener('change', (e) => {
      currentFilters.severity = e.target.value;
      currentFilters.page = 1;
      loadAccidents();
    });
  }

  if (sourceFilter) {
    sourceFilter.addEventListener('change', (e) => {
      currentFilters.source = e.target.value;
      currentFilters.page = 1;
      loadAccidents();
    });
  }
}

// Load accidents list
async function loadAccidents() {
  showLoading('accidents-table-body');

  try {
    const params = {};
    if (currentFilters.status) params.status = currentFilters.status;
    if (currentFilters.severity) params.severity = currentFilters.severity;
    if (currentFilters.source) params.source = currentFilters.source;
    params.page = currentFilters.page;
    params.limit = currentFilters.limit;

    const result = await api.getAccidents(params);

    if (result.success) {
      accidentsData = result.data;
      renderAccidentsTable(accidentsData);

      // Update pagination
      if (result.pagination) {
        pagination.update(result.pagination.page, result.pagination.totalPages);
      }
    } else {
      throw new Error(result.error || 'Failed to load accidents');
    }
  } catch (error) {
    console.error('Error loading accidents:', error);
    document.getElementById('accidents-table-body').innerHTML = `
      <tr>
        <td colspan="9" class="text-center" style="padding: 2rem; color: var(--danger);">
          <i class="fas fa-exclamation-circle" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
          <p>Ослын мэдээлэл ачааллахад алдаа гарлаа</p>
        </td>
      </tr>
    `;
  }
}

// Render accidents table
function renderAccidentsTable(accidents) {
  const tbody = document.getElementById('accidents-table-body');

  if (!accidents || accidents.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="text-center" style="padding: 2rem; color: var(--secondary);">
          <i class="fas fa-inbox" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
          <p>Осол олдсонгүй</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = accidents.map(accident => `
    <tr>
      <td>${accident.id}</td>
      <td>${formatDateTime(accident.accident_time)}</td>
      <td>
        <a href="${getMapLink(accident.latitude, accident.longitude)}" target="_blank" title="Газрын зураг дээр харах">
          ${formatCoordinates(accident.latitude, accident.longitude)}
          <i class="fas fa-external-link-alt" style="font-size: 0.75rem; margin-left: 0.25rem;"></i>
        </a>
      </td>
      <td>${getSeverityBadge(accident.severity)}</td>
      <td>${getStatusBadge(accident.status)}</td>
      <td>${truncate(accident.description || '-', 50)}</td>
      <td>${accident.reported_by_name || '-'}</td>
      <td>${accident.camera_name || '-'}</td>
      <td>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-sm btn-primary" onclick="viewAccidentDetails(${accident.id})" title="Дэлгэрэнгүй">
            <i class="fas fa-eye"></i>
          </button>
          ${accident.status !== 'resolved' ? `
            <button class="btn btn-sm btn-success" onclick="updateAccidentStatus(${accident.id}, 'resolved')" title="Шийдэгдсэн">
              <i class="fas fa-check"></i>
            </button>
          ` : ''}
          ${accident.status !== 'false_alarm' ? `
            <button class="btn btn-sm btn-warning" onclick="updateAccidentStatus(${accident.id}, 'false_alarm')" title="Худал">
              <i class="fas fa-times"></i>
            </button>
          ` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

// View accident details
function viewAccidentDetails(id) {
  const accident = accidentsData.find(a => a.id === id);
  if (!accident) return;

  // Create modal content
  const modalHTML = `
    <div class="modal" id="accident-modal" style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center;">
      <div class="modal-content" style="background: white; padding: 2rem; border-radius: 12px; max-width: 600px; width: 90%; max-height: 90vh; overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
          <h3 style="margin: 0;">Ослын дэлгэрэнгүй #${accident.id}</h3>
          <button onclick="closeModal()" style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--secondary);">&times;</button>
        </div>
        
        <table style="width: 100%; border-collapse: collapse;">
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600; width: 40%;">ID:</td>
            <td style="padding: 0.75rem;">${accident.id}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Огноо цаг:</td>
            <td style="padding: 0.75rem;">${formatDateTime(accident.accident_time)}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Байршил:</td>
            <td style="padding: 0.75rem;">
              <a href="${getMapLink(accident.latitude, accident.longitude)}" target="_blank">
                ${formatCoordinates(accident.latitude, accident.longitude)}
                <i class="fas fa-external-link-alt" style="font-size: 0.75rem;"></i>
              </a>
            </td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Хүнд байдал:</td>
            <td style="padding: 0.75rem;">${getSeverityBadge(accident.severity)}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Төлөв:</td>
            <td style="padding: 0.75rem;">${getStatusBadge(accident.status)}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Тайлбар:</td>
            <td style="padding: 0.75rem;">${accident.description || '-'}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Мэдээлсэн:</td>
            <td style="padding: 0.75rem;">${accident.reported_by_name || '-'}<br><small>${accident.reported_by_phone || ''}</small></td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Камер:</td>
            <td style="padding: 0.75rem;">${accident.camera_name || '-'}</td>
          </tr>
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">Эх үүсвэр:</td>
            <td style="padding: 0.75rem;">${accident.source === 'user' ? 'Хэрэглэгч' : 'Камер'}</td>
          </tr>
          ${accident.avg_confidence ? `
          <tr style="border-bottom: 1px solid var(--border);">
            <td style="padding: 0.75rem; font-weight: 600;">AI итгэлцүүр:</td>
            <td style="padding: 0.75rem;">${(accident.avg_confidence * 100).toFixed(1)}%</td>
          </tr>
          ` : ''}
          <tr>
            <td style="padding: 0.75rem; font-weight: 600;">Худал мэдээлэл:</td>
            <td style="padding: 0.75rem;">${accident.false_report_count || 0}</td>
          </tr>
        </table>
        
        <div style="margin-top: 1.5rem; display: flex; gap: 0.5rem; justify-content: flex-end;">
          <button class="btn btn-secondary" onclick="closeModal()">Хаах</button>
          ${accident.status !== 'resolved' ? `
            <button class="btn btn-success" onclick="updateAccidentStatus(${accident.id}, 'resolved'); closeModal();">
              <i class="fas fa-check"></i> Шийдэгдсэн
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// Close modal
function closeModal() {
  const modal = document.getElementById('accident-modal');
  if (modal) {
    modal.remove();
  }
}

// Update accident status
async function updateAccidentStatus(id, newStatus) {
  const statusNames = {
    'resolved': 'шийдэгдсэн',
    'confirmed': 'баталгаажуулах',
    'false_alarm': 'худал гэж тэмдэглэх'
  };

  if (!confirm(`Та энэ оолыг ${statusNames[newStatus]} гэж байна уу?`)) {
    return;
  }

  try {
    const result = await api.updateAccidentStatus(id, newStatus);

    if (result.success) {
      showToast('Төлөв шинэчлэгдлээ', 'success');
      await loadAccidents(); // Reload table
    } else {
      throw new Error(result.error || 'Failed to update status');
    }
  } catch (error) {
    console.error('Error updating status:', error);
    showToast('Төлөв шинэчлэхэд алдаа гарлаа', 'danger');
  }
}

// Export to CSV
function exportAccidents() {
  if (!accidentsData || accidentsData.length === 0) {
    showToast('Экспортлох өгөгдөл байхгүй', 'warning');
    return;
  }

  const exportData = accidentsData.map(accident => ({
    'ID': accident.id,
    'Огноо': formatDateTime(accident.accident_time),
    'Өргөрөг': accident.latitude,
    'Уртраг': accident.longitude,
    'Хүнд байдал': accident.severity,
    'Төлөв': accident.status,
    'Тайлбар': accident.description || '',
    'Мэдээлсэн': accident.reported_by_name || '',
    'Камер': accident.camera_name || '',
    'Эх үүсвэр': accident.source
  }));

  const filename = `accidents_${formatDate(new Date())}.csv`;
  exportToCSV(exportData, filename);
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', initAccidents);

// Export functions
window.initAccidents = initAccidents;
window.viewAccidentDetails = viewAccidentDetails;
window.updateAccidentStatus = updateAccidentStatus;
window.closeModal = closeModal;
window.exportAccidents = exportAccidents;