import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

/**
 * 启动单端口 Nest 应用：同源提供 API 与原生前端静态文件。
 * 端口始终优先读取沙箱注入的 DEPLOY_RUN_PORT，避免硬编码预览环境。
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  app.setGlobalPrefix('api');

  // 开发时 __dirname 指向 src，生产时指向 dist；两种情况的上一级均为项目根目录。
  app.useStaticAssets(join(__dirname, '..', 'public'), { index: 'index.html' });

  // 基础安全响应头；_request 是中间件约定参数，本处理函数无需读取请求体。
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const port = Number(process.env.DEPLOY_RUN_PORT || 5000);
  await app.listen(port, '0.0.0.0');
  console.log(`MySQL Workbench listening on port ${port}`);
}

void bootstrap();
