// ==UserScript==
// @name         VolunteerSignup CSV Task Importer
// @namespace    local.volunteersignup.importer
// @version      1.3
// @description  Import VolunteerSignup task rows from CSV or reset tasks to a TBC placeholder
// @match        https://volunteersignup.org/events/*
// @match        http://volunteersignup.org/events/*
// @match        https://www.volunteersignup.org/events/*
// @match        http://www.volunteersignup.org/events/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const CSRF_COOKIE_NAME = 'csrf_cookie_name';
  const CSRF_FORM_FIELD = 'csrf_test_name';

  const PLACEHOLDER_TASK = {
    what: 'TBC',
    when: 'TBC',
    count: 1
  };

  let parsedTasks = [];

  function getCookie(name) {
    const wanted = `${encodeURIComponent(name)}=`;

    return document.cookie
      .split(';')
      .map(v => v.trim())
      .find(v => v.startsWith(wanted))
      ?.slice(wanted.length) || '';
  }

  function getEventIdFromCurrentUrl() {
    const match = location.pathname.match(/^\/events\/[^/]+\/(\d+)(?:\/)?$/);

    if (!match) {
      throw new Error(
        `Could not determine event ID from current URL:\n${location.href}\n\n` +
        `Expected a URL like:\nhttps://volunteersignup.org/events/summary/744835`
      );
    }

    return match[1];
  }

  function resolveEditPath() {
    return `/events/edit/${getEventIdFromCurrentUrl()}`;
  }

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, '');

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];

      if (c === '"') {
        if (inQuotes && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        row.push(field);
        field = '';
      } else if ((c === '\n' || c === '\r') && !inQuotes) {
        if (c === '\r' && text[i + 1] === '\n') {
          i++;
        }

        row.push(field);

        if (row.some(v => v.trim() !== '')) {
          rows.push(row);
        }

        row = [];
        field = '';
      } else {
        field += c;
      }
    }

    row.push(field);

    if (row.some(v => v.trim() !== '')) {
      rows.push(row);
    }

    return rows;
  }

  function csvToTasks(rows) {
    if (!rows.length) {
      throw new Error('CSV is empty.');
    }

    const headers = rows[0].map(h => h.trim().toLowerCase());

    const whatIdx = headers.indexOf('what');
    const whenIdx = headers.indexOf('when');

    if (whatIdx === -1 || whenIdx === -1) {
      throw new Error('CSV must contain headers named "What" and "When".');
    }

    const tasks = [];

    for (const row of rows.slice(1)) {
      const what = (row[whatIdx] || '').trim();
      const when = (row[whenIdx] || '').trim();

      if (!what && !when) {
        continue;
      }

      if (!what || !when) {
        throw new Error(`Invalid row. Both What and When are required: ${JSON.stringify(row)}`);
      }

      tasks.push({
        what,
        when,
        count: 1
      });
    }

    if (!tasks.length) {
      throw new Error('No usable task rows found.');
    }

    return tasks;
  }

  async function getEditDocument(editUrl) {
    const res = await fetch(editUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch edit page: HTTP ${res.status}`);
    }

    const html = await res.text();

    return new DOMParser().parseFromString(html, 'text/html');
  }

  function getFormField(form, name) {
    const element = form?.elements?.[name];

    if (!element) {
      return '';
    }

    if (typeof element.value === 'string') {
      return element.value;
    }

    return '';
  }

  function normaliseKey(what, when) {
    return [
      String(what).trim().replace(/\s+/g, ' ').toLowerCase(),
      String(when).trim().replace(/\s+/g, ' ').toLowerCase()
    ].join('\u001f');
  }

  function extractExistingTaskIds(form) {
    const existing = new Map();

    for (let i = 0; i < 5000; i++) {
      const what = getFormField(form, `task_name_${i}`);
      const when = getFormField(form, `task_when_${i}`);
      const id = getFormField(form, `task_id_${i}`);

      if (!what && !when && !id) {
        if (i > 20) {
          break;
        }

        continue;
      }

      if (what && when && id) {
        const key = normaliseKey(what, when);

        if (!existing.has(key)) {
          existing.set(key, []);
        }

        existing.get(key).push(id);
      }
    }

    return existing;
  }

  function extractEventNameFromSignupPage() {
    const h1 = document.querySelector('h1');
    const text = h1?.textContent || '';

    const quoted = text.match(/"([^"]+)"/);
    if (quoted) {
      return quoted[1].trim();
    }

    return '';
  }

  async function getEditContext() {
    const editPath = resolveEditPath();
    const editUrl = new URL(editPath, location.origin).href;

    const doc = await getEditDocument(editUrl);

    const form =
      doc.querySelector(`form[action*="${editPath}"]`) ||
      doc.querySelector('form');

    if (!form) {
      throw new Error('Could not find the event edit form.');
    }

    const csrf =
      getCookie(CSRF_COOKIE_NAME) ||
      getFormField(form, CSRF_FORM_FIELD);

    if (!csrf) {
      throw new Error(
        `Could not find CSRF token from cookie "${CSRF_COOKIE_NAME}" ` +
        `or form field "${CSRF_FORM_FIELD}".`
      );
    }

    const eventName =
      getFormField(form, 'name') ||
      extractEventNameFromSignupPage();

    const description = getFormField(form, 'description');
    const curSignups = getFormField(form, 'cur_signups');

    if (!eventName) {
      throw new Error('Could not determine event name from the edit form.');
    }

    return {
      editUrl,
      form,
      csrf,
      eventName,
      description: description || '',
      curSignups: curSignups || ''
    };
  }

  function addTaskFields(body, task, index, existingTaskId = '') {
    body.set(`task_name_${index}`, task.what);

    if (existingTaskId) {
      body.set(`task_id_${index}`, existingTaskId);
    }

    body.set(`task_when_${index}`, task.when);
    body.set(`task_count_${index}`, String(task.count));
    body.set(`task_credit_${index}`, '');
  }

  async function buildPostBodyForTasks(tasks) {
    const ctx = await getEditContext();
    const existingIdsByKey = extractExistingTaskIds(ctx.form);

    const body = new URLSearchParams();

    body.set(CSRF_FORM_FIELD, ctx.csrf);
    body.set('name', ctx.eventName);
    body.set('description', ctx.description);

    tasks.forEach((task, i) => {
      const key = normaliseKey(task.what, task.when);
      const reusableIds = existingIdsByKey.get(key);
      const existingId = reusableIds?.shift() || '';

      addTaskFields(body, task, i, existingId);
    });

    body.set('cur_signups', ctx.curSignups);
    body.set('finished', 'FINISHED');

    return {
      editUrl: ctx.editUrl,
      body
    };
  }

  async function buildPostBodyForResetToTbc() {
    const ctx = await getEditContext();
    const existingIdsByKey = extractExistingTaskIds(ctx.form);

    const body = new URLSearchParams();

    body.set(CSRF_FORM_FIELD, ctx.csrf);
    body.set('name', ctx.eventName);
    body.set('description', ctx.description);

    /*
     * "Delete all records" behaviour:
     *
     * Submit exactly one task row:
     *
     *   task_name_0  = TBC
     *   task_when_0  = TBC
     *   task_count_0 = 1
     *
     * Existing non-TBC task rows are omitted from the POST body.
     * VolunteerSignup should then replace the event's task list with this
     * single placeholder row.
     */
    const key = normaliseKey(PLACEHOLDER_TASK.what, PLACEHOLDER_TASK.when);
    const reusableIds = existingIdsByKey.get(key);
    const existingId = reusableIds?.shift() || '';

    addTaskFields(body, PLACEHOLDER_TASK, 0, existingId);

    body.set('cur_signups', ctx.curSignups);
    body.set('finished', 'FINISHED');

    return {
      editUrl: ctx.editUrl,
      body
    };
  }

  async function postEditBody(editUrl, body) {
    console.log('[VolunteerSignup CSV Importer] POST URL:', editUrl);
    console.log('[VolunteerSignup CSV Importer] POST body:', body.toString());

    const res = await fetch(editUrl, {
      method: 'POST',
      credentials: 'include',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    const responseText = await res.text();

    if (!res.ok) {
      console.error(responseText);
      throw new Error(`POST failed: HTTP ${res.status}`);
    }

    return {
      finalUrl: res.url,
      responseText
    };
  }

  async function uploadTasks(tasks) {
    const { editUrl, body } = await buildPostBodyForTasks(tasks);
    return postEditBody(editUrl, body);
  }

  async function resetRecordsToTbc() {
    const { editUrl, body } = await buildPostBodyForResetToTbc();
    return postEditBody(editUrl, body);
  }

  function renderPreview(tasks) {
    const preview = document.querySelector('#vsi-preview');
    preview.textContent = '';

    const summary = document.createElement('p');
    summary.textContent =
      `Parsed ${tasks.length} individual signup slots. ` +
      `Duplicate What/When rows will be uploaded as separate VolunteerSignup rows.`;

    preview.appendChild(summary);

    const table = document.createElement('table');
    table.className = 'vsi-table';

    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>#</th><th>What</th><th>When</th><th>Count</th></tr>';
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    for (const [idx, task] of tasks.slice(0, 100).entries()) {
      const tr = document.createElement('tr');

      for (const value of [idx + 1, task.what, task.when, task.count]) {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    preview.appendChild(table);

    if (tasks.length > 100) {
      const more = document.createElement('p');
      more.textContent = `Showing first 100 of ${tasks.length} individual slots.`;
      preview.appendChild(more);
    }
  }

  async function handleFile(file) {
    const status = document.querySelector('#vsi-status');
    const uploadBtn = document.querySelector('#vsi-upload');

    status.textContent = `Reading ${file.name}...`;
    uploadBtn.disabled = true;

    const text = await file.text();
    const rows = parseCsv(text);

    parsedTasks = csvToTasks(rows);

    renderPreview(parsedTasks);

    status.textContent = 'CSV parsed. Review the preview, then upload.';
    uploadBtn.disabled = false;
  }

  function createUi() {
    const root = document.createElement('div');
    root.id = 'vsi-root';

    root.innerHTML = `
      <button id="vsi-open" type="button">Import CSV</button>

      <div id="vsi-modal" hidden>
        <div id="vsi-card">
          <div id="vsi-header">
            <strong>VolunteerSignup CSV Import</strong>
            <button id="vsi-close" type="button" aria-label="Close">×</button>
          </div>

          <p class="vsi-note">
            Current event ID is read from this page URL.
            Expected URL shape:
            <code>/events/summary/744835</code> or <code>/events/edit/744835</code>.
          </p>

          <p class="vsi-note">
            Drop a CSV with columns <code>What</code> and <code>When</code>.
            Each CSV row becomes one VolunteerSignup row with count <code>1</code>.
            Duplicate rows are preserved.
          </p>

          <p class="vsi-note">
            <strong>Delete all records</strong> resets the task list to one placeholder row:
            <code>TBC / TBC / 1</code>.
          </p>

          <div id="vsi-drop">
            <input id="vsi-file" type="file" accept=".csv,text/csv">
            <p>Drop CSV here, or click to choose a file.</p>
          </div>

          <div id="vsi-preview"></div>

          <div id="vsi-actions">
            <button id="vsi-upload" type="button" disabled>Upload CSV records</button>
            <button id="vsi-delete-all" type="button">Delete all records</button>
          </div>

          <p id="vsi-status"></p>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const css = document.createElement('style');

    css.textContent = `
      #vsi-open {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 999999;
        padding: 10px 14px;
        border: 0;
        border-radius: 5px;
        background: #2f75b5;
        color: white;
        font-weight: 600;
        cursor: pointer;
        font-family: Arial, sans-serif;
      }

      #vsi-modal {
        position: fixed;
        inset: 0;
        z-index: 999998;
        background: rgba(0, 0, 0, 0.45);
      }

      #vsi-card {
        width: min(900px, calc(100vw - 40px));
        max-height: calc(100vh - 40px);
        overflow: auto;
        margin: 20px auto;
        background: white;
        color: #222;
        border-radius: 6px;
        padding: 18px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
        font-family: Arial, sans-serif;
      }

      #vsi-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 18px;
        margin-bottom: 12px;
      }

      #vsi-close {
        border: 0;
        background: transparent;
        font-size: 28px;
        line-height: 1;
        cursor: pointer;
      }

      .vsi-note {
        margin: 0 0 12px 0;
      }

      #vsi-drop {
        border: 2px dashed #888;
        border-radius: 6px;
        padding: 22px;
        text-align: center;
        cursor: pointer;
        margin-bottom: 14px;
        background: #fafafa;
      }

      #vsi-drop.drag {
        background: #eef6ff;
        border-color: #2f75b5;
      }

      #vsi-file {
        display: none;
      }

      .vsi-table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 10px;
        font-size: 13px;
      }

      .vsi-table th,
      .vsi-table td {
        border: 1px solid #ddd;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
      }

      .vsi-table th {
        background: #f2f2f2;
      }

      #vsi-actions {
        margin-top: 14px;
        display: flex;
        gap: 10px;
        align-items: center;
      }

      #vsi-upload {
        padding: 9px 12px;
        background: #2f75b5;
        color: white;
        border: 0;
        border-radius: 4px;
        font-weight: 600;
        cursor: pointer;
      }

      #vsi-upload:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      #vsi-delete-all {
        padding: 9px 12px;
        background: #b00020;
        color: white;
        border: 0;
        border-radius: 4px;
        font-weight: 600;
        cursor: pointer;
      }

      #vsi-delete-all:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      #vsi-status {
        margin-top: 12px;
        white-space: pre-wrap;
      }
    `;

    document.head.appendChild(css);

    const modal = document.querySelector('#vsi-modal');
    const open = document.querySelector('#vsi-open');
    const close = document.querySelector('#vsi-close');
    const drop = document.querySelector('#vsi-drop');
    const fileInput = document.querySelector('#vsi-file');
    const uploadBtn = document.querySelector('#vsi-upload');
    const deleteAllBtn = document.querySelector('#vsi-delete-all');
    const status = document.querySelector('#vsi-status');

    open.addEventListener('click', () => {
      modal.hidden = false;

      try {
        const eventId = getEventIdFromCurrentUrl();
        status.textContent = `Detected event ID: ${eventId}`;
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    close.addEventListener('click', () => {
      modal.hidden = true;
    });

    drop.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
      if (!fileInput.files?.[0]) {
        return;
      }

      try {
        await handleFile(fileInput.files[0]);
      } catch (err) {
        console.error(err);
        status.textContent = `Error: ${err.message}`;
      }
    });

    drop.addEventListener('dragover', e => {
      e.preventDefault();
      drop.classList.add('drag');
    });

    drop.addEventListener('dragleave', () => {
      drop.classList.remove('drag');
    });

    drop.addEventListener('drop', async e => {
      e.preventDefault();
      drop.classList.remove('drag');

      const file = e.dataTransfer.files?.[0];

      if (!file) {
        return;
      }

      try {
        await handleFile(file);
      } catch (err) {
        console.error(err);
        status.textContent = `Error: ${err.message}`;
      }
    });

    uploadBtn.addEventListener('click', async () => {
      if (!parsedTasks.length) {
        return;
      }

      let eventId;

      try {
        eventId = getEventIdFromCurrentUrl();
      } catch (err) {
        status.textContent = `Upload blocked: ${err.message}`;
        return;
      }

      const ok = confirm(
        `Upload ${parsedTasks.length} individual signup slots to event ${eventId}?\n\n` +
        `Each CSV row will become a separate VolunteerSignup task row with count 1.\n` +
        `Duplicate What/When rows will NOT be consolidated.\n\n` +
        `This updates the event task list. Use only on the intended event.`
      );

      if (!ok) {
        return;
      }

      try {
        uploadBtn.disabled = true;
        deleteAllBtn.disabled = true;
        status.textContent = 'Uploading...';

        const result = await uploadTasks(parsedTasks);

        status.textContent =
          `Upload complete.\n\n` +
          `Final URL:\n${result.finalUrl}\n\n` +
          `Reload the signup page to verify.`;

      } catch (err) {
        console.error(err);
        status.textContent = `Upload failed: ${err.message}`;
      } finally {
        uploadBtn.disabled = parsedTasks.length === 0;
        deleteAllBtn.disabled = false;
      }
    });

    deleteAllBtn.addEventListener('click', async () => {
      let eventId;

      try {
        eventId = getEventIdFromCurrentUrl();
      } catch (err) {
        status.textContent = `Delete blocked: ${err.message}`;
        return;
      }

      const firstConfirm = confirm(
        `Reset event ${eventId} to a single placeholder record?\n\n` +
        `The resulting task list will be:\n\n` +
        `What:  TBC\n` +
        `When:  TBC\n` +
        `Count: 1\n\n` +
        `Existing task rows will be omitted from the edit POST. Continue?`
      );

      if (!firstConfirm) {
        return;
      }

      const typed = prompt(
        `Type RESET ${eventId} to confirm replacing all task rows with TBC / TBC / 1.`
      );

      if (typed !== `RESET ${eventId}`) {
        status.textContent = 'Reset cancelled. Confirmation text did not match.';
        return;
      }

      try {
        uploadBtn.disabled = true;
        deleteAllBtn.disabled = true;
        status.textContent = 'Resetting to TBC placeholder...';

        const result = await resetRecordsToTbc();

        parsedTasks = [];
        document.querySelector('#vsi-preview').textContent = '';

        status.textContent =
          `Reset request complete.\n\n` +
          `Final URL:\n${result.finalUrl}\n\n` +
          `Reload the signup page to verify that only TBC / TBC / 1 remains.`;

      } catch (err) {
        console.error(err);
        status.textContent = `Reset failed: ${err.message}`;
      } finally {
        uploadBtn.disabled = parsedTasks.length === 0;
        deleteAllBtn.disabled = false;
      }
    });
  }

  createUi();
})();
