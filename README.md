# YouTube 채널 검색 시스템

전세계 유튜브 채널을 대상으로 한 고급 검색 및 분석 시스템입니다.

## 주요 기능

- **다국가 검색**: 전세계 유튜브 채널 대상 검색
- **고급 필터링**: 조회수, 업로드 기간, 동영상 길이별 필터링
- **정렬 기능**: 모든 컬럼에 대한 오름차순/내림차순 정렬
- **페이지네이션**: 30/50/100/200개씩 결과 표시
- **썸네일 다운로드**: 검색된 동영상의 썸네일 이미지 다운로드

## 설치 및 실행

### 1. 의존성 설치
```bash
npm install
```

### 2. YouTube API 키 설정

#### 기본 설정 (단일 API 키)
- [Google Cloud Console](https://console.cloud.google.com/)에서 YouTube Data API v3 활성화
- API 키 생성
- `.env` 파일 생성

```env
YOUTUBE_API_KEY=YOUR_YOUTUBE_API_KEY_HERE
PORT=3000
```

#### 고급 설정 (다중 API 키) - 할당량 확장 권장 ✨
여러 Google 계정의 API 키를 사용하여 일일 할당량을 확장할 수 있습니다:

```env
# 최대 API 키 개수 설정 (기본값: 10)
MAX_API_KEYS=20

# 주 계정 (기본)
YOUTUBE_API_KEY_1=YOUR_FIRST_API_KEY_HERE

# 보조 계정들
YOUTUBE_API_KEY_2=YOUR_SECOND_API_KEY_HERE
YOUTUBE_API_KEY_3=YOUR_THIRD_API_KEY_HERE

# 필요에 따라 MAX_API_KEYS 설정값까지 추가 가능
YOUTUBE_API_KEY_4=YOUR_FOURTH_API_KEY_HERE
YOUTUBE_API_KEY_5=YOUR_FIFTH_API_KEY_HERE
# ...
# YOUTUBE_API_KEY_20=YOUR_TWENTIETH_API_KEY_HERE

# 기존 호환성을 위한 기본 키 (KEY_1과 동일하게 설정)
YOUTUBE_API_KEY=YOUR_FIRST_API_KEY_HERE
PORT=3000
```

**다중 API 키 장점:**
- **확장 가능한 할당량**: 기본 10,000 → MAX_API_KEYS × 10,000 units/일
- **예시 확장량**:
  - 10개 키: 100,000 units/일 (490회 검색)
  - 20개 키: 200,000 units/일 (980회 검색)
  - 50개 키: 500,000 units/일 (2,450회 검색)
- 할당량 초과 시 자동 다음 키로 전환
- 실시간 사용량 통계 및 모니터링
- 환경변수로 키 개수 동적 조정 가능

#### 사용법 예시
```env
# 예시 1: 20개 API 키 사용 (일일 980회 검색 가능)
MAX_API_KEYS=20

# 예시 2: 50개 API 키 사용 (일일 2,450회 검색 가능)  
MAX_API_KEYS=50

# 예시 3: 기본 설정 (10개 키, 일일 490회 검색)
# MAX_API_KEYS=10  (또는 설정하지 않음)
```

### 3. 서버 실행
```bash
npm start
```

### 4. 웹 브라우저에서 접속
```
http://localhost:3000
```

## 검색 옵션

### 국가 선택
- 대한민국, 미국, 일본, 중국, 영국, 독일, 프랑스, 캐나다, 호주, 인도

### 검색 필터
- **검색 키워드**: 특정 키워드로 동영상 검색
- **최소/최대 조회수**: 조회수 범위 설정 (기본: 10만 이상)
- **업로드 기간**: 1일, 1주일, 1개월, 3개월, 6개월, 1년
- **동영상 길이**: Short Form (4분 미만), Long Form (30분 이상)

### 결과 표시
- **정렬**: 채널명, 상태, 카테고리, 업로드일, 조회수별 정렬
- **페이지네이션**: 30/50/100/200개씩 표시
- **썸네일 다운로드**: 각 동영상의 썸네일 이미지 다운로드

## API 엔드포인트

### GET /api/search
YouTube 동영상 검색

**Query Parameters:**
- `country`: 국가 코드 (기본값: KR)
- `keyword`: 검색 키워드
- `minViews`: 최소 조회수 (기본값: 100000)
- `maxViews`: 최대 조회수
- `uploadPeriod`: 업로드 기간
- `videoLength`: 동영상 길이 (short/long/both)
- `maxResults`: 최대 결과 수 (기본값: 1000)

### GET /api/download-thumbnail
썸네일 이미지 다운로드

**Query Parameters:**
- `url`: 썸네일 이미지 URL
- `filename`: 다운로드할 파일명

## 기술 스택

- **Backend**: Node.js, Express.js
- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **API**: YouTube Data API v3
- **Dependencies**: 
  - googleapis: YouTube API 연동
  - axios: HTTP 클라이언트
  - cors: CORS 처리
  - dotenv: 환경변수 관리

## 응답 데이터 구조

```json
{
  "success": true,
  "data": [
    {
      "youtube_channel_name": "채널명",
      "thumbnail_url": "썸네일 URL",
      "status": "상태",
      "youtube_channel_id": "채널 ID",
      "primary_category": "카테고리",
      "status_date": "업로드일",
      "daily_view_count": 조회수,
      "vod_url": "동영상 URL",
      "video_id": "비디오 ID",
      "title": "동영상 제목",
      "description": "설명",
      "duration": "재생시간"
    }
  ],
  "total": 결과수
}
```

## 주의사항

1. YouTube API 키가 필요합니다.
2. API 호출 제한이 있으므로 과도한 요청 시 제한될 수 있습니다.
3. 대량의 결과 검색 시 시간이 오래 걸릴 수 있습니다.

## 문제 해결

### YouTube API 키 오류
- Google Cloud Console에서 YouTube Data API v3가 활성화되어 있는지 확인
- API 키가 올바르게 설정되어 있는지 확인

### 검색 결과가 나오지 않는 경우
- 검색 조건을 완화해보세요 (조회수 범위 확대, 키워드 변경 등)
- 네트워크 연결 상태를 확인하세요

### 서버 실행 오류
- Node.js 버전이 최신인지 확인하세요 (권장: v14 이상)
- 의존성이 올바르게 설치되었는지 확인하세요

## 라이선스

ISC License