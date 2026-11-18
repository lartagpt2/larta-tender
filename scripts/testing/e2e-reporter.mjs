import { resolve } from 'node:path';
import { json } from '../task008-gate-d/io.mjs';
export default class Reporter {
  results = [];
  onTestEnd(test, result) {
    this.results.push({
      testCase: test.titlePath().join(' > '),
      status: result.status,
      expectedStatus: test.expectedStatus,
      durationMs: result.duration,
    });
  }
  async onEnd() {
    if (process.env.ISOLATED_RUN_ROOT)
      await json(resolve(process.env.ISOLATED_RUN_ROOT, 'test-results.json'), this.results);
  }
}
