const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node18'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return;
  }
  const result = await esbuild.build({ ...options, metafile: true });
  const entry = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith('.js'));
  const size = entry?.[1].bytes ?? 0;
  console.log(`dist/extension.js  ${(size / 1024).toFixed(1)} KB`);
  if (size > 1.5 * 1024 * 1024) {
    console.warn('警告：产物体积超过 1.5MB，请检查是否引入了体积过大的依赖');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
