function enhanceFormFields() {
      const labels = {
        url:'Meeting link',
        'new-task-action':'Task','new-task-assignee':'Assignee','new-task-due':'Due note',
        'new-task-destination':'Slack destination',
        'new-task-scheduled':'Schedule','new-task-recurrence':'Recurrence',
        'new-approved-userid':'Slack user ID','new-approved-name':'Display name'
      };
      Object.entries(labels).forEach(([id, text]) => {
        const control = document.getElementById(id);
        if (!control || control.closest('.field-group')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'field-group';
        const label = document.createElement('label');
        label.className = 'field-label';
        label.htmlFor = id;
        label.textContent = text;
        control.parentNode.insertBefore(wrapper, control);
        wrapper.appendChild(label);
        wrapper.appendChild(control);
      });
      document.querySelectorAll('.toast').forEach(toast => {
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
      });
    }

    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openCommandPalette();
      } else if (event.key === 'Escape') {
        closeCommandPalette();
        closeMobileNav();
      }
    });

    window.addEventListener('hashchange', () => {
      const view = location.hash.slice(1);
      if (pageMeta[view] && !document.getElementById('page-' + view).classList.contains('active')) showTab(view);
    });

    window.addEventListener('DOMContentLoaded', () => {
      const savedTheme = localStorage.getItem('nora-theme');
      const preferredTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      applyTheme(savedTheme || preferredTheme);
      enhanceFormFields();
      const oauth = new URLSearchParams(location.search);
      if (oauth.has('mcp_connected') || oauth.has('mcp_error')) {
        location.hash = 'admin';
        setTimeout(() => {
          const toast = document.getElementById('mcp-toast');
          toast.className = oauth.has('mcp_error') ? 'toast err' : 'toast ok';
          toast.textContent = oauth.get('mcp_error') || 'MCP authorization complete. The connection was tested and its tools are ready.';
          history.replaceState({}, '', '/#admin');
        }, 0);
      }
      const initialView = location.hash.slice(1);
      showTab(pageMeta[initialView] ? initialView : 'tasks');
    });

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
