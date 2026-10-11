const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const exportsForTest = {};
const source = fs.readFileSync(require.resolve('../cloudflare/diagnostics.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
vm.runInNewContext(code.outputText, { exports: exportsForTest, URL });
const { requestLabel, errorCode, DiagnosticLog } = exportsForTest;

test('diagnostic labels omit query credentials, document IDs and external URLs', () => {
    const origin = 'https://test.workers.dev';
    assert.equal(requestLabel('/oauth.php?code=secret&redirect_uri=private', origin), '/oauth.php');
    assert.equal(requestLabel('/api/v10/documents/d/private-name?token=secret', origin), '/api/documents/…');
    assert.equal(requestLabel('/api/thumbnails/private-id/s/70x40', origin), '/api/thumbnails/…');
    assert.equal(requestLabel('/private-file.txt?secret=value', origin), '[app asset]');
    assert.equal(requestLabel('https://secret.example/private', origin), '[external request]');
});

test('diagnostics only display recognized OAuth errors, never response values', () => {
    assert.equal(errorCode('{"error":"invalid_grant","access_token":"secret","error_description":"private"}'), 'invalid_grant');
    assert.equal(errorCode('{"error":"secret-token-value"}'), undefined);
    assert.equal(errorCode('not json'), undefined);
});

test('diagnostic history is bounded and distinguishes HTTP errors from network failures', () => {
    const log = new DiagnosticLog();
    for (let i = 0; i < 35; i++) log.record({ method: 'GET', route: '/oauth.php', status: 400, ms: i, error: 'invalid_grant' });
    assert.equal(log.requests.length, 30);
    assert.equal(log.requests[0].ms, 5);
    log.record({ method: 'POST', route: '/api/assemblies/…', status: 0, ms: 20 });
    log.startupFailed = true;
    assert.match(log.text(), /Startup: failed/);
    assert.match(log.text(), /400.*invalid_grant/);
    assert.match(log.text(), /network failure/);
});
