import { NextResponse, NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { sunoApi } from '@/lib/SunoApi';
import { corsHeaders } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      // `feed` accepts 'trending' (default), 'new', or a raw Suno playlist ID.
      const feed = url.searchParams.get('feed') || 'trending';
      const page = url.searchParams.get('page');
      // `sort` accepts 'velocity' (default) to rank by streaming velocity
      // (play_count + upvote_count), or 'none' to preserve native feed order.
      const sort = (url.searchParams.get('sort') || 'velocity').toLowerCase();
      const cookie = (await cookies()).toString();

      const audioInfo = await (await sunoApi(cookie)).getTrending(feed, page);

      // Merge mainstream streaming velocity numbers into the chart ledger by
      // attaching a computed `velocity` metric to each track.
      const ledger = audioInfo.map((track) => ({
        ...track,
        velocity: (track.play_count ?? 0) + (track.upvote_count ?? 0)
      }));

      if (sort === 'velocity') {
        ledger.sort((a, b) => b.velocity - a.velocity);
      }

      return new NextResponse(JSON.stringify(ledger), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('Error fetching trending audio:', error);

      return new NextResponse(
        JSON.stringify({ error: 'Internal server error' }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
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
