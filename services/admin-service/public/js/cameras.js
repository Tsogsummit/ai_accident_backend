let cameras = [];
let currentCameraId = null;

document.addEventListener('DOMContentLoaded', () => {
  if (!checkAuth()) return;
  initUserInfo();
  initLogoutButton();
  loadCameras();
  setInterval(loadCameras, 30000);
});

async function loadCameras() {
  try {
    const result = await api.get('/admin/cameras');
    if (result.success) {
      cameras = result.cameras || result.data || [];
      renderCameras();
      updateStats();
    }
  } catch (error) {
    console.error('Failed to load cameras:', error);
    showToast('Камер ачааллахад алдаа гарлаа', 'danger');
  }
}

function renderCameras() {
  const container = document.getElementById('camerasContainer');
  if (cameras.length === 0) {
    container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--secondary);"><i class="fas fa-video" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;"></i><p>Камер байхгүй байна</p><button class="btn btn-primary" onclick="openAddModal()">Камер нэмэх</button></div>';
    return;
  }
  container.innerHTML = cameras.map(camera => `
    <div class="camera-card">
      <div class="camera-preview">
        ${camera.thumbnailUrl ? `<img src="${camera.thumbnailUrl}" alt="${escapeHtml(camera.name)}">` : `<i class="fas fa-video camera-placeholder"></i>`}
        <div class="camera-status-badge ${camera.is_online ? 'online' : 'offline'}">${camera.is_online ? 'Online' : 'Offline'}</div>
      </div>
      <div class="camera-info">
        <div class="camera-name">${escapeHtml(camera.name)}</div>
        <div class="camera-location"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(camera.location)}</div>
        <div class="camera-stats">
          <div class="stat-item"><div class="stat-value">${camera.total_accidents || 0}</div><div class="stat-label">Нийт</div></div>
          <div class="stat-item"><div class="stat-value">${camera.accidents_24h || 0}</div><div class="stat-label">24 цаг</div></div>
          <div class="stat-item"><div class="stat-value">${camera.status === 'active' ? '✓' : '✗'}</div><div class="stat-label">Статус</div></div>
        </div>
        <div class="camera-actions">
          <button class="btn btn-primary btn-sm" onclick="viewDetails(${camera.id})" style="flex: 1;"><i class="fas fa-eye"></i> Үзэх</button>
          <button class="btn btn-warning btn-sm" onclick="editCamera(${camera.id})"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm" onclick="deleteCamera(${camera.id})"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    </div>
  `).join('');
}

function updateStats() {
  document.getElementById('totalCameras').textContent = cameras.length;
  document.getElementById('activeCameras').textContent = cameras.filter(c => c.is_online).length;
  document.getElementById('recordingCameras').textContent = cameras.filter(c => c.status === 'active').length;
  const totalDetections = cameras.reduce((sum, c) => sum + (parseInt(c.accidents_24h) || 0), 0);
  document.getElementById('hourlyDetections').textContent = totalDetections;
}

function openAddModal() {
  currentCameraId = null;
  document.getElementById('modalTitle').textContent = 'Камер нэмэх';
  document.getElementById('cameraForm').reset();
  document.getElementById('cameraModal').classList.add('active');
}

function closeModal() {
  document.getElementById('cameraModal').classList.remove('active');
}

function editCamera(id) {
  const camera = cameras.find(c => c.id === id);
  if (!camera) return;
  currentCameraId = id;
  document.getElementById('modalTitle').textContent = 'Камер засах';
  document.getElementById('camera-name').value = camera.name;
  document.getElementById('camera-location').value = camera.location;
  document.getElementById('camera-latitude').value = camera.latitude;
  document.getElementById('camera-longitude').value = camera.longitude;
  document.getElementById('camera-stream').value = camera.stream_url || '';
  document.getElementById('camera-resolution').value = camera.resolution || '720p';
  document.getElementById('camera-fps').value = camera.fps || 25;
  document.getElementById('camera-ip').value = camera.ip_address || '';
  document.getElementById('camera-status').value = camera.status || 'active';
  document.getElementById('camera-description').value = camera.description || '';
  document.getElementById('cameraModal').classList.add('active');
}

async function handleSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.target);
  const data = Object.fromEntries(formData);
  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Хадгалж байна...';
  try {
    let result;
    if (currentCameraId) {
      result = await api.put(`/admin/cameras/${currentCameraId}`, data);
    } else {
      result = await api.post('/admin/cameras', data);
    }
    if (result.success) {
      showToast(result.message || 'Амжилттай хадгалагдлаа', 'success');
      closeModal();
      loadCameras();
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    showToast('Алдаа гарлаа: ' + error.message, 'danger');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = 'Хадгалах';
  }
}

async function deleteCamera(id) {
  const camera = cameras.find(c => c.id === id);
  if (!camera) return;
  if (!confirm(`"${camera.name}" камерыг устгах уу?`)) return;
  try {
    const result = await api.delete(`/admin/cameras/${id}`);
    if (result.success) {
      showToast(result.message || 'Камер устгагдлаа', 'success');
      loadCameras();
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    showToast('Устгахад алдаа гарлаа: ' + error.message, 'danger');
  }
}

function viewDetails(id) {
  const camera = cameras.find(c => c.id === id);
  if (!camera) return;
  const details = `ID: ${camera.id}\nНэр: ${camera.name}\nБайршил: ${camera.location}\nКоординат: ${formatCoordinates(camera.latitude, camera.longitude)}\nIP: ${camera.ip_address || '-'}\nStream URL: ${camera.stream_url || '-'}\nТөлөв: ${camera.status}\nOnline: ${camera.is_online ? 'Тийм' : 'Үгүй'}\nНийт ослууд: ${camera.total_accidents || 0}\n24 цагийн ослууд: ${camera.accidents_24h || 0}\nСүүлийн осол: ${camera.last_accident_time ? formatDateTime(camera.last_accident_time) : '-'}`.trim();
  alert(details);
}

function refreshCameras() {
  loadCameras();
  showToast('Шинэчлэгдлээ', 'success');
}

window.openAddModal = openAddModal;
window.closeModal = closeModal;
window.editCamera = editCamera;
window.deleteCamera = deleteCamera;
window.viewDetails = viewDetails;
window.handleSubmit = handleSubmit;
window.refreshCameras = refreshCameras;