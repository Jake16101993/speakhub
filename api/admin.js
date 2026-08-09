import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabase=createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

function signAdminToken(){
  const secret=process.env.SPEAKHUB_ADMIN_SECRET;
  if(!secret) throw new Error('ADMIN_SECRET_MISSING');
  const payload=Buffer.from(JSON.stringify({exp:Date.now()+8*60*60*1000})).toString('base64url');
  const sig=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function requireAdmin(request){
  const secret=process.env.SPEAKHUB_ADMIN_SECRET;
  if(!secret) return false;

  const auth=request.headers.get('authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const [payload,sig]=token.split('.');
  if(!payload||!sig) return false;

  const expected=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  if(sig.length!==expected.length) return false;

  try{
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return false;
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    return Number(data.exp)>Date.now();
  }catch{
    return false;
  }
}

function slug(s){
  return String(s||'topic')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-|-$/g,'')
    .slice(0,80) || 'topic';
}

async function handleLogin(request){
  if(request.method!=='POST'){
    return Response.json({error:'Method not allowed'},{status:405});
  }
  const body=await request.json().catch(()=>({}));
  const expected=process.env.SPEAKHUB_ADMIN_PASSWORD;
  if(!expected){
    return Response.json({error:'ADMIN_PASSWORD_MISSING'},{status:500});
  }
  if(String(body.password||'')!==expected){
    return Response.json({error:'INVALID_PASSWORD'},{status:401});
  }
  return Response.json({token:signAdminToken()});
}

async function handleOverview(){
  const [c,o,b,s]=await Promise.all([
    supabase.from('customers').select('*',{count:'exact',head:true}),
    supabase.from('orders').select('*',{count:'exact',head:true}).eq('payment_status','PAID'),
    supabase.from('bookings').select('*',{count:'exact',head:true}).eq('status','CONFIRMED'),
    supabase.from('class_sessions').select('*',{count:'exact',head:true}).eq('status','OPEN')
  ]);

  return Response.json({
    counts:{
      customers:c.count||0,
      paid_orders:o.count||0,
      confirmed_bookings:b.count||0,
      open_sessions:s.count||0
    }
  });
}

async function handleSessions(request){
  if(request.method==='GET'){
    const [
      {data:programs,error:pErr},
      {data:rooms,error:rErr},
      {data:sessions,error:sErr}
    ]=await Promise.all([
      supabase.from('programs').select('id,code,name').order('name'),
      supabase.from('rooms').select('id,name').order('name'),
      supabase.from('class_sessions').select(`
        id,session_date,session_period,starts_at,ends_at,capacity,status,
        teacher_name,teacher_country,topic_title,topic_storage_path,
        programs(name),rooms(name)
      `).order('session_date',{ascending:false}).limit(200)
    ]);

    if(pErr||rErr||sErr) throw (pErr||rErr||sErr);

    const ids=(sessions||[]).map(x=>x.id);
    const counts={};

    if(ids.length){
      const {data:bs,error:bErr}=await supabase
        .from('bookings')
        .select('session_id,status')
        .in('session_id',ids)
        .eq('status','CONFIRMED');

      if(bErr) throw bErr;
      (bs||[]).forEach(x=>counts[x.session_id]=(counts[x.session_id]||0)+1);
    }

    return Response.json({
      programs,
      rooms,
      sessions:(sessions||[]).map(x=>({
        ...x,
        program_name:x.programs?.name||'',
        room_name:x.rooms?.name||'',
        booked_count:counts[x.id]||0
      }))
    });
  }

  if(request.method==='POST'){
    const b=await request.json();

    if(!b.program_id||!b.session_date||!b.starts_at||!b.ends_at){
      return Response.json({error:'MISSING_FIELDS'},{status:400});
    }

    const sessionType=String(b.session_type||'ONE_OFF').toUpperCase();
    if(!['RECURRING','ONE_OFF'].includes(sessionType)){
      return Response.json({error:'INVALID_SESSION_TYPE'},{status:400});
    }

    // Keep compatibility with the existing schema: use the first room if room_id is required,
    // but room is no longer exposed in the admin/public timetable UI.
    let roomId=b.room_id||null;
    if(!roomId){
      const {data:firstRoom,error:roomErr}=await supabase
        .from('rooms')
        .select('id')
        .order('id')
        .limit(1)
        .maybeSingle();
      if(roomErr) throw roomErr;
      roomId=firstRoom?.id||null;
    }

    const start=new Date(`${b.session_date}T00:00:00`);
    if(Number.isNaN(start.getTime())){
      return Response.json({error:'INVALID_DATE'},{status:400});
    }

    const dates=[];
    if(sessionType==='RECURRING'){
      // Materialize the weekly class now, up to exactly 3 calendar months ahead.
      // No cron/background job is required.
      const limit=new Date(start);
      limit.setMonth(limit.getMonth()+3);
      for(let d=new Date(start); d<=limit; d.setDate(d.getDate()+7)){
        dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
      }
    }else{
      dates.push(b.session_date);
    }

    const rows=dates.map(sessionDate=>({
      program_id:b.program_id,
      session_date:sessionDate,
      session_period:b.session_period,
      starts_at:b.starts_at,
      ends_at:b.ends_at,
      room_id:roomId,
      teacher_name:b.teacher_name||null,
      teacher_country:b.teacher_country||null,
      capacity:Number(b.capacity||10),
      status:'OPEN'
    }));

    // Avoid accidental duplicates when admin clicks twice.
    const {data:existing,error:existingErr}=await supabase
      .from('class_sessions')
      .select('session_date,starts_at,ends_at')
      .eq('program_id',b.program_id)
      .in('session_date',dates);

    if(existingErr) throw existingErr;

    const existingKeys=new Set((existing||[]).map(x=>`${x.session_date}|${String(x.starts_at).slice(0,5)}|${String(x.ends_at).slice(0,5)}`));
    const toInsert=rows.filter(x=>!existingKeys.has(`${x.session_date}|${String(x.starts_at).slice(0,5)}|${String(x.ends_at).slice(0,5)}`));

    if(!toInsert.length){
      return Response.json({error:'SESSION_ALREADY_EXISTS'},{status:409});
    }

    const {data,error}=await supabase
      .from('class_sessions')
      .insert(toInsert)
      .select('id,session_date');

    if(error){
      return Response.json({error:error.message},{status:400});
    }

    return Response.json({
      success:true,
      session_type:sessionType,
      created_count:data?.length||0,
      skipped_count:rows.length-(data?.length||0),
      sessions:data||[]
    },{status:201});
  }

  return Response.json({error:'Method not allowed'},{status:405});
}

async function handleCustomers(){
  const {data,error}=await supabase
    .from('customers')
    .select('id,full_name,phone,status,created_at')
    .order('created_at',{ascending:false})
    .limit(500);

  if(error) throw error;
  return Response.json({customers:data||[]});
}

async function handleBookings(){
  const {data,error}=await supabase
    .from('bookings')
    .select(`
      id,status,created_at,
      customers:user_id(full_name,phone),
      orders!inner(payment_status,order_status),
      class_sessions(session_date,starts_at,ends_at,programs(name))
    `)
    .eq('status','CONFIRMED')
    .eq('orders.payment_status','PAID')
    .order('created_at',{ascending:false})
    .limit(500);

  if(error) throw error;

  return Response.json({
    bookings:(data||[]).map(x=>({
      id:x.id,
      full_name:x.customers?.full_name||'',
      phone:x.customers?.phone||'',
      payment_status:x.orders?.payment_status||'',
      session_date:x.class_sessions?.session_date||'',
      starts_at:x.class_sessions?.starts_at||'',
      ends_at:x.class_sessions?.ends_at||'',
      program_name:x.class_sessions?.programs?.name||''
    }))
  });
}

async function handleTopicUpload(request){
  if(request.method!=='POST'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const fd=await request.formData();
  const sessionId=String(fd.get('session_id')||'');
  const title=String(fd.get('title')||'').trim();
  const file=fd.get('file');

  if(!sessionId||!file){
    return Response.json({error:'MISSING_FIELDS'},{status:400});
  }

  if(file.type && file.type!=='application/pdf'){
    return Response.json({error:'PDF_ONLY'},{status:400});
  }

  const {data:session,error:sErr}=await supabase
    .from('class_sessions')
    .select('session_date,programs(name)')
    .eq('id',sessionId)
    .maybeSingle();

  if(sErr) throw sErr;
  if(!session){
    return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  }

  const path=`${session.session_date}-${slug(session.programs?.name)}-${slug(title||file.name)}.pdf`;
  const bytes=await file.arrayBuffer();

  const {error:uErr}=await supabase.storage
    .from('topics')
    .upload(path,bytes,{contentType:'application/pdf',upsert:true});

  if(uErr) throw uErr;

  const {error:updateErr}=await supabase
    .from('class_sessions')
    .update({
      topic_title:title||file.name.replace(/\.pdf$/i,''),
      topic_storage_path:path
    })
    .eq('id',sessionId);

  if(updateErr) throw updateErr;

  return Response.json({success:true,path});
}

export default {
  async fetch(request){
    try{
      const url=new URL(request.url);
      const action=url.searchParams.get('action')||'';

      if(action==='login'){
        return await handleLogin(request);
      }

      if(!requireAdmin(request)){
        return Response.json({error:'UNAUTHORIZED'},{status:401});
      }

      if(action==='overview') return await handleOverview(request);
      if(action==='sessions') return await handleSessions(request);
      if(action==='customers') return await handleCustomers(request);
      if(action==='bookings') return await handleBookings(request);
      if(action==='topic-upload') return await handleTopicUpload(request);

      return Response.json({error:'UNKNOWN_ACTION'},{status:404});
    }catch(err){
      console.error('admin api error',err);
      return Response.json(
        {error:'ADMIN_API_ERROR',details:String(err?.message||err)},
        {status:500}
      );
    }
  }
};
