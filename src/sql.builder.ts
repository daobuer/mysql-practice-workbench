import { BadRequestException } from '@nestjs/common';
import type { ConditionInput, Operation, SqlValue } from './database.types';

/** 已生成 SQL 与其有序绑定参数；二者必须一起传给 mysql2。 */
export interface BuiltStatement {
  /** 仅包含白名单标识符、关键字和问号占位符的参数化 SQL。 */
  sql: string;
  /** 与 SQL 中问号出现顺序完全一致的用户值。 */
  params: SqlValue[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DATA_TYPES = new Set(['INT', 'BIGINT', 'DECIMAL', 'VARCHAR', 'CHAR', 'TEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'FLOAT', 'DOUBLE']);
const OPERATORS = new Set(['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL']);
const CHARSETS = new Set(['utf8mb4', 'utf8', 'latin1']);
const COLLATIONS = new Set(['utf8mb4_unicode_ci', 'utf8mb4_general_ci', 'utf8mb4_bin', 'utf8_general_ci', 'utf8_unicode_ci', 'latin1_swedish_ci', 'latin1_bin']);
const NUMERIC_TYPES = new Set(['INT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE']);
const INTEGER_TYPES = new Set(['INT', 'BIGINT']);
const SIZED_TYPES = new Set(['INT', 'BIGINT', 'VARCHAR', 'CHAR', 'DECIMAL', 'FLOAT', 'DOUBLE']);
const CONJUNCTIONS = new Set(['AND', 'OR']);

/**
 * 抛出结构校验错误，统一使用 INVALID_OPERATION 供前端识别。
 * @param message 面向用户的具体中文原因，不包含敏感连接信息。
 */
function invalid(message: string): never {
  throw new BadRequestException({ message, code: 'INVALID_OPERATION' });
}

/**
 * 校验并规范化连接参数。
 * @param input 客户端提交的原始连接对象。
 * @returns 仅含 host、port、user、password 的安全连接配置。
 */
export function normalizeConnection(input: unknown) {
  if (!input || typeof input !== 'object') invalid('连接配置不能为空');
  const value = input as Record<string, unknown>;
  const host = String(value.host || '').trim();
  const user = String(value.user || '').trim();
  const password = value.password === undefined ? '' : value.password;
  const port = Number(value.port || 3306);
  if (!/^[A-Za-z0-9.:-]+$/.test(host) || host.length > 255) invalid('数据库主机格式无效');
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('端口必须是 1–65535 的整数');
  if (!user || user.length > 128) invalid('用户名不能为空且不能超过 128 字符');
  if (typeof password !== 'string' || password.length > 512) invalid('密码格式无效');
  return { host, port, user, password };
}

/**
 * 校验 MySQL 标识符并用反引号包裹。
 * @param value 待校验的数据库、表或字段名。
 * @param label 错误提示中显示的对象名称。
 */
function identifier(value: unknown, label: string): string {
  const name = String(value || '');
  if (!IDENTIFIER.test(name)) invalid(`${label}仅支持字母、数字和下划线，且需以字母或下划线开头`);
  return `\`${name}\``;
}

/**
 * 校验绑定值类型。undefined 统一转换为 NULL，避免 mysql2 收到不支持的值。
 * @param value 单个用户输入值。
 */
function sqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined || value === null) return null;
  invalid('字段值必须是字符串、有限数值、布尔值或 NULL');
}

/**
 * 校验字段长度/精度声明。
 * @param length 原始长度文本，例如 VARCHAR 的 100 或 DECIMAL 的 5,2。
 * @param type 已通过白名单校验的字段类型。
 */
function validateLength(length: unknown, type: string): string {
  if (!length) return '';
  const text = String(length);
  if (!SIZED_TYPES.has(type) || !/^\d{1,5}(,\d{1,2})?$/.test(text)) invalid(`${type} 类型的长度或精度格式无效`);
  if (type === 'VARCHAR' && (Number(text) < 1 || Number(text) > 65535)) invalid('VARCHAR 长度需在 1–65535 之间');
  if (type === 'CHAR' && (Number(text) < 1 || Number(text) > 255)) invalid('CHAR 长度需在 1–255 之间');
  if (type === 'DECIMAL') {
    const match = /^(\d{1,2})(?:,(\d{1,2}))?$/.exec(text);
    const precision = Number(match?.[1]);
    const scale = Number(match?.[2] || 0);
    if (!match || precision < 1 || precision > 65 || scale > 30 || scale > precision) invalid('DECIMAL 精度应为 M,D，且 1≤M≤65、0≤D≤30、D≤M');
  }
  return text;
}

/**
 * 把字段配置转换为安全 DDL，同时约束主键、自增与默认值之间的关系。
 * @param input 单个原始字段配置。
 * @returns 字段 SQL 与默认值绑定参数。
 */
function columnDefinition(input: any): { text: string; params: SqlValue[] } {
  const name = identifier(input.name, '字段名');
  const type = String(input.type || '').toUpperCase();
  if (!DATA_TYPES.has(type)) invalid(`不支持的字段类型：${type}`);
  const length = validateLength(input.length, type);
  if ((type === 'VARCHAR' || type === 'DECIMAL') && !length) invalid(`${type} 类型必须指定长度或精度`);
  const primaryKey = input.primaryKey === true;
  const autoIncrement = input.autoIncrement === true;
  const unsigned = input.unsigned === true;
  if (autoIncrement && (!INTEGER_TYPES.has(type) || !primaryKey)) invalid('AUTO_INCREMENT 只能用于整数主键');
  if (unsigned && !NUMERIC_TYPES.has(type)) invalid('UNSIGNED 只能用于数值类型');
  const nullable = primaryKey ? false : input.nullable === true;
  const parts = [`${name} ${type}${length ? `(${length})` : ''}`];
  if (unsigned) parts.push('UNSIGNED');
  parts.push(nullable ? 'NULL' : 'NOT NULL');
  if (autoIncrement) parts.push('AUTO_INCREMENT');
  const params: SqlValue[] = [];
  if (input.defaultEnabled === true && !autoIncrement) {
    if (input.defaultNull === true) {
      parts.push('DEFAULT NULL');
    } else {
      parts.push('DEFAULT ?');
      params.push(sqlValue(input.defaultValue ?? ''));
    }
  }
  return { text: parts.join(' '), params };
}

/**
 * 构建 WHERE 子句，支持每个条件独立设置 AND/OR 与 NOT。
 * @param conditionsInput 原始有序条件数组；无字段名的空行会被忽略。
 * @param defaultConjunction 兼容旧版请求的全局默认连接符。
 * @returns WHERE 文本及按条件顺序排列的绑定参数。
 */
function whereClause(conditionsInput: unknown, defaultConjunction = 'AND') {
  if (defaultConjunction && !CONJUNCTIONS.has(defaultConjunction)) invalid('默认条件连接符仅支持 AND 或 OR');
  const conditions = Array.isArray(conditionsInput) ? conditionsInput : [];
  if (conditions.length > 20) invalid('最多支持 20 个条件');
  const usable = conditions.filter((condition) => condition && typeof condition === 'object' && String((condition as any).column || '').trim());
  if (!usable.length) return { text: '', params: [] as SqlValue[] };
  const params: SqlValue[] = [];
  let text = '';
  usable.forEach((raw, index) => {
    const condition = raw as ConditionInput;
    const column = identifier(condition.column, '条件字段');
    const operator = String(condition.operator || '=').toUpperCase();
    if (!OPERATORS.has(operator)) invalid(`不支持的条件运算符：${operator}`);
    if (condition.conjunction && !CONJUNCTIONS.has(condition.conjunction)) invalid('条件连接符仅支持 AND 或 OR');
    if (condition.not !== undefined && typeof condition.not !== 'boolean') invalid('NOT 开关必须是布尔值');
    const isNullCheck = operator === 'IS NULL' || operator === 'IS NOT NULL';
    let expression = `${column} ${operator}`;
    if (!isNullCheck) {
      expression += ' ?';
      params.push(sqlValue(condition.value));
    }
    if (condition.not) expression = `NOT (${expression})`;
    const joiner = index === 0 ? '' : ` ${condition.conjunction || defaultConjunction} `;
    text += `${joiner}${expression}`;
  });
  return { text: ` WHERE ${text}`, params };
}

/**
 * 校验结构化操作并生成参数化 MySQL 指令。
 * 这是后端执行前的唯一 SQL 生成入口，不接收任何客户端原始 SQL。
 * @param operation 前端提交的操作判别联合对象。
 */
export function buildStatement(operation: Operation): BuiltStatement {
  if (!operation || typeof operation !== 'object') invalid('操作配置不能为空');
  const kind = operation.kind;
  if (kind === 'createDatabase') {
    const name = identifier(operation.name, '数据库名');
    if (!CHARSETS.has(operation.charset) || !COLLATIONS.has(operation.collation)) invalid('字符集或排序规则不受支持');
    if (!operation.collation.startsWith(`${operation.charset}_`)) invalid('排序规则与字符集不匹配');
    return { sql: `CREATE DATABASE ${operation.ifNotExists === false ? '' : 'IF NOT EXISTS '}${name} DEFAULT CHARACTER SET ${operation.charset} COLLATE ${operation.collation};`, params: [] };
  }
  if (kind === 'connectDatabase') return { sql: `USE ${identifier(operation.database, '数据库名')};`, params: [] };
  if (kind === 'createTable') {
    const table = `${identifier(operation.database, '数据库名')}.${identifier(operation.table, '数据表名')}`;
    if (!Array.isArray(operation.columns) || operation.columns.length < 1 || operation.columns.length > 100) invalid('数据表需要 1–100 个字段');
    const names = operation.columns.map((column) => String(column.name || ''));
    if (new Set(names).size !== names.length) invalid('字段名不能重复');
    if (operation.columns.filter((column) => column.autoIncrement).length > 1) invalid('一张表最多一个 AUTO_INCREMENT 字段');
    const definitions = operation.columns.map(columnDefinition);
    const primaryKeys = operation.columns.filter((column) => column.primaryKey).map((column) => identifier(column.name, '主键字段'));
    if (primaryKeys.length) definitions.push({ text: `PRIMARY KEY (${primaryKeys.join(', ')})`, params: [] });
    return {
      sql: `CREATE TABLE ${operation.ifNotExists ? 'IF NOT EXISTS ' : ''}${table} (\n  ${definitions.map((item) => item.text).join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
      params: definitions.flatMap((item) => item.params),
    };
  }
  if (kind === 'insert' || kind === 'update') {
    if (!Array.isArray(operation.values) || !operation.values.length) invalid('至少设置一个字段值');
  }
  if (kind === 'select' || kind === 'insert' || kind === 'update' || kind === 'delete') {
    const table = `${identifier(operation.database, '数据库名')}.${identifier(operation.table, '数据表名')}`;
    if (kind === 'insert') {
      const columns = operation.values.map((item) => identifier(item.column, '插入字段'));
      return { sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`, params: operation.values.map((item) => sqlValue(item.value)) };
    }
    if (kind === 'update') {
      const assignments = operation.values.map((item) => `${identifier(item.column, '更新字段')} = ?`);
      const where = whereClause(operation.conditions, operation.conjunction);
      if (!where.text) invalid('UPDATE 必须设置至少一个 WHERE 条件');
      return { sql: `UPDATE ${table} SET ${assignments.join(', ')}${where.text};`, params: [...operation.values.map((item) => sqlValue(item.value)), ...where.params] };
    }
    if (kind === 'delete') {
      const where = whereClause(operation.conditions, operation.conjunction);
      if (!where.text) invalid('DELETE 必须设置至少一个 WHERE 条件');
      return { sql: `DELETE FROM ${table}${where.text};`, params: where.params };
    }
    const columns = operation.columns?.length ? operation.columns.map((column) => identifier(column, '查询字段')).join(', ') : '*';
    const where = whereClause(operation.conditions, operation.conjunction);
    const limit = operation.limit === undefined ? 50 : Number(operation.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) invalid('LIMIT 必须是 1–500 的整数');
    let order = '';
    if (operation.orderColumn) {
      const direction = String(operation.orderDirection || 'ASC').toUpperCase();
      if (direction !== 'ASC' && direction !== 'DESC') invalid('排序方向仅支持 ASC 或 DESC');
      order = ` ORDER BY ${identifier(operation.orderColumn, '排序字段')} ${direction}`;
    }
    return { sql: `SELECT ${columns} FROM ${table}${where.text}${order} LIMIT ${limit};`, params: where.params };
  }
  invalid('不支持的操作类型');
}
