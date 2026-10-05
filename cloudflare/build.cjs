const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
for (const file of ['pokedex.html', 'setup.html']) fs.copyFileSync(path.join(root, file), path.join(output, file));
function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error('배포 폴더에 지원하지 않는 링크가 있습니다: ' + from);
  }
}
for (const dir of ['assets', 'data', 'images']) copyDirectory(path.join(root, dir), path.join(output, dir));
fs.copyFileSync(path.join(root, 'setup.html'), path.join(output, 'index.html'));
for (const file of ['_headers', '404.html']) fs.copyFileSync(path.join(root, 'cloudflare', file), path.join(output, file));
console.log('제작자용 Cloudflare Pages 정적 파일 준비 완료: dist (개인 Worker와 별도 배포)');
