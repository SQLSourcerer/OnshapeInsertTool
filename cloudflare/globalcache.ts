import { discoverPublicImages, imageDocument, libraryBlob, objectKey, publicLibraries, publicOrigin,
    remainingTTL, resourceHash, thumbnail, vendorSummary } from './publicresources';

type StoredObject = {
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
};
export interface PublicCacheEnv {
    ONSHAPE_ORIGIN: string;
    PUBLIC_LIBRARY_CACHE_ORIGIN?: string;
    PUBLIC_LIBRARY_BUCKET?: {
        get(key: string): Promise<StoredObject | null>;
        put(key: string, body: ArrayBuffer, options: { httpMetadata: { contentType: string; cacheControl: string } }): Promise<unknown>;
    };
    PUBLIC_LIBRARY_REFRESH?: {
        idFromName(name: string): unknown;
        get(id: unknown): { fetch(request: Request): Promise<Response> };
    };
}

function result(status: number, body: BodyInit | null = null, headers: HeadersInit = {}): Response {
    return new Response(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export function cacheConfigured(env: PublicCacheEnv): boolean {
    if (env.ONSHAPE_ORIGIN !== publicOrigin || !env.PUBLIC_LIBRARY_BUCKET || !env.PUBLIC_LIBRARY_REFRESH) return false;
    try {
        const url = new URL(env.PUBLIC_LIBRARY_CACHE_ORIGIN || '');
        return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    } catch { return false; }
}

export async function coordinatedRead(request: Request, env: PublicCacheEnv): Promise<Response> {
    const url = new URL(request.url);
    const hash = await resourceHash(url.pathname + url.search, request.headers.get('Accept') || '');
    const namespace = env.PUBLIC_LIBRARY_REFRESH!;
    return namespace.get(namespace.idFromName(hash)).fetch(request);
}

type Payload = { status: number; body: ArrayBuffer | null; headers: Record<string, string> };

// A resource's name resolves to the same object from every Cloudflare region.
export class GlobalLibraryRefresh {
    private inFlight?: Promise<Payload>;
    constructor(_state: unknown, private env: PublicCacheEnv) {}

    async fetch(request: Request): Promise<Response> {
        if (request.method !== 'GET' || !request.headers.get('Authorization')?.startsWith('Bearer ') ||
            this.env.ONSHAPE_ORIGIN !== publicOrigin || !this.env.PUBLIC_LIBRARY_BUCKET) return result(403);
        if (!this.inFlight) {
            this.inFlight = this.read(request).finally(() => { this.inFlight = undefined; });
        }
        const payload = await this.inFlight;
        return result(payload.status, payload.body?.slice(0) || null, payload.headers);
    }

    private async read(request: Request): Promise<Payload> {
        const url = new URL(request.url);
        const path = url.pathname;
        const isBlob = libraryBlob(path);
        const isSummary = vendorSummary(path);
        if (!isBlob && !isSummary && !thumbnail(path)) return this.bypass();
        const hash = await resourceHash(path + url.search, request.headers.get('Accept') || '');
        // Capture the window before fetching: a slow fill must never populate a later window.
        const key = objectKey(hash);
        if (!isSummary) {
            const stored = await this.env.PUBLIC_LIBRARY_BUCKET!.get(key);
            if (stored) return this.publicPayload(await stored.arrayBuffer(), stored.httpMetadata?.contentType || '', key, 'HIT');
        }

        if (thumbnail(path) && !publicLibraries.includes(imageDocument(path))) {
            // A hint selects a source; only its server-fetched contents grant membership.
            const hint = request.headers.get('X-Public-Library-Source');
            if (!hint) return this.bypass();
            const source = new URL(hint, publicOrigin);
            if (source.origin !== publicOrigin || source.username || source.password || source.hash ||
                (!libraryBlob(source.pathname) && !vendorSummary(source.pathname))) return this.bypass();
            const sourceRequest = new Request(source.toString(), { headers: {
                Authorization: request.headers.get('Authorization')!, Accept: 'application/json',
            } });
            const response = await coordinatedRead(sourceRequest, this.env);
            if (!response.ok) return this.bypass();
            const membership = discoverPublicImages(await response.json());
            if (!membership.documents.has(imageDocument(path)) && !membership.images.has(path + url.search)) return this.bypass();
        }

        let target = new URL(path + url.search, publicOrigin);
        const headers = new Headers({ Authorization: request.headers.get('Authorization')! });
        const accept = request.headers.get('Accept');
        headers.set('Accept', isBlob || isSummary ? 'application/json' : accept || '*/*');
        let response = await fetch(target.toString(), { headers, redirect: 'manual' });
        for (let redirects = 0; response.status >= 300 && response.status < 400; redirects++) {
            const location = response.headers.get('Location');
            let next: URL;
            try { next = new URL(location || '', target); }
            catch { return this.failed(502); }
            await response.body?.cancel();
            if (!thumbnail(path) || redirects >= 3 || !location || next.origin !== publicOrigin ||
                next.username || next.password || next.protocol !== 'https:') return this.failed(502);
            target = next;
            response = await fetch(target.toString(), { headers, redirect: 'manual' });
        }
        if (response.status !== 200) {
            await response.body?.cancel();
            // A shared failure must not expose the originating user's body or quota.
            return this.failed(response.status >= 400 ? response.status : 502);
        }
        if (Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024) {
            await response.body?.cancel();
            return this.bypass();
        }
        const body = await response.arrayBuffer();
        if (body.byteLength > 16 * 1024 * 1024) return this.bypass();
        let contentType = response.headers.get('Content-Type') || '';
        if (isBlob || isSummary) {
            let data: unknown;
            try { data = JSON.parse(new TextDecoder().decode(body)); }
            catch { return this.bypass(); }
            if (isSummary) {
                // Document summaries can contain personalized fields. Only discover images.
                const summary = data as { thumbnail?: unknown } | null;
                return { status: 200, body: new TextEncoder().encode(JSON.stringify({ thumbnail: summary?.thumbnail })).buffer,
                    headers: { 'Content-Type': 'application/json' } };
            }
            contentType = 'application/json';
        } else if (!/^image\//i.test(contentType) || !body.byteLength) return this.bypass();
        const cacheControl = 'public, max-age=' + remainingTTL();
        // Only validated public data reaches this bucket; upstream cookies and quotas are omitted.
        await this.env.PUBLIC_LIBRARY_BUCKET!.put(key, body, { httpMetadata: { contentType, cacheControl } });
        return this.publicPayload(body, contentType, key, 'MISS');
    }

    private publicPayload(body: ArrayBuffer, type: string, key: string, state: string): Payload {
        return { status: 200, body, headers: { 'Content-Type': type, 'X-Public-Cache-Key': key,
            'X-Global-Library-Cache': state } };
    }
    private bypass(): Payload { return { status: 412, body: null, headers: {} }; }
    private failed(status: number): Payload { return { status, body: null, headers: {} }; }
}
