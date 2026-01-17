// Hot Node Dashboard JavaScript

// Authentication state
let isAuthenticated = false;

// Check authentication status
async function checkAuth() {
  try {
    const response = await fetch('/api/auth/status');
    const data = await response.json();
    isAuthenticated = data.authenticated;
    updateUIForAuth();
  } catch (error) {
    console.error('Auth check failed:', error);
  }
}

// Update UI based on authentication
function updateUIForAuth() {
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const loginModal = document.getElementById('loginModal');
  
  if (isAuthenticated) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-block';
    
    // Enable all form inputs and buttons
    document.querySelectorAll('input:disabled, button:disabled, select:disabled').forEach(el => {
      el.disabled = false;
    });
    
    // Remove disabled class from buttons
    document.querySelectorAll('.btn-disabled-auth').forEach(el => {
      el.classList.remove('btn-disabled-auth');
    });
  } else {
    if (loginBtn) loginBtn.style.display = 'inline-block';
    if (logoutBtn) logoutBtn.style.display = 'none';
    
    // Disable all action buttons and form inputs
    const writeElements = document.querySelectorAll(
      'button[type="submit"], .btn-primary, .btn-danger, .btn-warning, input[type="text"], input[type="checkbox"], select'
    );
    writeElements.forEach(el => {
      // Skip the login form elements
      if (!el.closest('#loginModal')) {
        el.disabled = true;
        if (el.tagName === 'BUTTON' || el.classList.contains('btn')) {
          el.classList.add('btn-disabled-auth');
          el.title = 'Login required';
        }
      }
    });
  }
}

// Show login modal
function showLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('loginPassword').focus();
  }
}

// Hide login modal
function hideLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) {
    modal.style.display = 'none';
    document.getElementById('loginPassword').value = '';
  }
}

// Login
async function login(password) {
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    
    const data = await response.json();
    
    if (data.success) {
      isAuthenticated = true;
      hideLoginModal();
      updateUIForAuth();
      showNotification('Login successful', 'success');
    } else {
      showNotification('Invalid password', 'error');
    }
  } catch (error) {
    showNotification('Login failed: ' + error.message, 'error');
  }
}

// Logout
async function logout() {
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST'
    });
    
    const data = await response.json();
    
    if (data.success) {
      isAuthenticated = false;
      updateUIForAuth();
      showNotification('Logged out successfully', 'success');
    }
  } catch (error) {
    showNotification('Logout failed: ' + error.message, 'error');
  }
}

// Show notification
function showNotification(message, type = 'success') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideIn 0.3s reverse';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format relative time
function formatRelativeTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
}

// Fetch with timeout
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Auto-refresh data (optional)
let autoRefreshInterval = null;

function startAutoRefresh(intervalMs = 30000) {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }
  
  autoRefreshInterval = setInterval(() => {
    location.reload();
  }, intervalMs);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  console.log('Hot Node Dashboard loaded');
  
  // Check authentication status
  checkAuth();
  
  // Login button handler
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', showLoginModal);
  }
  
  // Logout button handler
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }
  
  // Login form handler
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const password = document.getElementById('loginPassword').value;
      login(password);
    });
  }
  
  // Close modal on background click
  const loginModal = document.getElementById('loginModal');
  if (loginModal) {
    loginModal.addEventListener('click', (e) => {
      if (e.target === loginModal) {
        hideLoginModal();
      }
    });
  }
  
  // Add copy-to-clipboard for CIDs
  document.querySelectorAll('code.cid').forEach(el => {
    el.style.cursor = 'pointer';
    el.title = 'Click to copy full CID';
    
    el.addEventListener('click', () => {
      const cid = el.getAttribute('title').replace('Click to copy full CID', el.textContent);
      navigator.clipboard.writeText(cid).then(() => {
        showNotification('CID copied to clipboard', 'success');
      });
    });
  });
});
