export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const program = url.searchParams.get('program');

      if (!from || !to) {
        return Response.json(
          { error: 'Missing required query params: from, to' },
          { status: 400 }
        );
      }

      const supabaseUrl = process.env.SUPABASE_URL;
      const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

      if (!supabaseUrl || !publishableKey) {
        return Response.json(
          { error: 'Supabase environment variables are missing' },
          { status: 500 }
        );
      }

      const response = await fetch(
        `${supabaseUrl}/rest/v1/rpc/get_public_sessions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: publishableKey,
            Authorization: `Bearer ${publishableKey}`
          },
          body: JSON.stringify({
            p_from: from,
            p_to: to,
            p_program_code: program || null
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        console.error('Supabase RPC error:', data);
        return Response.json(
          { error: 'Could not load sessions', details: data },
          { status: 500 }
        );
      }

      return Response.json(
        { sessions: data },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60'
          }
        }
      );
    } catch (error) {
      console.error(error);
      return Response.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
  }
};
