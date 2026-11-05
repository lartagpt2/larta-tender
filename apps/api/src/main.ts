import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
config({ path: resolve(__dirname, '../../../.env'), quiet: true });
async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 1024 * 1024 }),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Tender API').setVersion('1.0').build(),
  );
  SwaggerModule.setup('docs', app, document, { ui: false });
  await app.listen(Number(process.env.PORT || 3000), '127.0.0.1');
}
void bootstrap();
