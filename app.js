'use strict';

const $ = id => document.getElementById(id);
const make = (tag, text) => Object.assign(document.createElement(tag), text === undefined ? {} : { textContent: text });
const button = (text, action) => Object.assign(make('button', text), { onclick: action });
const ticks = date => date * 10000 + 621355968000000000;
const dateOf = value => new Date(Math.round((value - 621355968000000000) / 10000));
const workState = idea => idea.Done ? '完了' : idea.WorkState || '新規';
const states = ['新規', '進行中', '保留', '完了'];
function setWorkState(item, state) {
  item.Done = state === '完了';
  if (!item.Done) item.WorkState = state;
}
const titleOf = idea => idea.Title.trim() || '（無題）';
const fields = ['Title', 'Memo', 'Current', 'Goal', 'Acceptance'];
const fresh = () => ({ Version: 1, Projects: [], Active: null });
const selected = new Set();
let db, book, sort = 'Updated', ascending = false;
let draggedTab, deletionFolder, deleting = false;
let historyState, undo = [], redo = [];
let driveBase = JSON.parse(localStorage.getItem('ideamemo-drive-base') || 'null');
let driveAuto = false, driveTimer, driveBusy = false, drivePending = false;
function rememberDrive(base) {
  driveBase = base;
  localStorage.setItem('ideamemo-drive-base', JSON.stringify(base && { id: base.id, version: base.version }));
}
let config = { driveId: '', port: 11434, model: '', ...JSON.parse(localStorage.getItem('ideamemo-settings') || '{}') };
const app = () => book.Projects.find(p => p.Id === book.Active);
const idea = () => app()?.Ideas.find(i => i.Id === app().Focus);
const notify = text => { $('message').textContent = text; };
const fail = error => notify(error.message || String(error));
const safe = fn => async (...args) => { try { await fn(...args); } catch (error) { fail(error); } };

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('IdeaMemo', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readDb(key = 'data') {
  return new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function chooseDeletionFolder() {
  if (!window.showDirectoryPicker) throw new Error('削除バックアップ先の指定には、ChromeまたはEdgeの対応バージョンを使ってください。');
  let folder;
  try {
    folder = await window.showDirectoryPicker({ id: 'idea-deletion-backups', mode: 'readwrite' });
  } catch (error) {
    if (error.name === 'AbortError') return;
    throw error;
  }
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.objectStore('workspace').put(folder, 'deletion-folder');
  });
  deletionFolder = folder;
  notify('削除バックアップ先：' + folder.name);
}

async function backupAndDelete(project, items) {
  if (deleting || !items.length) return;
  deleting = true;
  try {
    if (!deletionFolder) {
      await chooseDeletionFolder();
      if (!deletionFolder) return;
    }
    const options = { mode: 'readwrite' };
    if (await deletionFolder.queryPermission(options) !== 'granted' &&
        await deletionFolder.requestPermission(options) !== 'granted') throw new Error('削除バックアップ先への書き込みが許可されていません。');
    const data = {
      Version: 1, Active: project.Id,
      Projects: [{ Id: project.Id, Name: project.Name, Context: project.Context, Groups: project.Groups, Ideas: items, History: [] }]
    };
    const name = 'IdeaMemo-deleted-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID() + '.json';
    const file = await deletionFolder.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    try {
      await writer.write(JSON.stringify(data));
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    if (!book.Projects.includes(project) || items.some(item => !project.Ideas.includes(item))) return;
    const ids = new Set(items.map(item => item.Id));
    project.Ideas = project.Ideas.filter(item => !ids.has(item.Id));
    if (ids.has(project.Focus)) project.Focus = null;
    for (const id of ids) selected.delete(id);
    render();
    await save();
    notify(items.length + ' 件をバックアップして削除しました。');
  } finally {
    deleting = false;
  }
}

function save(value = book) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.oncomplete = () => { if (value === book) scheduleDrive(); resolve(); };
    transaction.onabort = () => reject(transaction.error || new Error('自動保存に失敗しました。'));
    transaction.objectStore('workspace').put(value, 'data');
    if (value === book) captureHistory();
  });
}

function contentState() {
  return JSON.stringify(book.Projects.map(({ Focus, ...project }) => project));
}

function captureHistory() {
  const next = contentState();
  if (next === historyState) return;
  if (historyState !== undefined) undo.push(historyState);
  if (undo.length > 20) undo.shift();
  redo.length = 0;
  historyState = next;
  refreshHistory();
}

function refreshHistory() {
  $('undo').disabled = !undo.length;
  $('redo').disabled = !redo.length;
}

async function moveHistory(forward) {
  const source = forward ? redo : undo;
  const target = forward ? undo : redo;
  if (!source.length) return;
  target.push(historyState);
  historyState = source.pop();
  const focus = new Map(book.Projects.map(p => [p.Id, p.Focus]));
  book.Projects = JSON.parse(historyState);
  for (const p of book.Projects) p.Focus = focus.get(p.Id);
  validate(book);
  selected.clear();
  render();
  refreshHistory();
  await save();
  notify(forward ? 'やり直しました。' : '元に戻しました。');
}

function validate(value) {
  if (value?.Version !== 1 || !Array.isArray(value.Projects) || value.Projects.some(p =>
    typeof p?.Id !== 'string' || typeof p.Name !== 'string' || !Array.isArray(p.Groups) ||
    !Array.isArray(p.History) || !Array.isArray(p.Ideas) || p.Ideas.some(i =>
      typeof i?.Id !== 'string' || typeof i.Title !== 'string' || !Array.isArray(i.Images) ||
      i.Images.some(a => typeof a?.Name !== 'string' || typeof a.Data !== 'string')))) {
    throw new Error('IdeaMemoのバックアップ形式ではありません。');
  }
  if (!value.Projects.some(p => p.Id === value.Active)) value.Active = value.Projects[0]?.Id || null;
  return value;
}

async function replace(value) {
  const next = validate(value);
  if (book.Projects.length && !confirm('現在の内容を読み込んだデータで置き換えますか？')) return false;
  // Keep device-specific preferences on the receiving device.
  next.Ollama = book.Ollama;
  next.Model = book.Model;
  await save(next);
  book = next;
  captureHistory();
  selected.clear();
  render();
  return true;
}

function option(value, label = value) {
  return Object.assign(make('option', label), { value });
}

function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  Object.assign(make('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function render(rebuildTabs = true) {
  const project = app();
  const tabs = book.Projects.map(p => {
    const tab = button(p.Name, safe(async () => {
      book.Active = p.Id;
      selected.clear();
      $('app-settings').open = false;
      for (const tabButton of $('tabs').querySelectorAll('[aria-current]')) {
        tabButton.setAttribute('aria-current', String(tabButton === tab));
      }
      render(false);
      await save();
    }));
    tab.setAttribute('aria-current', String(p === project));
    tab.title = 'ダブルクリックでアプリ名を変更';
    tab.draggable = true;
    tab.ondragstart = event => {
      draggedTab = p.Id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', p.Id);
    };
    tab.ondragover = event => {
      if (!draggedTab || draggedTab === p.Id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      tab.classList.add('drop-target');
    };
    tab.ondragleave = () => tab.classList.remove('drop-target');
    tab.ondragend = () => { draggedTab = null; };
    tab.ondrop = safe(async event => {
      event.preventDefault();
      tab.classList.remove('drop-target');
      const source = book.Projects.findIndex(project => project.Id === draggedTab);
      const target = book.Projects.indexOf(p);
      draggedTab = null;
      if (source < 0 || target < 0 || source === target) return;
      book.Projects.splice(target, 0, book.Projects.splice(source, 1)[0]);
      render();
      await save();
    });
    tab.ondblclick = () => {
      const input = Object.assign(make('input'), { value: p.Name });
      const rename = safe(async () => {
        const next = input.value.trim();
        if (!next) { input.focus(); return; }
        p.Name = next;
        render();
        await save();
        $('dialog').close();
      });
      modal('アプリ名の変更', labeled('アプリ名', input), button('保存', rename));
      input.onkeydown = e => { if (e.key === 'Enter') rename(); };
      input.focus();
      input.select();
    };
    return tab;
  });
  const add = button('＋', safe(async () => {
    const Name = prompt('アプリ名')?.trim();
    if (!Name) return;
    const Id = crypto.randomUUID();
    book.Projects.push({ Id, Name, Context: '', Focus: null, Groups: [], Ideas: [], History: [] });
    book.Active = Id;
    selected.clear();
    render();
    await save();
  }));
  add.setAttribute('aria-label', 'アプリを追加');
  if (rebuildTabs) $('tabs').replaceChildren(...tabs, add);
  $('workspace').hidden = !project;
  if (!project) return;
  $('app-name').value = project.Name;
  $('context').value = project.Context || '';
  const groupFilter = $('group-filter').value;
  $('group-filter').replaceChildren(option('','すべてのグループ'), option('@none','未分類'), ...project.Groups.map(g => option(g)));
  $('group-filter').value = [...$('group-filter').options].some(o => o.value === groupFilter) ? groupFilter : '';
  renderEditor();
  renderRows();
}

function visibleIdeas() {
  const terms = $('search').value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filters = new Set([...$('state-filters').querySelectorAll('input:checked')].map(input => input.value));
  const group = $('group-filter').value;
  const photo = $('image-filter').value;
  const start = $('from').value;
  const end = $('to').value;
  return app().Ideas.filter(i => {
    const text = fields.map(key => i[key]).join('\n').toLocaleLowerCase();
    const stamp = i[$('date-field').value];
    const date = stamp ? dateOf(stamp) : null;
    return terms.every(term => text.includes(term)) &&
      (!filters.size || filters.has(workState(i)) || filters.has(i.Exported ? '出力済' : '未出力')) &&
      (!group || (group === '@none' ? !i.Group : group === i.Group)) &&
      (!photo || (photo === 'yes') === Boolean(i.Images.length)) &&
      (!$('changed').checked || (i.Exported && i.Updated > i.Exported)) &&
      (!start || (date && date >= new Date(start + 'T00:00:00'))) &&
      (!end || (date && date <= new Date(end + 'T23:59:59.999')));
  }).sort((a, b) => {
    if (sort === 'Group' && Boolean(a.Group) !== Boolean(b.Group)) return a.Group ? -1 : 1;
    const key = i => sort === 'WorkState' ? workState(i) : i[sort];
    const cmp = sort === 'Updated' ? key(a) - key(b) : String(key(a) || '').localeCompare(String(key(b) || ''), 'ja');
    return (ascending ? cmp : -cmp) || a.Title.localeCompare(b.Title, 'ja');
  });
}

function renderRows() {
  const shown = visibleIdeas();
  $('all').checked = shown.length > 0 && shown.every(i => selected.has(i.Id));
  $('all').indeterminate = !$('all').checked && shown.some(i => selected.has(i.Id));
  $('rows').replaceChildren(...shown.map(i => {
    const row = make('tr');
    row.setAttribute('aria-selected', String(i === idea()));
    const focus = safe(async () => { app().Focus = i.Id; renderEditor(); renderRows(); await save(); });
    row.onclick = focus;
    const checked = (label, value, change) => {
      const input = Object.assign(make('input'), { type: 'checkbox', checked: value });
      input.setAttribute('aria-label', label + ' ' + titleOf(i));
      input.onclick = e => e.stopPropagation();
      input.onchange = change;
      const cell = make('td');
      cell.append(input);
      return cell;
    };
    const title = make('td');
    title.append(button(titleOf(i), e => { e.stopPropagation(); focus(); }));
    const state = make('select');
    state.setAttribute('aria-label', '状態 ' + titleOf(i));
    state.title = i.Updated > i.Exported && i.Exported ? '出力後に編集あり' : i.Exported ? '出力済' : '未出力';
    state.replaceChildren(...states.map(value => option(value)));
    state.value = workState(i);
    state.onclick = e => e.stopPropagation();
    state.onchange = safe(async e => {
      setWorkState(i, e.target.value);
      if (i === idea()) $('WorkState').value = workState(i);
      renderRows();
      await save();
    });
    const stateCell = make('td');
    stateCell.append(state);
    row.append(checked('選択', selected.has(i.Id), e => {
      if (e.target.checked) selected.add(i.Id);
      else selected.delete(i.Id);
      $('all').checked = shown.every(item => selected.has(item.Id));
      $('all').indeterminate = !$('all').checked && shown.some(item => selected.has(item.Id));
    }), title, make('td', i.Group || '未分類'), stateCell);
    return row;
  }));
}

function renderEditor() {
  const item = idea();
  $('editor').hidden = !item;
  if (!item) return;
  for (const key of fields) $(key).value = item[key] || '';
  $('Group').replaceChildren(option('', '未分類'), ...app().Groups.map(g => option(g)));
  $('Group').value = item.Group || '';
  $('WorkState').value = workState(item);
  $('attachments').replaceChildren(...item.Images.map(a => attachmentTile(a, safe(async () => {
    if (!confirm('この画像を削除しますか？')) return;
    item.Images.splice(item.Images.indexOf(a), 1);
    await touch(item);
    renderEditor();
  }))));
}

function attachmentTile(a, remove, caption = a.Name) {
  const figure = make('figure');
  const image = Object.assign(make('img'), { src: 'data:image/png;base64,' + a.Data, alt: caption });
  figure.append(image, make('figcaption', caption), button('画像コピー', safe(async () => {
    const png = fetch(image.src).then(r => r.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    notify('画像をコピーしました。');
  })));
  if (remove) figure.append(button('削除', remove));
  return figure;
}

async function touch(item) {
  item.Updated = ticks(Date.now());
  renderRows();
  await save();
}

async function addImages(files) {
  const item = idea();
  if (!item) return;
  const images = await Promise.all([...files].filter(f => f.type.startsWith('image/')).map(async file => {
    const bitmap = await createImageBitmap(file);
    const canvas = Object.assign(make('canvas'), { width: bitmap.width, height: bitmap.height });
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return { Name: file.name, Data: canvas.toDataURL('image/png').split(',')[1] };
  }));
  if (!images.length || !app()?.Ideas.includes(item)) return;
  item.Images.push(...images);
  await touch(item);
  if (item === idea()) renderEditor();
}

function modal(title, ...content) {
  $('dialog-body').replaceChildren(make('h2', title), ...content);
  if (!$('dialog').open) $('dialog').showModal();
}

function ollamaPath(path) { return 'http://127.0.0.1:' + config.port + '/api/' + path; }
async function ollama(path, body) {
  const response = await fetch(ollamaPath(path), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw new Error('Ollama HTTP ' + response.status);
  return response.json();
}

async function modelList() {
  const answer = await ollama('tags');
  return Promise.all(answer.models.filter(m => !m.remote_host && !m.remote_model && !/[-:]cloud$/i.test(m.name)).map(async m => {
    const detail = await ollama('show', { model: m.name }).catch(() => ({}));
    return { name: m.name, vision: detail.capabilities?.includes('vision'), usable: !detail.capabilities || detail.capabilities.includes('completion') };
  }));
}

function makeDraft(project, items) {
  const lines = ['# ' + project.Name + ' の改修依頼'];
  if (project.Context) lines.push('', '## 共通情報', project.Context);
  let index = 0;
  for (const i of items) {
    lines.push('', '## ' + titleOf(i));
    for (const [key, label] of [['Memo','メモ'], ['Current','現状'], ['Goal','こうしてほしい'], ['Acceptance','完了条件']]) {
      if (i[key]) lines.push('', '### ' + label, i[key]);
    }
    for (const a of i.Images) lines.push('- 添付' + ++index + '：' + a.Name);
  }
  return lines.join('\n');
}

function promptDialog() {
  const project = app();
  const shown = visibleIdeas();
  const items = [...shown, ...project.Ideas.filter(i => !shown.includes(i))].filter(i => selected.has(i.Id));
  if (!items.length) { notify('一覧で出力する項目をチェックしてください。'); return; }
  const draft = Object.assign(make('textarea'), { rows: 12, value: makeDraft(project, items) });
  const model = make('select');
  model.setAttribute('aria-label', 'Ollamaモデル');
  const sequence = make('ol');
  const images = make('div');
  images.className = 'attachments';
  function update() {
    sequence.replaceChildren(...items.map((item, index) => {
      const li = make('li', titleOf(item) + ' ');
      function move(delta) {
        items.splice(index, 1);
        items.splice(index + delta, 0, item);
        draft.value = makeDraft(project, items);
        update();
      }
      if (index > 0) li.append(button('↑', () => move(-1)));
      if (index < items.length - 1) li.append(button('↓', () => move(1)));
      return li;
    }));
    images.replaceChildren(...items.flatMap(i => i.Images).map((a, index) => attachmentTile(a, null, '添付' + (index + 1) + '：' + a.Name)));
  }
  update();
  let models = [];
  const reload = safe(async () => {
    models = (await modelList()).filter(m => m.usable);
    model.replaceChildren(...models.map(m => option(m.name, m.name + (m.vision ? ' — 画像入力対応' : ''))));
    if (models.some(m => m.name === config.model)) model.value = config.model;
    notify(models.length ? 'モデルを取得しました。' : 'ローカルモデルがありません。');
  });
  const generate = button('Ollamaで生成', safe(async () => {
    const picked = models.find(m => m.name === model.value);
    if (!picked) throw new Error('Ollamaのモデルを取得してください。');
    generate.disabled = true;
    notify('生成中…');
    try {
      const user = { role: 'user', content: makeDraft(project, items) };
      if (picked.vision) user.images = items.flatMap(i => i.Images.map(a => a.Data));
      const answer = await ollama('chat', { model: picked.name, stream: false, messages: [
        { role: 'system', content: '日本語の実装プロンプトをMarkdownで作成してください。元の仕様と添付番号を維持し、原文にない仕様を追加しないでください。' }, user
      ] });
      if (!answer.message?.content?.trim()) throw new Error('生成結果が空です。');
      draft.value = answer.message.content;
      notify('生成しました。');
    } finally { generate.disabled = false; }
  }));
  async function record() {
    const Time = ticks(Date.now());
    items.forEach(i => { i.Exported = Time; });
    project.History.unshift({ Time, Text: draft.value, Titles: items.map(titleOf) });
    renderRows();
    await save();
  }
  modal('プロンプト作成', sequence, model, button('モデル取得', reload), generate, draft,
    button('コピーして出力済にする', safe(async () => { await navigator.clipboard.writeText(draft.value); await record(); })),
    button('Markdown保存', safe(async () => { download('prompt.md', draft.value, 'text/markdown'); await record(); })), images);
  reload();
}

function labeled(text, field) {
  const label = make('label', text);
  label.append(field);
  return label;
}

function settingsDialog() {
  const port = Object.assign(make('input'), { type: 'number', min: '1', max: '65535', value: config.port });
  const model = Object.assign(make('input'), { value: config.model });
  modal('Ollama設定', labeled('Ollama 接続ポート', port),
    labeled('通常使うモデル名', model), button('保存', () => {
      if (!port.value || !port.checkValidity()) { port.reportValidity(); return; }
      config = { ...config, port: Number(port.value), model: model.value.trim() };
      localStorage.setItem('ideamemo-settings', JSON.stringify(config));
      $('dialog').close();
    }));
}

let token, tokenClient, lastClientId, expires = 0;
function loadGoogle() {
  if (window.google?.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = Object.assign(make('script'), { src: 'https://accounts.google.com/gsi/client', onload: resolve,
      onerror: () => { script.remove(); reject(new Error('Googleログインを読み込めませんでした。')); } });
    document.head.append(script);
  });
}

function authorize() {
  if (lastClientId === config.driveId && token && Date.now() < expires) return Promise.resolve(token);
  return new Promise((resolve, reject) => {
    lastClientId = config.driveId;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: config.driveId, scope: 'https://www.googleapis.com/auth/drive.file',
      callback: response => {
        if (!response.access_token) { reject(new Error(response.error || 'Googleログインに失敗しました。')); return; }
        token = response.access_token;
        expires = Date.now() + (Number(response.expires_in) - 30) * 1000;
        resolve(token);
      },
      error_callback: error => reject(new Error(error.type || 'Googleログインを開けませんでした。'))
    });
    tokenClient.requestAccessToken();
  });
}

async function driveRequest(access, url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + access } });
  if (!response.ok) {
    if (response.status === 401) token = null;
    throw new Error('Google Drive HTTP ' + response.status);
  }
  return response.json();
}

async function uploadDrive(access, upload, item, name, snapshot = JSON.stringify(book), folder = null) {
  const url = upload + (item ? '/' + encodeURIComponent(item.id) : '') + '?uploadType=resumable&fields=id,version';
  const response = await fetch(url, {
    method: item ? 'PATCH' : 'POST',
    headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/json' },
    body: JSON.stringify(item ? {} : folder ? { name, parents: [folder] } : { name })
  });
  if (response.status === 401) token = null;
  const location = response.headers.get('Location');
  if (!response.ok || !location || new URL(location).origin !== 'https://www.googleapis.com')
    throw new Error('Google Driveのアップロードを開始できませんでした（HTTP ' + response.status + '）。');
  return driveRequest(access, location, { method: 'PUT', body: snapshot, headers: { 'Content-Type': 'application/json' } });
}

const driveFiles = 'https://www.googleapis.com/drive/v3/files';
const driveUpload = 'https://www.googleapis.com/upload/drive/v3/files';
const driveName = 'IdeaMemo.workspace.json';
const folderType = 'application/vnd.google-apps.folder';

async function findDriveFile(access, query) {
  const params = new URLSearchParams({ q: 'trashed = false and ' + query, fields: 'files(id,version)', orderBy: 'modifiedTime desc' });
  return (await driveRequest(access, driveFiles + '?' + params)).files[0];
}

async function createDriveFolder(access) {
  const parent = await findDriveFile(access, "mimeType = '" + folderType + "' and name = 'プライベート' and 'root' in parents");
  const metadata = { name: 'IdeaMemo', mimeType: folderType, appProperties: { ideamemoFolder: 'workspace' } };
  if (parent) metadata.parents = [parent.id];
  return driveRequest(access, driveFiles, { method: 'POST', body: JSON.stringify(metadata), headers: { 'Content-Type': 'application/json' } });
}

function scheduleDrive() {
  if (!driveAuto || !driveBase || contentState() === driveBase.content) return;
  drivePending = true;
  clearTimeout(driveTimer);
  driveTimer = setTimeout(autoDriveSave, 3000);
}

async function autoDriveSave() {
  if (driveBusy || !drivePending || !driveAuto) return;
  driveBusy = true;
  drivePending = false;
  try {
    if (!token || Date.now() >= expires) throw new Error('設定 → Google Driveで再接続してください。');
    const current = await driveRequest(token, driveFiles + '/' + encodeURIComponent(driveBase.id) + '?fields=id,version,trashed');
    if (!current.version || current.trashed || current.version !== driveBase.version)
      throw new Error('Drive側が更新されています。設定から読み込み、または保存し直してください。');
    const snapshot = JSON.stringify(book);
    const content = contentState();
    if (content === driveBase.content) return;
    const result = await uploadDrive(token, driveUpload, driveBase, driveName, snapshot);
    if (!result.version) throw new Error('Driveの更新番号を取得できませんでした。');
    rememberDrive({ ...result, content });
    notify('Google Driveに自動保存しました。');
  } catch (error) {
    driveAuto = false;
    notify('Drive自動保存を停止しました。 ' + error.message);
  } finally {
    driveBusy = false;
    scheduleDrive();
  }
}

async function driveDialog() {
  const input = Object.assign(make('input'), { value: config.driveId });
  const auto = Object.assign(make('input'), { type: 'checkbox', checked: driveAuto || localStorage.getItem('ideamemo-drive-auto') === '1' });
  auto.onchange = () => {
    localStorage.setItem('ideamemo-drive-auto', auto.checked ? '1' : '0');
    driveAuto = auto.checked && Boolean(driveBase && token && Date.now() < expires);
    if (driveAuto) scheduleDrive();
    else if (auto.checked) status.textContent = '先にDriveへ保存するか、Driveから読み込んでください。';
  };
  const status = make('p', 'Googleログインを読み込んでいます…');
  modal('Google Drive設定', labeled('Google OAuth WebクライアントID', input), labeled('Google Driveに自動保存', auto), status);
  await loadGoogle();
  async function transfer(write) {
    if (driveBusy) { status.textContent = 'Google Driveに保存中です。'; return; }
    if (!input.value.trim()) { status.textContent = 'WebクライアントIDを入力してください。'; return; }
    if (config.driveId !== input.value.trim()) { driveAuto = false; rememberDrive(null); }
    config.driveId = input.value.trim();
    localStorage.setItem('ideamemo-settings', JSON.stringify(config));
    driveBusy = true;
    try {
      const access = await authorize();
      status.textContent = 'Google Driveに接続しています…';
      if (write === null) {
        if (!driveBase?.id || !driveBase.version) throw new Error('先にDriveへ保存するか、Driveから読み込んでください。');
        const file = await driveRequest(access, driveFiles + '/' + encodeURIComponent(driveBase.id) + '?fields=id,version,trashed');
        if (file.trashed || file.version !== driveBase.version) throw new Error('Drive側が更新されています。内容を確認して読み込み、または保存し直してください。');
        driveAuto = auto.checked;
        status.textContent = driveAuto ? '接続しました。自動保存が有効です。' : '接続しました。';
        return;
      }
      let folder = await findDriveFile(access, "mimeType = '" + folderType + "' and appProperties has { key='ideamemoFolder' and value='workspace' }");
      let item = folder && await findDriveFile(access, "name = '" + driveName + "' and '" + folder.id + "' in parents");
      const legacy = !write && !item;
      if (legacy) item = await findDriveFile(access, "name = '" + driveName + "' and 'root' in parents");
      if (!write) {
        if (!item) { status.textContent = 'Google DriveにIdeaMemoのデータがありません。'; return; }
        const incoming = await driveRequest(access, driveFiles + '/' + encodeURIComponent(item.id) + '?alt=media');
        if (!await replace(incoming)) { status.textContent = '読み込みをキャンセルしました。'; return; }
        rememberDrive(legacy ? null : { ...item, content: contentState() });
        status.textContent = legacy ? '旧保存先から読み込みました。「Driveに保存」でIdeaMemoフォルダーへ保存してください。' : '読み込みました。';
      } else {
        if (item && !confirm('Google DriveのIdeaMemoデータをこの端末の内容で置き換えますか？')) { status.textContent = '保存をキャンセルしました。'; return; }
        if (!folder) folder = await createDriveFolder(access);
        const content = contentState();
        const result = await uploadDrive(access, driveUpload, item, driveName, JSON.stringify(book), folder.id);
        rememberDrive({ ...result, content });
        status.textContent = '保存しました。';
      }
      driveAuto = auto.checked && Boolean(driveBase?.id && driveBase?.version);
      drivePending = false;
    } catch (error) { status.textContent = error.message; }
    finally { driveBusy = false; scheduleDrive(); }
  }
  status.textContent = '保存または読み込みを選択してください。';
  if ($('dialog').open && status.isConnected) $('dialog-body').append(button('接続・再接続', () => transfer(null)),
    button('Driveに保存', () => transfer(true)), button('Driveから読み込み', () => transfer(false)));
}

safe(async () => {
  db = await openDb();
  book = validate(await readDb() || fresh());
  deletionFolder = await readDb('deletion-folder');
  $('deletion-folder').onclick = safe(chooseDeletionFolder);
  $('state-filters').replaceChildren(...[...states, '未出力', '出力済'].map(state => {
    const input = Object.assign(make('input'), { type: 'checkbox', value: state, onchange: renderRows });
    input.setAttribute('aria-label', state);
    const label = Object.assign(make('label'), { className: 'inline' });
    label.append(input, state);
    return label;
  }));
  historyState = contentState();
  refreshHistory();
  $('undo').onclick = safe(() => moveHistory(false));
  $('redo').onclick = safe(() => moveHistory(true));
  document.addEventListener('keydown', safe(async event => {
    if ($('dialog').open || !(event.ctrlKey || event.metaKey) || event.altKey ||
        event.target.matches('input:not([type=checkbox]), textarea, [contenteditable=true]')) return;
    const key = event.key.toLowerCase();
    if (key === 'z' || key === 'y') {
      event.preventDefault();
      await moveHistory(key === 'y' || event.shiftKey);
    }
  }));
  $('close').onclick = () => $('dialog').close();
  $('backup').onclick = () => download('IdeaMemo.workspace.json', JSON.stringify(book));
  $('restore').onclick = () => $('import').click();
  $('import').onchange = safe(async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file && await replace(JSON.parse(await file.text()))) notify('読み込みました。');
  });
  $('settings').onclick = settingsDialog;
  $('cloud').onclick = safe(driveDialog);
  $('app-name').onchange = safe(async e => {
    app().Name = e.target.value.trim() || app().Name;
    render();
    await save();
  });
  $('context').oninput = safe(async e => { app().Context = e.target.value; await save(); });
  $('add').onclick = safe(async () => {
    const now = ticks(Date.now());
    const item = { Id: crypto.randomUUID(), Title: '', Memo: '', Current: '', Goal: '', Acceptance: '',
      Group: '', WorkState: '新規', Done: false, Created: now, Updated: now, Exported: 0, Images: [] };
    app().Ideas.push(item);
    app().Focus = item.Id;
    renderEditor(); renderRows();
    $('Title').focus();
    await save();
  });
  for (const key of [...fields, 'Group']) $(key).oninput = safe(async e => {
    const item = idea();
    if (item) { item[key] = e.target.value; await touch(item); }
  });
  $('WorkState').onchange = safe(async e => {
    const item = idea();
    setWorkState(item, e.target.value);
    renderRows(); await save();
  });
  $('groups').onclick = () => {
    const group = make('select');
    const refresh = () => group.replaceChildren(option('', 'グループを選択'), ...app().Groups.map(g => option(g)));
    refresh();
    const edit = action => safe(async () => {
      const old = group.value;
      if (action !== 'add' && !old) return;
      const name = action === 'remove' ? '' : prompt('グループ名', old)?.trim();
      if (action !== 'remove' && (!name || name === '@none' || app().Groups.includes(name))) return;
      if (action === 'remove' && !confirm('グループを削除し、所属項目を未分類に戻しますか？')) return;
      if (action !== 'add') {
        app().Groups = app().Groups.filter(g => g !== old);
        app().Ideas.filter(i => i.Group === old).forEach(i => { i.Group = name; });
      }
      if (name) app().Groups.push(name);
      refresh(); render(); await save();
    });
    modal('グループ管理', group, button('追加', edit('add')), button('名前変更', edit('rename')), button('削除', edit('remove')));
  };
  $('all').onchange = e => { for (const i of visibleIdeas()) { if (e.target.checked) selected.add(i.Id); else selected.delete(i.Id); } renderRows(); };
  for (const id of ['search','group-filter','image-filter','changed','date-field','from','to']) $(id).oninput = renderRows;
  for (const header of document.querySelectorAll('[data-sort]')) header.onclick = () => {
    ascending = sort === header.dataset.sort ? !ascending : true;
    sort = header.dataset.sort;
    renderRows();
  };
  $('delete').onclick = safe(async () => {
    if (!selected.size || !confirm('選択した ' + selected.size + ' 件を削除しますか？ 絞り込みで非表示の項目も含みます。')) return;
    const project = app();
    await backupAndDelete(project, project.Ideas.filter(i => selected.has(i.Id)));
  });
  $('bulk').onclick = () => {
    if (!selected.size) { notify('一覧で対象項目をチェックしてください。'); return; }
    const group = make('select');
    const state = make('select');
    group.setAttribute('aria-label', '変更するグループ');
    state.setAttribute('aria-label', '状態');
    group.replaceChildren(option('', '変更しない'), option('0', '未分類'), ...app().Groups.map((g, index) => option(String(index + 1), g)));
    state.replaceChildren(option('', '変更しない'), ...states.map(value => option(value)));
    modal('選択 ' + selected.size + ' 件を一括変更', labeled('グループ', group), labeled('状態', state), button('適用', safe(async () => {
      const project = app();
      for (const item of project.Ideas.filter(i => selected.has(i.Id))) {
        if (group.value) item.Group = Number(group.value) === 0 ? '' : project.Groups[Number(group.value) - 1];
        if (state.value) setWorkState(item, state.value);
      }
      await save();
      render();
      $('dialog').close();
    })));
  };
  $('images').onchange = safe(async e => { await addImages(e.target.files); e.target.value = ''; });
  $('drop').ondragover = e => e.preventDefault();
  $('drop').ondrop = safe(async e => { e.preventDefault(); await addImages(e.dataTransfer.files); });
  document.addEventListener('paste', safe(async e => {
    if (idea() && !$('dialog').open && [...e.clipboardData.files].some(f => f.type.startsWith('image/'))) {
      e.preventDefault();
      await addImages(e.clipboardData.files);
    }
  }));
  $('prompt').onclick = promptDialog;
  $('history').onclick = () => {
    const history = make('select');
    const output = Object.assign(make('textarea'), { rows: 12, readOnly: true });
    app().History.forEach((h, i) => history.append(option(String(i), dateOf(h.Time).toLocaleString() + ' ' + h.Titles.join('、'))));
    history.onchange = () => { output.value = app().History[Number(history.value)]?.Text || ''; };
    history.onchange();
    modal('出力履歴', history, output, button('コピー', safe(() => navigator.clipboard.writeText(output.value))));
  };
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(fail);
})();
