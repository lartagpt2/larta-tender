import { OllamaDocumentAI } from './ollama';
import { emptyDraft, packWireDraft } from './contracts';
const config = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3-vl:8b-instruct',
  timeoutMs: 1000,
  digest: 'expected',
};
const make = () => {
  const client = new OllamaDocumentAI(config);
  const request = jest.spyOn(
    client as unknown as { request: (path: string, body?: unknown) => Promise<unknown> },
    'request',
  );
  return { client, request };
};
describe('local-only Ollama boundary', () => {
  it.each([
    'https://ollama.com:11434',
    'http://localhost:11434',
    'http://127.0.0.1:11434/proxy',
    'http://user:pass@127.0.0.1:11434',
    'http://10.0.0.1:11434',
  ])('rejects unapproved address %s', (baseUrl) => {
    expect(() => new OllamaDocumentAI({ ...config, baseUrl })).toThrow('local_ai_config_rejected');
  });
  it.each([{}, { cloud: { disabled: false } }])(
    'fails closed before sending document when cloud is not disabled',
    async (status) => {
      const { client, request } = make();
      request.mockResolvedValueOnce(status);
      await expect(client.extract([{ page: 1, text: 'Synthetic' }])).rejects.toThrow('cloud_not_disabled');
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects cloud alias and never sends document content', async () => {
    const { client, request } = make();
    request
      .mockResolvedValueOnce({ cloud: { disabled: true } })
      .mockResolvedValueOnce({ remote_model: 'cloud', capabilities: ['vision'] });
    await expect(client.extract([{ page: 1, text: 'Synthetic' }])).rejects.toThrow('cloud_or_model_rejected');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('requires pinned model digest', async () => {
    const { client, request } = make();
    request
      .mockResolvedValueOnce({ cloud: { disabled: true } })
      .mockResolvedValueOnce({ capabilities: ['vision'] })
      .mockResolvedValueOnce({ models: [{ name: config.model, digest: 'changed' }] });
    await expect(client.extract([{ page: 1, text: 'Synthetic' }])).rejects.toThrow('model_digest_mismatch');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('sends bounded schema/vision without tools and returns only a draft', async () => {
    const { client, request } = make();
    request
      .mockResolvedValueOnce({ cloud: { disabled: true } })
      .mockResolvedValueOnce({ capabilities: ['vision'] })
      .mockResolvedValueOnce({ models: [{ name: config.model, digest: 'expected' }] })
      .mockResolvedValueOnce({
        model: config.model,
        done: true,
        done_reason: 'stop',
        message: { content: JSON.stringify(packWireDraft(emptyDraft())) },
      });
    const result = await client.extract([{ page: 1, text: 'Synthetic', image: 'synthetic-base64' }]);
    const body = request.mock.calls[3][1] as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.format).toBeDefined();
    expect(body.tools).toBeUndefined();
    expect(result.digest).toBe('expected');
    expect(result.warnings).toContain('vision_evidence_requires_review');
    expect(result.draft.total.value).toBeNull();
  });
});
