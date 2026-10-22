const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

module.exports = function loadCloudflare(file, globals = {}) {
    const modules = new Map();
    function load(filename) {
        filename = path.resolve(filename);
        if (modules.has(filename)) return modules.get(filename);
        const exports = {};
        modules.set(filename, exports);
        const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        vm.runInNewContext(code, { exports, URL, URLSearchParams, Request, Response, Headers, TextEncoder, TextDecoder,
            Uint8Array, ArrayBuffer, crypto: require('node:crypto').webcrypto, console, Date, fetch,
            require: name => load(path.resolve(path.dirname(filename), name + '.ts')), ...globals,
        }, { filename });
        return exports;
    }
    return load(path.resolve(__dirname, '../..', file));
};
