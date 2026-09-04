const http = require('http');
const https = require('https');
const url = require('url');

/**
 * PIXEL DECK - Catalog Search Handler
 * 
 * Primary: Queries internal ytmusicapi Python microservice (port 5005) when available.
 * Fallback: Queries YouTube Music Innertube API directly via HTTPS in Node.js.
 * This ensures the search works seamlessly both in local development (with Python service)
 * and in serverless/cloud environments (e.g. Vercel, Netlify) without any external daemon.
 */

const PYTHON_SERVICE_PORT = process.env.SEARCH_SERVICE_PORT || 5005;
const PYTHON_SERVICE_HOST = '127.0.0.1';

// In-memory TTL Cache (10 minutes)
const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCached(key) {
  const item = searchCache.get(key);
  if (item && (Date.now() - item.timestamp < CACHE_TTL_MS)) {
    return item.data;
  }
  if (item) {
    searchCache.delete(key);
  }
  return null;
}

function setCached(key, data) {
  // CRITICAL RULE: Never cache empty or error results to prevent sticky broken states
  if (!data || data.status !== 'success' || !Array.isArray(data.results) || data.results.length === 0) {
    return;
  }

  // Cap cache size at 250 items
  if (searchCache.size > 250) {
    const oldestKey = searchCache.keys().next().value;
    searchCache.delete(oldestKey);
  }

  searchCache.set(key, {
    timestamp: Date.now(),
    data: data
  });
}

/**
 * Query local Python ytmusicapi microservice on port 5005
 */
function queryPythonMicroservice(query, page, limit) {
  return new Promise((resolve, reject) => {
    const searchPath = `/search?query=${encodeURIComponent(query)}&page=${page}&limit=${limit}`;
    const options = {
      hostname: PYTHON_SERVICE_HOST,
      port: PYTHON_SERVICE_PORT,
      path: searchPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ statusCode: res.statusCode, data: json });
        } catch (parseErr) {
          reject(new Error(`Failed to parse microservice response: ${parseErr.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Search microservice timeout after 8s'));
    });

    req.end();
  });
}

/**
 * Direct Node.js YouTube Music Innertube API Client
 * Used as fallback for Vercel/cloud deployments or when Python service is offline.
 */
function queryYouTubeMusicDirect(query, page = 1, limit = 20) {
  return new Promise((resolve, reject) => {
    const payload = {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20240801.01.00',
          hl: 'en',
          gl: 'US'
        }
      },
      query: query
    };

    const postData = JSON.stringify(payload);

    const options = {
      hostname: 'music.youtube.com',
      port: 443,
      path: '/youtubei/v1/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://music.youtube.com/',
        'Origin': 'https://music.youtube.com'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tracks = [];
          const seenIds = new Set();

          const tabs = data.contents?.tabbedSearchResultsRenderer?.tabs;
          const sections = tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

          for (const sec of sections) {
            // 1. Top result banner (musicCardShelfRenderer)
            if (sec.musicCardShelfRenderer) {
              const card = sec.musicCardShelfRenderer;
              const videoId = card.onTap?.watchEndpoint?.videoId || 
                              card.buttons?.[0]?.buttonRenderer?.command?.watchEndpoint?.videoId;
              const title = card.title?.runs?.map(r => r.text).join('') || '';
              const subtitleRuns = card.subtitle?.runs || [];
              const subtitleText = subtitleRuns.map(r => r.text).join('');
              
              if (videoId && !seenIds.has(videoId)) {
                seenIds.add(videoId);
                const artistRun = subtitleRuns.find(r => r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST');
                const artist = artistRun ? artistRun.text : (subtitleText.split('•')[1] || 'Official Artist').trim();
                
                const thumbs = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
                const artwork = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

                tracks.push({
                  id: `ytm_${videoId}`,
                  provider: 'youtube',
                  providerTrackId: videoId,
                  title: title,
                  artist: artist,
                  album: 'Official Release',
                  duration: 210,
                  durationFormatted: '03:30',
                  artwork: artwork.replace(/=w\d+-h\d+.*$/, '=w500-h500-l90-rj'),
                  streamUrl: null,
                  isOfficial: true,
                  audioQuality: 'high',
                  source: 'ytmusic_direct'
                });
              }
            }

            // 2. Shelf items (itemSectionRenderer)
            if (sec.itemSectionRenderer?.contents) {
              for (const c of sec.itemSectionRenderer.contents) {
                const item = c.musicResponsiveListItemRenderer;
                if (!item) continue;

                const videoId = item.playlistItemData?.videoId;
                if (!videoId || seenIds.has(videoId)) continue;

                const titleCol = item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
                const title = titleCol?.map(r => r.text).join('') || 'Unknown Title';

                const subCols = item.flexColumns?.slice(1) || [];
                let artist = '';
                let album = 'Official Release';
                let durationFormatted = '03:30';
                let durationSeconds = 210;

                for (const col of subCols) {
                  const runs = col.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
                  for (const r of runs) {
                    const pageType = r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
                    if (pageType === 'MUSIC_PAGE_TYPE_ARTIST') {
                      if (!artist) artist = r.text;
                    } else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM') {
                      album = r.text;
                    } else if (/^\d+:\d+$/.test(r.text.trim())) {
                      durationFormatted = r.text.trim();
                      const parts = durationFormatted.split(':').map(Number);
                      durationSeconds = (parts[0] * 60) + parts[1];
                    }
                  }
                }

                if (!artist) {
                  const fullSub = subCols.map(col => col.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text).join('')).join(' • ');
                  const parts = fullSub.split('•').map(s => s.trim());
                  if (parts.length > 1) artist = parts[1];
                  else artist = 'Official Artist';
                }

                const thumbs = item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
                const artwork = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

                seenIds.add(videoId);
                tracks.push({
                  id: `ytm_${videoId}`,
                  provider: 'youtube',
                  providerTrackId: videoId,
                  title: title,
                  artist: artist,
                  album: album,
                  duration: durationSeconds,
                  durationFormatted: durationFormatted,
                  artwork: artwork.replace(/=w\d+-h\d+.*$/, '=w500-h500-l90-rj'),
                  streamUrl: null,
                  isOfficial: true,
                  audioQuality: 'high',
                  source: 'ytmusic_direct'
                });
              }
            }
          }

          // Apply pagination slicing
          const offset = Math.max(0, (page - 1) * limit);
          const results = tracks.slice(offset, offset + limit);

          resolve({
            status: 'success',
            query: query,
            page: page,
            limit: limit,
            total: tracks.length,
            results: results
          });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Direct YouTube Music request timeout after 10s'));
    });
    req.write(postData);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const query = (req.query && (req.query.query || req.query.q || '')).trim();
  const page = Math.max(1, parseInt((req.query && req.query.page) || '1', 10));
  const limit = Math.min(50, Math.max(5, parseInt((req.query && req.query.limit) || '20', 10)));

  if (!query) {
    return res.status(400).json({
      status: 'error',
      code: 'MISSING_QUERY',
      message: 'Query parameter is required',
      results: []
    });
  }

  // Normalized cache key: lowercase trimmed query + page + limit
  const cacheKey = `${query.toLowerCase()}_p${page}_l${limit}`;
  const cachedData = getCached(cacheKey);
  if (cachedData) {
    return res.status(200).json(cachedData);
  }

  // 1. Try internal Python microservice first (port 5005)
  try {
    const response = await queryPythonMicroservice(query, page, limit);

    if (response.statusCode === 200 && response.data && response.data.status === 'success' && Array.isArray(response.data.results) && response.data.results.length > 0) {
      setCached(cacheKey, response.data);
      return res.status(200).json(response.data);
    }
  } catch (err) {
    // Python service unavailable or error (common in Vercel / serverless deployments)
    console.warn(`[SearchProxy] Python microservice unavailable on port ${PYTHON_SERVICE_PORT} (${err.message}). Falling back to direct YouTube Music engine...`);
  }

  // 2. Seamless fallback: Direct YouTube Music Innertube search in Node.js
  try {
    const directData = await queryYouTubeMusicDirect(query, page, limit);
    if (directData && directData.status === 'success' && Array.isArray(directData.results) && directData.results.length > 0) {
      setCached(cacheKey, directData);
      return res.status(200).json(directData);
    }
  } catch (directErr) {
    console.error(`[SearchProxy] Direct YouTube Music fallback error:`, directErr.message);
  }

  // If both engines returned empty or failed
  return res.status(200).json({
    status: 'success',
    query: query,
    page: page,
    limit: limit,
    total: 0,
    results: []
  });
};
