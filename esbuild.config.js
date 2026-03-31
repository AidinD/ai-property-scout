const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

// Load .env if present
const envPath = path.join(__dirname, '.env');
const env     = {};
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && rest.length) {
            env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
        }
    });
}

const define = {
    'process.env.SCOUT_TOKEN':       JSON.stringify(env.SCOUT_TOKEN       || ''),
    'process.env.SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY || ''),
    'process.env.CF_WORKER_URL':     JSON.stringify(env.CF_WORKER_URL     || ''),
};

const sharedConfig = {
    bundle:   true,
    format:   'iife',
    define,
    logLevel: 'info',
};

Promise.all([
    esbuild.build({ ...sharedConfig, entryPoints: ['src/pdfExtractor.js'], outfile: 'dist/pdfExtractor.js' }),
    esbuild.build({ ...sharedConfig, entryPoints: ['src/options.js'],      outfile: 'dist/options.js' }),
    esbuild.build({ ...sharedConfig, entryPoints: ['src/background.js'],   outfile: 'dist/background.js' }),
    esbuild.build({ ...sharedConfig, entryPoints: ['src/content.js'],      outfile: 'dist/content.js' }),
    esbuild.build({ ...sharedConfig, entryPoints: ['src/popup.js'],        outfile: 'dist/popup.js' }),
]).then(() => {
    // Copy static files
    fs.copyFileSync('manifest.json',    'dist/manifest.json');
    fs.copyFileSync('src/options.html', 'dist/options.html');
    fs.copyFileSync('src/sidebar.html', 'dist/sidebar.html');
    fs.copyFileSync('src/popup.html',   'dist/popup.html');
    console.log('Build complete.');
}).catch(() => process.exit(1));
