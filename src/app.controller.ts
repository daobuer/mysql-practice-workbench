import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import type { ConnectionRequest, ExecuteRequest, MetadataRequest } from './database.types';
import { MySqlService } from './mysql.service';

/**
 * 应用 HTTP 入口。
 * 控制器只负责接收结构化请求和委托服务层，不在此拼接 SQL 或保存连接状态。
 */
@Controller()
export class AppController {
  /**
   * @param mysql Nest 注入的 MySQL 服务；显式 @Inject 保证 tsx 开发模式也能正确解析依赖。
   */
  constructor(@Inject(MySqlService) private readonly mysql: MySqlService) {}

  /** 服务健康检查，不依赖数据库，便于区分 Web 服务故障与 MySQL 故障。 */
  @Get('health')
  health() {
    return { status: 'ok', service: 'mysql-practice-workbench' };
  }

  /**
   * 测试真实数据库连接。
   * @param body 请求体中的 connection 包含主机、端口、用户和内存态密码。
   */
  @Post('connection/test')
  testConnection(@Body() body: ConnectionRequest) {
    return this.mysql.testConnection(body.connection);
  }

  /**
   * 读取数据库、表和字段元数据。
   * @param body connection 为连接配置，database 为可选目标数据库。
   */
  @Post('metadata')
  metadata(@Body() body: MetadataRequest) {
    return this.mysql.metadata(body.connection, body.database);
  }

  /**
   * 执行结构化操作。
   * @param body operation.kind 决定操作类型，请求中不允许出现原始 SQL 字段。
   */
  @Post('execute')
  execute(@Body() body: ExecuteRequest) {
    return this.mysql.execute(body.connection, body.operation);
  }
}
