import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { MySqlService } from './mysql.service';

@Module({
  controllers: [AppController],
  providers: [MySqlService],
})
export class AppModule {}
