import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryEngine } from '../src/engine.js';
import { compactConversation, createAutoCompactState } from '../src/utils/compact.js';
const response = { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } as any;
function engine(fn: any, extra: any = {}) {
    return new QueryEngine({ provider: { apiType: 'openai-completions', createMessage: fn }, model: 'test', maxTurns: 1, maxTokens: 100, cwd: process.cwd(), tools: [], systemPrompt: 'test', ...extra });
}
async function collect(e: QueryEngine) {
    const out: any[] = [];
    for await (const x of e.submitMessage('hello'))
        out.push(x);
    return out.at(-1);
}
test('completion on final permitted turn succeeds', async () => {
    assert.equal((await collect(engine(async () => response))).subtype, 'success');
});
test('provider error is observable', async () => {
    const r = await collect(engine(async () => {
        throw Error('offline failure');
    }));
    assert.equal(r.is_error, true);
    assert.match(r.errors[0], /offline failure/);
});
test('pre-aborted run is cancelled without request', async () => {
    const c = new AbortController();
    c.abort();
    let calls = 0;
    const r = await collect(engine(async () => {
        calls++;
        return response;
    }, { abortSignal: c.signal }));
    assert.equal(calls, 0);
    assert.equal(r.subtype, 'cancelled');
});
test('abort after assistant yield prevents tools', async () => {
    const c = new AbortController();
    let calls = 0;
    const e = engine(async () => ({ ...response, content: [{ type: 'tool_use', id: 't', name: 'mutate', input: {} }], stopReason: 'tool_use' }), { abortSignal: c.signal, tools: [{ name: 'mutate', description: 'test', inputSchema: { type: 'object', properties: {} }, call: async () => {
                    calls++;
                    return { type: 'tool_result', tool_use_id: 't', content: 'ok' };
                } }] });
    let result: any;
    for await (const x of e.submitMessage('go')) {
        if (x.type === 'assistant')
            c.abort();
        if (x.type === 'result')
            result = x;
    }
    assert.equal(calls, 0);
    assert.equal(result.subtype, 'cancelled');
});
test('failed compaction is explicit and recovery terminates', async () => {
    const provider: any = { apiType: 'openai-completions', createMessage: async () => {
            throw Error('summary failed');
        } };
    const r: any = await compactConversation(provider, 'test', [], createAutoCompactState());
    assert.equal(r.success, false);
    let calls = 0;
    const e = engine(async () => {
        calls++;
        if (calls > 8)
            throw Error('sentinel');
        throw Object.assign(Error('prompt is too long'), { status: 400 });
    });
    const end = await collect(e);
    assert.equal(end.is_error, true);
    assert.ok(calls <= 4, `calls=${calls}`);
});
test('shared budget includes summary usage and stops admission', async () => {
    const ledger = { cost: 0, usage: { input_tokens: 0, output_tokens: 0 } };
    let calls = 0;
    const e = engine(async () => {
        calls++;
        return response;
    }, { contextWindowSize: 1, executionBudget: ledger, maxBudgetUsd: 0.00001, pricingPerMillion: { input: 1, output: 1 } });
    const r = await collect(e);
    assert.equal(calls, 1);
    assert.equal(r.subtype, 'error_max_budget_usd');
    assert.equal(ledger.usage.input_tokens, 10);
    assert.equal(r.usage.output_tokens, 5);
});
test('engine reports ledger delta including child charges', async () => {
    const ledger = { cost: 1, usage: { input_tokens: 100, output_tokens: 100 } };
    const e = engine(async () => {
        ledger.cost += 2;
        ledger.usage.input_tokens += 20;
        return response;
    }, { executionBudget: ledger, pricingPerMillion: { input: 1, output: 1 } });
    const r = await collect(e);
    assert.equal(r.usage.input_tokens, 30);
    assert.ok(Math.abs(r.cost - 2.000015) < 1e-10);
});
test('abort during model request produces one cancelled result', async () => {
    const controller = new AbortController();
    const e = engine(async (params: any) => {
        assert.equal(params.signal, controller.signal);
        return new Promise((_resolve, reject) => {
            params.signal.addEventListener('abort', () => reject(params.signal.reason), { once: true });
            controller.abort();
        });
    }, { abortSignal: controller.signal });
    assert.equal((await collect(e)).subtype, 'cancelled');
});
test('early exit after assistant preserves paired tool history and cleanup hooks', async () => {
    const events: string[] = [];
    const e = engine(async () => ({ ...response, content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }), {
        hookRegistry: { hasHooks: () => true, execute: async (event: string) => {
                events.push(event);
                return [];
            } },
    });
    for await (const event of e.submitMessage('go'))
        if (event.type === 'assistant')
            break;
    const last = e.getMessages().at(-1) as any;
    assert.equal(last.content[0].tool_use_id, 't');
    assert.equal(last.content[0].is_error, true);
    assert.deepEqual(events.slice(-2), ['Stop', 'SessionEnd']);
});
test('tool result history is persisted before consumer stops on result', async () => {
    const e = engine(async () => ({ ...response, content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }), {
        tools: [{ name: 'x', description: '', inputSchema: { type: 'object', properties: {} }, call: async () => ({ type: 'tool_result', tool_use_id: '', content: 'saved' }) }],
    });
    for await (const event of e.submitMessage('go'))
        if (event.type === 'tool_result')
            break;
    assert.equal((e.getMessages().at(-1) as any).content[0].content, 'saved');
});
test('zero budget prevents all model requests', async () => {
    let calls = 0;
    const end = await collect(engine(async () => {
        calls++;
        return response;
    }, { maxBudgetUsd: 0 }));
    assert.equal(calls, 0);
    assert.equal(end.subtype, 'error_max_budget_usd');
});
test('model usage distinguishes inherited child model charges', async () => {
    const ledger = { cost: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} as Record<string, any> };
    const e = engine(async () => {
        ledger.usage.input_tokens += 20;
        ledger.modelUsage.child = { input_tokens: 20, output_tokens: 0 };
        return response;
    }, { executionBudget: ledger });
    const end = await collect(e);
    assert.equal(end.model_usage.test.input_tokens, 10);
    assert.equal(end.model_usage.child.input_tokens, 20);
});
test('truncated tool response does not execute possibly incomplete arguments', async () => {
    let calls = 0;
    const e = engine(async () => ({ ...response, stopReason: 'max_tokens', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }), {
        tools: [{ name: 'x', description: '', inputSchema: { type: 'object', properties: {} }, call: async () => {
                    calls++;
                    return { type: 'tool_result', tool_use_id: '', content: 'changed' };
                } }],
    });
    const end = await collect(e);
    assert.equal(calls, 0);
    assert.equal(end.is_error, true);
});
