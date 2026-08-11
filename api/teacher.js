import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabase=createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {auth:{persistSession:false,autoRefreshToken:false}}
);

function requestUrl(request){
  const raw=request?.url||'/api/teacher';
  if(/^https?:\/\//i.test(raw)) return new URL(raw);
  const host=request?.headers?.get?.('host')
    || request?.headers?.host
    || 'speakhub.vn';
  const proto=request?.headers?.get?.('x-forwarded-proto')
    || request?.headers?.['x-forwarded-proto']
    || 'https';
  return new URL(raw, `${proto}://${host}`);
}


const TEACHER_CACHE_TTL_MS = 10 * 60 * 1000;
const teacherAccountCache = new Map();
const teacherProfileCache = new Map();

function cacheGet(map,key){
  const item=map.get(key);
  if(!item) return null;
  if(Date.now()-item.at>TEACHER_CACHE_TTL_MS){
    map.delete(key);
    return null;
  }
  return item.value;
}
function cacheSet(map,key,value){
  map.set(key,{value,at:Date.now()});
  return value;
}

function secret(){
  // Prefer a dedicated teacher secret, then reuse the existing admin secret.
  // Final fallback keeps Teacher login working on the current deployment
  // without requiring another Vercel env variable.
  return process.env.SPEAKHUB_TEACHER_SECRET
    || process.env.SPEAKHUB_ADMIN_SECRET
    || process.env.SUPABASE_SECRET_KEY;
}
function signTeacherToken(account){
  const s=secret();
  if(!s) throw new Error('TEACHER_SECRET_MISSING');
  const accountId=account.id||account.teacher_id;
  if(!accountId) throw new Error('TEACHER_ID_MISSING');
  const payload=Buffer.from(JSON.stringify({
    teacher_account_id:accountId,
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

async function resolveTeacherId(teacherName){
  const key=String(teacherName||'').trim().toLowerCase();
  const cached=cacheGet(teacherProfileCache,key);
  if(cached) return cached;

  const {data,error}=await supabase
    .from('teachers')
    .select('id,full_name,country,is_active')
    .eq('full_name',teacherName)
    .eq('is_active',true)
    .maybeSingle();

  if(error) throw error;
  if(data) cacheSet(teacherProfileCache,key,data);
  return data||null;
}

async function requireTeacher(request){
  const token=readTeacherToken(request);
  if(!token) return {error:'UNAUTHORIZED',status:401};

  const cacheKey=String(token.teacher_account_id||'');
  const cached=cacheGet(teacherAccountCache,cacheKey);
  if(cached) return {account:cached};

  const {data,error}=await supabase
    .from('teacher_accounts')
    .select('id,teacher_name,username,is_active')
    .eq('id',token.teacher_account_id)
    .eq('is_active',true)
    .maybeSingle();

  if(error) throw error;
  if(!data) return {error:'UNAUTHORIZED',status:401};
  cacheSet(teacherAccountCache,cacheKey,data);
  return {account:data};
}
function todayISO(){
  return new Date().toISOString().slice(0,10);
}
function localDateISO(d){
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function currentWeekRange(){
  const now=new Date();
  const monday=new Date(now);
  const offset=(now.getDay()+6)%7;
  monday.setDate(now.getDate()-offset);
  monday.setHours(0,0,0,0);

  const sunday=new Date(monday);
  sunday.setDate(monday.getDate()+6);

  return {from:localDateISO(monday),to:localDateISO(sunday)};
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

  if(error){
    console.error('verify_teacher_login RPC error', error);
    return Response.json({
      error:'TEACHER_LOGIN_RPC_FAILED',
      details:error.message||String(error)
    },{status:500});
  }

  const raw=Array.isArray(data)?data[0]:data;
  if(!raw) return Response.json({error:'INVALID_LOGIN'},{status:401});

  const account={
    id:raw.teacher_id||raw.id,
    teacher_name:raw.teacher_name,
    username:raw.username
  };

  if(!account.id) return Response.json({error:'TEACHER_ID_MISSING'},{status:500});

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

  const teacher=await resolveTeacherId(auth.account.teacher_name);
  if(!teacher){
    return Response.json({
      error:'TEACHER_NOT_MAPPED',
      details:`Không tìm thấy giáo viên "${auth.account.teacher_name}" trong bảng teachers.`
    },{status:400});
  }

  const {from,to}=currentWeekRange();

  const {data:sessions,error:sErr}=await supabase
    .from('class_sessions')
    .select(`
      id,session_date,starts_at,ends_at,status,topic_title,topic_storage_path,topic_vocabulary,teacher_id,
      programs(name),rooms(name),teachers(full_name,country)
    `)
    .eq('teacher_id',teacher.id)
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
      .select('session_id,status')
      .in('session_id',ids)
      .in('status',['CONFIRMED','ATTENDED','NO_SHOW']);

    if(bErr) throw bErr;
    (bookings||[]).forEach(b=>counts[b.session_id]=(counts[b.session_id]||0)+1);
  }

  return Response.json({
    teacher:{
      id:teacher.id,
      full_name:teacher.full_name,
      country:teacher.country||''
    },
    sessions:(sessions||[]).map(s=>({
      id:s.id,
      session_date:s.session_date,
      starts_at:s.starts_at,
      ends_at:s.ends_at,
      status:s.status,
      topic_title:s.topic_title||'',
      topic_storage_path:s.topic_storage_path||'',
      topic_vocabulary:Array.isArray(s.topic_vocabulary)?s.topic_vocabulary:[],
      teacher_name:s.teachers?.full_name||auth.account.teacher_name,
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

  const teacher=await resolveTeacherId(auth.account.teacher_name);
  if(!teacher) return Response.json({error:'TEACHER_NOT_MAPPED'},{status:400});

  const {data:session,error:sErr}=await supabase
    .from('class_sessions')
    .select(`
      id,program_id,room_id,session_date,starts_at,ends_at,status,topic_title,topic_storage_path,topic_vocabulary,teacher_id,
      programs(name),rooms(name),teachers(full_name,country)
    `)
    .eq('id',sessionId)
    .eq('teacher_id',teacher.id)
    .maybeSingle();

  if(sErr) throw sErr;
  if(!session) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});

  // Old recurring data may contain duplicate physical rows for what is actually
  // the same logical class. Gather all equivalent session IDs so a paid booking
  // is never hidden just because it points to a duplicate row.
  const {data:equivalentSessions,error:eqErr}=await supabase
    .from('class_sessions')
    .select('id')
    .eq('teacher_id',teacher.id)
    .eq('program_id',session.program_id)
    .eq('session_date',session.session_date)
    .eq('starts_at',session.starts_at)
    .eq('ends_at',session.ends_at)
    .neq('status','CANCELLED');

  if(eqErr) throw eqErr;

  const logicalSessionIds=[...new Set(
    [session.id,...(equivalentSessions||[]).map(x=>x.id)].filter(Boolean)
  )];

  // Read bookings first, then orders/customers separately.
  // This is more reliable than an inner relationship filter and lets us
  // explicitly verify which paid order each booking belongs to.
  const {data:bookingRows,error:bErr}=await supabase
    .from('bookings')
    .select('id,status,user_id,order_id,session_id,created_at')
    .in('session_id',logicalSessionIds)
    .in('status',['CONFIRMED','ATTENDED','NO_SHOW'])
    .order('created_at',{ascending:true});

  if(bErr) throw bErr;

  const orderIds=[...new Set((bookingRows||[]).map(b=>b.order_id).filter(Boolean))];
  const userIds=[...new Set((bookingRows||[]).map(b=>b.user_id).filter(Boolean))];

  // Orders and customer profiles are independent: fetch them in parallel.
  const [ordersResult,customersResult]=await Promise.all([
    orderIds.length
      ? supabase.from('orders').select('id,payment_status,order_status').in('id',orderIds)
      : Promise.resolve({data:[],error:null}),
    userIds.length
      ? supabase.from('customers').select('id,full_name,phone').in('id',userIds)
      : Promise.resolve({data:[],error:null})
  ]);

  if(ordersResult.error) throw ordersResult.error;
  if(customersResult.error) throw customersResult.error;

  const orders=ordersResult.data||[];
  const customers=customersResult.data||[];

  const orderMap=new Map(orders.map(o=>[o.id,o]));
  const customerMap=new Map(customers.map(c=>[c.id,c]));

  const paidBookings=(bookingRows||[]).filter(b=>{
    const o=orderMap.get(b.order_id);
    return o?.payment_status==='PAID' && o?.order_status==='CONFIRMED';
  });

  return Response.json({
    session:{
      id:session.id,
      session_date:session.session_date,
      starts_at:session.starts_at,
      ends_at:session.ends_at,
      status:session.status,
      topic_title:session.topic_title||'',
      topic_storage_path:session.topic_storage_path||'',
      topic_vocabulary:Array.isArray(session.topic_vocabulary)?session.topic_vocabulary:[],
      teacher_name:session.teachers?.full_name||auth.account.teacher_name,
      program_name:session.programs?.name||'',
      room_name:session.rooms?.name||''
    },
    students:paidBookings.map(b=>{
      const c=customerMap.get(b.user_id)||{};
      return {
        booking_id:b.id,
        customer_id:b.user_id||'',
        full_name:c.full_name||'Học viên',
        phone:c.phone||'',
        status:b.status
      };
    }),
    debug:{
      logical_session_ids:logicalSessionIds.length,
      raw_bookings:(bookingRows||[]).length,
      paid_bookings:paidBookings.length
    }
  });
}

async function openTeacherTopic(request,url){
  const auth=await requireTeacher(request);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});
  const sessionId=url.searchParams.get('session_id');
  if(!sessionId) return Response.json({error:'SESSION_ID_REQUIRED'},{status:400});
  const teacher=await resolveTeacherId(auth.account.teacher_name);
  if(!teacher) return Response.json({error:'TEACHER_NOT_MAPPED'},{status:400});

  const {data:session,error}=await supabase
    .from('class_sessions')
    .select('id,teacher_id,topic_title,topic_storage_path')
    .eq('id',sessionId).eq('teacher_id',teacher.id).maybeSingle();
  if(error) throw error;
  if(!session) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});

  const path=String(session.topic_storage_path||'').trim();
  if(!path) return Response.json({error:'TOPIC_NOT_READY'},{status:404});

  const {data:signed,error:signedErr}=await supabase.storage.from('topics').createSignedUrl(path,600);
  if(signedErr) throw signedErr;
  return Response.json({title:session.topic_title||'SpeakHub Topic',signed_url:signed.signedUrl,expires_in:600});
}

async function attendance(request){
  if(request.method!=='POST') return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
  const auth=await requireTeacher(request);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  const body=await request.json().catch(()=>({}));
  const bookingId=String(body.booking_id||'');
  const attended=Boolean(body.attended);
  if(!bookingId) return Response.json({error:'BOOKING_ID_REQUIRED'},{status:400});

  const teacher=await resolveTeacherId(auth.account.teacher_name);
  if(!teacher) return Response.json({error:'TEACHER_NOT_MAPPED'},{status:400});

  const {data:booking,error:bErr}=await supabase
    .from('bookings')
    .select(`
      id,status,session_id,
      class_sessions!inner(id,teacher_id)
    `)
    .eq('id',bookingId)
    .eq('class_sessions.teacher_id',teacher.id)
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

export default {
  async fetch(request) {

  try{
    const url=requestUrl(request);
    const action=url.searchParams.get('action')||'';

    if(action==='login') return await login(request);
    if(action==='me') return await me(request);
    if(action==='schedule') return await schedule(request);
    if(action==='session') return await sessionDetail(request,url);
    if(action==='attendance') return await attendance(request);

    return Response.json({error:'NOT_FOUND'},{status:404});
  }catch(err){
    console.error('teacher api error',err);
    return Response.json({
      error:'TEACHER_API_ERROR',
      details:err?.message||String(err),
      action:requestUrl(request).searchParams.get('action')||''
    },{status:500});
  }
  }
};
