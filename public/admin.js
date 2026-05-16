(function () {
  'use strict';

  const token = localStorage.getItem('lanvoice_token') || '';
  const usersBody = document.getElementById('users-body');
  const errorBox = document.getElementById('error');
  const whoami = document.getElementById('whoami');
  const reloadBtn = document.getElementById('reload-btn');
  const backBtn = document.getElementById('back-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const newUsername = document.getElementById('new-username');
  const newPassword = document.getElementById('new-password');
  const newRole = document.getElementById('new-role');
  const createUserBtn = document.getElementById('create-user-btn');

  let me = null;

  function showError(message) {
    errorBox.textContent = message || '';
    errorBox.classList.toggle('show', !!message);
  }

  function fmt(dateIso) {
    if (!dateIso) return '-';
    const d = new Date(dateIso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('de-DE');
  }

  async function api(path, options) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options && options.headers ? options.headers : {})
      }
    });

    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || 'Request fehlgeschlagen.');
    }
    return data;
  }

  function button(label, className, onClick, disabled) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (className) btn.className = className;
    if (disabled) btn.disabled = true;
    btn.addEventListener('click', onClick);
    return btn;
  }

  async function updateUser(userId, payload) {
    showError('');
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    await loadUsers();
  }

  async function deleteUser(userId) {
    showError('');
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    });
    await loadUsers();
  }

  async function createUser() {
    const username = (newUsername.value || '').trim();
    const password = newPassword.value || '';
    const role = newRole.value === 'admin' ? 'admin' : 'user';

    if (username.length < 3) {
      showError('Benutzername muss mindestens 3 Zeichen haben.');
      return;
    }
    if (password.length < 8) {
      showError('Passwort muss mindestens 8 Zeichen haben.');
      return;
    }

    showError('');
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role })
    });

    newUsername.value = '';
    newPassword.value = '';
    newRole.value = 'user';
    await loadUsers();
  }

  function rowFor(user) {
    const tr = document.createElement('tr');
    const isMe = me && me.id === user.id;

    const roleChip = `<span class="chip ${user.role}">${user.role}</span>`;
    const statusChip = `<span class="chip ${user.isActive ? 'on' : 'off'}">${user.isActive ? 'aktiv' : 'deaktiviert'}</span>`;

    tr.innerHTML = `
      <td data-label="User">${user.username}${isMe ? ' (du)' : ''}</td>
      <td data-label="Rolle">${roleChip}</td>
      <td data-label="Status">${statusChip}</td>
      <td data-label="Erstellt">${fmt(user.createdAt)}</td>
      <td data-label="Letzter Login">${fmt(user.lastLoginAt)}</td>
      <td data-label="Aktionen"><div class="row-actions"></div></td>
    `;

    const actions = tr.querySelector('.row-actions');
    actions.appendChild(button(
      user.role === 'admin' ? 'Zu User' : 'Zu Admin',
      '',
      () => updateUser(user.id, { role: user.role === 'admin' ? 'user' : 'admin' }),
      isMe
    ));

    actions.appendChild(button(
      user.isActive ? 'Deaktivieren' : 'Aktivieren',
      '',
      () => updateUser(user.id, { isActive: !user.isActive }),
      isMe
    ));

    actions.appendChild(button('PW Reset', '', async () => {
      const pw = prompt(`Neues Passwort für ${user.username} (min. 8 Zeichen):`);
      if (!pw) return;
      if (pw.length < 8) {
        showError('Passwort muss mindestens 8 Zeichen haben.');
        return;
      }
      await updateUser(user.id, { password: pw });
      alert('Passwort aktualisiert.');
    }, false));

    actions.appendChild(button(
      'Löschen',
      'danger',
      async () => {
        if (!confirm(`Nutzer ${user.username} wirklich löschen?`)) return;
        await deleteUser(user.id);
      },
      isMe
    ));

    return tr;
  }

  async function loadUsers() {
    const data = await api('/api/admin/users');
    usersBody.innerHTML = '';
    data.users.forEach(u => usersBody.appendChild(rowFor(u)));
  }

  async function bootstrap() {
    if (!token) {
      location.href = '/';
      return;
    }

    try {
      const meData = await api('/api/auth/me', { method: 'GET' });
      me = meData.user;
      if (me.role !== 'admin') {
        showError('Kein Admin-Zugriff.');
        whoami.textContent = `${me.username} (${me.role})`;
        usersBody.innerHTML = '';
        return;
      }
      whoami.textContent = `Eingeloggt als ${me.username} (${me.role})`;
      await loadUsers();
    } catch (err) {
      localStorage.removeItem('lanvoice_token');
      location.href = '/';
    }
  }

  reloadBtn.addEventListener('click', () => {
    bootstrap().catch((err) => showError(err.message));
  });

  backBtn.addEventListener('click', () => {
    location.href = '/';
  });

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('lanvoice_token');
    location.href = '/';
  });

  createUserBtn.addEventListener('click', () => {
    createUser().catch((err) => showError(err.message));
  });

  [newUsername, newPassword].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        createUser().catch((err) => showError(err.message));
      }
    });
  });

  bootstrap().catch((err) => showError(err.message));
})();
