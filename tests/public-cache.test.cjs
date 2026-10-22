const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('./helpers/cloudflare.cjs');

const library = '2fd951db6d0261aba5f16a5d';
const document = 'a'.repeat(24);
const blob = `/api/v10/blobelements/d/${library}/w/${'b'.repeat(24)}/e/${'c'.repeat(24)}`;
const image = `/api/thumbnails/d/${document}/v/${'d'.repeat(24)}/s/70x40`;
const appOrigin = 'https://app.example';
const r2Origin = 'https://cache.example';
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json',
    'Set-Cookie': 'private=cookie', 'X-Rate-Limit-Remaining': '12' } });
const user = token => ({ Authorization: 'Bearer ' + token, 'X-Server': 'https://cad.onshape.com', Accept: 'application/json' });

function harness(upstream = async url => url.includes('/thumbnails/')
    ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
    : json([{ jsonType: 'document-summary', id: document }])) {
    const clock = { now: 6001000 };
    const objects = new Map();
    const calls = [];
    const network = [];
    const globals = { Date: class extends Date { static now() { return clock.now; } },
        fetch: async (url, init) => { calls.push({ url, init }); return upstream(url, init); } };
    const worker = load('cloudflare/worker.ts', globals);
    const resources = load('cloudflare/publicresources.ts', globals);
    const env = {
        ONSHAPE_ORIGIN: 'https://cad.onshape.com', PUBLIC_LIBRARY_CACHE_ORIGIN: r2Origin,
        ASSETS: { fetch: async () => new Response('static') },
        PUBLIC_LIBRARY_BUCKET: {
            get: async key => {
                const item = objects.get(key);
                return item ? { arrayBuffer: async () => item.body.slice(0), httpMetadata: item.metadata } : null;
            },
            put: async (key, body, options) => { objects.set(key, { body: body.slice(0), metadata: options.httpMetadata }); },
        },
    };
    const instances = new Map();
    env.PUBLIC_LIBRARY_REFRESH = {
        idFromName: key => key,
        get: key => {
            if (!instances.has(key)) instances.set(key, new worker.GlobalLibraryRefresh({}, env));
            return instances.get(key);
        },
    };
    const run = (path, headers = user('alice'), extra = {}) => worker.default.fetch(new Request(appOrigin + path, {
        headers, ...extra,
    }), env);
    const fetcher = async (input, init = {}) => {
        const url = new URL(input);
        network.push({ url: url.toString(), init });
        if (url.origin === r2Origin) {
            const item = objects.get(url.pathname.slice(1));
            return item ? new Response(item.body.slice(0), { headers: { 'Content-Type': item.metadata.contentType } }) : new Response(null, { status: 404 });
        }
        assert.equal(url.origin, appOrigin);
        return worker.default.fetch(new Request(input, init), env);
    };
    return { clock, objects, calls, network, env, instances, run, fetcher, resources, worker, globals };
}

test('simultaneous callers from separate Worker isolates share one upstream JSON fetch and publish only validated bytes', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness(async () => { await gate; return json({ children: [{ jsonType: 'document-summary', id: document }] }); });
    const otherRegion = load('cloudflare/worker.ts', h.globals);
    const requests = Array.from({ length: 20 }, (_, index) => (index % 2 ? otherRegion : h.worker).default.fetch(
        new Request(appOrigin + blob, { headers: user('user-' + index) }), h.env));
    await new Promise(resolve => setImmediate(resolve));
    release();
    const responses = await Promise.all(requests);
    assert.equal(h.calls.length, 1);
    for (const response of responses) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Set-Cookie'), null);
        assert.equal(response.headers.get('X-Rate-Limit-Remaining'), null);
        assert.equal((await response.json()).children[0].id, document);
    }
    assert.equal(h.objects.size, 1);
    const [key, item] = [...h.objects][0];
    assert.match(key, /^global-library\/v1\/10\/[a-f0-9]{64}$/);
    assert.doesNotMatch(key, /alice|user-|Bearer/);
    assert.equal(item.metadata.contentType, 'application/json');
    assert.equal(item.metadata.cacheControl, 'public, max-age=599');
});

test('R2 hits survive object restarts, while the next ten-minute window lazily refetches', async () => {
    const h = harness();
    await h.run(blob);
    h.instances.clear();
    assert.equal((await h.run(blob)).headers.get('X-Global-Library-Cache'), 'HIT');
    assert.equal(h.calls.length, 1);
    h.clock.now = 6600000;
    const refreshed = await h.run(blob);
    assert.equal(refreshed.headers.get('X-Global-Library-Cache'), 'MISS');
    assert.match(refreshed.headers.get('X-Public-Cache-Key'), /\/11\//);
    assert.equal(h.calls.length, 2);
});

test('a slow fill never writes its response into the next freshness window', async () => {
    let started;
    let release;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness(async () => { started(); await gate; return json([]); });
    const pending = h.run(blob);
    await entered;
    h.clock.now = 6600000;
    release();
    await pending;
    assert.match([...h.objects.keys()][0], /\/10\//);
    await h.run(blob);
    assert.equal(h.calls.length, 2);
    assert.equal(h.objects.size, 2);
});

test('verified source membership permits images after coordinator restart and coalesces their refresh', async () => {
    const h = harness();
    await h.run(blob);
    h.instances.clear();
    const headers = { ...user('bob'), Accept: 'image/png', 'X-Public-Library-Source': blob };
    const responses = await Promise.all(Array.from({ length: 12 }, () => h.run(image, headers)));
    assert.equal(h.calls.filter(call => call.url.includes('/thumbnails/')).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/blobelements/')).length, 1);
    for (const response of responses) assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.equal(h.objects.size, 2);
});

test('untrusted source hints cannot publish arbitrary thumbnails or private JSON', async () => {
    for (const source of [undefined, 'https://evil.example' + blob, blob.replace(library, 'e'.repeat(24)), '/api/documents/private', blob]) {
        const h = harness(async url => url.includes('/blobelements/') ? json([])
            : new Response('private image', { headers: { 'Content-Type': 'image/png' } }));
        const headers = user('alice');
        if (source) headers['X-Public-Library-Source'] = source;
        const response = await h.run(image, headers);
        assert.equal(response.headers.get('X-Public-Cache-Key'), null);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal([...h.objects.values()].some(item => item.metadata.contentType === 'image/png'), false);
        assert.equal(h.calls.some(call => call.url.includes('evil.example')), false);
    }
    const h = harness();
    const response = await h.run(blob.replace(library, 'e'.repeat(24)));
    assert.equal(response.headers.get('X-Public-Cache-Key'), null);
    assert.equal(h.objects.size, 0);
});

test('an expired source is refreshed before authorizing a previously public image', async () => {
    let current = [{ jsonType: 'document-summary', id: document }];
    const h = harness(async url => url.includes('/blobelements/') ? json(current)
        : new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    const headers = { ...user('alice'), 'X-Public-Library-Source': blob };
    await h.run(image, headers);
    current = [];
    h.clock.now = 6600000;
    const response = await h.run(image, headers);
    assert.equal(response.headers.get('X-Public-Cache-Key'), null);
    assert.equal([...h.objects].filter(([key, item]) => key.includes('/11/') && item.metadata.contentType === 'image/png').length, 0);
});

test('vendor summaries authorize opaque images without publishing personalized fields', async () => {
    const opaque = '/api/thumbnails/' + 'f'.repeat(40) + '/s/70x40';
    const summary = '/api/v10/documents/' + library;
    const h = harness(async url => url.includes('/thumbnails/')
        ? new Response('logo', { headers: { 'Content-Type': 'image/png' } })
        : json({ privateField: 'alice-secret', thumbnail: { sizes: [{ href: 'https://cad.onshape.com' + opaque }] } }));
    assert.equal((await h.run(opaque, { ...user('alice'), 'X-Public-Library-Source': summary })).status, 200);
    assert.equal(h.objects.size, 1);
    for (const item of h.objects.values()) assert.doesNotMatch(new TextDecoder().decode(item.body), /alice-secret/);
});

test('failed fills retry; JSON Accept defaults share storage and queries remain distinct', async () => {
    let fail = true;
    const h = harness(async () => fail ? new Response('secret error', { status: 503 }) : json([]));
    const failed = await h.run(blob);
    assert.equal(failed.status, 503);
    assert.equal(await failed.text(), '');
    assert.equal(h.objects.size, 0);
    fail = false;
    await h.run(blob);
    await h.run(blob, { ...user('alice'), Accept: 'text/plain' });
    await h.run(blob + '?variant=2');
    assert.equal(h.objects.size, 2);
    assert.equal(h.calls.length, 3);
});

test('thumbnail Accept variants remain distinct', async () => {
    const h = harness();
    const logo = `/api/thumbnails/d/${library}/s/70x40`;
    await h.run(logo, { ...user('alice'), Accept: 'image/png' });
    await h.run(logo, { ...user('alice'), Accept: 'image/webp' });
    assert.equal(h.objects.size, 2);
    assert.equal(h.calls.length, 2);
});

test('storage failures fall back to the authenticated proxy without publishing data', async () => {
    const h = harness();
    h.env.PUBLIC_LIBRARY_BUCKET.get = async () => { throw new Error('R2 unavailable'); };
    const response = await h.run(blob);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Public-Cache-Key'), null);
    assert.equal(h.objects.size, 0);
    assert.equal(h.calls.length, 1);
});

test('malformed JSON, non-image responses and foreign redirects never reach public storage', async () => {
    for (const upstream of [
        async () => new Response('not JSON'),
        async () => new Response('redirect', { status: 302, headers: { Location: 'https://evil.example/private' } }),
    ]) {
        const h = harness(upstream);
        await h.run(blob);
        assert.equal(h.objects.size, 0);
    }
    const h = harness(async () => new Response('private JSON', { headers: { 'Content-Type': 'application/json' } }));
    await h.run(`/api/thumbnails/d/${library}/s/70x40`);
    assert.equal(h.objects.size, 0);
});

test('private, Enterprise, partial and write requests retain normal proxy behavior', async () => {
    const h = harness();
    await h.run(blob, { ...user('alice'), Range: 'bytes=0-5' });
    await h.run(blob, user('alice'), { method: 'POST', body: '{}' });
    assert.equal(h.objects.size, 0);
    assert.equal(h.instances.size, 0);
    h.env.ONSHAPE_ORIGIN = 'https://enterprise.example';
    await h.run(blob, { ...user('alice'), 'X-Server': 'https://enterprise.example' });
    assert.equal(h.instances.size, 0);
    assert.equal((await h.run(blob, {})).status, 401);
});

test('frontend JSON and thumbnail reads go directly to R2 after fills, without credentials', async () => {
    const h = harness();
    const { publicTransport } = load('cloudflare/publictransport.ts', h.globals);
    const client = publicTransport(appOrigin, h.fetcher);
    await client(appOrigin + blob, { headers: user('alice') });
    await client(appOrigin + image, { headers: { ...user('alice'), Accept: 'image/png' } });
    const apiCalls = h.network.filter(call => call.url.startsWith(appOrigin + '/api/')).length;
    const secondClient = publicTransport(appOrigin, h.fetcher);
    assert.equal((await secondClient(appOrigin + blob, { headers: user('bob') })).status, 200);
    assert.equal((await secondClient(appOrigin + image, { headers: { ...user('bob'), Accept: 'image/png' } })).status, 200);
    assert.equal(h.network.filter(call => call.url.startsWith(appOrigin + '/api/')).length, apiCalls);
    assert.equal(h.calls.length, 2);
    for (const call of h.network.filter(call => call.url.startsWith(r2Origin))) {
        assert.equal(call.init.credentials, 'omit');
        assert.equal(new Headers(call.init.headers).get('Authorization'), null);
        assert.equal(new Headers(call.init.headers).get('X-Server'), null);
        assert.equal(call.init.referrerPolicy, 'no-referrer');
    }
    h.clock.now += 600000;
    await secondClient(appOrigin + blob, { headers: user('bob') });
    assert.equal(h.calls.length, 3);
});

test('frontend bypasses R2 for private requests and falls back on storage/network failure', async () => {
    const h = harness();
    const { publicTransport } = load('cloudflare/publictransport.ts');
    const client = publicTransport(appOrigin, async (input, init) => {
        if (input.startsWith(r2Origin)) throw new Error('CORS or network failure');
        return h.fetcher(input, init);
    });
    await client(appOrigin + blob, { headers: user('alice') });
    assert.equal(h.calls.length, 1);
    const privatePath = blob.replace(library, 'e'.repeat(24));
    await client(appOrigin + privatePath, { headers: user('alice') });
    assert.equal(h.network.filter(call => call.url.startsWith(r2Origin)).length, 0);
    await client(appOrigin + blob, { headers: { ...user('alice'), 'X-Server': 'https://enterprise.example' } });
    assert.equal(h.network.at(-1).url, appOrigin + blob);
});
