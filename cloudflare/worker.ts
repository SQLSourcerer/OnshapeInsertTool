import { cacheConfigured, coordinatedRead, PublicCacheEnv } from './globalcache';
import { imageDocument, publicLibraries as globalLibraries } from './publicresources';
export { GlobalLibraryRefresh } from './globalcache';

interface Env extends PublicCacheEnv {
    ASSETS: { fetch(request: Request): Promise<Response> };
    ONSHAPE_CLIENT_ID: string;
    ONSHAPE_CLIENT_SECRET: string;
    ONSHAPE_ORIGIN: string;
}

const oauthOrigin = 'https://oauth.onshape.com';
const libraryTTL = 15 * 60;
type Membership = Record<string, { expires: number; documents: string[]; thumbnails: string[]; responses: string[] }>;

function cacheKey(url: URL, kind: string, resource: string, accept = ''): Request {
    const key = new URL('/__global-library-cache/v1/' + kind, url.origin);
    key.search = new URLSearchParams({ resource, accept }).toString();
    return new Request(key.toString());
}

async function sharedCache(origin: string): Promise<Cache | undefined> {
    // The allowlist belongs to the public cad service, not Enterprise tenants.
    if (origin !== 'https://cad.onshape.com' || typeof caches === 'undefined') return undefined;
    try { return await caches.open('global-library-v1'); }
    catch { console.warn('[Global Library cache unavailable]'); return undefined; }
}

async function membership(cache: Cache, url: URL, library: string): Promise<Membership> {
    const response = await cache.match(cacheKey(url, 'membership', library));
    return response ? await response.json() as Membership : {};
}

async function learnThumbnails(cache: Cache, url: URL, library: string, data: unknown, responseKey: Request): Promise<void> {
    const documents = new Set<string>();
    const thumbnails = new Set<string>();
    const pending: unknown[] = [data];
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        const node = value as Record<string, unknown>;
        if (typeof node.id === 'string' && /^[a-f0-9]{24}$/.test(node.id) &&
            (node.jsonType === 'document-summary' || node.jsonType === 'document-summary-configured')) documents.add(node.id);
        for (const child of Object.values(node)) {
            if (typeof child === 'string') {
                try {
                    const href = new URL(child, 'https://cad.onshape.com');
                    if (href.origin !== 'https://cad.onshape.com' || href.username || href.password) continue;
                    const document = href.pathname.match(/^\/(?:api\/(?:v\d+\/)?)?documents\/(?:d\/)?([a-f0-9]{24})(?:\/|$)/);
                    if (document) documents.add(document[1]);
                    if (/^\/api\/(?:v\d+\/)?thumbnails\//.test(href.pathname)) thumbnails.add(href.pathname + href.search);
                } catch { /* Library text is not necessarily a URL. */ }
            } else if (child && typeof child === 'object') pending.push(child);
        }
    }
    const entries = await membership(cache, url, library);
    for (const [key, entry] of Object.entries(entries)) if (entry.expires <= Date.now()) delete entries[key];
    const entryKey = url.pathname + url.search;
    entries[entryKey] = {
        expires: Date.now() + libraryTTL * 1000, documents: [...documents], thumbnails: [...thumbnails],
        responses: [...new Set([...(entries[entryKey]?.responses || []), responseKey.url])],
    };
    // shortcut: concurrent index updates can lose membership and cause cache misses; coordinate writes if measured necessary.
    await cache.put(cacheKey(url, 'membership', library), new Response(JSON.stringify(entries), {
        headers: { 'Cache-Control': 'public, max-age=' + libraryTTL, 'Content-Type': 'application/json' },
    }));
}

async function invalidateLibrary(cache: Cache, url: URL, library: string): Promise<void> {
    const entries = await membership(cache, url, library);
    await Promise.all(Object.values(entries).flatMap(entry => entry.responses.map(key => cache.delete(key))));
    await cache.delete(cacheKey(url, 'membership', library));
}

async function thumbnailEligible(cache: Cache, url: URL): Promise<boolean> {
    const document = url.pathname.match(/^\/api\/(?:v\d+\/)?thumbnails\/d\/([a-f0-9]{24})(?:\/|$)/)?.[1];
    if (document && globalLibraries.includes(document)) return true;
    const indexes = await Promise.all(globalLibraries.map(library => membership(cache, url, library)));
    return indexes.some(index => Object.values(index).some(entry => entry.expires > Date.now() &&
        ((document && entry.documents.includes(document)) || entry.thumbnails.includes(url.pathname + url.search))));
}

function cacheResult(response: Response, state: string, publicThumbnail = false): Response {
    const result = uncached(response);
    if (publicThumbnail) {
        result.headers.set('Cache-Control', response.headers.get('Cache-Control') || 'no-store');
        result.headers.set('Vary', 'Accept');
        result.headers.delete('X-Rate-Limit-Remaining');
        result.headers.delete('Retry-After');
    }
    result.headers.set('X-Global-Library-Cache', state);
    return result;
}

function error(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
        status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

function uncached(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirect(target: URL): Response {
    return uncached(Response.redirect(target.toString(), 302));
}

async function fetchWithoutRedirect(url: string, init: RequestInit = {}): Promise<Response> {
    // workerd supports follow/manual, but not the browser's redirect: 'error'.
    const response = await fetch(url, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return error('Unexpected upstream redirect', 502);
    }
    return response;
}

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/public-cache-config.json' && request.method === 'GET') {
        return new Response(JSON.stringify({ origin: cacheConfigured(env) ? new URL(env.PUBLIC_LIBRARY_CACHE_ORIGIN!).origin : '', now: Date.now() }), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
    }
    const onshape = new URL(env.ONSHAPE_ORIGIN);
    if (onshape.protocol !== 'https:' || onshape.username || onshape.password ||
        onshape.pathname !== '/' || onshape.search || onshape.hash) {
        return error('Invalid configured Onshape origin', 500);
    }

    if (path === '/redirect.php' || path === '/oauthsignin.php') {
        if (request.method !== 'GET') return error('Method not allowed', 405);
        if (!env.ONSHAPE_CLIENT_ID) return error('OAuth is not configured', 503);
        const callback = new URL('/', url.origin);
        if (path === '/redirect.php') {
            for (const key of ['documentId', 'workspaceId', 'elementId']) {
                const value = url.searchParams.get(key);
                if (!value || !/^[a-f0-9]{24}$/i.test(value)) return error('Missing or invalid document context', 400);
                callback.searchParams.set(key, value);
            }
        } else {
            const returnTo = url.searchParams.get('redirectOnshapeUri');
            if (!returnTo) return error('Missing Onshape return URL', 400);
            const target = new URL(returnTo);
            if (target.origin !== onshape.origin || target.username || target.password) return error('Invalid Onshape return URL', 400);
            callback.searchParams.set('redirectOnshapeUri', target.toString());
        }
        const authorize = new URL('/oauth/authorize', oauthOrigin);
        authorize.searchParams.set('response_type', 'code');
        authorize.searchParams.set('client_id', env.ONSHAPE_CLIENT_ID);
        authorize.searchParams.set('redirect_uri', callback.toString());
        return redirect(authorize);
    }

    if (path === '/oauth.php' || path === '/refresh.php') {
        if (request.method !== 'GET') return error('Method not allowed', 405);
        if (!env.ONSHAPE_CLIENT_ID || !env.ONSHAPE_CLIENT_SECRET) return error('OAuth is not configured', 503);
        const code = url.searchParams.get('code');
        if (!code) return error('Missing OAuth code or refresh token', 400);
        const body = new URLSearchParams({ client_id: env.ONSHAPE_CLIENT_ID, client_secret: env.ONSHAPE_CLIENT_SECRET });
        if (path === '/oauth.php') {
            const uri = url.searchParams.get('redirect_uri');
            if (!uri) return error('Missing redirect URI', 400);
            const callback = new URL(uri);
            if (callback.origin !== url.origin || callback.pathname !== '/' || callback.username || callback.password) {
                return error('Invalid redirect URI', 400);
            }
            body.set('grant_type', 'authorization_code');
            body.set('code', code);
            body.set('redirect_uri', uri);
        } else {
            body.set('grant_type', 'refresh_token');
            body.set('refresh_token', code);
        }
        return uncached(await fetchWithoutRedirect(oauthOrigin + '/oauth/token', {
            method: 'POST', body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }));
    }

    if (path.startsWith('/api/')) {
        const server = request.headers.get('X-Server');
        if (server && server.replace(/\/$/, '') !== onshape.origin) return error('Onshape server does not match configuration', 400);
        if (!request.headers.get('Authorization')?.startsWith('Bearer ')) return error('Missing bearer token', 401);
        const thumbnail = request.method === 'GET' && /^\/api\/(?:v\d+\/)?thumbnails\//.test(path);
        const blobLibrary = path.match(/^\/api\/(?:v\d+\/)?blobelements\/d\/([a-f0-9]{24})\/w\/[a-f0-9]{24}\/e\/[a-f0-9]{24}$/)?.[1];
        const summaryLibrary = path.match(/^\/api\/(?:v\d+\/)?documents\/([a-f0-9]{24})$/)?.[1];
        let cache: Cache | undefined;
        let key: Request | undefined;
        const library = blobLibrary && globalLibraries.includes(blobLibrary) ? blobLibrary : undefined;
        const directCache = cacheConfigured(env);
        const publicImage = thumbnail && (request.headers.has('X-Public-Library-Source') || globalLibraries.includes(imageDocument(path)));
        if (directCache && request.method === 'GET' && (library || publicImage) &&
            !['Range', 'If-Match', 'If-None-Match', 'If-Modified-Since'].some(name => request.headers.has(name))) {
            try {
                const shared = await coordinatedRead(request, env);
                if (shared.status !== 412) return shared;
                await shared.body?.cancel();
            } catch { console.warn('[Public library refresh unavailable]'); }
        }
        // Partial and conditional requests retain upstream semantics.
        if (!directCache && request.method === 'GET' && !['Range', 'If-Match', 'If-None-Match', 'If-Modified-Since'].some(name => request.headers.has(name)) &&
            (library || thumbnail)) {
            cache = await sharedCache(onshape.origin);
            try {
                if (cache && (library || await thumbnailEligible(cache, url))) {
                    key = cacheKey(url, 'response', onshape.origin + path + url.search, request.headers.get('Accept') || '');
                    const hit = await cache.match(key);
                    if (hit) {
                        if (library) await learnThumbnails(cache, url, library, await hit.clone().json(), key);
                        return cacheResult(hit, 'HIT', thumbnail);
                    }
                }
            } catch { console.warn('[Global Library cache read failed]'); cache = undefined; key = undefined; }
        }
        let target = new URL(onshape.origin);
        target.pathname = path;
        target.search = url.search;
        const headers = new Headers();
        for (const name of ['Authorization', 'Content-Type', 'Accept', 'Range', 'If-Match', 'If-None-Match', 'If-Modified-Since']) {
            const value = request.headers.get(name);
            if (value) headers.set(name, value);
        }
        let response = await fetch(target.toString(), {
            method: request.method, headers, redirect: 'manual',
            body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        });
        for (let redirects = 0; response.status >= 300 && response.status < 400; redirects++) {
            let next: URL | undefined;
            try {
                const location = response.headers.get('Location');
                if (location) next = new URL(location, target);
            } catch { /* Reject malformed destinations without logging raw values. */ }
            const follow = thumbnail && redirects < 3 && next && next.protocol === 'https:' &&
                next.origin === onshape.origin && !next.username && !next.password;
            if (thumbnail) console.warn('[Thumbnail redirect]', {
                status: response.status, followed: !!follow,
                destination: next ? {
                    host: next.hostname,
                    path: next.pathname.split('/').map(part => part.length >= 24 ? ':id' : part).join('/'),
                } : null,
            });
            await response.body?.cancel();
            if (!follow || !next) return error('Unexpected Onshape API redirect', 502);
            target = next;
            response = await fetch(target.toString(), { method: 'GET', headers, redirect: 'manual' });
        }
        const resultHeaders = new Headers({ 'Cache-Control': 'no-store' });
        for (const name of ['Content-Type', 'Content-Disposition', 'Retry-After', 'X-Rate-Limit-Remaining', 'Content-Range', 'Accept-Ranges']) {
            const value = response.headers.get(name);
            if (value) resultHeaders.set(name, value);
        }
        const result = new Response(response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders });
        // Learn vendor thumbnail URLs without sharing user-specific document summaries.
        if (!directCache && request.method === 'GET' && result.status === 200 && summaryLibrary && globalLibraries.includes(summaryLibrary)) {
            try {
                const summaryCache = await sharedCache(onshape.origin);
                if (summaryCache) {
                    const summary = await result.clone().json() as { thumbnail?: unknown };
                    await learnThumbnails(summaryCache, url, summaryLibrary, summary.thumbnail,
                        cacheKey(url, 'response', onshape.origin + path + url.search));
                }
            } catch { console.warn('[Global Library thumbnail discovery failed]'); }
        }
        if (!['GET', 'HEAD'].includes(request.method) && result.ok) {
            const changedLibrary = path.match(/^\/api\/(?:v\d+\/)?(?:documents\/(?:d\/)?|blobelements\/d\/)([a-f0-9]{24})(?:\/|$)/)?.[1];
            if (changedLibrary && globalLibraries.includes(changedLibrary)) {
                try {
                    const writeCache = await sharedCache(onshape.origin);
                    if (writeCache) await invalidateLibrary(writeCache, url, changedLibrary);
                } catch { console.warn('[Global Library cache invalidation failed]'); }
            }
        }
        const publicThumbnail = !!(cache && key && thumbnail && result.status === 200 &&
            /^image\//i.test(result.headers.get('Content-Type') || ''));
        // Onshape sets cookies even for public content; resultHeaders already strips them.
        if (cache && key && result.status === 200 &&
            (library || /^image\//i.test(result.headers.get('Content-Type') || ''))) {
            try {
                // Parsing validates Blob contents before they become shared cache data.
                if (library) await learnThumbnails(cache, url, library, await result.clone().json(), key);
                const stored = result.clone();
                const mutableThumbnail = /^\/api\/(?:v\d+\/)?thumbnails\/d\//.test(path) && !/\/v\/[a-f0-9]{24}\//.test(path);
                const vendorLogo = globalLibraries.includes(path.match(/^\/api\/(?:v\d+\/)?thumbnails\/d\/([a-f0-9]{24})(?:\/|$)/)?.[1] || '');
                const thumbnailTTL = mutableThumbnail && !vendorLogo ? 5 * 60 : 3 * 60 * 60;
                const ttl = library ? libraryTTL : thumbnailTTL;
                if (publicThumbnail) result.headers.set('Cache-Control', 'public, max-age=' + ttl);
                stored.headers.set('Cache-Control', 'public, max-age=' + ttl);
                // Quota and cooldown belong to the user who made the upstream request.
                stored.headers.delete('X-Rate-Limit-Remaining');
                stored.headers.delete('Retry-After');
                await cache.put(key, stored);
                return cacheResult(result, 'MISS', publicThumbnail);
            } catch { console.warn('[Global Library cache write failed]'); }
        }
        return cacheResult(result, 'BYPASS', publicThumbnail);
    }

    // These requests retrieve Onshape HTML/CSS to match the embedded panel style.
    if (path === '/getfile.php') {
        if (request.method !== 'GET') return error('Method not allowed', 405);
        const value = url.searchParams.get('url');
        if (!value) return error('Missing asset URL', 400);
        const target = new URL(value);
        if (target.origin !== onshape.origin || target.username || target.password) return error('Invalid asset origin', 400);
        return uncached(await fetchWithoutRedirect(target.toString()));
    }
    if (path.startsWith('/confirm_access')) {
        const target = new URL(url.pathname + url.search, oauthOrigin);
        target.pathname = '/oauth' + target.pathname;
        return redirect(target);
    }
    if (/\.php(?:\/|$)/i.test(path) || path.split('/').some((part) => part.startsWith('.'))) {
        return error('Not found', 404);
    }
    const response = await env.ASSETS.fetch(request);
    return path === '/' || path.endsWith('.html') ? uncached(response) : response;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            return await route(request, env);
        } catch (cause) {
            // Do not log request URLs, authorization headers, or token responses.
            if (cause instanceof TypeError && /Invalid URL/i.test(cause.message)) return error('Invalid URL', 400);
            console.error('Upstream failure:', cause instanceof Error
                ? cause.message.replace(/https?:\/\/\S+/g, '[URL]') : 'Unknown error');
            return error('Upstream request failed', 502);
        }
    },
};
