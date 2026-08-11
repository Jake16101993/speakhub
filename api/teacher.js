import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabase=createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

function secret(){
  return process.env.SPEAKHUB_TEACHER_SECRET || process.env.SPEAKHUB_ADMIN_SECRET;
}
function signTeacherToken(account){
  const s=secret();
  if(!s) throw new Error('TEACHER_SECRET_MISSING');
  const payload=Buffer.from(JSON.stringify({
    teacher_account_id:account.id,
    teacher_name:account.teacher_name,
    exp:Date.now()+12*60*60*1000
  })).toString('base64url');
  const sig=crypto.createHmac('sha256',s).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readTeacherToken(request){
  const s=secret();
  if(!s) return null;
  const auth=request.headers.get('authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const [payload,sig]=token.split('.');
  if(!payload||!sig) return null;
  const expected=crypto.createHmac('sha256',s).update(payload).digest('base64url');
  if(sig.length!==expected.length) return null;
  try{
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return null;
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(Number(data.exp)<=Date.now()) return null;
    return data;
  }catch{return null}
}
async function requireTeacher(request){
  const token=readTeacherToken(request);
  if(!token) return {error:'UNAUTHORIZED',status:401};

  const {data,error}=await supabase
    .from('teacher_accounts')
    .select('id,teacher_name,username,is_active')
    .eq('id',token.teacher_account_id)
    .eq('is_active',true)
    .maybeSingle();

  if(error) throw error;
  if(!data) return {error:'UNAUTHORIZED',status:401};
  return {account:data};
}
function todayISO(){
  return new Date().toISOString().slice(0,10);
}
function plusDaysISO(days){
  const d=new Date();
  d.setDate(d.getDate()+days);
  return d.toISOString().slice(0,10);
}

async function login(request){
  if(request.method!=='POST') return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
  const body=await request.json().catch(()=>({}));
  const username=String(body.username||'').trim().toLowerCase();
  const password=String(body.password||'');
  if(!username||!password) return Response.json({error:'MISSING_FIELDS'},{status:400});

  const {data,error}=await supabase.rpc('verify_teacher_login',{
    p_username:username,
    p_password:password
  });
  if(error) throw error;

  const account=Array.isArray(data)?data[0]:data;
  if(!account) return Response.json({error:'INVALID_LOGIN'},{status:401});

  return Response.json({
    token:signTeacherToken(account),
    teacher:{
      id:account.id,
      teacher_name:account.teacher_name,
      full_name:account.teacher_name,
      username:account.username
    }
  });
}

async function me(request){
  const auth=await requireTeacher(request);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});
  return Response.json({
    teacher:{
      id:auth.account.id,
      teacher_name:auth.account.teacher_name,
      full_name:auth.account.teacher_name,
      username:auth.account.username
    }
  });
}

async function schedule(request){
  const auth=await requireTeacher(request);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  const from=plusDaysISO(-14);
  const to=plusDaysISO(90);

  const {data:sessions,error:sErr}=await supabase
    .from('class_sessions')
    .select(`
      id,session_date,starts_at,ends_at,status,topic_title,teacher_name,
      programs(name),rooms(name)
    `)
    .eq('teacher_name',auth.account.teacher_name)
    .gte('session_date',from)
    .lte('session_date',to)
    .neq('status','CANCELLED')
    .order('session_date',{ascending:true})
    .order('starts_at',{ascending:true});

  if(sErr) throw sErr;

  const ids=(sessions||[]).map(s=>s.id);
  const counts={};
  if(ids.length){
    const {data:bookings,error:bErr}=await supabase
      .from('bookings')
      .select('session_id,status,orders!inner(payment_status)')
      .in('session_id',ids)
      .in('status',['CONFIRMED','ATTENDED','NO_SHOW'])
      .eq('orders.payment_status','PAID');

    if(bErr) throw bErr;
    (bookings||[]).forEach(b=>counts[b.session_id]=(counts[b.session_id]||0)+1);
  }

  return Response.json({
    sessions:(sessions||[]).map(s=>({
      id:s.id,
      session_date:s.session_date,
      starts_at:s.starts_at,
      ends_at:s.ends_at,
      status:s.status,
      topic_title:s.topic_title||'',
      teacher_name:s.teacher_name||'',
      program_name:s.programs?.name||'',
      room_name:s.rooms?.name||'',
      booked_count:counts[s.id]||0
    }))
  });
}

async function sessionDetail(request,url){
  const auth=await requireTeacher(request);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  const sessionId=url.searchParams.get('session_id');
  if(!sessionId) return Response.json({error:'SESSION_ID_REQUIRED'},{status:400});

  const {data:session,error:sErr}=await supabase
    .from('class_sessions')
    .select(`
      id,session_date,starts_at,ends_at,status,topic_title,teacher_name,
      programs(name),rooms(name)
    `)
    .eq('id',sessionId)
    .eq('teacher_name',auth.account.teacher_name)
    .maybeSingle();

  if(sErr) throw sErr;
  if(!session) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});

  const {data:bookings,error:bErr}=await supabase
    .from('bookings')
    .select(`
      id,status,
      customers:user_id(id,full_name,phone),
      orders!inner(payment_status,order_status)
    `)
    .eq('session_id',sessionId)
    .in('status',['CONFIRMED','ATTENDED','NO_SHOW'])
    .eq('orders.payment_status','PAID')
    .order('created_at',{ascending:true});

  if(bErr) throw bErr;

  return Response.json({
    session:{
      id:session.id,
      session_date:session.session_date,
      starts_at:session.starts_at,
      ends_at:session.ends_at,
      status:session.status,
      topic_title:session.topic_title||'',
      teacher_name:session.teacher_name||'',
      program_name:session.programs?.name||'',
      room_name:session.rooms?.name||''
    },
    students:(bookings||[]).map(b=>({
      booking_id:b.id,
      customer_id:b.customers?.id||'',
      full_name:b.customers?.full_name||'Học viên',
      phone:b.customers?.phone||'',
      status:b.status
    }))
  });
}

async function attendance(request){
  if(request.method!=='POST') return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
  const auth=await requireTeacher(request);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  const body=await request.json().catch(()=>({}));
  const bookingId=String(body.booking_id||'');
  const attended=Boolean(body.attended);
  if(!bookingId) return Response.json({error:'BOOKING_ID_REQUIRED'},{status:400});

  const {data:booking,error:bErr}=await supabase
    .from('bookings')
    .select(`
      id,status,session_id,
      class_sessions!inner(id,teacher_name)
    `)
    .eq('id',bookingId)
    .eq('class_sessions.teacher_name',auth.account.teacher_name)
    .maybeSingle();

  if(bErr) throw bErr;
  if(!booking) return Response.json({error:'BOOKING_NOT_FOUND'},{status:404});

  const nextStatus=attended?'ATTENDED':'CONFIRMED';
  const {error:uErr}=await supabase
    .from('bookings')
    .update({status:nextStatus})
    .eq('id',bookingId);

  if(uErr) throw uErr;

  const {error:logErr}=await supabase
    .from('attendance_log')
    .insert({
      booking_id:bookingId,
      session_id:booking.session_id,
      teacher_account_id:auth.account.id,
      attended,
      marked_at:new Date().toISOString()
    });
  if(logErr) console.warn('attendance log error',logErr.message);

  return Response.json({success:true,status:nextStatus});
}

export default async function handler(request){
  try{
    const url=new URL(request.url);
    const action=url.searchParams.get('action')||'';

    if(action==='login') return await login(request);
    if(action==='me') return await me(request);
    if(action==='schedule') return await schedule(request);
    if(action==='session') return await sessionDetail(request,url);
    if(action==='attendance') return await attendance(request);

    return Response.json({error:'NOT_FOUND'},{status:404});
  }catch(err){
    console.error('teacher api error',err);
    return Response.json({error:'TEACHER_API_ERROR',details:err?.message||String(err)},{status:500});
  }
}
