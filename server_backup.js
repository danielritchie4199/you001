const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const axios = require('axios');
const XLSX = require('xlsx');
const { Client } = require('@elastic/elasticsearch');
require('dotenv').config();

// Elasticsearch 클라이언트 설정
let esClient = null;
try {
  esClient = new Client({ node: process.env.ES_NODE || 'http://localhost:9200' });
  console.log('Elasticsearch 클라이언트 초기화 완료');
} catch (error) {
  console.warn('Elasticsearch 연결 실패, YouTube API만 사용:', error.message);
  esClient = null;
}

// 다중 API 키 관리 시스템
class ApiKeyManager {
  constructor() {
    // 환경변수에서 여러 API 키 수집
    this.apiKeys = [];
    this.currentKeyIndex = 0;
    this.keyUsageCount = {};
    this.keyQuotaExceeded = {};
    this.statusFile = path.join(__dirname, 'api_key_status.json');
    
    // API 키들을 환경변수에서 수집
    const maxKeys = parseInt(process.env.MAX_API_KEYS) || 10;
    console.log(`🔑 최대 API 키 개수: ${maxKeys}개`);
    
    for (let i = 1; i <= maxKeys; i++) {
      const key = process.env[`YOUTUBE_API_KEY_${i}`] || (i === 1 ? process.env.YOUTUBE_API_KEY : null);
      if (key && key !== 'your_primary_api_key_here' && key !== 'your_secondary_api_key_here' && key !== 'your_tertiary_api_key_here') {
        this.apiKeys.push({
          key: key,
          index: i,
          name: `API_KEY_${i}`,
          usageCount: 0,
          quotaExceeded: false,
          lastUsed: null,
          consecutiveErrors: 0  // 연속 오류 횟수 추가
        });
        this.keyUsageCount[i] = 0;
        this.keyQuotaExceeded[i] = false;
      }
    }
    
    if (this.apiKeys.length === 0) {
      console.error('❌ YouTube API 키가 설정되지 않았습니다!');
      console.log('📝 .env 파일에 다음과 같이 설정하세요:');
      console.log('YOUTUBE_API_KEY_1=your_first_api_key_here');
      console.log('YOUTUBE_API_KEY_2=your_second_api_key_here');
      console.log('YOUTUBE_API_KEY_3=your_third_api_key_here');
      process.exit(1);
    }
    
    console.log(`✅ ${this.apiKeys.length}개의 YouTube API 키가 설정되었습니다.`);
    this.apiKeys.forEach((keyInfo, index) => {
      console.log(`   ${index + 1}. ${keyInfo.name} (***${keyInfo.key.slice(-4)})`);
    });
    
    // 저장된 상태 로드
    this.loadKeyStatus();
  }
  
  // 현재 사용 가능한 API 키 반환 - 개선된 로직
  getCurrentKey() {
    // 할당량 초과되지 않은 키 찾기 (연속 오류가 많지 않은 키 우선)
    let availableKeys = this.apiKeys.filter(keyInfo => 
      !keyInfo.quotaExceeded && keyInfo.consecutiveErrors < 3
    );
    
    // 사용 가능한 키가 없으면 연속 오류 조건을 완화
    if (availableKeys.length === 0) {
      availableKeys = this.apiKeys.filter(keyInfo => !keyInfo.quotaExceeded);
    }
    
    if (availableKeys.length === 0) {
      console.log('⚠️ 모든 API 키의 할당량이 초과되었습니다. 다음 날까지 대기해야 합니다.');
      return null;
    }
    
    // 사용 횟수가 가장 적은 키를 선택
    availableKeys.sort((a, b) => a.usageCount - b.usageCount);
    const selectedKey = availableKeys[0];
    
    // 현재 인덱스 업데이트
    this.currentKeyIndex = selectedKey.index - 1;
    console.log(`🔑 선택된 API 키: ${selectedKey.name} (사용횟수: ${selectedKey.usageCount}, 연속오류: ${selectedKey.consecutiveErrors})`);
    
    return selectedKey;
  }
  
  // 현재 YouTube API 인스턴스 반환
  getYouTubeInstance() {
    const currentKey = this.getCurrentKey();
    if (!currentKey) {
      throw new Error('NO_AVAILABLE_KEYS: 사용 가능한 API 키가 없습니다.');
    }
    
    currentKey.usageCount++;
    currentKey.lastUsed = new Date();
    
    console.log(`🔑 사용 중인 API 키: ${currentKey.name} (사용횟수: ${currentKey.usageCount})`);
    
    // 사용량 변경 저장 (주기적으로)
    if (currentKey.usageCount % 5 === 0) {
      this.saveKeyStatus();
    }
    
    return google.youtube({ version: 'v3', auth: currentKey.key });
  }
  
  // 할당량 초과 처리 - 개선된 로직
  markKeyAsQuotaExceeded(currentKey, errorMessage = '') {
    if (!currentKey) return null;
    
    console.log(`❌ ${currentKey.name} 오류 발생: ${errorMessage}`);
    
    // 할당량 관련 오류인지 확인
    if (errorMessage.includes('quota') || errorMessage.includes('quotaExceeded') || 
        errorMessage.includes('dailyLimitExceeded') || errorMessage.includes('rateLimitExceeded')) {
      currentKey.quotaExceeded = true;
      console.log(`🚫 ${currentKey.name} 할당량 초과로 비활성화됨`);
    } else {
      // 다른 오류의 경우 연속 오류 횟수 증가
      currentKey.consecutiveErrors++;
      console.log(`⚠️ ${currentKey.name} 연속 오류 횟수: ${currentKey.consecutiveErrors}`);
      
      // 연속 오류가 3회 이상이면 임시 비활성화
      if (currentKey.consecutiveErrors >= 3) {
        console.log(`🔒 ${currentKey.name} 연속 오류로 임시 비활성화 (할당량 초과는 아님)`);
      }
    }
    
    // 상태 변경 저장
    this.saveKeyStatus();
    
    // 다음 사용 가능한 키 찾기
    const nextKey = this.getCurrentKey();
    
    if (nextKey) {
      console.log(`🔄 ${nextKey.name}으로 전환합니다.`);
      return nextKey;
    } else {
      console.log('⚠️ 사용 가능한 API 키가 없습니다.');
      return null;
    }
  }
  
  // API 호출 성공 시 연속 오류 카운터 리셋
  markKeyAsSuccessful(currentKey) {
    if (currentKey && currentKey.consecutiveErrors > 0) {
      console.log(`✅ ${currentKey.name} 성공, 연속 오류 카운터 리셋`);
      currentKey.consecutiveErrors = 0;
      this.saveKeyStatus();
    }
  }
  
  // 사용 가능한 키가 있는지 확인
  hasAvailableKeys() {
    return this.apiKeys.some(keyInfo => !keyInfo.quotaExceeded);
  }
  
  // 할당량 초과 처리를 포함한 안전한 YouTube 인스턴스 반환
  async getYouTubeInstanceSafely() {
    const maxRetries = this.apiKeys.length;
    let currentRetry = 0;
    
    while (currentRetry < maxRetries) {
      const currentKey = this.getCurrentKey();
      
      if (!currentKey || currentKey.quotaExceeded) {
        console.log('사용 가능한 API 키가 없음');
        return null;
      }
      
      currentKey.usageCount++;
      currentKey.lastUsed = new Date();
      console.log(`🔑 사용 중인 API 키: ${currentKey.name} (사용횟수: ${currentKey.usageCount})`);
      
      const youtube = google.youtube({ version: 'v3', auth: currentKey.key });
      return { youtube, currentKey };
    }
    
    return null;
  }
  
  // 상태 파일에서 API 키 상태 로드
  loadKeyStatus() {
    try {
      if (fs.existsSync(this.statusFile)) {
        const status = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
        const today = new Date().toDateString();
        
        // 당일이 아니면 상태 리셋 (일일 할당량 갱신)
        if (status.date !== today) {
          console.log(`📅 날짜 변경 감지 (${status.date} → ${today}), API 키 상태 리셋`);
          this.resetDailyStatus();
        } else {
          console.log(`🔄 저장된 API 키 상태 로드 (${status.date})`);
          this.restoreKeyStatus(status);
        }
      } else {
        console.log(`📝 API 키 상태 파일이 없음, 새로 생성`);
        this.saveKeyStatus();
      }
    } catch (error) {
      console.error('⚠️ 상태 파일 로드 실패:', error.message);
      console.log('💡 기본 상태로 진행합니다.');
    }
  }
  
  // 저장된 상태를 API 키에 복원
  restoreKeyStatus(status) {
    status.keys.forEach(savedKey => {
      const apiKey = this.apiKeys.find(key => key.index === savedKey.index);
      if (apiKey) {
        apiKey.quotaExceeded = savedKey.quotaExceeded;
        apiKey.usageCount = savedKey.usageCount;
        apiKey.consecutiveErrors = savedKey.consecutiveErrors || 0;
        if (savedKey.lastUsed) {
          apiKey.lastUsed = new Date(savedKey.lastUsed);
        }
        
        // 레거시 추적 객체도 업데이트
        this.keyUsageCount[apiKey.index] = apiKey.usageCount;
        this.keyQuotaExceeded[apiKey.index] = apiKey.quotaExceeded;
      }
    });
    
    const exceededCount = this.apiKeys.filter(key => key.quotaExceeded).length;
    const availableCount = this.apiKeys.length - exceededCount;
    console.log(`📊 상태 복원 완료: ${availableCount}/${this.apiKeys.length} 키 사용 가능`);
  }
  
  // 일일 상태 리셋
  resetDailyStatus() {
    this.apiKeys.forEach(key => {
      key.quotaExceeded = false;
      key.consecutiveErrors = 0;
      // usageCount와 lastUsed는 유지 (통계 목적)
    });
    this.saveKeyStatus();
    console.log(`🔄 모든 API 키 상태가 리셋되었습니다.`);
  }
  
  // 현재 상태를 파일에 저장
  saveKeyStatus() {
    try {
      const status = {
        date: new Date().toDateString(),
        lastUpdated: new Date().toISOString(),
        keys: this.apiKeys.map(key => ({
          index: key.index,
          name: key.name,
          quotaExceeded: key.quotaExceeded,
          usageCount: key.usageCount,
          consecutiveErrors: key.consecutiveErrors,
          lastUsed: key.lastUsed ? key.lastUsed.toISOString() : null
        }))
      };
      
      fs.writeFileSync(this.statusFile, JSON.stringify(status, null, 2), 'utf8');
      console.log(`💾 API 키 상태 저장 완료: ${this.statusFile}`);
    } catch (error) {
      console.error('⚠️ 상태 파일 저장 실패:', error.message);
    }
  }
  
  // 사용 통계 출력
  printUsageStats() {
    console.log('\n📊 API 키 사용 통계:');
    this.apiKeys.forEach(keyInfo => {
      const status = keyInfo.quotaExceeded ? '❌ 할당량 초과' : '✅ 사용 가능';
      const lastUsed = keyInfo.lastUsed ? keyInfo.lastUsed.toLocaleString() : '미사용';
      const currentIndicator = keyInfo.index === this.currentKeyIndex + 1 ? ' 🔑 현재' : '';
      const quotaInfo = keyInfo.quotaExceeded ? ' (할당량 초과)' : '';
      console.log(`   ${keyInfo.name}: ${status} | 사용횟수: ${keyInfo.usageCount} | 마지막 사용: ${lastUsed}${currentIndicator}${quotaInfo}`);
    });
    
    const availableKeys = this.apiKeys.filter(key => !key.quotaExceeded);
    const exhaustedKeys = this.apiKeys.filter(key => key.quotaExceeded);
    
    console.log(`\n📈 요약: ${availableKeys.length}/${this.apiKeys.length} 키 사용 가능`);
    if (exhaustedKeys.length > 0) {
      console.log(`   할당량 초과된 키: ${exhaustedKeys.map(k => k.name).join(', ')}`);
    }
    if (availableKeys.length > 0) {
      console.log(`   사용 가능한 키: ${availableKeys.map(k => k.name).join(', ')}`);
    }
    
    // 현재 활성 키 정보
    const currentKey = this.apiKeys[this.currentKeyIndex];
    if (currentKey) {
      console.log(`\n🔑 현재 활성 키: ${currentKey.name} (${currentKey.quotaExceeded ? '할당량 초과' : '정상'})`);
    }
  }
}

// API 키 매니저 인스턴스 생성
const apiKeyManager = new ApiKeyManager();

// Elasticsearch 헬퍼 함수들
class ElasticsearchHelper {
  constructor(client) {
    this.client = client;
    this.indexName = process.env.ES_INDEX_VIDEOS || 'videos';
    this.ttlHours = parseInt(process.env.ES_TTL_HOURS) || 48;
  }

  // 캐시 히트 판단
  async checkCacheHit(searchParams) {
    if (!this.client) return { hit: false, reason: 'ES client not available' };
    
    try {
      const { country, keyword, minViews, maxViews, maxResults } = searchParams;
      
      // 검색 조건 구성
      const mustQueries = [];
      const filterQueries = [];
      
      if (country && country !== 'worldwide') {
        mustQueries.push({ term: { country } });
      }
      
      if (keyword && keyword.trim()) {
        mustQueries.push({ term: { keyword_normalized: keyword.toLowerCase() } });
      }
      
      if (minViews) {
        filterQueries.push({ range: { daily_view_count: { gte: parseInt(minViews) } } });
      }
      
      if (maxViews) {
        filterQueries.push({ range: { daily_view_count: { lte: parseInt(maxViews) } } });
      }
      
      // 캐시된 데이터 수량 확인
      const countQuery = {
        query: {
          bool: {
            must: mustQueries,
            filter: filterQueries
          }
        }
      };
      
      const countResponse = await this.client.count({
        index: this.indexName,
        body: countQuery
      });
      
      const availableCount = countResponse.body.count;
      const requestedCount = parseInt(maxResults) || 60;
      
      // 신선도 확인
      const freshnessQuery = {
        query: { bool: { must: mustQueries, filter: filterQueries } },
        sort: [{ indexed_at: 'desc' }],
        size: 1,
        _source: ['indexed_at']
      };
      
      const freshnessResponse = await this.client.search({
        index: this.indexName,
        body: freshnessQuery
      });
      
      const hits = freshnessResponse.body.hits.hits;
      let isFresh = false;
      
      if (hits.length > 0) {
        const lastIndexed = new Date(hits[0]._source.indexed_at);
        const ttlLimit = new Date(Date.now() - this.ttlHours * 60 * 60 * 1000);
        isFresh = lastIndexed > ttlLimit;
      }
      
      const cacheHit = availableCount >= requestedCount && isFresh;
      
      return {
        hit: cacheHit,
        availableCount,
        requestedCount,
        isFresh,
        reason: cacheHit ? 'Cache hit' : `Insufficient data (${availableCount}/${requestedCount}) or stale data (fresh: ${isFresh})`
      };
      
    } catch (error) {
      console.error('Cache hit check error:', error);
      return { hit: false, reason: 'Cache check failed', error: error.message };
    }
  }
  
  // ES에서 검색 결과 조회
  async searchVideos(searchParams) {
    if (!this.client) return null;
    
    try {
      const { country, keyword, minViews, maxViews, maxResults } = searchParams;
      
      // 검색 조건 구성
      const mustQueries = [];
      const filterQueries = [];
      
      if (country && country !== 'worldwide') {
        mustQueries.push({ term: { country } });
      }
      
      if (keyword && keyword.trim()) {
        mustQueries.push({ term: { keyword_normalized: keyword.toLowerCase() } });
      }
      
      if (minViews) {
        filterQueries.push({ range: { daily_view_count: { gte: parseInt(minViews) } } });
      }
      
      if (maxViews) {
        filterQueries.push({ range: { daily_view_count: { lte: parseInt(maxViews) } } });
      }
      
      const searchQuery = {
        query: {
          bool: {
            must: mustQueries,
            filter: filterQueries
          }
        },
        sort: [{ daily_view_count: 'desc' }],
        size: parseInt(maxResults) || 60
      };
      
      const response = await this.client.search({
        index: this.indexName,
        body: searchQuery
      });
      
      // ES 결과를 API 응답 형식으로 변환
      const results = response.body.hits.hits.map(hit => ({
        youtube_channel_name: hit._source.youtube_channel_name,
        thumbnail_url: hit._source.thumbnail_url,
        status: hit._source.status || 'active',
        youtube_channel_id: hit._source.youtube_channel_id,
        primary_category: hit._source.primary_category,
        status_date: hit._source.status_date,
        daily_view_count: hit._source.daily_view_count,
        subscriber_count: hit._source.subscriber_count,
        vod_url: hit._source.vod_url,
        video_id: hit._source.video_id,
        title: hit._source.title,
        description: hit._source.description,
        duration: hit._source.duration,
        duration_seconds: hit._source.duration_seconds,
        video_length_category: hit._source.video_length_category
      }));
      
      return results;
      
    } catch (error) {
      console.error('ES search error:', error);
      return null;
    }
  }
  
  // YouTube API 결과를 ES에 bulk upsert
  async bulkUpsertVideos(videos, searchParams) {
    if (!this.client || !videos || videos.length === 0) return;
    
    try {
      const body = [];
      const indexedAt = new Date().toISOString();
      
      videos.forEach(video => {
        // upsert를 위한 update 액션
        body.push({
          update: {
            _index: this.indexName,
            _id: video.video_id
          }
        });
        
        // 문서 내용
        body.push({
          doc: {
            video_id: video.video_id,
            title: video.title,
            youtube_channel_name: video.youtube_channel_name,
            youtube_channel_id: video.youtube_channel_id,
            country: searchParams.country || 'unknown',
            status_date: video.status_date,
            daily_view_count: parseInt(video.daily_view_count) || 0,
            subscriber_count: parseInt(video.subscriber_count) || 0,
            duration_seconds: parseInt(video.duration_seconds) || 0,
            video_length_category: video.video_length_category,
            primary_category: video.primary_category,
            vod_url: video.vod_url,
            thumbnail_url: video.thumbnail_url,
            status: video.status || 'active',
            description: video.description || '',
            duration: video.duration || '',
            keyword_normalized: (searchParams.keyword || '').toLowerCase(),
            indexed_at: indexedAt
          },
          doc_as_upsert: true
        });
      });
      
              const response = await this.client.bulk({ body });
        
        // 응답 구조 검증 및 안전한 오류 처리
        if (response && response.body && response.body.errors) {
          console.error('ES bulk upsert errors:', response.body.items.filter(item => item.update && item.update.error));
        } else if (response && response.errors) {
          // 새로운 버전의 클라이언트 응답 구조
          console.error('ES bulk upsert errors:', response.items.filter(item => item.update && item.update.error));
        } else {
          console.log(`ES bulk upsert 성공: ${videos.length}개 비디오 인덱싱`);
        }
      
    } catch (error) {
      console.error('ES bulk upsert error:', error);
    }
  }
}

// ES 헬퍼 인스턴스 생성
const esHelper = new ElasticsearchHelper(esClient);

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors());
// 대용량 데이터 처리를 위한 body-parser 제한 증가
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

// 메인 페이지 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'you_list.html'));
});

// YouTube 동영상 검색 API
app.get('/api/search', async (req, res) => {
  const searchStartTime = Date.now(); // 검색 시작 시간 기록
  
  try {
    const {
      country = 'worldwide',  // 기본값을 전세계로 변경
      keyword = '',
      maxViews,
      minViews = 100000,
      uploadPeriod,
      startDate,
      endDate,
      videoLength,
      maxResults = 60,   // 기본값 60건
      uploadTimePreset,   // 시간대 프리셋 추가
      timeStart,          // 커스텀 시간 시작
      timeEnd,            // 커스텀 시간 끝
      timezone = 'KST'    // 시간대 (기본값: 한국)
    } = req.query;

    // maxResults 유효성 검사 및 변환
    const allowedResults = [10, 20, 30, 40, 50, 60, 100, 150, 200];
    const parsedMaxResults = parseInt(maxResults);
    const finalMaxResults = allowedResults.includes(parsedMaxResults) ? parsedMaxResults : 60;

    console.log('검색 파라미터:', req.query);
    console.log('선택된 국가:', country);
    console.log(`검색 결과 수: ${finalMaxResults}건 (요청: ${maxResults})`);

    // 동영상 길이 파라미터 파싱
    const selectedVideoLengths = videoLength && videoLength.trim() ? videoLength.split(',').filter(v => v.trim()) : [];
    console.log('선택된 동영상 길이:', selectedVideoLengths.length > 0 ? selectedVideoLengths : '모든 길이 허용 (필터 없음)');

    // ========== Elasticsearch 캐시 우선 로직 시작 ==========
    const searchParameters = {
      country,
      keyword,
      minViews,
      maxViews,
      uploadPeriod,
      startDate,
      endDate,
      videoLength,
      maxResults: finalMaxResults
    };
    
    // 1단계: 캐시 히트 확인
    console.log('🔍 Elasticsearch 캐시 확인 중...');
    const cacheResult = await esHelper.checkCacheHit(searchParameters);
    console.log('📊 캐시 확인 결과:', cacheResult);
    
    if (cacheResult.hit) {
      // 캐시 히트: ES에서 결과 조회
      console.log('✅ 캐시 히트! Elasticsearch에서 결과 조회');
      const cachedResults = await esHelper.searchVideos(searchParameters);
      
      if (cachedResults && cachedResults.length > 0) {
        console.log(`📦 캐시에서 ${cachedResults.length}개 결과 반환`);
        
        // 캐시 검색 소요시간 계산
        const cacheEndTime = Date.now();
        const cacheDuration = cacheEndTime - searchStartTime;
        const cacheDurationSeconds = (cacheDuration / 1000).toFixed(2);
        
        console.log(`\n⏱️ 캐시 검색 완료: 총 소요시간 ${cacheDurationSeconds}초 (${cachedResults.length}개 결과)`);
        console.log(`🔍 검색 조건: ${country}/${keyword || '키워드 없음'}/${finalMaxResults}건`);
        console.log('⚡ 캐시 히트로 초고속 검색!');
        console.log('='.repeat(52));
        
        return res.json({
          success: true,
          data: cachedResults,
          total: cachedResults.length,
          source: 'elasticsearch_cache',
          searchDuration: `${cacheDurationSeconds}초`
        });
      } else {
        console.log('⚠️ 캐시 히트였지만 결과가 없음, YouTube API로 fallback');
      }
    } else {
      console.log('❌ 캐시 미스:', cacheResult.reason);
      console.log('🔄 YouTube API 호출로 진행');
    }
    // ========== Elasticsearch 캐시 우선 로직 끝 ==========

    let searchResults = [];
    let nextPageToken = '';
    const resultsPerPage = Math.min(finalMaxResults, 50); // 선택한 결과 수에 따라 페이지당 요청량 조정

    // YouTube API 검색 파라미터 설정
    let searchParams = {
      part: 'snippet',
      type: 'video',
      maxResults: resultsPerPage,
      order: 'viewCount'
    };

    // 국가별 지역 코드 설정 (전세계가 아닌 경우에만)
    if (country !== 'worldwide') {
      const regionCode = getCountryCode(country);
      if (regionCode) {
        searchParams.regionCode = regionCode;
        console.log(`✅ 지역 코드 설정: ${country} → ${regionCode}`);
      } else {
        console.log(`⚠️ 경고: '${country}' 국가의 regionCode를 찾을 수 없어 전세계 검색으로 진행합니다.`);
        // regionCode가 null인 경우 명시적으로 제거
        delete searchParams.regionCode;
      }
    } else {
      console.log('🌍 전세계 검색: regionCode 없이 진행');
      // 전세계 검색 시 regionCode 명시적으로 제거
      delete searchParams.regionCode;
    }

    // 언어 설정 (국가별 기본 언어)
    const languageCode = getLanguageCode(country);
    if (languageCode) {
      searchParams.relevanceLanguage = languageCode;
      console.log(`🌐 언어 설정: ${country} → ${languageCode}`);
    }

    // 키워드 설정
    const isEmptyKeyword = !keyword || !keyword.trim();
    
    if (!isEmptyKeyword) {
      searchParams.q = keyword.trim();
      console.log(`키워드 검색: "${keyword.trim()}"`);
    } else {
      // 키워드가 없을 때는 국가별 인기 동영상 검색
      console.log('키워드 없음: 국가별 인기 동영상 검색');
      
      if (country !== 'worldwide') {
        // 특정 국가 선택 시: 해당 국가의 인기 콘텐츠 검색
        console.log(`🏳️ ${country} 국가의 인기 동영상 검색`);
        
        // 국가별 인기 검색어 사용 (더 정확한 지역별 결과)
        const countrySpecificTerms = {
          'korea': ['한국', 'korean', 'korea', '한국어'],
          'usa': ['america', 'usa', 'american', 'english'],
          'japan': ['japan', 'japanese', '일본', '일본어'],
          'uk': ['britain', 'uk', 'british', 'english'],
          'germany': ['germany', 'german', 'deutsch', '독일'],
          'france': ['france', 'french', 'français', '프랑스'],
          'canada': ['canada', 'canadian', 'english', 'french'],
          'australia': ['australia', 'australian', 'english'],
          'india': ['india', 'indian', 'hindi', 'english'],
          'brazil': ['brazil', 'brazilian', 'portuguese', 'português'],
          'mexico': ['mexico', 'mexican', 'spanish', 'español'],
          'italy': ['italy', 'italian', 'italiano', '이탈리아'],
          'spain': ['spain', 'spanish', 'español', '스페인']
        };
        
        const terms = countrySpecificTerms[country] || ['video', 'popular'];
        const randomTerm = terms[Math.floor(Math.random() * terms.length)];
        searchParams.q = randomTerm;
        
        // 국가별 검색을 위해 order를 relevance로 설정 (regionCode와 relevanceLanguage가 우선 적용됨)
        searchParams.order = 'relevance';
        
        console.log(`🌍 ${country} 국가별 인기 검색어: "${randomTerm}"`);
        console.log('설정: 관련성 순서로 정렬 (국가별 우선)');
      } else {
        // 전세계 선택 시: 일반적인 인기 동영상 검색
        console.log('🌍 전세계 인기 동영상 검색');
        
        const broadSearchTerms = ['a', 'the', 'and', 'or', 'video', 'youtube'];
        const randomTerm = broadSearchTerms[Math.floor(Math.random() * broadSearchTerms.length)];
        searchParams.q = randomTerm;
        
        // 전세계 검색 시에만 조회수 순 정렬
        searchParams.order = 'viewCount';
        
        console.log(`전세계 인기 동영상 검색어: "${randomTerm}"`);
        console.log('설정: 조회수 높은 순서로 정렬');
      }
    }

    // 디버그 로그 출력 (키워드 설정 후)
    console.log('=== 국가별 검색 디버그 정보 ===');
    console.log('1. 클라이언트 요청 country:', country);
    console.log('2. getCountryCode 결과:', getCountryCode(country));
    console.log('3. getLanguageCode 결과:', getLanguageCode(country));
    console.log('4. 키워드 상태:', keyword ? `"${keyword}"` : '없음 (국가별 인기 검색)');
    console.log('5. 검색 전략:', keyword ? '키워드 기반 검색' : (country === 'worldwide' ? '전세계 인기 검색' : `${country} 국가별 인기 검색`));
    console.log('6. 최종 YouTube API 검색 파라미터:', {
      regionCode: searchParams.regionCode || '없음 (전세계 검색)',
      relevanceLanguage: searchParams.relevanceLanguage,
      country: country,
      keyword: searchParams.q || '키워드 없음',
      order: searchParams.order,
      type: searchParams.type,
      isWorldwide: country === 'worldwide'
    });
    console.log('7. 검색 타입:', country === 'worldwide' ? '🌍 전세계 검색' : `🏳️ ${country} 국가별 검색`);
    console.log('========================================');

    // 업로드 기간 설정 (기존 드롭다운 방식)
    if (uploadPeriod) {
      const { publishedAfter, publishedBefore } = getDateRange(uploadPeriod);
      if (publishedAfter) searchParams.publishedAfter = publishedAfter;
      if (publishedBefore) searchParams.publishedBefore = publishedBefore;
    }

    // 커스텀 날짜 범위 설정 (startDate, endDate가 있으면 uploadPeriod보다 우선)
    if (startDate || endDate) {
      if (startDate) {
        try {
          const startDateTime = new Date(startDate + 'T00:00:00');
          if (isNaN(startDateTime.getTime())) {
            throw new Error('Invalid start date');
          }
          searchParams.publishedAfter = startDateTime.toISOString();
          console.log('✅ 시작일 설정 성공:', startDateTime.toISOString());
        } catch (error) {
          console.error('❌ 시작일 처리 오류:', error.message, '입력값:', startDate);
          // 오류 시 시작일 무시하고 계속 진행
        }
      }
      if (endDate) {
        try {
          const endDateTime = new Date(endDate + 'T23:59:59');
          if (isNaN(endDateTime.getTime())) {
            throw new Error('Invalid end date');
          }
          searchParams.publishedBefore = endDateTime.toISOString();
          console.log('✅ 종료일 설정 성공:', endDateTime.toISOString());
        } catch (error) {
          console.error('❌ 종료일 처리 오류:', error.message, '입력값:', endDate);
          // 오류 시 종료일 무시하고 계속 진행
        }
      }
      console.log('📅 커스텀 날짜 범위 적용:', {
        startDate: startDate || '없음',
        endDate: endDate || '없음',
        publishedAfter: searchParams.publishedAfter || '없음',
        publishedBefore: searchParams.publishedBefore || '없음'
      });
    }

    // 동영상 길이 설정 (YouTube API는 'short', 'medium', 'long'만 지원하므로 후처리에서 필터링)
    // videoLength 파라미터는 클라이언트에서 받아서 결과 필터링에 사용

         // 선택한 수만큼 결과 수집 (중복 제거)
     const processedVideoIds = new Set(); // 이미 처리된 비디오 ID 추적
     const processedChannelTitles = new Set(); // 이미 처리된 채널명 추적 (선택적)
     
     while (searchResults.length < finalMaxResults) {
       if (nextPageToken) {
         searchParams.pageToken = nextPageToken;
       }

       let response;
       let currentApiKey = apiKeyManager.getCurrentKey();
       
       // 견고한 API 키 전환 로직으로 재작성
       let retryCount = 0;
       const maxRetries = apiKeyManager.apiKeys.length;
       
       while (retryCount < maxRetries) {
         try {
           currentApiKey = apiKeyManager.getCurrentKey();
           const youtube = google.youtube({ version: 'v3', auth: currentApiKey.key });
           response = await youtube.search.list(searchParams);
           break; // 성공하면 루프 종료
         } catch (apiError) {
           console.error(`YouTube API 오류 (${currentApiKey.name}):`, apiError.message);
           
           // 할당량 초과 오류인 경우 다음 키로 전환
           if (apiError.message.includes('quota') || apiError.message.includes('quotaExceeded')) {
             console.log(`🚫 ${currentApiKey.name} 할당량 초과 감지`);
             
             const newApiKey = apiKeyManager.markKeyAsQuotaExceeded(currentApiKey);
             if (newApiKey) {
               console.log(`🔄 ${newApiKey.name}로 재시도합니다... (재시도 ${retryCount + 1}/${maxRetries})`);
               retryCount++;
               continue; // 다음 반복으로 계속
             } else {
               console.log('❌ 모든 API 키의 할당량이 초과되었습니다.');
               throw new Error('ALL_QUOTA_EXCEEDED: 모든 API 키의 할당량이 초과되었습니다.');
             }
           }
           // regionCode 관련 오류인 경우 처리
           else if ((apiError.message.includes('regionCode') || apiError.message.includes('invalid region')) && searchParams.regionCode) {
          console.log('🚨 regionCode 오류 발생!');
          console.log(`  - 요청한 국가: ${country}`);
          console.log(`  - 사용한 regionCode: ${searchParams.regionCode}`);
          console.log(`  - 오류 메시지: ${apiError.message}`);
          
          // regionCode가 유효한지 다시 확인
          const validRegionCodes = [
            'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT',
            'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI',
            'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY',
            'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
            'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
            'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK',
            'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
            'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
            'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR',
            'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
            'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS',
            'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
            'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW',
            'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
            'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
            'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
            'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM',
            'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF',
            'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW',
            'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
            'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
          ];
          
          if (validRegionCodes.includes(searchParams.regionCode)) {
            console.log('  ❌ regionCode는 유효하지만 YouTube에서 거부됨');
            console.log('  💡 이 국가는 YouTube 서비스 제한이 있을 수 있습니다.');
          } else {
            console.log('  ❌ regionCode가 유효하지 않음');
          }
          
          console.log('  🔄 전세계 검색으로 재시도합니다...');
          const originalRegionCode = searchParams.regionCode;
          delete searchParams.regionCode;
          
          console.log('  재시도 파라미터:', {
            regionCode: '제거됨',
            relevanceLanguage: searchParams.relevanceLanguage,
            country: country,
            originalRegionCode: originalRegionCode
          });
          
             const youtube = google.youtube({ version: 'v3', auth: currentApiKey.key });
             response = await youtube.search.list(searchParams);
             console.log('  ✅ 전세계 검색으로 성공');
             console.log(`  ⚠️  주의: "${country}" 검색이 전세계 검색으로 변경되었습니다.`);
             break; // 성공하면 루프 종료
           } else {
             console.log('복구할 수 없는 API 오류:', apiError.message);
             throw apiError; // 다른 오류는 그대로 전파
           }
         }
       }
       
       // 최대 재시도 횟수 초과 시
       if (retryCount >= maxRetries && !response) {
         throw new Error('MAX_RETRIES_EXCEEDED: 모든 API 키 재시도 실패');
       }
      
      if (!response.data.items || response.data.items.length === 0) {
        break;
      }
      
      console.log(`API 응답: ${response.data.items.length}개 동영상 발견`);

      // 비디오 ID 수집
      const videoIds = response.data.items.map(item => item.id.videoId);
      
      // 비디오 상세 정보 가져오기 (조회수, 통계 포함) - 견고한 API 키 전환 로직
      let videoDetails;
      let detailRetryCount = 0;
      const detailMaxRetries = apiKeyManager.apiKeys.length;
      
      while (detailRetryCount < detailMaxRetries) {
        try {
          const currentDetailKey = apiKeyManager.getCurrentKey();
          const youtube = google.youtube({ version: 'v3', auth: currentDetailKey.key });
          videoDetails = await youtube.videos.list({
            part: 'snippet,statistics,contentDetails',
            id: videoIds.join(',')
          });
          break; // 성공하면 루프 종료
        } catch (detailError) {
          console.error(`비디오 상세정보 조회 오류:`, detailError.message);
          
          if (detailError.message.includes('quota') || detailError.message.includes('quotaExceeded')) {
            console.log('🚫 비디오 상세정보 조회 중 할당량 초과 감지');
            
            const currentDetailKey = apiKeyManager.getCurrentKey();
            const newDetailKey = apiKeyManager.markKeyAsQuotaExceeded(currentDetailKey);
            if (newDetailKey) {
              console.log(`🔄 ${newDetailKey.name}로 비디오 상세정보 재시도... (재시도 ${detailRetryCount + 1}/${detailMaxRetries})`);
              detailRetryCount++;
              continue; // 다음 반복으로 계속
            } else {
              console.log('❌ 모든 API 키의 할당량이 초과되었습니다.');
              throw new Error('ALL_QUOTA_EXCEEDED: 모든 API 키의 할당량이 초과되었습니다.');
            }
          } else {
            throw detailError;
          }
        }
      }
      
      // 최대 재시도 횟수 초과 시
      if (detailRetryCount >= detailMaxRetries && !videoDetails) {
        throw new Error('MAX_RETRIES_EXCEEDED: 비디오 상세정보 조회 실패');
      }

             // 검색 결과 처리 (중복 제거)
       for (const video of videoDetails.data.items) {
         // 중복 비디오 ID 체크
         if (processedVideoIds.has(video.id)) {
           console.log(`🔄 중복 동영상 건너뛰기: ${video.id} - ${video.snippet.title}`);
           continue;
         }
         
         const viewCount = parseInt(video.statistics.viewCount || 0);
         
         // 조회수 필터링
         if (minViews && viewCount < parseInt(minViews)) continue;
         if (maxViews && viewCount > parseInt(maxViews)) continue;

         // 동영상 길이 필터링
         const durationInSeconds = parseDuration(video.contentDetails.duration);
         const videoLengthCategory = getVideoLengthCategory(durationInSeconds);
         
         if (!matchesVideoLength(videoLengthCategory, selectedVideoLengths)) continue;

                 // 채널 구독자 수 정보 가져오기
        const subscriberCount = await getChannelSubscriberCount(video.snippet.channelId);

        const result = {
          youtube_channel_name: video.snippet.channelTitle,
          thumbnail_url: video.snippet.thumbnails.maxres?.url || 
                        video.snippet.thumbnails.standard?.url || 
                        video.snippet.thumbnails.high?.url || 
                        video.snippet.thumbnails.medium?.url || 
                        video.snippet.thumbnails.default?.url,
          status: 'active',
          youtube_channel_id: video.snippet.channelId,
          primary_category: await getCategoryName(video.snippet.categoryId),
          status_date: video.snippet.publishedAt,
          daily_view_count: viewCount,
          subscriber_count: subscriberCount,
          vod_url: `https://www.youtube.com/watch?v=${video.id}`,
          video_id: video.id,
          title: video.snippet.title,
          description: video.snippet.description,
          duration: video.contentDetails.duration,
          duration_seconds: durationInSeconds,
          video_length_category: videoLengthCategory
        };

         // 중복 제거 후 결과 추가
         searchResults.push(result);
         processedVideoIds.add(video.id); // 처리된 ID 기록
         
         if (searchResults.length >= finalMaxResults) break;
       }

      nextPageToken = response.data.nextPageToken;
      if (!nextPageToken) break;

      // API 호출 제한을 위한 지연 (quota 절약)
      await new Promise(resolve => setTimeout(resolve, 500));
    }

         // 조회수 기준 내림차순 정렬
     searchResults.sort((a, b) => b.daily_view_count - a.daily_view_count);

     // 🕐 시간대 필터 적용
     const timeFilter = parseTimeFilterFromQuery(req.query);
     if (timeFilter) {
       console.log('🕐 시간대 필터 적용 중...');
       const originalCount = searchResults.length;
       searchResults = applyTimeFilter(searchResults, timeFilter);
       logTimeFilterStats(originalCount, searchResults.length, timeFilter);
     } else {
       console.log('🕐 시간대 필터 없음 - 모든 시간대의 영상 포함');
     }

     // 중복 제거 통계
     const totalProcessed = processedVideoIds.size + searchResults.length;
     const duplicatesRemoved = totalProcessed - searchResults.length;
     
     console.log(`검색 완료: ${searchResults.length}개 결과`);
     console.log(`🔄 중복 제거: ${duplicatesRemoved}개 중복 동영상 제거됨`);
     console.log(`📊 API 사용량: 검색 API ${Math.ceil(searchResults.length / 50)}회 + 상세정보 API ${Math.ceil(searchResults.length / 50)}회 (${finalMaxResults}건 요청 중 ${searchResults.length}건 결과)`);
     
     // API 키 사용 통계 출력
     apiKeyManager.printUsageStats();

     // ========== YouTube API 결과를 Elasticsearch에 인덱싱 ==========
     if (searchResults.length > 0) {
     console.log('📝 YouTube API 결과를 Elasticsearch에 인덱싱 중...');
     try {
     await esHelper.bulkUpsertVideos(searchResults, searchParameters);
     console.log('✅ Elasticsearch 인덱싱 완료');
     } catch (esError) {
     console.error('⚠️ Elasticsearch 인덱싱 실패:', esError.message);
     console.log('💡 YouTube API 결과는 정상 반환하지만 캐시 저장은 실패했습니다.');
     }
     }
     // ========== Elasticsearch 인덱싱 끝 ==========

     // 검색 소요시간 계산 및 출력
     const searchEndTime = Date.now();
     const searchDuration = searchEndTime - searchStartTime;
     const durationSeconds = (searchDuration / 1000).toFixed(2);
     
     console.log(`\n⏱️ 검색 완료: 총 소요시간 ${durationSeconds}초 (${searchResults.length}개 결과)`);
    console.log(`🔍 검색 조건: ${country}/${keyword || '키워드 없음'}/${finalMaxResults}건`);
    console.log('='.repeat(52));

    res.json({
      success: true,
      data: searchResults,
      total: searchResults.length,
      source: 'youtube_api_with_es_cache',
      searchDuration: `${durationSeconds}초`
    });

  } catch (error) {
    console.error('검색 오류:', error);
    
    // 오류 발생 시에도 소요시간 출력
    const errorEndTime = Date.now();
    const errorDuration = errorEndTime - searchStartTime;
    const errorDurationSeconds = (errorDuration / 1000).toFixed(2);
    
    console.log(`\n⚠️ 검색 실패: 소요시간 ${errorDurationSeconds}초`);
    console.log('='.repeat(52));
    
    // API 키 사용 통계 출력 (오류 발생 시에도)
    apiKeyManager.printUsageStats();
    
    // YouTube API quota 초과 오류 처리 - 수정된 로직
    if (error.message.includes('quota') || error.message.includes('quotaExceeded')) {
      console.error('YouTube API 할당량 초과 감지');
      
      // 실제로 사용 가능한 키가 있는지 확인
      const availableKeys = apiKeyManager.apiKeys.filter(key => !key.quotaExceeded);
      const totalKeys = apiKeyManager.apiKeys.length;
      const exhaustedKeys = totalKeys - availableKeys.length;
      
      // 사용 가능한 키가 있으면 429 에러를 반환하지 않고 재시도 유도
      if (availableKeys.length > 0) {
        console.log(`사용 가능한 API 키가 ${availableKeys.length}개 남아있음, 이 오류는 내부 처리 중 발생한 일시적 오류입니다.`);
        
        // 500 에러로 반환하여 클라이언트가 재시도할 수 있도록 함
        res.status(500).json({
          success: false,
          error: '일시적인 API 키 전환 오류가 발생했습니다. 잠시 후 재시도해 주세요.',
          errorType: 'temporary_api_key_switch_error',
          details: `${availableKeys.length}개의 API 키가 사용 가능합니다.`,
          keyStats: {
            total: totalKeys,
            available: availableKeys.length,
            exhausted: exhaustedKeys
          }
        });
      } else {
        // 모든 키가 실제로 소진된 경우에만 429 에러 반환
        console.error('모든 YouTube API 키의 할당량이 초과됨');
        res.status(429).json({
          success: false,
          error: `YouTube API 일일 할당량을 초과했습니다. (${exhaustedKeys}/${totalKeys} 키 사용됨)`,
          errorType: 'quota_exceeded',
          details: '모든 API 키의 할당량이 초과되었습니다. 내일 자동으로 할당량이 재설정됩니다.',
          keyStats: {
            total: totalKeys,
            available: availableKeys.length,
            exhausted: exhaustedKeys
          }
        });
      }
    } else if (error.message.includes('API key')) {
      console.error('YouTube API 키 오류');
      res.status(401).json({
        success: false,
        error: 'YouTube API 키가 유효하지 않습니다. 관리자에게 문의하세요.',
        errorType: 'invalid_api_key'
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message,
        errorType: 'general_error'
      });
    }
  }
});

// 썸네일 다운로드 API는 아래에 개선된 버전이 있습니다.

// Excel 다운로드 API
app.post('/api/download-excel', async (req, res) => {
  try {
    const { searchResults, searchParams } = req.body;
    
    if (!searchResults || !Array.isArray(searchResults)) {
      return res.status(400).json({ error: '검색 결과 데이터가 필요합니다.' });
    }

    // Excel용 데이터 변환
    const excelData = searchResults.map((result, index) => {
      return {
        '순번': index + 1,
        '채널명': result.youtube_channel_name || '',
        '채널 ID': result.youtube_channel_id || '',
        '동영상 제목': result.title || '',
        '카테고리': result.primary_category || '',
        '업로드일': result.status_date ? new Date(result.status_date).toLocaleDateString('ko-KR') : '',
        '조회수': parseInt(result.daily_view_count || 0).toLocaleString(),
        '구독자': formatSubscriberCountForExcel(result.subscriber_count || 0),
        'URL': result.vod_url || '',
        '시간(초)': result.duration_seconds || 0,
        '시간(형식)': formatDurationForExcel(result.duration_seconds),
        '동영상 길이': formatVideoLengthForExcel(result.video_length_category) || '',
        '상태': result.status || '',
        '썸네일 URL': result.thumbnail_url || ''
      };
    });

    // 워크북 생성
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);

    // 컬럼 너비 자동 조정
    const columnWidths = [
      { wch: 6 },  // 순번
      { wch: 25 }, // 채널명
      { wch: 20 }, // 채널 ID
      { wch: 40 }, // 동영상 제목
      { wch: 15 }, // 카테고리
      { wch: 12 }, // 업로드일
      { wch: 12 }, // 조회수
      { wch: 12 }, // 구독자
      { wch: 50 }, // URL
      { wch: 8 },  // 시간(초)
      { wch: 10 }, // 시간(형식)
      { wch: 12 }, // 동영상 길이
      { wch: 10 }, // 상태
      { wch: 50 }  // 썸네일 URL
    ];
    worksheet['!cols'] = columnWidths;

    // 워크시트를 워크북에 추가
    XLSX.utils.book_append_sheet(workbook, worksheet, 'YouTube 검색 결과');

    // Excel 파일을 버퍼로 생성
    const excelBuffer = XLSX.write(workbook, { 
      type: 'buffer', 
      bookType: 'xlsx',
      compression: true 
    });

    // 파일명 생성 (검색 조건 포함) - 대한민국 시간 기준
    const now = new Date();
    const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // UTC+9 (대한민국 시간)
    const timestamp = kstTime.toISOString().slice(0, 19).replace(/:/g, '-');
    const keyword = searchParams?.keyword || '전체';
    const country = searchParams?.country || 'worldwide';
    const resultCount = searchResults.length;
    
    // 날짜 범위 정보 포함
    let dateRangeStr = '';
    if (searchParams?.startDate || searchParams?.endDate) {
      const startDateStr = searchParams?.startDate ? searchParams.startDate.replace(/-/g, '') : '';
      const endDateStr = searchParams?.endDate ? searchParams.endDate.replace(/-/g, '') : '';
      if (startDateStr && endDateStr) {
        dateRangeStr = `_${startDateStr}-${endDateStr}`;
      } else if (startDateStr) {
        dateRangeStr = `_${startDateStr}이후`;
      } else if (endDateStr) {
        dateRangeStr = `_${endDateStr}이전`;
      }
    } else if (searchParams?.uploadPeriod) {
      dateRangeStr = `_${searchParams.uploadPeriod}`;
    }
    
    const filename = `YouTube_${keyword}_${country}${dateRangeStr}_[${resultCount}]_${timestamp}.xlsx`;

    // 응답 헤더 설정
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', excelBuffer.length);

    // Excel 파일 전송
    res.send(excelBuffer);

    console.log(`✅ Excel 파일 생성 완료: ${filename} (${searchResults.length}행)`);

  } catch (error) {
    console.error('Excel 다운로드 오류:', error);
    res.status(500).json({ error: 'Excel 파일 생성에 실패했습니다.' });
  }
});

// Excel용 시간 포맷 함수
function formatDurationForExcel(durationSeconds) {
  if (!durationSeconds || durationSeconds === 0) {
    return '00:00';
  }
  
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  } else {
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}

// Excel용 구독자 수 포맷 함수 (만 단위)
function formatSubscriberCountForExcel(count) {
  if (!count || count === 0) {
    return '0';
  }
  
  const number = parseInt(count);
  const inTenThousands = number / 10000;
  
  if (number < 10000) {
    // 1만 미만인 경우 소수점 2자리 표시
    return inTenThousands.toFixed(2);
  } else {
    // 1만 이상인 경우 소수점 1자리 표시 (100만 이상도 포함)
    return inTenThousands.toFixed(1);
  }
}

// Excel용 동영상 길이 카테고리 포맷 함수
function formatVideoLengthForExcel(category) {
  const categoryMap = {
    'short1': 'Short Form1 (1분 미만)',
    'short2': 'Short Form2 (1분 이상 2분 미만)',
    'mid1': 'Mid Form1 (2분 이상 10분 미만)',
    'mid2': 'Mid Form2 (10분 이상 20분 미만)',
    'long1': 'Long Form1 (20분 이상 30분 미만)',
    'long2': 'Long Form2 (30분 이상 40분 미만)',
    'long3': 'Long Form3 (40분 이상 50분 미만)',
    'long4': 'Long Form4 (50분 이상 60분 미만)',
    'long5': 'Long Form5 (60분 이상 90분 미만)',
    'long6': 'Long Form6 (90분 이상)'
  };
  
  return categoryMap[category] || category || '알 수 없음';
}

// 헬퍼 함수들
function getCountryCode(country) {
  // YouTube API가 공식 지원하는 regionCode 목록 (안전성 검증된 국가만)
  const countryMap = {
    'worldwide': null, // 전세계 검색 시 regionCode 없음
    'korea': 'KR',     // ✅ 한국 - 안정적
    'usa': 'US',       // ✅ 미국 - 안정적
    'japan': 'JP',     // ✅ 일본 - 안정적
    'china': null,     // ❌ 중국 - YouTube 접근 제한으로 null 처리
    'uk': 'GB',        // ✅ 영국 - 안정적
    'germany': 'DE',   // ✅ 독일 - 안정적
    'france': 'FR',    // ✅ 프랑스 - 안정적
    'canada': 'CA',    // ✅ 캐나다 - 안정적
    'australia': 'AU', // ✅ 호주 - 안정적
    'india': 'IN',     // ✅ 인도 - 안정적
    'brazil': 'BR',    // ✅ 브라질 - 안정적
    'mexico': 'MX',    // ✅ 멕시코 - 안정적
    'russia': null,    // ❌ 러시아 - YouTube 서비스 제한으로 null 처리
    'italy': 'IT',     // ✅ 이탈리아 - 안정적
    'spain': 'ES'      // ✅ 스페인 - 안정적
  };
  
  const code = countryMap[country.toLowerCase()];
  
  // 유효한 regionCode인지 확인 (YouTube API 지원 국가만)
  const validRegionCodes = [
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT',
    'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI',
    'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY',
    'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
    'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
    'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK',
    'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
    'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
    'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR',
    'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
    'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS',
    'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
    'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW',
    'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP',
    'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
    'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
    'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM',
    'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF',
    'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW',
    'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
    'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  ];
  
  // 유효한 코드만 반환, 그렇지 않으면 null
  return code && validRegionCodes.includes(code) ? code : null;
}

function getLanguageCode(country) {
  const languageMap = {
    'worldwide': 'en', // 전세계는 영어 기본
    'korea': 'ko',     // 한국어
    'usa': 'en',       // 영어
    'japan': 'ja',     // 일본어
    'china': 'zh',     // 중국어 (YouTube 접근 제한 고려)
    'uk': 'en',        // 영어
    'germany': 'de',   // 독일어
    'france': 'fr',    // 프랑스어
    'canada': 'en',    // 영어 (캐나다는 영어/프랑스어 혼용이지만 영어 우선)
    'australia': 'en', // 영어
    'india': 'en',     // 영어 (힌디어 등 여러 언어 있지만 영어 우선)
    'brazil': 'pt',    // 포르투갈어
    'mexico': 'es',    // 스페인어
    'russia': 'en',    // 러시아는 서비스 제한으로 영어 사용
    'italy': 'it',     // 이탈리아어
    'spain': 'es'      // 스페인어
  };
  
  return languageMap[country.toLowerCase()] || 'en';
}

function getDateRange(period) {
  const now = new Date();
  let publishedAfter = null;
  
  switch (period) {
    case '1day':
      publishedAfter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '1week':
      publishedAfter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '1month':
      publishedAfter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '3months':
      publishedAfter = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '6months':
      publishedAfter = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
      break;
    case '1year':
      publishedAfter = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case '2years':
      publishedAfter = new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '3years':
      publishedAfter = new Date(now.getTime() - 3 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '4years':
      publishedAfter = new Date(now.getTime() - 4 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '5years':
      publishedAfter = new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '6years':
      publishedAfter = new Date(now.getTime() - 6 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '7years':
      publishedAfter = new Date(now.getTime() - 7 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '8years':
      publishedAfter = new Date(now.getTime() - 8 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '9years':
      publishedAfter = new Date(now.getTime() - 9 * 365 * 24 * 60 * 60 * 1000);
      break;
    case '10years':
      publishedAfter = new Date(now.getTime() - 10 * 365 * 24 * 60 * 60 * 1000);
      break;
  }
  
  return {
    publishedAfter: publishedAfter ? publishedAfter.toISOString() : null,
    publishedBefore: null
  };
}

// YouTube duration (ISO 8601)을 초로 변환하는 함수
function parseDuration(duration) {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const matches = duration.match(regex);
  
  if (!matches) return 0;
  
  const hours = parseInt(matches[1]) || 0;
  const minutes = parseInt(matches[2]) || 0;
  const seconds = parseInt(matches[3]) || 0;
  
  return hours * 3600 + minutes * 60 + seconds;
}

// 동영상 길이 분류 함수
function getVideoLengthCategory(durationInSeconds) {
  if (durationInSeconds < 60) return 'short1';       // 1분 미만
  if (durationInSeconds < 120) return 'short2';      // 1분 이상 2분 미만
  if (durationInSeconds < 600) return 'mid1';        // 2분 이상 10분 미만
  if (durationInSeconds < 1200) return 'mid2';       // 10분 이상 20분 미만
  if (durationInSeconds < 1800) return 'long1';      // 20분 이상 30분 미만
  if (durationInSeconds < 2400) return 'long2';      // 30분 이상 40분 미만
  if (durationInSeconds < 3000) return 'long3';      // 40분 이상 50분 미만
  if (durationInSeconds < 3600) return 'long4';      // 50분 이상 60분 미만
  if (durationInSeconds < 5400) return 'long5';      // 60분 이상 90분 미만
  return 'long6';                                    // 90분 이상
}

// 선택된 길이 카테고리와 매치되는지 확인
function matchesVideoLength(videoLengthCategory, selectedLengths) {
  if (!selectedLengths || selectedLengths.length === 0) return true;
  return selectedLengths.includes(videoLengthCategory);
}

// 채널 구독자 수 가져오기
async function getChannelSubscriberCount(channelId) {
  try {
    const youtube = apiKeyManager.getYouTubeInstance();
    const channelResponse = await youtube.channels.list({
      part: 'statistics',
      id: channelId
    });

    if (channelResponse.data.items && channelResponse.data.items.length > 0) {
      const subscriberCount = channelResponse.data.items[0].statistics.subscriberCount;
      return parseInt(subscriberCount) || 0;
    }
    
    return 0;
  } catch (error) {
    console.error(`채널 구독자 수 조회 오류 (${channelId}):`, error.message);
    return 0;
  }
}

async function getCategoryName(categoryId) {
  try {
    const categories = {
      '1': 'Film & Animation',
      '2': 'Autos & Vehicles',
      '10': 'Music',
      '15': 'Pets & Animals',
      '17': 'Sports',
      '19': 'Travel & Events',
      '20': 'Gaming',
      '22': 'People & Blogs',
      '23': 'Comedy',
      '24': 'Entertainment',
      '25': 'News & Politics',
      '26': 'Howto & Style',
      '27': 'Education',
      '28': 'Science & Technology'
    };
    
    return categories[categoryId] || 'Other';
  } catch (error) {
    return 'Other';
  }
}

// 썸네일 다운로드 API (ERR_INVALID_CHAR 오류 해결)
app.get('/api/download-thumbnail', async (req, res) => {
try {
const { url, filename } = req.query;

console.log('📥 썸네일 다운로드 요청:', { url, filename });

if (!url) {
      return res.status(400).json({ error: 'URL이 필요합니다.' });
}

// 파일명 안전하게 처리 (ERR_INVALID_CHAR 오류 방지)
let safeFilename = filename || 'thumbnail.jpg';

// 파일명이 이미 안전한지 확인하는 함수
function isFilenameSafe(fname) {
  // ASCII가 아닌 문자, 특수문자, 제어문자 등 확인
    const unsafePattern = /[^\x20-\x7E]|[<>:"/\\|?*\x00-\x1f]/;
    return !unsafePattern.test(fname) && fname.length <= 100 && fname.trim() === fname;
}

// 파일명이 이미 안전하다면 변환하지 않음
if (isFilenameSafe(safeFilename)) {
console.log('✅ 파일명이 이미 안전함:', safeFilename);
} else {
  console.log('🔧 파일명 변환 필요:', { original: safeFilename });
  
  // 특수문자 및 유니코드 문자 제거/변경
safeFilename = safeFilename
    .normalize('NFD')                          // 유니코드 정규화
    .replace(/[\u0300-\u036f]/g, '')          // 발음 기호 제거
    .replace(/[^\x00-\x7F]/g, '')             // ASCII가 아닌 문자 제거 (한글, 이모지 등)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')   // 파일명에 사용 불가한 문자들 제거
  .replace(/["'`]/g, '')                    // 따옴표 제거
    .replace(/\s+/g, '_')                     // 공백을 언더스코어로 변경
    .replace(/_{2,}/g, '_')                   // 연속된 언더스코어를 하나로 변경
    .replace(/^_+|_+$/g, '')                  // 앞뒤 언더스코어 제거
        .substring(0, 100);                       // 파일명 길이 제한
      
      // 파일명이 비어있으면 기본값 설정
      if (!safeFilename || safeFilename.length === 0) {
        safeFilename = 'thumbnail';
      }
      
      // 파일 확장자 확인 및 추가
      if (!safeFilename.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/)) {
        safeFilename += '.jpg';
      }
      
      console.log('🔧 파일명 변환 완료:', { original: filename, safe: safeFilename });
    }

    const response = await axios.get(url, { 
      responseType: 'stream',
      timeout: 10000  // 10초 타임아웃
    });
    
    // 안전한 파일명만 헤더에 설정
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Content-Length', response.headers['content-length'] || '');
    
    response.data.pipe(res);

    console.log(`✅ 썸네일 다운로드 성공: ${safeFilename}`);

  } catch (error) {
    console.error('썸네일 다운로드 오류:', error);
    
    // 구체적인 오류 처리
    if (error.code === 'ERR_INVALID_CHAR') {
      console.error('❌ Content-Disposition 헤더 오류:', {
        originalFilename: req.query.filename,
        url: req.query.url,
        error: error.message
      });
      res.status(400).json({ 
        error: '파일명에 사용할 수 없는 문자가 포함되어 있습니다.',
        details: 'Invalid characters in filename for HTTP header'
      });
    } else if (error.response) {
      console.error('❌ 외부 서버 오류:', error.response.status, error.response.statusText);
      res.status(502).json({ 
        error: '썸네일 서버에서 이미지를 가져올 수 없습니다.',
        details: `HTTP ${error.response.status}: ${error.response.statusText}`
      });
    } else if (error.request) {
      console.error('❌ 네트워크 오류:', error.message);
      res.status(503).json({ 
        error: '네트워크 오류로 썸네일 다운로드에 실패했습니다.',
        details: 'Network timeout or connection error'
      });
    } else {
      console.error('❌ 알 수 없는 오류:', error.message);
      res.status(500).json({ 
        error: '썸네일 다운로드에 실패했습니다.',
        details: error.message
      });
    }
  }
});

// 🕐 시간대 필터 관련 함수들
function parseTimeFilterFromQuery(query) {
  const {
    uploadTimePreset,
    timeStart,
    timeEnd,
    timezone = 'KST'
  } = query;

  // 프리셋이 있으면 프리셋 사용
  if (uploadTimePreset && uploadTimePreset !== 'custom' && uploadTimePreset !== 'all') {
    const preset = getTimePresetConfig(uploadTimePreset);
    if (preset) {
      return {
        startTime: preset.start,
        endTime: preset.end,
        timezone: preset.timezone || timezone,
        source: 'preset',
        presetName: uploadTimePreset
      };
    }
  }

  // 커스텀 시간 설정이 있으면 커스텀 사용
  if (timeStart && timeEnd) {
    return {
      startTime: timeStart,
      endTime: timeEnd,
      timezone: timezone,
      source: 'custom'
    };
  }

  // 설정이 없으면 null 반환
  return null;
}

// 시간대 프리셋 설정 정의 (업데이트된 버전)
function getTimePresetConfig(presetName) {
  const presets = {
    // 한국 떡상 시간대 프리셋
    'kr_golden': {
      start: '18:00',
      end: '23:00',
      timezone: 'KST',
      description: '한국 골든타임 (저녁 6시-11시) - 최고 떡상률 35%'
    },
    'kr_lunch': {
      start: '11:00',
      end: '14:00',
      timezone: 'KST',
      description: '한국 점심시간 (오전 11시-오후 2시) - 직장인 시청 피크'
    },
    'morning_commute': {
      start: '07:00',
      end: '09:00',
      timezone: 'KST',
      description: '출근시간 (오전 7시-9시) - 쇼츠 최적화 시간대'
    },
    'late_night': {
      start: '23:00',
      end: '02:00',
      timezone: 'KST',
      description: '심야시간 (밤 11시-새벽 2시) - 몰입도 높은 시청'
    },
    'kr_weekend_afternoon': {
      start: '14:00',
      end: '17:00',
      timezone: 'KST',
      description: '주말 오후 (오후 2시-5시) - 여유로운 시청'
    },
    // 미국 시간대 프리셋
    'us_prime_est': {
      start: '19:00',
      end: '23:00',
      timezone: 'EST',
      description: '미국 동부 프라임타임 (저녁 7시-11시 EST) - 뉴욕 기준'
    },
    'us_prime_pst': {
      start: '19:00',
      end: '23:00',
      timezone: 'PST',
      description: '미국 서부 프라임타임 (저녁 7시-11시 PST) - LA 기준'
    },
    // 글로벌 최적화 시간대
    'global_sweet': {
      start: '14:00',
      end: '16:00',
      timezone: 'EST',
      description: '글로벌 스윗스팟 (미국 동부 오후 2시-4시) - 3대륙 동시 활성'
    },
    'asia_prime': {
      start: '20:00',
      end: '22:00',
      timezone: 'KST',
      description: '아시아 프라임타임 (저녁 8시-10시 KST) - 한중일 동시 활성'
    },
    // 쇼츠 특화 시간대
    'shorts_morning': {
      start: '07:00',
      end: '09:00',
      timezone: 'KST',
      description: '쇼츠 아침 피크 (7시-9시) - 출근길 모바일 시청'
    },
    'shorts_lunch': {
      start: '12:00',
      end: '13:00',
      timezone: 'KST',
      description: '쇼츠 점심 피크 (12시-1시) - 휴식시간 짧은 콘텐츠'
    },
    'shorts_evening': {
      start: '18:00',
      end: '20:00',
      timezone: 'KST',
      description: '쇼츠 저녁 피크 (6시-8시) - 퇴근길 모바일 시청'
    },
    // 기존 호환성을 위한 alias
    'shorts_peak': {
      start: '12:00',
      end: '13:00',
      timezone: 'KST',
      description: '쇼츠 피크타임 (복수 시간대)'
    },
    'weekend_morning': {
      start: '09:00',
      end: '12:00',
      timezone: 'KST',
      description: '주말 오전 (9시-12시)'
    },
    'us_prime': {
      start: '19:00',
      end: '23:00',
      timezone: 'EST',
      description: '미국 프라임타임 (19-23시 EST)'
    }
  };

  return presets[presetName] || null;
}

// 시간대 필터 적용 함수
function applyTimeFilter(videos, timeFilter) {
  if (!timeFilter || !videos || videos.length === 0) {
    return videos;
  }

  const { startTime, endTime, timezone } = timeFilter;
  
  return videos.filter(video => {
    if (!video.status_date) return true; // 업로드 시간 정보가 없으면 포함

    try {
      const uploadDate = new Date(video.status_date);
      const uploadHour = convertToTimezone(uploadDate, timezone);
      
      return isTimeInRange(uploadHour, startTime, endTime);
    } catch (error) {
      console.error('시간 필터 처리 오류:', error, video.video_id);
      return true; // 오류 시 포함
    }
  });
}

// 시간대 변환 함수 (서머타임 고려 개선 버전)
function convertToTimezone(date, timezone) {
  const utcTime = date.getTime();
  
  // 시간대별 오프셋 (시간 단위) - 서머타임 고려
  const timezoneOffsets = {
    'KST': 9,    // 한국 표준시 (UTC+9) - 서머타임 없음
    'JST': 9,    // 일본 표준시 (UTC+9) - 서머타임 없음
    'EST': getUSOffset(date, 'EST'), // 미국 동부 (UTC-5/-4)
    'PST': getUSOffset(date, 'PST'), // 미국 서부 (UTC-8/-7)
    'GMT': 0,    // 그리니치 표준시 (UTC+0)
    'CET': getEUOffset(date),        // 중앙유럽 (UTC+1/+2)
    'CST': getUSOffset(date, 'CST')  // 미국 중부 (UTC-6/-5)
  };
  
  const offset = timezoneOffsets[timezone] || 0;
  const localTime = new Date(utcTime + (offset * 60 * 60 * 1000));
  
  return {
    hour: localTime.getUTCHours(),
    minute: localTime.getUTCMinutes(),
    timeString: `${String(localTime.getUTCHours()).padStart(2, '0')}:${String(localTime.getUTCMinutes()).padStart(2, '0')}`
  };
}

// 미국 시간대 오프셋 계산 (서머타임 고려)
function getUSOffset(date, timezone) {
  const year = date.getFullYear();
  
  // 서머타임 시작: 3월 둘째 일요일 오전 2시
  const dstStart = new Date(year, 2, 1); // 3월 1일
  dstStart.setDate(dstStart.getDate() + (7 - dstStart.getDay()) % 7 + 7); // 둘째 일요일
  dstStart.setHours(2, 0, 0, 0);
  
  // 서머타임 끝: 11월 첫째 일요일 오전 2시
  const dstEnd = new Date(year, 10, 1); // 11월 1일
  dstEnd.setDate(dstEnd.getDate() + (7 - dstEnd.getDay()) % 7); // 첫째 일요일
  dstEnd.setHours(2, 0, 0, 0);
  
  const isDST = date >= dstStart && date < dstEnd;
  
  const baseOffsets = {
    'EST': -5,  // 표준시
    'PST': -8,  // 표준시
    'CST': -6   // 표준시
  };
  
  const baseOffset = baseOffsets[timezone] || 0;
  return isDST ? baseOffset + 1 : baseOffset; // 서머타임일 때 +1시간
}

// 유럽 시간대 오프셋 계산 (서머타임 고려)
function getEUOffset(date) {
  const year = date.getFullYear();
  
  // EU 서머타임 시작: 3월 마지막 일요일 오전 1시
  const dstStart = new Date(year, 2, 31); // 3월 31일
  dstStart.setDate(dstStart.getDate() - dstStart.getDay()); // 마지막 일요일
  dstStart.setHours(1, 0, 0, 0);
  
  // EU 서머타임 끝: 10월 마지막 일요일 오전 1시
  const dstEnd = new Date(year, 9, 31); // 10월 31일
  dstEnd.setDate(dstEnd.getDate() - dstEnd.getDay()); // 마지막 일요일
  dstEnd.setHours(1, 0, 0, 0);
  
  const isDST = date >= dstStart && date < dstEnd;
  
  return isDST ? 2 : 1; // CEST(UTC+2) 또는 CET(UTC+1)
}

// 시간 범위 체크 함수 (자정을 넘는 경우도 처리)
function isTimeInRange(uploadTime, startTime, endTime) {
  const uploadHour = uploadTime.hour;
  const uploadMinute = uploadTime.minute;
  const uploadTotalMinutes = uploadHour * 60 + uploadMinute;
  
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);
  const startTotalMinutes = startHour * 60 + startMin;
  const endTotalMinutes = endHour * 60 + endMin;
  
  if (startTotalMinutes <= endTotalMinutes) {
    // 일반적인 경우 (같은 날 내)
    return uploadTotalMinutes >= startTotalMinutes && uploadTotalMinutes <= endTotalMinutes;
  } else {
    // 자정을 넘는 경우 (예: 23:00 ~ 02:00)
    return uploadTotalMinutes >= startTotalMinutes || uploadTotalMinutes <= endTotalMinutes;
  }
}

// 시간대 필터 통계 로그 출력
function logTimeFilterStats(originalCount, filteredCount, timeFilter) {
  const filtered = originalCount - filteredCount;
  const filterRate = originalCount > 0 ? ((filtered / originalCount) * 100).toFixed(1) : '0.0';
  
  console.log('🕐 시간대 필터 결과:');
  console.log(`   원본: ${originalCount}개 → 필터링 후: ${filteredCount}개`);
  console.log(`   제외된 영상: ${filtered}개 (${filterRate}%)`);
  console.log(`   시간 범위: ${timeFilter.startTime} ~ ${timeFilter.endTime} (${timeFilter.timezone})`);
  
  if (timeFilter.source === 'preset') {
    const preset = getTimePresetConfig(timeFilter.presetName);
    console.log(`   프리셋: ${preset ? preset.description : timeFilter.presetName}`);
  } else {
    console.log(`   설정: 커스텀 시간 범위`);
  }
}

// 서버 시작
app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`브라우저에서 http://localhost:${PORT} 를 열어주세요.`);
});