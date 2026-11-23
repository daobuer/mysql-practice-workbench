const quoteIdentifier = (name) => `\`${String(name || '').replaceAll('`', '``')}\``;
const quoteValue = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
};

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

export const conditionSQL = (condition, literal = true) => {
  const left = quoteIdentifier(condition.column);
  if (condition.operator === 'IS NULL' || condition.operator === 'IS NOT NULL') {
    return { text: `${left} ${condition.operator}`, params: [] };
  }
  return {
    text: `${left} ${condition.operator} ${literal ? quoteValue(condition.value) : '?'}`,
    params: literal ? [] : [condition.value],
  };
};

export const whereSQL = (conditions, conjunction, literal = true) => {
  const usable = (conditions || []).filter((condition) => condition.column);
  if (!usable.length) return { text: '', params: [] };
  const built = usable.map((condition) => conditionSQL(condition, literal));
  return {
    text: ` WHERE ${built.map((item) => item.text).join(` ${conjunction || 'AND'} `)}`,
    params: built.flatMap((item) => item.params),
  };
};

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
    { value: 'select', label: '查询数据 SELECT', title: '查询表内数据', code: 'ROWS / SELECT', tip: '先用 LIMIT 小范围查询，再逐步增加条件和排序。', explanation: '选择需要返回的列，可组合 WHERE 条件、排序与行数限制。' },
    { value: 'update', label: '修改数据 UPDATE', title: '修改匹配数据', code: 'ROWS / UPDATE', tip: 'UPDATE 必须携带 WHERE，先 SELECT 同样条件确认影响范围。', explanation: '更新符合 WHERE 条件的记录；为防止误操作，条件不能为空。' },
    { value: 'delete', label: '删除数据 DELETE', title: '删除匹配数据', code: 'ROWS / DELETE', tip: 'DELETE 必须携带 WHERE，删除前建议用相同条件执行 SELECT。', explanation: '删除符合 WHERE 条件的记录；为防止误操作，条件不能为空。' },
  ],
};
