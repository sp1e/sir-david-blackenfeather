import {build} from 'esbuild';
await Promise.all([
  build({entryPoints:['src/site/sir-david-api.ts'],bundle:true,format:'esm',platform:'neutral',outfile:'build/sir-david-api.js'}),
  build({entryPoints:['../local-adapter/claude-adapter.mjs'],bundle:true,format:'iife',globalName:'SirDavidLocal',platform:'browser',outfile:'admin/claude-adapter.js'})
]);
