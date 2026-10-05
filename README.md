# random_pokemon_widget-ver1

노션에 포켓몬을 수집하는 개인용 위젯입니다. 공용 화면은 Cloudflare Pages, 노션 API 연결은 사용자의 개인 Cloudflare Worker에서 제공합니다. 수집 기록과 여러 기기에서 공유할 화면 설정은 노션에 저장합니다.

## 사용자 설치

1. 포켓몬 전용 개인 노션 공간에 수집 DB 템플릿을 복제합니다.
2. 노션 내부 연결을 만들고 복제한 원본 DB에 읽기·삽입·업데이트를 허용합니다.
3. 개인 Worker를 만들어 [worker.js](https://pokemon.loraticon.com/downloads/worker.js)를 붙여넣고 배포합니다. 노션 내부 연결 토큰은 `NOTION_TOKEN` Secret으로 등록합니다.
4. [HTTPS 연결 페이지](https://pokemon.loraticon.com/setup)에 Worker 주소와 원본 DB 주소를 입력합니다.
5. 생성·복사된 위젯 주소를 비공개 노션 페이지에 임베드합니다.

사용자는 Node.js 설치·GitHub 연결·Bindings 설정을 하지 않아도 됩니다. [설치 ZIP](./cloudflare-개인설치.zip)에는 단일 Worker 코드와 안내문이 들어 있습니다. [자세한 설치 안내](./cloudflare/installer/먼저-읽어주세요.md)를 참고하세요. 공개 템플릿 복제 링크는 아직 등록하지 않았습니다.

수집 DB는 이름(제목), 폼 식별자(텍스트), 배경 식별자(텍스트), 즐겨찾기(체크박스)를 사용합니다. 연결하면 같은 DB 안에 ‘위젯 설정’ 페이지를 추가합니다. 이 페이지는 포획 횟수에서 제외하고 배경 즐겨찾기·슬립 설정을 공유합니다.

포획 한도는 기본 하루 3마리이며 개인 Worker의 `DAILY_LIMIT` 변수로 조절할 수 있습니다. 노션에 남아 있는 오늘의 기록을 기준으로 하므로 오늘 기록을 삭제하면 기회가 돌아옵니다. 현재 기록으로 같은 폼의 중복을 확인하며 여러 Worker 실행 인스턴스 사이의 동시 저장은 엄격히 잠그지 않습니다.

별도의 위젯용·설정용 토큰은 사용하지 않습니다. 개인 기기와 비공개 노션 페이지에서만 사용하고 Worker·위젯 주소를 공유하거나 공개하지 마세요.

## 제작자 빌드

Node.js 개발 환경에서 `npm ci`, `npm run build`, `npm test` 순서로 실행합니다. Cloudflare Pages 빌드 명령은 `npm run build`, 출력 폴더는 `dist`입니다. 루트 `wrangler.jsonc`는 공용 Pages 설정이며 개인 Worker 설정은 `cloudflare/worker.wrangler.jsonc`입니다.

빌드는 공용 화면·이미지·데이터, 사용자용 단일 worker.js와 두 배포 ZIP을 생성합니다. [공용 Pages 배포 안내](./cloudflare/공용-Pages-배포.md)를 참고하세요.

이 저장 구조로 전환할 때는 공용 Pages와 개인 Worker를 모두 업데이트하고 새 위젯 주소를 생성합니다. 기존 노션 기록·체크박스를 보존하며 이전 Cloudflare 저장소의 배경 즐겨찾기·슬립 설정은 다시 선택합니다. 이전 Durable Object를 실제로 배포했던 Worker는 보존하고 새 Worker에 설치합니다. Bindings가 비어 있었던 테스트 Worker는 업데이트할 수 있습니다.

비상업적 팬 프로젝트입니다. © Nintendo / Creatures / GAME FREAK / Pokémon
