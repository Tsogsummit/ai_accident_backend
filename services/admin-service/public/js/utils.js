// Utility Functions
function formatDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTime(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDateTime(dateString) {
  if (!dateString) return '-';
  return `${formatDate(dateString)} ${formatTime(dateString)}`;
}

function formatNumber(number) {
  if (number === null || number === undefined) return '0';
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function getSeverityBadge(severity) {
  const badges = {
    'minor': '<span class="badge badge-warning">Бага</span>',
    'moderate': '<span class="badge badge-warning">Дунд</span>',
    'severe': '<span class="badge badge-danger">Ноцтой</span>',
  };
  return badges[severity] || '<span class="badge badge-secondary">-</span>';
}

function getStatusBadge(status) {
  const badges = {
    'reported': '<span class="badge badge-warning">Мэдээлсэн</span>',
    'confirmed': '<span class="badge badge-danger">Баталгаажсан</span>',
    'resolved': '<span class="badge badge-success">Шийдэгдсэн</span>',
    'false_alarm': '<span class="badge badge-secondary">Худал</span>',
  };
  return badges[status] || '<span class="badge badge-secondary">-</span>';
}

function getUserStatusBadge(status) {
  const badges = {
    'active': '<span class="badge badge-success">Идэвхтэй</span>',
    'inactive': '<span class="badge badge-secondary">Идэвхгүй</span>',
    'suspended': '<span class="badge badge-danger">Хаасан</span>',
  };
  return badges[status] || '<span class="badge badge-secondary">-</span>';
}

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `alert alert-${type}`;
  toast.style.cssText = 'min-width: 300px; margin-bottom: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);';
  toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'danger' ? 'exclamation-circle' : 'info-circle'}"></i> ${message}`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function showLoading(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = '<div class="loading"><div class="spinner"></div><p>Ачааллаж байна...</p></div>';
  }
}

function truncate(text, length = 50) {
  if (!text) return '-';
  return text.length <= length ? text : text.substring(0, length) + '...';
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function formatCoordinates(lat, lng) {
  if (!lat || !lng) return '-';
  return `${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`;
}

function getMapLink(lat, lng) {
  if (!lat || !lng) return '#';
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function exportToCSV(data, filename) {
  if (!data || !data.length) {
    showToast('Өгөгдөл байхгүй байна', 'warning');
    return;
  }
  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(','),
    ...data.map(row => headers.map(h => {
      const cell = row[h];
      if (cell === null || cell === undefined) return '';
      const str = String(cell);
      return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(','))
  ].join('\n');
  
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

class Pagination {
  constructor(container, options = {}) {
    this.container = container;
    this.currentPage = options.page || 1;
    this.totalPages = options.totalPages || 1;
    this.onPageChange = options.onPageChange || (() => {});
  }

  render() {
    const container = document.getElementById(this.container);
    if (!container) return;

    let html = '<div class="pagination" style="display: flex; gap: 0.5rem; justify-content: center; margin-top: 1rem;">';
    html += `<button class="btn btn-sm btn-secondary" ${this.currentPage === 1 ? 'disabled' : ''} onclick="pagination.goToPage(${this.currentPage - 1})">Өмнөх</button>`;
    
    const pages = this.getPageNumbers();
    pages.forEach(page => {
      if (page === '...') {
        html += '<span style="padding: 0.375rem 0.75rem;">...</span>';
      } else {
        html += `<button class="btn btn-sm ${page === this.currentPage ? 'btn-primary' : 'btn-secondary'}" onclick="pagination.goToPage(${page})">${page}</button>`;
      }
    });
    
    html += `<button class="btn btn-sm btn-secondary" ${this.currentPage === this.totalPages ? 'disabled' : ''} onclick="pagination.goToPage(${this.currentPage + 1})">Дараах</button>`;
    html += '</div>';
    container.innerHTML = html;
  }

  getPageNumbers() {
    const pages = [];
    if (this.totalPages <= 7) {
      for (let i = 1; i <= this.totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (this.currentPage > 3) pages.push('...');
      const start = Math.max(2, this.currentPage - 1);
      const end = Math.min(this.totalPages - 1, this.currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (this.currentPage < this.totalPages - 2) pages.push('...');
      pages.push(this.totalPages);
    }
    return pages;
  }

  goToPage(page) {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
    this.render();
    this.onPageChange(page);
  }

  update(page, totalPages) {
    this.currentPage = page;
    this.totalPages = totalPages;
    this.render();
  }
}

window.formatDate = formatDate;
window.formatTime = formatTime;
window.formatDateTime = formatDateTime;
window.formatNumber = formatNumber;
window.getSeverityBadge = getSeverityBadge;
window.getStatusBadge = getStatusBadge;
window.getUserStatusBadge = getUserStatusBadge;
window.showToast = showToast;
window.showLoading = showLoading;
window.truncate = truncate;
window.escapeHtml = escapeHtml;
window.formatCoordinates = formatCoordinates;
window.getMapLink = getMapLink;
window.exportToCSV = exportToCSV;
window.Pagination = Pagination;
