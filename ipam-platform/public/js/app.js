import { logout } from './core.js';
import { render } from './router.js';
import { setupAdminTabs } from './views/admin.js';

window.__logout = () => logout(true);

window.addEventListener('hashchange', render);
if (!location.hash) location.hash = '#/dashboard';
render();
const adminTabObserver = new MutationObserver(() => { if (document.querySelector('.tabs')) setupAdminTabs(); });
adminTabObserver.observe(document.body, { childList: true, subtree: true });
