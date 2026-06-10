import { NextResponse, NextRequest } from 'next/server';
import { spotifyApi } from '@/lib/SpotifyApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      // `chart` accepts 'top-50-global' (default), 'viral-50-global', or a raw playlist ID.
      const chart = url.searchParams.get('chart') || 'top-50-global';
      const market = url.searchParams.get('market');

      const chartData = await spotifyApi.getChart(chart, market);

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
