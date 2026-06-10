import { NextResponse, NextRequest } from 'next/server';
import { spotifyApi } from '@/lib/SpotifyApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      // mode: 'search' (default) builds a popularity-ranked chart proxy that
      // works with standard credentials. 'playlist' targets an editorial/raw
      // playlist (Top 50 / Viral 50 require grandfathered Spotify access).
      const mode = (url.searchParams.get('mode') || 'search').toLowerCase();
      const market = url.searchParams.get('market');

      let chartData;
      if (mode === 'playlist') {
        const chart = url.searchParams.get('chart') || 'top-50-global';
        chartData = await spotifyApi.getChart(chart, market);
      } else {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const year = url.searchParams.get('year');
        chartData = await spotifyApi.getChartBySearch(market, limit, year);
      }

      return new NextResponse(JSON.stringify(chartData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error: any) {
      console.error('Error fetching Spotify chart:', error);

      const message =
        typeof error?.message === 'string'
          ? error.message
          : 'Internal server error';

      // Surface credential/config issues as 500, upstream Spotify blocks as 502.
      const isConfigError = message.includes('environment variable');
      const status = isConfigError ? 500 : 502;

      return new NextResponse(JSON.stringify({ error: message }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'GET',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
