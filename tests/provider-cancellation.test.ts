import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/utils/retry.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { createServer } from 'node:http';
test('retry delay is interrupted by abort', async () => {
    const c = new AbortController();
    let calls = 0;
    const start = Date.now();
    const p = withRetry(async () => {
        calls++;
        setTimeout(() => c.abort(), 10);
        throw Object.assign(Error('retry'), { status: 429 });
    }, { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 1000, retryableStatusCodes: [429] }, c.signal);
    await assert.rejects(p);
    assert.equal(calls, 1);
    assert.ok(Date.now() - start < 500);
});
for (const Provider of [OpenAIProvider, AnthropicProvider])
    test(`${Provider.name} forwards cancellation to transport`, async () => {
        const server = createServer((_req, res) => {
            setTimeout(() => res.end('{}'), 1000).unref();
        });
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const c = new AbortController();
        const addr = server.address() as any;
        try {
            const p = new Provider({ apiKey: 'offline', baseURL: `http://127.0.0.1:${addr.port}` }).createMessage({ model: 'test', maxTokens: 10, system: 'test', messages: [{ role: 'user', content: 'hi' }], signal: c.signal } as any);
            setTimeout(() => c.abort(), 30);
            const start = Date.now();
            await assert.rejects(p);
            assert.ok(Date.now() - start < 500);
        }
        finally {
            server.closeAllConnections();
            server.close();
        }
    });
