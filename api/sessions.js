export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const program = url.searchParams.get('program') || url.searchParams.get('program_code');

      if (!from || !to) {
        return Response.json(
          { error: 'Missing required query params: from, to' },
          { status: 400 }
        );
      }

      // Hard limit: public/session clients cannot query beyond 3 calendar months from today.
      const today = new Date();
      today.setHours(0,0,0,0);
      const maxDate = new Date(today);
      maxDate.setMonth(maxDate.getMonth()+3);

      const requestedFrom = new Date(`${from}T00:00:00`);
      const requestedTo = new Date(`${to}T00:00:00`);

      if(Number.isNaN(requestedFrom.getTime()) || Number.isNaN(requestedTo.getTime())){
        return Response.json({error:'Invalid date range'},{status:400});
      }
      if(requestedTo > maxDate){
        return Response.json(
          {error:'MAX_3_MONTHS',details:'Sessions can only be viewed up to 3 months ahead.'},
          {status:400}
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
