// Accident Management Script
let accidentsData = [];
let pagination = null;
let currentFilters = { page: 1, limit: 50, status: '', source: '' };

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
  ['status-filter', 'source-filter'].forEach(id => {
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
      document.getElementById('accidents-table-body').innerHTML = '<tr><td colspan="8" class="text-center" style="padding: 2rem; color: var(--danger);"><i class="fas fa-exclamation-circle" style="font-size: 2rem;"></i><p>Ослын мэдээлэл ачааллахад алдаа гарлаа</p></td></tr>';
  }
}

function renderAccidentsTable(accidents) {
  const tbody = document.getElementById('accidents-table-body');
  if (!accidents || !accidents.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="padding: 2rem;"><i class="fas fa-inbox" style="font-size: 2rem;"></i><p>Осол олдсонгүй</p></td></tr>';
    return;
  }

  tbody.innerHTML = accidents.map(a => {
    const needsReview = a.false_report_count >= 3;
    const reviewBadge = needsReview ? `<span class="badge badge-warning" style="margin-left: 0.5rem;" title="${a.false_report_count} хэрэглэгч хуурмаг гэж мэдээлсэн"><i class="fas fa-exclamation-triangle"></i> ${a.false_report_count}</span>` : '';

    return `
      <tr ${needsReview && a.status !== 'false_alarm' ? 'style="background-color: #fff3cd;"' : ''}>
        <td>${a.id}</td>
        <td>${formatDateTime(a.accident_time)}</td>
        <td><a href="${getMapLink(a.latitude, a.longitude)}" target="_blank">${formatCoordinates(a.latitude, a.longitude)}<i class="fas fa-external-link-alt" style="font-size: 0.75rem; margin-left: 0.25rem;"></i></a></td>
        <td>${getStatusBadge(a.status)}${reviewBadge}</td>
        <td>${truncate(a.description || '-', 50)}</td>
        <td>${a.reported_by_name || '-'}</td>
        <td>${a.camera_name || '-'}</td>
        <td><div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button class="btn btn-sm btn-primary" onclick="viewAccidentDetails(${a.id})" title="Дэлгэрэнгүй"><i class="fas fa-eye"></i></button>
          ${needsReview && a.status !== 'false_alarm' ? `<button class="btn btn-sm btn-warning" onclick="showStatusUpdateDialog(${a.id}, ${a.false_report_count})" title="Төлөв шинэчлэх (${a.false_report_count} хуурмаг мэдээлэл)"><i class="fas fa-edit"></i></button>` : ''}
          ${a.status !== 'resolved' && !needsReview ? `<button class="btn btn-sm btn-success" onclick="updateAccidentStatus(${a.id}, 'resolved')" title="Шийдэгдсэн"><i class="fas fa-check"></i></button>` : ''}
        </div></td>
      </tr>
    `;
  }).join('');
}

function viewAccidentDetails(id) {
  const a = accidentsData.find(x => x.id === id);
  if (!a) return;
  
  alert(`Осол #${a.id}\nОгноо: ${formatDateTime(a.accident_time)}\nБайршил: ${formatCoordinates(a.latitude, a.longitude)}\nТөлөв: ${a.status}`);
}

function showStatusUpdateDialog(id, falseReportCount) {
  const a = accidentsData.find(x => x.id === id);
  if (!a) return;

  const message = `Осол #${id} - ${falseReportCount} хэрэглэгч хуурмаг мэдээлэл гэж мэдээлсэн.\n\nАдмин төлөв шинэчлэх:\n\n1. Хуурмаг мэдээлэл (False Alarm) - Хэрэглэгчдэд мэдэгдэл илгээнэ\n2. Баталгаажсан (Confirmed) - Осол үнэхээр болсон\n3. Цуцлах\n\nТа ямар төлөвт шилжүүлэх вэ?`;

  const choice = prompt(message + '\n\nОруулна уу: 1=Хуурмаг, 2=Баталгаажсан, 3=Цуцлах', '');

  if (choice === '1') {
    updateAccidentStatusWithConfirm(id, 'false_alarm', 'Хуурмаг мэдээлэл гэж тэмдэглэх үү? Хэрэглэгчдэд мэдэгдэл илгээгдэнэ.');
  } else if (choice === '2') {
    updateAccidentStatusWithConfirm(id, 'confirmed', 'Баталгаажсан гэж тэмдэглэх үү?');
  }
}

async function updateAccidentStatusWithConfirm(id, newStatus, confirmMessage) {
  if (!confirm(confirmMessage)) return;
  try {
    const result = await api.updateAccidentStatus(id, newStatus);
    if (result.success) {
      if (newStatus === 'false_alarm') {
        showToast('Төлөв шинэчлэгдлээ. Хэрэглэгчдэд мэдэгдэл илгээгдлээ.', 'success');
      } else {
        showToast('Төлөв шинэчлэгдлээ', 'success');
      }
      await loadAccidents();
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    showToast('Алдаа гарлаа', 'danger');
  }
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
window.showStatusUpdateDialog = showStatusUpdateDialog;
window.updateAccidentStatusWithConfirm = updateAccidentStatusWithConfirm;
window.updateAccidentStatus = updateAccidentStatus;
window.exportAccidents = exportAccidents;
