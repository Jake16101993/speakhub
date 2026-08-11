
function dateYmd(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function supabaseRest(url,key,path,options={}){
  const res=await fetch(`${url}/rest/v1/${path}`,{
    ...options,
    headers:{
      apikey:key,
      Authorization:`Bearer ${key}`,
      'Content-Type':'application/json',
      Prefer: options.prefer || '',
      ...(options.headers||{})
    }
  });

  let data=null;
  const text=await res.text();
  if(text){
    try{ data=JSON.parse(text) }catch{ data=text }
  }

  if(!res.ok){
    throw new Error(typeof data==='string'?data:JSON.stringify(data));
  }
  return data;
}

async function materializeRecurringSessions(supabaseUrl,secretKey){
  if(!secretKey)return;

  const seeds=await supabaseRest(
    supabaseUrl,
    secretKey,
    'class_sessions?select=id,program_id,location_id,session_date,session_period,starts_at,ends_at,room_id,teacher_id,capacity,status,is_recurring,recurrence_source_id&is_recurring=eq.true&recurrence_source_id=is.null',
    {method:'GET'}
  );

  const today=new Date();
  today.setHours(0,0,0,0);
  const horizon=new Date(today);
  horizon.setMonth(horizon.getMonth()+3);

  for(const seed of seeds||[]){
    let cursor=new Date(`${seed.session_date}T00:00:00`);
    if(Number.isNaN(cursor.getTime()))continue;

    while(cursor<today) cursor.setDate(cursor.getDate()+7);

    const dates=[];
    for(let d=new Date(cursor); d<=horizon; d.setDate(d.getDate()+7)){
      dates.push(dateYmd(d));
    }
    if(!dates.length)continue;

    const minDate=dates[0];
    const maxDate=dates[dates.length-1];

    const existing=await supabaseRest(
      supabaseUrl,
      secretKey,
      `class_sessions?select=session_date,starts_at,ends_at&program_id=eq.${encodeURIComponent(seed.program_id)}&session_date=gte.${minDate}&session_date=lte.${maxDate}`,
      {method:'GET'}
    );

    const keys=new Set((existing||[]).map(x=>
      `${x.session_date}|${String(x.starts_at).slice(0,5)}|${String(x.ends_at).slice(0,5)}`
    ));

    const children=dates
      .filter(date=>date!==seed.session_date)
      .filter(date=>!keys.has(`${date}|${String(seed.starts_at).slice(0,5)}|${String(seed.ends_at).slice(0,5)}`))
      .map(date=>({
        program_id:seed.program_id,
        location_id:seed.location_id,
        session_date:date,
        session_period:seed.session_period,
        starts_at:seed.starts_at,
        ends_at:seed.ends_at,
        room_id:seed.room_id,
        teacher_id:seed.teacher_id,
        capacity:seed.capacity,
        status:seed.status||'OPEN',
        is_recurring:true,
        recurrence_source_id:seed.id
      }));

    if(children.length){
      await supabaseRest(
        supabaseUrl,
        secretKey,
        'class_sessions',
        {
          method:'POST',
          body:JSON.stringify(children),
          prefer:'return=minimal'
        }
      );
    }
  }
}

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

      // PERFORMANCE:
      // Do not materialize recurring sessions during public reads.
      // Recurring rows must be generated when admin creates/updates the schedule,
      // not every time a user opens the booking calendar.
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
