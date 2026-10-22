const path = require('node:path');
const webpack = require('webpack');
const FileManagerPlugin = require('filemanager-webpack-plugin');
const base = require('./webpack.config');

module.exports = (env, argv) => {
    const config = base(env, argv);
    const output = path.resolve(__dirname, 'dist-cloudflare');
    config.entry = [path.resolve(__dirname, 'cloudflare/main.ts')];
    config.output = { ...config.output, path: output, clean: true };
    config.module.rules[0].include.push(path.resolve(__dirname, 'cloudflare'));
    config.module.rules[0].options.configFile = path.resolve(__dirname, 'tsconfig.json');
    // Never publish PHP source or server/config.php as static assets.
    config.plugins = config.plugins.filter((plugin) => !(plugin instanceof FileManagerPlugin));
    config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/app_settings\.json$/, path.resolve(__dirname, 'cloudflare/app_settings.json')),
        new FileManagerPlugin({ events: { onEnd: { copy: [
            { source: path.resolve(__dirname, 'app/static/*'), destination: output },
            { source: path.resolve(__dirname, 'cloudflare/fonts/*'), destination: path.join(output, 'fonts') },
        ] } } })
    );
    return config;
};
