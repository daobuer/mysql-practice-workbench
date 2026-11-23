import { BadRequestException, Injectable } from '@nestjs/common';
import { createConnection, type Connection, type FieldPacket, type RowDataPacket } from 'mysql2/promise';
import { buildStatement, normalizeConnection } from './sql.builder';
import type { ColumnInfo, ConnectionConfig, DatabaseInfo, MetadataResponse, Operation, TableInfo } from './database.types';

/** 数据库版本查询的返回行结构。 */
interface VersionRow extends RowDataPacket {
  serverVersion: string;
  currentUser: string;
}

/** 数据库清单查询的返回行结构。 */
interface SchemaRow extends RowDataPacket, DatabaseInfo {}

/** 数据表清单查询的返回行结构。 */
interface TableRow extends RowDataPacket {
  name: string;
}

/** 字段元数据查询在表清单基础上附加所属表名。 */
interface ColumnRow extends RowDataPacket, ColumnInfo {
  tableName: string;
}

/** MySQL 驱动及网络错误中用于安全错误提示的字段。 */
interface DatabaseError extends Error {
  code?: string;
  errno?: number;
}

@Injectable()
export class MySqlService {
  /**
   * 在真实 MySQL 连接的生命周期内运行回调，并保证连接最终关闭。
   * 不使用持久连接池，是因为连接凭据由每次请求提供且不能跨用户共享。
   * @param input 未校验的客户端连接配置。
   * @param task 接收已建立连接的异步业务函数。
   * @returns 回调的原始业务结果。
   */
  private async withConnection<T>(input: ConnectionConfig, task: (connection: Connection) => Promise<T>): Promise<T> {
    const config = normalizeConnection(input);
    let connection: Connection | undefined;
    try {
      connection = await createConnection({
        ...config,
        connectTimeout: 6000, // 六秒连接超时，避免不可用主机长期占用请求。
        multipleStatements: false, // 禁止一次请求执行多条语句。
        dateStrings: true, // 日期按字符串返回，避免时区转换造成展示偏差。
      });
      return await task(connection);
    } finally {
      if (connection) await connection.end();
    }
  }

  /**
   * 将数据库错误转换为不泄露凭据的中文 400 响应。
   * 已抛出的 Nest 业务异常原样抛出，未知编程错误也原样抛出以便日志定位。
   * @param error mysql2 或网络层抛出的原始错误。
   */
  private handleDatabaseError(error: unknown): never {
    if (error instanceof BadRequestException) throw error;
    const databaseError = error as DatabaseError;
    const code = databaseError?.code || 'DATABASE_ERROR';
    const messages: Record<string, string> = {
      ECONNREFUSED: '无法连接数据库，请确认主机、端口与 MySQL 服务状态',
      ETIMEDOUT: '数据库连接超时，请检查网络和服务状态',
      ER_ACCESS_DENIED_ERROR: '用户名或密码错误，或该用户没有登录权限',
      ER_BAD_DB_ERROR: '目标数据库不存在或当前用户无权访问',
      ER_DB_CREATE_EXISTS: '目标数据库已存在',
      ER_TABLE_EXISTS_ERROR: '目标数据表已存在',
      ER_NO_SUCH_TABLE: '目标数据表不存在',
      ER_BAD_TABLE_ERROR: '目标数据表不存在或无权访问',
      ER_BAD_FIELD_ERROR: '字段不存在，请刷新结构后重试',
      ER_DUP_ENTRY: '写入失败：主键或唯一索引值重复',
      ER_PARSE_ERROR: '生成的指令未被数据库接受，请检查字段配置',
    };
    const detail = databaseError?.message ? `：${databaseError.message}` : '';
    throw new BadRequestException({ message: `${messages[code] || '数据库执行失败'}${detail}`, code });
  }

  /**
   * 测试真实连接并读取数据库版本、当前账号。
   * @param connection 客户端提交的连接配置。
   */
  async testConnection(connection: ConnectionConfig) {
    try {
      return await this.withConnection(connection, async (client) => {
        const [rows] = await client.query<VersionRow[]>('SELECT VERSION() AS serverVersion, CURRENT_USER() AS currentUser;');
        return { connected: true, serverVersion: rows[0]?.serverVersion, currentUser: rows[0]?.currentUser };
      });
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  /**
   * 从 information_schema 读取真实元数据。
   * @param connection 客户端连接配置。
   * @param database 可选目标库；提供时返回该库的表和有序字段，否则只返回库清单。
   */
  async metadata(connection: ConnectionConfig, database?: string): Promise<MetadataResponse> {
    try {
      return await this.withConnection(connection, async (client) => {
        const [databaseRows] = await client.query<SchemaRow[]>(
          'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS defaultCharset FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME;',
        );
        const databases = databaseRows.map(({ name, defaultCharset }) => ({ name, defaultCharset }));
        if (!database) return { databases, tables: [] };

        // 所有元数据筛选值同样使用参数绑定，不拼接用户输入。
        const [tableRows] = await client.query<TableRow[]>(
          "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;",
          [database],
        );
        if (!tableRows.length) return { databases, tables: [] };
        const [columnRows] = await client.query<ColumnRow[]>(
          `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, DATA_TYPE AS type,
            COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
            COLUMN_KEY AS columnKey, EXTRA AS extra
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME, ORDINAL_POSITION;`,
          [database],
        );
        const tables: TableInfo[] = tableRows.map((table) => ({
          name: table.name,
          columns: columnRows
            .filter((column) => column.tableName === table.name)
            .map(({ name, type, columnType, isNullable, defaultValue, columnKey, extra }) => ({ name, type, columnType, isNullable, defaultValue, columnKey, extra })),
        }));
        return { databases, tables };
      });
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  /**
   * 校验并执行一个结构化操作，返回真实数据库结果。
   * @param connectionConfig 当前请求的数据库连接配置。
   * @param operation 操作对象；kind 决定 SQL 生成分支。
   */
  async execute(connectionConfig: ConnectionConfig, operation: Operation) {
    const startedAt = Date.now();
    const statement = buildStatement(operation);
    try {
      return await this.withConnection(connectionConfig, async (connection) => {
        if (operation.kind === 'connectDatabase') {
          // USE 作用于当前短连接，再查询 DATABASE() 向调用方确认切换结果。
          await connection.query(statement.sql, statement.params);
          const [rows] = await connection.query<RowDataPacket[]>('SELECT DATABASE() AS database_name;');
          return {
            success: true,
            operation: operation.kind,
            message: `已连接数据库 ${operation.database}`,
            sql: statement.sql,
            rows,
            fields: ['database_name'],
            rowCount: rows.length,
            affectedRows: 0,
            durationMs: Date.now() - startedAt,
          };
        }

        const [rawResult, rawFields] = await connection.query(statement.sql, statement.params);
        if (Array.isArray(rawResult)) {
          // SELECT 返回行数组；字段顺序以驱动 FieldPacket 为准。
          const rows = rawResult as RowDataPacket[];
          const fields = (rawFields as FieldPacket[]).map((field) => field.name);
          return {
            success: true,
            operation: operation.kind,
            message: `查询完成，返回 ${rows.length} 行`,
            sql: statement.sql,
            rows,
            fields,
            rowCount: rows.length,
            affectedRows: 0,
            durationMs: Date.now() - startedAt,
          };
        }

        // DDL 与写入语句返回 ResultSetHeader，提取影响行数、自增 ID 等指标。
        const result = rawResult as any;
        const messages: Record<string, string> = {
          createDatabase: `数据库 ${operation.kind === 'createDatabase' ? operation.name : ''} 已就绪`,
          createTable: `数据表 ${operation.kind === 'createTable' ? operation.table : ''} 已就绪`,
          insert: '数据插入成功',
          update: '数据更新完成',
          delete: '数据删除完成',
        };
        return {
          success: true,
          operation: operation.kind,
          message: messages[operation.kind] || '指令执行成功',
          sql: statement.sql,
          rows: [],
          fields: [],
          rowCount: 0,
          affectedRows: result.affectedRows ?? 0,
          changedRows: result.changedRows ?? 0,
          insertId: result.insertId ?? 0,
          warningStatus: result.warningStatus ?? 0,
          durationMs: Date.now() - startedAt,
        };
      });
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }
}
