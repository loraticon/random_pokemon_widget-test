import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker, { NotionCollection } from '../../cloudflare/worker.mjs';
const db = '123456781234123412341234567890ab', origin = 'https://pokemon.loraticon.com';
const collectionSource = fs.readFileSync(new URL('../../assets/collection.js', import.meta.url), 'utf8');
const setupSource = fs.readFileSync(new URL('../../setup.html', import.meta.url), 'utf8');
const setupScript = [...setupSource.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
function client(fetcher, values = new Map()) {
  const context = vm.createContext({ URL, URLSearchParams, crypto, TextEncoder, AbortSignal, fetch: fetcher,
    localStorage: { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) } });
  vm.runInContext(collectionSource, context);
  return { context, values, api: context.PokemonCollection };
}
const snapshot = () => ({ owned: [], pending: [], records: [], used: 0, limit: 3, remaining: 3, preferences: {}, nextCursor: null });
function request(path, method = 'GET', body, headers = {}) {
  return new Request('https://personal.workers.dev' + path, { method, headers: { Origin: origin, ...headers }, ...(body !== undefined ? { body } : {}) });
}
test('붙여넣기 Worker는 저장소 바인딩 없이 CORS 응답, NOTION_TOKEN 누락을 안내', async () => {
  const preflight = await worker.fetch(request('/api/setup', 'OPTIONS', undefined, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }), {});
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  const missing = await worker.fetch(request('/api/setup', 'POST', '{}'), {});
  assert.equal(missing.status, 503); assert.match((await missing.json()).error, /NOTION_TOKEN/);
});
test('다른 사이트·null Origin·잘못된 메서드·사용하지 않는 헤더는 거절', async () => {
  for (const other of ['https://else.example', 'null']) assert.equal((await worker.fetch(request('/api/collection', 'GET', undefined, { Origin: other }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/setup'), {})).status, 405);
  assert.equal((await worker.fetch(request('/unknown'), {})).status, 404);
  assert.equal((await worker.fetch(request('/api/setup', 'OPTIONS', undefined, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' }), {})).status, 403);
  assert.equal((await worker.fetch(request('/api/setup'), { WIDGET_ORIGIN: 'http://example.com' })).status, 503);
});
test('잘못된 JSON·DB 주소·큰 요청은 Notion 쓰기 전에 거절', async () => {
  const env = { NOTION_TOKEN: 'test-only' };
  for (const body of ['{', 'null', '[]', '{}', JSON.stringify({ databaseId: 'https://wrong.example/' + db })]) assert.equal((await worker.fetch(request('/api/setup', 'POST', body), env)).status, 400);
  assert.equal((await worker.fetch(request('/api/setup', 'POST', JSON.stringify({ databaseId: db, extra: 'a'.repeat(65536) })), env)).status, 413);
});
test('설정 API는 입력한 원본 DB를 준비하며 DB별로 라우팅', async t => {
  const originalDatabase = NotionCollection.prototype.database, originalSettings = NotionCollection.prototype.settings;
  const seen = [];
  NotionCollection.prototype.database = async function (prepare) { seen.push([this.databaseId, prepare]); return { url: 'https://www.notion.so/' + this.databaseId }; };
  NotionCollection.prototype.settings = async function (create) { seen.push(create); };
  t.after(() => { NotionCollection.prototype.database = originalDatabase; NotionCollection.prototype.settings = originalSettings; });
  const response = await worker.fetch(request('/api/setup', 'POST', JSON.stringify({ databaseId: db })), { NOTION_TOKEN: 'test-only', DAILY_LIMIT: '5' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { databaseId: db, databaseUrl: 'https://www.notion.so/' + db, dailyLimit: 5 });
  assert.deepEqual(seen, [[db, true], true]);
});
test('RemoteStore는 Worker+DB를 검증하고 GET·POST에 DB만 전달, API 토큰 없이 연결', async () => {
  const calls = [], f = client(async (url, init) => { calls.push([url, init]); return Response.json(snapshot()); });
  const store = new f.api.RemoteStore('https://personal.workers.dev/', 'https://www.notion.so/Collection-' + db + '?v=view');
  await store.getSnapshot(true); await store.request('/api/setup', { databaseId: 'cannot-override' });
  assert.equal(new URL(calls[0][0]).searchParams.get('db'), db);
  assert.equal(new URL(calls[0][0]).searchParams.get('records'), '1');
  assert.equal(JSON.parse(calls[1][1].body).databaseId, db);
  assert.equal(calls[1][1].credentials, 'omit'); assert.equal(calls[1][1].headers.Authorization, undefined);
  for (const [url, id] of [['http://personal.workers.dev', db], ['https://personal.workers.dev/api', db], ['https://personal.workers.dev', 'bad']]) await assert.rejects(new f.api.RemoteStore(url, id).getSnapshot());
  assert.equal(calls.length, 2);
});
test('응답 손실의 미확인 기록은 DB별로 분리하고 저장된 포켓몬 조회로 해제', async () => {
  let fail = true, owned = [];
  const f = client(async () => { if (fail) throw Error('offline'); return Response.json({ ...snapshot(), owned }); });
  const store = new f.api.RemoteStore('https://personal.workers.dev', db), other = new f.api.RemoteStore('https://personal.workers.dev', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const record = { id: crypto.randomUUID(), slug: 'pikachu', isShiny: false };
  await assert.rejects(store.capture(record)); assert.equal((await store.pending()).id, record.id); assert.equal(await other.pending(), null);
  fail = false; assert.equal((await store.getSnapshot()).pending.length, 1);
  owned = ['pikachu:false']; assert.equal((await store.getSnapshot()).pending.length, 0); assert.equal(await store.pending(), null);
});
test('한도·중복 거절은 미확인 포획을 해제, 통신 오류는 재확인 가능하도록 보존', async () => {
  for (const code of ['DAILY_LIMIT', 'ALREADY_COLLECTED']) {
    const f = client(async () => Response.json({ error: '거절', code }, { status: 409 }));
    const store = new f.api.RemoteStore('https://personal.workers.dev', db);
    await assert.rejects(store.capture({ id: crypto.randomUUID(), slug: 'pikachu', isShiny: false }), error => error.code === code);
    assert.equal(await store.pending(), null);
  }
});
function setupFixture({ protocol = 'https:', hash = '', clipboardFails = false, responseError = false, collectionResponse } = {}) {
  const calls = [], copied = [], elements = new Map([...setupSource.matchAll(/id="([^"]+)"/g)].map(m => [m[1], { value: '', hidden: m[1] === 'result', events: {}, addEventListener(k, fn) { this.events[k] = fn; }, select() { this.selected = true; } }]));
  const f = client(async (url, init) => {
    calls.push([url, init]);
    if (responseError) return Response.json({ error: 'DB 권한을 확인해주세요.' }, { status: 503 });
    if (new URL(url).pathname === '/api/collection') return collectionResponse ? collectionResponse(url, init) : Response.json(snapshot());
    return Response.json({ databaseId: db, databaseUrl: 'https://www.notion.so/' + db });
  });
  Object.assign(f.context, { document: { getElementById: id => elements.get(id) },
    location: { protocol, hash, href: protocol + '//pokemon.loraticon.com/setup' + hash, pathname: '/setup', search: '' },
    history: { calls: [], replaceState(...args) { this.calls.push(args); } },
    navigator: { clipboard: { async writeText(value) { if (clipboardFails) throw Error('denied'); copied.push(value); } } } });
  vm.runInContext(setupScript, f.context);
  const submit = async () => { elements.get('worker').value ||= 'https://personal.workers.dev'; elements.get('database').value ||= 'https://www.notion.so/' + db; await elements.get('connect-form').events.submit({ preventDefault() {} }); };
  return { ...f, elements, calls, copied, submit };
}
test('HTTPS 연결 화면은 DB 준비→실제 기록 조회→링크 생성→자동 복사 및 다시 복사', async () => {
  const f = setupFixture(); await f.submit();
  assert.equal(f.calls.length, 2); assert.equal(JSON.parse(f.calls[0][1].body).databaseId, db);
  assert.equal(new URL(f.calls[1][0]).pathname, '/api/collection');
  assert.equal(new URL(f.calls[1][0]).searchParams.get('records'), '1');
  assert.equal(new URL(f.calls[1][0]).searchParams.get('db'), db);
  assert.deepEqual(f.calls.map(([, init]) => init.method), ['POST', 'GET']);
  const url = new URL(f.elements.get('widget-url').value), params = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.pathname, '/pokedex.html'); assert.equal(params.get('db'), db); assert.equal(params.get('worker'), 'https://personal.workers.dev'); assert.equal(params.has('key'), false);
  assert.equal(f.elements.get('result').hidden, false); assert.equal(f.copied.length, 1);
  await f.elements.get('copy').events.click(); assert.equal(f.copied.length, 2); assert.equal(f.elements.get('connect').disabled, false);
});
test('app.notion.com의 워크스페이스·DB 링크로 연결하고 위장 도메인은 거절', async () => {
  const f = setupFixture();
  f.elements.get('database').value = 'https://app.notion.com/p/pokemon/Collection-' + db + '?v=view';
  await f.submit();
  assert.equal(f.calls.length, 2); assert.equal(JSON.parse(f.calls[0][1].body).databaseId, db);
  assert.equal(f.elements.get('result').hidden, false); assert.equal(f.copied.length, 1);
  assert.throws(() => f.api.normalizeDatabaseId('https://app.notion.com.evil.example/p/pokemon/' + db));
});
test('클립보드 차단 시 수동 복사·선택 안내, API 실패 시 링크를 표시하지 않음', async () => {
  const f = setupFixture({ clipboardFails: true }); await f.submit();
  assert.match(f.elements.get('status').textContent, /복사 버튼/); await f.elements.get('copy').events.click(); assert.equal(f.elements.get('widget-url').selected, true);
  const bad = setupFixture({ responseError: true }); await bad.submit(); assert.equal(bad.elements.get('result').hidden, true); assert.match(bad.elements.get('error-detail').textContent, /권한/);
  assert.equal(bad.calls.length, 1); assert.equal(bad.copied.length, 0);
  assert.match(bad.elements.get('error-stage').textContent, /DB 준비/);
});
test('설치 링크는 두 주소만 미리 입력, 버튼 전 API 호출 없음; file 연결은 HTTPS 안내', async () => {
  const f = setupFixture({ hash: '#' + new URLSearchParams({ worker: 'https://personal.workers.dev', db }) });
  assert.equal(f.elements.get('database').value, 'https://www.notion.so/' + db); assert.equal(f.calls.length, 0);
  assert.equal(f.context.history.calls.length, 1); assert.equal(f.context.history.calls[0][2], '/setup');
  const local = setupFixture({ protocol: 'file:' }); await local.submit(); assert.equal(local.calls.length, 0); assert.match(local.elements.get('error-detail').textContent, /HTTPS/);
});

test('오류 안내 바로가기 해시는 유지하고 Worker 설치 매개변수만 주소에서 제거', () => {
  const help = setupFixture({ hash: '#troubleshooting' });
  assert.equal(help.context.history.calls.length, 0);
  assert.equal(help.context.location.hash, '#troubleshooting');
  assert.equal(help.calls.length, 0);
  const invalidInstall = setupFixture({ hash: '#worker=invalid' });
  assert.equal(invalidInstall.context.history.calls.length, 1);
  assert.match(invalidInstall.elements.get('status').textContent, /설치 링크/);
  assert.equal(invalidInstall.calls.length, 0);
});

test('DB 준비 후 기록 조회 실패는 정확한 오류와 해당 해결 안내를 표시하고 링크·복사를 차단', async () => {
  for (const [message, topic] of [
    ["노션의 폼 식별자 ''를 확인해주세요.", 'form'],
    ["노션의 배경 식별자 'bad'를 확인해주세요.", 'background'],
    ['복제한 원본 DB 주소와 노션의 연결 추가 권한을 확인해주세요.', 'permissions'],
    ['노션 연결 토큰을 확인해주세요.', 'token'],
    ['개인 Worker에 연결하지 못했어요. 주소와 Worker의 WIDGET_ORIGIN 설정을 확인해주세요.', 'worker'],
    ['위젯 설정 페이지를 준비해주세요.', 'settings'],
    ["노션의 '이름' 속성 유형을 확인해주세요.", 'schema'],
    ['노션 요청이 잠시 많아졌어요.', 'retry'],
    ['ë…¸, ì…', 'encoding'],
    ['알 수 없는 오류', null]
  ]) {
    const f = setupFixture({ collectionResponse: () => Response.json({ error: message }, { status: 503 }) });
    await f.submit();
    assert.equal(f.calls.length, 2);
    assert.equal(f.elements.get('result').hidden, true);
    assert.equal(f.elements.get('widget-url').value, '');
    assert.equal(f.copied.length, 0);
    assert.equal(f.elements.get('connection-error').hidden, false);
    assert.match(f.elements.get('error-stage').textContent, /수집 기록 확인/);
    assert.equal(f.elements.get('error-detail').textContent, message);
    assert.equal(f.elements.get('error-help').href, topic ? '#help-' + topic : '#troubleshooting');
    await f.elements.get('error-help').events.click();
    if (topic) assert.equal(f.elements.get('help-' + topic).open, true);
    assert.equal(f.elements.get('connect').disabled, false);
  }
});

test('실제 조회를 기다리는 동안 결과를 숨기고 중복 연결·복사를 하지 않음', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = setupFixture({ collectionResponse: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const connecting = f.submit();
  await waiting;
  assert.match(f.elements.get('status').textContent, /2 \/ 2.*수집 기록/);
  assert.equal(f.elements.get('result').hidden, true);
  assert.equal(f.elements.get('widget-url').value, '');
  assert.equal(f.elements.get('connect').disabled, true);
  await f.submit(); await f.elements.get('copy').events.click();
  assert.equal(f.calls.length, 2); assert.equal(f.copied.length, 0);
  release(Response.json(snapshot())); await connecting;
  assert.equal(f.elements.get('result').hidden, false); assert.equal(f.copied.length, 1);
});

test('조회 실패 재시도에서 이전 링크를 지우며 수정 후 다시 연결 가능', async () => {
  let fail = false;
  const f = setupFixture({ collectionResponse: () => fail ? Response.json({ error: '노션 연결 토큰을 확인해주세요.' }, { status: 503 }) : Response.json(snapshot()) });
  await f.submit(); assert.equal(f.copied.length, 1);
  fail = true; await f.submit();
  assert.equal(f.elements.get('widget-url').value, '');
  await f.elements.get('copy').events.click();
  assert.equal(f.copied.length, 1); assert.equal(f.elements.get('result').hidden, true);
  fail = false; await f.submit();
  assert.equal(f.elements.get('connection-error').hidden, true);
  assert.equal(f.elements.get('result').hidden, false); assert.equal(f.copied.length, 2);
});

test('잘못된 Worker의 HTTP 200 응답도 링크 생성 성공으로 처리하지 않음', async () => {
  for (const response of [
    () => new Response('<html>Worker 설치 안내</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => Response.json({ databaseId: db }),
    () => Response.json(null),
    () => Response.json({ ...snapshot(), records: null }),
    () => Response.json({ ...snapshot(), preferences: [] })
  ]) {
    const f = setupFixture({ collectionResponse: response }); await f.submit();
    assert.equal(f.elements.get('result').hidden, true); assert.equal(f.copied.length, 0);
    assert.match(f.elements.get('error-detail').textContent, /최신 worker.js/);
    assert.equal(f.elements.get('error-help').href, '#help-worker');
  }
});
