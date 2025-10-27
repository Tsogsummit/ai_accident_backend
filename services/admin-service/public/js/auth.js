// Authentication Functions
// Handle login, logout, and session management

// Login form handler
async function handleLogin(event) {
    event.preventDefault();
  
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('error-message');
    const loginBtn = document.getElementById('login-btn');
  
    // Validation
    if (!username || !password) {
      showError('Хэрэглэгчийн нэр болон нууц үг оруулна уу');
      return;
    }
  
    // Disable button and show loading
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Нэвтэрч байна...';
    errorDiv.classList.remove('show');
  
    try {
      const result = await api.login(username, password);
  
      if (result.success) {
        showToast('Амжилттай нэвтэрлээ', 'success');
        // Redirect to dashboard
        setTimeout(() => {
          window.location.href = '/dashboard.html';
        }, 500);
      } else {
        showError(result.error || 'Нэвтрэхэд алдаа гарлаа');
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Нэвтрэх';
      }
    } catch (error) {
      console.error('Login error:', error);
      showError(error.message || 'Нэвтрэхэд алдаа гарлаа');
      loginBtn.disabled = false;
      loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Нэвтрэх';
    }
  }
  
  // Show error message
  function showError(message) {
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.classList.add('show');
    }
  }
  
  // Logout handler
  async function handleLogout() {
    if (confirm('Та гарахдаа итгэлтэй байна уу?')) {
      try {
        await api.logout();
      } catch (error) {
        console.error('Logout error:', error);
        // Force logout even if API call fails
        api.setToken(null);
        window.location.href = '/login.html';
      }
    }
  }
  
  // Initialize user info in navbar
  function initUserInfo() {
    const adminInfo = api.getAdminInfo();
    if (!adminInfo) return;
  
    const userNameEl = document.querySelector('.user-name');
    const userRoleEl = document.querySelector('.user-role');
    const userAvatarEl = document.querySelector('.user-avatar');
  
    if (userNameEl) {
      userNameEl.textContent = adminInfo.username;
    }
  
    if (userRoleEl) {
      userRoleEl.textContent = 'Админ';
    }
  
    if (userAvatarEl) {
      userAvatarEl.textContent = adminInfo.username.charAt(0).toUpperCase();
    }
  }
  
  // Check if user is authenticated
  function checkAuth() {
    if (!api.isAuthenticated()) {
      window.location.href = '/login.html';
      return false;
    }
    return true;
  }
  
  // Initialize logout button
  function initLogoutButton() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleLogout);
    }
  }
  
  // Check session periodically
  function startSessionCheck() {
    // Check every 5 minutes
    setInterval(() => {
      if (!api.isAuthenticated()) {
        showToast('Session хугацаа дууслаа', 'warning');
        setTimeout(() => {
          window.location.href = '/login.html';
        }, 2000);
      }
    }, 5 * 60 * 1000);
  }
  
  // Export functions
  window.handleLogin = handleLogin;
  window.handleLogout = handleLogout;
  window.initUserInfo = initUserInfo;
  window.checkAuth = checkAuth;
  window.initLogoutButton = initLogoutButton;
  window.startSessionCheck = startSessionCheck;