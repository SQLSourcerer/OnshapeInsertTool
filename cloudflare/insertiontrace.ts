import { RateLimitMiddleware } from '../app/common/ratelimit';

export class InsertionTrace {
    active = false;
    private started = 0;
    private lines: string[] = [];
    private sequence = 0;
    constructor(private now = () => performance.now(), private print = (line: string) => console.log(line)) {}
    start(): void {
        this.lines = [];
        this.sequence++;
        this.started = this.now();
        this.active = true;
        this.event('Trace started');
    }
    stop(): void { this.event('Trace stopped'); this.active = false; this.sequence++; }
    report(): string { return this.lines.join('\n'); }
    event(label: string): void {
        if (!this.active) return;
        const line = `[Insert trace +${Math.round(this.now() - this.started)} ms] ${label}`;
        this.lines.push(line);
        if (this.lines.length > 300) this.lines.shift();
        this.print(line);
    }
    begin(label: string): (outcome?: string) => void {
        const start = this.now();
        const session = this.sequence;
        const enabled = this.active;
        this.event(label + ' start');
        return (outcome = 'done') => {
            if (enabled && this.active && session === this.sequence)
                this.event(`${label} ${outcome} (${Math.round(this.now() - start)} ms)`);
        };
    }
}

export function installInsertionTrace(app: any): InsertionTrace {
    const trace = new InsertionTrace();
    (window as any).insertTrace = trace;
    // Log fixed labels only: no arguments, return values, URLs or error messages.
    for (const name of ['checkInsertItem', 'quickInsertItem', 'resolveDocumentVersion',
        'getInsertChoices', 'showItemChoices', 'outputConfigurationOptions',
        'findDeterministicPartId', 'getMetaData', 'insertToTarget',
        'insertToAssembly', 'insertToPartStudio']) {
        const original = app[name];
        if (typeof original !== 'function') continue;
        app[name] = function (...args: any[]) {
            const end = trace.begin(name);
            try {
                const result = original.apply(this, args);
                if (result && typeof result.then === 'function')
                    result.then(() => end(), () => end('failed'));
                else end();
                return result;
            } catch (error) { end('failed'); throw error; }
        };
    }
    // Trace the actual cooldown before fetch, without changing its behavior.
    const originalPre = RateLimitMiddleware.prototype.pre;
    RateLimitMiddleware.prototype.pre = function (context) {
        const end = trace.begin('API rate-limit check');
        const result = originalPre.call(this, context);
        result.then(() => end(), () => end('failed'));
        return result;
    };
    document.addEventListener('click', () => trace.event('UI click'), true);
    document.addEventListener('visibilitychange', () => trace.event(document.hidden ? 'App hidden' : 'App visible'));
    return trace;
}
