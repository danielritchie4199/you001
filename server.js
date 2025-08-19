const express = require('express');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
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
      
      // 다음 사용 가능한 키로 전환
      const nextKey = this.apiKeys.find(keyInfo => !keyInfo.quotaExceeded);
      if (nextKey) {
        console.log(`🔄 ${nextKey.name}으로 전환합니다.`);
        return true; // 전환 성공
      } else {
        console.log('⚠️ 사용 가능한 API 키가 없습니다.');
        return false; // 전환 실패
      }
    }
    return false;
  }
  
  // 사용 통계 출력
  printUsageStats() {
    console.log('\n📊 API 키 사용 통계:');
    this.apiKeys.forEach(keyInfo => {
      const status = keyInfo.quotaExceeded ? '❌ 할당량 초과' : '✅ 사용 가능';
      const lastUsed = keyInfo.lastUsed ? keyInfo.lastUsed.toLocaleString() : '미사용';
      console.log(`   ${keyInfo.name}: ${status} | 사용횟수: ${keyInfo.usageCount} | 마지막 사용: ${lastUsed}`);
    });
  }
}

// API 키 매니저 인스턴스 생성
const apiKeyManager = new ApiKeyManager();

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors());
app.use(express.json());
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
      videoLength,
      maxResults = 60   // 기본값 60건
    } = req.query;

    // maxResults 유효성 검사 및 변환
    const allowedResults = [60, 100, 150, 200];
    const parsedMaxResults = parseInt(maxResults);
    const finalMaxResults = allowedResults.includes(parsedMaxResults) ? parsedMaxResults : 60;

    console.log('검색 파라미터:', req.query);
    console.log('선택된 국가:', country);
    console.log(`검색 결과 수: ${finalMaxResults}건 (요청: ${maxResults})`);

    // 동영상 길이 파라미터 파싱
    const selectedVideoLengths = videoLength ? videoLength.split(',') : [];
    console.log('선택된 동영상 길이:', selectedVideoLengths);

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
    console.log('4. 최종 YouTube API 검색 파라미터:', {
      regionCode: searchParams.regionCode || '없음 (전세계 검색)',
      relevanceLanguage: searchParams.relevanceLanguage,
      country: country,
      keyword: keyword || '키워드 없음',
      order: searchParams.order,
      type: searchParams.type,
      isWorldwide: country === 'worldwide'
    });
    console.log('===========================');

    // 키워드 설정
    const isEmptyKeyword = !keyword || !keyword.trim();
    
    if (!isEmptyKeyword) {
      searchParams.q = keyword.trim();
      console.log(`키워드 검색: "${keyword.trim()}"`);
    } else {
      // 키워드가 없을 때는 조회수가 높은 인기 동영상 검색
      console.log('키워드 없음: 인기 동영상 검색 (조회수 높은 순)');
      
      // YouTube API에서 키워드 없이 검색하기 위해 매우 일반적인 단어들 사용
      // 이렇게 하면 거의 모든 동영상이 매칭되어 조회수 순으로 정렬됨
      const broadSearchTerms = ['a', 'the', 'and', 'or', 'video', 'youtube'];
      const randomTerm = broadSearchTerms[Math.floor(Math.random() * broadSearchTerms.length)];
      searchParams.q = randomTerm;
      
      // 조회수 정렬을 확실히 설정
      searchParams.order = 'viewCount';
      
      console.log(`인기 동영상 검색용 광범위 검색어: "${randomTerm}"`);
      console.log('설정: 조회수 높은 순서로 정렬');
    }

    // 업로드 기간 설정
    if (uploadPeriod) {
      const { publishedAfter, publishedBefore } = getDateRange(uploadPeriod);
      if (publishedAfter) searchParams.publishedAfter = publishedAfter;
      if (publishedBefore) searchParams.publishedBefore = publishedBefore;
    }

    // 동영상 길이 설정 (YouTube API는 'short', 'medium', 'long'만 지원하므로 후처리에서 필터링)
    // videoLength 파라미터는 클라이언트에서 받아서 결과 필터링에 사용

    // 선택한 수만큼 결과 수집
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
          
          if (apiKeyManager.markKeyAsQuotaExceeded(currentApiKey)) {
            console.log('🔄 다른 API 키로 재시도합니다...');
            try {
              const youtube = apiKeyManager.getYouTubeInstance();
              response = await youtube.search.list(searchParams);
              console.log('✅ 다른 API 키로 성공');
            } catch (retryError) {
              if (retryError.message.includes('quota') || retryError.message.includes('quotaExceeded')) {
                console.log('❌ 모든 API 키의 할당량이 초과되었습니다.');
                throw retryError;
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
          if (apiKeyManager.markKeyAsQuotaExceeded(currentDetailKey)) {
            console.log('🔄 다른 API 키로 비디오 상세정보 재시도...');
            const youtube = apiKeyManager.getYouTubeInstance();
            videoDetails = await youtube.videos.list({
              part: 'snippet,statistics,contentDetails',
              id: videoIds.join(',')
            });
            console.log('✅ 다른 API 키로 비디오 상세정보 조회 성공');
          } else {
            throw detailError;
          }
        } else {
          throw detailError;
        }
      }

      // 검색 결과 처리
      for (const video of videoDetails.data.items) {
        const viewCount = parseInt(video.statistics.viewCount || 0);
        
        // 조회수 필터링
        if (minViews && viewCount < parseInt(minViews)) continue;
        if (maxViews && viewCount > parseInt(maxViews)) continue;

        // 동영상 길이 필터링
        const durationInSeconds = parseDuration(video.contentDetails.duration);
        const videoLengthCategory = getVideoLengthCategory(durationInSeconds);
        
        if (!matchesVideoLength(videoLengthCategory, selectedVideoLengths)) continue;

        const result = {
          youtube_channel_name: video.snippet.channelTitle,
          thumbnail_url: video.snippet.thumbnails.medium?.url || video.snippet.thumbnails.default?.url,
          status: 'active',
          youtube_channel_id: video.snippet.channelId,
          primary_category: await getCategoryName(video.snippet.categoryId),
          status_date: video.snippet.publishedAt,
          daily_view_count: viewCount,
          vod_url: `https://www.youtube.com/watch?v=${video.id}`,
          video_id: video.id,
          title: video.snippet.title,
          description: video.snippet.description,
          duration: video.contentDetails.duration,
          duration_seconds: durationInSeconds,
          video_length_category: videoLengthCategory
        };

        searchResults.push(result);
        
        if (searchResults.length >= finalMaxResults) break;
      }

      nextPageToken = response.data.nextPageToken;
      if (!nextPageToken) break;

      // API 호출 제한을 위한 지연 (quota 절약)
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // 조회수 기준 내림차순 정렬
    searchResults.sort((a, b) => b.daily_view_count - a.daily_view_count);

    console.log(`검색 완료: ${searchResults.length}개 결과`);
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
  if (durationInSeconds < 120) return 'short';        // 2분 미만
  if (durationInSeconds < 600) return 'mid';          // 2분 이상 10분 미만
  if (durationInSeconds < 1800) return 'long1';      // 10분 이상 30분 미만
  return 'long2';                                     // 30분 이상
}

// 선택된 길이 카테고리와 매치되는지 확인
function matchesVideoLength(videoLengthCategory, selectedLengths) {
  if (!selectedLengths || selectedLengths.length === 0) return true;
  return selectedLengths.includes(videoLengthCategory);
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