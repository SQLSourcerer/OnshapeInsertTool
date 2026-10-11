const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function harness(fetch = () => { throw new Error('Unexpected upstream request'); }, logs = [], cache) {
    const exports = {};
    const source = fs.readFileSync(require.resolve('../cloudflare/worker.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    vm.runInNewContext(code.outputText, { exports, URL, URLSearchParams, Request, Response, Headers, TypeError, fetch,
        caches: cache && { open: async () => cache },
        Date: cache ? class extends Date { static now() { return cache.now; } } : Date,
        console: { warn: (...args) => logs.push(args), error() {} },
    });
    const env = {
        ONSHAPE_CLIENT_ID: 'test-client', ONSHAPE_CLIENT_SECRET: 'test-secret',
        ONSHAPE_ORIGIN: 'https://cad.onshape.com',
        ASSETS: { fetch: async () => new Response('<html>test</html>', { headers: { 'Content-Type': 'text/html' } }) },
    };
    return (path, init, overrides) => exports.default.fetch(new Request('https://test.workers.dev' + path, init), { ...env, ...overrides });
}

function memoryCache() {
    const entries = new Map();
    return {
        now: 0, entries,
        async match(key) {
            const entry = entries.get(key.url);
            return entry && entry.expires > this.now ? entry.response.clone() : undefined;
        },
        async put(key, response) {
            const ttl = Number(response.headers.get('Cache-Control').match(/max-age=(\d+)/)[1]);
            // Consume streams as Cloudflare does; never store a bearer token in a key.
            const stored = new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
            entries.set(key.url, { response: stored, expires: this.now + ttl * 1000 });
        },
        async delete(key) { return entries.delete(typeof key === 'string' ? key : key.url); },
    };
}

const libraryId = '2fd951db6d0261aba5f16a5d';
const documentId = 'a'.repeat(24);
const blobPath = '/api/v10/blobelements/d/' + libraryId + '/w/' + 'b'.repeat(24) + '/e/' + 'c'.repeat(24);
const thumbnailPath = '/api/thumbnails/d/' + documentId + '/s/70x40';
const user = token => ({ headers: { Authorization: 'Bearer ' + token } });

test('backend library allowlist matches the frontend Global Libraries', () => {
    const frontend = fs.readFileSync(require.resolve('../app/app.ts'), 'utf8').match(/globalLibrariesNodes: string\[\] = \[([\s\S]*?)\];/)[1];
    const worker = fs.readFileSync(require.resolve('../cloudflare/worker.ts'), 'utf8').match(/const globalLibraries = \[([\s\S]*?)\];/)[1];
    assert.deepEqual(worker.match(/[a-f0-9]{24}/g), frontend.match(/[a-f0-9]{24}/g));
});

test('library JSON is shared across users and Worker instances, expires, and omits another user quota', async () => {
    const cache = memoryCache();
    let calls = 0;
    const upstream = async () => { calls++; return new Response(JSON.stringify({ children: [{ jsonType: 'document-summary', id: documentId }] }), {
        headers: { 'Content-Type': 'application/json', 'X-Rate-Limit-Remaining': '12' },
    }); };
    const first = await harness(upstream, [], cache)(blobPath, user('alice-secret'));
    assert.equal(first.headers.get('X-Global-Library-Cache'), 'MISS');
    assert.equal(first.headers.get('X-Rate-Limit-Remaining'), '12');
    const run = harness(upstream, [], cache);
    const hit = await run(blobPath, user('bob-secret'));
    assert.equal(hit.headers.get('X-Global-Library-Cache'), 'HIT');
    assert.equal(hit.headers.get('Cache-Control'), 'no-store');
    assert.equal(hit.headers.get('X-Rate-Limit-Remaining'), null);
    assert.equal(await hit.text(), await first.text());
    assert.equal(calls, 1);
    assert.equal((await run(blobPath)).status, 401);
    assert.equal((await run(blobPath, { headers: { Authorization: 'Bearer x', 'X-Server': 'https://evil.example' } })).status, 400);
    assert.doesNotMatch([...cache.entries.keys()].join(), /alice-secret|bob-secret/);
    cache.now = 15 * 60 * 1000;
    assert.equal((await run(blobPath, user('bob'))).headers.get('X-Global-Library-Cache'), 'MISS');
    assert.equal(calls, 2);
});

test('thumbnails learned from public library JSON share binary responses but unknown thumbnails bypass', async () => {
    const cache = memoryCache();
    const opaque = '/api/thumbnails/' + 'd'.repeat(40) + '/s/70x40?t=revision';
    let calls = 0;
    const upstream = async path => {
        calls++;
        if (path.includes('/blobelements/')) return new Response(JSON.stringify({ children: [
            { jsonType: 'document-summary', id: documentId, thumbnail: { sizes: [{ href: 'https://cad.onshape.com' + opaque }] } },
            { href: 'https://evil.example/api/thumbnails/foreign/s/70x40' },
        ] }));
        return new Response(new Uint8Array([0, 128, 255]), { headers: { 'Content-Type': 'image/png' } });
    };
    let run = harness(upstream, [], cache);
    assert.equal((await run(thumbnailPath, user('alice'))).headers.get('X-Global-Library-Cache'), 'BYPASS');
    await run(blobPath, user('alice'));
    run = harness(upstream, [], cache);
    for (const path of [thumbnailPath, opaque]) {
        assert.equal((await run(path, user('alice'))).headers.get('X-Global-Library-Cache'), 'MISS');
        const hit = await run(path, user('bob'));
        assert.equal(hit.headers.get('X-Global-Library-Cache'), 'HIT');
        assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), new Uint8Array([0, 128, 255]));
    }
    assert.equal(calls, 4);
    for (const path of ['/api/thumbnails/foreign/s/70x40', thumbnailPath.replace(documentId, 'e'.repeat(24))]) {
        assert.equal((await run(path, user('bob'))).headers.get('X-Global-Library-Cache'), 'BYPASS');
    }
    cache.now = 5 * 60 * 1000;
    assert.equal((await run(thumbnailPath, user('bob'))).headers.get('X-Global-Library-Cache'), 'MISS');
    assert.equal((await run(opaque, user('bob'))).headers.get('X-Global-Library-Cache'), 'HIT');
    cache.now = 15 * 60 * 1000;
    assert.equal((await run(opaque, user('bob'))).headers.get('X-Global-Library-Cache'), 'BYPASS');
});

test('vendor logos reuse the library document allowlist and remain shared for three hours', async () => {
    const cache = memoryCache();
    let calls = 0;
    const upstream = async () => { calls++; return new Response('logo', { headers: { 'Content-Type': 'image/png' } }); };
    const path = '/api/thumbnails/d/' + libraryId + '/s/70x40';
    const first = await harness(upstream, [], cache)(path, user('alice'));
    assert.equal(first.headers.get('X-Global-Library-Cache'), 'MISS');
    const run = harness(upstream, [], cache);
    cache.now = 3 * 60 * 60 * 1000 - 1;
    const hit = await run(path, user('bob'));
    assert.equal(hit.headers.get('X-Global-Library-Cache'), 'HIT');
    assert.equal(await hit.text(), 'logo');
    assert.equal(calls, 1);
    cache.now++;
    assert.equal((await run(path, user('bob'))).headers.get('X-Global-Library-Cache'), 'MISS');
    assert.equal(calls, 2);
});

test('version-specific and thumbnail-ID images remain cached for three hours without extending expiry on hits', async () => {
    const cache = memoryCache();
    const opaque = '/api/thumbnails/' + 'd'.repeat(40) + '/s/70x40';
    const versioned = thumbnailPath.replace('/s/', '/v/' + 'f'.repeat(24) + '/s/');
    let imageCalls = 0;
    const run = harness(async path => {
        if (path.includes('/blobelements/')) return new Response(JSON.stringify({ children: [
            { jsonType: 'document-summary', id: documentId, thumbnail: { sizes: [{ href: 'https://cad.onshape.com' + opaque }] } },
        ] }));
        imageCalls++;
        return new Response('image', { headers: { 'Content-Type': 'image/png' } });
    }, [], cache);
    await run(blobPath, user('alice'));
    for (const path of [versioned, opaque]) {
        assert.equal((await run(path, user('alice'))).headers.get('X-Global-Library-Cache'), 'MISS');
    }
    cache.now = 3 * 60 * 60 * 1000 - 1;
    // Library reads refresh eligibility separately from the image response TTL.
    await run(blobPath, user('bob'));
    for (const path of [versioned, opaque]) {
        assert.equal((await run(path, user('bob'))).headers.get('X-Global-Library-Cache'), 'HIT');
    }
    assert.equal(imageCalls, 2);
    cache.now++;
    for (const path of [versioned, opaque]) {
        assert.equal((await run(path, user('bob'))).headers.get('X-Global-Library-Cache'), 'MISS');
    }
    assert.equal(imageCalls, 4);
});

test('cache variants preserve queries and Accept, while private, tenant, conditional and write requests bypass', async () => {
    const cache = memoryCache();
    const calls = [];
    const run = harness(async (url, init) => {
        calls.push({ url, init });
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }, [], cache);
    await run(blobPath, user('a'));
    await run(blobPath + '?contentDisposition=attachment', user('b'));
    await run(blobPath, { headers: { Authorization: 'Bearer b', Accept: 'application/json' } });
    assert.equal(calls.length, 3);
    for (const path of [blobPath.replace(libraryId, documentId), '/api/documents/' + libraryId, '/api/globaltreenodes/folder/test/insertables']) {
        await run(path, user('a')); await run(path, user('b'));
    }
    assert.equal(calls.length, 9);
    for (const header of ['Range', 'If-Match', 'If-None-Match', 'If-Modified-Since']) {
        const response = await run(blobPath, { headers: { Authorization: 'Bearer b', [header]: 'test' } });
        assert.equal(response.headers.get('X-Global-Library-Cache'), 'BYPASS');
        assert.equal(calls.at(-1).init.headers.get(header), 'test');
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        const response = await run(blobPath, { method, headers: { Authorization: 'Bearer a' } });
        assert.equal(response.headers.get('X-Global-Library-Cache'), 'BYPASS');
    }
    const tenant = await run(blobPath, user('a'), { ONSHAPE_ORIGIN: 'https://enterprise.onshape.com' });
    assert.equal(tenant.headers.get('X-Global-Library-Cache'), 'BYPASS');
});

test('failed, partial, malformed and non-image responses never enter the shared cache', async () => {
    for (const options of [{ status: 403 }, { status: 429 }, { status: 503 }, { status: 206 }, {}]) {
        const cache = memoryCache();
        let calls = 0;
        const run = harness(async () => { calls++; return new Response('not JSON', options); }, [], cache);
        await run(blobPath, user('a')); await run(blobPath, user('b'));
        assert.equal(calls, 2);
        assert.equal(cache.entries.size, 0);
    }
    const cache = memoryCache();
    let calls = 0;
    const run = harness(async () => { calls++; return new Response('error', { headers: { 'Content-Type': 'text/html' } }); }, [], cache);
    const path = '/api/thumbnails/d/' + libraryId + '/s/70x40';
    await run(path, user('a')); await run(path, user('b'));
    assert.equal(calls, 2);
    assert.equal(cache.entries.size, 0);
});

test('public library files and thumbnails cache despite upstream cookies, without storing or forwarding cookies', async () => {
    const cache = memoryCache();
    let calls = 0;
    const run = harness(async url => {
        calls++;
        const image = url.includes('/thumbnails/');
        return new Response(image ? 'image' : '{}', {
            headers: { 'Content-Type': image ? 'image/png' : 'application/json', 'Set-Cookie': 'upstream-session=secret' },
        });
    }, [], cache);
    for (const path of [blobPath, '/api/thumbnails/d/' + libraryId + '/s/70x40']) {
        const first = await run(path, user('alice'));
        assert.equal(first.headers.get('X-Global-Library-Cache'), 'MISS');
        assert.equal(first.headers.get('Set-Cookie'), null);
        const second = await run(path, user('bob'));
        assert.equal(second.headers.get('X-Global-Library-Cache'), 'HIT');
        assert.equal(second.headers.get('Set-Cookie'), null);
    }
    assert.equal(calls, 2);
    for (const { response } of cache.entries.values()) assert.equal(response.headers.get('Set-Cookie'), null);
    for (let i = 0; i < 2; i++) {
        const privateResponse = await run(blobPath.replace(libraryId, documentId), user('bob'));
        assert.equal(privateResponse.headers.get('X-Global-Library-Cache'), 'BYPASS');
        assert.equal(privateResponse.headers.get('Set-Cookie'), null);
    }
    assert.equal(calls, 4);
});

test('cache failures fall back to upstream without breaking successful responses', async () => {
    const cache = memoryCache();
    cache.match = async () => { throw new Error('unavailable'); };
    const run = harness(async () => new Response('{}'), [], cache);
    assert.equal(await (await run(blobPath, user('a'))).text(), '{}');
    cache.match = async () => undefined;
    cache.put = async () => { throw new Error('unavailable'); };
    assert.equal(await (await run(blobPath, user('a'))).text(), '{}');
});

test('successful library writes invalidate Blob variants and learned thumbnail membership, failed writes retain them', async () => {
    const cache = memoryCache();
    let contents = { children: [{ jsonType: 'document-summary', id: documentId }] };
    let writeStatus = 403;
    const run = harness(async (url, init) => {
        if (init.method !== 'GET') return new Response('{}', { status: writeStatus });
        if (url.includes('/blobelements/')) return new Response(JSON.stringify(contents));
        return new Response('image', { headers: { 'Content-Type': 'image/png' } });
    }, [], cache);
    await run(blobPath, user('a'));
    await run(blobPath, { headers: { Authorization: 'Bearer a', Accept: 'application/json' } });
    await run(thumbnailPath, user('a'));
    await run(blobPath, { method: 'POST', ...user('a') });
    assert.equal((await run(blobPath, user('b'))).headers.get('X-Global-Library-Cache'), 'HIT');
    contents = { children: [] };
    writeStatus = 200;
    await run(blobPath, { method: 'POST', ...user('a') });
    assert.equal((await run(thumbnailPath, user('b'))).headers.get('X-Global-Library-Cache'), 'BYPASS');
    const fresh = await run(blobPath, user('b'));
    assert.equal(fresh.headers.get('X-Global-Library-Cache'), 'MISS');
    assert.equal(await fresh.text(), JSON.stringify(contents));
    assert.equal((await run(blobPath, { headers: { Authorization: 'Bearer b', Accept: 'application/json' } })).headers.get('X-Global-Library-Cache'), 'MISS');
});

test('vendor document summaries teach opaque thumbnail URLs without caching personalized fields', async () => {
    const cache = memoryCache();
    const opaque = '/api/thumbnails/' + 'f'.repeat(40) + '/s/70x40';
    let calls = 0;
    const run = harness(async (url, init) => {
        calls++;
        if (url.includes('/documents/')) return new Response(JSON.stringify({
            userSpecific: init.headers.get('Authorization'), thumbnail: { sizes: [{ href: 'https://cad.onshape.com' + opaque }] },
            userSpecificUrl: 'https://cad.onshape.com/documents/' + documentId,
        }), { headers: { 'Set-Cookie': 'upstream-session=secret' } });
        return new Response('image', { headers: { 'Content-Type': 'image/png' } });
    }, [], cache);
    const path = '/api/documents/' + libraryId;
    assert.match(await (await run(path, user('alice'))).text(), /alice/);
    assert.match(await (await run(path, user('bob'))).text(), /bob/);
    assert.equal((await run(opaque, user('alice'))).headers.get('X-Global-Library-Cache'), 'MISS');
    assert.equal((await run(opaque, user('bob'))).headers.get('X-Global-Library-Cache'), 'HIT');
    assert.equal(calls, 3);
    assert.equal((await run(thumbnailPath, user('bob'))).headers.get('X-Global-Library-Cache'), 'BYPASS');
});

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

test('thumbnail redirects log only sanitized destinations', async () => {
    for (const location of [
        'https://username:password@images.onshape.com/api/thumbnails/' + 'a'.repeat(24) + '/s/70x40?signature=private#fragment',
        '/api/thumbnails/' + 'b'.repeat(24) + '/s/70x40?token=private',
        'http://[', null,
    ]) {
        const logs = [];
        let calls = 0;
        const run = harness(async () => {
            calls++;
            if (calls === 2) return new Response('image', { headers: { 'Content-Type': 'image/png' } });
            return new Response(null, { status: 307, headers: location ? { Location: location } : {} });
        }, logs);
        const response = await run('/api/thumbnails/d/' + 'c'.repeat(24) + '/s/70x40', {
            headers: { Authorization: 'Bearer sensitive-token' },
        });
        assert.equal(response.status, location?.startsWith('/') ? 200 : 502);
        assert.equal(calls, location?.startsWith('/') ? 2 : 1);
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

test('thumbnail GETs follow same HTTPS origin redirects and preserve the final image', async () => {
    const calls = [];
    const data = new Uint8Array([0, 128, 255]);
    const run = harness(async (url, init) => {
        calls.push(url);
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'manual');
        assert.equal(init.headers.get('Authorization'), 'Bearer token');
        if (calls.length === 1) return Response.redirect('https://cad.onshape.com/images/first.png', 307);
        if (calls.length === 2) return new Response('discard this', { status: 302, headers: { Location: 'default-document.png' } });
        return new Response(data, { headers: { 'Content-Type': 'image/png' } });
    });
    const response = await run('/api/thumbnails/d/part/s/70x40', { headers: { Authorization: 'Bearer token' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), data);
    assert.equal(calls[2], 'https://cad.onshape.com/images/default-document.png');
});

test('thumbnail redirects reject other origins, credentials, loops and redirecting writes', async () => {
    for (const destination of [
        'https://evil.example/image', 'http://cad.onshape.com/image', 'https://cad.onshape.com:444/image',
        'https://user:password@cad.onshape.com/image', '/loop',
    ]) {
        let calls = 0;
        const run = harness(async () => { calls++; return new Response('redirect', { status: 307, headers: { Location: destination } }); });
        assert.equal((await run('/api/thumbnails/d/part/s/70x40', { headers: { Authorization: 'Bearer token' } })).status, 502);
        assert.equal(calls, destination === '/loop' ? 4 : 1);
    }
    for (const [path, method] of [['/api/thumbnails/d/part/s/70x40', 'POST'], ['/api/documents', 'GET']]) {
        let calls = 0;
        const run = harness(async () => { calls++; return Response.redirect('https://cad.onshape.com/images/default-document.png', 307); });
        assert.equal((await run(path, { method, headers: { Authorization: 'Bearer token' } })).status, 502);
        assert.equal(calls, 1);
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
