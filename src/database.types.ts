export type SqlValue = string | number | boolean | null;

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface ValueInput {
  column: string;
  value: SqlValue;
}

export interface ConditionInput {
  column: string;
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'IS NULL' | 'IS NOT NULL';
  value?: SqlValue;
}

export interface ColumnInput {
  name: string;
  type: string;
  length?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unsigned?: boolean;
  defaultEnabled?: boolean;
  defaultNull?: boolean;
  defaultValue?: SqlValue;
}

export type Operation =
  | { kind: 'createDatabase'; name: string; charset: string; collation: string; ifNotExists?: boolean }
  | { kind: 'connectDatabase'; database: string }
  | { kind: 'createTable'; database: string; table: string; ifNotExists?: boolean; columns: ColumnInput[] }
  | { kind: 'insert'; database: string; table: string; values: ValueInput[] }
  | { kind: 'select'; database: string; table: string; columns?: string[]; conditions?: ConditionInput[]; conjunction?: 'AND' | 'OR'; orderColumn?: string; orderDirection?: 'ASC' | 'DESC'; limit?: number }
  | { kind: 'update'; database: string; table: string; values: ValueInput[]; conditions: ConditionInput[]; conjunction?: 'AND' | 'OR' }
  | { kind: 'delete'; database: string; table: string; conditions: ConditionInput[]; conjunction?: 'AND' | 'OR' };

export interface ConnectionRequest {
  connection: ConnectionConfig;
}

export interface MetadataRequest extends ConnectionRequest {
  database?: string;
}

export interface ExecuteRequest extends ConnectionRequest {
  operation: Operation;
}

export interface Statement {
  sql: string;
  params: SqlValue[];
}
