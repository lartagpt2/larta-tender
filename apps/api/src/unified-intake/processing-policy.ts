import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
export interface ProcessingPolicyConfig {
  mode: 'disabled' | 'synthetic' | 'approved_corpus';
  enabled: boolean;
  sha256: string[];
}
export interface PolicySnapshot {
  version: string;
  config: ProcessingPolicyConfig;
  reason(sha: string): string | null;
}
export class IntakePolicy {
  constructor(
    private readonly load: () => Promise<ProcessingPolicyConfig> = async () => ({
      mode: 'disabled',
      enabled: true,
      sha256: [],
    }),
  ) {}
  static file(path: string, workspace: string) {
    return new IntakePolicy(async () => {
      const p = resolve(path),
        r = relative(resolve(workspace), p);
      if (!isAbsolute(path) || r.startsWith('..') || isAbsolute(r))
        throw Error('policy_path_outside_workspace');
      for (let c = p; ; c = dirname(c)) {
        if ((await lstat(c)).isSymbolicLink()) throw Error('policy_link');
        if (dirname(c) === c) break;
      }
      return JSON.parse(await readFile(p, 'utf8')) as ProcessingPolicyConfig;
    });
  }
  async current(): Promise<PolicySnapshot> {
    const c = await this.load();
    if (
      !['disabled', 'synthetic'].includes(c.mode) ||
      typeof c.enabled !== 'boolean' ||
      !Array.isArray(c.sha256) ||
      c.sha256.some((s) => !/^[a-f0-9]{64}$/.test(s))
    )
      throw Error('invalid_or_unapproved_processing_policy');
    const config = { ...c, sha256: [...new Set(c.sha256)].sort() };
    const version = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    return {
      version,
      config,
      reason: (sha) =>
        !config.enabled
          ? 'intake_processing_disabled'
          : config.mode === 'disabled'
            ? 'processing_disabled'
            : !config.sha256.includes(sha)
              ? 'sha_not_approved'
              : null,
    };
  }
}
