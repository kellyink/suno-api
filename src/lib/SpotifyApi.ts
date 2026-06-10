import pino from 'pino';

const logger = pino();

const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

/**
 * Well-known Spotify editorial playlist IDs for global charts.
 * NOTE: Spotify restricted Web API access to editorial/algorithmic playlists
 * for apps in development mode (late 2024). These may return 404 unless your
 * app has been granted extended access.
 */
export const SPOTIFY_CHART_PLAYLISTS: Record<string, string> = {
  'top-50-global': '37i9dQZEVXbMDoHDwVN2tF',
  'viral-50-global': '37i9dQZEVXbLiRSasKsNU9'
};

export interface SpotifyTrackInfo {
  rank: number; // Position within the playlist (1-based)
  id: string; // Spotify track ID
  name: string; // Track title
  artists: string[]; // Artist name(s)
  album: string; // Album name
  image_url: string | null; // Album cover art
  popularity: number; // Spotify popularity score (0-100) — streaming velocity proxy
  duration_ms: number; // Track duration in milliseconds
  explicit: boolean; // Explicit content flag
  preview_url: string | null; // 30s audio preview
  external_url: string | null; // Open in Spotify
  added_at: string | null; // When the track entered the playlist
}

export interface SpotifyChartResult {
  playlist_id: string;
  playlist_name: string;
  snapshot_id: string;
  total: number;
  fetched_at: string;
  tracks: SpotifyTrackInfo[];
}

/**
 * Minimal Spotify Web API client using the Client Credentials flow.
 * This flow only accesses public catalog/playlist data and requires no user login.
 */
class SpotifyApi {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * Retrieves (and caches) an app access token via the Client Credentials flow.
   */
  private async getAccessToken(): Promise<string> {
    // Reuse the cached token until ~30s before expiry.
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(
        'Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET environment variables.'
      );
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch(SPOTIFY_ACCOUNTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      cache: 'no-store'
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Spotify token request failed (${response.status}): ${detail}`
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    logger.info('Obtained Spotify access token');

    return this.accessToken;
  }

  /**
   * Fetches a global chart playlist and normalizes it into ranked track data.
   * @param chart 'top-50-global' (default), 'viral-50-global', or a raw playlist ID.
   * @param market Optional ISO 3166-1 alpha-2 market code (e.g. 'US').
   */
  public async getChart(
    chart = 'top-50-global',
    market?: string | null
  ): Promise<SpotifyChartResult> {
    const token = await this.getAccessToken();
    const playlistId = SPOTIFY_CHART_PLAYLISTS[chart.toLowerCase()] ?? chart;

    const url = new URL(`${SPOTIFY_API_BASE}/playlists/${playlistId}`);
    url.searchParams.set(
      'fields',
      'name,snapshot_id,tracks(total,items(added_at,track(id,name,popularity,duration_ms,explicit,preview_url,external_urls(spotify),album(name,images),artists(name))))'
    );
    if (market) {
      url.searchParams.set('market', market);
    }

    logger.info('Fetching Spotify chart: ' + url.href);
    const response = await fetch(url.href, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Spotify playlist request failed (${response.status}): ${detail}`
      );
    }

    const data = await response.json();
    const items: any[] = data.tracks?.items ?? [];

    const tracks: SpotifyTrackInfo[] = items
      .filter((item) => item.track)
      .map((item, index) => {
        const track = item.track;
        return {
          rank: index + 1,
          id: track.id,
          name: track.name,
          artists: (track.artists ?? []).map((a: any) => a.name),
          album: track.album?.name ?? '',
          image_url: track.album?.images?.[0]?.url ?? null,
          popularity: track.popularity ?? 0,
          duration_ms: track.duration_ms ?? 0,
          explicit: Boolean(track.explicit),
          preview_url: track.preview_url ?? null,
          external_url: track.external_urls?.spotify ?? null,
          added_at: item.added_at ?? null
        };
      });

    return {
      playlist_id: playlistId,
      playlist_name: data.name ?? '',
      snapshot_id: data.snapshot_id ?? '',
      total: data.tracks?.total ?? tracks.length,
      fetched_at: new Date().toISOString(),
      tracks
    };
  }

  /**
   * Builds a chart proxy by searching the public catalog and ranking tracks by
   * Spotify's `popularity` score (0-100). This avoids the editorial-playlist
   * access restriction (Top 50 / Viral 50 return 403 for non-grandfathered apps)
   * while still surfacing mainstream streaming velocity.
   *
   * @param market Optional ISO 3166-1 alpha-2 market code (e.g. 'US').
   * @param limit  Number of ranked tracks to return (default 50, max 50).
   * @param year   Catalog year to sample (default: current year).
   */
  public async getChartBySearch(
    market?: string | null,
    limit = 50,
    year?: string | null
  ): Promise<SpotifyChartResult> {
    const token = await this.getAccessToken();
    const topN = Math.min(Math.max(limit, 1), 50);
    const sampleYear = year || String(new Date().getFullYear());

    // Spotify search caps offset+limit at 1000; sample up to 200 tracks
    // across 4 pages, then rank by popularity to build the chart proxy.
    const pageSize = 50;
    const pages = 4;
    const collected = new Map<string, any>();

    for (let page = 0; page < pages; page++) {
      const url = new URL(`${SPOTIFY_API_BASE}/search`);
      url.searchParams.set('q', `year:${sampleYear}`);
      url.searchParams.set('type', 'track');
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('offset', String(page * pageSize));
      if (market) {
        url.searchParams.set('market', market);
      }

      const response = await fetch(url.href, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store'
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Spotify search request failed (${response.status}): ${detail}`
        );
      }

      const data = await response.json();
      const items: any[] = data.tracks?.items ?? [];
      for (const track of items) {
        if (track?.id && !collected.has(track.id)) {
          collected.set(track.id, track);
        }
      }

      // Stop early if Spotify returned a short final page.
      if (items.length < pageSize) {
        break;
      }
    }

    logger.info(
      `Spotify search proxy collected ${collected.size} tracks for year:${sampleYear}`
    );

    const ranked = Array.from(collected.values())
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
      .slice(0, topN);

    const tracks: SpotifyTrackInfo[] = ranked.map((track, index) => ({
      rank: index + 1,
      id: track.id,
      name: track.name,
      artists: (track.artists ?? []).map((a: any) => a.name),
      album: track.album?.name ?? '',
      image_url: track.album?.images?.[0]?.url ?? null,
      popularity: track.popularity ?? 0,
      duration_ms: track.duration_ms ?? 0,
      explicit: Boolean(track.explicit),
      preview_url: track.preview_url ?? null,
      external_url: track.external_urls?.spotify ?? null,
      added_at: null
    }));

    return {
      playlist_id: `search:year:${sampleYear}${market ? ':' + market : ''}`,
      playlist_name: `Popularity Chart Proxy (${sampleYear}${
        market ? ', ' + market : ', Global'
      })`,
      snapshot_id: '',
      total: tracks.length,
      fetched_at: new Date().toISOString(),
      tracks
    };
  }
}

// Single shared instance so the access token is cached across requests.
export const spotifyApi = new SpotifyApi();
