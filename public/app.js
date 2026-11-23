import { buildOperationSQL, operationCatalog } from './sql.js';

const $ = (selector) => document.querySelector(selector);
const dynamicFields = $('#dynamic-fields');
const databaseSelect = $('#database-select');
const tableSelect = $('#table-select');
const systemDatabases = ['information_schema', 'mysql', 'performance_schema', 'sys'];
const dataTypes = ['INT', 'BIGINT', 'VARCHAR', 'CHAR', 'DECIMAL', 'FLOAT', 'DOUBLE', 'TEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'BOOLEAN'];
const operators = ['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL'];

const freshDataState = () => ({
  insert: { values: [] },
  select: { columns: [], conditions: [{ column: '', operator: '=', value: '' }], conjunction: 'AND', orderColumn: '', orderDirection: 'ASC', limit: 50 },
  update: { values: [], conditions: [{ column: '', operator: '=', value: '' }], conjunction: 'AND' },
  delete: { conditions: [{ column: '', operator: '=', value: '' }], conjunction: 'AND' },
});

const state = {
  connection: null,
  connected: false,
  serverInfo: null,
  databases: [],
  tables: [],
  activeDatabase: '',
  activeTable: '',
  category: 'database',
  action: 'createDatabase',
  createDatabase: { name: 'practice_db', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', ifNotExists: true },
  createTable: {
    table: 'students', ifNotExists: true,
    columns: [
      { name: 'id', type: 'INT', length: '', nullable: false, primaryKey: true, autoIncrement: true, unsigned: true },
      { name: 'name', type: 'VARCHAR', length: '100', nullable: false, primaryKey: false, autoIncrement: false, unsigned: false },
      { name: 'created_at', type: 'DATETIME', length: '', nullable: true, primaryKey: false, autoIncrement: false, unsigned: false },
    ],
  },
  ...freshDataState(),
  history: readHistory(),
};

function readHistory() {
  try {
    const value = JSON.parse(localStorage.getItem('mysql-workbench-history') || '[]');
    return Array.isArray(value) ? value.slice(0, 20) : [];
  } catch { return []; }
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const payload = await response.json().catch(() => ({ message: '服务返回了无法解析的响应' }));
  if (!response.ok) {
    const message = Array.isArray(payload.message) ? payload.message.join('；') : payload.message;
    const error = new Error(message || `请求失败 (${response.status})`);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function currentColumns() {
  return state.tables.find((table) => table.name === state.activeTable)?.columns || [];
}

function currentMeta() {
  return operationCatalog[state.category].find((item) => item.value === state.action);
}

function getOperation() {
  const database = state.activeDatabase;
  const table = state.activeTable;
  if (state.action === 'createDatabase') return { kind: state.action, ...state.createDatabase };
  if (state.action === 'connectDatabase') return { kind: state.action, database };
  if (state.action === 'createTable') return { kind: state.action, database, ...state.createTable };
  const operation = { kind: state.action, database, table, ...state[state.action] };
  if (state.action === 'insert' || state.action === 'update') {
    operation.values = operation.values.filter((item) => item.enabled).map(({ column, value }) => ({ column, value }));
  }
  return operation;
}

function highlightSQL(sql) {
  const pattern = /(`(?:``|[^`])*`|'(?:''|\\.|[^'])*'|\b(?:CREATE|DATABASE|IF|NOT|EXISTS|DEFAULT|CHARACTER|SET|COLLATE|USE|TABLE|PRIMARY|KEY|ENGINE|INNODB|CHARSET|INSERT|INTO|VALUES|SELECT|FROM|WHERE|AND|OR|ORDER|BY|ASC|DESC|LIMIT|UPDATE|DELETE|NULL|IS|LIKE|AUTO_INCREMENT|UNSIGNED|INT|BIGINT|VARCHAR|CHAR|DECIMAL|FLOAT|DOUBLE|TEXT|DATE|DATETIME|TIMESTAMP|BOOLEAN)\b|\b\d+(?:\.\d+)?\b|\?)/gi;
  let output = '';
  let cursor = 0;
  for (const match of sql.matchAll(pattern)) {
    output += escapeHTML(sql.slice(cursor, match.index));
    const token = match[0];
    const className = token.startsWith('`') ? 'sql-identifier'
      : token.startsWith("'") ? 'sql-string'
        : /^\d/.test(token) ? 'sql-number'
          : token === '?' ? 'sql-placeholder' : 'sql-keyword';
    output += `<span class="${className}">${escapeHTML(token)}</span>`;
    cursor = match.index + token.length;
  }
  return output + escapeHTML(sql.slice(cursor));
}

function updatePreview() {
  const sql = buildOperationSQL(getOperation());
  $('#sql-preview').innerHTML = highlightSQL(sql);
  $('#sql-lines').textContent = `${sql.split('\n').length} ${sql.split('\n').length === 1 ? 'LINE' : 'LINES'}`;
  const meta = currentMeta();
  $('#config-title').textContent = meta.title;
  $('#operation-code').textContent = meta.code;
  $('#learning-tip').textContent = meta.tip;
  $('#sql-explanation').textContent = meta.explanation;
  updateContext();
}

function updateContext() {
  $('#context-connection').textContent = state.connected ? `${state.connection.user}@${state.connection.host}` : '未连接';
  $('#context-database').textContent = state.activeDatabase || '—';
  $('#context-table').textContent = state.activeTable || '—';
}

function renderActions() {
  $('#category-select').value = state.category;
  $('#action-select').innerHTML = operationCatalog[state.category]
    .map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
  $('#action-select').value = state.action;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.category === state.category));
  configureTargetVisibility();
}

function configureTargetVisibility() {
  $('#database-field').hidden = state.action === 'createDatabase';
  $('#table-field').hidden = state.category !== 'data';
  $('#target-section').hidden = state.action === 'createDatabase';
}

function renderDatabaseOptions() {
  const options = state.databases.map((item) => {
    const name = typeof item === 'string' ? item : item.name;
    const isSystem = systemDatabases.includes(name);
    return `<option value="${escapeHTML(name)}" ${isSystem ? 'disabled' : ''}>${escapeHTML(name)}${isSystem ? '（系统库）' : ''}</option>`;
  });
  databaseSelect.innerHTML = `<option value="">选择数据库</option>${options.join('')}`;
  databaseSelect.value = state.activeDatabase;
  if (!databaseSelect.value) databaseSelect.value = '';
  renderTableOptions();
}

function renderTableOptions() {
  tableSelect.innerHTML = `<option value="">选择数据表</option>${state.tables.map((table) => `<option value="${escapeHTML(table.name)}">${escapeHTML(table.name)}</option>`).join('')}`;
  tableSelect.value = state.activeTable;
  if (!tableSelect.value) tableSelect.value = '';
}

function renderDynamic() {
  configureTargetVisibility();
  if (state.action === 'createDatabase') renderCreateDatabase();
  if (state.action === 'createTable') renderCreateTable();
  if (['insert', 'select', 'update', 'delete'].includes(state.action)) renderDataOperation();
  updatePreview();
}

function renderCreateDatabase() {
  const config = state.createDatabase;
  dynamicFields.innerHTML = `
    <div class="field-grid two-columns">
      <label class="field"><span>数据库名称</span><input data-state-key="name" value="${escapeHTML(config.name)}" placeholder="例如 practice_db" required /></label>
      <label class="field"><span>字符集</span><select data-state-key="charset"><option value="utf8mb4">utf8mb4（推荐）</option><option value="utf8">utf8</option><option value="latin1">latin1</option></select></label>
      <label class="field"><span>排序规则</span><select data-state-key="collation"><option value="utf8mb4_unicode_ci">utf8mb4_unicode_ci</option><option value="utf8mb4_general_ci">utf8mb4_general_ci</option><option value="utf8_unicode_ci">utf8_unicode_ci</option><option value="utf8_general_ci">utf8_general_ci</option><option value="latin1_swedish_ci">latin1_swedish_ci</option></select></label>
      <div class="field"><span>存在保护</span><label class="check-label option-box"><input type="checkbox" data-state-key="ifNotExists" ${config.ifNotExists ? 'checked' : ''}/>使用 IF NOT EXISTS</label></div>
    </div>
    <p class="field-hint">名称仅允许字母、数字和下划线，且不能以数字开头。</p>`;
  dynamicFields.querySelector('[data-state-key="charset"]').value = config.charset;
  dynamicFields.querySelector('[data-state-key="collation"]').value = config.collation;
}

function renderCreateTable() {
  const config = state.createTable;
  dynamicFields.innerHTML = `
    <div class="field-grid two-columns table-name-row">
      <label class="field"><span>数据表名称</span><input data-state-key="table" value="${escapeHTML(config.table)}" placeholder="例如 students" /></label>
      <div class="field"><span>存在保护</span><label class="check-label option-box"><input type="checkbox" data-state-key="ifNotExists" ${config.ifNotExists ? 'checked' : ''}/>使用 IF NOT EXISTS</label></div>
    </div>
    <div class="subsection-heading"><span>字段结构</span><button class="text-button" type="button" data-action="add-column"><svg><use href="#i-plus"/></svg>添加字段</button></div>
    <div class="schema-editor">
      <div class="schema-row schema-head"><span>字段名</span><span>类型</span><span>长度</span><span>允许 NULL</span><span>主键</span><span>自增</span><span>无符号</span><span></span></div>
      ${config.columns.map((column, index) => `
        <div class="schema-row">
          <input class="compact-input" aria-label="字段名" data-kind="column" data-index="${index}" data-key="name" value="${escapeHTML(column.name)}" />
          <select class="compact-input" aria-label="字段类型" data-kind="column" data-index="${index}" data-key="type">${dataTypes.map((type) => `<option ${column.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select>
          <input class="compact-input" aria-label="长度" data-kind="column" data-index="${index}" data-key="length" value="${escapeHTML(column.length)}" placeholder="—" />
          <input type="checkbox" aria-label="允许空值" data-kind="column" data-index="${index}" data-key="nullable" ${column.nullable ? 'checked' : ''}/>
          <input type="checkbox" aria-label="主键" data-kind="column" data-index="${index}" data-key="primaryKey" ${column.primaryKey ? 'checked' : ''}/>
          <input type="checkbox" aria-label="自增" data-kind="column" data-index="${index}" data-key="autoIncrement" ${column.autoIncrement ? 'checked' : ''}/>
          <input type="checkbox" aria-label="无符号" data-kind="column" data-index="${index}" data-key="unsigned" ${column.unsigned ? 'checked' : ''}/>
          <button class="icon-button remove-button" type="button" aria-label="删除字段" data-action="remove-column" data-index="${index}"><svg><use href="#i-trash"/></svg></button>
        </div>`).join('')}
    </div>
    <p class="field-hint">InnoDB / utf8mb4 · 长度适用于整数、字符串和小数类型；DECIMAL 可写 10,2。</p>`;
}

function resetValuesForSchema(action) {
  const values = currentColumns().map((column) => ({
    column: column.name,
    value: null,
    enabled: action === 'insert' ? !column.extra.includes('auto_increment') : false,
    isNull: false,
  }));
  state[action].values = values;
}

function renderDataOperation() {
  if (!state.activeDatabase || !state.activeTable) {
    dynamicFields.innerHTML = '<div class="empty-schema">先在上方选择目标数据库与数据表。若列表为空，请点击左侧“刷新结构”。</div>';
    return;
  }
  const columns = currentColumns();
  if (!columns.length) {
    dynamicFields.innerHTML = '<div class="empty-schema">未读取到字段结构，请刷新结构后重试。</div>';
    return;
  }
  if (state.action === 'insert' || state.action === 'update') {
    if (!state[state.action].values.length) resetValuesForSchema(state.action);
    dynamicFields.innerHTML = renderValueEditor(state.action, columns);
  }
  if (state.action === 'select') {
    dynamicFields.innerHTML = `
      <div class="subsection-heading"><span>返回字段</span><button type="button" class="text-button" data-action="clear-columns">全部字段 *</button></div>
      <div class="column-choices">${columns.map((column) => `<label class="check-label"><input type="checkbox" data-kind="select-column" value="${escapeHTML(column.name)}" ${state.select.columns.includes(column.name) ? 'checked' : ''}/>${escapeHTML(column.name)}</label>`).join('')}</div>
      ${renderConditions('select')}
      <div class="field-grid three-columns order-grid">
        <label class="field"><span>排序字段</span><select data-state-key="orderColumn"><option value="">不排序</option>${columns.map((column) => `<option value="${escapeHTML(column.name)}">${escapeHTML(column.name)}</option>`).join('')}</select></label>
        <label class="field"><span>排序方向</span><select data-state-key="orderDirection"><option>ASC</option><option ${state.select.orderDirection === 'DESC' ? 'selected' : ''}>DESC</option></select></label>
        <label class="field"><span>返回行数 LIMIT</span><input type="number" min="1" max="500" data-state-key="limit" value="${state.select.limit}" /></label>
      </div>`;
    dynamicFields.querySelector('[data-state-key="orderColumn"]').value = state.select.orderColumn;
  }
  if (state.action === 'update') dynamicFields.innerHTML += renderConditions('update', true);
  if (state.action === 'delete') dynamicFields.innerHTML = renderConditions('delete', true);
}

function renderValueEditor(action, columns) {
  const title = action === 'insert' ? '写入值（勾选需要插入的字段）' : '设置新值（勾选需要更新的字段）';
  return `<div class="subsection-heading"><span>${title}</span></div><div class="value-list">
    ${state[action].values.map((item, index) => {
      const schema = columns.find((column) => column.name === item.column);
      return `<div class="value-row">
        <label class="check-label value-name"><input type="checkbox" data-kind="value" data-index="${index}" data-key="enabled" ${item.enabled ? 'checked' : ''}/><code>${escapeHTML(item.column)}</code></label>
        <span class="value-type">${escapeHTML(schema?.columnType || '')}</span>
        <input class="compact-input" data-kind="value" data-index="${index}" data-key="value" value="${item.value === null ? '' : escapeHTML(item.value)}" placeholder="输入值" ${!item.enabled || item.isNull ? 'disabled' : ''}/>
        <label class="check-label"><input type="checkbox" data-kind="value" data-index="${index}" data-key="isNull" ${item.isNull ? 'checked' : ''} ${!item.enabled ? 'disabled' : ''}/>NULL</label>
      </div>`;
    }).join('')}</div>`;
}

function renderConditions(action, danger = false) {
  const config = state[action];
  return `${danger ? '<div class="danger-note"><svg><use href="#i-info"/></svg>安全保护：至少设置一个有效 WHERE 条件，避免整表变更。</div>' : ''}
    <div class="subsection-heading"><span>筛选条件 WHERE</span><button type="button" class="text-button" data-action="add-condition"><svg><use href="#i-plus"/></svg>添加条件</button></div>
    <div class="condition-list">${config.conditions.map((condition, index) => `
      <div class="condition-row">
        <select class="compact-input" aria-label="条件字段" data-kind="condition" data-index="${index}" data-key="column"><option value="">选择字段</option>${currentColumns().map((column) => `<option value="${escapeHTML(column.name)}" ${condition.column === column.name ? 'selected' : ''}>${escapeHTML(column.name)}</option>`).join('')}</select>
        <select class="compact-input" aria-label="比较符" data-kind="condition" data-index="${index}" data-key="operator">${operators.map((operator) => `<option ${condition.operator === operator ? 'selected' : ''}>${operator}</option>`).join('')}</select>
        <input class="compact-input" aria-label="条件值" data-kind="condition" data-index="${index}" data-key="value" value="${escapeHTML(condition.value)}" ${condition.operator.includes('NULL') ? 'disabled' : ''}/>
        <button class="icon-button remove-button" type="button" aria-label="删除条件" data-action="remove-condition" data-index="${index}"><svg><use href="#i-trash"/></svg></button>
      </div>`).join('')}</div>
    <label class="field conjunction-field"><span>多条件连接方式</span><select data-state-key="conjunction"><option ${config.conjunction === 'AND' ? 'selected' : ''}>AND</option><option ${config.conjunction === 'OR' ? 'selected' : ''}>OR</option></select></label>`;
}

function handleDynamicInput(event) {
  const target = event.target;
  const key = target.dataset.stateKey;
  if (key) {
    const source = state.action === 'createDatabase' ? state.createDatabase : state.action === 'createTable' ? state.createTable : state[state.action];
    source[key] = target.type === 'checkbox' ? target.checked : target.type === 'number' ? Number(target.value) : target.value;
    if (state.action === 'createDatabase' && key === 'charset') {
      const defaultCollations = { utf8mb4: 'utf8mb4_unicode_ci', utf8: 'utf8_unicode_ci', latin1: 'latin1_swedish_ci' };
      if (!state.createDatabase.collation.startsWith(`${state.createDatabase.charset}_`)) {
        state.createDatabase.collation = defaultCollations[state.createDatabase.charset];
      }
      renderDynamic();
      return;
    }
    updatePreview();
    return;
  }
  const kind = target.dataset.kind;
  const index = Number(target.dataset.index);
  if (kind === 'column') {
    state.createTable.columns[index][target.dataset.key] = target.type === 'checkbox' ? target.checked : target.value;
    updatePreview();
  }
  if (kind === 'value') {
    const item = state[state.action].values[index];
    const field = target.dataset.key;
    if (field === 'isNull') {
      item.isNull = target.checked;
      item.value = target.checked ? null : '';
      renderDynamic();
    } else {
      item[field] = target.type === 'checkbox' ? target.checked : target.value;
      if (field === 'enabled') item.isNull = false;
      updatePreview();
      if (field === 'enabled') renderDynamic();
    }
  }
  if (kind === 'condition') {
    state[state.action].conditions[index][target.dataset.key] = target.value;
    if (target.dataset.key === 'operator') renderDynamic();
    else updatePreview();
  }
}

dynamicFields.addEventListener('input', handleDynamicInput);
dynamicFields.addEventListener('change', handleDynamicInput);
dynamicFields.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'add-column') state.createTable.columns.push({ name: `field_${state.createTable.columns.length + 1}`, type: 'VARCHAR', length: '255', nullable: true, primaryKey: false, autoIncrement: false, unsigned: false });
  if (action === 'remove-column' && state.createTable.columns.length > 1) state.createTable.columns.splice(Number(button.dataset.index), 1);
  if (action === 'add-condition') state[state.action].conditions.push({ column: '', operator: '=', value: '' });
  if (action === 'remove-condition') state[state.action].conditions.splice(Number(button.dataset.index), 1);
  if (action === 'clear-columns') state.select.columns = [];
  if (action === 'clear-columns' || action.includes('condition') || action.includes('column')) renderDynamic();
});

$('#category-select').addEventListener('change', (event) => setCategory(event.target.value));
$('#action-select').addEventListener('change', (event) => {
  state.action = event.target.value;
  renderDynamic();
});

function setCategory(category) {
  state.category = category;
  state.action = operationCatalog[category][0].value;
  renderActions();
  renderDynamic();
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setCategory(button.dataset.category)));

$('#operation-form').addEventListener('submit', (event) => event.preventDefault());

databaseSelect.addEventListener('change', async () => {
  state.activeDatabase = databaseSelect.value;
  state.activeTable = '';
  state.tables = [];
  Object.assign(state, freshDataState());
  renderDynamic();
  if (state.activeDatabase) await loadMetadata();
});

tableSelect.addEventListener('change', () => {
  state.activeTable = tableSelect.value;
  Object.assign(state, freshDataState());
  renderDynamic();
});

function connectionFromForm() {
  const host = $('#connection-host').value.trim();
  const port = Number($('#connection-port').value);
  const user = $('#connection-user').value.trim();
  const password = $('#connection-password').value;
  if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请填写有效的主机、端口和用户名');
  return { host, port, user, password };
}

function setConnectionFeedback(message, type = '') {
  const feedback = $('#connection-feedback');
  feedback.textContent = message;
  feedback.className = `connection-feedback ${type}`;
}

async function testConnection() {
  let config;
  try { config = connectionFromForm(); }
  catch (error) { setConnectionFeedback(error.message, 'error'); return null; }
  const button = $('#test-connection');
  button.disabled = true;
  setConnectionFeedback('正在建立真实连接…');
  try {
    const result = await api('/api/connection/test', { method: 'POST', body: JSON.stringify({ connection: config }) });
    setConnectionFeedback(`连接成功 · ${result.serverVersion} · ${result.currentUser}`, 'success');
    return { config, result };
  } catch (error) {
    setConnectionFeedback(error.message, 'error');
    return null;
  } finally { button.disabled = false; }
}

$('#test-connection').addEventListener('click', testConnection);
$('#open-connection').addEventListener('click', () => $('#connection-dialog').showModal());
$('#close-connection').addEventListener('click', () => $('#connection-dialog').close());
$('#connection-dialog').addEventListener('click', (event) => {
  if (event.target === $('#connection-dialog')) $('#connection-dialog').close();
});

$('#connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#save-connection');
  submit.disabled = true;
  const tested = await testConnection();
  if (!tested) { submit.disabled = false; return; }
  state.connection = tested.config;
  state.serverInfo = tested.result;
  state.connected = true;
  state.activeDatabase = '';
  state.activeTable = '';
  state.tables = [];
  try {
    await loadMetadata();
    localStorage.setItem('mysql-workbench-connection', JSON.stringify({ host: state.connection.host, port: state.connection.port, user: state.connection.user }));
    $('#connection-label').textContent = `${state.connection.user}@${state.connection.host}`;
    $('#connection-dot').classList.add('connected');
    $('#connection-dialog').close();
    toast(`已连接 ${state.serverInfo.serverVersion}`);
  } catch (error) {
    state.connected = false;
    toast(error.message, true);
  } finally {
    submit.disabled = false;
    updateContext();
  }
});

async function loadMetadata() {
  if (!state.connection) { toast('请先连接数据库', true); return; }
  const refreshButton = $('#refresh-metadata');
  refreshButton.disabled = true;
  try {
    const result = await api('/api/metadata', {
      method: 'POST',
      body: JSON.stringify({ connection: state.connection, database: state.activeDatabase || undefined }),
    });
    state.databases = result.databases;
    state.tables = result.tables || [];
    if (state.activeTable && !state.tables.some((table) => table.name === state.activeTable)) state.activeTable = '';
    renderDatabaseOptions();
    renderDynamic();
  } catch (error) { toast(error.message, true); }
  finally { refreshButton.disabled = false; }
}

$('#refresh-metadata').addEventListener('click', loadMetadata);

function validateOperation(operation) {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (operation.kind === 'createDatabase' && !identifier.test(operation.name)) throw new Error('数据库名称格式不正确');
  if (operation.database && !identifier.test(operation.database)) throw new Error('请选择有效的数据库');
  if (operation.kind === 'createTable') {
    if (!identifier.test(operation.table)) throw new Error('数据表名称格式不正确');
    if (!operation.columns.length || operation.columns.some((column) => !identifier.test(column.name))) throw new Error('请检查字段名称');
  }
  if (['insert', 'select', 'update', 'delete'].includes(operation.kind)) {
    if (!operation.database || !operation.table) throw new Error('请选择目标数据库与数据表');
  }
  if (['insert', 'update'].includes(operation.kind) && !operation.values.length) throw new Error('请至少勾选一个写入字段');
  if (['update', 'delete'].includes(operation.kind) && !operation.conditions.some((item) => item.column)) throw new Error('UPDATE 和 DELETE 必须设置 WHERE 条件');
}

$('#execute-sql').addEventListener('click', executeOperation);
async function executeOperation() {
  if (!state.connected || !state.connection) {
    toast('执行前请先连接 MySQL', true);
    $('#connection-dialog').showModal();
    return;
  }
  const operation = getOperation();
  const previewSQL = buildOperationSQL(operation);
  try { validateOperation(operation); }
  catch (error) { toast(error.message, true); return; }
  const button = $('#execute-sql');
  button.disabled = true;
  button.classList.add('loading');
  button.querySelector('span').textContent = '正在执行…';
  const startedAt = performance.now();
  try {
    const result = await api('/api/execute', {
      method: 'POST', body: JSON.stringify({ connection: state.connection, operation }),
    });
    const duration = result.durationMs ?? Math.round(performance.now() - startedAt);
    renderResult(result);
    addHistory({ sql: previewSQL, ok: true, duration, time: new Date().toISOString() });
    toast('指令执行成功');
    if (operation.kind === 'createDatabase') {
      state.activeDatabase = operation.name;
      state.activeTable = '';
      await loadMetadata();
    }
    if (operation.kind === 'connectDatabase') {
      state.activeDatabase = operation.database;
      state.activeTable = '';
      await loadMetadata();
    }
    if (operation.kind === 'createTable') {
      state.activeTable = operation.table;
      await loadMetadata();
    }
  } catch (error) {
    const duration = Math.round(performance.now() - startedAt);
    renderError(error.message, previewSQL);
    addHistory({ sql: previewSQL, ok: false, duration, time: new Date().toISOString() });
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    button.querySelector('span').textContent = '执行指令';
  }
}

function switchResultTab(history = false) {
  $('#result-content').hidden = history;
  $('#history-content').hidden = !history;
  $('#result-tab').classList.toggle('active', !history);
  $('#history-tab').classList.toggle('active', history);
  $('#result-tab').setAttribute('aria-selected', String(!history));
  $('#history-tab').setAttribute('aria-selected', String(history));
  if (history) renderHistory();
}

$('#result-tab').addEventListener('click', () => switchResultTab(false));
$('#history-tab').addEventListener('click', () => switchResultTab(true));

function renderResult(result) {
  switchResultTab(false);
  const content = $('#result-content');
  content.replaceChildren();
  const message = document.createElement('div');
  message.className = 'result-message';
  message.innerHTML = '<svg><use href="#i-check"/></svg>';
  const text = document.createElement('span');
  text.textContent = result.message || '指令已由 MySQL 成功执行';
  message.append(text);
  content.append(message);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (rows.length) content.append(createResultTable(rows));
  else if (result.operation === 'select') {
    const empty = document.createElement('div'); empty.className = 'empty-history'; empty.textContent = '查询成功，没有匹配的记录。'; content.append(empty);
  } else {
    content.append(createResultTable([
      { 指标: '影响行数', 值: result.affectedRows ?? 0 },
      { 指标: '变更行数', 值: result.changedRows ?? '—' },
      { 指标: '自增 ID', 值: result.insertId || '—' },
      { 指标: '告警数', 值: result.warningStatus ?? 0 },
    ]));
  }
  $('#result-stats').innerHTML = `<span><strong>成功</strong></span><span>${escapeHTML(result.durationMs)} ms</span><span>${rows.length || result.affectedRows || 0} ROWS</span>`;
}

function createResultTable(rows) {
  const wrapper = document.createElement('div'); wrapper.className = 'table-scroll';
  const table = document.createElement('table');
  const thead = document.createElement('thead'); const headRow = document.createElement('tr');
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  columns.forEach((column) => { const th = document.createElement('th'); th.textContent = column; headRow.append(th); });
  thead.append(headRow); table.append(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((column) => {
      const td = document.createElement('td'); const value = row[column];
      if (value === null) { td.textContent = 'NULL'; td.className = 'null-value'; }
      else td.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
      td.title = td.textContent; tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody); wrapper.append(table); return wrapper;
}

function renderError(message, sql) {
  switchResultTab(false);
  const content = $('#result-content'); content.replaceChildren();
  const errorBox = document.createElement('div'); errorBox.className = 'result-message error';
  errorBox.innerHTML = '<svg><use href="#i-info"/></svg>';
  const text = document.createElement('span'); text.textContent = message; errorBox.append(text); content.append(errorBox);
  const pre = document.createElement('pre'); pre.className = 'history-sql'; pre.textContent = sql; content.append(pre);
  $('#result-stats').innerHTML = '<span style="color:var(--orange)">执行失败</span><span>请检查配置与权限</span>';
}

function addHistory(item) {
  state.history.unshift(item);
  state.history = state.history.slice(0, 20);
  localStorage.setItem('mysql-workbench-history', JSON.stringify(state.history));
  $('#history-count').textContent = state.history.length;
}

function renderHistory() {
  const container = $('#history-content');
  if (!state.history.length) { container.innerHTML = '<div class="empty-history">暂无执行记录。历史仅保存在当前浏览器，不包含连接凭据。</div>'; return; }
  container.innerHTML = `<div class="history-list">${state.history.map((item) => `
    <div class="history-item"><span class="history-status ${item.ok ? '' : 'error'}">${item.ok ? '✓ 成功' : '× 失败'}</span><pre class="history-sql" title="${escapeHTML(item.sql)}">${escapeHTML(item.sql.replaceAll('\n', ' '))}</pre><span class="history-time">${escapeHTML(new Date(item.time).toLocaleString('zh-CN'))} · ${item.duration} ms</span></div>`).join('')}</div>`;
}

$('#copy-sql').addEventListener('click', async () => {
  const sql = buildOperationSQL(getOperation());
  try { await navigator.clipboard.writeText(sql); toast('SQL 已复制'); }
  catch {
    const textarea = document.createElement('textarea'); textarea.value = sql; document.body.append(textarea); textarea.select(); document.execCommand('copy'); textarea.remove(); toast('SQL 已复制');
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); executeOperation(); }
});

try {
  const saved = JSON.parse(localStorage.getItem('mysql-workbench-connection') || 'null');
  if (saved) {
    $('#connection-host').value = saved.host || '127.0.0.1';
    $('#connection-port').value = saved.port || 3306;
    $('#connection-user').value = saved.user || 'root';
  }
} catch { /* Ignore invalid local preferences. */ }

$('#history-count').textContent = state.history.length;
renderActions();
renderDynamic();
