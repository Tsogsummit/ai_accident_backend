// API Utility Functions
// Handle all API requests with authentication

const API_BASE_URL = window.location.origin;

class API {
  constructor() {
    this.baseURL = API_BASE_URL;
    this.token = localStorage.getItem('admin_token');
  }

  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem('admin_token', token);
    } else {
      localStorage.removeItem('admin_token');
    }
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    return headers;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const config = {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);
      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Token expired or invalid
          this.setToken(null);
          window.location.href = '/login.html';
          throw new Error('Session expired. Please login again.');
        }
        throw new Error(data.error || data.message || 'API request failed');
      }

      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  }

  // GET request
  async get(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = queryString ? `${endpoint}?${queryString}` : endpoint;
    return this.request(url, { method: 'GET' });
  }

  // POST request
  async post(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // PUT request
  async put(endpoint, data = {}) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // DELETE request
  async delete(endpoint) {
    return this.request(endpoint, {
      method: 'DELETE',
    });
  }

  // Admin specific endpoints
  async login(username, password) {
    const data = await this.post('/admin/login', { username, password });
    if (data.success && data.token) {
      this.setToken(data.token);
    }
    return data;
  }

  async logout() {
    this.setToken(null);
    window.location.href = '/login.html';
  }

  async getDashboardStats() {
    return this.get('/admin/dashboard/stats');
  }

  async getAccidents(params = {}) {
    return this.get('/admin/accidents', params);
  }

  async updateAccidentStatus(id, status) {
    return this.put(`/admin/accidents/${id}/status`, { status });
  }

  async getUsers(params = {}) {
    return this.get('/admin/users', params);
  }

  async getCameras(params = {}) {
    return this.get('/api/cameras', params);
  }

  async getReports(params = {}) {
    return this.get('/api/reports', params);
  }

  isAuthenticated() {
    return !!this.token;
  }

  getAdminInfo() {
    if (!this.token) return null;
    
    try {
      const payload = JSON.parse(atob(this.token.split('.')[1]));
      return {
        username: payload.username,
        role: payload.role,
        permissions: payload.permissions,
      };
    } catch (error) {
      console.error('Failed to parse token:', error);
      return null;
    }
  }
}

// Create global API instance
const api = new API();

// Check authentication on protected pages
function requireAuth() {
  if (!api.isAuthenticated()) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

// Export for use in other scripts
window.api = api;
window.requireAuth = requireAuth;