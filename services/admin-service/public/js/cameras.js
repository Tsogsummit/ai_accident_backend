// services/admin-service/public/js/cameras.js - COMPLETE VERSION
let camerasData = [];
let pagination = null;
let currentFilters = { page: 1, limit: 50, status: '' };
let editingCamera = null;

async function initCameras() {
  if (!checkAuth()) return;
  initUserInfo();
  initLogoutButton();
  setActiveNav('cameras');

  pagination = new Pagination('pagination-container', {
    page: 1, totalPages: 1,
    onPageChange: (page) => {
      currentFilters.page = page;
      loadCameras();
    }
  });

  setupFilters();
  setupModals();
  await loadCameras();
}

function setupFilters() {
  const statusFilter = document.getElementById('status-filter');
  if (statusFilter) {
    statusFilter.addEventListener('change', (e) => {
      currentFilters.status = e.target.value;
      currentFilters.page = 1;
      loadCameras();
    });
  }
}

function setupModals() {
  // Close modals on click outside
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      closeModal(e.target.id);
    }
  });
}

async function loadCameras() {
  showLoading('cameras-table-body');
  try {
    const params = { ...currentFilters };
    const result = await api.get('/admin/cameras', params);
    
    if (result.success) {
      camerasData = result.data;
      renderCamerasTable(camerasData);
      if (result.pagination) {
        pagination.update(result.pagination.page, result.pagination.totalPages);
      }
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    document.getElementById('cameras-table-body').innerHTML = 
      '<tr><td colspan="8" class="text-center" style="padding: 2rem; color: var(--danger);">' +
      '<i class="fas fa-exclamation-circle" style="font-size: 2rem;"></i>' +
      '<p>Камерын мэдээлэл ачааллахад алдаа гарлаа</p></td></tr>';
  }
}

function renderCamerasTable(cameras) {
  const tbody = document.getElementById('cameras-table-body');
  
  if (!cameras || !cameras.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="padding: 2rem;">' +
      '<i class="fas fa-inbox" style="font-size: 2rem;"></i>' +
      '<p>Камер олдсонгүй</p></td></tr>';
    return;
  }

  tbody.innerHTML = cameras.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>
        <div style="font-weight: 600;">${escapeHtml(c.name)}</div>
        <div style="font-size: 0.875rem; color: var(--secondary);">${escapeHtml(c.location)}</div>
      </td>
      <td>
        <a href="${getMapLink(c.latitude, c.longitude)}" target="_blank">
          ${formatCoordinates(c.latitude, c.longitude)}
          <i class="fas fa-external-link-alt" style="font-size: 0.75rem; margin-left: 0.25rem;"></i>
        </a>
      </td>
      <td>${c.is_online ? '<span class="badge badge-success">Online</span>' : '<span class="badge badge-secondary">Offline</span>'}</td>
      <td>${getCameraStatusBadge(c.status)}</td>
      <td>
        <div>${c.total_accidents || 0} нийт</div>
        <div style="font-size: 0.875rem; color: var(--secondary);">${c.accidents_24h || 0} (24ц)</div>
      </td>
      <td>${c.last_accident_time ? formatDateTime(c.last_accident_time) : '-'}</td>
      <td>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-sm btn-primary" onclick="viewCameraDetails(${c.id})" title="Дэлгэрэнгүй">
            <i class="fas fa-eye"></i>
          </button>
          <button class="btn btn-sm btn-warning" onclick="editCamera(${c.id})" title="Засах">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-sm btn-danger" onclick="deleteCamera(${c.id})" title="Устгах">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function getCameraStatusBadge(status) {
  const badges = {
    'active': '<span class="badge badge-success">Идэвхтэй</span>',
    'inactive': '<span class="badge badge-secondary">Идэвхгүй</span>',
    'maintenance': '<span class="badge badge-warning">Засвар</span>',
  };
  return badges[status] || '<span class="badge badge-secondary">-</span>';
}

function openAddCameraModal() {
  editingCamera = null;
  document.getElementById('modal-title').textContent = 'Камер нэмэх';
  document.getElementById('camera-form').reset();
  document.getElementById('camera-modal').style.display = 'flex';
}

function editCamera(id) {
  const camera = camerasData.find(c => c.id === id);
  if (!camera) return;

  editingCamera = camera;
  document.getElementById('modal-title').textContent = 'Камер засах';
  document.getElementById('camera-name').value = camera.name;
  document.getElementById('camera-location').value = camera.location;
  document.getElementById('camera-latitude').value = camera.latitude;
  document.getElementById('camera-longitude').value = camera.longitude;
  document.getElementById('camera-ip').value = camera.ip_address || '';
  document.getElementById('camera-stream').value = camera.stream_url || '';
  document.getElementById('camera-description').value = camera.description || '';
  document.getElementById('camera-status').value = camera.status;
  
  document.getElementById('camera-modal').style.display = 'flex';
}

function closeModal(modalId) {
  document.getElementById(modalId).style.display = 'none';
}

async function saveCameraForm(event) {
  event.preventDefault();
  
  const formData = {
    name: document.getElementById('camera-name').value.trim(),
    location: document.getElementById('camera-location').value.trim(),
    latitude: parseFloat(document.getElementById('camera-latitude').value),
    longitude: parseFloat(document.getElementById('camera-longitude').value),
    ip_address: document.getElementById('camera-ip').value.trim(),
    stream_url: document.getElementById('camera-stream').value.trim(),
    description: document.getElementById('camera-description').value.trim(),
    status: document.getElementById('camera-status').value,
  };

  // Validation
  if (!formData.name || !formData.location) {
    showToast('Нэр болон байршил заавал оруулна уу', 'danger');
    return;
  }

  if (isNaN(formData.latitude) || isNaN(formData.longitude)) {
    showToast('Координат буруу байна', 'danger');
    return;
  }

  const saveBtn = document.getElementById('save-camera-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Хадгалж байна...';

  try {
    let result;
    if (editingCamera) {
      result = await api.put(`/admin/cameras/${editingCamera.id}`, formData);
    } else {
      result = await api.post('/admin/cameras', formData);
    }

    if (result.success) {
      showToast(editingCamera ? 'Камер шинэчлэгдлээ' : 'Камер нэмэгдлээ', 'success');
      closeModal('camera-modal');
      await loadCameras();
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    showToast('Алдаа гарлаа: ' + error.message, 'danger');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fas fa-save"></i> Хадгалах';
  }
}

async function deleteCamera(id) {
  const camera = camerasData.find(c => c.id === id);
  if (!camera) return;

  if (!confirm(`"${camera.name}" камерыг устгах уу?`)) return;

  try {
    const result = await api.delete(`/admin/cameras/${id}`);
    if (result.success) {
      showToast('Камер устгагдлаа', 'success');
      await loadCameras();
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    showToast('Устгахад алдаа гарлаа: ' + error.message, 'danger');
  }
}

function viewCameraDetails(id) {
  const camera = camerasData.find(c => c.id === id);
  if (!camera) return;

  const details = `
ID: ${camera.id}
Нэр: ${camera.name}
Байршил: ${camera.location}
Координат: ${formatCoordinates(camera.latitude, camera.longitude)}
IP: ${camera.ip_address || '-'}
Stream URL: ${camera.stream_url || '-'}
Төлөв: ${camera.status}
Online: ${camera.is_online ? 'Тийм' : 'Үгүй'}
Нийт ослууд: ${camera.total_accidents || 0}
24 цагийн ослууд: ${camera.accidents_24h || 0}
Сүүлийн осол: ${camera.last_accident_time ? formatDateTime(camera.last_accident_time) : '-'}
  `.trim();

  alert(details);
}

function exportCameras() {
  if (!camerasData || !camerasData.length) {
    showToast('Өгөгдөл байхгүй', 'warning');
    return;
  }
  
  const exportData = camerasData.map(c => ({
    'ID': c.id,
    'Нэр': c.name,
    'Байршил': c.location,
    'Өргөрөг': c.latitude,
    'Уртраг': c.longitude,
    'Төлөв': c.status,
    'Online': c.is_online ? 'Тийм' : 'Үгүй',
    'Нийт ослууд': c.total_accidents || 0
  }));
  
  exportToCSV(exportData, `cameras_${formatDate(new Date())}.csv`);
}

document.addEventListener('DOMContentLoaded', initCameras);
window.initCameras = initCameras;
window.openAddCameraModal = openAddCameraModal;
window.editCamera = editCamera;
window.deleteCamera = deleteCamera;
window.viewCameraDetails = viewCameraDetails;
window.closeModal = closeModal;
window.saveCameraForm = saveCameraForm;
window.exportCameras = exportCameras;