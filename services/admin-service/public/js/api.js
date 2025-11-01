// API Utility - UPDATED VERSION to use microservices
const API_BASE_URL = window.location.origin;
const USER_SERVICE_URL = window.location.protocol + '//' + window.location.hostname + ':3001';

class API {
  constructor() {
    this.baseURL = API_BASE_URL;
    this.userServiceURL = USER_SERVICE_URL;
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
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const config = { ...options, headers: { ...this.getHeaders(), ...options.headers } };

    try {
      const response = await fetch(url, config);
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.setToken(null);
          window.location.href = '/login.html';
          throw new Error('Session expired');
        }
        throw new Error(data.error || 'API request failed');
      }
      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  }

  async requestService(serviceURL, endpoint, options = {}) {
    const url = `${serviceURL}${endpoint}`;
    const config = { ...options, headers: { ...this.getHeaders(), ...options.headers } };

    try {
      const response = await fetch(url, config);
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.setToken(null);
          window.location.href = '/login.html';
          throw new Error('Session expired');
        }
        throw new Error(data.error || 'API request failed');
      }
      return data;
    } catch (error) {
      console.error('Service API Error:', error);
      throw error;
    }
  }

  async get(endpoint, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(qs ? `${endpoint}?${qs}` : endpoint, { method: 'GET' });
  }

  async post(endpoint, data = {}) {
    return this.request(endpoint, { method: 'POST', body: JSON.stringify(data) });
  }

  async put(endpoint, data = {}) {
    return this.request(endpoint, { method: 'PUT', body: JSON.stringify(data) });
  }

  async delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }

  // ==========================================
  // AUTH
  // ==========================================

  async login(username, password) {
    const data = await this.post('/admin/login', { username, password });
    if (data.success && data.token) this.setToken(data.token);
    return data;
  }

  async logout() {
    this.setToken(null);
    window.location.href = '/login.html';
  }

  // ==========================================
  // DASHBOARD
  // ==========================================

  async getDashboardStats() { 
    return this.get('/admin/dashboard/stats'); 
  }

  // ==========================================
  // ACCIDENTS
  // ==========================================

  async getAccidents(params = {}) { 
    return this.get('/admin/accidents', params); 
  }

  async updateAccidentStatus(id, status) {
    return this.put(`/admin/accidents/${id}/status`, { status });
  }

  // ==========================================
  // USERS - USING USER SERVICE
  // ==========================================

  async getUsers(params = {}) { 
    try {
      // Try user-service first
      const qs = new URLSearchParams(params).toString();
      return await this.requestService(
        this.userServiceURL, 
        qs ? `/admin/users?${qs}` : '/admin/users',
        { method: 'GET' }
      );
    } catch (error) {
      console.warn('User service unavailable, falling back to admin service:', error);
      // Fallback to admin service
      return this.get('/admin/users', params);
    }
  }

  async getUserStats() {
    try {
      return await this.requestService(
        this.userServiceURL,
        '/admin/users/stats',
        { method: 'GET' }
      );
    } catch (error) {
      console.warn('User service stats unavailable:', error);
      return { success: false, error: 'User service unavailable' };
    }
  }

  async createUser(data) {
    try {
      return await this.requestService(
        this.userServiceURL,
        '/admin/users',
        { method: 'POST', body: JSON.stringify(data) }
      );
    } catch (error) {
      console.warn('User service create unavailable, falling back:', error);
      return this.post('/admin/users', data);
    }
  }

  async updateUser(id, data) {
    try {
      return await this.requestService(
        this.userServiceURL,
        `/admin/users/${id}`,
        { method: 'PUT', body: JSON.stringify(data) }
      );
    } catch (error) {
      console.warn('User service update unavailable, falling back:', error);
      return this.put(`/admin/users/${id}`, data);
    }
  }

  async deleteUser(id) {
    try {
      return await this.requestService(
        this.userServiceURL,
        `/admin/users/${id}`,
        { method: 'DELETE' }
      );
    } catch (error) {
      console.warn('User service delete unavailable, falling back:', error);
      return this.delete(`/admin/users/${id}`);
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================

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
        permissions: payload.permissions 
      };
    } catch (error) {
      return null;
    }
  }
}

const api = new API();

function requireAuth() {
  if (!api.isAuthenticated()) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

window.api = api;
window.requireAuth = requireAuth;