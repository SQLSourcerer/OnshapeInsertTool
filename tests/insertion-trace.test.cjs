const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');

function harness() {
    const exports = {};
    const window = {};
    const document = { addEventListener() {} };
    class Middleware { async pre(context) { return context; } }
    const source = fs.readFileSync(require.resolve('../cloudflare/insertiontrace.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    vm.runInNewContext(code.outputText, { exports, window, document, performance,
        console: { log() {} }, require: () => ({ RateLimitMiddleware: Middleware }) });
    return exports;
}

test('trace is opt-in, bounded, and ignores completions from a previous recording', () => {
    const { InsertionTrace } = harness();
    let now = 0;
    const output = [];
    const trace = new InsertionTrace(() => now, line => output.push(line));
    trace.event('disabled');
    assert.equal(output.length, 0);
    trace.start();
    const end = trace.begin('lookup');
    now = 50;
    end();
    assert.match(trace.report(), /lookup done \(50 ms\)/);
    trace.stop();
    trace.start();
    end();
    assert.doesNotMatch(trace.report(), /lookup/);
    for (let i = 0; i < 400; i++) trace.event('event');
    assert.equal(trace.report().split('\n').length, 300);
});

test('instrumented methods preserve this, promise identity, results and errors without logging values', async () => {
    const { installInsertionTrace } = harness();
    const pending = Promise.resolve('private result');
    const app = {
        secret: 'private argument',
        getInsertChoices(arg) { assert.equal(this.secret, arg); return pending; },
        showItemChoices() { return 'private result'; },
        insertToTarget() { throw new Error('private exception'); },
        insertToAssembly() { return Promise.reject(new Error('private rejection')); },
    };
    const trace = installInsertionTrace(app);
    trace.start();
    assert.equal(app.getInsertChoices('private argument'), pending);
    await pending;
    assert.equal(app.showItemChoices(), 'private result');
    assert.throws(() => app.insertToTarget(), /private exception/);
    await assert.rejects(app.insertToAssembly(), /private rejection/);
    assert.match(trace.report(), /getInsertChoices done/);
    assert.match(trace.report(), /insertToTarget failed/);
    assert.doesNotMatch(trace.report(), /private/);
});
