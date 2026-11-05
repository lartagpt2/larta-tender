import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { HttpErrorFilter } from './http-error.filter';
function context() {
  const send = jest.fn();
  const status = jest.fn().mockReturnValue({ send });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ id: 'correlation-test' }) }),
  } as unknown as ArgumentsHost;
  return { host, status, send };
}
test('validation errors do not serialize exception details', () => {
  const { host, status, send } = context();
  new HttpErrorFilter().catch(new BadRequestException({ message: 'private document text' }), host);
  expect(status).toHaveBeenCalledWith(400);
  expect(send).toHaveBeenCalledWith({
    statusCode: 400,
    message: 'Некорректный запрос',
    correlationId: 'correlation-test',
  });
});
test('unexpected failures expose neither secrets nor stack in response or log', () => {
  const { host, status, send } = context();
  const logger = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    new HttpErrorFilter().catch(new Error('private credential'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Внутренняя ошибка сервера',
      correlationId: 'correlation-test',
    });
    expect(logger).toHaveBeenCalledWith(JSON.stringify({ status: 500, correlationId: 'correlation-test' }));
  } finally {
    logger.mockRestore();
  }
});
