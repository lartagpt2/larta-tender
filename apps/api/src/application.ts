import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { DataOptions } from './tenders.module';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './http-error.filter';
export interface ApplicationOptions {
  data?: DataOptions;
  environment?: string;
  enableOpenApi?: boolean;
  logger?: false;
}
export async function createApplication(options: ApplicationOptions = {}): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      enabled: process.env.DATA_ACCESS_ENABLED === 'true',
      token: process.env.DEV_API_TOKEN,
      actorId: process.env.DEV_ACTOR_ID,
      ...options.data,
      environment: options.environment ?? process.env.NODE_ENV ?? 'development',
    }),
    adapter,
    {
      logger: options.logger,
    },
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  const environment = options.environment ?? process.env.NODE_ENV ?? 'development';
  const enableOpenApi = options.enableOpenApi ?? process.env.ENABLE_OPENAPI === 'true';
  if (environment !== 'production' && enableOpenApi) {
    const spec = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Larta Tender API').setVersion('1.1').addBearerAuth().build(),
    );
    SwaggerModule.setup('api/docs', app, spec, { ui: false, jsonDocumentUrl: '/api/openapi.json' });
  }
  return app;
}
