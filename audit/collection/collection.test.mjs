import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { Collection, koreaDay, pageId, backgroundFor, default as worker } from '../../cloudflare/worker.mjs';
const require = createRequire(import.meta.url);
const { LocalStore } = require('../../assets/collection.js');
const collectionClient = require('../../assets/collection.js');
const backgroundCatalog = JSON.parse(fs.readFileSync(new URL('../../data/background-catalog.json', import.meta.url), 'utf8'));
collectionClient.configureBackgrounds(backgroundCatalog, JSON.parse(fs.readFileSync(new URL('../../data/pokemon-background-types.json', import.meta.url), 'utf8')));
const uuid = () => crypto.randomUUID();
class Storage {
  constructor() { this.items = new Map(); }
  async get(key) { return structuredClone(this.items.get(key)); }
  async put(key, value) {
    if (typeof key === 'string') this.items.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.items.set(k, structuredClone(v));
  }
  async delete(key) { for (const k of Array.isArray(key) ? key : [key]) this.items.delete(k); }
  async list({ prefix, startAfter, limit = 1000 }) {
    return new Map([...this.items].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit));
  }
}
async function fixture() {
  const storage = new Storage();
  await storage.put('database', { source: 'source', id: 'db', url: 'https://www.notion.so/db', schemaVersion: 3 });
  const object = new Collection({ storage }, { WIDGET_ORIGIN: 'https://pokemon-example.pages.dev' });
  const pages = [];
  let posts = 0;
  let failure = null;
  const patches = [];
  object.notion = async (path, body, method) => {
    if (path.startsWith('pages/') && method === 'PATCH') {
      if (failure === 'favorite') throw Error('즐겨찾기 저장 실패');
      const page = pages.find(page => page.id === path.slice(6));
      if (!page) throw Error('없는 노션 페이지');
      patches.push(body);
      Object.assign(page.properties, body.properties);
      return page;
    }
    if (path === 'pages') {
      posts++;
      assert.equal(body.parent.data_source_id, 'source');
      assert.ok(body.properties['폼 식별자'].rich_text[0].text.content);
      const page = { id: uuid(), properties: body.properties, created_time: new Date().toISOString() };
      pages.push(page);
      if (failure === 'uncertain') throw Object.assign(new Error('응답 손실'), { uncertain: true });
      return page;
    }
    if (path.endsWith('/query')) {
      const id = body.filter?.rich_text?.equals;
      const matching = id ? pages.filter(page => page.properties[body.filter.property]?.rich_text[0].text.content === id) : pages;
      return { results: matching, has_more: false };
    }
    throw Error('Unexpected endpoint ' + path);
  };
  const capture = body => object.fetch(new Request('https://widget/api/capture', { method: 'POST', body: JSON.stringify(body) }));
  return { object, storage, pages, patches, capture, posts: () => posts, fail: type => { failure = type; } };
}
const body = (slug = 'pikachu') => ({ id: uuid(), slug, isShiny: false });

test('새 DB는 네 속성만 생성, 최소 행의 도감·이미지·배경·즐겨찾기 조회', async () => {
  const f = await fixture();
  f.storage.items.clear();
  f.object.env.NOTION_PARENT_PAGE_ID = '0123456789abcdef0123456789abcdef';
  const calls = [];
  f.object.notion = async (path, payload) => {
    calls.push({ path, payload });
    if (path.startsWith('blocks/')) return { results: [], has_more: false };
    if (path === 'databases') return { id: 'db', url: 'https://www.notion.so/db', data_sources: [{ id: 'source' }] };
    throw Error(path);
  };
  await f.object.ensureDatabase();
  assert.deepEqual(Object.keys(calls.at(-1).payload.initial_data_source.properties).sort(), ['이름', '폼 식별자', '배경 식별자', '즐겨찾기'].sort());
  const record = f.object.toRecord({ id: uuid(), created_time: '2026-09-01T00:00:00Z', properties: {
    '이름': { title: [] }, '폼 식별자': { rich_text: [{ text: { content: 'pikachu' } }] },
    '배경 식별자': { rich_text: [{ text: { content: 'fire' } }] }, '즐겨찾기': { checkbox: true }
  } });
  assert.equal(record.name, '피카츄'); assert.equal(record.dexId, 25); assert.equal(record.favorite, true);
  assert.equal(record.backgroundId, 'fire'); assert.equal(record.backgroundName, '불꽃 타입 배경');
  assert.match(record.imageSrc, /normal\/pikachu.webp$/);
  assert.equal(collectionClient.backgroundFor(record).id, 'fire');
});

test('노션 체크 변경 조회, 별의 단일 변경은 다른 즐겨찾기를 보존, 실패 시 미확정', async () => {
  const f = await fixture(); await f.capture(body()); await f.capture(body('eevee'));
  f.pages[1].properties['즐겨찾기'].checkbox = true;
  const current = await f.object.getSnapshot();
  assert.deepEqual(current.preferences.favoritePokemon, ['eevee:false']);
  const stale = { ...collectionClient.DEFAULT_PREFERENCES, favoritePokemon: [], mode: 'sleep' };
  const result = await f.object.savePreferences({ ...stale, favoriteChange: { pokemonKey: 'pikachu:false', favorite: true } });
  assert.deepEqual(new Set(result.preferences.favoritePokemon), new Set(['pikachu:false', 'eevee:false']));
  assert.equal(f.patches.length, 1);
  f.pages[1].properties['즐겨찾기'].checkbox = false;
  const modeOnly = await f.object.savePreferences({ mode: 'draw', pokemonKey: '', backgroundId: '' });
  assert.deepEqual(modeOnly.preferences.favoritePokemon, ['pikachu:false']);
  f.fail('favorite');
  await assert.rejects(f.object.savePreferences({ ...stale, favoriteChange: { pokemonKey: 'pikachu:false', favorite: false } }), /즐겨찾기 저장 실패/);
  assert.equal(f.pages[0].properties['즐겨찾기'].checkbox, true);
  assert.equal((await f.storage.get('preferences')).mode, 'draw');
});

test('네 속성 DB의 페이지별 조회, 색이 다른 이전 행 제외, 잘못된 식별자 안내', async () => {
  const f = await fixture(); await f.capture(body()); await f.capture(body('eevee'));
  const queries = [];
  const oldShiny = structuredClone(f.pages[0]); oldShiny.properties['색이 다름'] = { checkbox: true };
  f.object.notion = async (path, payload) => {
    assert.ok(path.endsWith('/query')); queries.push(payload);
    return payload.start_cursor ? { results: [f.pages[1]], has_more: false }
      : { results: [f.pages[0], oldShiny], has_more: true, next_cursor: 'second-page' };
  };
  const data = await f.object.getSnapshot(new URL('https://widget/api/collection?records=1'));
  assert.equal(data.records.length, 2); assert.equal(queries[1].start_cursor, 'second-page');
  assert.ok(queries.every(query => !query.sorts));
  const invalid = structuredClone(f.pages[0]);
  invalid.properties['배경 식별자'].rich_text[0].text.content = 'unknown-background';
  assert.throws(() => f.object.toRecord(invalid), /배경 식별자/);
  invalid.properties['폼 식별자'].rich_text[0].text.content = 'unknown-pokemon';
  assert.throws(() => f.object.toRecord(invalid), /폼 식별자/);
});

test('저장 후 다른 노션 행의 잘못된 식별자가 있어도 포획과 기회를 보존', async () => {
  const f = await fixture();
  f.pages.push({ id: uuid(), created_time: new Date().toISOString(), properties: {
    '폼 식별자': { rich_text: [{ text: { content: 'unknown-pokemon' } }] }
  } });
  const request = body();
  const response = await f.capture(request);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /폼 식별자/);
  assert.equal((await f.storage.get('request:' + request.id)).status, 'saved');
  assert.equal((await f.storage.get('owned:pikachu:false')).status, 'saved');
  assert.equal((await f.storage.list({ prefix: 'day:' + koreaDay() + ':' })).size, 1);
  assert.equal((await f.storage.list({ prefix: 'pending:' })).size, 0);
  f.pages.shift();
  assert.equal((await f.capture(request)).status, 200);
  assert.equal(f.posts(), 1);
  assert.equal((await f.object.getSnapshot()).remaining, 2);
});

test('이전 위젯의 즐겨찾기를 새 체크박스로 옮기고 실패한 이동을 재시도', async () => {
  const f = await fixture(); await f.capture(body());
  await f.storage.put('preferences', { ...collectionClient.DEFAULT_PREFERENCES, favoritePokemon: ['pikachu:false'] });
  await f.storage.put('database', { source: 'source', id: 'db', schemaVersion: 2 });
  const source = { properties: { '이름': { title: {} }, '폼 식별자': { rich_text: {} }, '배경 식별자': { rich_text: {} }, '색이 다름': { checkbox: {} } } };
  const original = f.object.notion;
  f.object.notion = async (path, payload, method) => {
    if (path === 'data_sources/source') {
      if (method === 'PATCH') { Object.assign(source.properties, payload.properties); return {}; }
      return source;
    }
    return original(path, payload, method);
  };
  f.fail('favorite');
  await assert.rejects(f.object.ensureDatabase(), /즐겨찾기 저장 실패/);
  assert.equal((await f.storage.get('database')).schemaVersion, 2);
  f.fail(null);
  assert.equal((await f.object.ensureDatabase()).schemaVersion, 3);
  assert.equal(f.pages[0].properties['즐겨찾기'].checkbox, true);
  assert.ok(source.properties['색이 다름']);
  assert.equal(await f.storage.get('notion-favorite-migration'), undefined);
});

test('포획에 전기 배경을 함께 저장, 클라이언트 임의 배경은 무시, 기존 기록과 전용 배경도 해금', async () => {
  const f = await fixture();
  assert.equal((await f.capture({ ...body(), backgroundId: 'fire' })).status, 200);
  const p = f.pages[0].properties;
  assert.equal(p['배경 식별자'].rich_text[0].text.content, 'electric');
  assert.deepEqual(Object.keys(p).sort(), ['이름', '폼 식별자', '배경 식별자', '즐겨찾기'].sort());
  assert.equal(p['즐겨찾기'].checkbox, false);
  const minimal = f.object.toRecord(f.pages[0]);
  assert.equal(minimal.dexId, 25);
  assert.equal(minimal.isShiny, false);
  assert.equal(minimal.capturedAt, f.pages[0].created_time);
  assert.match(minimal.imageSrc, /normal\/pikachu.webp$/);
  assert.equal(minimal.backgroundName, '전기 타입 배경');
  assert.equal(minimal.backgroundSrc, 'https://pokemon-example.pages.dev/assets/backgrounds/electric.webp');
  delete p['배경 식별자'];
  const legacy = f.object.toRecord(f.pages[0]);
  assert.equal(legacy.backgroundId, 'electric');
  assert.equal(backgroundFor({ slug: 'zapdos', dexId: 145 }).id, 'special/zapdos');
  assert.equal(backgroundFor({ slug: 'zapdos-galarian', dexId: 145 }).id, 'special/zapdos-galarian');
});

test('같은 전기 배경 중복 해금, 포켓몬·배경 독립 선택과 재시작 유지, 미수집 선택 거절', async () => {
  const f = await fixture();
  for (const slug of ['pikachu', 'raichu', 'eevee']) await f.capture(body(slug));
  const records = (await f.object.getSnapshot(new URL('https://widget/api/collection?records=1'))).records;
  assert.equal(new Set(records.map(r => r.backgroundId)).size, 2);
  const preferences = { ...collectionClient.DEFAULT_PREFERENCES, mode: 'sleep', pokemonKey: 'eevee:false', backgroundId: 'electric' };
  const response = await f.object.fetch(new Request('https://widget/api/preferences', { method: 'POST', body: JSON.stringify(preferences) }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).preferences, preferences);
  const restarted = new Collection({ storage: f.storage }, f.object.env);
  restarted.notion = f.object.notion;
  assert.deepEqual((await restarted.getSnapshot()).preferences, preferences);
  await assert.rejects(f.object.savePreferences({ ...preferences, pokemonKey: 'mew:false' }), /수집한 포켓몬/);
  await assert.rejects(f.object.savePreferences({ ...preferences, backgroundId: 'fire' }), /수집한 배경/);
  await assert.rejects(f.object.savePreferences({ ...preferences, mode: 'invalid' }), /화면 설정/);
  assert.deepEqual((await f.object.getSnapshot()).preferences, preferences);
});

test('기존 노션 DB에는 누락한 배경 속성만 추가, 수정 실패 후 다시 마이그레이션', async () => {
  const f = await fixture();
  await f.storage.put('database', { source: 'source', id: 'db', url: 'https://www.notion.so/db' });
  const calls = [];
  let fail = true;
  f.object.notion = async (path, payload, method) => {
    calls.push({ path, payload, method });
    if (!payload) return { properties: { '배경 이름': { rich_text: {} }, '이름': { title: {} } } };
    if (fail) throw Error('권한 오류');
    return {};
  };
  await assert.rejects(f.object.ensureDatabase(), /권한 오류/);
  assert.equal((await f.storage.get('database')).schemaVersion, undefined);
  fail = false;
  assert.equal((await f.object.ensureDatabase()).schemaVersion, 3);
  const update = calls.at(-1);
  assert.equal(update.method, 'PATCH');
  assert.deepEqual(Object.keys(update.payload.properties).sort(), ['배경 식별자', '즐겨찾기', '폼 식별자'].sort());
  const count = calls.length;
  await f.object.ensureDatabase(); assert.equal(calls.length, count);
});

test('로컬 슬립 설정 유지와 기존 기록의 배경 해금, 저장 실패는 기존 설정 유지', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const store = new LocalStore(storage);
  await store.capture({ ...body(), name: '피카츄' });
  const preferences = { ...collectionClient.DEFAULT_PREFERENCES, mode: 'sleep', pokemonKey: 'pikachu:false', backgroundId: 'electric' };
  await store.savePreferences(preferences);
  assert.deepEqual((await new LocalStore(storage).getSnapshot()).preferences, preferences);
  await assert.rejects(store.savePreferences({ ...preferences, backgroundId: 'fire' }), /수집한 배경/);
  const broken = new LocalStore({ ...storage, setItem: () => { throw Error('storage full'); } });
  await assert.rejects(broken.savePreferences({ ...preferences, mode: 'draw' }), /storage full/);
  assert.deepEqual((await store.getSnapshot()).preferences, preferences);
});

test('한국 시간 자정과 노션 페이지 주소를 정확히 처리', () => {
  assert.equal(koreaDay('2026-10-01T14:59:59Z'), '2026-10-01');
  assert.equal(koreaDay('2026-10-01T15:00:00Z'), '2026-10-02');
  assert.equal(pageId('https://www.notion.so/title-0123456789abcdef0123456789abcdef?pvs=4'), '0123456789abcdef0123456789abcdef');
  assert.throws(() => pageId('잘못된 주소'));
});

test('노션 체크박스에 복수 즐겨찾기 저장·중복 제거·재시작 유지·모드만 저장해도 유지', async () => {
  const f = await fixture();
  await f.capture(body()); await f.capture(body('raichu')); await f.capture(body('eevee'));
  const preferences = { mode: 'draw', pokemonKey: '', backgroundId: '',
    favoritePokemon: ['pikachu:false', 'raichu:false', 'eevee:false', 'pikachu:false'], favoriteBackgrounds: ['electric', 'normal', 'electric'] };
  const result = await f.object.savePreferences(preferences);
  assert.deepEqual(result.preferences.favoritePokemon, ['pikachu:false', 'raichu:false', 'eevee:false']);
  assert.ok(f.pages.every(page => page.properties['즐겨찾기'].checkbox));
  assert.ok(f.patches.every(patch => Object.keys(patch.properties).join() === '즐겨찾기'));
  assert.deepEqual(result.preferences.favoriteBackgrounds, ['electric', 'normal']);
  const restarted = new Collection({ storage: f.storage }, f.object.env);
  restarted.notion = f.object.notion;
  assert.deepEqual((await restarted.getSnapshot()).preferences, result.preferences);
  const legacyResult = await f.object.savePreferences({ mode: 'sleep', pokemonKey: 'eevee:false', backgroundId: 'electric' });
  assert.deepEqual(legacyResult.preferences.favoritePokemon, result.preferences.favoritePokemon);
  assert.deepEqual(legacyResult.preferences.favoriteBackgrounds, result.preferences.favoriteBackgrounds);
  assert.equal((await f.object.getSnapshot()).used, 3);
  await assert.rejects(f.object.savePreferences({ ...legacyResult.preferences, favoritePokemon: ['mew:false'] }), /수집한 포켓몬/);
  await assert.rejects(f.object.savePreferences({ ...legacyResult.preferences, favoriteBackgrounds: ['fire'] }), /수집한 배경/);
  for (const values of [null, 'pikachu:false', [1], Array(3001).fill('pikachu:false')]) {
    await assert.rejects(f.object.savePreferences({ ...legacyResult.preferences, favoritePokemon: values }), /즐겨찾기 설정/);
  }
  assert.deepEqual((await f.object.getSnapshot()).preferences, legacyResult.preferences);
});

test('큰 즐겨찾기 요청은 8KB 이상도 저장, 노션에서 삭제된 이전 즐겨찾기는 다음 저장 시 정리', async () => {
  const f = await fixture(); await f.capture(body()); await f.capture(body('eevee'));
  const preferences = { mode: 'draw', pokemonKey: '', backgroundId: '', favoritePokemon: Array(700).fill('pikachu:false'), favoriteBackgrounds: ['electric', 'normal'] };
  const payload = JSON.stringify(preferences);
  assert.ok(new TextEncoder().encode(payload).length > 8192);
  const response = await f.object.fetch(new Request('https://widget/api/preferences', { method: 'POST', body: payload }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).preferences.favoritePokemon, ['pikachu:false']);
  f.pages.splice(0, 1);
  const result = await f.object.savePreferences({ mode: 'draw', pokemonKey: '', backgroundId: '' });
  assert.deepEqual(result.preferences.favoritePokemon, []);
  assert.deepEqual(result.preferences.favoriteBackgrounds, ['normal']);
});

test('로컬 즐겨찾기 호환·복수 등록·저장 실패 원복·미수집 거절', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const store = new LocalStore(storage);
  await store.capture({ ...body(), name: '피카츄' }); await store.capture({ ...body('eevee'), name: '이브이' });
  const saved = (await store.savePreferences({ mode: 'draw', pokemonKey: '', backgroundId: '', favoritePokemon: ['pikachu:false', 'eevee:false'], favoriteBackgrounds: ['electric'] })).preferences;
  assert.deepEqual((await new LocalStore(storage).getSnapshot()).preferences, saved);
  await store.savePreferences({ mode: 'sleep', pokemonKey: '', backgroundId: '' });
  assert.deepEqual((await store.getSnapshot()).preferences.favoritePokemon, saved.favoritePokemon);
  await assert.rejects(store.savePreferences({ ...saved, favoritePokemon: ['mew:false'] }), /수집한 포켓몬/);
  await assert.rejects(store.savePreferences({ ...saved, favoriteBackgrounds: null }), /즐겨찾기 설정/);
  const before = (await store.getSnapshot()).preferences;
  const broken = new LocalStore({ ...storage, setItem: () => { throw Error('storage full'); } });
  await assert.rejects(broken.savePreferences({ ...saved, favoritePokemon: [] }), /storage full/);
  assert.deepEqual((await store.getSnapshot()).preferences, before);
});
test('동시 포획 네 번 중 세 번만 저장, 새 요청 ID로 한도 우회 불가', async () => {
  const f = await fixture();
  const responses = await Promise.all(['pikachu', 'raichu', 'eevee', 'bulbasaur'].map(slug => f.capture(body(slug))));
  assert.equal(responses.filter(r => r.ok).length, 3);
  assert.equal(responses.filter(r => r.status === 409).length, 1);
  assert.equal(f.posts(), 3);
  const state = await f.object.getSnapshot();
  assert.equal(state.used, 3); assert.equal(state.remaining, 0);
  assert.equal(state.owned.length, 3);
  const rejected = responses.find(r => !r.ok);
  assert.equal((await rejected.json()).code, 'DAILY_LIMIT');
});

test('같은 포켓몬 동시 요청은 한 번만 포획하고 기회도 한 번만 사용', async () => {
  const f = await fixture();
  const responses = await Promise.all([f.capture(body()), f.capture(body())]);
  assert.equal(responses.filter(r => r.ok).length, 1);
  assert.equal((await responses.find(r => !r.ok).json()).code, 'ALREADY_COLLECTED');
  assert.equal(f.posts(), 1);
  const state = await f.object.getSnapshot();
  assert.equal(state.used, 1); assert.equal(state.remaining, 2);
  assert.deepEqual(state.owned, ['pikachu:false']);
});

test('기존 기록과 이전 날짜의 포획도 중복을 막고 색이 다른 포켓몬은 거절', async () => {
  const f = await fixture();
  const record = { ...body(), capturedAt: '2026-09-01T00:00:00Z' };
  await f.storage.put('request:' + record.id, { day: '2026-09-01', status: 'saved', record });
  assert.equal((await f.capture(body())).status, 409);
  assert.equal((await f.object.getSnapshot()).used, 0);
  assert.equal((await f.capture({ ...body(), isShiny: true })).status, 400);
  assert.equal(f.posts(), 0);
});

test('기존 노션 DB에만 있는 포켓몬도 중복 저장하지 않음', async () => {
  const f = await fixture(); await f.capture(body());
  for (const key of [...f.storage.items.keys()]) if (key !== 'database') f.storage.items.delete(key);
  const response = await f.capture(body());
  assert.equal((await response.json()).code, 'ALREADY_COLLECTED');
  assert.equal(f.posts(), 1);
  const state = await f.object.getSnapshot();
  assert.equal(state.used, 0); assert.equal(state.remaining, 3); assert.deepEqual(state.owned, ['pikachu:false']);
});
test('같은 요청 반복과 다른 포켓몬으로 요청 ID 재사용', async () => {
  const f = await fixture(), request = body();
  assert.equal((await f.capture(request)).status, 200);
  assert.equal((await f.capture(request)).status, 200);
  assert.equal((await f.capture({ ...request, slug: 'raichu' })).status, 409);
  assert.equal(f.posts(), 1);
});
test('노션에 저장됐지만 응답을 놓쳐도 POST 재전송 없이 복구', async () => {
  const f = await fixture(), request = body(); f.fail('uncertain');
  assert.equal((await f.capture(request)).status, 503);
  const pending = await f.object.getSnapshot();
  assert.equal(pending.used, 0); assert.equal(pending.remaining, 2); assert.equal(pending.pending.length, 1);
  assert.equal((await f.capture(body())).status, 409);
  assert.equal((await f.capture(request)).status, 200);
  assert.equal(f.posts(), 1);
  assert.equal((await f.object.getSnapshot()).used, 1);
});
test('노션 삭제로 당일 기회가 되살아나지 않음, DB 수정 내용은 조회에 반영', async () => {
  const f = await fixture(); await f.capture(body());
  f.pages[0].properties['이름'].title[0].text.content = '수정한 이름';
  let state = await f.object.getSnapshot(new URL('https://widget/api/collection?records=1'));
  assert.equal(state.records[0].name, '수정한 이름');
  f.pages.splice(0);
  state = await f.object.getSnapshot(new URL('https://widget/api/collection?records=1'));
  assert.equal(state.records.length, 0); assert.equal(state.used, 1);
});
test('재시작 후 저장된 예약과 성공 횟수를 유지', async () => {
  const f = await fixture(); await f.capture(body());
  const restarted = new Collection({ storage: f.storage }, f.object.env);
  restarted.notion = f.object.notion;
  assert.equal((await restarted.getSnapshot()).used, 1);
});
test('노션이 명확히 저장을 거절하면 기회 예약을 해제', async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  f.object.notion = Collection.prototype.notion;
  globalThis.fetch = async url => String(url).endsWith('/query') ? Response.json({ results: [] })
    : Response.json({ message: 'not allowed' }, { status: 403 });
  try {
    assert.equal((await f.capture(body())).status, 503);
    const state = await f.object.getSnapshot();
    assert.equal(state.used, 0); assert.equal(state.remaining, 3); assert.equal(state.pending.length, 0);
    assert.equal(state.owned.length, 0);
    assert.equal(f.storage.items.has('owned:pikachu:false'), false);
  } finally { globalThis.fetch = originalFetch; }
});
test('잘못된 포켓몬/요청은 저장하지 않음', async () => {
  const f = await fixture();
  assert.equal((await f.capture({ ...body(), slug: 'unknown' })).status, 400);
  assert.equal((await f.capture({ ...body(), id: 'not-a-uuid' })).status, 400);
  assert.equal(f.posts(), 0);
});
test('위젯 키 검증 전에 Notion/저장소에 접근하지 않음', async () => {
  const response = await worker.fetch(new Request('https://widget/api/collection'), {
    WIDGET_ORIGIN: 'https://pokemon-example.pages.dev', WIDGET_KEY: 'a'.repeat(32), NOTION_TOKEN: 'test', COLLECTION: { get() { throw Error('unauthorized access'); } }
  });
  assert.equal(response.status, 401);
});
test('로컬 미리보기: 아니오는 차감 없음, 3회 제한과 중복 요청 및 저장 실패', async () => {
  const values = new Map();
  const store = new LocalStore({ getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v) });
  assert.equal((await store.getSnapshot()).used, 0);
  const record = { ...body(), name: '피카츄', dexId: 25 };
  assert.equal((await store.capture(record)).used, 1);
  assert.equal((await store.capture(record)).used, 1);
  await assert.rejects(store.capture({ ...record, id: uuid() }), { code: 'ALREADY_COLLECTED' });
  assert.equal((await store.getSnapshot()).used, 1);
  await store.capture({ ...record, slug: 'raichu', id: uuid() }); await store.capture({ ...record, slug: 'eevee', id: uuid() });
  await assert.rejects(store.capture({ ...record, slug: 'bulbasaur', id: uuid() }), { code: 'DAILY_LIMIT' });
  const broken = new LocalStore({ getItem: () => null, setItem: () => { throw Error('storage full'); } });
  await assert.rejects(broken.capture(record));
  assert.equal((await broken.getSnapshot()).used, 0);
});
