const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const XLSX = require('xlsx');
const { Client } = require('@elastic/elasticsearch');
require('dotenv').config();

// Elasticsearch 클라이언트 설정
let esClient = null;
try {
  esClient = new Client({
    node: process.env.ES_NODE || 'http://localhost:9200',
    auth: process.env.ES_USERNAME && process.env.ES_PASSWORD ? {
      username: process.env.ES_USERNAME,
      password: process.env.ES_PASSWORD
    } : undefined
  });
  console.log('Elasticsearch 클라이언트 초기화 완료');
} catch (error) {
  console.warn('Elasticsearch 연결 실패, YouTube API만 사용:', error.message);
  esClient = null;
}

// 인덱스 매핑 설정
async function initializeIndex() {
  if (!esClient) return;
  try {
    const indexName = process.env.ES_INDEX_VIDEOS || 'videos';
    const exists = await esClient.indices.exists({ index: indexName });
    if (!exists.body) {
      await esClient.indices.create({
        index: indexName,
        body: {
          mappings: {
            properties: {
              video_id: { type: 'keyword' },
              title: { type: 'text' },
              youtube_channel_name: { type: 'text' },
              youtube_channel_id: { type: 'keyword' },
              country: { type: 'keyword' },
              status_date: { type: 'date' },
              daily_view_count: { type: 'long' },
              subscriber_count: { type: 'long' },
              duration_seconds: { type: 'integer' },
              video_length_category: { type: 'keyword' },
              primary_category: { type: 'keyword' },
              vod_url: { type: 'keyword' },
              thumbnail_url: { type: 'keyword' },
              status: { type: 'keyword' },
              description: { type: 'text' },
              keyword_normalized: { type: 'keyword' },
              indexed_at: { type: 'date' }
            }
          }
        }
      });
      console.log(`✅ 인덱스 ${indexName} 생성 및 매핑 설정 완료`);
    } else {
      console.log(`✅ 인덱스 ${indexName} 이미 존재`);
    }
  } catch (error) {
    console.error('인덱스 초기화 실패:', error.message);
  }
}

// 서버 시작시 인덱스 초기화
initializeIndex();

// 다중 API 키 관리 시스템
class ApiKeyManager {
  constructor() {
    this.apiKeys = [];
    this.currentKeyIndex = 0;
    this.keyUsageCount = {};
    this.keyQuotaExceeded = {};
    
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
          consecutiveErrors: 0
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
  }
  
  getCurrentKey() {
    let availableKeys = this.apiKeys.filter(keyInfo => 
      !keyInfo.quotaExceeded && keyInfo.consecutiveErrors < 3
    );
    
    if (availableKeys.length === 0) {
      availableKeys = this.apiKeys.filter(keyInfo => !keyInfo.quotaExceeded);
    }
    
    if (availableKeys.length === 0) {
      console.log('⚠️ 모든 API 키의 할당량이 초과되었습니다.');
      return null;
    }
    
    availableKeys.sort((a, b) => a.usageCount - b.usageCount);
    const selectedKey = availableKeys[0];
    
    this.currentKeyIndex = selectedKey.index - 1;
    console.log(`🔑 선택된 API 키: ${selectedKey.name} (사용횟수: ${selectedKey.usageCount}, 연속오류: ${selectedKey.consecutiveErrors})`);
    
    return selectedKey;
  }
  
  getYouTubeInstance() {
    const currentKey = this.getCurrentKey();
    if (!currentKey) {
      throw new Error('NO_AVAILABLE_KEYS: 사용 가능한 API 키가 없습니다.');
    }
    
    currentKey.usageCount++;
    currentKey.lastUsed = new Date();
    
    console.log(`🔑 사용 중인 API 키: ${currentKey.name} (사용횟수: ${currentKey.usageCount})`);
    
    return google.youtube({ version: 'v3', auth: currentKey.key });
  }
  
  markKeyAsQuotaExceeded(currentKey, errorMessage = '') {
    if (!currentKey) return null;
    
    console.log(`❌ ${currentKey.name} 오류 발생: ${errorMessage}`);
    
    if (errorMessage.includes('quota') || errorMessage.includes('quotaExceeded') || 
        errorMessage.includes('dailyLimitExceeded') || errorMessage.includes('rateLimitExceeded')) {
      currentKey.quotaExceeded = true;
      console.log(`🚫 ${currentKey.name} 할당량 초과로 비활성화됨`);
    } else {
      currentKey.consecutiveErrors++;
      console.log(`⚠️ ${currentKey.name} 연속 오류 횟수: ${currentKey.consecutiveErrors}`);
      
      if (currentKey.consecutiveErrors >= 3) {
        console.log(`🔒 ${currentKey.name} 연속 오류로 임시 비활성화 (할당량 초과는 아님)`);
      }
    }
    
    const nextKey = this.getCurrentKey();
    
    if (nextKey) {
      console.log(`🔄 ${nextKey.name}으로 전환합니다.`);
      return nextKey;
    } else {
      console.log('⚠️ 사용 가능한 API 키가 없습니다.');
      return null;
    }
  }
  
  markKeyAsSuccessful(currentKey) {
    if (currentKey && currentKey.consecutiveErrors > 0) {
      console.log(`✅ ${currentKey.name} 성공, 연속 오류 카운터 리셋`);
      currentKey.consecutiveErrors = 0;
    }
  }
  
  hasAvailableKeys() {
    return this.apiKeys.some(keyInfo => !keyInfo.quotaExceeded);
  }
  
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
    this.bulkFailureCount = 0; // Bulk 실패 카운터 추가
    this.bulkFailureThreshold = 5; // 알림 임계값
  }

  async checkCacheHit(searchParams) {
    if (!this.client) return { hit: false, reason: 'ES client not available' };
    
    const startTime = Date.now();
    try {
      const { country, keyword, minViews, maxViews, maxResults } = searchParams;
      
      const mustQueries = [];
      const filterQueries = [];
      
      if (country && country !== 'worldwide') {
        mustQueries.push({ term: { country } });
      } else {
        mustQueries.push({ bool: { must_not: { exists: { field: 'country' } } } });
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
      
      // Freshness 필터 추가
      const ttlLimit = new Date(Date.now() - this.ttlHours * 60 * 60 * 1000);
      filterQueries.push({ range: { indexed_at: { gte: ttlLimit.toISOString() } } });
      
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
      
      const cacheHit = availableCount >= requestedCount;
      const queryTime = Date.now() - startTime;
      
      console.log(`📊 캐시 히트 체크 시간: ${queryTime}ms, 사용 가능 데이터: ${availableCount}/${requestedCount}`);
      
      return {
        hit: cacheHit,
        availableCount,
        requestedCount,
        isFresh: true, // range 필터로 보장
        reason: cacheHit ? 'Cache hit' : `Insufficient data (${availableCount}/${requestedCount})`,
        queryTime
      };
      
    } catch (error) {
      console.error('Cache hit check error:', error);
      return { hit: false, reason: 'Cache check failed', error: error.message, queryTime: Date.now() - startTime };
    }
  }
  
  async searchVideos(searchParams) {
    if (!this.client) return null;
    
    const startTime = Date.now();
    try {
      const { country, keyword, minViews, maxViews, maxResults } = searchParams;
      
      const mustQueries = [];
      const filterQueries = [];
      
      if (country && country !== 'worldwide') {
        mustQueries.push({ term: { country } });
      } else {
        mustQueries.push({ bool: { must_not: { exists: { field: 'country' } } } });
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
      
      const ttlLimit = new Date(Date.now() - this.ttlHours * 60 * 60 * 1000);
      filterQueries.push({ range: { indexed_at: { gte: ttlLimit.toISOString() } } });
      
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
      
      const queryTime = Date.now() - startTime;
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
      
      console.log(`📊 ES 검색 완료: ${results.length}개 결과, 쿼리 시간: ${queryTime}ms`);
      return results;
      
    } catch (error) {
      console.error('ES search error:', error);
      return null;
    }
  }
  
  async bulkUpsertVideos(videos, searchParams) {
    if (!this.client || !videos || videos.length === 0) return;
    
    try {
      const body = [];
      const indexedAt = new Date().toISOString();
      
      videos.forEach(video => {
        body.push({
          update: {
            _index: this.indexName,
            _id: video.video_id
          }
        });
        
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
      
      if (response.body.errors) {
        this.bulkFailureCount++;
        console.error('ES bulk upsert errors:', response.body.items.filter(item => item.update && item.update.error));
        if (this.bulkFailureCount >= this.bulkFailureThreshold) {
          console.error(`🚨 ES bulk upsert ${this.bulkFailureCount}회 연속 실패! 관리자 확인 필요`);
        }
      } else {
        this.bulkFailureCount = 0; // 성공시 카운터 리셋
        console.log(`ES bulk upsert 성공: ${videos.length}개 비디오 인덱싱`);
      }
      
    } catch (error) {
      this.bulkFailureCount++;
      console.error('ES bulk upsert error:', error);
      if (this.bulkFailureCount >= this.bulkFailureThreshold) {
        console.error(`🚨 ES bulk upsert ${this.bulkFailureCount}회 연속 실패! 관리자 확인 필요`);
      }
    }
  }
}

// ES 헬퍼 인스턴스 생성
const esHelper = new ElasticsearchHelper(esClient);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'you_list.html'));
});

app.get('/api/search', async (req, res) => {
  try {
    const {
      country = 'worldwide',
      keyword = '',
      maxViews,
      minViews = 100000,
      uploadPeriod,
      startDate,
      endDate,
      videoLength,
      maxResults = 60
    } = req.query;

    const allowedResults = [10, 20, 30, 40, 50, 60, 100, 150, 200];
    const parsedMaxResults = parseInt(maxResults);
    const finalMaxResults = allowedResults.includes(parsedMaxResults) ? parsedMaxResults : 60;

    console.log('검색 파라미터:', req.query);
    console.log('선택된 국가:', country);
    console.log(`검색 결과 수: ${finalMaxResults}건 (요청: ${maxResults})`);

    const selectedVideoLengths = videoLength && videoLength.trim() ? videoLength.split(',').filter(v => v.trim()) : [];
    console.log('선택된 동영상 길이:', selectedVideoLengths.length > 0 ? selectedVideoLengths : '모든 길이 허용 (필터 없음)');

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
    
    console.log('🔍 Elasticsearch 캐시 확인 중...');
    const cacheResult = await esHelper.checkCacheHit(searchParameters);
    console.log('📊 캐시 확인 결과:', cacheResult);
    
    if (cacheResult.hit) {
      console.log('✅ 캐시 히트! Elasticsearch에서 결과 조회');
      const cachedResults = await esHelper.searchVideos(searchParameters);
      
      if (cachedResults && cachedResults.length > 0) {
        console.log(`📦 캐시에서 ${cachedResults.length}개 결과 반환`);
        return res.json({
          success: true,
          data: cachedResults,
          total: cachedResults.length,
          source: 'elasticsearch_cache'
        });
      } else {
        console.log('⚠️ 캐시 히트였지만 결과가 없음, YouTube API로 fallback');
      }
    } else {
      console.log('❌ 캐시 미스:', cacheResult.reason);
      console.log('🔄 YouTube API 호출로 진행');
    }

    let searchResults = [];
    let nextPageToken = '';
    const resultsPerPage = Math.min(finalMaxResults, 50);
    const processedVideoIds = new Set();

    let searchParams = {
      part: 'snippet',
      type: 'video',
      maxResults: resultsPerPage,
      order: 'viewCount'
    };

    if (country !== 'worldwide') {
      const regionCode = getCountryCode(country);
      if (regionCode) {
        searchParams.regionCode = regionCode;
        console.log(`✅ 지역 코드 설정: ${country} → ${regionCode}`);
      } else {
        console.log(`⚠️ 경고: '${country}' 국가의 regionCode를 찾을 수 없어 전세계 검색으로 진행합니다.`);
        delete searchParams.regionCode;
      }
    } else {
      console.log('🌍 전세계 검색: regionCode 없이 진행');
      delete searchParams.regionCode;
    }

    const languageCode = getLanguageCode(country);
    if (languageCode) {
      searchParams.relevanceLanguage = languageCode;
      console.log(`🌐 언어 설정: ${country} → ${languageCode}`);
    }

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
    console.log('===========================');

    const isEmptyKeyword = !keyword || !keyword.trim();
    
    if (!isEmptyKeyword) {
      searchParams.q = keyword.trim();
      console.log(`키워드 검색: "${keyword.trim()}"`);
    } else {
      console.log('키워드 없음: 국가별 인기 동영상 검색');
      
      if (country !== 'worldwide') {
        console.log(`🏳️ ${country} 국가의 인기 동영상 검색`);
        
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
        
        searchParams.order = 'relevance';
        
        console.log(`🌍 ${country} 국가별 인기 검색어: "${randomTerm}"`);
        console.log('설정: 관련성 순서로 정렬 (국가별 우선)');
      } else {
        console.log('🌍 전세계 인기 동영상 검색');
        
        const broadSearchTerms = ['a', 'the', 'and', 'or', 'video', 'youtube'];
        const randomTerm = broadSearchTerms[Math.floor(Math.random() * broadSearchTerms.length)];
        searchParams.q = randomTerm;
      }
    }

    if (uploadPeriod) {
      const { publishedAfter, publishedBefore } = getDateRange(uploadPeriod);
      if (publishedAfter) searchParams.publishedAfter = publishedAfter;
      if (publishedBefore) searchParams.publishedBefore = publishedBefore;
    } else if (startDate || endDate) {
      if (startDate) searchParams.publishedAfter = startDate;
      if (endDate) searchParams.publishedBefore = endDate;
    }

    const instance = await apiKeyManager.getYouTubeInstanceSafely();
    if (!instance) {
      throw new Error('NO_AVAILABLE_KEYS: 사용 가능한 API 키가 없습니다.');
    }
    
    let { youtube, currentKey } = instance;
    
    while (searchResults.length < finalMaxResults) {
      if (nextPageToken) {
        searchParams.pageToken = nextPageToken;
      }
      
      let response;
      try {
        response = await youtube.search.list(searchParams);
        apiKeyManager.markKeyAsSuccessful(currentKey);
      } catch (error) {
        console.error('YouTube API 검색 오류:', error.message);
        if (error.message.includes('quota') || error.message.includes('quotaExceeded')) {
          console.log('🚫 검색 중 할당량 초과 감지');
          const newKey = apiKeyManager.markKeyAsQuotaExceeded(currentKey, error.message);
          if (newKey) {
            console.log(`🔄 ${newKey.name}으로 재시도...`);
            currentKey = newKey;
            youtube = google.youtube({ version: 'v3', auth: newKey.key });
            continue;
          } else {
            throw new Error('ALL_QUOTA_EXCEEDED: 모든 API 키의 할당량이 초과되었습니다.');
          }
        } else {
          throw error;
        }
      }
      
      const videoIds = response.data.items.map(item => item.id.videoId).join(',');
      
      const detailMaxRetries = 3;
      let detailRetryCount = 0;
      let videoDetails = null;
      
      while (!videoDetails && detailRetryCount < detailMaxRetries) {
        try {
          videoDetails = await youtube.videos.list({
            part: 'snippet,contentDetails,statistics',
            id: videoIds
          });
          apiKeyManager.markKeyAsSuccessful(currentKey);
        } catch (detailError) {
          console.error('비디오 상세정보 조회 오류:', detailError.message);
          if (detailError.message.includes('quota') || detailError.message.includes('quotaExceeded')) {
            console.log('🚫 비디오 상세정보 조회 중 할당량 초과 감지');
            const newDetailKey = apiKeyManager.markKeyAsQuotaExceeded(currentKey);
            if (newDetailKey) {
              console.log(`🔄 ${newDetailKey.name}으로 비디오 상세정보 재시도... (재시도 ${detailRetryCount + 1}/${detailMaxRetries})`);
              currentKey = newDetailKey;
              youtube = google.youtube({ version: 'v3', auth: newDetailKey.key });
              detailRetryCount++;
              continue;
            } else {
              throw new Error('ALL_QUOTA_EXCEEDED: 모든 API 키의 할당량이 초과되었습니다.');
            }
          } else {
            throw detailError;
          }
        }
      }
      
      if (detailRetryCount >= detailMaxRetries && !videoDetails) {
        throw new Error('MAX_RETRIES_EXCEEDED: 비디오 상세정보 조회 실패');
      }

      for (const video of videoDetails.data.items) {
        if (processedVideoIds.has(video.id)) {
          console.log(`🔄 중복 동영상 건너뛰기: ${video.id} - ${video.snippet.title}`);
          continue;
        }
        
        const viewCount = parseInt(video.statistics.viewCount || 0);
        
        if (minViews && viewCount < parseInt(minViews)) continue;
        if (maxViews && viewCount > parseInt(maxViews)) continue;

        const durationInSeconds = parseDuration(video.contentDetails.duration);
        const videoLengthCategory = getVideoLengthCategory(durationInSeconds);
        
        if (!matchesVideoLength(videoLengthCategory, selectedVideoLengths)) continue;

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

        searchResults.push(result);
        processedVideoIds.add(video.id);
        
        if (searchResults.length >= finalMaxResults) break;
      }

      nextPageToken = response.data.nextPageToken;
      if (!nextPageToken) break;

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    searchResults.sort((a, b) => b.daily_view_count - a.daily_view_count);

    const totalProcessed = processedVideoIds.size + searchResults.length;
    const duplicatesRemoved = totalProcessed - searchResults.length;
    
    console.log(`검색 완료: ${searchResults.length}개 결과`);
    console.log(`🔄 중복 제거: ${duplicatesRemoved}개 중복 동영상 제거됨`);
    console.log(`📊 API 사용량: 검색 API ${Math.ceil(searchResults.length / 50)}회 + 상세정보 API ${Math.ceil(searchResults.length / 50)}회 (${finalMaxResults}건 요청 중 ${searchResults.length}건 결과)`);
    
    apiKeyManager.printUsageStats();

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

    res.json({
      success: true,
      data: searchResults,
      total: searchResults.length,
      source: 'youtube_api_with_es_cache'
    });

  } catch (error) {
    console.error('검색 오류:', error);
    
    apiKeyManager.printUsageStats();
    
    if (error.message.includes('quota') || error.message.includes('quotaExceeded')) {
      console.error('YouTube API 할당량 초과 감지');
      
      const availableKeys = apiKeyManager.apiKeys.filter(key => !key.quotaExceeded);
      const totalKeys = apiKeyManager.apiKeys.length;
      const exhaustedKeys = totalKeys - availableKeys.length;
      
      if (availableKeys.length > 0) {
        console.log(`사용 가능한 API 키가 ${availableKeys.length}개 남아있음, 이 오류는 내부 처리 중 발생한 일시적 오류입니다.`);
        
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

app.get('/api/download-thumbnail', async (req, res) => {
  try {
    const { url, filename } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL이 필요합니다.' });
    }

    const response = await axios.get(url, { responseType: 'stream' });
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'thumbnail.jpg'}"`);
    res.setHeader('Content-Type', 'image/jpeg');
    
    response.data.pipe(res);

  } catch (error) {
    console.error('썸네일 다운로드 오류:', error);
    res.status(500).json({ error: '썸네일 다운로드에 실패했습니다.' });
  }
});

app.post('/api/download-excel', async (req, res) => {
  try {
    const { searchResults, searchParams } = req.body;
    
    if (!searchResults || !Array.isArray(searchResults)) {
      return res.status(400).json({ error: '검색 결과 데이터가 필요합니다.' });
    }

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

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);

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

    XLSX.utils.book_append_sheet(workbook, worksheet, 'YouTube 검색 결과');

    const excelBuffer = XLSX.write(workbook, { 
      type: 'buffer', 
      bookType: 'xlsx',
      compression: true 
    });

    const now = new Date();
    const kstTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const timestamp = kstTime.toISOString().slice(0, 19).replace(/:/g, '-');
    const keyword = searchParams?.keyword || '전체';
    const country = searchParams?.country || 'worldwide';
    const resultCount = searchResults.length;
    
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

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', excelBuffer.length);

    res.send(excelBuffer);

    console.log(`✅ Excel 파일 생성 완료: ${filename} (${searchResults.length}행)`);

  } catch (error) {
    console.error('Excel 다운로드 오류:', error);
    res.status(500).json({ error: 'Excel 파일 생성에 실패했습니다.' });
  }
});

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

function formatSubscriberCountForExcel(count) {
  if (!count || count === 0) {
    return '0';
  }
  
  const number = parseInt(count);
  const inTenThousands = number / 10000;
  
  if (number < 10000) {
    return inTenThousands.toFixed(2);
  } else if (number < 100000) {
    return inTenThousands.toFixed(1);
  } else {
    return Math.round(inTenThousands).toString();
  }
}

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

function getCountryCode(country) {
  const countryMap = {
    'worldwide': null,
    'korea': 'KR',
    'usa': 'US',
    'japan': 'JP',
    'china': null,
    'uk': 'GB',
    'germany': 'DE',
    'france': 'FR',
    'canada': 'CA',
    'australia': 'AU',
    'india': 'IN',
    'brazil': 'BR',
    'mexico': 'MX',
    'russia': null,
    'italy': 'IT',
    'spain': 'ES'
  };
  
  const code = countryMap[country.toLowerCase()];
  
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
  
  return code && validRegionCodes.includes(code) ? code : null;
}

function getLanguageCode(country) {
  const languageMap = {
    'worldwide': 'en',
    'korea': 'ko',
    'usa': 'en',
    'japan': 'ja',
    'china': 'zh',
    'uk': 'en',
    'germany': 'de',
    'france': 'fr',
    'canada': 'en',
    'australia': 'en',
    'india': 'en',
    'brazil': 'pt',
    'mexico': 'es',
    'russia': 'en',
    'italy': 'it',
    'spain': 'es'
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

function parseDuration(duration) {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const matches = duration.match(regex);
  
  if (!matches) return 0;
  
  const hours = parseInt(matches[1]) || 0;
  const minutes = parseInt(matches[2]) || 0;
  const seconds = parseInt(matches[3]) || 0;
  
  return hours * 3600 + minutes * 60 + seconds;
}

function getVideoLengthCategory(durationInSeconds) {
  if (durationInSeconds < 60) return 'short1';
  if (durationInSeconds < 120) return 'short2';
  if (durationInSeconds < 600) return 'mid1';
  if (durationInSeconds < 1200) return 'mid2';
  if (durationInSeconds < 1800) return 'long1';
  if (durationInSeconds < 2400) return 'long2';
  if (durationInSeconds < 3000) return 'long3';
  if (durationInSeconds < 3600) return 'long4';
  if (durationInSeconds < 5400) return 'long5';
  return 'long6';
}

function matchesVideoLength(videoLengthCategory, selectedLengths) {
  if (!selectedLengths || selectedLengths.length === 0) return true;
  return selectedLengths.includes(videoLengthCategory);
}

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

app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`브라우저에서 http://localhost:${PORT} 를 열어주세요.`);
});