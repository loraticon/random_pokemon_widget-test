const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/background-catalog.json'), 'utf8'));
const pattern = /(<script type="application\/json" id="background-catalog">)[\s\S]*?(<\/script>)/;
for (const filename of ['pokedex.html', 'pokedex-legendary-test.html']) {
  const file = path.join(root, filename);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  if (!pattern.test(html)) throw new Error('공통 배경 목록을 찾지 못했습니다: ' + filename);
  const updated = html.replace(pattern, (_, open, close) => open + JSON.stringify(catalog).replace(/</g, '\\u003c') + close);
  if (html !== updated) fs.writeFileSync(file, updated, 'utf8');
}
console.log('브라우저와 Worker의 공통 배경 목록 동기화 완료');
