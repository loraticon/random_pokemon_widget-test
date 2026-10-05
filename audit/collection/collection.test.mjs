import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NotionCollection, koreaDay, pageId, backgroundFor, default as worker } from '../../cloudflare/worker.mjs';
const require = createRequire(import.meta.url);
const { LocalStore } = require('../../assets/collection.js');
const db = '0123456789abcdef0123456789abcdef';
const origin = 'https://pokemon.loraticon.com';
const settingsSlug = '__widget_settings_v1__';
const text = value => [{ text: { content: value } }];
const content = rich => rich.map(item => item.text.content).join('');
const request = (slug = 'pikachu') => ({ id: crypto.randomUUID(), slug, isShiny: false });
function page(slug, created_time = new Date().toISOString(), background = '') {
  return { id: crypto.randomUUID(), created_time, properties: { '이름': { title: text(slug) }, '폼 식별자': { rich_text: text(slug) }, '배경 식별자': { rich_text: text(background) }, '즐겨찾기': { checkbox: false } } };
}
function fixture(limit = 3) {
  const env = { NOTION_TOKEN: 'mock-token', DAILY_LIMIT: String(limit) };
  const pages = []; const blocks = new Map(); const calls = []; let failure;
  const schema = { '이름': { title: {} }, '폼 식별자': { rich_text: {} }, '배경 식별자': { rich_text: {} }, '즐겨찾기': { checkbox: {} }, '메모': { rich_text: {} } };
  const notion = async (path, body, method) => {
    calls.push({ path, body, method });
    if (path === 'databases/' + db) return { id: db, url: 'https://www.notion.so/' + db, data_sources: [{ id: 'source' }] };
    if (path === 'data_sources/source') { if (method === 'PATCH') Object.assign(schema, body.properties); return { properties: schema }; }
    if (path === 'data_sources/source/query') {
      const match = body.filter?.rich_text?.equals;
      const list = pages.filter(p => !match || content(p.properties['폼 식별자'].rich_text) === match);
      return { results: structuredClone(list), has_more: false };
    }
    if (path.startsWith('blocks/') && path.includes('/children')) return { results: structuredClone(blocks.get(path.split('/')[1]) || []), has_more: false };
    if (path.startsWith('blocks/') && method === 'PATCH') {
      if (failure === 'settings') throw Error('설정 저장 실패');
      const block = [...blocks.values()].flat().find(b => b.id === path.slice(7));
      Object.assign(block.code, body.code); return block;
    }
    if (path.startsWith('pages/') && method === 'PATCH') {
      if (failure === 'favorite') throw Error('별 저장 실패');
      const row = pages.find(p => p.id === path.slice(6));
      Object.assign(row.properties, body.properties); return row;
    }
    if (path === 'pages') {
      const slug = content(body.properties['폼 식별자'].rich_text);
      if (slug !== settingsSlug && failure === 'reject') throw Error('포획 저장 실패');
      const row = { id: crypto.randomUUID(), created_time: new Date().toISOString(), properties: structuredClone(body.properties) };
      pages.push(row);
      if (body.children) blocks.set(row.id, body.children.map(b => ({ ...structuredClone(b), id: crypto.randomUUID() })));
      if (slug !== settingsSlug && failure === 'uncertain') throw Object.assign(Error('응답 손실'), { uncertain: true });
      return structuredClone(row);
    }
    throw Error('Unexpected Notion path ' + path);
  };
  const fresh = () => { const c = new NotionCollection(env, db); c.notion = notion; return c; };
  const prepare = async () => { const c = fresh(); await c.database(true); await c.settings(true); return c; };
  return { env, pages, blocks, calls, schema, fresh, prepare, fail: value => { failure = value; } };
}

test('원본 DB 재사용, 추가 속성 보존, 설정 페이지만 자동 생성하며 재연결 시 재사용', async () => {
  const f = fixture(); const c = await f.prepare();
  assert.ok(f.schema['메모']); assert.equal(f.pages.length, 1);
  const settings = f.pages[0]; assert.equal(content(settings.properties['폼 식별자'].rich_text), settingsSlug);
  assert.equal(content(settings.properties['이름'].title), '위젯 설정');
  assert.equal(f.calls.some(c => c.path === 'databases'), false);
  const snap = await c.getSnapshot(); assert.equal(snap.used, 0); assert.equal(snap.remaining, 3); assert.deepEqual(snap.records, []);
  await f.prepare(); assert.equal(f.pages.length, 1);
});
test('연결 준비는 누락한 네 속성만 추가하고 유형 오류는 기존 DB를 덮어쓰지 않음', async () => {
  const f = fixture(); delete f.schema['즐겨찾기']; await f.prepare();
  assert.deepEqual(f.calls.find(c => c.method === 'PATCH').body, { properties: { '즐겨찾기': { checkbox: {} } } });
  const invalid = fixture(); invalid.schema['폼 식별자'] = { number: {} };
  await assert.rejects(invalid.prepare(), /속성 유형/); assert.equal(invalid.pages.length, 0);
});
test('설정 페이지와 색이 다른 기존 기록은 도감·한도에서 제외하고 노션 기록은 보존', async () => {
  const f = fixture(); await f.prepare();
  const shiny = page('pikachu'); shiny.properties['색이 다름'] = { checkbox: true }; f.pages.push(shiny);
  const snapshot = await f.fresh().getSnapshot(); assert.equal(snapshot.used, 0); assert.equal(snapshot.records.length, 0); assert.equal(f.pages.length, 2);
});
test('포획은 네 속성만 저장, 클라이언트 배경을 무시하고 폼별 배경과 이미지를 계산', async () => {
  const f = fixture(); await f.prepare();
  const result = await f.fresh().capture({ ...request('arcanine-hisuian'), backgroundId: 'water', name: '임의 이름' });
  assert.equal(result.used, 1); assert.equal(result.remaining, 2);
  const row = f.pages[1]; assert.deepEqual(Object.keys(row.properties).sort(), ['이름', '폼 식별자', '배경 식별자', '즐겨찾기'].sort());
  assert.equal(content(row.properties['배경 식별자'].rich_text), 'fire'); assert.equal(content(row.properties['이름'].title), '윈디 (히스이)');
  assert.match(result.records[0].imageSrc, /arcanine-hisuian\.webp$/); assert.equal(result.records[0].backgroundId, 'fire');
});
test('기존·과거 포켓몬은 새 요청 ID로도 다시 저장하지 않음', async () => {
  const f = fixture(); await f.prepare(); f.pages.push(page('pikachu', '2026-09-01T00:00:00Z'));
  await assert.rejects(f.fresh().capture(request()), { code: 'ALREADY_COLLECTED' });
  assert.equal((await f.fresh().getSnapshot()).used, 0); assert.equal(f.pages.length, 2);
});
test('현재 DB의 오늘 기록으로 한도 판단, 오늘 기록을 삭제하면 기회와 재수집 복구', async () => {
  const f = fixture(); await f.prepare();
  for (const slug of ['pikachu', 'raichu', 'eevee']) await f.fresh().capture(request(slug));
  await assert.rejects(f.fresh().capture(request('bulbasaur')), { code: 'DAILY_LIMIT' });
  f.pages.splice(1, 1);
  const after = await f.fresh().getSnapshot(); assert.equal(after.used, 2); assert.equal(after.remaining, 1); assert.equal(after.owned.includes('pikachu:false'), false);
  const recaptured = await f.fresh().capture(request()); assert.equal(recaptured.used, 3); assert.equal(recaptured.records.length, 3);
});
test('노션에서 휴지통으로 이동한 오늘 기록도 횟수와 수집 여부에서 제외', async () => {
  const f = fixture(); await f.prepare(); await f.fresh().capture(request()); f.pages[1].in_trash = true;
  assert.equal((await f.fresh().getSnapshot()).used, 0); await f.fresh().capture(request());
});
test('Worker의 DAILY_LIMIT 변경은 같은 노션 DB 기록에 바로 반영', async () => {
  const f = fixture(1); await f.prepare(); await f.fresh().capture(request());
  await assert.rejects(f.fresh().capture(request('eevee')), { code: 'DAILY_LIMIT' });
  f.env.DAILY_LIMIT = '5'; const result = await f.fresh().capture(request('eevee'));
  assert.equal(result.limit, 5); assert.equal(result.remaining, 3);
  f.env.DAILY_LIMIT = '0'; assert.throws(() => f.fresh(), /DAILY_LIMIT/);
});
test('저장 거절은 노션 횟수를 차감하지 않고 응답 손실 후에는 조회로 복구', async () => {
  const f = fixture(); await f.prepare(); f.fail('reject');
  await assert.rejects(f.fresh().capture(request())); assert.equal((await f.fresh().getSnapshot()).used, 0);
  f.fail('uncertain'); const result = await f.fresh().capture(request());
  assert.equal(result.used, 1); assert.equal(f.pages.length, 2);
});
test('새 요청에서도 저장 직전 노션 체크를 읽고 별 하나만 변경, 나머지 별 보존', async () => {
  const f = fixture(); await f.prepare(); f.pages.push(page('pikachu'), page('eevee'));
  f.pages[1].properties['즐겨찾기'].checkbox = true;
  const result = await f.fresh().savePreferences({ favoriteChange: { pokemonKey: 'eevee:false', favorite: true } });
  assert.deepEqual(new Set(result.preferences.favoritePokemon), new Set(['pikachu:false', 'eevee:false']));
  f.pages[1].properties['즐겨찾기'].checkbox = false;
  assert.deepEqual((await f.fresh().getSnapshot()).preferences.favoritePokemon, ['eevee:false']);
  f.fail('favorite'); await assert.rejects(f.fresh().savePreferences({ favoriteChange: { pokemonKey: 'eevee:false', favorite: false } }));
  assert.equal(f.pages[2].properties['즐겨찾기'].checkbox, true);
});
test('슬립 선택과 배경 즐겨찾기는 노션 설정 페이지에 저장, 다른 인스턴스에서 공유', async () => {
  const f = fixture(); await f.prepare(); await f.fresh().capture(request());
  await f.fresh().savePreferences({ mode: 'sleep', pokemonKey: 'pikachu:false', backgroundId: 'electric', favoriteBackgrounds: ['electric', 'electric'] });
  const next = (await f.fresh().getSnapshot()).preferences;
  assert.equal(next.mode, 'sleep'); assert.equal(next.pokemonKey, 'pikachu:false'); assert.equal(next.backgroundId, 'electric'); assert.deepEqual(next.favoriteBackgrounds, ['electric']);
  assert.equal(f.pages.length, 2); assert.equal((await f.fresh().getSnapshot()).used, 1);
  f.fail('settings'); await assert.rejects(f.fresh().savePreferences({ mode: 'draw' })); assert.equal((await f.fresh().getSnapshot()).preferences.mode, 'sleep');
});
test('포켓몬 별 저장은 다른 기기가 바꾼 슬립 설정을 덮어쓰지 않음', async () => {
  const f = fixture(); await f.prepare(); await f.fresh().capture(request());
  await f.fresh().savePreferences({ mode: 'sleep' });
  const result = await f.fresh().savePreferences({ mode: 'draw', favoriteChange: { pokemonKey: 'pikachu:false', favorite: true } });
  assert.equal(result.preferences.mode, 'sleep');
});
test('수집 삭제 후 설정의 미수집 포켓몬·배경·즐겨찾기는 조회에서 정리', async () => {
  const f = fixture(); await f.prepare(); await f.fresh().capture(request());
  await f.fresh().savePreferences({ mode: 'sleep', pokemonKey: 'pikachu:false', backgroundId: 'electric', favoriteBackgrounds: ['electric'] });
  f.pages.splice(1); const prefs = (await f.fresh().getSnapshot()).preferences;
  assert.equal(prefs.pokemonKey, ''); assert.equal(prefs.backgroundId, ''); assert.deepEqual(prefs.favoriteBackgrounds, []);
});
test('미수집 포켓몬·배경 설정과 색이 다른 포획·잘못된 요청은 거절', async () => {
  const f = fixture(); await f.prepare();
  await assert.rejects(f.fresh().capture({ ...request(), isShiny: true }), { status: 400 });
  await assert.rejects(f.fresh().capture(request('unknown')), { status: 400 });
  await assert.rejects(f.fresh().savePreferences({ pokemonKey: 'pikachu:false' }), /수집한 포켓몬/);
  await assert.rejects(f.fresh().savePreferences({ favoriteBackgrounds: ['electric'] }), /수집한 배경/);
  assert.equal(f.pages.length, 1);
});
test('설정 페이지 삭제 후 재연결은 새 설정을 생성하고 포획 기록은 보존', async () => {
  const f = fixture(); await f.prepare(); await f.fresh().capture(request()); f.pages.splice(0, 1);
  await assert.rejects(f.fresh().getSnapshot(), /설정 페이지/); await f.prepare();
  assert.equal(f.pages.length, 2); assert.equal((await f.fresh().getSnapshot()).used, 1);
});
test('같은 실행 인스턴스의 동시 포획은 직렬화, 중복·기본 한도 우회 방지', async t => {
  const f = fixture(); await f.prepare();
  const original = NotionCollection.prototype.notion; NotionCollection.prototype.notion = f.fresh().notion;
  t.after(() => { NotionCollection.prototype.notion = original; });
  const capture = slug => worker.fetch(new Request('https://test.workers.dev/api/capture', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ ...request(slug), databaseId: db }) }), f.env);
  const duplicates = await Promise.all([capture('pikachu'), capture('pikachu')]); assert.deepEqual(duplicates.map(r => r.status), [200, 409]);
  const limits = await Promise.all(['raichu', 'eevee', 'bulbasaur'].map(capture)); assert.equal(limits.filter(r => r.ok).length, 2);
  assert.equal((await f.fresh().getSnapshot()).used, 3);
});
test('DB 조회의 다음 페이지를 따라가 모든 포획 기록과 한도를 계산', async () => {
  const c = new NotionCollection({ NOTION_TOKEN: 'mock' }, db);
  c.notion = async (path, body) => path.startsWith('databases/') ? { data_sources: [{ id: 'source' }] }
    : { results: [page(body.start_cursor ? 'eevee' : 'pikachu')], has_more: !body.start_cursor, next_cursor: body.start_cursor ? null : 'next' };
  assert.equal((await c.readRecords()).length, 2);
});
test('Notion 401·404·429는 원인을 표시하며 DB를 새로 만들지 않음', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const [status, message] of [[401, /토큰/], [404, /권한/], [429, /요청/]]) {
    globalThis.fetch = async () => Response.json({}, { status });
    await assert.rejects(new NotionCollection({ NOTION_TOKEN: 'mock' }, db).database(true), message);
  }
});
test('DB 주소 검증과 한국 시간 자정, 히스이·전용 배경 구분', () => {
  assert.equal(pageId('https://www.notion.so/Collection-' + db + '?v=ignored'), db);
  assert.equal(pageId('https://app.notion.com/p/pokemon/Collection-' + db + '?v=ignored'), db);
  assert.equal(pageId('https://app.notion.com/p/pokemon/01234567-89ab-cdef-0123-456789abcdef/'), db);
  assert.throws(() => pageId('https://app.notion.com.evil.example/p/pokemon/' + db));
  assert.equal(pageId('01234567-89ab-cdef-0123-456789abcdef'), db);
  assert.throws(() => pageId('https://evil.example/' + db));
  assert.equal(koreaDay('2026-10-04T14:59:59Z'), '2026-10-04'); assert.equal(koreaDay('2026-10-04T15:00:00Z'), '2026-10-05');
  assert.equal(backgroundFor({ slug: 'arcanine-hisuian' }).id, 'fire'); assert.equal(backgroundFor({ slug: 'zapdos-galarian' }).id, 'special/zapdos-galarian');
});
test('로컬 미리보기의 중복·한도·저장 실패는 기존 동작 유지', async () => {
  const values = new Map(); const store = new LocalStore({ getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) });
  const record = request(); await store.capture(record); await store.capture(record);
  await assert.rejects(store.capture(request()), { code: 'ALREADY_COLLECTED' });
  await store.capture(request('eevee')); await store.capture(request('raichu'));
  await assert.rejects(store.capture(request('bulbasaur')), { code: 'DAILY_LIMIT' });
  const broken = new LocalStore({ getItem: () => null, setItem: () => { throw Error('저장 공간 없음'); } });
  await assert.rejects(broken.capture(record)); assert.equal((await broken.getSnapshot()).used, 0);
});
