interface Env {
    ASSETS: { fetch(request: Request): Promise<Response> };
    ONSHAPE_CLIENT_ID: string;
    ONSHAPE_CLIENT_SECRET: string;
    ONSHAPE_ORIGIN: string;
}

const oauthOrigin = 'https://oauth.onshape.com';

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
        const target = new URL(onshape.origin);
        target.pathname = path;
        target.search = url.search;
        const headers = new Headers();
        for (const name of ['Authorization', 'Content-Type', 'Accept', 'Range', 'If-Match']) {
            const value = request.headers.get(name);
            if (value) headers.set(name, value);
        }
        const response = await fetch(target.toString(), {
            method: request.method, headers, redirect: 'manual',
            body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        });
        // Never forward the bearer token to an upstream redirect destination.
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            return error('Unexpected Onshape API redirect', 502);
        }
        const resultHeaders = new Headers({ 'Cache-Control': 'no-store' });
        for (const name of ['Content-Type', 'Content-Disposition', 'Retry-After', 'X-Rate-Limit-Remaining', 'Content-Range', 'Accept-Ranges']) {
            const value = response.headers.get(name);
            if (value) resultHeaders.set(name, value);
        }
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders });
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
