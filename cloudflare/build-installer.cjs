const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
// Wrangler와 같은 잠금 파일의 esbuild를 사용해 JSON 데이터를 단일 모듈에 동봉합니다.
const esbuild = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('wrangler/package.json'))] }));
const output = path.join(root, 'release', 'personal-worker');
const downloads = path.join(root, 'dist', 'downloads');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'worker.mjs')], outfile: path.join(output, 'worker.js'),
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', charset: 'utf8', sourcemap: false });
fs.copyFileSync(path.join(__dirname, 'installer', '먼저-읽어주세요.md'), path.join(output, '먼저-읽어주세요.md'));
// 이전 설치 방식의 생성 파일만 제거합니다. 사용자의 연결 파일이나 secrets는 건드리지 않습니다.
for (const file of ['wrangler.jsonc', 'package.json', 'package-lock.json', 'install.cjs', '설치.cmd', '.gitignore']) {
  const target = path.join(output, file);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
if (fs.existsSync(path.join(downloads, 'wrangler.jsonc'))) fs.unlinkSync(path.join(downloads, 'wrangler.jsonc'));
for (const file of ['worker.js', '먼저-읽어주세요.md']) fs.copyFileSync(path.join(output, file), path.join(downloads, file));
console.log('브라우저 붙여넣기 설치용 worker.js와 안내 준비 완료: release/personal-worker');
