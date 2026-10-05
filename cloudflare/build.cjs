const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
// 코드 내용이 바뀔 때 파일명도 바뀌어 이전 브라우저/프록시 캐시를 재사용하지 않습니다.
const collectionBytes = fs.readFileSync(path.join(root, 'assets', 'collection.js'));
const collectionName = 'collection.' + crypto.createHash('sha256').update(collectionBytes).digest('hex').slice(0, 12) + '.js';
for (const file of ['pokedex.html', 'setup.html']) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  if (!html.includes('src="./assets/collection.js"')) throw new Error('위젯 연결 스크립트를 찾지 못했습니다: ' + file);
  fs.writeFileSync(path.join(output, file), html.replace('src="./assets/collection.js"', 'src="./assets/' + collectionName + '"'), 'utf8');
}
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
for (const entry of fs.readdirSync(path.join(output, 'assets'), { withFileTypes: true })) {
  if (entry.isFile() && /^collection\.[0-9a-f]{12}\.js$/.test(entry.name) && entry.name !== collectionName) fs.unlinkSync(path.join(output, 'assets', entry.name));
}
fs.writeFileSync(path.join(output, 'assets', collectionName), collectionBytes);
fs.copyFileSync(path.join(output, 'setup.html'), path.join(output, 'index.html'));
for (const file of ['_headers', '404.html']) fs.copyFileSync(path.join(root, 'cloudflare', file), path.join(output, file));
console.log('제작자용 Cloudflare Pages 정적 파일 준비 완료: dist (개인 Worker와 별도 배포)');
