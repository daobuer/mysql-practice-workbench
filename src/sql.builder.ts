import { BadRequestException } from '@nestjs/common';
import type { ColumnInput, ConditionInput, Operation, SqlValue, Statement, ValueInput } from './database.types';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATA_TYPES = new Set(['INT', 'BIGINT', 'VARCHAR', 'CHAR', 'DECIMAL', 'FLOAT', 'DOUBLE', 'TEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'BOOLEAN']);
const NUMERIC_TYPES = new Set(['INT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE']);
const INTEGER_TYPES = new Set(['INT', 'BIGINT']);
const SIZED_TYPES = new Set(['INT', 'BIGINT', 'VARCHAR', 'CHAR', 'DECIMAL', 'FLOAT', 'DOUBLE']);
const OPERATORS = new Set(['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL']);
const CHARSETS = new Set(['utf8mb4', 'utf8', 'latin1']);

function invalid(message: string): never {
  throw new BadRequestException({ message, code: 'INVALID_OPERATION' });
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || value.length > 64) {
    invalid(`${label}仅支持 64 位以内的字母、数字和下划线，且不能以数字开头`);
  }
  return value;
}

function quoteIdentifier(value: unknown, label: string): string {
  return `\`${identifier(value, label)}\``;
}

function sqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined || value === null) return null;
  invalid('字段值仅支持字符串、有限数值、布尔值或 NULL');
}

function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) invalid(`${label}必须是数组`);
  return value as T[];
}

function validateLength(column: ColumnInput): string {
  const length = column.length?.trim();
  if (!length || !SIZED_TYPES.has(column.type)) return '';
  if (column.type === 'DECIMAL') {
    const match = /^(\d{1,2})(?:,(\d{1,2}))?$/.exec(length);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65 || Number(match[2] || 0) > 30 || Number(match[2] || 0) > Number(match[1])) {
      invalid('DECIMAL 长度应为 precision 或 precision,scale，例如 10,2');
    }
  } else if (!/^\d{1,5}$/.test(length) || Number(length) < 1 || (column.type === 'CHAR' && Number(length) > 255)) {
    invalid(`${column.type} 的长度格式不正确`);
  }
  return `(${length})`;
}

function columnDefinition(column: ColumnInput): string {
  const name = quoteIdentifier(column.name, '字段名');
  if (!DATA_TYPES.has(column.type)) invalid(`不支持的字段类型：${String(column.type)}`);
  if (column.unsigned && !NUMERIC_TYPES.has(column.type)) invalid('只有数值字段可以设置为 UNSIGNED');
  if (column.autoIncrement && !INTEGER_TYPES.has(column.type)) invalid('只有 INT 或 BIGINT 字段可以 AUTO_INCREMENT');
  if (column.autoIncrement && !column.primaryKey) invalid('自增字段必须同时设为主键');
  const parts = [`${name} ${column.type}${validateLength(column)}`];
  if (column.unsigned) parts.push('UNSIGNED');
  parts.push(column.nullable && !column.primaryKey ? 'NULL' : 'NOT NULL');
  if (column.autoIncrement) parts.push('AUTO_INCREMENT');
  if (column.defaultEnabled) parts.push('DEFAULT', column.defaultNull ? 'NULL' : '?');
  return parts.join(' ');
}

function columnDefaults(columns: ColumnInput[]): SqlValue[] {
  return columns.filter((column) => column.defaultEnabled && !column.defaultNull).map((column) => sqlValue(column.defaultValue));
}

function valuesInput(values: unknown): ValueInput[] {
  const items = requireArray<ValueInput>(values, '写入值');
  if (!items.length || items.length > 100) invalid('写入字段数量应在 1 到 100 之间');
  return items.map((item) => ({ column: identifier(item.column, '写入字段'), value: sqlValue(item.value) }));
}

function conditionsInput(conditions: unknown, required: boolean): ConditionInput[] {
  const items = requireArray<ConditionInput>(conditions || [], 'WHERE 条件');
  if (items.length > 20) invalid('WHERE 条件最多支持 20 项');
  if (required && !items.length) invalid('UPDATE 和 DELETE 必须包含 WHERE 条件');
  return items.map((item) => {
    if (!OPERATORS.has(item.operator)) invalid(`不支持的条件运算符：${String(item.operator)}`);
    return {
      column: identifier(item.column, '条件字段'),
      operator: item.operator,
      value: item.operator.includes('NULL') ? null : sqlValue(item.value),
    };
  });
}

function whereClause(conditions: ConditionInput[], conjunction: unknown): { sql: string; params: SqlValue[] } {
  if (!conditions.length) return { sql: '', params: [] };
  if (conjunction !== 'AND' && conjunction !== 'OR') invalid('多条件连接方式仅支持 AND 或 OR');
  const params: SqlValue[] = [];
  const clauses = conditions.map((condition) => {
    const column = quoteIdentifier(condition.column, '条件字段');
    if (condition.operator === 'IS NULL' || condition.operator === 'IS NOT NULL') return `${column} ${condition.operator}`;
    params.push(condition.value ?? null);
    return `${column} ${condition.operator} ?`;
  });
  return { sql: ` WHERE ${clauses.join(` ${conjunction} `)}`, params };
}

function tableName(operation: { database: string; table: string }): string {
  return `${quoteIdentifier(operation.database, '数据库名')}.${quoteIdentifier(operation.table, '数据表名')}`;
}

export function buildStatement(operation: Operation): Statement {
  if (!operation || typeof operation !== 'object') invalid('缺少操作配置');

  if (operation.kind === 'createDatabase') {
    const name = quoteIdentifier(operation.name, '数据库名');
    if (!CHARSETS.has(operation.charset)) invalid('不支持的数据库字符集');
    if (typeof operation.collation !== 'string' || !/^[a-z0-9_]+$/.test(operation.collation) || !operation.collation.startsWith(`${operation.charset}_`)) {
      invalid('排序规则与字符集不匹配');
    }
    return {
      sql: `CREATE DATABASE ${operation.ifNotExists === false ? '' : 'IF NOT EXISTS '}${name} DEFAULT CHARACTER SET ${operation.charset} COLLATE ${operation.collation};`,
      params: [],
    };
  }

  if (operation.kind === 'connectDatabase') {
    return { sql: `USE ${quoteIdentifier(operation.database, '数据库名')};`, params: [] };
  }

  const qualifiedTable = tableName(operation);
  if (operation.kind === 'createTable') {
    const columns = requireArray<ColumnInput>(operation.columns, '字段结构');
    if (!columns.length || columns.length > 100) invalid('字段数量应在 1 到 100 之间');
    if (columns.filter((column) => column.autoIncrement).length > 1) invalid('一张表最多只能有一个自增字段');
    const names = new Set(columns.map((column) => column.name));
    if (names.size !== columns.length) invalid('字段名不能重复');
    const definitions = columns.map((column) => `  ${columnDefinition(column)}`);
    const primaryKeys = columns.filter((column) => column.primaryKey).map((column) => quoteIdentifier(column.name, '主键字段'));
    if (primaryKeys.length) definitions.push(`  PRIMARY KEY (${primaryKeys.join(', ')})`);
    return {
      sql: `CREATE TABLE ${operation.ifNotExists ? 'IF NOT EXISTS ' : ''}${qualifiedTable} (\n${definitions.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      params: columnDefaults(columns),
    };
  }

  if (operation.kind === 'insert') {
    const values = valuesInput(operation.values);
    return {
      sql: `INSERT INTO ${qualifiedTable} (${values.map((item) => quoteIdentifier(item.column, '写入字段')).join(', ')}) VALUES (${values.map(() => '?').join(', ')});`,
      params: values.map((item) => item.value),
    };
  }

  if (operation.kind === 'select') {
    const selected = operation.columns || [];
    const columns = selected.length
      ? requireArray<string>(selected, '查询字段').map((column) => quoteIdentifier(column, '查询字段')).join(', ')
      : '*';
    const conditions = conditionsInput(operation.conditions || [], false);
    const where = whereClause(conditions, operation.conjunction || 'AND');
    let order = '';
    if (operation.orderColumn) {
      if (operation.orderDirection !== 'ASC' && operation.orderDirection !== 'DESC') invalid('排序方向仅支持 ASC 或 DESC');
      order = ` ORDER BY ${quoteIdentifier(operation.orderColumn, '排序字段')} ${operation.orderDirection}`;
    }
    const limit = operation.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) invalid('LIMIT 应为 1 到 500 的整数');
    return { sql: `SELECT ${columns} FROM ${qualifiedTable}${where.sql}${order} LIMIT ${limit};`, params: where.params };
  }

  if (operation.kind === 'update') {
    const values = valuesInput(operation.values);
    const conditions = conditionsInput(operation.conditions, true);
    const where = whereClause(conditions, operation.conjunction || 'AND');
    const assignments = values.map((item) => `${quoteIdentifier(item.column, '写入字段')} = ?`).join(', ');
    return { sql: `UPDATE ${qualifiedTable} SET ${assignments}${where.sql};`, params: [...values.map((item) => item.value), ...where.params] };
  }

  if (operation.kind === 'delete') {
    const conditions = conditionsInput(operation.conditions, true);
    const where = whereClause(conditions, operation.conjunction || 'AND');
    return { sql: `DELETE FROM ${qualifiedTable}${where.sql};`, params: where.params };
  }

  invalid('不支持的操作类型');
}
