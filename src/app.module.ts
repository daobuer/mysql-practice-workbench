import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { MySqlService } from './mysql.service';

/**
 * Nest 根模块：注册 HTTP 控制器与 MySQL 服务提供者。
 * 连接由服务层按请求创建，因此这里不注册共享凭据或全局数据库连接池。
 */
@Module({
  controllers: [AppController],
  providers: [MySqlService],
})
export class AppModule {}
