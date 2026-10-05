# 제작자용 포켓몬 Pages

공용 화면과 개인 API를 분리했습니다. 배포 준비 파일의 공개 저장소는 https://github.com/loraticon/random_pokemon_widget-test 입니다. 실제 Cloudflare Pages와 개인 Worker 배포는 아직 수행하지 않았습니다.

## 제작자 Pages

1. Cloudflare Pages에서 Git 연동 프로젝트를 만들고 `loraticon/random_pokemon_widget-test` 저장소의 `main` 브랜치를 선택합니다.
2. 프레임워크는 없음, 빌드 명령은 `npm run build`, 출력 디렉터리는 `dist`, 프로젝트 루트는 저장소 루트로 지정합니다.
3. `wrangler.jsonc`는 Pages 전용 설정입니다. 현재 프로젝트 이름 `pokemon-random-widget`은 배포 준비값이며 실제 생성할 이름에 맞춰 수정합니다.
4. `dist` 안의 정적 파일만 배포합니다. `functions`, `_worker.js`, 노션 secrets, 개인 Worker 바인딩은 공용 Pages에 넣지 않습니다.
5. 실제 Pages origin이 확정되면 `cloudflare/worker.wrangler.jsonc`의 `vars.WIDGET_ORIGIN`에 입력합니다. 예: `https://실제프로젝트.pages.dev`. 모든 사용자에게 동일한 값이며 제작자가 템플릿에 한 번 지정합니다. 현재 빈 값은 잘못된 도메인을 허용하지 않기 위한 미설정 상태입니다.
6. 개인 Worker 설치 템플릿을 게시합니다. 공용 화면용 저장소와 개인 API 템플릿은 배포 대상을 구분해야 합니다. 현재 같은 소스 묶음에서 개인 Worker CLI 배포는 `npm run deploy`로 명시합니다. Deploy to Cloudflare 버튼은 실제 API 템플릿 저장소/경로를 확정한 뒤 추가합니다.

공용 `/setup.html`에서 사용자가 개인 Worker 주소와 키를 입력합니다. 생성되는 주소는 `공용Pages/pokedex.html#worker=개인Worker주소&key=개인키`이며 값은 URL 인코딩합니다. 화면 업데이트는 공용 Pages 재배포로 적용됩니다. 개인 API의 코드가 바뀌면 사용자도 Worker를 업데이트합니다.

저장소 루트의 `index.html`은 GitHub 테스트용 도감 화면입니다. Cloudflare 빌드는 별도의 `pokedex.html`을 도감 화면으로 사용하고, `setup.html`을 `dist/index.html`로 복사해 연결 설정을 첫 화면으로 제공합니다. Cloudflare 출력 디렉터리는 저장소 루트가 아닌 `dist`로 지정합니다. `dist`, `node_modules`, 개인 secret 파일은 GitHub에 올리지 않습니다.

## 요금과 한도

2026-10-02 공식 문서 확인 기준입니다.

| 구분 | 요청이 몰릴 때 | 사용량이 잡히는 계정 |
|---|---|---|
| 정적 HTML·JS·CSS·이미지 | Pages 정적 요청은 무료·무제한 | 제작자 Pages |
| 노션 수집 API·인증용 사전 요청 | Workers Free는 계정 전체 하루 100,000 요청. 초과하면 오류 | 사용자별 계정 |
| 포획 제한·중복 방지 저장소 | SQLite Durable Objects는 무료 한도가 있으며 초과한 종류의 작업은 오류 | 사용자별 계정 |
| Pages 코드 배포 | 무료 플랜 월 500회 빌드. 방문 횟수와 별개 | 제작자 계정 |

Durable Objects Free의 주요 한도는 요청 100,000/일, 실행 시간 13,000 GB-s/일, 행 읽기 500만/일, 행 쓰기 100,000/일, 저장 데이터 총 5GB입니다. `get`, `put`, `list`, `delete`도 행 읽기/쓰기에 포함됩니다. 하루 3마리 포획이 하루 API 요청 3회를 뜻하지는 않습니다. 위젯 열기·기록 확인·도감 조회·CORS 사전 요청 등도 요청을 사용하며, 같은 계정의 공부 기록 위젯 등과 계정 한도를 공유합니다.

무료 플랜을 유지하면 한도 초과 시 해당 작업이 제한됩니다. 유료 Workers 플랜을 선택한 계정은 월 기본료 및 사용량에 따른 과금이 적용될 수 있습니다. 계정의 실제 요금제는 배포 전에 확인해야 합니다. 제작자 Pages에는 Functions를 추가하지 않는 구성을 유지합니다. Pages Functions를 추가하면 정적 요청과 달리 Workers 사용량에 포함됩니다.

포켓몬 원격 스프라이트 보조 경로는 기존 GitHub의 raw 이미지입니다. 이 트래픽은 Pages 트래픽과 별개이며, 현재 자산을 전부 Pages로 옮기지는 않았습니다. 사용자 증가에 따른 이미지 제공 문제는 별도로 확인해야 합니다.

공식 자료:

- [Pages 정적 요청과 Functions 요금](https://developers.cloudflare.com/pages/functions/pricing/)
- [Workers 일일 요청 한도](https://developers.cloudflare.com/workers/platform/limits/#daily-requests)
- [Durable Objects 무료·유료 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/)
- [Pages 빌드 한도](https://developers.cloudflare.com/pages/platform/limits/#builds)
