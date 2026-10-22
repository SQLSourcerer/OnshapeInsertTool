export const publicOrigin = 'https://cad.onshape.com';
export const publicTTL = 600;
// Keep aligned with app.ts; these documents contain intentionally public, shared data.
export const publicLibraries = [
    '2fd951db6d0261aba5f16a5d', '65d1b86ea725f780582d9dd0', 'f4aa6bf18a572782640d6476',
    'f3b99a8450b4f983b1efa03c', 'b71490095d0a6e87f29c4975', '1348b49fc35396eed14d589b',
    '48ccfa30daa8fc8dad88f0eb', 'ef69c7f97eac419fe24faf1d', '07986b342f5e967bbfd021f8',
];

export function libraryBlob(path: string): boolean {
    const id = path.match(/^\/api\/(?:v\d+\/)?blobelements\/d\/([a-f0-9]{24})\/w\/[a-f0-9]{24}\/e\/[a-f0-9]{24}$/)?.[1];
    return !!id && publicLibraries.includes(id);
}

export function vendorSummary(path: string): boolean {
    return publicLibraries.includes(path.match(/^\/api\/(?:v\d+\/)?documents\/([a-f0-9]{24})$/)?.[1] || '');
}

export function thumbnail(path: string): boolean {
    return /^\/api\/(?:v\d+\/)?thumbnails\//.test(path);
}

// Interpret only URLs from trusted library payloads, never from request headers.
export function discoverPublicImages(data: unknown): { documents: Set<string>; images: Set<string> } {
    const documents = new Set<string>();
    const images = new Set<string>();
    const pending: unknown[] = [data];
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        const node = value as Record<string, unknown>;
        if (typeof node.id === 'string' && /^[a-f0-9]{24}$/.test(node.id) &&
            ['document-summary', 'document-summary-configured'].includes(String(node.jsonType))) documents.add(node.id);
        for (const child of Object.values(node)) {
            if (typeof child === 'string') {
                try {
                    const url = new URL(child, publicOrigin);
                    if (url.origin !== publicOrigin || url.username || url.password) continue;
                    const id = url.pathname.match(/^\/(?:api\/(?:v\d+\/)?)?documents\/(?:d\/)?([a-f0-9]{24})(?:\/|$)/)?.[1];
                    if (id) documents.add(id);
                    if (thumbnail(url.pathname)) images.add(url.pathname + url.search);
                } catch { /* Most library strings are labels rather than URLs. */ }
            } else if (child && typeof child === 'object') pending.push(child);
        }
    }
    return { documents, images };
}

export function imageDocument(path: string): string {
    return path.match(/^\/api\/(?:v\d+\/)?thumbnails\/d\/([a-f0-9]{24})(?:\/|$)/)?.[1] || '';
}

export async function resourceHash(path: string, accept: string): Promise<string> {
    // These endpoints are published only as validated JSON, regardless of SDK Accept defaults.
    const pathname = path.split('?')[0];
    if (libraryBlob(pathname) || vendorSummary(pathname)) accept = 'application/json';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([publicOrigin, path, accept])));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function objectKey(hash: string, now = Date.now()): string {
    return 'global-library/v1/' + Math.floor(now / (publicTTL * 1000)) + '/' + hash;
}

export function remainingTTL(now = Date.now()): number {
    return Math.max(1, Math.ceil((publicTTL * 1000 - now % (publicTTL * 1000)) / 1000));
}
