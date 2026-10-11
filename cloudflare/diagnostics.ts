import { installInsertionTrace } from './insertiontrace';

type RequestRecord = { method: string; route: string; status: number; ms: number; error?: string; cache?: string };

export function cacheState(value: string | null): string | undefined {
    return value && ['HIT', 'MISS', 'BYPASS'].includes(value) ? value : undefined;
}

// Report route categories, never document IDs, query strings, headers, or bodies.
export function requestLabel(value: string, origin: string): string {
    try {
        const url = new URL(value, origin);
        if (url.origin !== origin) return '[external request]';
        if (['/oauth.php', '/refresh.php', '/getfile.php'].includes(url.pathname)) return url.pathname;
        const api = url.pathname.match(/^\/api\/(?:v\d+\/)?([a-z]+)(?:\/|$)/i);
        if (api) return '/api/' + api[1].toLowerCase() + '/…';
        return '[app asset]';
    } catch {
        return '[invalid URL]';
    }
}

export function errorCode(body: string): string | undefined {
    try {
        const code = JSON.parse(body).error;
        // Only known protocol codes are safe to show; arbitrary response strings
        // can contain credentials or echoed request values.
        if (['invalid_grant', 'invalid_client', 'invalid_request', 'unauthorized_client',
            'unsupported_grant_type', 'access_denied', 'server_error'].includes(code)) return code;
    } catch { /* A failed response need not be JSON. */ }
    return undefined;
}

export class DiagnosticLog {
    readonly requests: RequestRecord[] = [];
    startupFailed = false;
    runtimeFailures = 0;
    record(request: RequestRecord): void {
        this.requests.push(request);
        if (this.requests.length > 30) this.requests.shift();
    }
    text(): string {
        const lines = ['Cloudflare test app',
            'Startup: ' + (this.startupFailed ? 'failed' : 'no startup failure reported'),
            'Runtime errors: ' + this.runtimeFailures,
            'Recent requests (maximum 30):'];
        for (const item of this.requests) {
            lines.push(`${item.method} ${item.route} → ${item.status || 'network failure'} (${item.ms} ms)${item.cache ? ' · cache ' + item.cache : ''}${item.error ? ' · ' + item.error : ''}`);
        }
        if (!this.requests.length) lines.push('No requests recorded yet.');
        return lines.join('\n');
    }
}

export function installDiagnostics(app: { failApp(reason: any): void }): void {
    const trace = installInsertionTrace(app);
    const log = new DiagnosticLog();
    const drawer = document.createElement('details');
    drawer.id = 'test-diagnostics';
    drawer.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:10000;background:#f3f4f6;color:#111827;border-top:1px solid #9ca3af;font:12px system-ui;text-align:left';
    const summary = document.createElement('summary');
    summary.textContent = 'Test diagnostics';
    summary.style.cssText = 'padding:7px;cursor:pointer';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear diagnostics';
    clear.style.cssText = 'margin:4px 8px';
    const output = document.createElement('pre');
    output.style.cssText = 'white-space:pre-wrap;overflow:auto;max-height:30vh;margin:8px;font:11px monospace';
    const traceButton = document.createElement('button');
    traceButton.type = 'button';
    traceButton.textContent = 'Start insertion trace';
    traceButton.style.cssText = 'margin:4px 8px';
    traceButton.onclick = () => {
        if (trace.active) trace.stop(); else trace.start();
        traceButton.textContent = trace.active ? 'Stop insertion trace' : 'Start insertion trace';
    };
    drawer.append(summary, clear, traceButton, output);
    const render = () => {
        output.textContent = log.text();
        summary.textContent = 'Test diagnostics' + (log.startupFailed ? ' — startup failed' : '');
    };
    const record = (item: RequestRecord) => { log.record(item); render(); };
    clear.onclick = () => { log.requests.length = 0; log.startupFailed = false; log.runtimeFailures = 0; render(); };
    const mount = () => { document.body.appendChild(drawer); render(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();

    const originalFail = app.failApp.bind(app);
    app.failApp = (reason) => {
        log.startupFailed = true;
        drawer.open = true;
        render();
        // Preserve the existing app behavior, but supplement blank statusText errors.
        originalFail(reason || 'Startup failed. Open Test diagnostics below for request statuses.');
    };
    for (const event of ['error', 'unhandledrejection']) {
        window.addEventListener(event, () => { log.runtimeFailures++; render(); });
    }

    const opened = new WeakMap<XMLHttpRequest, { method: string; route: string }>();
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...args: any[]) {
        opened.set(this, { method: method.toUpperCase(), route: requestLabel(String(url), window.location.origin) });
        return (originalOpen as any).call(this, method, url, ...args);
    } as typeof originalOpen;
    XMLHttpRequest.prototype.send = function (...args: any[]) {
        const info = opened.get(this);
        const start = performance.now();
        const end = trace.begin(`XHR ${info?.method || ''} ${info?.route || '[unknown route]'}`);
        if (info) this.addEventListener('loadend', () => {
            end(`status ${this.status}`);
            let code: string | undefined;
            if (this.status >= 400 && (!this.responseType || this.responseType === 'text')) code = errorCode(this.responseText);
            record({ ...info, status: this.status, ms: Math.round(performance.now() - start), error: code,
                cache: cacheState(this.getResponseHeader('X-Global-Library-Cache')) });
        }, { once: true });
        return (originalSend as any).apply(this, args);
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const request = input instanceof Request ? input : undefined;
        const route = requestLabel(request ? request.url : String(input), window.location.origin);
        const method = (init?.method || request?.method || 'GET').toUpperCase();
        const start = performance.now();
        const end = trace.begin(`fetch ${method} ${route}`);
        try {
            const response = await originalFetch(input, init);
            end(`status ${response.status}`);
            record({ method, route, status: response.status, ms: Math.round(performance.now() - start),
                cache: cacheState(response.headers.get('X-Global-Library-Cache')) });
            return response;
        } catch (cause) {
            end('network failure');
            record({ method, route, status: 0, ms: Math.round(performance.now() - start) });
            throw cause;
        }
    };
}
