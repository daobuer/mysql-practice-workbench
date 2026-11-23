/**
 * MySQL 连接配置。
 * 密码只存在于当前请求与后端连接对象的内存中，不写入数据库、历史记录或日志。
 */
export interface ConnectionConfig {
  /** MySQL 主机名或 IP 地址。 */
  host: string;
  /** MySQL TCP 端口，常用值为 3306。 */
  port: number;
  /** 登录用户名。 */
  user: string;
  /** 登录密码；允许本地练习实例使用空字符串。 */
  password: string;
}

/** 后端允许用于绑定参数的标量值，杜绝把客户端 SQL 片段直接拼入语句。 */
export type SqlValue = string | number | boolean | null;

/** CREATE TABLE 的单个字段定义。 */
export interface ColumnDefinitionInput {
  /** 字段名，只允许字母、数字和下划线。 */
  name: string;
  /** 字段类型，仅可使用后端 DATA_TYPES 白名单中的类型。 */
  type: string;
  /** 类型长度或 DECIMAL 精度，例如 100、5,2；不需要长度的类型可省略。 */
  length?: string;
  /** 是否允许存储 NULL。 */
  nullable: boolean;
  /** 是否作为联合主键或单列主键的一部分。 */
  primaryKey: boolean;
  /** 是否自动递增，仅允许整数主键使用。 */
  autoIncrement: boolean;
  /** 是否为无符号数值。 */
  unsigned: boolean;
  /** 是否显式声明 DEFAULT。 */
  defaultEnabled?: boolean;
  /** 是否将默认值设为 NULL；优先于 defaultValue。 */
  defaultNull?: boolean;
  /** 具体默认值，通过参数占位符传给 mysql2。 */
  defaultValue?: SqlValue;
}

/**
 * WHERE 条件项。
 * conjunction 描述“当前项与上一项”的连接方式，not 只对当前比较表达式取反。
 */
export interface ConditionInput {
  /** 参与比较的字段名。 */
  column: string;
  /** 比较运算符，必须命中 SQL builder 的运算符白名单。 */
  operator: string;
  /** 比较值；IS NULL/IS NOT NULL 条件不需要该值。 */
  value?: SqlValue;
  /** 当前条件与前一条件的连接符；首项忽略该字段。 */
  conjunction?: 'AND' | 'OR';
  /** 是否生成 NOT (条件)，用于实现逻辑非。 */
  not?: boolean;
}

/** INSERT 或 UPDATE 的字段值映射。 */
export interface ValueInput {
  /** 目标字段名。 */
  column: string;
  /** 待写入值，执行时使用问号占位符绑定。 */
  value: SqlValue;
}

/** 创建数据库操作。 */
export interface CreateDatabaseOperation {
  kind: 'createDatabase';
  name: string;
  charset: string;
  collation: string;
  ifNotExists?: boolean;
}

/** 连接并切换数据库操作。 */
export interface ConnectDatabaseOperation {
  kind: 'connectDatabase';
  database: string;
}

/** 创建自定义结构数据表操作。 */
export interface CreateTableOperation {
  kind: 'createTable';
  database: string;
  table: string;
  ifNotExists: boolean;
  columns: ColumnDefinitionInput[];
}

/** 插入一行数据操作。 */
export interface InsertOperation {
  kind: 'insert';
  database: string;
  table: string;
  values: ValueInput[];
}

/** 查询操作，支持多条件、NOT、排序和 LIMIT。 */
export interface SelectOperation {
  kind: 'select';
  database: string;
  table: string;
  columns?: string[];
  conditions?: ConditionInput[];
  /** 旧版请求的默认连接符；新请求优先读取每个条件自己的 conjunction。 */
  conjunction?: 'AND' | 'OR';
  orderColumn?: string;
  orderDirection?: 'ASC' | 'DESC';
  limit?: number;
}

/** 更新操作；values 与 conditions 均不能为空。 */
export interface UpdateOperation {
  kind: 'update';
  database: string;
  table: string;
  values: ValueInput[];
  conditions: ConditionInput[];
  conjunction?: 'AND' | 'OR';
}

/** 删除操作；conditions 不能为空，以避免误删整表。 */
export interface DeleteOperation {
  kind: 'delete';
  database: string;
  table: string;
  conditions: ConditionInput[];
  conjunction?: 'AND' | 'OR';
}

/** 前端可提交的全部结构化操作，后端通过 kind 进行判别联合校验。 */
export type Operation =
  | CreateDatabaseOperation
  | ConnectDatabaseOperation
  | CreateTableOperation
  | InsertOperation
  | SelectOperation
  | UpdateOperation
  | DeleteOperation;

/** 连接测试和元数据接口的请求体。 */
export interface ConnectionRequest {
  connection: ConnectionConfig;
  /** 元数据接口的可选目标库；提供时同时读取该库的表和字段。 */
  database?: string;
}

/** 元数据接口请求体；继承连接配置和可选目标数据库。 */
export interface MetadataRequest extends ConnectionRequest {}

/** 执行接口请求体；不包含原始 SQL，防止任意语句注入。 */
export interface ExecuteRequest extends ConnectionRequest {
  operation: Operation;
}

/** information_schema 查询出的数据库摘要。 */
export interface DatabaseInfo {
  name: string;
  defaultCharset: string;
}

/** information_schema 查询出的字段元数据，用于驱动前端级联选项。 */
export interface ColumnInfo {
  name: string;
  type: string;
  columnType: string;
  isNullable: 'YES' | 'NO';
  defaultValue: SqlValue;
  columnKey: string;
  extra: string;
}

/** 数据表及其有序字段列表。 */
export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

/** 元数据接口响应。 */
export interface MetadataResponse {
  databases: DatabaseInfo[];
  tables: TableInfo[];
}
