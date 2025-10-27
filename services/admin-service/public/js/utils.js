// Utility Functions
// Common helper functions used across the admin dashboard

// Format date
function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  // Format time
  function formatTime(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  
  // Format datetime
  function formatDateTime(dateString) {
    if (!dateString) return '-';
    return `${formatDate(dateString)} ${formatTime(dateString)}`;
  }
  
  // Time ago format
  function timeAgo(dateString) {
    if (!dateString) return '-';
    
    const now = new Date();
    const past = new Date(dateString);
    const diffMs = now - past;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
  
    if (diffMins < 1) return 'Яг одоо';
    if (diffMins < 60) return `${diffMins} минутын өмнө`;
    if (diffHours < 24) return `${diffHours} цагийн өмнө`;
    if (diffDays < 7) return `${diffDays} өдрийн өмнө`;
    
    return formatDate(dateString);
  }
  
  // Format number with commas
  function formatNumber(number) {
    if (number === null || number === undefined) return '0';
    return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  
  // Get severity badge class
  function getSeverityBadge(severity) {
    const badges = {
      'minor': '<span class="badge badge-warning">Бага</span>',
      'moderate': '<span class="badge badge-warning">Дунд</span>',
      'severe': '<span class="badge badge-danger">Ноцтой</span>',
    };
    return badges[severity] || '<span class="badge badge-secondary">-</span>';
  }
  
  // Get status badge class
  function getStatusBadge(status) {
    const badges = {
      'reported': '<span class="badge badge-warning">Мэдээлсэн</span>',
      'confirmed': '<span class="badge badge-danger">Баталгаажсан</span>',
      'resolved': '<span class="badge badge-success">Шийдэгдсэн</span>',
      'false_alarm': '<span class="badge badge-secondary">Худал</span>',
    };
    return badges[status] || '<span class="badge badge-secondary">-</span>';
  }
  
  // Get user status badge
  function getUserStatusBadge(status) {
    const badges = {
      'active': '<span class="badge badge-success">Идэвхтэй</span>',
      'inactive': '<span class="badge badge-secondary">Идэвхгүй</span>',
      'suspended': '<span class="badge badge-danger">Хаасан</span>',
    };
    return badges[status] || '<span class="badge badge-secondary">-</span>';
  }
  
  // Get camera status badge
  function getCameraStatusBadge(isOnline) {
    if (isOnline) {
      return '<span class="badge badge-success">Online</span>';
    } else {
      return '<span class="badge badge-secondary">Offline</span>';
    }
  }
  
  // Show toast notification
  function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toast-container');
    
    if (!toastContainer) {
      const container = document.createElement('div');
      container.id = 'toast-container';
      container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999;';
      document.body.appendChild(container);
    }
  
    const toast = document.createElement('div');
    toast.className = `alert alert-${type}`;
    toast.style.cssText = 'min-width: 300px; margin-bottom: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);';
    toast.innerHTML = `
      <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'danger' ? 'exclamation-circle' : 'info-circle'}"></i>
      ${message}
    `;
  
    document.getElementById('toast-container').appendChild(toast);
  
    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
  
  // Show loading spinner
  function showLoading(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
      element.innerHTML = `
        <div class="loading">
          <div class="spinner"></div>
          <p>Ачааллаж байна...</p>
        </div>
      `;
    }
  }
  
  // Hide loading
  function hideLoading(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
      element.innerHTML = '';
    }
  }
  
  // Confirm dialog
  function confirm(message, callback) {
    if (window.confirm(message)) {
      callback();
    }
  }
  
  // Truncate text
  function truncate(text, length = 50) {
    if (!text) return '-';
    if (text.length <= length) return text;
    return text.substring(0, length) + '...';
  }
  
  // Escape HTML
  function escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
  
  // Debounce function
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
  
  // Copy to clipboard
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Хуулагдлаа', 'success');
    } catch (err) {
      showToast('Хуулахад алдаа гарлаа', 'danger');
    }
  }
  
  // Download file
  function downloadFile(data, filename, type = 'text/plain') {
    const blob = new Blob([data], { type });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }
  
  // Export to CSV
  function exportToCSV(data, filename) {
    if (!data || !data.length) {
      showToast('Өгөгдөл байхгүй байна', 'warning');
      return;
    }
  
    const headers = Object.keys(data[0]);
    const csv = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => {
          const cell = row[header];
          // Escape commas and quotes
          if (cell === null || cell === undefined) return '';
          const str = String(cell);
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        }).join(',')
      )
    ].join('\n');
  
    downloadFile('\uFEFF' + csv, filename, 'text/csv;charset=utf-8');
  }
  
  // Initialize tooltips (if using Bootstrap or similar)
  function initTooltips() {
    const tooltips = document.querySelectorAll('[data-tooltip]');
    tooltips.forEach(el => {
      el.title = el.getAttribute('data-tooltip');
    });
  }
  
  // Format coordinates
  function formatCoordinates(lat, lng) {
    if (!lat || !lng) return '-';
    return `${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}`;
  }
  
  // Get map link
  function getMapLink(lat, lng) {
    if (!lat || !lng) return '#';
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  
  // Pagination helper
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
  
      // Previous button
      html += `
        <button class="btn btn-sm btn-secondary" ${this.currentPage === 1 ? 'disabled' : ''} 
                onclick="pagination.goToPage(${this.currentPage - 1})">
          Өмнөх
        </button>
      `;
  
      // Page numbers
      const pages = this.getPageNumbers();
      pages.forEach(page => {
        if (page === '...') {
          html += '<span style="padding: 0.375rem 0.75rem;">...</span>';
        } else {
          html += `
            <button class="btn btn-sm ${page === this.currentPage ? 'btn-primary' : 'btn-secondary'}"
                    onclick="pagination.goToPage(${page})">
              ${page}
            </button>
          `;
        }
      });
  
      // Next button
      html += `
        <button class="btn btn-sm btn-secondary" ${this.currentPage === this.totalPages ? 'disabled' : ''}
                onclick="pagination.goToPage(${this.currentPage + 1})">
          Дараах
        </button>
      `;
  
      html += '</div>';
      container.innerHTML = html;
    }
  
    getPageNumbers() {
      const pages = [];
      const maxButtons = 7;
  
      if (this.totalPages <= maxButtons) {
        for (let i = 1; i <= this.totalPages; i++) {
          pages.push(i);
        }
      } else {
        pages.push(1);
  
        if (this.currentPage > 3) {
          pages.push('...');
        }
  
        const start = Math.max(2, this.currentPage - 1);
        const end = Math.min(this.totalPages - 1, this.currentPage + 1);
  
        for (let i = start; i <= end; i++) {
          pages.push(i);
        }
  
        if (this.currentPage < this.totalPages - 2) {
          pages.push('...');
        }
  
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
  
  // Export functions
  window.formatDate = formatDate;
  window.formatTime = formatTime;
  window.formatDateTime = formatDateTime;
  window.timeAgo = timeAgo;
  window.formatNumber = formatNumber;
  window.getSeverityBadge = getSeverityBadge;
  window.getStatusBadge = getStatusBadge;
  window.getUserStatusBadge = getUserStatusBadge;
  window.getCameraStatusBadge = getCameraStatusBadge;
  window.showToast = showToast;
  window.showLoading = showLoading;
  window.hideLoading = hideLoading;
  window.confirm = confirm;
  window.truncate = truncate;
  window.escapeHtml = escapeHtml;
  window.debounce = debounce;
  window.copyToClipboard = copyToClipboard;
  window.exportToCSV = exportToCSV;
  window.initTooltips = initTooltips;
  window.formatCoordinates = formatCoordinates;
  window.getMapLink = getMapLink;
  window.Pagination = Pagination;