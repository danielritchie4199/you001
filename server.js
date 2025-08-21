const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const XLSX = require('xlsx');
require('dotenv').config();

// 다중 API 키 관리 시스템
class ApiKeyManager {
  constructor() {
    // 환경변수에서 여러 API 키 수집
    this.apiKeys = [];
    this.currentKeyIndex = 0;
    this.keyUsageCount = {};
    this.keyQuotaExceeded = {};
    
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
          lastUsed: null
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
  
  // 현재 사용 가능한 API 키 반환
  getCurrentKey() {
    // 할당량 초과되지 않은 키 찾기
    let availableKey = this.apiKeys.find(keyInfo => !keyInfo.quotaExceeded);
    
    if (!availableKey) {
      console.log('⚠️ 모든 API 키의 할당량이 초과되었습니다. 첫 번째 키로 재시도합니다.');
      // 모든 키가 초과된 경우 첫 번째 키 사용 (다음 날까지 대기)
      availableKey = this.apiKeys[0];
    } else {
      // 사용 가능한 키가 있으면 현재 인덱스 업데이트
      this.currentKeyIndex = availableKey.index - 1;
      console.log(`🔑 현재 사용 가능한 키: ${availableKey.name} (인덱스: ${this.currentKeyIndex + 1})`);
    }
    
    return availableKey;
  }
  
  // 현재 YouTube API 인스턴스 반환
  getYouTubeInstance() {
    const currentKey = this.getCurrentKey();
    currentKey.usageCount++;
    currentKey.lastUsed = new Date();
    
    console.log(`🔑 사용 중인 API 키: ${currentKey.name} (사용횟수: ${currentKey.usageCount})`);
    
    return google.youtube({ version: 'v3', auth: currentKey.key });
  }
  
  // 할당량 초과 처리
  markKeyAsQuotaExceeded(currentKey) {
    if (currentKey) {
      currentKey.quotaExceeded = true;
      console.log(`❌ ${currentKey.name} 할당량 초과로 비활성화됨`);
      
      // 다음 사용 가능한 키 찾기 (현재 키 제외)
      const nextKey = this.apiKeys.find(keyInfo => 
        keyInfo.index !== currentKey.index && !keyInfo.quotaExceeded
      );
      
      if (nextKey) {
        console.log(`🔄 ${nextKey.name}으로 전환합니다.`);
        // 현재 키 인덱스 업데이트
        this.currentKeyIndex = nextKey.index - 1;
        return nextKey; // 전환된 키 반환
      } else {
        console.log('⚠️ 사용 가능한 API 키가 없습니다.');
        return null; // 전환 실패
      }
    }
    return null;
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
      maxResults = 60   // 기본값 60건
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
       
       try {
         const youtube = apiKeyManager.getYouTubeInstance();
         response = await youtube.search.list(searchParams);
       } catch (apiError) {
        console.error('YouTube API 오류:', apiError.message);
        
                          // 할당량 초과 오류 처리
          if (apiError.message.includes('quota') || apiError.message.includes('quotaExceeded')) {
            console.log(`🚫 ${currentApiKey.name} 할당량 초과 감지`);
            
            const newApiKey = apiKeyManager.markKeyAsQuotaExceeded(currentApiKey);
            if (newApiKey) {
              console.log(`🔄 ${newApiKey.name}로 재시도합니다...`);
              try {
                // 새로운 API 키로 YouTube 인스턴스 직접 생성
                const youtube = google.youtube({ version: 'v3', auth: newApiKey.key });
                response = await youtube.search.list(searchParams);
                console.log(`✅ ${newApiKey.name}로 성공`);
              } catch (retryError) {
                if (retryError.message.includes('quota') || retryError.message.includes('quotaExceeded')) {
                  console.log(`❌ ${newApiKey.name}도 할당량 초과, 다음 키로 재시도...`);
                  // 재귀적으로 다음 키 시도
                  const nextKey = apiKeyManager.markKeyAsQuotaExceeded(newApiKey);
                  if (nextKey) {
                    console.log(`🔄 ${nextKey.name}로 재시도...`);
                    const youtube = google.youtube({ version: 'v3', auth: nextKey.key });
                    response = await youtube.search.list(searchParams);
                    console.log(`✅ ${nextKey.name}로 성공`);
                  } else {
                    console.log('❌ 모든 API 키의 할당량이 초과되었습니다.');
                    throw retryError;
                  }
                } else {
                  throw retryError;
                }
              }
            } else {
              throw apiError; // 사용 가능한 키가 없으면 오류 전파
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
          
          const youtube = apiKeyManager.getYouTubeInstance();
          response = await youtube.search.list(searchParams);
          console.log('  ✅ 전세계 검색으로 성공');
          console.log(`  ⚠️  주의: "${country}" 검색이 전세계 검색으로 변경되었습니다.`);
        } else {
          console.log('복구할 수 없는 API 오류:', apiError.message);
          throw apiError; // 다른 오류는 그대로 전파
        }
      }
      
      if (!response.data.items || response.data.items.length === 0) {
        break;
      }
      
      console.log(`API 응답: ${response.data.items.length}개 동영상 발견`);

      // 비디오 ID 수집
      const videoIds = response.data.items.map(item => item.id.videoId);
      
      // 비디오 상세 정보 가져오기 (조회수, 통계 포함)
      let videoDetails;
      try {
        const youtube = apiKeyManager.getYouTubeInstance();
        videoDetails = await youtube.videos.list({
          part: 'snippet,statistics,contentDetails',
          id: videoIds.join(',')
        });
                           } catch (detailError) {
          if (detailError.message.includes('quota') || detailError.message.includes('quotaExceeded')) {
            console.log('🚫 비디오 상세정보 조회 중 할당량 초과 감지');
            
            let currentDetailKey = apiKeyManager.getCurrentKey();
            const newDetailKey = apiKeyManager.markKeyAsQuotaExceeded(currentDetailKey);
            if (newDetailKey) {
              console.log(`🔄 ${newDetailKey.name}로 비디오 상세정보 재시도...`);
              
              try {
                const youtube = google.youtube({ version: 'v3', auth: newDetailKey.key });
                videoDetails = await youtube.videos.list({
                  part: 'snippet,statistics,contentDetails',
                  id: videoIds.join(',')
                });
                console.log(`✅ ${newDetailKey.name}로 비디오 상세정보 조회 성공`);
              } catch (retryDetailError) {
                if (retryDetailError.message.includes('quota') || retryDetailError.message.includes('quotaExceeded')) {
                  console.log(`❌ ${newDetailKey.name}도 할당량 초과, 다음 키로 재시도...`);
                  const nextDetailKey = apiKeyManager.markKeyAsQuotaExceeded(newDetailKey);
                  if (nextDetailKey) {
                    console.log(`🔄 ${nextDetailKey.name}로 비디오 상세정보 재시도...`);
                    const youtube = google.youtube({ version: 'v3', auth: nextDetailKey.key });
                    videoDetails = await youtube.videos.list({
                      part: 'snippet,statistics,contentDetails',
                      id: videoIds.join(',')
                    });
                    console.log(`✅ ${nextDetailKey.name}로 비디오 상세정보 조회 성공`);
                  } else {
                    throw retryDetailError;
                  }
                } else {
                  throw retryDetailError;
                }
              }
            } else {
              throw detailError;
            }
          } else {
            throw detailError;
          }
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
          thumbnail_url: video.snippet.thumbnails.medium?.url || video.snippet.thumbnails.default?.url,
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

     // 중복 제거 통계
     const totalProcessed = processedVideoIds.size + searchResults.length;
     const duplicatesRemoved = totalProcessed - searchResults.length;
     
     console.log(`검색 완료: ${searchResults.length}개 결과`);
     console.log(`🔄 중복 제거: ${duplicatesRemoved}개 중복 동영상 제거됨`);
     console.log(`📊 API 사용량: 검색 API ${Math.ceil(searchResults.length / 50)}회 + 상세정보 API ${Math.ceil(searchResults.length / 50)}회 (${finalMaxResults}건 요청 중 ${searchResults.length}건 결과)`);
     
     // API 키 사용 통계 출력
     apiKeyManager.printUsageStats();

    res.json({
      success: true,
      data: searchResults,
      total: searchResults.length
    });

  } catch (error) {
    console.error('검색 오류:', error);
    
    // API 키 사용 통계 출력 (오류 발생 시에도)
    apiKeyManager.printUsageStats();
    
    // YouTube API quota 초과 오류 처리
    if (error.message.includes('quota') || error.message.includes('quotaExceeded')) {
      console.error('YouTube API 할당량 초과');
      
      const availableKeys = apiKeyManager.apiKeys.filter(key => !key.quotaExceeded);
      const totalKeys = apiKeyManager.apiKeys.length;
      const exhaustedKeys = totalKeys - availableKeys.length;
      
      res.status(429).json({
        success: false,
        error: `YouTube API 일일 할당량을 초과했습니다. (${exhaustedKeys}/${totalKeys} 키 사용됨)`,
        errorType: 'quota_exceeded',
        details: availableKeys.length > 0 
          ? `${availableKeys.length}개의 추가 API 키가 사용 가능합니다.`
          : '모든 API 키의 할당량이 초과되었습니다. 내일 자동으로 할당량이 재설정됩니다.',
        keyStats: {
          total: totalKeys,
          available: availableKeys.length,
          exhausted: exhaustedKeys
        }
      });
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

// 썸네일 다운로드 API
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
    // 1만 미만인 경우 소수점 표시
    return inTenThousands.toFixed(2);
  } else if (number < 100000) {
    // 1만 이상 10만 미만인 경우 소수점 1자리
    return inTenThousands.toFixed(1);
  } else {
    // 10만 이상인 경우 정수로 표시
    return Math.round(inTenThousands).toString();
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

// 서버 시작
app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
  console.log(`브라우저에서 http://localhost:${PORT} 를 열어주세요.`);
});