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

function vnDateParts(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Ho_Chi_Minh',
    year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(date);
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  return {year:Number(get('year')),month:Number(get('month')),day:Number(get('day'))};
}
function dateISOFromParts(y,m,d){
  return new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10);
}
function addDaysISO(iso,days){
  const d=new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}
function currentWeekBounds(){
  const p=vnDateParts();
  const today=dateISOFromParts(p.year,p.month,p.day);
  const d=new Date(`${today}T00:00:00Z`);
  const day=d.getUTCDay()===0?7:d.getUTCDay();
  const monday=addDaysISO(today,-(day-1));
  return {
    prev_from:addDaysISO(monday,-7), prev_to:addDaysISO(monday,-1),
    current_from:monday, current_to:addDaysISO(monday,6),
    next_from:addDaysISO(monday,7), next_to:addDaysISO(monday,13)
  };
}
function monthBounds(){
  const p=vnDateParts();
  const first=dateISOFromParts(p.year,p.month,1);
  const next=p.month===12?dateISOFromParts(p.year+1,1,1):dateISOFromParts(p.year,p.month+1,1);
  return {first,next};
}
function fillRate(sessions,bookingCounts){
  let seats=0,booked=0;
  for(const s of (sessions||[])){
    seats+=Number(s.capacity||0);
    booked+=Number(bookingCounts[s.id]||0);
  }
  return seats>0?Math.round((booked/seats)*1000)/10:0;
}
async function handleOverview(){
  const w=currentWeekBounds(), month=monthBounds(), weekEndExclusive=addDaysISO(w.current_to,1);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh'}).format(new Date());
  const results=await Promise.all([
    supabase.from('customers').select('*',{count:'exact',head:true}),
    supabase.from('orders').select('*',{count:'exact',head:true}).eq('payment_status','PAID'),
    supabase.from('bookings').select('*',{count:'exact',head:true}).eq('status','CONFIRMED'),
    supabase.from('class_sessions').select('*',{count:'exact',head:true}).eq('status','OPEN'),
    supabase.from('class_sessions').select('id,capacity,topic_storage_path').gte('session_date',w.current_from).lte('session_date',w.current_to).neq('status','CANCELLED'),
    supabase.from('class_sessions').select('id,capacity').gte('session_date',w.prev_from).lte('session_date',w.prev_to).neq('status','CANCELLED'),
    supabase.from('class_sessions').select('id,capacity').gte('session_date',w.next_from).lte('session_date',w.next_to).neq('status','CANCELLED'),
    supabase.from('placement_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('progress_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('placement_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED'),
    supabase.from('progress_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED'),
    supabase.from('orders').select('total_amount').eq('payment_status','PAID').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('orders').select('total_amount').eq('payment_status','PAID').gte('created_at',`${month.first}T00:00:00+07:00`).lt('created_at',`${month.next}T00:00:00+07:00`),
    supabase.from('class_sessions').select('id').gte('session_date',today).neq('status','CANCELLED')
  ]);
  const err=results.find(x=>x.error)?.error;if(err) throw err;
  const [c,o,b,s,week,prev,next,pw,gw,pa,ga,mw,mm,future]=results;
  const all=[...(prev.data||[]),...(week.data||[]),...(next.data||[])], counts={}, ids=all.map(x=>x.id);
  if(ids.length){
    const {data:bs,error}=await supabase.from('bookings').select('session_id').in('session_id',ids).in('status',['CONFIRMED','ATTENDED','NO_SHOW']);
    if(error) throw error;
    for(const x of (bs||[])) counts[x.session_id]=(counts[x.session_id]||0)+1;
  }
  let activeStudents=0;
  const futureIds=(future.data||[]).map(x=>x.id);
  if(futureIds.length){
    const {data:fb,error}=await supabase.from('bookings').select('user_id').in('session_id',futureIds).eq('status','CONFIRMED');
    if(error) throw error;
    activeStudents=new Set((fb||[]).map(x=>x.user_id).filter(Boolean)).size;
  }
  const fill=rows=>{
    rows=rows||[];if(!rows.length)return 0;
    const maxSeats=Math.max(0,...rows.map(x=>Number(x.capacity||0)));
    const total=rows.length*maxSeats;
    const booked=rows.reduce((n,x)=>n+Number(counts[x.id]||0),0);
    return total?Math.round((booked/total)*1000)/10:0;
  };
  const sum=rows=>(rows||[]).reduce((n,x)=>n+Number(x.total_amount||0),0);
  const dayStart=`${today}T00:00:00+07:00`,dayEnd=`${addDaysISO(today,1)}T00:00:00+07:00`;
  const weekStart=`${w.current_from}T00:00:00+07:00`,weekEnd=`${weekEndExclusive}T00:00:00+07:00`;
  const monthStart=`${month.first}T00:00:00+07:00`,monthEnd=`${month.next}T00:00:00+07:00`;
  async function uniqueVisitors(from,to){
    const {data,error}=await supabase.from('website_visits').select('visitor_id').gte('last_seen_at',from).lt('last_seen_at',to);
    if(error)throw error;return new Set((data||[]).map(x=>x.visitor_id).filter(Boolean)).size;
  }
  const chartFrom=addDaysISO(today,-29);
  const onlineSince=new Date(Date.now()-75*1000).toISOString();
  const [visDay,visWeek,visMonth,onlineRes,chartRes]=await Promise.all([
    uniqueVisitors(dayStart,dayEnd),uniqueVisitors(weekStart,weekEnd),uniqueVisitors(monthStart,monthEnd),
    supabase.from('website_visits').select('visitor_id').gte('last_seen_at',onlineSince),
    supabase.from('website_visits').select('visitor_id,visited_on').gte('visited_on',chartFrom).lte('visited_on',today)
  ]);
  if(onlineRes.error)throw onlineRes.error;if(chartRes.error)throw chartRes.error;
  const onlineVisitors=new Set((onlineRes.data||[]).map(x=>x.visitor_id).filter(Boolean)).size;
  const dailyMap={};
  for(let i=0;i<30;i++)dailyMap[addDaysISO(chartFrom,i)]=new Set();
  for(const x of (chartRes.data||[])){if(dailyMap[x.visited_on]&&x.visitor_id)dailyMap[x.visited_on].add(x.visitor_id);}
  const visits30=Object.entries(dailyMap).map(([date,set])=>({date,visitors:set.size}));
  return Response.json({
    counts:{customers:c.count||0,paid_orders:o.count||0,confirmed_bookings:b.count||0,open_sessions:s.count||0},
    analytics:{
      sessions_this_week:(week.data||[]).length,
      topics_this_week:(week.data||[]).filter(x=>String(x.topic_storage_path||'').trim()).length,
      active_students:activeStudents,
      tests_this_week:{placement:pw.count||0,progress:gw.count||0},
      tests_all:{placement:pa.count||0,progress:ga.count||0},
      paid_amount:{week:sum(mw.data),month:sum(mm.data)},
      fill_rate:{previous_week:fill(prev.data),current_week:fill(week.data),next_week:fill(next.data)},
      ranges:w,
      website_visits:{day:visDay,week:visWeek,month:visMonth,online:onlineVisitors,daily_30:visits30}
    }
  });
}

async function handleSessions(request){
  if(request.method==='GET'){
    const [
      {data:programs,error:pErr},
      {data:rooms,error:rErr},
      {data:teachers,error:tErr},
      {data:sessions,error:sErr}
    ]=await Promise.all([
      supabase.from('programs').select('id,code,name').order('name'),
      supabase.from('rooms').select('id,name,location_id').order('name'),
      supabase.from('teachers').select('id,full_name,country,is_active').eq('is_active',true).order('full_name'),
      supabase.from('class_sessions').select(`
        id,session_date,session_period,starts_at,ends_at,capacity,status,is_recurring,recurrence_source_id,
        teacher_id,topic_title,topic_storage_path,topic_vocabulary,
        programs(name),rooms(name),teachers(full_name,country)
      `).order('session_date',{ascending:false}).limit(200)
    ]);

    if(pErr||rErr||tErr||sErr) throw (pErr||rErr||tErr||sErr);

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
      programs:programs||[],
      rooms:rooms||[],
      teachers:teachers||[],
      sessions:(sessions||[]).map(x=>({
        ...x,
        program_name:x.programs?.name||'',
        room_name:x.rooms?.name||'',
        teacher_name:x.teachers?.full_name||'',
        teacher_country:x.teachers?.country||'',
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

    let roomId=b.room_id||null;
    let fallbackLocationId=null;

    if(!roomId){
      const {data:firstRoom,error:roomErr}=await supabase
        .from('rooms')
        .select('id,location_id')
        .order('id')
        .limit(1)
        .maybeSingle();

      if(roomErr) throw roomErr;
      roomId=firstRoom?.id||null;
      fallbackLocationId=firstRoom?.location_id||null;
    }

    let locationId=b.location_id||fallbackLocationId||null;

    if(!locationId && roomId){
      const {data:roomWithLocation,error:roomLocationErr}=await supabase
        .from('rooms')
        .select('location_id')
        .eq('id',roomId)
        .maybeSingle();

      if(roomLocationErr) throw roomLocationErr;
      locationId=roomWithLocation?.location_id||null;
    }

    const common={
      program_id:b.program_id,
      location_id:locationId,
      session_date:b.session_date,
      session_period:b.session_period,
      starts_at:b.starts_at,
      ends_at:b.ends_at,
      room_id:roomId,
      teacher_id:b.teacher_id||null,
      capacity:Number(b.capacity||10),
      status:'OPEN'
    };

    // Check the exact unique key before trying to insert.
    const {data:existing,error:existingErr}=await supabase
      .from('class_sessions')
      .select('id,is_recurring,recurrence_source_id')
      .eq('program_id',b.program_id)
      .eq('room_id',roomId)
      .eq('session_date',b.session_date)
      .eq('starts_at',b.starts_at)
      .maybeSingle();

    if(existingErr) throw existingErr;

    // If the slot already exists and admin chooses "recurring",
    // upgrade the existing session into the recurring seed instead of failing.
    if(existing){
      if(sessionType==='RECURRING'){
        const {data:updated,error:updateErr}=await supabase
          .from('class_sessions')
          .update({
            location_id:locationId,
            session_period:b.session_period,
            ends_at:b.ends_at,
            teacher_id:b.teacher_id||null,
            capacity:Number(b.capacity||10),
            status:'OPEN',
            is_recurring:true,
            recurrence_source_id:null
          })
          .eq('id',existing.id)
          .select('id,session_date,is_recurring')
          .single();

        if(updateErr){
          return Response.json({error:updateErr.message},{status:400});
        }

        return Response.json({
          success:true,
          reused_existing:true,
          session_type:'RECURRING',
          created_count:0,
          updated_count:1,
          sessions:[updated]
        },{status:200});
      }

      return Response.json({
        error:'SESSION_ALREADY_EXISTS',
        details:'Đã có lớp này vào đúng ngày và giờ đã chọn.'
      },{status:409});
    }

    if(sessionType==='ONE_OFF'){
      const {data,error}=await supabase
        .from('class_sessions')
        .insert({...common,is_recurring:false,recurrence_source_id:null})
        .select('id,session_date')
        .single();

      if(error){
        if(String(error.message||'').includes('class_sessions_program_id_room_id_session_date_starts_at_key')){
          return Response.json({error:'SESSION_ALREADY_EXISTS'},{status:409});
        }
        return Response.json({error:error.message},{status:400});
      }

      return Response.json({
        success:true,
        session_type:'ONE_OFF',
        created_count:1,
        sessions:[data]
      },{status:201});
    }

    const {data:seed,error:seedErr}=await supabase
      .from('class_sessions')
      .insert({...common,is_recurring:true,recurrence_source_id:null})
      .select('id,session_date')
      .single();

    if(seedErr){
      if(String(seedErr.message||'').includes('class_sessions_program_id_room_id_session_date_starts_at_key')){
        return Response.json({error:'SESSION_ALREADY_EXISTS'},{status:409});
      }
      return Response.json({error:seedErr.message},{status:400});
    }

    // DB trigger now handles weekly duplication.
    return Response.json({
      success:true,
      session_type:'RECURRING',
      created_count:1,
      sessions:[seed]
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


function validManualPhone(phone){
  return /^0\d{9}$/.test(String(phone||'').trim());
}
function validManualName(name){
  return String(name||'').trim().split(/\s+/).filter(Boolean).length>=2;
}

async function getManualSessions(){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh'}).format(new Date());
  const {data:sessions,error}=await supabase
    .from('class_sessions')
    .select('id,session_date,starts_at,ends_at,capacity,status,programs(name)')
    .gte('session_date',today)
    .neq('status','CANCELLED')
    .order('session_date',{ascending:true})
    .order('starts_at',{ascending:true})
    .limit(500);
  if(error) throw error;

  const ids=(sessions||[]).map(x=>x.id), counts={};
  if(ids.length){
    const {data:bs,error:bErr}=await supabase
      .from('bookings').select('session_id').in('session_id',ids)
      .in('status',['CONFIRMED','ATTENDED','NO_SHOW']);
    if(bErr) throw bErr;
    for(const b of (bs||[])) counts[b.session_id]=(counts[b.session_id]||0)+1;
  }
  return (sessions||[]).map(x=>({...x,program_name:x.programs?.name||'',booked_count:counts[x.id]||0}));
}

async function ensureManualCustomer(phone,fullName){
  const cleanPhone=String(phone).trim();
  const cleanName=String(fullName).trim().replace(/\s+/g,' ');

  const {data:existing,error:eErr}=await supabase
    .from('customers')
    .select('id,phone,full_name,status')
    .eq('phone',cleanPhone)
    .maybeSingle();
  if(eErr) throw eErr;

  if(existing){
    if(existing.status!=='ACTIVE') throw new Error('CUSTOMER_NOT_ACTIVE');
    if(cleanName && cleanName!==existing.full_name){
      await supabase.from('customers').update({full_name:cleanName,updated_at:new Date().toISOString()}).eq('id',existing.id);
    }
    return existing.id;
  }

  // Manual-transfer customer still needs a real auth UUID because orders/bookings
  // reference auth.users. Create a passwordless internal auth account.
  const email=`manual-${cleanPhone}-${crypto.randomBytes(4).toString('hex')}@speakhub.local`;
  const {data:authData,error:authErr}=await supabase.auth.admin.createUser({
    email,
    email_confirm:true,
    user_metadata:{full_name:cleanName,phone:cleanPhone,source:'ADMIN_MANUAL'}
  });
  if(authErr) throw authErr;
  const userId=authData?.user?.id;
  if(!userId) throw new Error('MANUAL_AUTH_USER_CREATE_FAILED');

  const {error:cErr}=await supabase.from('customers').insert({
    id:userId,
    phone:cleanPhone,
    full_name:cleanName,
    status:'ACTIVE'
  });
  if(cErr) throw cErr;

  return userId;
}

async function handleManualBookings(request){
  if(request.method==='GET'){
    const sessions=await getManualSessions();

    let orders=[];
    try{
      const {data,error}=await supabase
        .from('orders')
        .select(`
          id,order_code,user_id,total_amount,paid_at,payment_status,order_status,created_at,
          customers:user_id(full_name,phone),
          bookings(id,session_id,status,class_sessions(session_date,starts_at,ends_at,programs(name)))
        `)
        .eq('payment_status','PAID')
        .like('order_code','MANUAL-%')
        .order('created_at',{ascending:false})
        .limit(300);

      if(error) throw error;

      orders=(data||[]).map(o=>({
        order_id:o.id,
        order_code:o.order_code,
        full_name:o.customers?.full_name||'',
        phone:o.customers?.phone||'',
        total_amount:Number(o.total_amount||0),
        paid_date:o.paid_at?String(o.paid_at).slice(0,10):'',
        bookings:(o.bookings||[])
          .filter(b=>['CONFIRMED','ATTENDED','NO_SHOW'].includes(String(b.status||'')))
          .map(b=>({
            booking_id:b.id,
            session_id:b.session_id,
            session_date:b.class_sessions?.session_date||'',
            starts_at:b.class_sessions?.starts_at||'',
            ends_at:b.class_sessions?.ends_at||'',
            program_name:b.class_sessions?.programs?.name||''
          }))
          .sort((a,b)=>`${a.session_date} ${a.starts_at}`.localeCompare(`${b.session_date} ${b.starts_at}`))
      })).filter(o=>o.bookings.length);
    }catch(historyErr){
      console.error('manual order history load failed',historyErr);
    }

    return Response.json({sessions,orders});
  }

  if(request.method==='POST'){
    const b=await request.json().catch(()=>({}));
    const phone=String(b.phone||'').trim();
    const fullName=String(b.full_name||'').trim();
    const sessionIds=[...new Set((Array.isArray(b.session_ids)?b.session_ids:[]).map(x=>String(x||'')).filter(Boolean))];
    const amount=Math.round(Number(b.amount||0));
    const paidDate=String(b.paid_date||'').trim();

    if(!validManualPhone(phone)) return Response.json({error:'SĐT phải gồm 10 số và bắt đầu bằng 0.'},{status:400});
    if(!validManualName(fullName)) return Response.json({error:'Vui lòng nhập đầy đủ họ tên.'},{status:400});
    if(!sessionIds.length) return Response.json({error:'Vui lòng chọn ít nhất 1 session.'},{status:400});
    if(!Number.isFinite(amount)||amount<0) return Response.json({error:'Số tiền đã nhận không được âm.'},{status:400});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) return Response.json({error:'Vui lòng chọn ngày thanh toán thành công.'},{status:400});

    const customerId=await ensureManualCustomer(phone,fullName);

    const {data:selectedSessions,error:sErr}=await supabase
      .from('class_sessions')
      .select('id,capacity,status,session_date,starts_at')
      .in('id',sessionIds);
    if(sErr) throw sErr;
    if((selectedSessions||[]).length!==sessionIds.length) return Response.json({error:'Có session không tồn tại.'},{status:400});

    for(const session of selectedSessions||[]){
      if(session.status!=='OPEN') return Response.json({error:`Session ${session.session_date} ${String(session.starts_at).slice(0,5)} không còn OPEN.`},{status:400});

      const {count,error:countErr}=await supabase
        .from('bookings').select('*',{count:'exact',head:true})
        .eq('session_id',session.id)
        .in('status',['CONFIRMED','ATTENDED','NO_SHOW']);
      if(countErr) throw countErr;
      if(Number(count||0)>=Number(session.capacity||0)){
        return Response.json({error:`Session ${session.session_date} ${String(session.starts_at).slice(0,5)} đã FULL.`},{status:400});
      }

      // Same phone/customer may intentionally book another seat in the same session.
      // Capacity is still enforced above; each booking row counts as one seat.
    }

    // Use noon Vietnam time so selecting a paid calendar date never shifts to
    // the previous day when rendered through UTC-aware clients.
    const paidAt=`${paidDate}T12:00:00+07:00`;
    const now=new Date().toISOString();
    const count=sessionIds.length;
    const unitPrice=Math.round(amount/count);
    const orderCode=`MANUAL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // Manual-transfer orders follow the exact same customer reschedule rule
    // as normal paid orders:
    // 1–3 sessions  -> 1 change
    // 4–7 sessions  -> 2 changes
    // 8+ sessions   -> 3 changes
    const rescheduleLimit=count<4?1:(count<8?2:3);

    const {data:order,error:oErr}=await supabase.from('orders').insert({
      order_code:orderCode,
      user_id:customerId,
      session_count:count,
      unit_price:unitPrice,
      original_total:amount,
      discount_amount:0,
      total_amount:amount,
      reschedule_limit:rescheduleLimit,
      reschedule_used:0,
      payment_status:'PAID',
      order_status:'CONFIRMED',
      paid_at:paidAt
    }).select('id').single();
    if(oErr) throw oErr;

    const bookingRows=sessionIds.map(sessionId=>({
      user_id:customerId,
      order_id:order.id,
      session_id:sessionId,
      status:'CONFIRMED',
      confirmed_at:now
    }));

    const {data:bookings,error:bErr}=await supabase
      .from('bookings')
      .insert(bookingRows)
      .select('id,session_id');
    if(bErr) throw bErr;

    return Response.json({
      success:true,
      source:'ADMIN_MANUAL_TRANSFER',
      payment_status:'PAID',
      booking_status:'CONFIRMED',
      booking_count:(bookings||[]).length,
      booking_ids:(bookings||[]).map(x=>x.id),
      reschedule_limit:rescheduleLimit,
      total_amount:amount,
      paid_date:paidDate,
      order_id:order.id,
      customer_id:customerId
    },{status:201});
  }

  return Response.json({error:'Method not allowed'},{status:405});
}

async function handleManualReschedule(request){
  if(request.method!=='POST') return Response.json({error:'Method not allowed'},{status:405});
  const b=await request.json().catch(()=>({}));
  const bookingId=String(b.booking_id||''), targetId=String(b.session_id||'');
  if(!bookingId||!targetId) return Response.json({error:'MISSING_FIELDS'},{status:400});

  const {data:booking,error:bErr}=await supabase
    .from('bookings')
    .select('id,user_id,session_id,status,orders!inner(order_code,payment_status)')
    .eq('id',bookingId).maybeSingle();
  if(bErr) throw bErr;
  if(!booking) return Response.json({error:'BOOKING_NOT_FOUND'},{status:404});
  if(!String(booking.orders?.order_code||'').startsWith('MANUAL-')) return Response.json({error:'NOT_MANUAL_BOOKING'},{status:403});
  if(booking.orders?.payment_status!=='PAID') return Response.json({error:'ORDER_NOT_PAID'},{status:400});
  if(booking.session_id===targetId) return Response.json({success:true,unchanged:true});

  const {data:target,error:tErr}=await supabase
    .from('class_sessions').select('id,capacity,status').eq('id',targetId).maybeSingle();
  if(tErr) throw tErr;
  if(!target) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  if(target.status!=='OPEN') return Response.json({error:'SESSION_NOT_OPEN'},{status:400});

  const {count,error:cErr}=await supabase.from('bookings').select('*',{count:'exact',head:true})
    .eq('session_id',targetId).in('status',['CONFIRMED','ATTENDED','NO_SHOW']);
  if(cErr) throw cErr;
  if(Number(count||0)>=Number(target.capacity||0)) return Response.json({error:'SESSION_FULL'},{status:400});

  // Admin may move this booking into a session where the same customer
  // already has another seat. Capacity remains the only seat-limit rule.

  const {error:uErr}=await supabase.from('bookings').update({session_id:targetId}).eq('id',bookingId);
  if(uErr) throw uErr;

  return Response.json({success:true});
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


function extractOpenAIOutputText(data){
  if(typeof data?.output_text==='string' && data.output_text.trim()) return data.output_text;
  const parts=[];
  for(const item of (data?.output||[])){
    for(const c of (item?.content||[])){
      if(typeof c?.text==='string') parts.push(c.text);
      else if(typeof c?.text?.value==='string') parts.push(c.text.value);
    }
  }
  return parts.join('\n').trim();
}

function parseOpenAIJson(text){
  return JSON.parse(String(text||'')
    .replace(/^```json\s*/i,'')
    .replace(/^```\s*/,'')
    .replace(/```$/,'')
    .trim());
}

function topicVocabularySchema(){
  return {
    type:'object',
    additionalProperties:false,
    properties:{
      items:{
        type:'array',
        minItems:10,
        maxItems:10,
        items:{
          type:'object',
          additionalProperties:false,
          properties:{
            word:{type:'string'},
            part_of_speech:{type:'string'},
            pronunciation:{type:'string'},
            vietnamese:{type:'string'},
            example:{type:'string'},
            situation:{type:'string'}
          },
          required:['word','part_of_speech','pronunciation','vietnamese','example','situation']
        }
      }
    },
    required:['items']
  };
}

async function generateTopicVocabulary(topic,program){
  if(!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY_MISSING');

  const prompt=`Create practical vocabulary for an OFFLINE English speaking club in Vietnam.

CLASS: ${program}
TOPIC: ${topic}

Create exactly 10 useful words, phrases, or collocations that students can actively use while discussing this topic.

Difficulty — follow this strictly:
- Kid Starter: VERY EASY A1 concrete words and short phrases. Avoid abstract vocabulary.
- Kid Communicator: EASY A1–A2 speaking words/phrases suitable for children.
- Adult Beginner: EASY practical A1–A2 conversational English. Avoid difficult synonyms and academic vocabulary.
- Adult Intermediate: practical B1 conversational vocabulary and common collocations. Do NOT make it IELTS/academic/B2-heavy.

For every item:
- word: useful English word/phrase/collocation
- part_of_speech: short English label
- pronunciation: simple IPA if useful, otherwise empty string
- vietnamese: concise Vietnamese meaning
- example: one natural English sentence related directly to the topic
- situation: one short Vietnamese situation where the student could naturally use this word/phrase

Avoid obscure words and duplicate meanings. Keep situation concise and practical.`;

  const resp=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{
      Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model:process.env.OPENAI_PLACEMENT_MODEL||'gpt-5-mini',
      store:false,
      input:[
        {
          role:'developer',
          content:[{
            type:'input_text',
            text:'Return only the requested structured SpeakHub vocabulary list. Vietnamese meanings must be natural and concise.'
          }]
        },
        {
          role:'user',
          content:[{type:'input_text',text:prompt}]
        }
      ],
      text:{
        format:{
          type:'json_schema',
          name:'speakhub_topic_vocabulary',
          strict:true,
          schema:topicVocabularySchema()
        }
      }
    })
  });

  const data=await resp.json().catch(()=>({}));
  if(!resp.ok){
    console.error('OpenAI vocabulary generation error',data);
    throw new Error(data?.error?.message||'OPENAI_VOCABULARY_FAILED');
  }

  let parsed;
  try{
    parsed=JSON.parse(extractResponseText(data));
  }catch(err){
    console.error('Vocabulary structured output parse error',data);
    throw new Error('VOCABULARY_RESULT_INVALID');
  }

  const items=Array.isArray(parsed?.items)?parsed.items:[];
  if(items.length!==10) throw new Error('VOCABULARY_COUNT_INVALID');
  return items;
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
  if(!title){
    return Response.json({
      error:'TOPIC_TITLE_REQUIRED',
      details:'Vui lòng nhập tên topic. Hệ thống không dùng tên file PDF làm tên topic.'
    },{status:400});
  }

  if(file.type && file.type!=='application/pdf'){
    return Response.json({error:'PDF_ONLY'},{status:400});
  }

  const {data:session,error:sErr}=await supabase
    .from('class_sessions')
    .select(`
      id,program_id,teacher_id,session_date,starts_at,ends_at,
      programs(name)
    `)
    .eq('id',sessionId)
    .maybeSingle();

  if(sErr) throw sErr;
  if(!session){
    return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  }

  const topicTitle=title;

  // Generate first. Admin only gets "success" when both topic + shared vocabulary
  // are ready, so we never silently save an empty vocabulary list.
  let topicVocabulary;
  try{
    topicVocabulary=await generateTopicVocabulary(
      topicTitle,
      session.programs?.name||'SpeakHub'
    );
  }catch(vErr){
    console.error('topic vocabulary pre-generation failed',vErr);
    return Response.json({
      error:'TOPIC_VOCABULARY_GENERATION_FAILED',
      details:String(vErr?.message||vErr)
    },{status:502});
  }

  const path=`${session.session_date}-${slug(session.programs?.name)}-${slug(topicTitle)}.pdf`;
  const bytes=await file.arrayBuffer();

  const {error:uErr}=await supabase.storage
    .from('topics')
    .upload(path,bytes,{contentType:'application/pdf',upsert:true});

  if(uErr) throw uErr;

  // Important: older recurring data may contain duplicate physical rows.
  // Propagate topic + shared vocabulary to every equivalent logical session.
  let q=supabase
    .from('class_sessions')
    .update({
      topic_title:topicTitle,
      topic_storage_path:path,
      topic_vocabulary:topicVocabulary
    })
    .eq('program_id',session.program_id)
    .eq('session_date',session.session_date)
    .eq('starts_at',session.starts_at)
    .eq('ends_at',session.ends_at);

  if(session.teacher_id){
    q=q.eq('teacher_id',session.teacher_id);
  }else{
    q=q.is('teacher_id',null);
  }

  const {data:updated,error:updateErr}=await q.select('id');

  if(updateErr) throw updateErr;

  return Response.json({
    success:true,
    path,
    topic_title:topicTitle,
    vocabulary_generated:true,
    vocabulary_count:topicVocabulary.length,
    vocabulary_error:null,
    updated_session_count:(updated||[]).length,
    updated_session_ids:(updated||[]).map(x=>x.id)
  });
}



async function handleTopicDelete(request){
  if(request.method!=='POST'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const b=await request.json().catch(()=>({}));
  const sessionId=String(b.session_id||'');
  if(!sessionId) return Response.json({error:'SESSION_ID_REQUIRED'},{status:400});

  const {data:session,error:sErr}=await supabase
    .from('class_sessions')
    .select('id,program_id,teacher_id,session_date,starts_at,ends_at,topic_storage_path')
    .eq('id',sessionId)
    .maybeSingle();

  if(sErr) throw sErr;
  if(!session) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});

  const path=String(session.topic_storage_path||'').trim();

  let q=supabase
    .from('class_sessions')
    .update({
      topic_title:null,
      topic_storage_path:null,
      topic_vocabulary:[]
    })
    .eq('program_id',session.program_id)
    .eq('session_date',session.session_date)
    .eq('starts_at',session.starts_at)
    .eq('ends_at',session.ends_at);

  if(session.teacher_id) q=q.eq('teacher_id',session.teacher_id);
  else q=q.is('teacher_id',null);

  const {data:updated,error:uErr}=await q.select('id');
  if(uErr) throw uErr;

  if(path){
    const {error:storageErr}=await supabase.storage.from('topics').remove([path]);
    if(storageErr){
      console.error('Topic storage delete warning',storageErr);
    }
  }

  return Response.json({
    success:true,
    deleted_session_count:(updated||[]).length,
    deleted_session_ids:(updated||[]).map(x=>x.id)
  });
}

async function requireActiveCustomer(customerId,token){
  if(!customerId||!token) return {error:'CUSTOMER_TOKEN_REQUIRED',status:401};

  const {data,error}=await supabase
    .from('customers')
    .select('id,status,full_name,phone')
    .eq('id',customerId)
    .eq('device_token',token)
    .maybeSingle();

  if(error) throw error;
  if(!data) return {error:'INVALID_CUSTOMER_TOKEN',status:401};
  if(data.status!=='ACTIVE') return {error:'CUSTOMER_NOT_ACTIVE',status:403};
  return {customer:data};
}

function startOfCurrentWeekISO(){
  const now=new Date();
  const vn=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh'}));
  const day=vn.getDay()===0?7:vn.getDay();
  vn.setDate(vn.getDate()-(day-1));
  vn.setHours(0,0,0,0);
  return vn.toISOString();
}

async function placementUsage(customerId){
  return dailyTestUsage(customerId,'PLACEMENT');
}

async function dailyPlacementUsage(customerId,visitorId){
  const b=vnTodayBounds();
  let q=supabase.from('test_attempts')
    .select('*',{count:'exact',head:true})
    .eq('test_type','PLACEMENT')
    .gte('created_at',b.start)
    .lt('created_at',b.end);

  if(customerId) q=q.eq('customer_id',customerId);
  else q=q.eq('visitor_id',visitorId).is('customer_id',null);

  const {count,error}=await q;
  if(error)throw error;
  const used=Number(count||0),limit=3;
  return {used,remaining:Math.max(0,limit-used),limit,date:b.day};
}
async function recordPlacementAttempt(customerId,visitorId){
  const row={
    customer_id:customerId||null,
    visitor_id:customerId?null:visitorId,
    test_type:'PLACEMENT'
  };
  const {error}=await supabase.from('test_attempts').insert(row);
  if(error)throw error;
}
async function resolvePlacementIdentity(customerId,token,visitorId){
  if(customerId||token){
    const auth=await requireActiveCustomer(customerId,token);
    if(auth.error)return {error:auth.error,status:auth.status};
    return {customerId:auth.customer.id,visitorId:null,customer:auth.customer};
  }
  const v=String(visitorId||'').slice(0,120);
  if(!v)return {error:'PLACEMENT_IDENTITY_REQUIRED',status:400};
  return {customerId:null,visitorId:v,customer:null};
}

async function handlePlacementStatus(request){
  if(request.method!=='GET'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const url=new URL(request.url);
  const customerId=url.searchParams.get('customer_id');
  const token=url.searchParams.get('token');
  const visitorId=url.searchParams.get('visitor_id');

  const ident=await resolvePlacementIdentity(customerId,token,visitorId);
  if(ident.error)return Response.json({error:ident.error},{status:ident.status});

  return Response.json(await dailyPlacementUsage(ident.customerId,ident.visitorId));
}

function averageTranscriptionConfidence(logprobs){
  if(!Array.isArray(logprobs)||!logprobs.length) return null;
  const vals=logprobs
    .map(x=>Number(x?.logprob))
    .filter(Number.isFinite)
    .map(lp=>Math.exp(lp));
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}

async function handlePlacementTranscribe(request){
  if(request.method!=='POST'){
    return Response.json({error:'Method not allowed'},{status:405});
  }
  if(!process.env.OPENAI_API_KEY){
    return Response.json({error:'OPENAI_API_KEY_MISSING'},{status:500});
  }

  const fd=await request.formData();
  const customerId=String(fd.get('customer_id')||'');
  const token=String(fd.get('token')||'');
  const visitorId=String(fd.get('visitor_id')||'');
  const audio=fd.get('audio');

  const ident=await resolvePlacementIdentity(customerId,token,visitorId);
  if(ident.error) return Response.json({error:ident.error},{status:ident.status});

  const usageBefore=await dailyPlacementUsage(ident.customerId,ident.visitorId);
  if(usageBefore.remaining<=0) return Response.json({error:'TEST_DAILY_LIMIT',usage:usageBefore},{status:429});

  // Daily test limit enforced server-side for both customers and guests.
  if(!audio || typeof audio.arrayBuffer!=='function'){
    return Response.json({error:'AUDIO_REQUIRED'},{status:400});
  }

  if(Number(audio.size||0)>12*1024*1024){
    return Response.json({error:'AUDIO_TOO_LARGE'},{status:413});
  }

  const openaiForm=new FormData();
  openaiForm.append('file',audio,audio.name||'placement.webm');
  openaiForm.append('model',process.env.OPENAI_TRANSCRIBE_MODEL||'gpt-4o-mini-transcribe');
  openaiForm.append('language','en');
  openaiForm.append('response_format','json');
  openaiForm.append('include[]','logprobs');
  openaiForm.append(
    'prompt',
    'This is an English placement speaking test. Preserve the learner wording, grammar mistakes, repetitions, fillers, and incomplete sentences as faithfully as possible.'
  );

  const resp=await fetch('https://api.openai.com/v1/audio/transcriptions',{
    method:'POST',
    headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
    body:openaiForm
  });

  const data=await resp.json().catch(()=>({}));
  if(!resp.ok){
    console.error('OpenAI transcription error',data);
    return Response.json({
      error:'TRANSCRIPTION_FAILED',
      details:data?.error?.message||'OpenAI transcription failed'
    },{status:502});
  }

  return Response.json({
    text:String(data.text||'').trim(),
    confidence:averageTranscriptionConfidence(data.logprobs),
    usage:data.usage||null
  });
}

function placementSchema(){
  return {
    type:'object',
    additionalProperties:false,
    properties:{
      overall_score:{type:'integer',minimum:0,maximum:100},
      grammar_score:{type:'integer',minimum:0,maximum:100},
      vocabulary_score:{type:'integer',minimum:0,maximum:100},
      fluency_score:{type:'integer',minimum:0,maximum:100},
      pronunciation_score:{type:'integer',minimum:0,maximum:100},
      comprehension_score:{type:'integer',minimum:0,maximum:100},
      cefr_estimate:{type:'string',enum:['Pre-A1','A1','A2','B1','B2+']},
      recommended_program_name:{
        type:'string',
        enum:['Kid Starter','Kid Communicator','Adult Beginner','Adult Intermediate']
      },
      confidence:{type:'number',minimum:0,maximum:1},
      summary_vi:{type:'string'},
      strengths_vi:{type:'array',items:{type:'string'},minItems:2,maxItems:5},
      improvements_vi:{type:'array',items:{type:'string'},minItems:2,maxItems:5},
      reading_feedback_vi:{type:'array',items:{type:'string'},minItems:2,maxItems:5},
      speaking_feedback_vi:{type:'array',items:{type:'string'},minItems:3,maxItems:6},
      recommended_study_focus_vi:{type:'array',items:{type:'string'},minItems:3,maxItems:6},
      level_reason_vi:{type:'string'},
      grammar_examples:{
        type:'array',
        minItems:0,
        maxItems:3,
        items:{
          type:'object',
          additionalProperties:false,
          properties:{
            original:{type:'string'},
            corrected:{type:'string'},
            explanation_vi:{type:'string'}
          },
          required:['original','corrected','explanation_vi']
        }
      }
    },
    required:[
      'overall_score','grammar_score','vocabulary_score','fluency_score',
      'pronunciation_score','comprehension_score','cefr_estimate',
      'recommended_program_name','confidence','summary_vi',
      'strengths_vi','improvements_vi','reading_feedback_vi',
      'speaking_feedback_vi','recommended_study_focus_vi',
      'level_reason_vi','grammar_examples'
    ]
  };
}

function extractResponseText(data){
  if(typeof data?.output_text==='string') return data.output_text;
  const out=Array.isArray(data?.output)?data.output:[];
  for(const item of out){
    for(const c of (item?.content||[])){
      if(c?.type==='output_text' && typeof c.text==='string') return c.text;
    }
  }
  return '';
}

async function handlePlacementScore(request){
  // Limit successful AI tests to 3 per Vietnam calendar day.

  if(request.method!=='POST'){
    return Response.json({error:'Method not allowed'},{status:405});
  }
  if(!process.env.OPENAI_API_KEY){
    return Response.json({error:'OPENAI_API_KEY_MISSING'},{status:500});
  }

  const b=await request.json().catch(()=>({}));
  const customerId=String(b.customer_id||'');
  const token=String(b.token||'');
  const visitorId=String(b.visitor_id||'');

  const ident=await resolvePlacementIdentity(customerId,token,visitorId);
  if(ident.error) return Response.json({error:ident.error},{status:ident.status});

  const usageBefore=await dailyPlacementUsage(ident.customerId,ident.visitorId);
  if(usageBefore.remaining<=0) return Response.json({error:'TEST_DAILY_LIMIT',usage:usageBefore},{status:429});

  // Anonymous users may take placement tests; booked customers keep account-linked history.
  const birthYear=Number(b.birth_year||0);
  const nowYear=new Date().getFullYear();
  const age=nowYear-birthYear;
  if(!birthYear || age<5 || age>90){
    return Response.json({error:'INVALID_BIRTH_YEAR'},{status:400});
  }

  const q1=String(b.question_1||'').trim();
  const q2=String(b.question_2||'').trim();
  const t1=String(b.transcript_1||'').trim();
  const t2=String(b.transcript_2||'').trim();
  const readingAnswers=Array.isArray(b.reading_answers)?b.reading_answers:[];
  const readingCorrect=Array.isArray(b.reading_correct)?b.reading_correct:[];
  const readingItems=Array.isArray(b.reading_items)?b.reading_items:[];
  const readingScore=readingCorrect.length
    ? Math.round(100*readingCorrect.filter((x,i)=>String(readingAnswers[i])===String(x)).length/readingCorrect.length)
    : 0;

  if(!t1 && !t2){
    return Response.json({error:'SPEAKING_REQUIRED'},{status:400});
  }

  const clarity1=Number.isFinite(Number(b.transcription_confidence_1))
    ? Math.round(Number(b.transcription_confidence_1)*100)
    : null;
  const clarity2=Number.isFinite(Number(b.transcription_confidence_2))
    ? Math.round(Number(b.transcription_confidence_2)*100)
    : null;

  const allowedByAge=age<15
    ? ['Kid Starter','Kid Communicator']
    : ['Adult Beginner','Adult Intermediate'];

  const prompt=`You are the SpeakHub English Placement Assessor.

Evaluate a learner for an OFFLINE English speaking club. Be consistent, practical, and supportive.
This is NOT an IELTS/academic English exam. The goal is to place learners into a speaking club where they can participate comfortably and improve.

AGE: ${age}
ALLOWED PROGRAMS FOR THIS AGE: ${allowedByAge.join(', ')}

AGE-SPECIFIC PLACEMENT RULE:
${age<10
  ? '- Young child: keep the benchmark gentle. The ONLY goal is Kid Starter vs Kid Communicator. Reward understanding, short complete answers, willingness to speak, and basic everyday vocabulary. Never score like an adult exam.'
  : age<15
    ? '- Child/young teen: keep the benchmark accessible. The ONLY goal is Kid Starter vs Kid Communicator. Kid Communicator does not require advanced grammar; understanding and connected simple sentences are enough.'
    : '- Adult benchmark: Adult Intermediate means conversationally fluent and understandable; advanced academic English is NOT required.'}

READING:
Score: ${readingScore}/100
Learner answers: ${JSON.stringify(readingAnswers)}
Correct answers: ${JSON.stringify(readingCorrect)}
Question-level reading data: ${JSON.stringify(readingItems)}

SPEAKING QUESTION 1:
${q1}
TRANSCRIPT 1:
${t1 || '(no usable speech)'}

SPEAKING QUESTION 2:
${q2}
TRANSCRIPT 2:
${t2 || '(no usable speech)'}

TRANSCRIPTION CONFIDENCE PROXIES:
Q1: ${clarity1===null?'unknown':clarity1+'/100'}
Q2: ${clarity2===null?'unknown':clarity2+'/100'}

SCORING RUBRIC:
- Grammar 0-100: control of basic structures, tense, agreement, sentence construction.
- Vocabulary 0-100: range, appropriateness, ability to express meaning.
- Fluency 0-100: continuity, answer length, linking ideas, ability to sustain speech. Do not punish normal fillers heavily.
- Pronunciation 0-100: this is only a SPEECH CLARITY PROXY because you mainly have transcript + transcription confidence. Never claim phoneme-level precision. Use confidence proxies cautiously.
- Comprehension 0-100: reading performance + whether speaking answers directly understand the questions.
- Overall: weighted speaking-first score. Speaking should dominate.

PROGRAM GUIDANCE — SPEAKHUB PRACTICAL THRESHOLD:
Kid Starter:
- very short/basic answers or needs substantial prompting
- limited comprehension of simple questions
- mainly words, phrases, or very short sentences

Kid Communicator:
- understands everyday questions
- can answer with simple connected sentences
- can give a basic reason, example, or short story even with mistakes

Adult Beginner:
- understands basic everyday questions but often answers briefly
- may translate mentally, pause often, or rely on simple grammar/vocabulary
- can communicate meaning, but sustaining a conversation is still difficult

Adult Intermediate:
- IMPORTANT: this is NOT a high academic threshold
- roughly practical A2+ to B1 speaking is enough
- if the learner understands the question, can keep talking for several sentences, express the main idea, and give a simple reason/example, Intermediate is appropriate
- grammar mistakes, accent, pauses, limited vocabulary, or imperfect pronunciation do NOT block Intermediate when communication is clear
- do NOT require sophisticated debate language, advanced grammar, or native-like fluency

PLACEMENT PRIORITY:
1. Can the learner understand the question?
2. Can they communicate the intended meaning?
3. Can they sustain a response beyond isolated short sentences?
4. Can they give at least a simple reason/example?
Speaking communication matters more than grammatical perfection.

IMPORTANT:
- Choose ONLY from ALLOWED PROGRAMS FOR THIS AGE.
- Avoid being overly strict. SpeakHub Intermediate is a conversational club level, not an IELTS benchmark.
- A reasonably fluent and understandable adult should normally be Adult Intermediate even with frequent grammar errors.
- Reading supports the decision but should not downgrade a learner who clearly communicates well in speaking.
- Write detailed, friendly Vietnamese feedback.
- reading_feedback_vi: comment on comprehension, wrong/correct choices, and what the learner should review. Mention specific concepts when possible.
- speaking_feedback_vi: give 3–6 concrete observations across fluency, grammar, vocabulary, comprehension, and clarity.
- recommended_study_focus_vi: give 3–6 actionable study recommendations tailored to this learner, not generic advice.
- level_reason_vi: clearly explain why this program fits, and what would indicate readiness for the next level.
- grammar_examples must only contain genuine errors visible in transcripts. If there is no clear error, return [].
`;

  const openaiResp=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{
      Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model:process.env.OPENAI_PLACEMENT_MODEL||'gpt-5-mini',
      store:false,
      input:[
        {
          role:'developer',
          content:[{type:'input_text',text:'Return only the requested structured placement assessment. Do not add prose outside the schema.'}]
        },
        {
          role:'user',
          content:[{type:'input_text',text:prompt}]
        }
      ],
      text:{
        format:{
          type:'json_schema',
          name:'speakhub_placement_result',
          strict:true,
          schema:placementSchema()
        }
      }
    })
  });

  const openaiData=await openaiResp.json().catch(()=>({}));
  if(!openaiResp.ok){
    console.error('OpenAI placement scoring error',openaiData);
    return Response.json({
      error:'PLACEMENT_AI_FAILED',
      details:openaiData?.error?.message||'OpenAI placement scoring failed'
    },{status:502});
  }

  let result;
  try{
    result=JSON.parse(extractResponseText(openaiData));
  }catch(err){
    console.error('placement result parse error',openaiData);
    return Response.json({error:'PLACEMENT_RESULT_INVALID'},{status:502});
  }

  if(!allowedByAge.includes(result.recommended_program_name)){
    result.recommended_program_name=age<15?'Kid Communicator':'Adult Beginner';
    result.confidence=Math.min(Number(result.confidence||0),0.5);
  }

  // Blend the limited speech-clarity proxy into pronunciation conservatively.
  const clarityVals=[clarity1,clarity2].filter(Number.isFinite);
  if(clarityVals.length){
    const avg=Math.round(clarityVals.reduce((a,b)=>a+b,0)/clarityVals.length);
    result.pronunciation_score=Math.round(
      0.65*Number(result.pronunciation_score||0)+0.35*avg
    );
  }

  const {data:program,error:programErr}=await supabase
    .from('programs')
    .select('id,name,code')
    .eq('name',result.recommended_program_name)
    .maybeSingle();
  if(programErr) throw programErr;

  const insertRow={
    customer_id:ident.customerId,
    visitor_id:ident.customerId?null:ident.visitorId,
    birth_year:birthYear,
    age_at_test:age,
    reading_score:readingScore,
    question_1:q1,
    question_2:q2,
    transcript_1:t1||null,
    transcript_2:t2||null,
    transcription_confidence_1:Number.isFinite(Number(b.transcription_confidence_1))?Number(b.transcription_confidence_1):null,
    transcription_confidence_2:Number.isFinite(Number(b.transcription_confidence_2))?Number(b.transcription_confidence_2):null,
    grammar_score:result.grammar_score,
    vocabulary_score:result.vocabulary_score,
    fluency_score:result.fluency_score,
    pronunciation_score:result.pronunciation_score,
    comprehension_score:result.comprehension_score,
    overall_score:result.overall_score,
    cefr_estimate:result.cefr_estimate,
    recommended_program_id:program?.id||null,
    recommended_program_name:result.recommended_program_name,
    ai_confidence:result.confidence,
    summary_vi:result.summary_vi,
    strengths_vi:result.strengths_vi,
    improvements_vi:result.improvements_vi,
    grammar_examples:result.grammar_examples,
    raw_result:result,
    model_used:process.env.OPENAI_PLACEMENT_MODEL||'gpt-5-mini',
    status:'COMPLETED'
  };

  const {data:saved,error:saveErr}=await supabase
    .from('placement_tests')
    .insert(insertRow)
    .select('id,created_at')
    .single();

  if(saveErr) throw saveErr;

  await recordPlacementAttempt(ident.customerId,ident.visitorId);
  return Response.json({
    success:true,
    placement_test_id:saved.id,
    created_at:saved.created_at,
    program_id:program?.id||null,
    ...result,
    usage:await dailyPlacementUsage(ident.customerId,ident.visitorId)
  });
}


async function handlePlacementHistory(request){
  if(request.method!=='GET'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const url=new URL(request.url);
  const customerId=url.searchParams.get('customer_id');
  const token=url.searchParams.get('token');
  const visitorId=url.searchParams.get('visitor_id');

  const ident=await resolvePlacementIdentity(customerId,token,visitorId);
  if(ident.error)return Response.json({error:ident.error},{status:ident.status});

  let q=supabase
    .from('placement_tests')
    .select(`
      id,created_at,birth_year,age_at_test,reading_score,
      grammar_score,vocabulary_score,fluency_score,pronunciation_score,
      comprehension_score,overall_score,cefr_estimate,
      recommended_program_id,recommended_program_name,ai_confidence,
      summary_vi,strengths_vi,improvements_vi,grammar_examples,raw_result,status
    `)
    .eq('status','COMPLETED')
    .order('created_at',{ascending:false})
    .limit(30);

  if(ident.customerId) q=q.eq('customer_id',ident.customerId);
  else q=q.eq('visitor_id',ident.visitorId).is('customer_id',null);

  const {data,error}=await q;
  if(error) throw error;

  return Response.json({
    success:true,
    tests:(data||[]).map(x=>({
      ...x,
      reading_feedback_vi:x.raw_result?.reading_feedback_vi||[],
      speaking_feedback_vi:x.raw_result?.speaking_feedback_vi||[],
      recommended_study_focus_vi:x.raw_result?.recommended_study_focus_vi||[],
      level_reason_vi:x.raw_result?.level_reason_vi||''
    }))
  });
}


function progressSchema(){
  return {
    type:'object',
    additionalProperties:false,
    properties:{
      overall_score:{type:'integer',minimum:0,maximum:100},
      grammar_score:{type:'integer',minimum:0,maximum:100},
      vocabulary_score:{type:'integer',minimum:0,maximum:100},
      fluency_score:{type:'integer',minimum:0,maximum:100},
      pronunciation_score:{type:'integer',minimum:0,maximum:100},
      comprehension_score:{type:'integer',minimum:0,maximum:100},
      summary_vi:{type:'string'},
      strengths_vi:{type:'array',items:{type:'string'},minItems:2,maxItems:5},
      improvements_vi:{type:'array',items:{type:'string'},minItems:2,maxItems:5},
      speaking_feedback_vi:{type:'array',items:{type:'string'},minItems:3,maxItems:6},
      recommended_study_focus_vi:{type:'array',items:{type:'string'},minItems:3,maxItems:6},
      grammar_examples:{
        type:'array',
        minItems:0,
        maxItems:4,
        items:{
          type:'object',
          additionalProperties:false,
          properties:{
            original:{type:'string'},
            corrected:{type:'string'},
            explanation_vi:{type:'string'}
          },
          required:['original','corrected','explanation_vi']
        }
      }
    },
    required:[
      'overall_score','grammar_score','vocabulary_score','fluency_score',
      'pronunciation_score','comprehension_score','summary_vi',
      'strengths_vi','improvements_vi','speaking_feedback_vi',
      'recommended_study_focus_vi','grammar_examples'
    ]
  };
}

async function verifyProgressBooking(customerId,bookingId){
  if(!bookingId || bookingId==='TEST_MODE_PROGRESS'){
    return {
      booking:null,
      session:null,
      topic:'General English',
      program:'Adult Intermediate',
      is_test_mode:true
    };
  }

  const {data,error}=await supabase
    .from('bookings')
    .select(`
      id,user_id,session_id,status,
      class_sessions(
        id,session_date,topic_title,
        programs(name)
      )
    `)
    .eq('id',bookingId)
    .eq('user_id',customerId)
    .maybeSingle();

  if(error) throw error;
  if(!data) return {error:'BOOKING_NOT_FOUND',status:404};
  if(data.status!=='CONFIRMED') return {error:'BOOKING_NOT_CONFIRMED',status:400};

  return {
    booking:data,
    session:data.class_sessions||null,
    topic:data.class_sessions?.topic_title||'General English',
    program:data.class_sessions?.programs?.name||'SpeakHub',
    is_test_mode:false
  };
}

async function handleProgressScore(request){
  // Limit successful AI tests to 3 per Vietnam calendar day.

  if(request.method!=='POST'){
    return Response.json({error:'Method not allowed'},{status:405});
  }
  if(!process.env.OPENAI_API_KEY){
    return Response.json({error:'OPENAI_API_KEY_MISSING'},{status:500});
  }

  const b=await request.json().catch(()=>({}));
  const customerId=String(b.customer_id||'');
  const token=String(b.token||'');
  const bookingId=String(b.booking_id||'');

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});
  const usageBefore=await dailyTestUsage(customerId,'PROGRESS');
  if(usageBefore.remaining<=0) return Response.json({error:'TEST_DAILY_LIMIT',usage:usageBefore},{status:429});

  const verified=await verifyProgressBooking(customerId,bookingId);
  if(verified.error) return Response.json({error:verified.error},{status:verified.status});

  const quizItems=Array.isArray(b.quiz_items)?b.quiz_items:[];
  const quizCorrect=quizItems.length
    ? quizItems.filter(x=>Number(x.selected_index)===Number(x.correct_index)).length
    : 0;
  const quizScore=quizItems.length?Math.round(100*quizCorrect/quizItems.length):0;

  const q1=String(b.question_1||'').trim();
  const q2=String(b.question_2||'').trim();
  const t1=String(b.transcript_1||'').trim();
  const t2=String(b.transcript_2||'').trim();

  if(!t1 || !t2){
    return Response.json({error:'TWO_SPEAKING_ANSWERS_REQUIRED'},{status:400});
  }

  const clarity1=Number.isFinite(Number(b.transcription_confidence_1))
    ? Math.round(Number(b.transcription_confidence_1)*100)
    : null;
  const clarity2=Number.isFinite(Number(b.transcription_confidence_2))
    ? Math.round(Number(b.transcription_confidence_2)*100)
    : null;

  const prompt=`You are the SpeakHub Progress Test Assessor.

GOAL:
Measure change in practical English ability over time. This is NOT a topic-memory quiz and NOT IELTS.
Use the same practical speaking-club benchmark every session so scores remain comparable.

PROGRAM:
${verified.program}

SESSION TOPIC:
${verified.topic}

STANDARDIZED MULTIPLE CHOICE:
Score: ${quizScore}/100
Question data: ${JSON.stringify(quizItems)}

SPEAKING 1 — STANDARDIZED GENERAL ENGLISH:
Question: ${q1}
Transcript: ${t1}

SPEAKING 2 — LIGHTLY RELATED TO SESSION TOPIC:
Question: ${q2}
Transcript: ${t2}

TRANSCRIPTION CLARITY PROXY:
Q1: ${clarity1===null?'unknown':clarity1+'/100'}
Q2: ${clarity2===null?'unknown':clarity2+'/100'}

WEIGHTING:
- Speaking ability is the main signal.
- Speaking 1 is especially important because it is standardized/general and supports comparison over time.
- Speaking 2 tests transfer/application of English to the recent topic, but do NOT reward topic knowledge itself.
- Multiple choice supports Grammar/Vocabulary/Comprehension but should not dominate Overall.

SCORING:
Grammar: practical sentence control.
Vocabulary: range and appropriateness.
Fluency: continuity, linking, ability to sustain speech.
Pronunciation: only a speech-clarity proxy; do not claim phoneme-level precision.
Comprehension: standardized quiz + whether the learner understood both speaking prompts.
Overall: practical communication progress score.

IMPORTANT:
- Keep the benchmark stable across sessions.
- Do not raise/lower standards based on the topic.
- Topic familiarity must not inflate the score.
- Give detailed Vietnamese feedback.
- grammar_examples must only contain genuine errors visible in transcripts.
- recommended_study_focus_vi must be actionable.
`;

  const resp=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',
    headers:{
      Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      model:process.env.OPENAI_PLACEMENT_MODEL||'gpt-5-mini',
      store:false,
      input:[
        {
          role:'developer',
          content:[{type:'input_text',text:'Return only the requested structured English progress assessment.'}]
        },
        {
          role:'user',
          content:[{type:'input_text',text:prompt}]
        }
      ],
      text:{
        format:{
          type:'json_schema',
          name:'speakhub_progress_result',
          strict:true,
          schema:progressSchema()
        }
      }
    })
  });

  const data=await resp.json().catch(()=>({}));
  if(!resp.ok){
    console.error('OpenAI progress scoring error',data);
    return Response.json({
      error:'PROGRESS_AI_FAILED',
      details:data?.error?.message||'OpenAI progress scoring failed'
    },{status:502});
  }

  let result;
  try{
    result=JSON.parse(extractResponseText(data));
  }catch(err){
    console.error('progress result parse error',data);
    return Response.json({error:'PROGRESS_RESULT_INVALID'},{status:502});
  }

  const clarityVals=[clarity1,clarity2].filter(Number.isFinite);
  if(clarityVals.length){
    const avg=Math.round(clarityVals.reduce((a,b)=>a+b,0)/clarityVals.length);
    result.pronunciation_score=Math.round(
      0.65*Number(result.pronunciation_score||0)+0.35*avg
    );
  }

  const row={
    customer_id:customerId,
    booking_id:verified.booking?.id||null,
    session_id:verified.session?.id||null,
    program_name:verified.program,
    topic_title:verified.topic,
    quiz_score:quizScore,
    quiz_items:quizItems,
    question_1:q1,
    question_2:q2,
    transcript_1:t1,
    transcript_2:t2,
    transcription_confidence_1:Number.isFinite(Number(b.transcription_confidence_1))?Number(b.transcription_confidence_1):null,
    transcription_confidence_2:Number.isFinite(Number(b.transcription_confidence_2))?Number(b.transcription_confidence_2):null,
    grammar_score:result.grammar_score,
    vocabulary_score:result.vocabulary_score,
    fluency_score:result.fluency_score,
    pronunciation_score:result.pronunciation_score,
    comprehension_score:result.comprehension_score,
    overall_score:result.overall_score,
    summary_vi:result.summary_vi,
    strengths_vi:result.strengths_vi,
    improvements_vi:result.improvements_vi,
    speaking_feedback_vi:result.speaking_feedback_vi,
    recommended_study_focus_vi:result.recommended_study_focus_vi,
    grammar_examples:result.grammar_examples,
    raw_result:result,
    model_used:process.env.OPENAI_PLACEMENT_MODEL||'gpt-5-mini',
    status:'COMPLETED'
  };

  // Production: one progress result per booking. Test-mode fallback can save multiple attempts.
  let saved;
  if(verified.booking?.id){
    const {data:existing,error:findErr}=await supabase
      .from('progress_tests')
      .select('id')
      .eq('customer_id',customerId)
      .eq('booking_id',verified.booking.id)
      .maybeSingle();
    if(findErr) throw findErr;

    if(existing?.id){
      const {data:updateData,error:updateErr}=await supabase
        .from('progress_tests')
        .update(row)
        .eq('id',existing.id)
        .select('id,created_at')
        .single();
      if(updateErr) throw updateErr;
      saved=updateData;
    }else{
      const {data:insertData,error:insertErr}=await supabase
        .from('progress_tests')
        .insert(row)
        .select('id,created_at')
        .single();
      if(insertErr) throw insertErr;
      saved=insertData;
    }
  }else{
    const {data:insertData,error:insertErr}=await supabase
      .from('progress_tests')
      .insert(row)
      .select('id,created_at')
      .single();
    if(insertErr) throw insertErr;
    saved=insertData;
  }

  await recordTestAttempt(customerId,'PROGRESS');
  return Response.json({
    success:true,
    progress_test_id:saved.id,
    created_at:saved.created_at,
    quiz_score:quizScore,
    topic_title:verified.topic,
    program_name:verified.program,
    ...result
  });
}

async function handleProgressHistory(request){
  if(request.method!=='GET'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const url=new URL(request.url);
  const customerId=url.searchParams.get('customer_id');
  const token=url.searchParams.get('token');

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  const {data,error}=await supabase
    .from('progress_tests')
    .select(`
      id,created_at,booking_id,session_id,program_name,topic_title,quiz_score,
      grammar_score,vocabulary_score,fluency_score,pronunciation_score,
      comprehension_score,overall_score,summary_vi,strengths_vi,
      improvements_vi,speaking_feedback_vi,recommended_study_focus_vi,
      grammar_examples,status
    `)
    .eq('customer_id',customerId)
    .eq('status','COMPLETED')
    .order('created_at',{ascending:true})
    .limit(100);

  if(error) throw error;
  return Response.json({success:true,tests:data||[]});
}



function normalizePricingTiers(input){
  if(!Array.isArray(input)||!input.length) throw new Error('PRICE_TIERS_REQUIRED');
  const tiers=input.map(x=>({
    min_sessions:Number(x.min_sessions),
    max_sessions:(x.max_sessions===null||x.max_sessions===''||x.max_sessions===undefined)?null:Number(x.max_sessions),
    unit_price:Number(x.unit_price)
  })).sort((a,b)=>a.min_sessions-b.min_sessions);
  if(tiers[0].min_sessions!==1) throw new Error('PRICE_TIERS_MUST_START_AT_1');
  for(let i=0;i<tiers.length;i++){
    const t=tiers[i];
    if(!Number.isInteger(t.min_sessions)||t.min_sessions<1) throw new Error('INVALID_PRICE_MIN');
    if(!Number.isInteger(t.unit_price)||t.unit_price<0) throw new Error('INVALID_UNIT_PRICE');
    if(t.max_sessions!==null && (!Number.isInteger(t.max_sessions)||t.max_sessions<t.min_sessions)) throw new Error('INVALID_PRICE_MAX');
    if(i<tiers.length-1){
      if(t.max_sessions===null) throw new Error('ONLY_LAST_TIER_CAN_BE_OPEN_ENDED');
      if(tiers[i+1].min_sessions!==t.max_sessions+1) throw new Error('PRICE_TIERS_MUST_BE_CONTIGUOUS');
    }else if(t.max_sessions!==null){
      throw new Error('LAST_PRICE_TIER_MUST_BE_OPEN_ENDED');
    }
  }
  return tiers;
}
async function handlePublicPrice(){
  // Read the exact same pricing_config row used by Admin > Price.
  // This avoids a second RPC/function becoming stale or missing.
  const {data,error}=await supabase
    .from('pricing_config')
    .select('landing_price,tiers,updated_at')
    .eq('id',1)
    .maybeSingle();
  if(error) throw error;
  if(!data) throw new Error('PRICE_CONFIG_NOT_FOUND');

  return Response.json(data,{
    status:200,
    headers:{
      'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0',
      'CDN-Cache-Control':'no-store',
      'Vercel-CDN-Cache-Control':'no-store'
    }
  });
}

async function handlePrice(request){
  if(request.method==='GET'){
    const {data,error}=await supabase.from('pricing_config').select('landing_price,tiers,updated_at').eq('id',1).maybeSingle();
    if(error) throw error;
    return Response.json(data||{landing_price:89000,tiers:[
      {min_sessions:1,max_sessions:3,unit_price:119000},
      {min_sessions:4,max_sessions:7,unit_price:99000},
      {min_sessions:8,max_sessions:null,unit_price:89000}
    ]});
  }
  if(request.method==='POST'){
    const body=await request.json().catch(()=>({}));
    const landing=Number(body.landing_price);
    if(!Number.isInteger(landing)||landing<0) throw new Error('INVALID_LANDING_PRICE');
    const tiers=normalizePricingTiers(body.tiers);
    const {data,error}=await supabase.from('pricing_config').upsert({id:1,landing_price:landing,tiers,updated_at:new Date().toISOString()},{onConflict:'id'}).select('landing_price,tiers,updated_at').single();
    if(error) throw error;
    return Response.json(data);
  }
  return Response.json({error:'Method not allowed'},{status:405});
}


function vnTodayBounds(){
  const now=new Date();
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  return {
    day:parts,
    start:`${parts}T00:00:00+07:00`,
    end:`${addDaysISO(parts,1)}T00:00:00+07:00`
  };
}
async function dailyTestUsage(customerId,testType){
  const b=vnTodayBounds();
  const {count,error}=await supabase.from('test_attempts').select('*',{count:'exact',head:true})
    .eq('customer_id',customerId).eq('test_type',testType)
    .gte('created_at',b.start).lt('created_at',b.end);
  if(error)throw error;
  const used=Number(count||0),limit=3;
  return {used,remaining:Math.max(0,limit-used),limit,date:b.day};
}
async function recordTestAttempt(customerId,testType){
  const {error}=await supabase.from('test_attempts').insert({customer_id:customerId,test_type:testType});
  if(error)throw error;
}
async function handleProgressStatus(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  const u=new URL(request.url),customerId=u.searchParams.get('customer_id'),token=u.searchParams.get('token');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  return Response.json(await dailyTestUsage(customerId,'PROGRESS'));
}
async function relevantSessionIds(customerId){
  const {data,error}=await supabase.from('bookings').select('session_id,status,orders!inner(payment_status)')
    .eq('user_id',customerId).neq('status','CANCELLED').eq('orders.payment_status','PAID');
  if(error)throw error;
  return [...new Set((data||[]).map(x=>x.session_id).filter(Boolean))];
}
async function handleNotifications(request){
  const body=request.method==='POST'?await request.json().catch(()=>({})):{};
  const u=new URL(request.url);
  const customerId=body.customer_id||u.searchParams.get('customer_id'),token=body.token||u.searchParams.get('token');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const ids=await relevantSessionIds(customerId);
  if(!ids.length)return Response.json({notifications:[],unread_count:0});
  const {data:events,error}=await supabase.from('session_events').select(`
    id,event_type,message,created_at,session_id,
    class_sessions(session_date,starts_at,programs(name))
  `).in('session_id',ids).order('created_at',{ascending:false}).limit(100);
  if(error)throw error;
  const eventIds=(events||[]).map(x=>x.id);
  let readSet=new Set();
  if(eventIds.length){
    const {data:reads,error:rErr}=await supabase.from('notification_reads').select('event_id').eq('customer_id',customerId).in('event_id',eventIds);
    if(rErr)throw rErr;readSet=new Set((reads||[]).map(x=>x.event_id));
  }
  if(request.method==='POST' && body.mark_all && eventIds.length){
    const rows=eventIds.map(event_id=>({customer_id:customerId,event_id}));
    const {error:wErr}=await supabase.from('notification_reads').upsert(rows,{onConflict:'customer_id,event_id',ignoreDuplicates:true});
    if(wErr)throw wErr;readSet=new Set(eventIds);
  }
  const notifications=(events||[]).map(e=>({
    id:e.id,event_type:e.event_type,message:e.message,created_at:e.created_at,
    session_date:e.class_sessions?.session_date||'',starts_at:e.class_sessions?.starts_at||'',
    program_name:e.class_sessions?.programs?.name||'',unread:!readSet.has(e.id)
  }));
  return Response.json({notifications,unread_count:notifications.filter(x=>x.unread).length});
}
async function handleCommunity(request){
  const u=new URL(request.url);
  let b={};
  if(request.method==='POST')b=await request.json().catch(()=>({}));
  const customerId=b.customer_id||u.searchParams.get('customer_id'),token=b.token||u.searchParams.get('token');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  if(request.method==='POST'){
    if(b.op==='post'){
      const title=String(b.title||'').trim(),tag=String(b.tag||'Thảo luận').trim();
      if(!title)return Response.json({error:'TITLE_REQUIRED'},{status:400});
      const today=vnTodayBounds();
      const {count,error:cErr}=await supabase.from('community_posts').select('*',{count:'exact',head:true})
        .eq('customer_id',customerId).gte('created_at',today.start).lt('created_at',today.end);
      if(cErr)throw cErr;
      if(Number(count||0)>=3)return Response.json({error:'COMMUNITY_DAILY_LIMIT'},{status:429});
      const {error}=await supabase.from('community_posts').insert({customer_id:customerId,tag,title});
      if(error)throw error;
      return Response.json({success:true});
    }
    return Response.json({error:'UNKNOWN_COMMUNITY_OP'},{status:400});
  }
  const {data:posts,error}=await supabase.from('community_posts').select('id,tag,title,created_at,customers(full_name)').order('created_at',{ascending:false}).limit(100);
  if(error)throw error;
  const {data:stateRow,error:sErr}=await supabase.from('community_read_state').select('last_seen_at').eq('customer_id',customerId).maybeSingle();
  if(sErr)throw sErr;
  const lastSeen=stateRow?.last_seen_at?new Date(stateRow.last_seen_at).getTime():0;
  const unread=(posts||[]).filter(p=>new Date(p.created_at).getTime()>lastSeen && p.customers?.full_name!==auth.customer.full_name).length;
  if(u.searchParams.get('seen')==='1'){
    const {error:uErr}=await supabase.from('community_read_state').upsert({customer_id:customerId,last_seen_at:new Date().toISOString()},{onConflict:'customer_id'});
    if(uErr)throw uErr;
  }
  return Response.json({posts:(posts||[]).map(p=>({id:p.id,tag:p.tag,title:p.title,created_at:p.created_at,author:p.customers?.full_name||'Học viên',likes:0})),unread_count:u.searchParams.get('seen')==='1'?0:unread});
}
async function handleChat(request){
  const u=new URL(request.url);
  const b=request.method==='POST'?await request.json().catch(()=>({})):{};

  const customerId=b.customer_id||u.searchParams.get('customer_id')||'';
  const token=b.token||u.searchParams.get('token')||'';
  const visitorId=String(b.visitor_id||u.searchParams.get('visitor_id')||'').slice(0,120);

  let customer=null;
  if(customerId||token){
    const auth=await requireActiveCustomer(customerId,token);
    if(auth.error)return Response.json({error:auth.error},{status:auth.status});
    customer=auth.customer;
  }else if(!visitorId){
    return Response.json({error:'CHAT_IDENTITY_REQUIRED'},{status:400});
  }

  if(request.method==='POST'){
    const text=String(b.text||'').trim();
    const clientMessageId=String(b.client_message_id||'').slice(0,120);
    if(!text)return Response.json({error:'MESSAGE_REQUIRED'},{status:400});

    const row={
      customer_id:customer?.id||null,
      visitor_id:customer?.id?null:visitorId,
      sender:'USER',
      body:text,
      read_by_user:true,
      read_by_admin:false,
      client_message_id:clientMessageId||null
    };

    // Do not use upsert(onConflict: client_message_id) here.
    // The DB uses a partial unique index for non-null message IDs, and
    // PostgREST cannot reliably infer that index for ON CONFLICT.
    // A normal insert is correct; if a network retry sends the same
    // client_message_id twice, treat PostgreSQL 23505 as success.
    const {error}=await supabase.from('support_messages').insert(row);
    if(error && String(error.code||'')!=='23505') throw error;

    return Response.json({success:true,duplicate:String(error?.code||'')==='23505'});
  }

  let q=supabase.from('support_messages').select('id,sender,body,created_at');
  if(customer?.id) q=q.eq('customer_id',customer.id);
  else q=q.eq('visitor_id',visitorId).is('customer_id',null);

  const {data,error}=await q.order('created_at');
  if(error)throw error;

  let mark=supabase.from('support_messages').update({read_by_user:true})
    .eq('sender','ADMIN').eq('read_by_user',false);
  if(customer?.id) mark=mark.eq('customer_id',customer.id);
  else mark=mark.eq('visitor_id',visitorId).is('customer_id',null);
  await mark;

  return Response.json({messages:data||[]});
}
async function handleAccountBadges(request){
  const u=new URL(request.url);
  const customerId=u.searchParams.get('customer_id')||'';
  const token=u.searchParams.get('token')||'';
  const visitorId=String(u.searchParams.get('visitor_id')||'').slice(0,120);

  if(!customerId||!token){
    if(!visitorId){
      return Response.json({
        notification_unread:0,community_unread:0,chat_unread:0,
        placement:{used:0,remaining:3,limit:3},
        progress:{used:0,remaining:3,limit:3}
      });
    }
    const {count:chatUnread,error}=await supabase.from('support_messages')
      .select('*',{count:'exact',head:true})
      .eq('visitor_id',visitorId)
      .is('customer_id',null)
      .eq('sender','ADMIN')
      .eq('read_by_user',false);
    if(error)throw error;
    return Response.json({
      notification_unread:0,community_unread:0,chat_unread:chatUnread||0,
      placement:{used:0,remaining:3,limit:3},
      progress:{used:0,remaining:3,limit:3}
    });
  }

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error)return Response.json({error:auth.error},{status:auth.status});

  const ids=await relevantSessionIds(customerId);
  let notificationUnread=0;
  if(ids.length){
    const {data:events,error}=await supabase.from('session_events').select('id').in('session_id',ids);
    if(error)throw error;
    const eventIds=(events||[]).map(x=>x.id);
    if(eventIds.length){
      const {data:reads,error:rErr}=await supabase.from('notification_reads').select('event_id').eq('customer_id',customerId).in('event_id',eventIds);
      if(rErr)throw rErr;
      const rs=new Set((reads||[]).map(x=>x.event_id));
      notificationUnread=eventIds.filter(id=>!rs.has(id)).length;
    }
  }

  const {data:cr,error:crErr}=await supabase.from('community_read_state')
    .select('last_seen_at').eq('customer_id',customerId).maybeSingle();
  if(crErr)throw crErr;

  let cq=supabase.from('community_posts').select('*',{count:'exact',head:true});
  if(cr?.last_seen_at)cq=cq.gt('created_at',cr.last_seen_at);
  const cRes=await cq;if(cRes.error)throw cRes.error;

  const {count:chatUnread,error:chatErr}=await supabase.from('support_messages')
    .select('*',{count:'exact',head:true})
    .eq('customer_id',customerId)
    .eq('sender','ADMIN')
    .eq('read_by_user',false);
  if(chatErr)throw chatErr;

  const [placement,progress]=await Promise.all([
    dailyTestUsage(customerId,'PLACEMENT'),
    dailyTestUsage(customerId,'PROGRESS')
  ]);

  return Response.json({
    notification_unread:notificationUnread,
    community_unread:cRes.count||0,
    chat_unread:chatUnread||0,
    placement,progress
  });
}
async function handleTrackVisit(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const b=await request.json().catch(()=>({}));const visitor=String(b.visitor_id||'').slice(0,120);
  if(!visitor)return Response.json({error:'VISITOR_REQUIRED'},{status:400});
  const day=vnTodayBounds().day;
  const {error}=await supabase.from('website_visits').upsert({visitor_id:visitor,visited_on:day,last_seen_at:new Date().toISOString()},{onConflict:'visitor_id,visited_on'});
  if(error)throw error;return Response.json({success:true});
}
async function handleAdminChat(request){
  if(request.method==='GET'){
    const u=new URL(request.url);
    const threadKey=String(u.searchParams.get('thread_key')||'');

    if(threadKey){
      const [kind,id]=threadKey.split(':',2);
      let q=supabase.from('support_messages').select('id,sender,body,created_at,read_by_admin');
      if(kind==='customer') q=q.eq('customer_id',id);
      else if(kind==='visitor') q=q.eq('visitor_id',id).is('customer_id',null);
      else return Response.json({error:'INVALID_THREAD_KEY'},{status:400});

      const {data:messages,error}=await q.order('created_at');
      if(error)throw error;

      let mark=supabase.from('support_messages').update({read_by_admin:true})
        .eq('sender','USER').eq('read_by_admin',false);
      if(kind==='customer') mark=mark.eq('customer_id',id);
      else mark=mark.eq('visitor_id',id).is('customer_id',null);
      await mark;

      return Response.json({messages:messages||[]});
    }

    const {data:msgs,error}=await supabase.from('support_messages').select(
      'customer_id,visitor_id,sender,body,created_at,read_by_admin,customers(full_name,phone)'
    ).order('created_at',{ascending:false}).limit(1000);
    if(error)throw error;

    const map=new Map();
    for(const m of (msgs||[])){
      const key=m.customer_id?`customer:${m.customer_id}`:`visitor:${m.visitor_id}`;
      if(!key || key==='visitor:null')continue;
      if(!map.has(key)){
        map.set(key,{
          thread_key:key,
          customer_id:m.customer_id||null,
          visitor_id:m.visitor_id||null,
          full_name:m.customer_id?(m.customers?.full_name||'Học viên'):'Người lạ',
          phone:m.customer_id?(m.customers?.phone||''):'',
          last_message:m.body,
          last_at:m.created_at,
          unread:0
        });
      }
      if(m.sender==='USER'&&!m.read_by_admin)map.get(key).unread++;
    }

    return Response.json({
      threads:[...map.values()].sort((a,b)=>String(b.last_at).localeCompare(String(a.last_at)))
    });
  }

  const b=await request.json().catch(()=>({}));
  const threadKey=String(b.thread_key||'');
  const text=String(b.text||'').trim();
  if(!threadKey||!text)return Response.json({error:'MISSING_FIELDS'},{status:400});

  const [kind,id]=threadKey.split(':',2);
  const row={
    customer_id:kind==='customer'?id:null,
    visitor_id:kind==='visitor'?id:null,
    sender:'ADMIN',
    body:text,
    read_by_admin:true,
    read_by_user:false,
    client_message_id:String(b.client_message_id||'').slice(0,120)||null
  };

  if(!row.customer_id&&!row.visitor_id)return Response.json({error:'INVALID_THREAD_KEY'},{status:400});

  const {error}=await supabase.from('support_messages').insert(row);
  if(error && String(error.code||'')!=='23505') throw error;

  return Response.json({success:true,duplicate:String(error?.code||'')==='23505'});
}
function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

function isSupabaseClockSkewError(err){
  const code=String(err?.code||'');
  const msg=String(err?.message||'').toLowerCase();
  return code==='PGRST303' && msg.includes('jwt issued at future');
}

async function runAdminActionWithRetry(fn){
  try{
    return await fn();
  }catch(err){
    if(!isSupabaseClockSkewError(err)) throw err;

    // Rare transient clock skew between the serverless runtime and Supabase.
    // Wait briefly and retry once instead of blanking the entire Admin UI.
    console.warn('Supabase JWT clock skew detected; retrying admin request once.');
    await sleep(1200);
    return await fn();
  }
}


export default {
  async fetch(request){
    try{
      const url=new URL(request.url);
      const action=url.searchParams.get('action')||'';

      if(action==='login'){
        return await handleLogin(request);
      }

      // Customer-authenticated public AI placement actions.
      // Kept inside existing /api/admin.js so SpeakHub does not add another
      // Vercel Serverless Function on the Hobby plan.
      if(action==='placement-status') return await handlePlacementStatus(request);
      if(action==='placement-transcribe') return await handlePlacementTranscribe(request);
      if(action==='placement-score') return await handlePlacementScore(request);
      if(action==='placement-history') return await handlePlacementHistory(request);
      if(action==='progress-score') return await handleProgressScore(request);
      if(action==='progress-history') return await handleProgressHistory(request);
      if(action==='progress-status') return await handleProgressStatus(request);
      if(action==='notifications') return await handleNotifications(request);
      if(action==='community') return await handleCommunity(request);
      if(action==='chat'){
        try{
          return await handleChat(request);
        }catch(err){
          console.error('chat api error',err);
          return Response.json(
            {error:'CHAT_API_ERROR',details:String(err?.message||err),code:String(err?.code||'')},
            {status:500}
          );
        }
      }
      if(action==='account-badges') return await handleAccountBadges(request);
      if(action==='track-visit') return await handleTrackVisit(request);

      // Public read-only price config used by landing page and booking UI.
      // No admin secret is exposed; only landing_price + tiers are returned.
      if(action==='public-price') return await runAdminActionWithRetry(()=>handlePublicPrice());

      if(!requireAdmin(request)){
        return Response.json({error:'UNAUTHORIZED'},{status:401});
      }

      if(action==='overview') return await runAdminActionWithRetry(()=>handleOverview());
      if(action==='price') return await runAdminActionWithRetry(()=>handlePrice(request));
      if(action==='sessions') return await runAdminActionWithRetry(()=>handleSessions(request));
      if(action==='customers') return await runAdminActionWithRetry(()=>handleCustomers(request));
      if(action==='bookings') return await runAdminActionWithRetry(()=>handleBookings(request));
      if(action==='manual-bookings'){
        try{
          return await runAdminActionWithRetry(()=>handleManualBookings(request));
        }catch(err){
          console.error('manual booking api error',err);
          return Response.json(
            {error:'MANUAL_BOOKING_ERROR',details:String(err?.message||err),code:String(err?.code||'')},
            {status:500}
          );
        }
      }
      if(action==='manual-reschedule') return await runAdminActionWithRetry(()=>handleManualReschedule(request));
      if(action==='topic-upload') return await runAdminActionWithRetry(()=>handleTopicUpload(request));
      if(action==='topic-delete') return await runAdminActionWithRetry(()=>handleTopicDelete(request));
      if(action==='admin-chat') return await runAdminActionWithRetry(()=>handleAdminChat(request));

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
