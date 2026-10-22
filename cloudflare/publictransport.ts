import { discoverPublicImages, imageDocument, libraryBlob, objectKey, publicLibraries, publicOrigin,
    publicTTL, resourceHash, thumbnail, vendorSummary } from './publicresources';

/** Direct reads carry no OAuth headers; only a miss reaches the authenticated API. */
export function publicTransport(appOrigin: string, fetcher: typeof fetch = fetch): (url: string, init?: RequestInit) => Promise<Response> {
    const sources = new Map<string, string>();
    let settings: Promise<string>;
    let clockOffset = 0;
    const cacheOrigin = () => settings || (settings = fetcher(appOrigin + '/public-cache-config.json', { credentials: 'omit' })
        .then(async response => {
            if (!response.ok) return '';
            const config = await response.json();
            if (!config.origin) return '';
            const origin = new URL(config.origin);
            if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash ||
                origin.username || origin.password) return '';
            if (typeof config.now === 'number') clockOffset = config.now - Date.now();
            return origin.origin;
        }).catch(() => ''));

    function remember(data: unknown, source: string): void {
        const discovered = discoverPublicImages(data);
        for (const id of discovered.documents) sources.set(id, source);
        for (const path of discovered.images) sources.set(path, source);
        // Bound long-lived panels without altering their existing response caches.
        while (sources.size > 10000) sources.delete(sources.keys().next().value);
    }

    return async (input, init = {}) => {
        const url = new URL(input, appOrigin);
        const headers = new Headers(init.headers);
        const server = headers.get('X-Server')?.replace(/\/$/, '');
        const read = (init.method || 'GET').toUpperCase() === 'GET' && url.origin === appOrigin &&
            (!server || server === publicOrigin) &&
            !['Range', 'If-Match', 'If-None-Match', 'If-Modified-Since'].some(name => headers.has(name));
        const path = url.pathname + url.search;
        const blob = read && libraryBlob(url.pathname);
        const source = sources.get(path) || sources.get(imageDocument(url.pathname));
        const image = read && thumbnail(url.pathname) && (publicLibraries.includes(imageDocument(url.pathname)) || !!source);
        const origin = (blob || image) ? await cacheOrigin() : '';
        const accept = headers.get('Accept') || '';
        if (origin) {
            try {
                const key = objectKey(await resourceHash(path, accept), Date.now() + clockOffset);
                const response = await fetcher(origin + '/' + key, {
                    credentials: 'omit', referrerPolicy: 'no-referrer', headers: accept ? { Accept: accept } : {},
                });
                if (response.status === 200 && (blob ? /application\/json/i : /^image\//i).test(response.headers.get('Content-Type') || '')) {
                    if (blob) remember(await response.clone().json(), path);
                    return response;
                }
                await response.body?.cancel();
            } catch { /* Missing objects, CORS and storage outages fall back to the API. */ }
        }
        if (origin && image && source) headers.set('X-Public-Library-Source', source);
        const response = await fetcher(input, { ...init, headers });
        if (read && response.status === 200) {
            const key = response.headers.get('X-Public-Cache-Key');
            const bucket = key?.match(/^global-library\/v1\/(\d+)\//)?.[1];
            // Correct an out-of-date client window after a server-side fill.
            if (bucket && objectKey('', Date.now() + clockOffset).split('/')[2] !== bucket)
                clockOffset = Number(bucket) * publicTTL * 1000 - Date.now();
            if (blob) {
                try { remember(await response.clone().json(), path); } catch { /* Preserve the API response. */ }
            } else if (vendorSummary(url.pathname)) {
                try {
                    const summary = await response.clone().json();
                    remember(summary.thumbnail, path);
                } catch { /* Summaries need not contain thumbnails. */ }
            }
        }
        return response;
    };
}
