import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
const read = path => fs.readFileSync(new URL('../../' + path, import.meta.url));
function unzip(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8'), start = offset + 30 + length + extra;
    files.set(name, zlib.inflateRawSync(bytes.subarray(start, start + size))); offset = start + size;
  }
  return files;
}
test('배포 HTML은 내용별 파일명으로 연결 코드를 요청해 이전 파일 캐시를 재사용하지 않음', () => {
  const files = unzip(read('cloudflare-Pages-공용화면.zip'));
  let expectedPath;
  for (const name of ['index.html', 'setup.html', 'pokedex.html']) {
    const html = files.get(name).toString('utf8');
    const scriptPath = html.match(/src="\.\/(assets\/collection\.[0-9a-f]{12}\.js)"/)?.[1];
    assert.ok(scriptPath, name + '에서 버전별 연결 코드가 필요합니다.');
    assert.doesNotMatch(html, /src="\.\/assets\/collection\.js"/);
    assert.deepEqual(files.get(scriptPath), read('assets/collection.js'));
    if (expectedPath) assert.equal(scriptPath, expectedPath);
    expectedPath = scriptPath;
  }
});
test('개인 설치 ZIP은 바로 붙여넣는 Worker와 안내 두 파일만 포함, 배포 다운로드와 일치', () => {
  const files = unzip(read('cloudflare-개인설치.zip'));
  assert.deepEqual([...files.keys()].sort(), ['worker.js', '먼저-읽어주세요.md'].sort());
  for (const [name, bytes] of files) assert.deepEqual(bytes, read('release/personal-worker/' + name));
  assert.deepEqual(read('cloudflare-개인설치.zip'), read('dist/downloads/개인-Worker-설치.zip'));
});
test('단일 Worker 모듈은 외부 import와 저장소 바인딩 없이 로드·기본 응답 가능', async () => {
  const source = read('release/personal-worker/worker.js').toString('utf8');
  assert.doesNotMatch(source, /^import\s/m); assert.doesNotMatch(source, /env\.COLLECTION|ctx\.storage|DurableObject/);
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(typeof module.default.fetch, 'function'); assert.equal(typeof module.NotionCollection, 'function');
  assert.equal(module.backgroundFor({ slug: 'arcanine-hisui', dexId: 59 }).id, 'fire');
  const response = await module.default.fetch(new Request('https://example.workers.dev/api/setup', { method: 'POST', body: '{}' }), {});
  assert.equal(response.status, 503); assert.match((await response.json()).error, /NOTION_TOKEN/);
});
test('공용 Pages ZIP은 새 연결 화면·Worker 다운로드 포함, Secret·개인 연결 정보는 제외', () => {
  const files = unzip(read('cloudflare-Pages-공용화면.zip'));
  for (const name of ['index.html', 'setup.html', 'pokedex.html', 'assets/collection.js', 'downloads/worker.js']) assert.deepEqual(files.get(name), read('dist/' + name));
  assert.match(files.get('setup.html').toString(), /id="database"/);
  assert.equal([...files.keys()].some(name => /(?:^|\/)(?:\.dev\.vars|\.widget-install\.json|install\.cjs|설치\.cmd|wrangler\.jsonc)$/.test(name)), false);
  const config = JSON.parse(read('cloudflare/worker.wrangler.jsonc').toString());
  assert.equal(config.durable_objects, undefined); assert.equal(config.migrations, undefined); assert.equal(config.vars.NOTION_TOKEN, undefined);
});

test('설치 코드를 Windows 문자셋으로 열어도 한국어 DB 속성과 설정 페이지를 정확하게 사용', async () => {
  const bytes = read('release/personal-worker/worker.js');
  assert.equal(bytes.some(byte => byte > 127), false, '설치 파일은 ASCII만 사용해야 합니다.');
  const source = new TextDecoder('windows-1252').decode(bytes);
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const collection = new module.NotionCollection({ NOTION_TOKEN: 'test-only' }, '0123456789abcdef0123456789abcdef');
  const schema = { '이름': { title: {} }, '폼 식별자': { rich_text: {} }, '배경 식별자': { rich_text: {} }, '즐겨찾기': { checkbox: {} } };
  let children, writes = 0;
  collection.notion = async (path, body, method) => {
    assert.notEqual(method, 'PATCH', '정상 DB 속성을 잘못 읽어 다른 속성을 추가하면 안 됩니다.');
    if (path.startsWith('databases/')) return { data_sources: [{ id: 'source' }] };
    if (path === 'data_sources/source') return { properties: schema };
    if (path === 'data_sources/source/query') {
      assert.equal(body.filter.property, '폼 식별자');
      return { results: [], has_more: false };
    }
    if (path === 'pages') {
      writes++;
      assert.equal(body.properties['이름'].title[0].text.content, '위젯 설정');
      assert.equal(body.properties['폼 식별자'].rich_text[0].text.content, '__widget_settings_v1__');
      children = body.children.map(block => ({ ...block, id: 'settings-block' }));
      return { id: 'settings-page' };
    }
    if (path.startsWith('blocks/')) return { results: children, has_more: false };
    throw Error('Unexpected Notion request: ' + path);
  };
  await collection.database(true);
  const settings = await collection.settings(true);
  assert.equal(writes, 1);
  assert.equal(settings.preferences.mode, 'draw');
  assert.equal(module.normalizeSlug('nidoran♀'), 'nidoran-f');
  assert.equal(module.normalizeSlug('farfetch’d'), 'farfetchd');
});
