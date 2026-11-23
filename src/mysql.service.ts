import { BadRequestException, Injectable } from '@nestjs/common';
import { createConnection } from 'mysql2/promise';
import type { Connection, FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ConnectionConfig, Operation } from './database.types';
import { buildStatement } from './sql.builder';

interface DatabaseError {
  code?: string;
  message?: string;
  sqlMessage?: string;
}

interface SchemaRow extends RowDataPacket {
  name: string;
  defaultCharset: string;
}

interface TableRow extends RowDataPacket {
  name: string;
}

interface ColumnRow extends RowDataPacket {
  tableName: string;
  name: string;
  type: string;
  columnType: string;
  isNullable: 'YES' | 'NO';
  defaultValue: unknown;
  columnKey: string;
  extra: string;
}

@Injectable()
export class MySqlService {
  private normalizeConnection(input: ConnectionConfig): ConnectionConfig {
    if (!input || typeof input !== 'object') throw new BadRequestException({ message: '缺少数据库连接配置' });
    const host = typeof input.host === 'string' ? input.host.trim() : '';
    const user = typeof input.user === 'string' ? input.user.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const port = Number(input.port);
    if (!host || host.length > 255 || !/^[A-Za-z0-9.:-]+$/.test(host)) {
      throw new BadRequestException({ message: 'MySQL 主机地址格式不正确' });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestException({ message: 'MySQL 端口应为 1 到 65535 的整数' });
    }
    if (!user || user.length > 128 || password.length > 512) {
      throw new BadRequestException({ message: 'MySQL 用户名或密码格式不正确' });
    }
    return { host, port, user, password };
  }

  private async withConnection<T>(input: ConnectionConfig, callback: (connection: Connection) => Promise<T>): Promise<T> {
    const config = this.normalizeConnection(input);
    const connection = await createConnection({
      ...config,
      connectTimeout: 6000,
      multipleStatements: false,
    });
    try {
      return await callback(connection);
    } finally {
      await connection.end();
    }
  }

  private databaseError(error: unknown): never {
    if (error instanceof BadRequestException) throw error;
    const databaseError = error as DatabaseError;
    const code = databaseError?.code || 'DATABASE_ERROR';
    const friendlyMessages: Record<string, string> = {
      ECONNREFUSED: '无法连接 MySQL，请确认服务已启动且端口正确',
      ETIMEDOUT: '连接 MySQL 超时，请检查主机与网络',
      ENOTFOUND: '找不到 MySQL 主机，请检查主机地址',
      ER_ACCESS_DENIED_ERROR: 'MySQL 拒绝了连接，请检查用户名、密码与授权范围',
      ER_BAD_DB_ERROR: '目标数据库不存在或当前用户无权访问',
      ER_DB_CREATE_EXISTS: '目标数据库已经存在',
      ER_TABLE_EXISTS_ERROR: '目标数据表已经存在',
      ER_NO_SUCH_TABLE: '目标数据表不存在',
      ER_BAD_FIELD_ERROR: '字段不存在，请刷新表结构后重试',
      ER_DUP_ENTRY: '写入违反了唯一键或主键约束',
      ER_PARSE_ERROR: 'MySQL 无法解析生成的指令',
      ER_NO_REFERENCED_ROW_2: '操作违反了外键约束',
    };
    const summary = friendlyMessages[code] || 'MySQL 执行失败';
    const detail = typeof databaseError?.sqlMessage === 'string' ? `：${databaseError.sqlMessage}` : '';
    throw new BadRequestException({ message: `${summary}${detail}`, code });
  }

  async testConnection(input: ConnectionConfig) {
    try {
      return await this.withConnection(input, async (connection) => {
        const [rows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS serverVersion, CURRENT_USER() AS currentUser;');
        return {
          connected: true,
          serverVersion: String(rows[0]?.serverVersion || 'unknown'),
          currentUser: String(rows[0]?.currentUser || ''),
        };
      });
    } catch (error) {
      this.databaseError(error);
    }
  }

  async metadata(input: ConnectionConfig, database?: string) {
    if (database !== undefined && (typeof database !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(database))) {
      throw new BadRequestException({ message: '目标数据库名称格式不正确' });
    }
    try {
      return await this.withConnection(input, async (connection) => {
        const [databases] = await connection.query<SchemaRow[]>(
          'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS defaultCharset FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME;',
        );
        if (!database) return { databases, tables: [] };

        const [tableRows] = await connection.query<TableRow[]>(
          "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;",
          [database],
        );
        const [columnRows] = await connection.query<ColumnRow[]>(
          `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, DATA_TYPE AS type,
            COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
            COLUMN_KEY AS columnKey, EXTRA AS extra
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
           ORDER BY TABLE_NAME, ORDINAL_POSITION;`,
          [database],
        );
        const tables = tableRows.map((table) => ({
          name: table.name,
          columns: columnRows.filter((column) => column.tableName === table.name).map((column) => ({
            name: column.name,
            type: column.type,
            columnType: column.columnType,
            isNullable: column.isNullable,
            defaultValue: column.defaultValue,
            columnKey: column.columnKey,
            extra: column.extra,
          })),
        }));
        return { databases, tables };
      });
    } catch (error) {
      this.databaseError(error);
    }
  }

  async execute(input: ConnectionConfig, operation: Operation) {
    const statement = buildStatement(operation);
    const startedAt = Date.now();
    try {
      return await this.withConnection(input, async (connection) => {
        const [rawResult, rawFields] = await connection.query(statement.sql, statement.params);
        const durationMs = Date.now() - startedAt;

        if (operation.kind === 'connectDatabase') {
          const [rows] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS currentDatabase;');
          return {
            success: true,
            operation: operation.kind,
            message: `已连接数据库 ${operation.database}`,
            sql: statement.sql,
            rows,
            fields: ['currentDatabase'],
            rowCount: rows.length,
            affectedRows: 0,
            durationMs,
          };
        }

        if (Array.isArray(rawResult)) {
          const rows = rawResult as RowDataPacket[];
          const fields = Array.isArray(rawFields) ? (rawFields as FieldPacket[]).map((field) => field.name) : [];
          return {
            success: true,
            operation: operation.kind,
            message: `查询完成，返回 ${rows.length} 行`,
            sql: statement.sql,
            rows,
            fields,
            rowCount: rows.length,
            affectedRows: 0,
            durationMs,
          };
        }

        const result = rawResult as ResultSetHeader;
        const messages: Record<Operation['kind'], string> = {
          createDatabase: `数据库 ${operation.kind === 'createDatabase' ? operation.name : ''} 已就绪`,
          connectDatabase: '数据库已连接',
          createTable: `数据表 ${operation.kind === 'createTable' ? operation.table : ''} 已就绪`,
          insert: '数据已写入',
          select: '查询完成',
          update: `更新完成，影响 ${result.affectedRows} 行`,
          delete: `删除完成，影响 ${result.affectedRows} 行`,
        };
        return {
          success: true,
          operation: operation.kind,
          message: messages[operation.kind],
          sql: statement.sql,
          rows: [],
          fields: [],
          rowCount: 0,
          affectedRows: Number(result.affectedRows || 0),
          changedRows: Number(result.changedRows || 0),
          insertId: Number(result.insertId || 0),
          warningStatus: Number(result.warningStatus || 0),
          durationMs,
        };
      });
    } catch (error) {
      this.databaseError(error);
    }
  }
}
