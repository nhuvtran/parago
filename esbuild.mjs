import { build } from 'esbuild';

const common = { bundle: true, format: 'iife', target: 'chrome120', logLevel: 'info' };

await build({ ...common, entryPoints: ['src/content/filter.js'], outfile: 'dist/content.js' });
await build({ ...common, entryPoints: ['src/content/checkout.entry.js'], outfile: 'dist/checkout.js' });
await build({ ...common, entryPoints: ['src/content/devPanel.js'], outfile: 'dist/devPanel.js' });
await build({ ...common, entryPoints: ['src/content/productDetail.js'], outfile: 'dist/productDetail.js' });
await build({ ...common, entryPoints: ['src/background.js'], outfile: 'dist/background.js' });
