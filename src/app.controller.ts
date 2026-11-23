import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import type { ConnectionRequest, ExecuteRequest, MetadataRequest } from './database.types';
import { MySqlService } from './mysql.service';

@Controller()
export class AppController {
  constructor(@Inject(MySqlService) private readonly mysql: MySqlService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'mysql-practice-workbench' };
  }

  @Post('connection/test')
  testConnection(@Body() body: ConnectionRequest) {
    return this.mysql.testConnection(body.connection);
  }

  @Post('metadata')
  metadata(@Body() body: MetadataRequest) {
    return this.mysql.metadata(body.connection, body.database);
  }

  @Post('execute')
  execute(@Body() body: ExecuteRequest) {
    return this.mysql.execute(body.connection, body.operation);
  }
}
