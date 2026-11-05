import { HealthController } from './app.module';
test('health responds without connecting to PostgreSQL', () => {
  expect(new HealthController().health()).toEqual({ status: 'ok', persistence: 'not-configured' });
});
