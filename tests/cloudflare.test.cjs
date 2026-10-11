const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function harness(fetch = () => { throw new Error('Unexpected upstream request'); }, logs = []) {
    const exports = {};
    const source = fs.readFileSync(require.resolve('../cloudflare/worker.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    vm.runInNewContext(code.outputText, { exports, URL, URLSearchParams, Request, Response, Headers, TypeError, fetch,
        console: { warn: (...args) => logs.push(args), error() {} },
    });
    const env = {
        ONSHAPE_CLIENT_ID: 'test-client', ONSHAPE_CLIENT_SECRET: 'test-secret',
        ONSHAPE_ORIGIN: 'https://cad.onshape.com',
        ASSETS: { fetch: async () => new Response('<html>test</html>', { headers: { 'Content-Type': 'text/html' } }) },
    };
    return (path, init, overrides) => exports.default.fetch(new Request('https://test.workers.dev' + path, init), { ...env, ...overrides });
}

test('Cloudflare launch supplies the configured client and exact frontend callback', async () => {
    const run = harness();
    const response = await run('/redirect.php?client_id=untrusted&documentId=' + 'a'.repeat(24) + '&workspaceId=' + 'b'.repeat(24) + '&elementId=' + 'c'.repeat(24));
    const target = new URL(response.headers.get('Location'));
    assert.equal(response.status, 302);
    assert.equal(target.origin, 'https://oauth.onshape.com');
    assert.equal(target.searchParams.get('client_id'), 'test-client');
    assert.equal(target.searchParams.get('redirect_uri'), 'https://test.workers.dev/?documentId=' + 'a'.repeat(24) + '&workspaceId=' + 'b'.repeat(24) + '&elementId=' + 'c'.repeat(24));
    assert.equal((await run('/redirect.php?documentId=bad')).status, 400);
});

test('OAuth exchange and refresh encode secrets and preserve upstream errors without caching', async () => {
    const calls = [];
    const run = harness(async (url, init) => { calls.push({ url, init }); return new Response('{"error":"invalid_grant"}', { status: 400, headers: { 'Content-Type': 'application/json' } }); });
    const uri = 'https://test.workers.dev/?documentId=a&workspaceId=b&elementId=c';
    const response = await run('/oauth.php?code=a%2Bb&redirect_uri=' + encodeURIComponent(uri));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '{"error":"invalid_grant"}');
    assert.equal(calls[0].url, 'https://oauth.onshape.com/oauth/token');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].init.body.get('code'), 'a+b');
    assert.equal(calls[0].init.body.get('client_secret'), 'test-secret');
    assert.equal(calls[0].init.body.get('redirect_uri'), uri);
    await run('/refresh.php?code=refresh%2Btoken');
    assert.equal(calls[1].init.body.get('grant_type'), 'refresh_token');
    assert.equal(calls[1].init.body.get('refresh_token'), 'refresh+token');
});

test('OAuth refuses foreign callbacks and missing secrets before making upstream requests', async () => {
    const run = harness();
    assert.equal((await run('/oauth.php?code=a&redirect_uri=https://evil.example/')).status, 400);
    assert.equal((await run('/oauth.php?code=a&redirect_uri=garbage')).status, 400);
    assert.equal((await run('/refresh.php?code=a', undefined, { ONSHAPE_CLIENT_SECRET: '' })).status, 503);
    assert.equal((await run('/refresh.php')).status, 400);
    assert.equal((await run('/oauth.php', { method: 'POST' })).status, 405);
});

test('OAuth and style helpers use workerd redirect mode and refuse upstream redirects', async () => {
    const run = harness(async (url, init) => {
        assert.equal(init.redirect, 'manual');
        return Response.redirect('https://evil.example', 302);
    });
    assert.equal((await run('/oauth.php?code=test&redirect_uri=https://test.workers.dev/')).status, 502);
    assert.equal((await run('/getfile.php?url=https://cad.onshape.com/css/test.css')).status, 502);
});

test('API proxy streams every write method and retains query, content type, status and rate limits', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        let observed;
        const run = harness(async (url, init) => {
            observed = { url, method: init.method, headers: init.headers, body: await new Response(init.body).text() };
            return new Response('slow down', { status: 429, headers: { 'Retry-After': '7', 'X-Rate-Limit-Remaining': '0', 'Content-Type': 'text/plain' } });
        });
        const response = await run('/api/v10/documents/d?x=a%2Bb', { method, body: '{"x":1}', headers: {
            Authorization: 'Bearer token', 'X-Server': 'https://cad.onshape.com', 'Content-Type': 'application/json', Cookie: 'private',
        } });
        assert.equal(observed.url, 'https://cad.onshape.com/api/v10/documents/d?x=a%2Bb');
        assert.equal(observed.method, method);
        assert.equal(observed.body, '{"x":1}');
        assert.equal(observed.headers.get('Content-Type'), 'application/json');
        assert.equal(observed.headers.get('Cookie'), null);
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('Retry-After'), '7');
        assert.equal(response.headers.get('X-Rate-Limit-Remaining'), '0');
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
});

test('API proxy preserves multipart uploads and binary thumbnails', async () => {
    const data = new FormData();
    data.set('file', new Blob(['part data']), 'part.txt');
    const run = harness(async (url, init) => {
        const form = await new Response(init.body, { headers: init.headers }).formData();
        assert.equal(await form.get('file').text(), 'part data');
        return new Response(new Uint8Array([0, 128, 255]), { headers: { 'Content-Type': 'image/png' } });
    });
    const response = await run('/api/blobelements', { method: 'POST', body: data, headers: { Authorization: 'Bearer token' } });
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255]));
    assert.equal(response.headers.get('Content-Type'), 'image/png');
});

test('API proxy rejects arbitrary upstreams, missing tokens and redirected API requests', async () => {
    const run = harness();
    assert.equal((await run('/api/users', { headers: { Authorization: 'Bearer a', 'X-Server': 'https://evil.example' } })).status, 400);
    assert.equal((await run('/api/users')).status, 401);
    const redirected = harness(async () => Response.redirect('https://evil.example', 302));
    assert.equal((await redirected('/api/users', { headers: { Authorization: 'Bearer a' } })).status, 502);
});

test('thumbnail redirects log only sanitized destinations and remain blocked', async () => {
    for (const location of [
        'https://username:password@images.onshape.com/api/thumbnails/' + 'a'.repeat(24) + '/s/70x40?signature=private#fragment',
        '/api/thumbnails/' + 'b'.repeat(24) + '/s/70x40?token=private',
        'http://[', null,
    ]) {
        const logs = [];
        let calls = 0;
        const run = harness(async () => {
            calls++;
            return new Response(null, { status: 307, headers: location ? { Location: location } : {} });
        }, logs);
        const response = await run('/api/thumbnails/d/' + 'c'.repeat(24) + '/s/70x40', {
            headers: { Authorization: 'Bearer sensitive-token' },
        });
        assert.equal(response.status, 502);
        assert.equal(calls, 1);
        assert.equal(logs.length, 1);
        assert.equal(logs[0][0], '[Thumbnail redirect]');
        assert.equal(logs[0][1].status, 307);
        if (location && location !== 'http://[') {
            assert.equal(logs[0][1].destination.host, location.startsWith('/') ? 'cad.onshape.com' : 'images.onshape.com');
            assert.equal(logs[0][1].destination.path, '/api/thumbnails/:id/s/70x40');
        } else assert.equal(logs[0][1].destination, null);
        assert.doesNotMatch(JSON.stringify(logs), /username|password|private|fragment|sensitive-token|a{24}|b{24}|c{24}/);
    }
});

test('Onshape CSS helper and sign-in only accept configured Onshape origin', async () => {
    let destination;
    const run = harness(async (url) => { destination = url; return new Response('css'); });
    assert.equal(await (await run('/getfile.php?url=https://cad.onshape.com/css/test.css')).text(), 'css');
    assert.equal(destination, 'https://cad.onshape.com/css/test.css');
    assert.equal((await run('/getfile.php?url=https://evil.example')).status, 400);
    assert.equal((await run('/oauthsignin.php?redirectOnshapeUri=https://evil.example')).status, 400);
    const response = await run('/oauthsignin.php?redirectOnshapeUri=' + encodeURIComponent('https://cad.onshape.com/documents/a'));
    const callback = new URL(new URL(response.headers.get('Location')).searchParams.get('redirect_uri'));
    assert.equal(callback.searchParams.get('redirectOnshapeUri'), 'https://cad.onshape.com/documents/a');
});

test('static HTML is uncached, PHP and dotfiles are blocked, upstream failures omit details', async () => {
    const run = harness();
    assert.equal((await run('/?code=sensitive')).headers.get('Cache-Control'), 'no-store');
    assert.equal((await run('/main-hash.js')).headers.get('Cache-Control'), null);
    for (const path of ['/config.php', '/server/config.php', '/.dev.vars', '/api.php']) {
        assert.equal((await run(path)).status, 404);
    }
    const failing = harness(async () => { throw new Error('secret details'); });
    const response = await failing('/api/users', { headers: { Authorization: 'Bearer a' } });
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('secret details'), false);
});
