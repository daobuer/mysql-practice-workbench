/**
 * 将数据库标识符包裹为 MySQL 反引号形式。
 * 此函数只负责前端预览转义；后端仍会执行严格的标识符白名单校验。
 * @param {string} name 数据库、数据表或字段名称。
 * @returns {string} 可用于 SQL 预览的标识符。
 */
const quoteIdentifier = (name) => `\`${String(name || '').replaceAll('`', '``')}\``;

/**
 * 把 JavaScript 输入值格式化为便于学习的 SQL 字面量。
 * 注意：该字面量仅用于页面展示，真正执行时后端始终使用问号占位符和参数绑定。
 * @param {string|number|boolean|null|undefined} value 用户输入的字段值。
 * @returns {string} SQL 字面量文本。
 */
const quoteValue = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
};

/**
 * 生成单个字段的 CREATE TABLE 定义。
 * @param {object} column 字段配置，包含名称、类型、长度、空值、主键和自增等选项。
 * @returns {string} 形如 `id` INT UNSIGNED NOT NULL 的字段定义。
 */
const columnDefinition = (column) => {
  const size = column.length && ['INT', 'BIGINT', 'VARCHAR', 'CHAR', 'DECIMAL', 'FLOAT', 'DOUBLE'].includes(column.type)
    ? `(${column.length})`
    : '';
  const parts = [`${quoteIdentifier(column.name)} ${column.type}${size}`];
  if (column.unsigned) parts.push('UNSIGNED');
  parts.push(column.nullable ? 'NULL' : 'NOT NULL');
  if (column.autoIncrement) parts.push('AUTO_INCREMENT');
  if (column.defaultEnabled) {
    parts.push('DEFAULT', column.defaultNull ? 'NULL' : quoteValue(column.defaultValue));
  }
  return parts.join(' ');
};

/**
 * 生成一个基础比较条件，并按需用 NOT (...) 对当前条件整体取反。
 * @param {object} condition 条件项；column 为字段，operator 为比较符，value 为比较值，not 表示是否取反。
 * @param {boolean} literal true 时生成可读字面量，false 时生成问号占位符并收集参数。
 * @returns {{text: string, params: Array<*>}} 条件文本及执行参数。
 */
export const conditionSQL = (condition, literal = true) => {
  const left = quoteIdentifier(condition.column);
  const isNullCheck = condition.operator === 'IS NULL' || condition.operator === 'IS NOT NULL';
  const text = isNullCheck
    ? `${left} ${condition.operator}`
    : `${left} ${condition.operator} ${literal ? quoteValue(condition.value) : '?'}`;
  return {
    text: condition.not ? `NOT (${text})` : text,
    params: !literal && !isNullCheck ? [condition.value] : [],
  };
};

/**
 * 将多个条件组合成 WHERE 子句。
 * 第一项不需要连接符；从第二项开始读取各自 conjunction（AND/OR），从而允许混合逻辑。
 * @param {Array<object>} conditions 有序条件数组，顺序与页面中的条件行一致。
 * @param {'AND'|'OR'} conjunction 兼容旧配置的默认连接符；条件自身未设置时使用。
 * @param {boolean} literal 是否输出字面量预览，false 用于参数化语句。
 * @returns {{text: string, params: Array<*>}} 完整 WHERE 文本和有序参数列表。
 */
export const whereSQL = (conditions, conjunction = 'AND', literal = true) => {
  const usable = (conditions || []).filter((condition) => condition.column);
  if (!usable.length) return { text: '', params: [] };
  let text = '';
  const params = [];
  usable.forEach((condition, index) => {
    const built = conditionSQL(condition, literal);
    const joiner = index === 0 ? '' : ` ${condition.conjunction || conjunction} `;
    text += `${joiner}${built.text}`;
    params.push(...built.params);
  });
  return { text: ` WHERE ${text}`, params };
};

/**
 * 根据结构化操作生成对应 MySQL 指令，是前端实时预览的统一入口。
 * @param {object} operation 当前操作对象，kind 决定建库、建表或数据 CRUD 分支。
 * @param {boolean} literal true 输出可复制的字面量 SQL；false 输出参数化 SQL。
 * @returns {string} 完整 SQL 文本。
 */
export function buildOperationSQL(operation, literal = true) {
  const { kind, database } = operation;
  const qualifiedTable = `${quoteIdentifier(database)}.${quoteIdentifier(operation.table)}`;

  if (kind === 'createDatabase') {
    return `CREATE DATABASE ${operation.ifNotExists === false ? '' : 'IF NOT EXISTS '}${quoteIdentifier(operation.name)}\n  DEFAULT CHARACTER SET ${operation.charset}\n  COLLATE ${operation.collation};`;
  }
  if (kind === 'connectDatabase') return `USE ${quoteIdentifier(database)};`;
  if (kind === 'createTable') {
    const definitions = operation.columns.map((column) => `  ${columnDefinition(column)}`);
    const primaryKeys = operation.columns.filter((column) => column.primaryKey).map((column) => quoteIdentifier(column.name));
    if (primaryKeys.length) definitions.push(`  PRIMARY KEY (${primaryKeys.join(', ')})`);
    return `CREATE TABLE ${operation.ifNotExists ? 'IF NOT EXISTS ' : ''}${qualifiedTable} (\n${definitions.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
  }
  if (kind === 'insert') {
    const values = operation.values.filter((item) => item.column);
    const columns = values.map((item) => quoteIdentifier(item.column)).join(', ');
    const placeholders = values.map((item) => literal ? quoteValue(item.value) : '?').join(', ');
    return `INSERT INTO ${qualifiedTable} (${columns})\nVALUES (${placeholders});`;
  }
  if (kind === 'select') {
    const columns = operation.columns?.length
      ? operation.columns.map(quoteIdentifier).join(', ')
      : '*';
    const where = whereSQL(operation.conditions, operation.conjunction, literal);
    const order = operation.orderColumn
      ? ` ORDER BY ${quoteIdentifier(operation.orderColumn)} ${operation.orderDirection || 'ASC'}`
      : '';
    return `SELECT ${columns}\nFROM ${qualifiedTable}${where.text}${order}\nLIMIT ${operation.limit || 50};`;
  }
  if (kind === 'update') {
    const values = operation.values.filter((item) => item.column);
    const assignments = values.map((item) => `${quoteIdentifier(item.column)} = ${literal ? quoteValue(item.value) : '?'}`).join(', ');
    const where = whereSQL(operation.conditions, operation.conjunction, literal);
    return `UPDATE ${qualifiedTable}\nSET ${assignments}${where.text};`;
  }
  if (kind === 'delete') {
    const where = whereSQL(operation.conditions, operation.conjunction, literal);
    return `DELETE FROM ${qualifiedTable}${where.text};`;
  }
  return '-- 请选择操作';
}

/** 操作目录：同时驱动级联下拉、左侧导航、标题和当前操作的学习提示。 */
export const operationCatalog = {
  database: [
    { value: 'createDatabase', label: '创建数据库 CREATE', title: '创建数据库', code: 'DATABASE / CREATE', tip: '先创建一个独立练习库，避免在业务数据库中试验。', explanation: '创建一个新的逻辑数据库，并指定 UTF8MB4 字符集与排序规则。' },
    { value: 'connectDatabase', label: '连接数据库 USE', title: '连接数据库', code: 'DATABASE / CONNECT', tip: 'USE 会切换当前会话数据库；本应用会把选择随后续请求发送。', explanation: '验证目标数据库可连接，并将其设为后续操作的当前上下文。' },
  ],
  table: [
    { value: 'createTable', label: '创建数据表 CREATE TABLE', title: '定制数据表结构', code: 'TABLE / CREATE', tip: '字段名使用名词，整数主键配合 AUTO_INCREMENT 便于练习。', explanation: '在目标库中创建 InnoDB 数据表，并定义字段、空值约束与主键。' },
  ],
  data: [
    { value: 'insert', label: '新增数据 INSERT', title: '新增一行数据', code: 'ROWS / INSERT', tip: '只填写需要插入的列；留空字符串与 NULL 是不同概念。', explanation: '向目标表插入一行记录，所有输入值由后端使用参数绑定。' },
    { value: 'select', label: '查询数据 SELECT', title: '查询表内数据', code: 'ROWS / SELECT', tip: '先用 LIMIT 小范围查询，再逐步增加条件和排序。', explanation: '选择需要返回的列，可用 AND、OR、NOT 组合 WHERE 条件，并设置排序与行数限制。' },
    { value: 'update', label: '修改数据 UPDATE', title: '修改匹配数据', code: 'ROWS / UPDATE', tip: 'UPDATE 必须携带 WHERE，先 SELECT 同样条件确认影响范围。', explanation: '更新符合 WHERE 条件的记录；支持 AND、OR、NOT，且为防止误操作条件不能为空。' },
    { value: 'delete', label: '删除数据 DELETE', title: '删除匹配数据', code: 'ROWS / DELETE', tip: 'DELETE 必须携带 WHERE，删除前建议用相同条件执行 SELECT。', explanation: '删除符合 WHERE 条件的记录；支持 AND、OR、NOT，且为防止误操作条件不能为空。' },
  ],
};
