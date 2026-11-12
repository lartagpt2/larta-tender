import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const reply = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    const code =
      exception && typeof exception === 'object' && 'code' in exception ? exception.code : undefined;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : ['LT409', '40001', '40P01'].includes(String(code))
          ? 409
          : 500;
    const messages: Record<number, string> = {
      400: 'Некорректный запрос',
      401: 'Требуется вход',
      403: 'Доступ запрещён',
      404: 'Ресурс не найден',
      409: 'Конфликт версии или ключа запроса',
      503: 'Доступ к данным пока не настроен',
      413: 'Превышен размер запроса',
      429: 'Слишком много запросов',
    };
    // Never serialize exception.message, request data or stack to the client/log.
    if (status >= 500) console.error(JSON.stringify({ status, correlationId: request.id }));
    void reply.status(status).send({
      statusCode: status,
      message: messages[status] || 'Внутренняя ошибка сервера',
      correlationId: request.id,
    });
  }
}
