// Accident Management Script
let accidentsData = [];
let pagination = null;
let currentFilters = { page: 1, limit: 50, status: '', severity: '', source: '' };

async function initAccidents() {
  if (!checkAuth()) return;
  initUserInfo();
  initLogoutButton();
  setActiveNav('accidents');

  pagination = new Pagination('pagination-container', {
    page: 1, totalPages: 1,
    onPageChange: (page) => {
      currentFilters.page = page;
      loadAccidents();
    }
  });

  setupFilters();
  await loadAccidents();
}

function setupFilters() {
  ['status-filter', 'severity-filter', 'source-filter'].forEach(id => {
    const filter = document.getElementById(id);
    if (filter) {
      filter.addEventListener('change', (e) => {
        currentFilters[id.split('-')[0]] = e.target.value;
        currentFilters.page = 1;
        loadAccidents();
      });
    }
  });
}

async function loadAccidents() {
  showLoading('accidents-table-body');
  try {
    const params = { ...currentFilters };
    const result = await api.getAccidents(params);
    if (result.success) {
      accidentsData = result.data;
      renderAccidentsTable(accidentsData);
      if (result.pagination) pagination.update(result.pagination.page, result.pagination.totalPages);
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    document.getElementById('accidents-table-body').innerHTML = '<tr><td colspan="9" class="text-center" style="padding: 2rem; color: var(--danger);"><i class="fas fa-exclamation-circle" style="font-size: 2rem;"></i><p>Ослын мэдээлэл ачааллахад алдаа гарлаа</p></td></tr>';
  }
}

function renderAccidentsTable(accidents) {
  const tbody = document.getElementById('accidents-table-body');
  if (!accidents || !accidents.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center" style="padding: 2rem;"><i class="fas fa-inbox" style="font-size: 2rem;"></i><p>Осол олдсонгүй</p></td></tr>';
    return;
  }

  tbody.innerHTML = accidents.map(a => `
    <tr>
      <td>${a.id}</td>
      <td>${formatDateTime(a.accident_time)}</td>
      <td><a href="${getMapLink(a.latitude, a.longitude)}" target="_blank">${formatCoordinates(a.latitude, a.longitude)}<i class="fas fa-external-link-alt" style="font-size: 0.75rem; margin-left: 0.25rem;"></i></a></td>
      <td>${getSeverityBadge(a.severity)}</td>
      <td>${getStatusBadge(a.status)}</td>
      <td>${truncate(a.description || '-', 50)}</td>
      <td>${a.reported_by_name || '-'}</td>
      <td>${a.camera_name || '-'}</td>
      <td><div style="display: flex; gap: 0.5rem;">
        <button class="btn btn-sm btn-primary" onclick="viewAccidentDetails(${a.id})"><i class="fas fa-eye"></i></button>
        ${a.status !== 'resolved' ? `<button class="btn btn-sm btn-success" onclick="updateAccidentStatus(${a.id}, 'resolved')"><i class="fas fa-check"></i></button>` : ''}
      </div></td>
    </tr>
  `).join('');
}

function viewAccidentDetails(id) {
  const a = accidentsData.find(x => x.id === id);
  if (!a) return;
  
  alert(`Осол #${a.id}\nОгноо: ${formatDateTime(a.accident_time)}\nБайршил: ${formatCoordinates(a.latitude, a.longitude)}\nТөлөв: ${a.status}`);
}

async function updateAccidentStatus(id, newStatus) {
  if (!confirm('Төлөв шинэчлэх үү?')) return;
  try {
    const result = await api.updateAccidentStatus(id, newStatus);
    if (result.success) {
      showToast('Төлөв шинэчлэгдлээ', 'success');
      await loadAccidents();
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    showToast('Алдаа гарлаа', 'danger');
  }
}

function exportAccidents() {
  if (!accidentsData || !accidentsData.length) {
    showToast('Өгөгдөл байхгүй', 'warning');
    return;
  }
  const exportData = accidentsData.map(a => ({
    'ID': a.id,
    'Огноо': formatDateTime(a.accident_time),
    'Өргөрөг': a.latitude,
    'Уртраг': a.longitude,
    'Төлөв': a.status
  }));
  exportToCSV(exportData, `accidents_${formatDate(new Date())}.csv`);
}

document.addEventListener('DOMContentLoaded', initAccidents);
window.initAccidents = initAccidents;
window.viewAccidentDetails = viewAccidentDetails;
window.updateAccidentStatus = updateAccidentStatus;
window.exportAccidents = exportAccidents;
