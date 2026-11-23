import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  app.setGlobalPrefix('api');
  app.useStaticAssets(join(__dirname, '..', 'public'), { index: 'index.html' });
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
