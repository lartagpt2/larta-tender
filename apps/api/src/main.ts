import { config } from 'dotenv';
import { resolve } from 'node:path';
import { createApplication } from './application';
config({ path: resolve(__dirname, '../../../.env'), quiet: true });
async function bootstrap() {
  const app = await createApplication();
  await app.listen(Number(process.env.PORT || 3000), '127.0.0.1');
}
void bootstrap();
