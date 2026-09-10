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

function normalizeSupporterBranch(branch){
  const b=String(branch||'').trim().toLowerCase();
  if(b==='go-vap'||b==='govap'||b==='go_vap') return 'go-vap';
  if(b==='district-2'||b==='d2'||b==='district_2') return 'district-2';
  return '';
}
function signSupporterToken(branch){const secret=process.env.SPEAKHUB_SUPPORTER_SECRET||process.env.SPEAKHUB_ADMIN_SECRET;if(!secret)throw new Error('SUPPORTER_SECRET_MISSING');const cleanBranch=normalizeSupporterBranch(branch);if(!cleanBranch)throw new Error('INVALID_SUPPORTER_BRANCH');const payload=Buffer.from(JSON.stringify({role:'supporter',branch:cleanBranch,exp:Date.now()+12*60*60*1000})).toString('base64url');const sig=crypto.createHmac('sha256',secret).update(payload).digest('base64url');return `${payload}.${sig}`}
function requireSupporter(request){const secret=process.env.SPEAKHUB_SUPPORTER_SECRET||process.env.SPEAKHUB_ADMIN_SECRET;if(!secret)return null;const auth=request.headers.get('authorization')||'',token=auth.startsWith('Bearer ')?auth.slice(7):'', [payload,sig]=token.split('.');if(!payload||!sig)return null;const expected=crypto.createHmac('sha256',secret).update(payload).digest('base64url');try{if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));const branch=normalizeSupporterBranch(d.branch);return d.role==='supporter'&&branch&&Number(d.exp)>Date.now()?{...d,branch}:null}catch{return null}}
function supporterScopedRequest(request,branch){const u=new URL(request.url);u.searchParams.set('scope',branch);return new Request(u.toString(),request)}
async function handleSupporterLogin(request){
  if(request.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
  const b=await request.json().catch(()=>({})),password=String(b.password||'');
  const govap=String(process.env.CS_GOVAP_PASSWORD||''),d2=String(process.env.CS_D2_PASSWORD||'');
  if(!govap||!d2)return Response.json({error:'CS_BRANCH_PASSWORD_MISSING'},{status:500});
  const goMatch=password===govap,d2Match=password===d2;
  if(goMatch&&d2Match)return Response.json({error:'CS_PASSWORDS_MUST_BE_DIFFERENT'},{status:500});
  const branch=goMatch?'go-vap':(d2Match?'district-2':'');
  if(!branch)return Response.json({error:'INVALID_PASSWORD'},{status:401});
  return Response.json({token:signSupporterToken(branch),branch});
}


// ===== Publisher / affiliate =====
function publisherPasswordHash(password){
  const secret=process.env.SPEAKHUB_ADMIN_SECRET||'speakhub-publisher';
  return crypto.createHmac('sha256',secret).update(String(password||'')).digest('hex');
}
function randomPublisherSlug(){
  const letters='abcdefghijklmnopqrstuvwxyz',digits='0123456789',all=letters+digits;
  // Always include at least one letter and one digit, then shuffle the 4 characters.
  const chars=[letters[crypto.randomInt(letters.length)],digits[crypto.randomInt(digits.length)],all[crypto.randomInt(all.length)],all[crypto.randomInt(all.length)]];
  for(let i=chars.length-1;i>0;i--){const j=crypto.randomInt(i+1);[chars[i],chars[j]]=[chars[j],chars[i]]}
  return chars.join('');
}
function signPublisherToken(publisherId){
  const secret=process.env.SPEAKHUB_ADMIN_SECRET;if(!secret)throw new Error('ADMIN_SECRET_MISSING');
  const payload=Buffer.from(JSON.stringify({role:'publisher',publisher_id:publisherId,exp:Date.now()+12*60*60*1000})).toString('base64url');
  const sig=crypto.createHmac('sha256',secret).update(payload).digest('base64url');return `${payload}.${sig}`;
}
function publisherFromRequest(request){
  const secret=process.env.SPEAKHUB_ADMIN_SECRET;if(!secret)return null;
  const auth=request.headers.get('authorization')||'',token=auth.startsWith('Bearer ')?auth.slice(7):'',parts=token.split('.');if(parts.length!==2)return null;
  const [payload,sig]=parts,expected=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  try{if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return d.role==='publisher'&&Number(d.exp)>Date.now()?d:null}catch{return null}
}
function publisherPeriodBounds(month='',from='',to=''){
  const f=String(from||'').trim(),t=String(to||'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(f)&&/^\d{4}-\d{2}-\d{2}$/.test(t)){
    const start=new Date(f+'T00:00:00+07:00').toISOString();
    const endDate=new Date(t+'T00:00:00+07:00');endDate.setDate(endDate.getDate()+1);
    return {start,end:endDate.toISOString(),from:f,to:t,mode:'range'};
  }
  const m=String(month||'').trim();
  if(!/^\d{4}-\d{2}$/.test(m)) return null;
  const [y,mo]=m.split('-').map(Number);if(mo<1||mo>12)return null;
  const start=new Date(Date.UTC(y,mo-1,1)-7*60*60*1000).toISOString();
  const end=new Date(Date.UTC(y,mo,1)-7*60*60*1000).toISOString();
  return {start,end,month:m,mode:'month'};
}
function applyPublisherPeriod(query,column,bounds){return bounds?query.gte(column,bounds.start).lt(column,bounds.end):query;}
function normalizeCommissionScheme(input){
  if(!Array.isArray(input))return [];
  const rows=input.map(r=>({min_sessions:Math.max(1,Math.floor(Number(r?.min_sessions||0))),max_sessions:r?.max_sessions==null||r?.max_sessions===''?null:Math.floor(Number(r.max_sessions)),amount:Math.max(0,Math.round(Number(r?.amount||0)))})).filter(r=>r.min_sessions>0&&Number.isFinite(r.amount));
  rows.sort((a,b)=>a.min_sessions-b.min_sessions);
  for(const r of rows){if(r.max_sessions!=null&&(!Number.isFinite(r.max_sessions)||r.max_sessions<r.min_sessions))throw new Error('INVALID_COMMISSION_RANGE')}
  for(let i=1;i<rows.length;i++){const prev=rows[i-1];if(prev.max_sessions==null||rows[i].min_sessions<=prev.max_sessions)throw new Error('OVERLAPPING_COMMISSION_RANGES')}
  return rows;
}
function commissionForSessions(scheme,count,revenue,legacyRate=0){
  const rules=Array.isArray(scheme)?scheme:[];const n=Number(count||0);
  const rule=rules.find(r=>n>=Number(r.min_sessions||0)&&(r.max_sessions==null||n<=Number(r.max_sessions)));
  if(rule)return Math.max(0,Math.round(Number(rule.amount||0)));
  return rules.length?0:Math.round(Number(revenue||0)*Number(legacyRate||0)/100);
}
async function findPublisherForLogin(login){
  const value=String(login||'').trim();
  if(!value)return null;
  const slug=value.toLowerCase();
  let q=await supabase.from('publishers').select('id,name,phone,slug,login_code,password_hash,status,commission_rate,commission_scheme').eq('slug',slug).maybeSingle();
  if(q.error)throw q.error;if(q.data)return q.data;
  const phone=value.replace(/[\s.-]/g,'');
  q=await supabase.from('publishers').select('id,name,phone,slug,login_code,password_hash,status,commission_rate,commission_scheme').eq('phone',phone).maybeSingle();
  if(q.error)throw q.error;if(q.data)return q.data;
  // Backward compatibility with V108 login codes; new accounts use slug as code.
  q=await supabase.from('publishers').select('id,name,phone,slug,login_code,password_hash,status,commission_rate,commission_scheme').eq('login_code',value).maybeSingle();
  if(q.error)throw q.error;return q.data||null;
}
async function handlePublisherLogin(request){
  if(request.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
  const b=await request.json().catch(()=>({})),login=String(b.login||'').trim(),password=String(b.password||'');
  const data=await findPublisherForLogin(login);
  if(!data||data.status!=='ACTIVE'||data.password_hash!==publisherPasswordHash(password))return Response.json({error:'INVALID_LOGIN'},{status:401});
  return Response.json({token:signPublisherToken(data.id),publisher:{id:data.id,name:data.name,slug:data.slug,phone:data.phone||'',commission_rate:Number(data.commission_rate||0)}});
}
async function publisherClicksLast30Days(publisherId){
  const now=new Date();
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'});
  const today=fmt.format(now);
  const startDay=addDaysISO(today,-29);
  const startIso=new Date(`${startDay}T00:00:00+07:00`).toISOString();
  const counts=Object.fromEntries(Array.from({length:30},(_,i)=>[addDaysISO(startDay,i),0]));
  let from=0;
  while(true){
    const {data,error}=await supabase.from('publisher_clicks').select('clicked_at').eq('publisher_id',publisherId).gte('clicked_at',startIso).order('clicked_at',{ascending:true}).range(from,from+999);
    if(error)throw error;
    const rows=data||[];
    for(const row of rows){const day=fmt.format(new Date(row.clicked_at));if(Object.prototype.hasOwnProperty.call(counts,day))counts[day]++}
    if(rows.length<1000)break;
    from+=1000;
    if(from>=50000)break;
  }
  return Object.entries(counts).map(([date,clicks])=>({date,clicks}));
}

async function publisherReportRows(publisherId,month='',from='',to=''){
  const bounds=publisherPeriodBounds(month,from,to);
  const dailyClicksPromise=publisherClicksLast30Days(publisherId);
  let clicksQ=supabase.from('publisher_clicks').select('id,visitor_id,clicked_at').eq('publisher_id',publisherId).order('clicked_at',{ascending:false}).limit(10000);
  let eventsQ=supabase.from('publisher_events').select('visitor_id,customer_id,event_type,event_at').eq('publisher_id',publisherId).order('event_at',{ascending:false}).limit(20000);
  let attrsQ=supabase.from('publisher_order_attributions').select('order_id,customer_id,attributed_at').eq('publisher_id',publisherId).order('attributed_at',{ascending:false}).limit(10000);
  clicksQ=applyPublisherPeriod(clicksQ,'clicked_at',bounds);eventsQ=applyPublisherPeriod(eventsQ,'event_at',bounds);attrsQ=applyPublisherPeriod(attrsQ,'attributed_at',bounds);
  const [{data:pub,error:pErr},{data:clicks,error:cErr},{data:events,error:eErr},{data:attrs,error:aErr}]=await Promise.all([
    supabase.from('publishers').select('id,name,phone,slug,login_code,status,commission_rate,commission_scheme,created_at').eq('id',publisherId).maybeSingle(),clicksQ,eventsQ,attrsQ
  ]);if(pErr)throw pErr;if(cErr)throw cErr;if(eErr)throw eErr;if(aErr)throw aErr;if(!pub)return null;
  const attrRows=attrs||[],orderIds=attrRows.map(x=>x.order_id).filter(Boolean),custIds=[...new Set(attrRows.map(x=>x.customer_id).filter(Boolean))];
  const [{data:orders,error:oErr},{data:customers,error:uErr},{data:bookingRows,error:bErr}]=await Promise.all([
    orderIds.length?supabase.from('orders').select('id,total_amount,payment_status,order_status,created_at').in('id',orderIds):Promise.resolve({data:[],error:null}),
    custIds.length?supabase.from('customers').select('id,phone,full_name').in('id',custIds):Promise.resolve({data:[],error:null}),
    orderIds.length?supabase.from('bookings').select('id,order_id').in('order_id',orderIds):Promise.resolve({data:[],error:null})
  ]);if(oErr)throw oErr;if(uErr)throw uErr;if(bErr)throw bErr;
  const om=new Map((orders||[]).map(x=>[String(x.id),x])),cm=new Map((customers||[]).map(x=>[String(x.id),x])),bookingCounts=new Map();for(const b of (bookingRows||[])){const k=String(b.order_id||'');bookingCounts.set(k,(bookingCounts.get(k)||0)+1)};
  const latestEvent=new Map();for(const e of (events||[])){const k=String(e.customer_id||e.visitor_id||'');if(k&&!latestEvent.has(k))latestEvent.set(k,e)}
  const stageRank={LANDING:1,BOOKING_OPEN:2,CUSTOMER_INFO:3,ORDER_CREATED:4,PAYMENT_QR:5,PAID:6};
  const customersRows=attrRows.map(a=>{const o=om.get(String(a.order_id))||{},c=cm.get(String(a.customer_id))||{},sessionCount=bookingCounts.get(String(a.order_id))||0;let stage=o.payment_status==='PAID'?'PAID':'ORDER_CREATED';const ev=latestEvent.get(String(a.customer_id));if(ev&&stageRank[ev.event_type]>stageRank[stage])stage=ev.event_type;const amount=Number(o.total_amount||0),commission=o.payment_status==='PAID'?commissionForSessions(pub.commission_scheme,sessionCount,amount,pub.commission_rate):0;return {customer_id:a.customer_id,full_name:c.full_name||'',phone:c.phone||'',order_id:a.order_id,stage,payment_status:o.payment_status||'',order_status:o.order_status||'',amount,session_count:sessionCount,commission,attributed_at:a.attributed_at}}).sort((a,b)=>new Date(b.attributed_at)-new Date(a.attributed_at));
  const paid=customersRows.filter(x=>x.payment_status==='PAID'),revenue=paid.reduce((s,x)=>s+x.amount,0),commission=paid.reduce((s,x)=>s+Number(x.commission||0),0),uniqueVisitors=new Set((clicks||[]).map(x=>x.visitor_id)).size;
  const funnel={landing:0,booking_open:0,customer_info:0,order_created:0,payment_qr:0,paid:0};
  const sets={LANDING:new Set(),BOOKING_OPEN:new Set(),CUSTOMER_INFO:new Set(),ORDER_CREATED:new Set(),PAYMENT_QR:new Set(),PAID:new Set()};
  for(const e of (events||[])){const k=String(e.customer_id||e.visitor_id||'');if(k&&sets[e.event_type])sets[e.event_type].add(k)}
  funnel.landing=sets.LANDING.size;funnel.booking_open=sets.BOOKING_OPEN.size;funnel.customer_info=sets.CUSTOMER_INFO.size;funnel.order_created=sets.ORDER_CREATED.size;funnel.payment_qr=sets.PAYMENT_QR.size;funnel.paid=Math.max(sets.PAID.size,paid.length);
  const daily_clicks=await dailyClicksPromise;
  return {publisher:{...pub,login_code:pub.slug},period:bounds||null,summary:{clicks:(clicks||[]).length,unique_visitors:uniqueVisitors,orders:customersRows.length,paid_orders:paid.length,revenue,commission,conversion_rate:uniqueVisitors?paid.length*100/uniqueVisitors:0,funnel},customers:customersRows.slice(0,1000),daily_clicks};
}
async function handlePublisherPortal(request){
  const auth=publisherFromRequest(request);if(!auth)return Response.json({error:'UNAUTHORIZED'},{status:401});
  const url=new URL(request.url),month=url.searchParams.get('month')||'',from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'';const report=await publisherReportRows(auth.publisher_id,month,from,to);if(!report)return Response.json({error:'PUBLISHER_NOT_FOUND'},{status:404});return Response.json(report);
}
async function handlePublisherTrack(request){
  if(request.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});const b=await request.json().catch(()=>({}));
  const visitorId=String(b.visitor_id||'').trim().slice(0,120),slug=String(b.slug||'').trim().toLowerCase(),eventType=String(b.event_type||'LANDING').trim().toUpperCase();if(!visitorId)return Response.json({error:'VISITOR_ID_REQUIRED'},{status:400});
  let pub=null;
  if(slug){const {data,error}=await supabase.from('publishers').select('id,slug').eq('slug',slug).eq('status','ACTIVE').maybeSingle();if(error)throw error;pub=data;if(pub&&eventType==='LANDING'){const {error:ce}=await supabase.from('publisher_clicks').insert({publisher_id:pub.id,visitor_id:visitorId,landing_path:String(b.landing_path||'/').slice(0,300),user_agent:String(request.headers.get('user-agent')||'').slice(0,500)});if(ce)throw ce;}}
  if(!pub){const {data,error}=await supabase.from('publisher_clicks').select('publisher_id').eq('visitor_id',visitorId).order('clicked_at',{ascending:false}).limit(1).maybeSingle();if(error)throw error;if(data)pub={id:data.publisher_id};}
  if(!pub)return Response.json({ok:true,attributed:false});
  const allowed=new Set(['LANDING','BOOKING_OPEN','CUSTOMER_INFO','ORDER_CREATED','PAYMENT_QR','PAID']);const type=allowed.has(eventType)?eventType:'LANDING';
  const {error:ee}=await supabase.from('publisher_events').insert({publisher_id:pub.id,visitor_id:visitorId,customer_id:b.customer_id||null,order_id:b.order_id||null,event_type:type,metadata:b.metadata||{}});if(ee)throw ee;
  return Response.json({ok:true,attributed:true,publisher_id:pub.id});
}
async function handlePublisherAdmin(request){
  if(request.method==='POST'){
    const b=await request.json().catch(()=>({})),name=String(b.name||'').trim(),phone=String(b.phone||'').replace(/[\s.-]/g,''),password=String(b.password||''),scheme=normalizeCommissionScheme(b.commission_scheme||[]);if(!name||password.length<6)return Response.json({error:'NAME_AND_PASSWORD_REQUIRED'},{status:400});
    if(phone){const {data:existing,error:pe}=await supabase.from('publishers').select('id').eq('phone',phone).maybeSingle();if(pe)throw pe;if(existing)return Response.json({error:'PHONE_ALREADY_REGISTERED'},{status:409})}
    let slug='';
    for(let i=0;i<50;i++){
      const candidate=randomPublisherSlug();
      const {data:exists,error:checkErr}=await supabase.from('publishers').select('id').eq('slug',candidate).maybeSingle();
      if(checkErr)throw checkErr;
      if(!exists){slug=candidate;break}
    }
    if(!slug)return Response.json({error:'PUBLISHER_SLUG_POOL_BUSY'},{status:503});
    const loginCode=slug;const {data,error}=await supabase.from('publishers').insert({name,phone:phone||null,slug,login_code:loginCode,password_hash:publisherPasswordHash(password),commission_rate:0,commission_scheme:scheme,status:'ACTIVE'}).select('id,name,phone,slug,login_code,status,commission_rate,commission_scheme,created_at').single();if(error)throw error;return Response.json({publisher:data,link:`https://speakhub.vn/${slug}`},{status:201});
  }
  if(request.method==='PUT'){
    const b=await request.json().catch(()=>({})),publisherId=String(b.publisher_id||'').trim();if(!publisherId)return Response.json({error:'PUBLISHER_ID_REQUIRED'},{status:400});
    const updates={updated_at:new Date().toISOString()};
    if(Object.prototype.hasOwnProperty.call(b,'commission_scheme'))updates.commission_scheme=normalizeCommissionScheme(b.commission_scheme||[]);
    if(Object.prototype.hasOwnProperty.call(b,'name')){const name=String(b.name||'').trim();if(!name)return Response.json({error:'NAME_REQUIRED'},{status:400});updates.name=name}
    if(Object.prototype.hasOwnProperty.call(b,'phone')){const phone=String(b.phone||'').replace(/[\s.-]/g,'');if(phone){const {data:dupe,error:de}=await supabase.from('publishers').select('id').eq('phone',phone).neq('id',publisherId).maybeSingle();if(de)throw de;if(dupe)return Response.json({error:'PHONE_ALREADY_REGISTERED'},{status:409})}updates.phone=phone||null}
    if(String(b.password||'')){const pw=String(b.password);if(pw.length<6)return Response.json({error:'PASSWORD_MIN_6'},{status:400});updates.password_hash=publisherPasswordHash(pw)}
    const {data,error}=await supabase.from('publishers').update(updates).eq('id',publisherId).select('id,name,phone,slug,status,commission_rate,commission_scheme,created_at').single();if(error)throw error;return Response.json({ok:true,publisher:data});
  }
  const url=new URL(request.url),month=url.searchParams.get('month')||'',from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'';
  const {data,error}=await supabase.from('publishers').select('id,name,phone,slug,login_code,status,commission_rate,commission_scheme,created_at').order('created_at',{ascending:false});if(error)throw error;
  const reports=(await Promise.all((data||[]).map(pub=>publisherReportRows(pub.id,month,from,to)))).filter(Boolean);
  return Response.json({month,from,to,publishers:reports});
}
async function resolveAdminScope(scope='overall'){
  scope=String(scope||'overall').toLowerCase();
  if(scope==='overall') return {scope:'overall',location_id:null,room_ids:null};
  const {data:locs,error:lErr}=await supabase.from('locations').select('id,name,district');
  if(lErr) throw lErr;
  let loc=null;
  if(scope==='district-2') loc=(locs||[]).find(x=>/district\s*2|quận\s*2|quan\s*2|thu duc|thủ đức/i.test(`${x.name||''} ${x.district||''}`));
  if(scope==='go-vap') loc=(locs||[]).find(x=>/go\s*vap|gò\s*vấp|khoi\s*coffee|khói\s*coffee/i.test(`${x.name||''} ${x.district||''}`));
  if(!loc) return {scope,location_id:null,room_ids:[]};
  const {data:rooms,error:rErr}=await supabase.from('rooms').select('id').eq('location_id',loc.id);
  if(rErr) throw rErr;
  return {scope,location_id:loc.id,room_ids:(rooms||[]).map(x=>x.id)};
}
function scopeQuery(q,scopeInfo,column='room_id'){
  if(scopeInfo?.room_ids===null) return q;
  return scopeInfo?.room_ids?.length?q.in(column,scopeInfo.room_ids):q.eq('id','00000000-0000-0000-0000-000000000000');
}


async function handleSupporterRegistrationSessions(request){
  const today=vnTodayBounds().day;
  const u=new URL(request.url),scopeInfo=await resolveAdminScope(u.searchParams.get('scope')||'overall');
  let sessionsQ=supabase.from('class_sessions')
    .select('id,room_id,session_date,starts_at,ends_at,capacity,status,programs(name),rooms(name)')
    .gte('session_date',today).eq('status','OPEN')
    .order('session_date',{ascending:true}).order('starts_at',{ascending:true}).limit(500);
  sessionsQ=scopeQuery(sessionsQ,scopeInfo,'room_id');
  const {data,error}=await sessionsQ;
  if(error)throw error;
  const nowTime=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
  const rows=(data||[]).filter(x=>String(x.session_date)>today||(String(x.session_date)===today&&String(x.ends_at||'23:59').slice(0,5)>nowTime));
  const ids=rows.map(x=>x.id),counts={};
  if(ids.length){const {data:bs,error:bErr}=await supabase.from('bookings').select('session_id').in('session_id',ids).in('status',['CONFIRMED','ATTENDED','NO_SHOW']);if(bErr)throw bErr;for(const b of (bs||[]))counts[b.session_id]=(counts[b.session_id]||0)+1;}
  return Response.json({sessions:rows.map(x=>({id:x.id,session_date:x.session_date,starts_at:x.starts_at,ends_at:x.ends_at,capacity:Number(x.capacity||0),booked_count:Number(counts[x.id]||0),program_name:x.programs?.name||'',room_name:x.rooms?.name||''})).filter(x=>x.capacity>0)});
}

async function handleSupporterSessions(request){
  const today=vnTodayBounds().day;
  const u=new URL(request.url),scopeInfo=await resolveAdminScope(u.searchParams.get('scope')||'overall');
  let q=supabase.from('class_sessions').select('id,room_id,session_date,starts_at,ends_at,capacity,status,topic_title,topic_storage_path,programs(name),rooms(name),teachers(full_name)')
    .gte('session_date',today).neq('status','CANCELLED').not('topic_storage_path','is',null)
    .order('session_date',{ascending:true}).order('starts_at',{ascending:true}).limit(300);
  q=scopeQuery(q,scopeInfo,'room_id');
  const {data,error}=await q;if(error)throw error;
  const rows=(data||[]).filter(x=>String(x.topic_storage_path||'').trim());
  const ids=rows.map(x=>x.id),counts={};
  if(ids.length){const {data:bs,error:bErr}=await supabase.from('bookings').select('session_id').in('session_id',ids).in('status',['CONFIRMED','ATTENDED','NO_SHOW']);if(bErr)throw bErr;for(const b of (bs||[]))counts[b.session_id]=(counts[b.session_id]||0)+1;}
  const eligible=rows.filter(x=>Number(x.capacity||0)<=0||Number(counts[x.id]||0)<Number(x.capacity||0));
  const sessions=await Promise.all(eligible.map(async x=>{
    const {data:signed,error:sErr}=await supabase.storage.from('topics').createSignedUrl(String(x.topic_storage_path),1800);
    if(sErr){console.error('supporter topic signed url failed',sErr);return null}
    return {id:x.id,session_date:x.session_date,starts_at:x.starts_at,ends_at:x.ends_at,program_name:x.programs?.name||'',room_name:x.rooms?.name||'',teacher_name:x.teachers?.full_name||'',topic_title:x.topic_title||'Tài liệu buổi học',download_url:signed?.signedUrl||''};
  }));
  return Response.json({sessions:sessions.filter(x=>x&&x.download_url)});
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

async function getRenewalInsights(scope='overall'){
  const nowMs=Date.now();
  const scopeInfo=await resolveAdminScope(scope);

  const {data,error}=await supabase
    .from('orders')
    .select(`
      id,user_id,created_at,payment_status,order_status,
      customers:user_id(full_name,phone,status),
      bookings(
        id,status,
        class_sessions(room_id,session_date,starts_at,ends_at,programs(name))
      )
    `)
    .eq('payment_status','PAID')
    .order('created_at',{ascending:true})
    .limit(5000);

  if(error) throw error;

  const byCustomer=new Map();

  for(const order of (data||[])){
    if(!order.user_id) continue;
    const customer=order.customers||{};
    if(String(customer.status||'ACTIVE')!=='ACTIVE') continue;

    const lessons=(order.bookings||[])
      .filter(b=>['CONFIRMED','ATTENDED','NO_SHOW'].includes(String(b.status||'')))
      .filter(b=>scopeInfo.room_ids===null || (scopeInfo.room_ids||[]).includes(b.class_sessions?.room_id))
      .map(b=>{
        const s=b.class_sessions||{};
        const date=String(s.session_date||'');
        const start=String(s.starts_at||'').slice(0,8);
        const end=String(s.ends_at||'').slice(0,8);
        const whenStart=date&&start?new Date(`${date}T${start}+07:00`).getTime():0;
        const whenEnd=date&&(end||start)?new Date(`${date}T${end||start}+07:00`).getTime():0;
        return {
          session_date:date,
          starts_at:s.starts_at||'',
          ends_at:s.ends_at||'',
          program_name:s.programs?.name||'',
          when_start:whenStart,
          when_end:whenEnd
        };
      })
      .filter(x=>x.when_start>0)
      .sort((a,b)=>a.when_start-b.when_start);

    if(!lessons.length) continue;

    const item={
      order_id:order.id,
      created_at:order.created_at,
      user_id:order.user_id,
      full_name:customer.full_name||'',
      phone:customer.phone||'',
      lessons,
      first_lesson:lessons[0],
      last_lesson:lessons[lessons.length-1]
    };

    if(!byCustomer.has(order.user_id)) byCustomer.set(order.user_id,[]);
    byCustomer.get(order.user_id).push(item);
  }

  let eligibleCustomers=0;
  let renewedCustomers=0;
  const reminders=[];

  for(const [userId,orders] of byCustomer){
    orders.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));

    const endedOrders=orders.filter(o=>o.last_lesson.when_end<=nowMs);
    if(endedOrders.length){
      eligibleCustomers++;
      if(orders.length>=2) renewedCustomers++;
    }

    // Remind = no future paid lesson and the latest paid lesson has already ended.
    const allLessons=orders.flatMap(o=>o.lessons).sort((a,b)=>a.when_start-b.when_start);
    const futureLessons=allLessons.filter(x=>x.when_start>nowMs);
    const pastLessons=allLessons.filter(x=>x.when_end<=nowMs);

    if(!futureLessons.length && pastLessons.length){
      const last=pastLessons[pastLessons.length-1];
      const latestOrder=orders[orders.length-1];
      reminders.push({
        customer_id:userId,
        full_name:latestOrder.full_name,
        phone:latestOrder.phone,
        last_session_date:last.session_date,
        last_starts_at:last.starts_at,
        last_ends_at:last.ends_at,
        last_program_name:last.program_name,
        last_lesson_at:last.when_start
      });
    }
  }

  reminders.sort((a,b)=>b.last_lesson_at-a.last_lesson_at);

  return {
    eligible_customers:eligibleCustomers,
    renewed_customers:renewedCustomers,
    renewal_rate:eligibleCustomers
      ? Math.round((renewedCustomers/eligibleCustomers)*1000)/10
      : 0,
    reminders
  };
}

async function handleReminders(request){
  const u=request?new URL(request.url):null;
  const insights=await getRenewalInsights(u?.searchParams.get('scope')||'overall');
  return Response.json({
    reminders:insights.reminders,
    renewal_rate:insights.renewal_rate,
    renewed_customers:insights.renewed_customers,
    eligible_customers:insights.eligible_customers
  });
}

async function handleOverview(request){
  const url=new URL(request.url), scope=String(url.searchParams.get('scope')||'overall');
  const w=currentWeekBounds(), month=monthBounds(), weekEndExclusive=addDaysISO(w.current_to,1);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh'}).format(new Date());
  const scopeInfo=await resolveAdminScope(scope);
  const scopedRoomIds=scopeInfo.room_ids;
  const sessionQ=(q)=>scopedRoomIds===null?q:(scopedRoomIds.length?q.in('room_id',scopedRoomIds):q.eq('id','00000000-0000-0000-0000-000000000000'));
  const results=await Promise.all([
    supabase.from('customers').select('*',{count:'exact',head:true}),
    supabase.from('orders').select('*',{count:'exact',head:true}).eq('payment_status','PAID'),
    supabase.from('bookings').select('*',{count:'exact',head:true}).eq('status','CONFIRMED'),
    sessionQ(supabase.from('class_sessions').select('*',{count:'exact',head:true}).eq('status','OPEN')),
    sessionQ(supabase.from('class_sessions').select('id,capacity,topic_storage_path').gte('session_date',w.current_from).lte('session_date',w.current_to).neq('status','CANCELLED')),
    sessionQ(supabase.from('class_sessions').select('id,capacity').gte('session_date',w.prev_from).lte('session_date',w.prev_to).neq('status','CANCELLED')),
    sessionQ(supabase.from('class_sessions').select('id,capacity').gte('session_date',w.next_from).lte('session_date',w.next_to).neq('status','CANCELLED')),
    supabase.from('placement_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('progress_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('placement_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED'),
    supabase.from('progress_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED'),
    supabase.from('pronunciation_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('pronunciation_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED'),
    supabase.from('comprehension_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('comprehension_tests').select('*',{count:'exact',head:true}).eq('status','COMPLETED'),
    supabase.from('orders').select('total_amount').eq('payment_status','PAID').gte('created_at',`${w.current_from}T00:00:00+07:00`).lt('created_at',`${weekEndExclusive}T00:00:00+07:00`),
    supabase.from('orders').select('total_amount').eq('payment_status','PAID').gte('created_at',`${month.first}T00:00:00+07:00`).lt('created_at',`${month.next}T00:00:00+07:00`),
    sessionQ(supabase.from('class_sessions').select('id').gte('session_date',today).neq('status','CANCELLED'))
  ]);
  const err=results.find(x=>x.error)?.error;if(err) throw err;
  const [c,o,b,s,week,prev,next,pw,gw,pa,ga,prw,pra,cow,coa,mw,mm,future]=results;
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
  // Visitor rows can easily exceed Supabase's default 1,000-row response cap.
  // Always page through the daily table so recent dates never disappear from the chart.
  async function visitorIdsByVisitedOn(fromDate,toDate){
    const out=[];const pageSize=1000;
    for(let from=0;;from+=pageSize){
      const {data,error}=await supabase.from('website_visit_daily').select('visitor_id,visited_on,last_seen_at').gte('visited_on',fromDate).lte('visited_on',toDate).order('visited_on',{ascending:true}).range(from,from+pageSize-1);
      if(error)throw error;out.push(...(data||[]));if(!data||data.length<pageSize)break;
    }
    return out;
  }
  async function uniqueVisitorsByDate(fromDate,toDate){
    const rows=await visitorIdsByVisitedOn(fromDate,toDate);
    return new Set(rows.map(x=>String(x.visitor_id||'')).filter(Boolean)).size;
  }
  const chartFrom=addDaysISO(today,-29);
  const fillFrom=addDaysISO(today,-23),fillTo=addDaysISO(today,6); // 23 previous days + today + 6 upcoming days = 30
  const onlineSince=new Date(Date.now()-75*1000).toISOString();
  const [visRows30,visDay,visWeek,visMonth,onlineRes,latestVisitRes,fillSessionsRes,paid30Res]=await Promise.all([
    visitorIdsByVisitedOn(chartFrom,today),
    uniqueVisitorsByDate(today,today),
    uniqueVisitorsByDate(w.current_from,w.current_to),
    uniqueVisitorsByDate(month.first,addDaysISO(month.next,-1)),
    supabase.from('website_visit_daily').select('visitor_id').gte('last_seen_at',onlineSince).limit(5000),
    supabase.from('website_visit_daily').select('last_seen_at,visited_on').order('last_seen_at',{ascending:false}).limit(1),
    sessionQ(supabase.from('class_sessions').select('id,session_date,capacity').gte('session_date',fillFrom).lte('session_date',fillTo).neq('status','CANCELLED')),
    supabase.from('orders').select('id,total_amount,paid_at').eq('payment_status','PAID').gte('paid_at',`${chartFrom}T00:00:00+07:00`).lt('paid_at',`${addDaysISO(today,1)}T00:00:00+07:00`).order('paid_at',{ascending:true}).limit(5000)
  ]);
  if(onlineRes.error)throw onlineRes.error;if(latestVisitRes.error)throw latestVisitRes.error;if(fillSessionsRes.error)throw fillSessionsRes.error;if(paid30Res.error)throw paid30Res.error;
  const onlineVisitors=new Set((onlineRes.data||[]).map(x=>String(x.visitor_id||'')).filter(Boolean)).size;
  const dailyMap={};
  for(let i=0;i<30;i++)dailyMap[addDaysISO(chartFrom,i)]=new Set();
  for(const x of visRows30){if(dailyMap[x.visited_on]&&x.visitor_id)dailyMap[x.visited_on].add(String(x.visitor_id));}
  const visits30=Object.entries(dailyMap).map(([date,set])=>({date,visitors:set.size}));

  const fillRows=fillSessionsRes.data||[];
  const fillIds=fillRows.map(x=>x.id);
  const fillCounts={};
  if(fillIds.length){
    const {data:fb,error:fbErr}=await supabase.from('bookings').select('session_id').in('session_id',fillIds).in('status',['CONFIRMED','ATTENDED','NO_SHOW']);
    if(fbErr)throw fbErr;
    for(const x of (fb||[]))fillCounts[x.session_id]=(fillCounts[x.session_id]||0)+1;
  }
  const fillDaily={};
  for(let i=0;i<30;i++)fillDaily[addDaysISO(fillFrom,i)]={capacity:0,booked:0};
  for(const x of fillRows){
    if(!fillDaily[x.session_date])continue;
    fillDaily[x.session_date].capacity+=Number(x.capacity||0);
    fillDaily[x.session_date].booked+=Number(fillCounts[x.id]||0);
  }
  // No-session days are null, not 0%. The frontend uses null to break the line.
  const fill30=Object.entries(fillDaily).map(([date,v])=>({date,rate:v.capacity?Math.round((v.booked/v.capacity)*1000)/10:null,booked:v.booked,capacity:v.capacity,is_today:date===today}));

  // Paid revenue by actual paid_at date (not order creation date).
  // For branch views, keep only orders that contain at least one booking in that branch.
  let paidRows30=paid30Res.data||[];
  if(Array.isArray(scopedRoomIds)){
    if(!scopedRoomIds.length)paidRows30=[];
    else if(paidRows30.length){
      const paidIds=paidRows30.map(x=>x.id);
      const {data:scopeSessions,error:scopeSessionsErr}=await supabase.from('class_sessions').select('id').in('room_id',scopedRoomIds).limit(10000);if(scopeSessionsErr)throw scopeSessionsErr;
      const sid=(scopeSessions||[]).map(x=>x.id);let allowed=new Set();
      if(sid.length){
        const {data:scopeBookings,error:scopeBookingsErr}=await supabase.from('bookings').select('order_id').in('session_id',sid).in('order_id',paidIds).limit(10000);if(scopeBookingsErr)throw scopeBookingsErr;
        allowed=new Set((scopeBookings||[]).map(x=>x.order_id).filter(Boolean));
      }
      paidRows30=paidRows30.filter(x=>allowed.has(x.id));
    }
  }
  const paidDaily={};for(let i=0;i<30;i++)paidDaily[addDaysISO(chartFrom,i)]=0;
  for(const x of paidRows30){const d=String(x.paid_at||'').slice(0,10);if(Object.prototype.hasOwnProperty.call(paidDaily,d))paidDaily[d]+=Number(x.total_amount||0);}
  const paid30=Object.entries(paidDaily).map(([date,amount])=>({date,amount,is_today:date===today}));
  let scopedCounts=null,scopedPaidWeek=null,scopedPaidMonth=null;
  if(Array.isArray(scopedRoomIds)){
    if(!scopedRoomIds.length){scopedCounts={customers:0,paid_orders:0,confirmed_bookings:0,open_sessions:s.count||0};scopedPaidWeek=0;scopedPaidMonth=0;}
    else{
      const {data:ss,error:ssErr}=await supabase.from('class_sessions').select('id').in('room_id',scopedRoomIds);if(ssErr)throw ssErr;
      const sids=(ss||[]).map(x=>x.id);
      if(!sids.length){scopedCounts={customers:0,paid_orders:0,confirmed_bookings:0,open_sessions:s.count||0};scopedPaidWeek=0;scopedPaidMonth=0;}
      else{
        const {data:sbs,error:sbErr}=await supabase.from('bookings').select('user_id,order_id,status,orders!inner(total_amount,payment_status,created_at)').in('session_id',sids).neq('status','CANCELLED').eq('orders.payment_status','PAID');if(sbErr)throw sbErr;
        const users=new Set(),ordersMap=new Map();let confirmed=0;
        for(const x of (sbs||[])){if(x.user_id)users.add(x.user_id);if(x.order_id&&!ordersMap.has(x.order_id))ordersMap.set(x.order_id,x.orders);if(['CONFIRMED','ATTENDED','NO_SHOW'].includes(String(x.status||'')))confirmed++;}
        const orderVals=[...ordersMap.values()];
        scopedPaidWeek=orderVals.filter(x=>String(x.created_at||'')>=`${w.current_from}T00:00:00`&&String(x.created_at||'')<`${weekEndExclusive}T00:00:00`).reduce((n,x)=>n+Number(x.total_amount||0),0);
        scopedPaidMonth=orderVals.filter(x=>String(x.created_at||'')>=`${month.first}T00:00:00`&&String(x.created_at||'')<`${month.next}T00:00:00`).reduce((n,x)=>n+Number(x.total_amount||0),0);
        scopedCounts={customers:users.size,paid_orders:ordersMap.size,confirmed_bookings:confirmed,open_sessions:s.count||0};
      }
    }
  }
  const renewal=await getRenewalInsights();
  return Response.json({
    counts:scopedCounts||{customers:c.count||0,paid_orders:o.count||0,confirmed_bookings:b.count||0,open_sessions:s.count||0},
    analytics:{
      sessions_this_week:(week.data||[]).length,
      topics_this_week:(week.data||[]).filter(x=>String(x.topic_storage_path||'').trim()).length,
      active_students:activeStudents,
      tests_this_week:{placement:pw.count||0,progress:gw.count||0},
      tests_all:{placement:pa.count||0,progress:ga.count||0},
      pronunciation_tests:{week:prw.count||0,all:pra.count||0},
      comprehension_tests:{week:cow.count||0,all:coa.count||0},
      paid_amount:{week:scopedPaidWeek===null?sum(mw.data):scopedPaidWeek,month:scopedPaidMonth===null?sum(mm.data):scopedPaidMonth},
      fill_rate:{previous_week:fill(prev.data),current_week:fill(week.data),next_week:fill(next.data)},
      renewal_rate:{
        rate:renewal.renewal_rate,
        renewed_customers:renewal.renewed_customers,
        eligible_customers:renewal.eligible_customers
      },
      ranges:w,
      website_visits:{day:visDay,week:visWeek,month:visMonth,online:onlineVisitors,daily_30:visits30,latest_seen_at:latestVisitRes.data?.[0]?.last_seen_at||null,latest_visited_on:latestVisitRes.data?.[0]?.visited_on||null},
      fill_rate_daily_30:fill30,
      paid_daily_30:paid30
    }
  });
}


async function handleDateDiscounts(request){
  if(request.method==='GET'){
    const {data,error}=await supabase
      .from('class_date_discounts')
      .select('discount_date,program_name,discount_percent,created_at')
      .order('discount_date',{ascending:true})
      .order('program_name',{ascending:true});
    if(error) throw error;
    return Response.json({discounts:data||[]});
  }

  if(request.method==='POST'){
    const body=await request.json().catch(()=>({}));
    const discountDate=String(body.discount_date||'').trim();
    const programName=String(body.program_name||'').trim();
    const discountPercent=Number(body.discount_percent);

    if(!/^\d{4}-\d{2}-\d{2}$/.test(discountDate)){
      return Response.json({error:'INVALID_DISCOUNT_DATE',details:'Please choose a valid discount date.'},{status:400});
    }
    if(!programName){
      return Response.json({error:'PROGRAM_REQUIRED',details:'Please choose a class.'},{status:400});
    }
    if(!Number.isFinite(discountPercent) || discountPercent<=0 || discountPercent>=100){
      return Response.json({error:'INVALID_DISCOUNT_PERCENT',details:'Discount must be greater than 0% and less than 100%.'},{status:400});
    }

    const cleanPercent=Math.round(discountPercent*100)/100;
    const {data,error}=await supabase
      .from('class_date_discounts')
      .upsert({
        discount_date:discountDate,
        program_name:programName,
        discount_percent:cleanPercent
      },{onConflict:'discount_date,program_name'})
      .select('discount_date,program_name,discount_percent,created_at')
      .single();

    if(error) throw error;
    return Response.json({success:true,discount:data});
  }

  if(request.method==='DELETE'){
    const body=await request.json().catch(()=>({}));
    const discountDate=String(body.discount_date||'').trim();
    const programName=String(body.program_name||'').trim();

    if(!discountDate || !programName){
      return Response.json({error:'DISCOUNT_KEY_REQUIRED',details:'Date and class are required.'},{status:400});
    }

    const {error}=await supabase
      .from('class_date_discounts')
      .delete()
      .eq('discount_date',discountDate)
      .eq('program_name',programName);

    if(error) throw error;
    return Response.json({success:true});
  }

  return Response.json({error:'Method not allowed'},{status:405});
}

async function handlePublicDateDiscounts(){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh'}).format(new Date());
  const {data,error}=await supabase
    .from('class_date_discounts')
    .select('discount_date,program_name,discount_percent')
    .gte('discount_date',today)
    .order('discount_date',{ascending:true});

  if(error) throw error;

  return Response.json(
    {discounts:data||[]},
    {headers:{
      'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0',
      'CDN-Cache-Control':'no-store',
      'Vercel-CDN-Cache-Control':'no-store'
    }}
  );
}

async function handleSessions(request){
  if(request.method==='GET'){
    const url=new URL(request.url), scopeInfo=await resolveAdminScope(url.searchParams.get('scope')||'overall');
    let roomQ=supabase.from('rooms').select('id,name,location_id').order('name');
    if(scopeInfo.location_id) roomQ=roomQ.eq('location_id',scopeInfo.location_id);
    else if(Array.isArray(scopeInfo.room_ids)&&!scopeInfo.room_ids.length) roomQ=roomQ.eq('id','00000000-0000-0000-0000-000000000000');
    let sessionsQ=supabase.from('class_sessions').select(`
        id,session_date,session_period,starts_at,ends_at,capacity,status,is_recurring,recurrence_source_id,
        room_id,location_id,teacher_id,topic_title,topic_storage_path,topic_vocabulary,
        programs(name),rooms(name),teachers(full_name,country)
      `).order('session_date',{ascending:false}).limit(200);
    sessionsQ=scopeQuery(sessionsQ,scopeInfo,'room_id');
    const [
      {data:programs,error:pErr},
      {data:rooms,error:rErr},
      {data:teachers,error:tErr},
      {data:sessions,error:sErr}
    ]=await Promise.all([
      supabase.from('programs').select('id,code,name').order('name'),
      roomQ,
      supabase.from('teachers').select('id,full_name,country,is_active').eq('is_active',true).order('full_name'),
      sessionsQ
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
    const url=new URL(request.url), scopeInfo=await resolveAdminScope(url.searchParams.get('scope')||'overall');

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
      let firstRoomQ=supabase.from('rooms').select('id,location_id').order('id').limit(1);
      if(scopeInfo.location_id) firstRoomQ=firstRoomQ.eq('location_id',scopeInfo.location_id);
      const {data:firstRoom,error:roomErr}=await firstRoomQ.maybeSingle();

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


  if(request.method==='PATCH'){
    const b=await request.json().catch(()=>({}));
    const sessionId=String(b.session_id||'').trim();
    const operation=String(b.operation||'').toUpperCase();

    if(!sessionId){
      return Response.json({error:'SESSION_ID_REQUIRED'},{status:400});
    }

    if(operation!=='CHANGE_TEACHER'){
      return Response.json({error:'INVALID_SESSION_OPERATION'},{status:400});
    }

    const teacherId=b.teacher_id?String(b.teacher_id):null;

    // Validate teacher before changing the session.
    if(teacherId){
      const {data:teacher,error:tErr}=await supabase
        .from('teachers')
        .select('id,is_active')
        .eq('id',teacherId)
        .maybeSingle();

      if(tErr) throw tErr;
      if(!teacher || teacher.is_active===false){
        return Response.json({error:'TEACHER_NOT_AVAILABLE'},{status:400});
      }
    }

    const {data:updated,error}=await supabase
      .from('class_sessions')
      .update({teacher_id:teacherId})
      .eq('id',sessionId)
      .select(`
        id,session_date,starts_at,ends_at,teacher_id,
        teachers(full_name,country)
      `)
      .maybeSingle();

    if(error) throw error;
    if(!updated){
      return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
    }

    // Teacher portal reads class_sessions.teacher_id directly,
    // so no duplicate/sync table write is needed.
    return Response.json({
      success:true,
      session:{
        ...updated,
        teacher_name:updated.teachers?.full_name||'',
        teacher_country:updated.teachers?.country||''
      }
    });
  }

  if(request.method==='DELETE'){
    const b=await request.json().catch(()=>({}));
    const sessionId=String(b.session_id||'').trim();

    if(!sessionId){
      return Response.json({error:'SESSION_ID_REQUIRED'},{status:400});
    }

    const {data:session,error:sErr}=await supabase
      .from('class_sessions')
      .select('id')
      .eq('id',sessionId)
      .maybeSingle();

    if(sErr) throw sErr;
    if(!session){
      return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
    }

    // Stronger than the UI check: reject if ANY non-cancelled booking exists.
    // This protects against stale admin screens and concurrent bookings.
    const {count:bookingCount,error:bErr}=await supabase
      .from('bookings')
      .select('*',{count:'exact',head:true})
      .eq('session_id',sessionId)
      .neq('status','CANCELLED');

    if(bErr) throw bErr;

    if(Number(bookingCount||0)>0){
      return Response.json({
        error:'SESSION_HAS_BOOKINGS',
        booking_count:Number(bookingCount||0)
      },{status:409});
    }

    const {error:deleteErr}=await supabase
      .from('class_sessions')
      .delete()
      .eq('id',sessionId);

    if(deleteErr){
      // Foreign-key or other linked-data protection: do not force/cascade it here.
      if(String(deleteErr.code||'')==='23503'){
        return Response.json({
          error:'SESSION_DELETE_BLOCKED',
          details:String(deleteErr.message||'')
        },{status:409});
      }
      throw deleteErr;
    }

    return Response.json({success:true,deleted_session_id:sessionId});
  }

  return Response.json({error:'Method not allowed'},{status:405});
}


async function handleCustomerSearch(request){
  const url=new URL(request.url);
  const q=String(url.searchParams.get('q')||'').trim();

  if(!q){
    return Response.json({customers:[]});
  }

  const digits=q.replace(/\D/g,'');
  const safeText=q.replace(/[%_]/g,'').trim();

  let builder=supabase
    .from('customers')
    .select('id,full_name,phone,status,created_at')
    .order('created_at',{ascending:false})
    .limit(8);

  // Phone-like input -> search phone only.
  // Name-like input -> search full_name only.
  // This avoids fragile PostgREST OR filter parsing.
  if(digits.length>=3 && digits.length>=safeText.replace(/\s/g,'').length){
    builder=builder.ilike('phone',`%${digits}%`);
  }else{
    builder=builder.ilike('full_name',`%${safeText}%`);
  }

  const {data,error}=await builder;
  if(error) throw error;

  return Response.json({customers:data||[]});
}

async function handleCustomers(request){
  const url=new URL(request.url), scopeInfo=await resolveAdminScope(url.searchParams.get('scope')||'overall');
  let customerIds=null;
  if(Array.isArray(scopeInfo.room_ids)){
    if(!scopeInfo.room_ids.length) customerIds=[];
    else{
      const {data:ss,error:sErr}=await supabase.from('class_sessions').select('id').in('room_id',scopeInfo.room_ids);if(sErr)throw sErr;
      const ids=(ss||[]).map(x=>x.id);
      if(!ids.length) customerIds=[];
      else{const {data:bs,error:bErr}=await supabase.from('bookings').select('user_id').in('session_id',ids).neq('status','CANCELLED');if(bErr)throw bErr;customerIds=[...new Set((bs||[]).map(x=>x.user_id).filter(Boolean))];}
    }
  }
  let q=supabase.from('customers').select('id,full_name,phone,status,created_at').order('created_at',{ascending:false}).limit(500);
  if(Array.isArray(customerIds)) q=customerIds.length?q.in('id',customerIds):q.eq('id','00000000-0000-0000-0000-000000000000');
  const {data,error}=await q;
  if(error) throw error;
  return Response.json({customers:data||[]});
}


function validManualPhone(phone){
  return /^0\d{9}$/.test(String(phone||'').trim());
}
function validManualName(name){
  return String(name||'').trim().split(/\s+/).filter(Boolean).length>=2;
}

async function getManualSessions(request){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh'}).format(new Date());
  const url=new URL(request.url), scopeInfo=await resolveAdminScope(url.searchParams.get('scope')||'overall');
  let sessionQ=supabase.from('class_sessions')
    .select('id,room_id,session_date,starts_at,ends_at,capacity,status,programs(name)')
    .gte('session_date',today);
  sessionQ=scopeQuery(sessionQ,scopeInfo,'room_id');
  const {data:sessions,error}=await sessionQ
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
    const sessions=await getManualSessions(request);
    const allowedSessionIds=new Set((sessions||[]).map(x=>String(x.id)));

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
        .eq('order_status','CONFIRMED')
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
        source:String(o.order_code||'').startsWith('MANUAL-')?'MANUAL':'ONLINE',
        bookings:(o.bookings||[])
          .filter(b=>['CONFIRMED','ATTENDED','NO_SHOW'].includes(String(b.status||'')))
          .filter(b=>allowedSessionIds.has(String(b.session_id)))
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

async function handleBookings(request){
  const url=new URL(request.url), scopeInfo=await resolveAdminScope(url.searchParams.get('scope')||'overall');
  let q=supabase.from('bookings')
    .select(`
      id,status,created_at,
      customers:user_id(full_name,phone),
      orders!inner(payment_status,order_status),
      class_sessions!inner(room_id,session_date,starts_at,ends_at,programs(name))
    `)
    .eq('status','CONFIRMED');
  if(Array.isArray(scopeInfo.room_ids)) q=scopeInfo.room_ids.length?q.in('class_sessions.room_id',scopeInfo.room_ids):q.eq('class_sessions.room_id','00000000-0000-0000-0000-000000000000');
  const {data,error}=await q
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

function topicImageFolder(pdfPath){return `${String(pdfPath||'').replace(/\.pdf$/i,'')}-pages`}
function topicImageManifestPath(pdfPath){return `${topicImageFolder(pdfPath)}/manifest.json`}
function topicImagePagePath(pdfPath,pageNo){return `${topicImageFolder(pdfPath)}/${String(pageNo).padStart(3,'0')}.jpg`}
async function handleTopicPageUpload(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const fd=await request.formData();const sessionId=String(fd.get('session_id')||'');const pageNo=Number(fd.get('page_no')||0);const pageCount=Number(fd.get('page_count')||0);const image=fd.get('image');
  if(!sessionId||!image||!Number.isInteger(pageNo)||!Number.isInteger(pageCount)||pageNo<1||pageCount<1||pageNo>pageCount||pageCount>30)return Response.json({error:'INVALID_TOPIC_IMAGE_UPLOAD'},{status:400});
  if(image.type&&image.type!=='image/jpeg')return Response.json({error:'TOPIC_IMAGE_JPEG_ONLY'},{status:400});
  if(Number(image.size||0)>3*1024*1024)return Response.json({error:'TOPIC_IMAGE_TOO_LARGE'},{status:413});
  const {data:session,error:sErr}=await supabase.from('class_sessions').select('id,topic_storage_path').eq('id',sessionId).maybeSingle();
  if(sErr)throw sErr;if(!session)return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  const pdfPath=String(session.topic_storage_path||'').trim();if(!pdfPath)return Response.json({error:'TOPIC_NOT_READY'},{status:409});
  const folder=topicImageFolder(pdfPath);
  if(pageNo===1){
    const {data:oldFiles,error:listErr}=await supabase.storage.from('topics').list(folder,{limit:100});
    if(!listErr&&Array.isArray(oldFiles)&&oldFiles.length){const removePaths=oldFiles.map(x=>`${folder}/${x.name}`).filter(Boolean);if(removePaths.length){const {error:rErr}=await supabase.storage.from('topics').remove(removePaths);if(rErr)console.error('old topic image cleanup warning',rErr)}}
  }
  const imagePath=topicImagePagePath(pdfPath,pageNo);const bytes=await image.arrayBuffer();
  const {error:uploadErr}=await supabase.storage.from('topics').upload(imagePath,bytes,{contentType:'image/jpeg',cacheControl:'3600',upsert:true});if(uploadErr)throw uploadErr;
  if(pageNo===pageCount){
    const pages=Array.from({length:pageCount},(_,i)=>topicImagePagePath(pdfPath,i+1));
    const manifestBytes=new TextEncoder().encode(JSON.stringify({version:1,page_count:pageCount,pages,generated_at:new Date().toISOString()}));
    const {error:mErr}=await supabase.storage.from('topics').upload(topicImageManifestPath(pdfPath),manifestBytes,{contentType:'application/json',cacheControl:'3600',upsert:true});if(mErr)throw mErr;
  }
  return Response.json({success:true,page_no:pageNo,page_count:pageCount,image_path:imagePath});
}
async function removeTopicGeneratedImages(pdfPath){
  const path=String(pdfPath||'').trim();if(!path)return;const folder=topicImageFolder(path);
  try{const {data:files,error}=await supabase.storage.from('topics').list(folder,{limit:100});if(error)return;const paths=(files||[]).map(x=>`${folder}/${x.name}`).filter(Boolean);if(paths.length)await supabase.storage.from('topics').remove(paths)}catch(err){console.error('topic generated image cleanup warning',err)}
}
async function topicUploadSession(sessionId){
  const {data:session,error:sErr}=await supabase
    .from('class_sessions')
    .select(`
      id,program_id,teacher_id,session_date,starts_at,ends_at,
      programs(name)
    `)
    .eq('id',sessionId)
    .maybeSingle();
  if(sErr) throw sErr;
  return session||null;
}

function topicDirectPath(session,topicTitle){
  // A unique path avoids stale CDN/object-cache behavior when a topic is replaced.
  return `${session.id}/${Date.now()}-${slug(session.programs?.name)}-${slug(topicTitle)}.pdf`;
}

async function handleTopicUploadInit(request){
  if(request.method!=='POST') return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
  const body=await request.json().catch(()=>({}));
  const sessionId=String(body.session_id||'').trim();
  const title=String(body.title||'').trim();
  const fileType=String(body.file_type||'application/pdf').toLowerCase();
  const fileSize=Number(body.file_size||0);
  if(!sessionId||!title) return Response.json({error:'MISSING_FIELDS'},{status:400});
  if(fileType && fileType!=='application/pdf') return Response.json({error:'PDF_ONLY'},{status:400});
  if(fileSize<=0) return Response.json({error:'EMPTY_PDF'},{status:400});
  // Keep a generous application-level guard. The upload itself bypasses the Vercel body limit.
  if(fileSize>50*1024*1024) return Response.json({error:'PDF_TOO_LARGE_MAX_50MB'},{status:413});

  const session=await topicUploadSession(sessionId);
  if(!session) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  const path=topicDirectPath(session,title);
  const {data:signed,error:signErr}=await supabase.storage.from('topics').createSignedUploadUrl(path,{upsert:false});
  if(signErr) throw signErr;
  if(!signed?.signedUrl) return Response.json({error:'SIGNED_UPLOAD_URL_FAILED'},{status:500});
  return Response.json({success:true,path,signed_url:signed.signedUrl,expires_in_seconds:7200});
}

async function handleTopicUploadFinalize(request){
  if(request.method!=='POST') return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
  const body=await request.json().catch(()=>({}));
  const sessionId=String(body.session_id||'').trim();
  const title=String(body.title||'').trim();
  const path=String(body.path||'').trim();
  if(!sessionId||!title||!path) return Response.json({error:'MISSING_FIELDS'},{status:400});

  const session=await topicUploadSession(sessionId);
  if(!session) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  // Finalization may only attach a PDF from the selected session's dedicated folder.
  if(!path.startsWith(`${session.id}/`)||!path.toLowerCase().endsWith('.pdf')){
    return Response.json({error:'INVALID_TOPIC_STORAGE_PATH'},{status:400});
  }

  // Confirm the browser actually completed the direct upload before changing the session row.
  const folder=`${session.id}`;
  const fileName=path.slice(folder.length+1);
  const {data:objects,error:listErr}=await supabase.storage.from('topics').list(folder,{search:fileName,limit:10});
  if(listErr) throw listErr;
  if(!(objects||[]).some(x=>x.name===fileName)){
    return Response.json({error:'TOPIC_PDF_NOT_FOUND_AFTER_UPLOAD',details:'PDF upload did not complete. Please try again.'},{status:409});
  }

  let topicVocabulary;
  try{
    topicVocabulary=await generateTopicVocabulary(title,session.programs?.name||'SpeakHub');
  }catch(vErr){
    console.error('topic vocabulary pre-generation failed',vErr);
    // Do not attach a half-ready topic. The uploaded object can safely remain orphaned and be overwritten by a later unique upload.
    return Response.json({error:'TOPIC_VOCABULARY_GENERATION_FAILED',details:String(vErr?.message||vErr)},{status:502});
  }

  let q=supabase
    .from('class_sessions')
    .update({topic_title:title,topic_storage_path:path,topic_vocabulary:topicVocabulary})
    .eq('program_id',session.program_id)
    .eq('session_date',session.session_date)
    .eq('starts_at',session.starts_at)
    .eq('ends_at',session.ends_at);
  if(session.teacher_id) q=q.eq('teacher_id',session.teacher_id); else q=q.is('teacher_id',null);
  const {data:updated,error:updateErr}=await q.select('id');
  if(updateErr) throw updateErr;

  return Response.json({
    success:true,
    path,
    topic_title:title,
    vocabulary_generated:true,
    vocabulary_count:topicVocabulary.length,
    updated_session_count:(updated||[]).length||1
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
    await removeTopicGeneratedImages(path);
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
  const used=Number(count||0),limit=(testType==='PROGRESS'?1:3);
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
  // Limit successful Progress Tests to 1 per Vietnam calendar day.

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
  // Limit successful Progress Tests to 1 per Vietnam calendar day.

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
  const used=Number(count||0),limit=(testType==='PROGRESS'?1:3);
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
  const method=request.method.toUpperCase();
  let customerId=u.searchParams.get('customer_id');
  let token=u.searchParams.get('token');

  if(method==='POST'){
    const body=await request.json().catch(()=>({}));
    customerId=body.customer_id||customerId;
    token=body.token||token;
    const auth=await requireActiveCustomer(customerId,token);
    if(auth.error) return Response.json({error:auth.error},{status:auth.status});
    const op=body.op||'post';

    if(op==='post'){
      const tag=String(body.tag||'Thảo luận').trim().slice(0,50);
      const title=String(body.title||'').trim().slice(0,500);
      if(!title) return Response.json({error:'TITLE_REQUIRED'},{status:400});
      const today=vnTodayBounds();
      const {count,error:cErr}=await supabase.from('community_posts').select('*',{count:'exact',head:true})
        .eq('customer_id',customerId).gte('created_at',today.start).lt('created_at',today.end);
      if(cErr) throw cErr;
      if(Number(count||0)>=3) return Response.json({error:'COMMUNITY_DAILY_LIMIT'},{status:429});
      const {error}=await supabase.from('community_posts').insert({customer_id:customerId,tag,title});
      if(error) throw error;
      return Response.json({ok:true});
    }

    const postId=body.post_id;
    if(!postId) return Response.json({error:'POST_ID_REQUIRED'},{status:400});

    if(op==='like'){
      const {data:existing,error:eErr}=await supabase.from('community_likes')
        .select('id').eq('post_id',postId).eq('customer_id',customerId).maybeSingle();
      if(eErr) throw eErr;
      if(existing){
        const {error}=await supabase.from('community_likes').delete().eq('id',existing.id);
        if(error) throw error;
        return Response.json({ok:true,liked:false});
      }
      const {error}=await supabase.from('community_likes').insert({post_id:postId,customer_id:customerId});
      if(error) throw error;
      return Response.json({ok:true,liked:true});
    }

    if(op==='comment'){
      const text=String(body.text||'').trim().slice(0,1000);
      if(!text) return Response.json({error:'COMMENT_REQUIRED'},{status:400});
      const {data:inserted,error}=await supabase.from('community_comments')
        .insert({post_id:postId,customer_id:customerId,text})
        .select('id,created_at').single();
      if(error) throw error;
      return Response.json({ok:true,comment:inserted});
    }
    return Response.json({error:'INVALID_COMMUNITY_OPERATION'},{status:400});
  }

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  const {data:posts,error}=await supabase.from('community_posts')
    .select('id,tag,title,created_at,customers(full_name)').order('created_at',{ascending:false}).limit(100);
  if(error) throw error;

  const postIds=(posts||[]).map(p=>p.id);
  let likes=[],comments=[];
  if(postIds.length){
    const [lr,cr]=await Promise.all([
      supabase.from('community_likes').select('id,post_id,customer_id').in('post_id',postIds),
      supabase.from('community_comments').select('id,post_id,text,created_at,customers(full_name)')
        .in('post_id',postIds).order('created_at',{ascending:true})
    ]);
    if(lr.error) throw lr.error;
    if(cr.error) throw cr.error;
    likes=lr.data||[];comments=cr.data||[];
  }

  const todayCommunity=vnTodayBounds();
  const todayCount=(posts||[]).filter(p=>{
    const t=new Date(p.created_at).getTime();
    return t>=new Date(todayCommunity.start).getTime() && t<new Date(todayCommunity.end).getTime();
  }).length;

  const result=(posts||[]).map(p=>{
    const pl=likes.filter(x=>String(x.post_id)===String(p.id));
    const pc=comments.filter(x=>String(x.post_id)===String(p.id));
    return {
      id:p.id,tag:p.tag,title:p.title,created_at:p.created_at,author:p.customers?.full_name||'Học viên',
      likes:pl.length,liked:pl.some(x=>String(x.customer_id)===String(customerId)),
      comments:pc.map(c=>({
        id:c.id,author:c.customers?.full_name||'Học viên',text:c.text,
        time:new Date(c.created_at).toLocaleTimeString('vi-VN',{
          timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit'
        })
      }))
    };
  });
  return Response.json({posts:result,today_count:todayCount,unread_count:todayCount});
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
        progress:{used:0,remaining:1,limit:1}
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
      progress:{used:0,remaining:1,limit:1}
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

  const todayCommunity=vnTodayBounds();
  const cRes=await supabase.from('community_posts').select('*',{count:'exact',head:true})
    .gte('created_at',todayCommunity.start).lt('created_at',todayCommunity.end);
  if(cRes.error)throw cRes.error;

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

async function handleTeacherUsers(request){
  if(request.method==='GET'){
    const [teachersRes,accountsRes]=await Promise.all([
      supabase.from('teachers').select('id,full_name,country,is_active').order('full_name',{ascending:true}),
      supabase.from('teacher_accounts').select('id,teacher_name,username,is_active,created_at,updated_at').order('teacher_name',{ascending:true})
    ]);
    if(teachersRes.error)throw teachersRes.error;
    if(accountsRes.error)throw accountsRes.error;
    const byName=new Map((accountsRes.data||[]).map(a=>[String(a.teacher_name||'').trim().toLowerCase(),a]));
    return Response.json({
      teachers:(teachersRes.data||[]).map(t=>({
        ...t,
        account:byName.get(String(t.full_name||'').trim().toLowerCase())||null
      })),
      accounts:accountsRes.data||[]
    });
  }

  if(request.method==='POST'){
    const b=await request.json().catch(()=>({}));
    const displayName=String(b.display_name||'').trim();
    const country=String(b.country||'').trim();
    const username=String(b.username||'').trim().toLowerCase();
    const password=String(b.password||'');
    if(!displayName||!country||!username||password.length<6){
      return Response.json({error:'Display name, country, username and password (min 6 chars) are required.'},{status:400});
    }

    const {data:existingTeacher,error:checkErr}=await supabase.from('teachers').select('id').ilike('full_name',displayName).limit(1);
    if(checkErr)throw checkErr;
    if((existingTeacher||[]).length)return Response.json({error:'A teacher with this display name already exists. Please use a different name.'},{status:409});

    const {data:teacher,error:tErr}=await supabase.from('teachers').insert({full_name:displayName,country,is_active:true}).select('id,full_name,country,is_active').single();
    if(tErr)throw tErr;
    try{
      const {data,error}=await supabase.rpc('admin_upsert_teacher_account',{
        p_teacher_name:displayName,p_username:username,p_password:password,p_is_active:true
      });
      if(error)throw error;
      return Response.json({success:true,teacher,account:Array.isArray(data)?data[0]:data});
    }catch(err){
      await supabase.from('teachers').delete().eq('id',teacher.id);
      throw err;
    }
  }

  if(request.method==='PATCH'){
    const b=await request.json().catch(()=>({}));
    const accountId=String(b.account_id||'').trim();
    const password=String(b.password||'');
    const username=String(b.username||'').trim().toLowerCase();
    const hasActive=typeof b.is_active==='boolean';
    if(!accountId)return Response.json({error:'ACCOUNT_REQUIRED'},{status:400});
    if(password && password.length<6)return Response.json({error:'Password must be at least 6 characters.'},{status:400});

    const {data,error}=await supabase.rpc('admin_update_teacher_account',{
      p_account_id:accountId,
      p_username:username||null,
      p_password:password||null,
      p_is_active:hasActive?b.is_active:null
    });
    if(error)throw error;
    return Response.json({success:true,account:Array.isArray(data)?data[0]:data});
  }

  return Response.json({error:'Method not allowed'},{status:405});
}

async function handleStudentSchedule(request){
  const u=new URL(request.url), customerId=String(u.searchParams.get('customer_id')||''), q=String(u.searchParams.get('q')||'').trim();
  if(!customerId){
    if(!q)return Response.json({customers:[]});const digits=q.replace(/\D/g,'');let b=supabase.from('customers').select('id,full_name,phone,status').limit(12);
    b=(digits.length>=3)?b.ilike('phone',`%${digits}%`):b.ilike('full_name',`%${q.replace(/[%_]/g,'')}%`);const {data,error}=await b;if(error)throw error;return Response.json({customers:data||[]});
  }
  const {data:c,error:cErr}=await supabase.from('customers').select('id,full_name,phone').eq('id',customerId).maybeSingle();if(cErr)throw cErr;if(!c)return Response.json({error:'CUSTOMER_NOT_FOUND'},{status:404});
  const today=vnTodayBounds().day;
  const scopeInfo=await resolveAdminScope(u.searchParams.get('scope')||'overall');
  let bq=supabase.from('bookings').select(`id,status,session_id,class_sessions!inner(room_id,session_date,starts_at,ends_at,programs(name),rooms(name))`).eq('user_id',customerId).in('status',['CONFIRMED','ATTENDED','NO_SHOW']);
  if(Array.isArray(scopeInfo.room_ids)) bq=scopeInfo.room_ids.length?bq.in('class_sessions.room_id',scopeInfo.room_ids):bq.eq('class_sessions.room_id','00000000-0000-0000-0000-000000000000');
  const {data,error}=await bq.order('created_at',{ascending:true});if(error)throw error;
  return Response.json({customer:c,bookings:(data||[]).map(x=>({id:x.id,status:x.status,session_date:x.class_sessions?.session_date||'',starts_at:x.class_sessions?.starts_at||'',ends_at:x.class_sessions?.ends_at||'',program_name:x.class_sessions?.programs?.name||'',room_name:x.class_sessions?.rooms?.name||''})).filter(x=>x.session_date&&x.session_date>=today)});
}

async function handleTrackVisit(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const b=await request.json().catch(()=>({}));
  const visitor=String(b.visitor_id||'').trim().slice(0,120);
  if(!visitor)return Response.json({error:'VISITOR_REQUIRED'},{status:400});
  const day=vnTodayBounds().day;
  const lastSeen=new Date().toISOString();

  const {error}=await supabase.from('website_visit_daily').upsert(
    {visitor_id:visitor,visited_on:day,last_seen_at:lastSeen},
    {onConflict:'visitor_id,visited_on'}
  );
  if(error)throw error;
  return Response.json({success:true,visited_on:day,last_seen_at:lastSeen});
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



// ===== V117 adaptive test profiles =====
async function customerAdaptiveTier(customerId,programName=''){
  const p=String(programName||'').toLowerCase();
  let latest=null;
  if(customerId){
    const {data,error}=await supabase.from('placement_tests').select('age_at_test,recommended_program_name,created_at').eq('customer_id',customerId).eq('status','COMPLETED').order('created_at',{ascending:false}).limit(1).maybeSingle();
    if(!error)latest=data||null;
  }
  const age=Number(latest?.age_at_test||0)||null;
  const levelText=(p||String(latest?.recommended_program_name||'').toLowerCase());
  if(levelText.includes('kid')) return age!==null&&age<10?'youngKid':'teenKid';
  if(age!==null&&age<10)return 'youngKid';
  if(age!==null&&age<16)return 'teenKid';
  if(levelText.includes('intermediate'))return 'intermediate';
  return 'beginner';
}
function adaptiveDifficultyLabel(tier){
  return tier==='youngKid'?'very easy English for a child under 10; concrete ideas, very short sentences, friendly and visual/emoji-friendly':tier==='teenKid'?'easy-to-moderate English for ages 10-15; clear school/life topics, simple reasons and examples':tier==='intermediate'?'intermediate B1-B2 English; richer vocabulary, reasoning, examples and nuance':'beginner A1-A2/B1 English; practical everyday language and clear short explanations';
}

// ===== V112 AI Test Center: Pronunciation + Session Comprehension =====
function v112Text(data){return extractResponseText(data)}
async function v112AI(prompt,schema,name){
  const resp=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_PLACEMENT_MODEL||'gpt-5-mini',input:[{role:'system',content:[{type:'input_text',text:prompt}]}],text:{format:{type:'json_schema',name,schema,strict:true}}})});
  const d=await resp.json().catch(()=>({}));if(!resp.ok)throw new Error(d?.error?.message||'OPENAI_TEST_FAILED');return JSON.parse(v112Text(d));
}

const V117_PRON_BANKS={
  youngKid:{
    paragraphs:[
      'I have a little dog. He likes to run in the park and play with a red ball.',
      'My school is near my house. I walk there with my sister every morning.',
      'On Sunday, we make pancakes. I help mix the eggs, milk, and flour.',
      'The sun is bright today. We take our bikes outside and ride around the park.',
      'My favorite animal is a dolphin. It can swim fast and jump out of the water.',
      'I keep my books on a small desk. My blue pencil case is next to the lamp.',
      'After school, I eat a snack and play a game with my brother.',
      'There are three birds in the tree. One is yellow and two are brown.',
      'I like rainy days because I can wear my boots and use my umbrella.',
      'Our teacher reads a funny story. Everyone listens and laughs together.',
      'My birthday is in October. We have a cake, candles, and a small family party.',
      'At the zoo, I see a tall giraffe, a sleepy lion, and two playful monkeys.',
      'I wash my hands before lunch and put my plate on the table.',
      'My friend and I build a tower with blocks. We try again when it falls down.',
      'We plant a small flower in the garden and give it water every day.',
      'I can sing one English song. I practise it slowly and then sing it faster.',
      'The bus comes at seven. I sit by the window and look at the streets.',
      'My grandma makes warm soup. I help carry the bowls to the table.',
      'I draw a green tree, a yellow sun, and a small house with a red door.',
      'Before bed, I brush my teeth and choose one short book to read.'
    ],
    words:'apple animal balloon banana basket beautiful birthday brother chicken classroom cloudy cookie dinner doctor family favorite flower friend funny garden giraffe happy homework jacket kitchen little monkey morning mother orange pencil picture playground purple rabbit rainy school sister sleepy smile soccer spoon student sunny teacher tiger tomorrow umbrella window yellow'.split(/\s+/)
  },
  teenKid:{
    paragraphs:[
      'Learning a new skill takes time. Short practice every day can be more useful than one very long lesson each week.',
      'Our class worked on a science project together. We shared ideas, tested different designs, and fixed the parts that did not work.',
      'A good friend listens carefully and speaks honestly. Small problems are easier to solve when both people stay calm.',
      'Phones can help students find information quickly, but they can also make it harder to focus during homework.',
      'Last weekend, my family visited a new place in the city. We took photos, tried local food, and learned something about its history.',
      'When I feel nervous before speaking English, I prepare my first sentence and take one slow breath before I begin.',
      'Team sports teach more than physical skills. Players also learn to communicate, support each other, and handle mistakes.',
      'A useful school project should solve a real problem. Even a simple idea can become interesting when students test and improve it.',
      'Reading stories in English helps me notice new words in context. I remember them better when I use them in my own sentences.',
      'Good study habits are easier to keep when goals are clear. Finishing one small task can make the next task feel less difficult.',
      'People sometimes disagree because they understand a situation differently. Asking a question can be better than making a quick judgment.',
      'Trying something new can feel uncomfortable at first. Confidence often grows after we practise, make mistakes, and try again.',
      'A strong presentation has a clear beginning, useful examples, and a short ending that reminds the audience of the main idea.',
      'Social media can be fun and useful, but people should check information before sharing it with others.',
      'If students want to improve English, they need chances to speak. Real conversations help turn passive knowledge into active skill.',
      'A difficult subject becomes easier when students break it into smaller parts and ask for help when they need it.',
      'Volunteering can help young people understand their community. It also gives them a chance to meet people with different experiences.',
      'Saving money for a goal requires patience. Small choices each week can become a meaningful amount over several months.',
      'A healthy routine includes enough sleep, regular movement, and time away from screens before bed.',
      'When a plan fails, the best next step is to understand why. A small change in strategy may produce a much better result.'
    ],
    words:'achievement adventure advice attention awkward balance behaviour challenge choice comfortable community compare confident consequence creative curious decision describe develop different direction discussion education effective environment example familiar flexible focus future habit improve independent information journey language leadership meaningful motivate natural opportunity ordinary organise particular patience performance practical prefer prepare priority probably progress question realistic recognise recommend relationship reliable remember responsibility result rhythm schedule serious situation skill social specific strategy strength successful support technology thought through together useful usually variety vocabulary volunteer weather world'.split(/\s+/)
  },
  beginner:{
    paragraphs:[
      'Speaking English regularly can build confidence. A short conversation every day gives learners a chance to use familiar words in real situations.',
      'A clear daily routine makes work easier to manage. People can choose a few important tasks and finish them before moving to smaller jobs.',
      'Travelling to a new place can be exciting. Asking simple questions and listening carefully often helps visitors solve practical problems.',
      'Good communication starts with listening. When people understand the main idea first, they can answer more clearly and avoid confusion.',
      'Learning from mistakes is part of improvement. The important thing is to notice the problem, correct it, and practise the better version again.',
      'A job interview becomes easier with preparation. Candidates should explain their experience with short examples and answer the question directly.',
      'Healthy habits do not need to be complicated. Regular sleep, simple exercise, and balanced meals can support energy throughout the day.',
      'Saving money becomes easier when people track small expenses. A simple plan can help them decide what is necessary and what can wait.',
      'Technology is useful when it saves time or makes information easier to find. People still need to check important details before making decisions.',
      'A good meeting should have a clear purpose. Everyone needs to know the main question and what action should happen next.',
      'Friendships stay strong when people communicate honestly. It is often better to explain a problem calmly than to avoid the conversation.',
      'Studying English through topics can make practice more interesting. Learners can connect new vocabulary with ideas they already understand.',
      'Confidence in speaking grows slowly. People usually feel more comfortable after they have repeated useful phrases in several real conversations.',
      'A useful presentation is easy to follow. The speaker introduces the idea, gives one or two examples, and finishes with a clear message.',
      'People often manage time better when they reduce distractions. Turning off unnecessary notifications can make focused work much easier.',
      'Customer service requires patience and clear language. Asking the right question can help identify the real problem before offering a solution.',
      'Remote work can save travel time, but workers need clear routines and regular communication with their team.',
      'A practical goal should be specific enough to measure. Small weekly progress is easier to notice when the target is clear.',
      'When people learn new vocabulary, they remember it better by using the words in sentences instead of only reading a list.',
      'A difficult conversation can improve when both people slow down, listen carefully, and explain what they need without blaming each other.',
      'Exercise can improve energy and mood. A simple walk or short workout is often easier to maintain than an extreme plan.',
      'Good teamwork depends on clear roles and respectful communication. People work faster when they know what they are responsible for.',
      'Public transport can make cities more convenient. Reliable buses and trains help people travel without depending on private vehicles.',
      'A strong habit starts with a small action that is easy to repeat. Consistency matters more than trying to change everything at once.',
      'When learning feels difficult, changing the method may help. A different example or shorter practice session can make the idea clearer.'
    ],
    words:'accurate adapt advice affordable agreement answer apartment audience available balance business calendar career careful challenge choice comfortable compare confident convenient cooperate customer decision describe detail develop different direction discuss education effective efficient encourage energy environment example experience familiar flexible focus friendly future goal grammar habit healthy help improve information interview language learn manage meaningful method natural necessary notice opportunity organise patience practical prefer prepare problem productive progress pronunciation question realistic recommend relationship remember result schedule simple situation skill speaking strategy successful support useful usually value variety vocabulary weather workplace'.split(/\s+/)
  }
};

const V116_PRON_PARAGRAPHS=[
  "Every small habit shapes the way we learn. When people practise with patience, they notice mistakes earlier, speak more clearly, and build confidence step by step.",
  "A useful conversation is not only about choosing the right words. Good speakers listen carefully, respond naturally, and give the other person enough time to share an idea.",
  "Learning a language becomes easier when it is part of daily life. Reading signs, describing simple routines, and asking short questions can turn ordinary moments into useful practice.",
  "People often improve faster when they focus on one clear goal. A specific target makes practice easier to measure and helps learners stay motivated when progress feels slow.",
  "Technology can save time, but it can also create distractions. The best tools support our decisions without replacing the attention and effort needed to learn something well.",
  "Travel teaches people to adapt quickly. New places, unfamiliar food, and different customs encourage us to observe carefully and communicate even when we do not know every word.",
  "A strong team depends on trust and communication. Members need to explain ideas clearly, ask for help when necessary, and respect different opinions before making a decision.",
  "Confidence usually grows after action, not before it. When learners speak despite small mistakes, they collect real experience and become less afraid of difficult conversations.",
  "Healthy routines are easier to maintain when they are realistic. Sleeping well, moving regularly, and planning meals can support both physical energy and concentration during the day.",
  "Successful people do not always work longer hours. Many of them choose priorities carefully, protect their attention, and spend more time on tasks that create meaningful results.",
  "Cities change when more people work, study, and travel in different ways. Public transport, green spaces, and flexible services can make daily life more convenient for everyone.",
  "A good presentation guides the listener from one idea to the next. Clear structure, short examples, and a calm speaking pace often matter more than using complicated vocabulary.",
  "Making a difficult decision requires both information and judgment. People compare options, think about possible consequences, and decide which risk they are willing to accept.",
  "Friendships can become stronger through honest communication. Small misunderstandings are easier to solve when people explain how they feel instead of making quick assumptions.",
  "Workplaces are changing as artificial intelligence becomes more common. Employees may need to learn new skills, check information carefully, and use technology as a practical assistant.",
  "Saving money is easier when people understand where their income goes. Simple planning can reveal unnecessary spending and make larger goals feel more achievable over time.",
  "Curiosity helps people learn beyond the classroom. Asking why something happens, comparing different explanations, and searching for evidence can lead to deeper understanding.",
  "A job interview is a conversation with a purpose. Strong candidates answer directly, support their claims with examples, and show how their experience connects to the role.",
  "Social media can connect people quickly, but short messages sometimes create confusion. Reading carefully and checking context can prevent unnecessary arguments or false conclusions.",
  "Children learn many skills through play. Games can encourage creativity, cooperation, problem solving, and the confidence to try again after something does not work.",
  "A memorable story usually contains a clear change. The listener understands what happened, why it mattered, and how the character felt before and after the main event.",
  "Negotiation works best when both sides understand each other's priorities. Asking useful questions can reveal solutions that are better than simply arguing about one number.",
  "Good leaders do not need to have every answer. They create direction, listen to useful feedback, and help other people take responsibility for important decisions.",
  "Environmental choices often involve trade-offs. A convenient option today may create a larger cost later, so communities need to compare short-term benefits with long-term impact.",
  "Studying abroad can be exciting and challenging at the same time. Students must manage practical tasks, communicate with new people, and adapt to unfamiliar expectations.",
  "People remember information better when they connect it to something meaningful. Examples, personal stories, and repeated practice can make new ideas easier to recall later.",
  "A productive meeting needs a clear purpose. Participants should know what must be discussed, which decisions are required, and what actions will happen after the meeting ends.",
  "Mistakes are useful when we examine them carefully. Instead of feeling embarrassed, learners can identify the cause, adjust their approach, and avoid repeating the same problem.",
  "Customer service becomes difficult when expectations are unclear. Calm questions, accurate information, and practical solutions can turn a frustrating situation into a positive experience.",
  "The ability to explain a complex idea simply is valuable. It shows that a speaker understands the topic and can choose language that matches the listener's needs.",
  "Remote work offers flexibility, but it also requires discipline. People need to organise tasks, communicate progress, and create boundaries between working time and personal time.",
  "Exercise can improve more than physical fitness. Regular movement may support mood, concentration, and energy, especially when it becomes a consistent part of a person's routine.",
  "Different generations may view careers in different ways. Some value stability, while others prefer flexibility, rapid learning, or the freedom to change direction more often.",
  "A good debate is not a competition to speak the loudest. Participants need evidence, logical reasons, and the ability to respond directly to the strongest point from the other side.",
  "When people move to a new country, language is only one part of adaptation. Social habits, humour, workplace culture, and everyday rules can also take time to understand.",
  "Buying something expensive often involves emotion as well as logic. Comparing real needs, long-term value, and alternative choices can reduce regret after the decision.",
  "A clear explanation usually begins with the main idea. Details and examples should support that idea instead of forcing the listener to guess what the speaker is trying to say.",
  "Building a new skill requires repetition with feedback. Practice becomes more effective when learners know what they did well and what specific detail they should change next time.",
  "Communities become stronger when people participate. Sharing useful information, helping neighbours, and respecting common spaces can improve daily life in simple but meaningful ways.",
  "The future of education may combine teachers, technology, and independent learning. The challenge is to use each method for the kind of learning it supports best.",
  "People sometimes avoid difficult conversations because they expect conflict. Preparing the key message and listening without interrupting can make the discussion more respectful and useful.",
  "Creativity often begins with ordinary observations. A small inconvenience, an unusual question, or a different combination of familiar ideas can become the start of something new.",
  "Strong pronunciation is not about copying one perfect accent. The main goal is to make sounds, stress, and rhythm clear enough that other people can understand the message easily.",
  "Time management is really about choosing what deserves attention. A full schedule can still be unproductive if important tasks are constantly delayed by smaller urgent requests.",
  "When learning feels difficult, changing the method can be more useful than simply trying harder. A new example, shorter practice, or immediate feedback may unlock progress.",
  "Public speaking becomes easier when the speaker knows the audience. The same idea can sound very different when it is explained to children, colleagues, customers, or experts.",
  "A good question can improve a conversation immediately. Open questions invite longer answers, while focused follow-up questions show that the listener is genuinely paying attention.",
  "Success can be measured in different ways. Income and status matter to some people, while others care more about freedom, relationships, personal growth, or meaningful work."
];
const V116_PRON_EXTENSIONS=[
  "Try to keep a steady pace while reading, connect ideas naturally, and make important words slightly clearer. The goal is not speed, but speech that another person can follow without effort.",
  "Pay attention to final consonants, word stress, and the rhythm between short and long phrases. A calm pace usually makes pronunciation easier to understand than rushing through every sentence.",
  "Read as if you were explaining the idea to a real person. Pause briefly at punctuation, keep your voice relaxed, and avoid making every word sound equally strong.",
  "Clear speech comes from accurate sounds and natural rhythm working together. Focus on complete words, especially endings, while keeping the sentence connected instead of reading one word at a time.",
  "Do not worry about having a perfect accent. Concentrate on intelligibility, consistent word stress, and smooth transitions so the message sounds confident and easy to follow.",
  "Use a conversational tone rather than a robotic reading voice. Let stressed words carry the meaning, reduce less important words slightly, and keep each sentence moving forward naturally.",
  "Take enough time to pronounce difficult clusters and longer words. A short pause is better than swallowing a sound, because clarity matters more than finishing the paragraph quickly.",
  "Keep your breathing comfortable and your volume steady. When a sentence becomes long, group words into meaningful phrases instead of trying to say the whole line in one breath.",
  "Imagine that the listener cannot see the text. Your pronunciation should make the structure of the sentence clear through stress, small pauses, and smooth connections between related words.",
  "Notice how English rhythm alternates between stronger and weaker syllables. You do not need to exaggerate the pattern, but a little contrast can make your speech sound much more natural.",
  "For the word list, say each item separately and clearly. Give yourself a brief pause between words so the system can hear the complete pronunciation rather than one continuous string.",
  "Accuracy and fluency should support each other. If a word feels difficult, slow down for that word, then return to a natural pace instead of keeping the entire paragraph unusually slow."
];
const V116_PRON_WORDS=`achievement accurate adapt advantage adventure affordable agreement ambitious analysis anxious apology approach argument arrangement audience authentic available awareness awkward balance behaviour benefit boundary breathe brilliant business calendar career challenge character choice comfortable community compare confident consequence consistent convenient cooperate courage creative culture curious customer debate decision describe detail develop different direction discipline discuss education effective efficient encourage energy entrepreneur environment especially essential evaluate evidence example experience familiar flexible fluency focus foreign fortunate function general genuine goal government grammar growth habit healthy hesitate identify imagine impact improve independent influence information interview knowledge language leadership likely maintain meaningful measure motivate natural necessary negotiate notice opportunity ordinary organise particular patience performance perspective practical prefer prepare priority probably problem productive progress pronunciation purpose quality question realistic recognise recommend relationship reliable remember responsibility result rhythm schedule serious similar situation solution specific strategy strength stress successful support technology thought through together tradition useful usually value variety vegetable vehicle vocabulary volunteer vulnerable weather world ability absolute academic accept access accident account achieve action active actually addition address adjust admire adult advice affect afford against allow almost alternative amazed amount ancient announce answer apartment appear apply appreciate argue arrive article avoid basic beautiful because become before belief belong better borrow brave break bridge bright bring broad budget build busy careful carry cause certain chance change choose citizen climate close colleague common communicate complete concern condition connect consider contact continue control conversation correct create current custom daily damage decide deep degree demand depend design difficult direct discover distance district divide document during early earn effect effort either employee empty enough equal escape event exact excellent expect explain express extra famous feature final finance follow formal forward freedom friendly future gentle global happen helpful honest include increase industry instead interest involve journey judge later leader learn level local manage market matter memory message method modern nearly normal object opinion patient pattern perhaps personal popular position possible present prevent private process promise protect public receive recent reduce regular relation report require respect safe science share simple skill social special speech spend standard strange strong student success system teacher team temperature travel various voice whole willing wonder work workplace abroad abstract accessible accommodation accomplish acknowledge acquire adequate administration advance advertise advocate agenda aggressive alert analyse anticipate apparent appeal appropriate approve arrange assess assume attach attempt attention attitude attract authority average aware background barrier brief campaign capable category circumstance clarify client combine comment commercial commit compete complain complex concentrate conclude conduct confirm conflict constant consumer context contrast contribute convince coordinate critical decline define demonstrate despite determine difference engage enhance ensure establish estimate examine exchange expand explore extend framework generate handle ignore illustrate implement indicate inform intention interpret introduce issue justify objective outcome participate policy potential promote propose provide reflect research resolve resource respond review significant structure suggest theory transfer development`.split(/\s+/);
function vnDayBounds(){
  const ymd=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return {ymd,start:`${ymd}T00:00:00+07:00`,end:`${ymd}T23:59:59.999+07:00`};
}
async function pronunciationUsage(customerId){
  const {start,end}=vnDayBounds();
  const {count,error}=await supabase.from('pronunciation_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',start).lte('created_at',end);
  if(error)throw error;
  const used=Math.min(1,count||0);return {used,remaining:Math.max(0,1-used),limit:1};
}
function pronunciationPoolForTier(tier){
  const cfg=tier==='intermediate'?{paragraphs:V116_PRON_PARAGRAPHS,words:V116_PRON_WORDS}:V117_PRON_BANKS[tier]||V117_PRON_BANKS.beginner;
  const extensions=tier==='intermediate'?V116_PRON_EXTENSIONS:[
    'Read at a calm pace. Make each word clear and pause naturally at punctuation.',
    'Keep your voice relaxed. Focus on complete words, clear endings, and steady rhythm.',
    'Read as if you are talking to a real person. Clarity is more important than speed.',
    'Pause briefly between ideas and pronounce the final sound of each important word.',
    'Use a steady rhythm and make stressed words slightly stronger than small grammar words.',
    'Do not rush. A natural, comfortable pace is better than speaking as fast as possible.',
    'Finish each sentence clearly, then take a short breath before the next sentence.',
    'Keep vowels open and consonant endings complete, especially when two words connect.'
  ];
  const pool=[];
  const para=cfg.paragraphs||[];
  const words=cfg.words||[];
  // Deterministic bank: each paragraph cycles through every extension before repeating.
  // Word windows are also shifted, so the complete prompt remains unique for the whole pool.
  for(let pi=0;pi<para.length;pi++){
    for(let ei=0;ei<extensions.length;ei++){
      const picked=[];
      const offset=(pi*13+ei*17)%Math.max(1,words.length);
      for(let k=0;k<10&&k<words.length;k++)picked.push(words[(offset+k*7)%words.length]);
      const paragraph=`${para[pi]} ${extensions[ei]}`;
      pool.push({tier,paragraph,words:picked,reference_text:`BANK:${tier}:${pi}:${ei}\nPARAGRAPH:\n${paragraph}\nWORDS: ${picked.join(', ')}`});
    }
  }
  return pool;
}
async function handlePronunciationPrompt(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const b=vnDayBounds();
  const {count:todayCount,error:todayErr}=await supabase.from('pronunciation_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',b.start).lte('created_at',b.end);
  if(todayErr)throw todayErr;
  if(Number(todayCount||0)>=1)return Response.json({error:'PRONUNCIATION_DAILY_LIMIT',usage:{used:1,remaining:0,limit:1,date:b.ymd}},{status:429});
  const tier=await customerAdaptiveTier(customerId);
  const {count:allCount,error:allErr}=await supabase.from('pronunciation_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED');
  if(allErr)throw allErr;
  const pool=pronunciationPoolForTier(tier);
  const content=pool[Number(allCount||0)%Math.max(1,pool.length)]||pool[0];
  return Response.json({success:true,usage:{used:0,remaining:1,limit:1,date:b.ymd},pool_size:pool.length,...content});
}

function listeningScenario(index,tier){
  const names=[['Mia','Leo'],['Anna','Ben'],['Nora','Sam'],['Emma','Jack'],['Lily','Noah'],['Chloe','Max'],['Sophie','Daniel'],['Grace','Ryan']];
  const places=['library','coffee shop','school office','bookstore','bus stop','community center','sports club','supermarket','train station','study room'];
  const times=['8:30','9:15','10:00','11:45','1:30','2:20','3:15','4:40','5:30','6:10'];
  const items=['English book','notebook','train ticket','lunch box','presentation file','blue jacket','phone charger','sports bag','coffee order','homework folder'];
  const prices=['45,000 dong','60,000 dong','75,000 dong','90,000 dong','120,000 dong','150,000 dong','180,000 dong','200,000 dong'];
  const reasons=['the weather may change','they have an English class later','the first option is sold out','they need more time to prepare','the bus is running late','a friend recommended it','the room is quieter','it is closer to home'];
  const actions=['meet near the entrance','send a message after class','buy the item before leaving','wait for ten minutes','call the teacher','take the next bus','finish the work together','return tomorrow morning'];
  let n=Math.max(0,Number(index)||0);
  const pick=arr=>{const v=arr[n%arr.length];n=Math.floor(n/arr.length);return v};
  const [a,b]=pick(names),place=pick(places),time=pick(times),item=pick(items),price=pick(prices),reason=pick(reasons),action=pick(actions);
  let dialogue;
  if(tier==='youngKid') dialogue=`${a}: Hi ${b}! Are you going to the ${place} at ${time}? ${b}: Yes. I need my ${item}. ${a}: Great. Why are you going there? ${b}: Because ${reason}. ${a}: Okay. After that, let's ${action}.`;
  else if(tier==='teenKid') dialogue=`${a}: Are we still meeting at the ${place} at ${time}? ${b}: Yes, but I need to bring my ${item}. ${a}: No problem. I heard it costs about ${price}. ${b}: That's fine. I chose this plan because ${reason}. ${a}: Good idea. Then we can ${action}.`;
  else if(tier==='beginner') dialogue=`${a}: Hi ${b}, are you free to meet at the ${place} at ${time}? ${b}: Yes. I also need to pick up my ${item}. ${a}: I checked earlier and it should cost around ${price}. ${b}: That works for me. I prefer this plan because ${reason}. ${a}: Perfect. When we're finished, let's ${action}.`;
  else dialogue=`${a}: Before we confirm the plan, can we meet at the ${place} at ${time}? ${b}: That should work. I also need to collect my ${item}, and the estimated cost is ${price}. ${a}: Fine with me. Is there a particular reason you prefer that option? ${b}: Mainly because ${reason}. It seems more practical. ${a}: Agreed. Once that's done, we should ${action} so we don't lose any more time.`;
  const mk=(prompt,correct,alts)=>({prompt,options:[correct,...alts],answer:0});
  const questions=[
    mk('Where are the speakers planning to meet?',place,['at home','at a hospital','at an airport']),
    mk('What time do they plan to meet?',time,['7:00','12:00','8:00']),
    mk(`What item does ${b} mention?`,item,['a camera','an umbrella','a bicycle']),
    mk('Why do they prefer this plan?',reason,['they forgot the address','they want to cancel','they dislike the place']),
    mk('What will they do afterward?',action,['go home immediately','change the plan completely','wait until next week'])
  ];
  if(tier!=='kid_u10') questions[2]=mk('What cost is mentioned?',price,['20,000 dong','300,000 dong','500,000 dong']);
  const mixed=questions.map((q,i)=>{const shift=(index+i)%q.options.length;const options=q.options.slice(shift).concat(q.options.slice(0,shift));return {...q,options,answer:(q.options.length-shift)%q.options.length};});
  return {dialogue,questions:mixed,scenario_id:`${tier}-${index}`,tier};
}
async function handleListeningPrompt(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const b=vnDayBounds();
  const {count:todayCount,error:e1}=await supabase.from('listening_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',b.start).lte('created_at',b.end);if(e1)throw e1;
  if(Number(todayCount||0)>=1)return Response.json({error:'LISTENING_DAILY_LIMIT'},{status:429});
  const {count:allCount,error:e2}=await supabase.from('listening_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED');if(e2)throw e2;
  const tier=await customerAdaptiveTier(customerId); const poolSize=960; const item=listeningScenario(Number(allCount||0)%poolSize,tier);
  return Response.json({success:true,...item,pool_size:poolSize,usage:{used:0,remaining:1,limit:1,date:b.ymd}});
}
async function handleListeningScore(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const body=await request.json().catch(()=>({})),customerId=String(body.customer_id||''),token=String(body.token||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const b=vnDayBounds();
  const {count,error:e1}=await supabase.from('listening_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',b.start).lte('created_at',b.end);if(e1)throw e1;
  if(Number(count||0)>=1)return Response.json({error:'LISTENING_DAILY_LIMIT'},{status:429});
  const tier=await customerAdaptiveTier(customerId); const idx=Math.max(0,parseInt(String(body.scenario_id||'').split('-').pop()||'0',10)||0); const expected=listeningScenario(idx,tier);
  const answers=Array.isArray(body.answers)?body.answers:[]; let correct=0;
  expected.questions.forEach((q,i)=>{if(Number(answers[i])===q.answer)correct++});
  const score=correct*20;
  const feedback=score>=80?'Nghe tốt và nắm được phần lớn chi tiết quan trọng.':score>=60?'Bạn hiểu ý chính khá ổn; nên chú ý thêm thời gian, lý do và chi tiết cụ thể.':'Nên nghe theo cụm ý, tập bắt từ khóa về nơi chốn, thời gian, lý do và hành động tiếp theo.';
  const {data,error}=await supabase.from('listening_tests').insert({customer_id:customerId,scenario_id:expected.scenario_id,tier,dialogue:expected.dialogue,questions:expected.questions,answers,correct_count:correct,overall_score:score,feedback_vi:feedback,status:'COMPLETED'}).select('id,created_at').single(); if(error)throw error;
  return Response.json({success:true,id:data.id,created_at:data.created_at,correct_count:correct,overall_score:score,feedback_vi:feedback});
}

function grammarScenario(index,tier){
  const poolSize=1440;
  const idx=Math.max(0,Number(index)||0)%poolSize;
  const names=['Anna','Ben','Mia','Leo','Nora','Sam','Emma','Jack','Lily','Noah','Chloe','Max'];
  const nouns=['project','meeting','homework','report','presentation','English class','bus','book','coffee','phone','schedule','exercise'];
  const places=['school','office','library','cafe','park','station','classroom','store'];
  const days=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const verbs=[['go','goes','went'],['study','studies','studied'],['work','works','worked'],['play','plays','played'],['watch','watches','watched'],['finish','finishes','finished'],['visit','visits','visited'],['carry','carries','carried']];
  const adjectives=[['fast','faster','fastest'],['easy','easier','easiest'],['quiet','quieter','quietest'],['busy','busier','busiest'],['small','smaller','smallest'],['cheap','cheaper','cheapest'],['strong','stronger','strongest'],['friendly','friendlier','friendliest']];
  let code=idx;
  const take=arr=>{const v=arr[code%arr.length];code=Math.floor(code/arr.length);return v;};
  // Mixed-radix selection makes the visible context tuple unique for all 1,440 sets.
  const n1=take(names),noun=take(nouns),place=take(places),day=take(days);
  const n2=names[(idx*5+3)%names.length],v=verbs[(idx*3+1)%verbs.length],adj=adjectives[(idx*5+2)%adjectives.length];
  const shuffle=(correct,alts,salt)=>{const base=[correct,...alts];const shift=(idx+salt)%base.length;const options=base.slice(shift).concat(base.slice(0,shift));return {options,answer:(base.length-shift)%base.length};};
  const mk=(prompt,correct,alts,explanation,salt)=>({prompt,...shuffle(correct,alts,salt),explanation});
  let qs=[];
  if(tier==='youngKid'){
    qs=[
      mk(`${n1} ___ to school near the ${place} every ${day}.`,v[1],[v[0],v[2],'going'],'Use the third-person singular form after he/she/a name in the present simple.',1),
      mk(`There ___ two books on the desk.`,'are',['is','be','am'],'Use “are” with plural nouns.',2),
      mk(`Yesterday, ${n2} ___ at the ${place}.`,v[2],[v[0],v[1],'will '+v[0]],'“Yesterday” normally needs the past simple.',3),
      mk(`I have ___ apple.`,'an',['a','the','some'],'Use “an” before a vowel sound.',4),
      mk(`The bag is ___ the chair.`,'under',['at','for','from'],'“Under” shows a lower position.',5),
      mk(`She ___ swim very well.`,'can',['cans','can to','is can'],'Modal “can” is followed by the base verb.',6),
      mk(`This book is ___ than that one.`,adj[1],[adj[0],adj[2],'more '+adj[2]],'Use the comparative form with “than”.',7),
      mk(`If it rains, we ___ inside.`,'will stay',['stayed','stays','staying'],'Use “will + verb” for a likely future result.',8)
    ];
  }else if(tier==='teenKid'){
    qs=[
      mk(`${n1} usually ___ the ${noun} at the ${place} every ${day}.`,v[1],[v[0],v[2],'is '+v[0]],'Present simple third-person singular takes -s/-es.',1),
      mk(`They ___ at the ${place} right now.`,'are studying',['study','studied','studies'],'“Right now” calls for the present continuous.',2),
      mk(`We ___ the ${noun} last ${day}.`,v[2],[v[0],v[1],'have '+v[1]],'A finished past time takes the past simple.',3),
      mk(`She bought ___ new phone yesterday.`,'a',['an','some','any'],'Use “a” before a singular countable noun beginning with a consonant sound.',4),
      mk(`The meeting starts ___ 9:00.`,'at',['in','on','for'],'Use “at” for clock times.',5),
      mk(`You ___ bring your ID tomorrow.`,'should',['should to','shoulds','are should'],'A modal is followed by the base form.',6),
      mk(`This exercise is ___ than the last one.`,adj[1],[adj[0],adj[2],'most '+adj[0]],'Use the comparative form with “than”.',7),
      mk(`If I have time tonight, I ___ you.`,'will call',['called','would called','calling'],'First conditional: if + present, will + base verb.',8)
    ];
  }else if(tier==='intermediate'){
    qs=[
      mk(`By the time the meeting at the ${place} started on ${day}, ${n1} ___ the ${noun}.`,'had finished',['has finished','finished','was finishing'],'Past perfect shows an earlier action before another past event.',1),
      mk(`The report ___ by the team before Friday.`,'will be completed',['will complete','is completing','has complete'],'Future passive: will be + past participle.',2),
      mk(`If the company ___ earlier, it might have avoided the problem.`,'had acted',['acted','would act','has acted'],'Third conditional uses if + past perfect.',3),
      mk(`${n2} suggested ___ the discussion until everyone arrived.`,'delaying',['to delay','delay','delayed'],'“Suggest” is commonly followed by a gerund.',4),
      mk(`The manager, ___ joined last month, is leading the project.`,'who',['which','where','whose'],'Use “who” for a person as the subject of a relative clause.',5),
      mk(`Hardly ___ the presentation started when the power went out.`,'had',['has','did','was'],'After “hardly” at the beginning, use inversion with past perfect.',6),
      mk(`The new process is considerably ___ than the old one.`,adj[1],[adj[0],adj[2],'more '+adj[2]],'A comparative form is required after “than”.',7),
      mk(`I would rather you ___ me before changing the schedule.`,'told',['tell','will tell','have told'],'“Would rather + subject” takes a past form for present/future preference.',8)
    ];
  }else{
    qs=[
      mk(`${n1} usually ___ the ${noun} at the ${place} every ${day}.`,v[1],[v[0],v[2],'is '+v[0]],'Use present simple for routines; third-person singular takes -s/-es.',1),
      mk(`We ___ at the ${place} when you called.`,'were waiting',['wait','are waiting','have waited'],'Past continuous describes an action in progress at a past moment.',2),
      mk(`${n2} ___ the ${noun} yesterday.`,v[2],[v[0],v[1],'has '+v[0]],'“Yesterday” takes the past simple.',3),
      mk(`She needs ___ umbrella because it may rain.`,'an',['a','the','some'],'Use “an” before a vowel sound.',4),
      mk(`The class begins ___ ${day}.`,'on',['at','in','by'],'Use “on” with days of the week.',5),
      mk(`You ___ check the details before you send the email.`,'should',['should to','shoulds','are should'],'Modal verbs are followed by the base verb.',6),
      mk(`This option is ___ than the first one.`,adj[1],[adj[0],adj[2],'most '+adj[0]],'Use the comparative form with “than”.',7),
      mk(`If we finish early, we ___ the plan together.`,'will review',['reviewed','would reviewed','reviewing'],'First conditional uses will + base verb in the result clause.',8)
    ];
  }
  return {scenario_id:`${tier}-${idx}`,tier,questions:qs,pool_size:poolSize};
}
async function handleGrammarPrompt(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const b=vnDayBounds();
  const {count:todayCount,error:e1}=await supabase.from('grammar_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',b.start).lte('created_at',b.end);if(e1)throw e1;
  if(Number(todayCount||0)>=1)return Response.json({error:'GRAMMAR_DAILY_LIMIT'},{status:429});
  const {count:allCount,error:e2}=await supabase.from('grammar_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED');if(e2)throw e2;
  const tier=await customerAdaptiveTier(customerId);const item=grammarScenario(Number(allCount||0),tier);
  return Response.json({success:true,...item,usage:{used:0,remaining:1,limit:1,date:b.ymd}});
}
async function handleGrammarScore(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const body=await request.json().catch(()=>({})),customerId=String(body.customer_id||''),token=String(body.token||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const b=vnDayBounds();
  const {count,error:e1}=await supabase.from('grammar_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',b.start).lte('created_at',b.end);if(e1)throw e1;
  if(Number(count||0)>=1)return Response.json({error:'GRAMMAR_DAILY_LIMIT'},{status:429});
  const tier=await customerAdaptiveTier(customerId);const idx=Math.max(0,parseInt(String(body.scenario_id||'').split('-').pop()||'0',10)||0);const expected=grammarScenario(idx,tier);
  const answers=Array.isArray(body.answers)?body.answers:[];let correct=0;
  const review=expected.questions.map((q,i)=>{const ok=Number(answers[i])===q.answer;if(ok)correct++;return {correct:ok,correct_answer:q.options[q.answer],explanation:q.explanation};});
  const score=Math.round(correct/expected.questions.length*100);
  const feedback=score>=88?'Grammar rất ổn. Tiếp tục duy trì độ chính xác và chú ý các cấu trúc khó hơn.':score>=63?'Nền grammar khá ổn; xem lại các câu sai và ghi nhớ dấu hiệu thời gian/cấu trúc đi kèm.':'Nên ôn lại các cấu trúc cơ bản trong bộ hôm nay rồi thử áp dụng chúng vào câu nói ngắn.';
  const {data,error}=await supabase.from('grammar_tests').insert({customer_id:customerId,scenario_id:expected.scenario_id,tier,questions:expected.questions,answers,correct_count:correct,overall_score:score,feedback_vi:feedback,status:'COMPLETED'}).select('id,created_at').single();if(error)throw error;
  return Response.json({success:true,id:data.id,created_at:data.created_at,correct_count:correct,overall_score:score,feedback_vi:feedback,review});
}

async function getStreakSettings(){
  const {data,error}=await supabase.from('streak_settings').select('id,target_days,discount_percent,enabled,updated_at').eq('id',1).maybeSingle();
  if(error)throw error;
  return data||{id:1,target_days:10,discount_percent:10,enabled:true,updated_at:null};
}
function vnDateKeyFromISO(v){
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v))}catch{return ''}
}
async function streakCompletedDays(customerId){
  const tables=['progress_tests','pronunciation_tests','listening_tests','grammar_tests'];
  const sets=[];
  for(const table of tables){
    const {data,error}=await supabase.from(table).select('created_at').eq('customer_id',customerId).eq('status','COMPLETED').order('created_at',{ascending:false}).limit(500);
    if(error)throw error;
    sets.push(new Set((data||[]).map(x=>vnDateKeyFromISO(x.created_at)).filter(Boolean)));
  }
  if(!sets.length)return new Set();
  return new Set([...sets[0]].filter(day=>sets.slice(1).every(st=>st.has(day))));
}
function previousISODate(day){return addDaysISO(day,-1)}
async function ensureStreakReward(customerId,streak,settings){
  if(!settings.enabled||streak<Number(settings.target_days||10))return null;
  const target=Math.max(1,Number(settings.target_days||10));
  const milestone=Math.floor(streak/target)*target;
  const {data:existing,error:e1}=await supabase.from('streak_rewards').select('id,customer_id,milestone_days,discount_percent,voucher_code,status,created_at').eq('customer_id',customerId).eq('milestone_days',milestone).maybeSingle();
  if(e1)throw e1;
  if(existing)return existing;
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let suffix='';for(let i=0;i<6;i++)suffix+=alphabet[Math.floor(Math.random()*alphabet.length)];
  const voucher=`SH${Math.round(Number(settings.discount_percent||10))}-${suffix}`;
  const {data,error}=await supabase.from('streak_rewards').insert({customer_id:customerId,milestone_days:milestone,discount_percent:Number(settings.discount_percent||10),voucher_code:voucher,status:'ISSUED'}).select('id,customer_id,milestone_days,discount_percent,voucher_code,status,created_at').single();
  if(error)throw error;
  return data;
}
async function getStreakStatus(customerId){
  const settings=await getStreakSettings();
  const days=await streakCompletedDays(customerId);
  const today=vnDayBounds().ymd;
  let cursor=days.has(today)?today:previousISODate(today),streak=0;
  while(days.has(cursor)&&streak<1000){streak++;cursor=previousISODate(cursor)}
  const target=Math.max(1,Number(settings.target_days||10));
  const reward=await ensureStreakReward(customerId,streak,settings);
  let latestReward=reward;
  if(!latestReward){
    const {data,error}=await supabase.from('streak_rewards').select('id,milestone_days,discount_percent,voucher_code,status,created_at').eq('customer_id',customerId).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if(error)throw error;latestReward=data||null;
  }
  const cycleProgress=streak>0&&streak%target===0?target:(streak%target);
  const nextRewardAt=(Math.floor(streak/target)+1)*target;
  return {current_streak:streak,target_days:target,discount_percent:Number(settings.discount_percent||10),enabled:!!settings.enabled,today_complete:days.has(today),progress_to_reward:cycleProgress,next_reward_at:nextRewardAt,reward:latestReward};
}
async function handleStreakStatus(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  return Response.json({success:true,...await getStreakStatus(customerId)});
}
async function handleStreakSettings(request){
  if(request.method==='GET')return Response.json({success:true,settings:await getStreakSettings()});
  if(request.method==='POST'){
    const b=await request.json().catch(()=>({}));
    const target=Math.max(1,Math.min(365,Math.round(Number(b.target_days||10))));
    const pct=Math.max(1,Math.min(99,Number(b.discount_percent||10)));
    const enabled=b.enabled!==false;
    const {data,error}=await supabase.from('streak_settings').upsert({id:1,target_days:target,discount_percent:pct,enabled,updated_at:new Date().toISOString()},{onConflict:'id'}).select('id,target_days,discount_percent,enabled,updated_at').single();
    if(error)throw error;return Response.json({success:true,settings:data});
  }
  return Response.json({error:'Method not allowed'},{status:405});
}
async function handleDailyTestStatus(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const b=vnDayBounds();
  const countToday=async table=>{const {count,error}=await supabase.from(table).select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',b.start).lte('created_at',b.end);if(error)throw error;return Number(count||0)};
  const [progress,pronunciation,listening,grammar]=await Promise.all([countToday('progress_tests'),countToday('pronunciation_tests'),countToday('listening_tests'),countToday('grammar_tests')]);
  const sessions=await comprehensionStatusRows(customerId);
  const compRequired=sessions.length>0,compDone=compRequired&&!!sessions[0]?.done;
  return Response.json({success:true,date:b.ymd,progress:{done:progress>0},pronunciation:{done:pronunciation>0},listening:{done:listening>0},grammar:{done:grammar>0},comprehension:{required:compRequired,done:compDone},all_done:progress>0&&pronunciation>0&&listening>0&&grammar>0&&(!compRequired||compDone)});
}

async function handlePronunciationScore(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  if(!process.env.OPENAI_API_KEY)return Response.json({error:'OPENAI_API_KEY_MISSING'},{status:500});
  const fd=await request.formData();const customerId=String(fd.get('customer_id')||''),token=String(fd.get('token')||''),reference=String(fd.get('reference_text')||'').slice(0,5000),audio=fd.get('audio');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});const usage=await pronunciationUsage(customerId);if(usage.remaining<=0)return Response.json({error:'PRONUNCIATION_DAILY_LIMIT',usage},{status:429});if(!audio||typeof audio.arrayBuffer!=='function')return Response.json({error:'AUDIO_REQUIRED'},{status:400});
  const of=new FormData();of.append('file',audio,audio.name||'pronunciation.webm');of.append('model',process.env.OPENAI_TRANSCRIBE_MODEL||'gpt-4o-mini-transcribe');of.append('language','en');of.append('response_format','json');of.append('include[]','logprobs');of.append('prompt','Pronunciation assessment. Transcribe exactly what the learner says, including errors.');
  const tr=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:of});const td=await tr.json().catch(()=>({}));if(!tr.ok)throw new Error(td?.error?.message||'TRANSCRIPTION_FAILED');
  const conf=averageTranscriptionConfidence(td.logprobs);const schema={type:'object',additionalProperties:false,properties:{overall_score:{type:'integer',minimum:0,maximum:100},accuracy_score:{type:'integer',minimum:0,maximum:100},clarity_score:{type:'integer',minimum:0,maximum:100},stress_score:{type:'integer',minimum:0,maximum:100},fluency_score:{type:'integer',minimum:0,maximum:100},summary_vi:{type:'string'},improvements_vi:{type:'array',items:{type:'string'},minItems:2,maxItems:5}},required:['overall_score','accuracy_score','clarity_score','stress_score','fluency_score','summary_vi','improvements_vi']};
  const result=await v112AI(`You assess English pronunciation for SpeakHub. Compare REFERENCE with TRANSCRIPT. Transcription confidence is supporting evidence, not a perfect phonetic measurement. Be conservative: do not claim exact phoneme errors that cannot be inferred. Score intelligibility, word accuracy, likely stress/rhythm and fluency. Feedback is concise Vietnamese, with English examples when useful.\nREFERENCE: ${reference}\nTRANSCRIPT: ${String(td.text||'')}\nTRANSCRIPTION_CONFIDENCE: ${conf??'unknown'}`,schema,'speakhub_pronunciation_result');
  const {data:saved,error}=await supabase.from('pronunciation_tests').insert({customer_id:customerId,reference_text:reference,transcript:String(td.text||''),transcription_confidence:conf,...result,status:'COMPLETED',raw_result:result}).select('id,created_at').single();if(error)throw error;return Response.json({success:true,id:saved.id,created_at:saved.created_at,...result});
}
async function comprehensionStatusRows(customerId){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const {data,error}=await supabase.from('bookings').select(`id,status,session_id,class_sessions(id,session_date,ends_at,topic_title,programs(name))`).eq('user_id',customerId).in('status',['CONFIRMED','ATTENDED','NO_SHOW']).lte('class_sessions.session_date',today).order('created_at',{ascending:false}).limit(20);if(error)throw error;
  const vnNow=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh'}));const nowHM=`${String(vnNow.getHours()).padStart(2,'0')}:${String(vnNow.getMinutes()).padStart(2,'0')}`;
  const rows=(data||[]).filter(x=>{const cs=x.class_sessions;if(!cs?.id)return false;if(String(cs.session_date)<today)return true;if(String(cs.session_date)>today)return false;const end=String(cs.ends_at||'23:59').slice(0,5);return end<=nowHM;}).sort((a,b)=>String(b.class_sessions.session_date).localeCompare(String(a.class_sessions.session_date))).slice(0,3);
  const ids=rows.map(x=>x.session_id);let done=new Set();if(ids.length){const q=await supabase.from('comprehension_tests').select('session_id').eq('customer_id',customerId).in('session_id',ids).eq('status','COMPLETED');if(q.error)throw q.error;done=new Set((q.data||[]).map(x=>x.session_id))}
  return rows.map(x=>({id:x.session_id,booking_id:x.id,session_date:x.class_sessions.session_date,topic_title:x.class_sessions.topic_title||'English Session',program_name:x.class_sessions.programs?.name||'SpeakHub',done:done.has(x.session_id)}));
}
async function handleComprehensionStatus(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  return Response.json({success:true,sessions:await comprehensionStatusRows(customerId)});
}

async function comprehensionSession(customerId,sessionId,demo){
  const {data,error}=await supabase.from('bookings').select(`session_id,class_sessions(id,session_date,ends_at,topic_title,programs(name))`).eq('user_id',customerId).eq('session_id',sessionId).in('status',['CONFIRMED','ATTENDED','NO_SHOW']).maybeSingle();if(error)throw error;if(!data)return null;const cs=data.class_sessions||{};const vnNow=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh'}));const today=`${vnNow.getFullYear()}-${String(vnNow.getMonth()+1).padStart(2,'0')}-${String(vnNow.getDate()).padStart(2,'0')}`,nowHM=`${String(vnNow.getHours()).padStart(2,'0')}:${String(vnNow.getMinutes()).padStart(2,'0')}`;if(String(cs.session_date)>today||(String(cs.session_date)===today&&String(cs.ends_at||'23:59').slice(0,5)>nowHM))return null;return {session_id:sessionId,topic_title:cs.topic_title||'English Session',level:cs.programs?.name||'SpeakHub',demo:false};
}
async function handleComprehensionQuiz(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const b=await request.json().catch(()=>({})),customerId=String(b.customer_id||''),token=String(b.token||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const sess=await comprehensionSession(customerId,String(b.session_id||''),!!b.demo);if(!sess)return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  if(!sess.demo){
    const {data:existing,error:exErr}=await supabase.from('comprehension_tests').select('id,status,questions').eq('customer_id',customerId).eq('session_id',sess.session_id).maybeSingle();if(exErr)throw exErr;
    if(existing?.status==='COMPLETED')return Response.json({error:'COMPREHENSION_ALREADY_COMPLETED'},{status:409});
    if(existing?.status==='PENDING'&&Array.isArray(existing.questions)&&existing.questions.length)return Response.json({success:true,...sess,tier:await customerAdaptiveTier(customerId,sess.level),questions:existing.questions});
  }
  const tier=await customerAdaptiveTier(customerId,sess.level);
  const {count}=await supabase.from('comprehension_tests').select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED');
  const templates=[
    'main idea and one practical example',
    'cause and effect in the topic',
    'one benefit and one possible problem',
    'a personal application of the topic',
    'a comparison between two viewpoints',
    'one recommendation and the reason behind it',
    'a situation where the idea becomes difficult',
    'one misunderstanding people may have about the topic',
    'a real-life example connected with the topic',
    'one change the learner would make after the discussion',
    'the strongest reason supporting one side',
    'one consequence if people ignore the issue'
  ];
  const template=templates[(count||0)%templates.length];
  const schema={type:'object',additionalProperties:false,properties:{questions:{type:'array',minItems:4,maxItems:5,items:{type:'object',additionalProperties:false,properties:{prompt:{type:'string'},word:{type:['string','null']},visual:{type:['string','null']}},required:['prompt','word','visual']}}},required:['questions']};
  const q=await v112AI(`Create a short post-session comprehension check for topic: "${sess.topic_title}". Program: ${sess.level}. Learner tier: ${tier}. Difficulty: ${adaptiveDifficultyLabel(tier)}. This test cycle focus is: ${template}. Create 2-3 topic-understanding questions and exactly 2 vocabulary items. Vocabulary items must ask the learner to explain the word in English, not translate it. For youngKid, use very common concrete vocabulary and add a helpful emoji in visual for every question; for teenKid, visual may be an emoji when useful; for Beginner use practical vocabulary; for Intermediate use richer topic vocabulary and require reasons/examples. Do not test obscure facts. Avoid generic repeated wording and vary the question structure.`,schema,'speakhub_comprehension_quiz');
  if(!sess.demo){const {error}=await supabase.from('comprehension_tests').upsert({customer_id:customerId,session_id:sess.session_id,topic_title:sess.topic_title,program_name:sess.level,questions:q.questions,answers:[],status:'PENDING',raw_result:{tier,template}},{onConflict:'customer_id,session_id'});if(error)throw error}
  return Response.json({success:true,...sess,tier,questions:q.questions});
}

async function handleComprehensionScore(request){
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});const b=await request.json().catch(()=>({})),customerId=String(b.customer_id||''),token=String(b.token||'');const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});const sess=await comprehensionSession(customerId,String(b.session_id||''),!!b.demo);if(!sess)return Response.json({error:'SESSION_NOT_FOUND'},{status:404});
  if(!sess.demo){const {data:done,error:doneErr}=await supabase.from('comprehension_tests').select('id').eq('customer_id',customerId).eq('session_id',sess.session_id).eq('status','COMPLETED').maybeSingle();if(doneErr)throw doneErr;if(done)return Response.json({error:'COMPREHENSION_ALREADY_COMPLETED'},{status:409});}
  const schema={type:'object',additionalProperties:false,properties:{overall_score:{type:'integer',minimum:0,maximum:100},topic_understanding_score:{type:'integer',minimum:0,maximum:100},vocabulary_score:{type:'integer',minimum:0,maximum:100},summary_vi:{type:'string'},feedback_vi:{type:'array',items:{type:'string'},minItems:2,maxItems:5}},required:['overall_score','topic_understanding_score','vocabulary_score','summary_vi','feedback_vi']};const result=await v112AI(`Assess this learner's comprehension of an English speaking session. Topic: ${sess.topic_title}. Level: ${sess.level}. Reward understanding and ability to explain vocabulary in English. For Kid level, be encouraging and forgiving; Beginner normal/simple; Intermediate expect clearer reasoning and richer English. Questions/answers: ${JSON.stringify(b.answers||[])}`,schema,'speakhub_comprehension_result');
  if(!sess.demo){const tier=await customerAdaptiveTier(customerId,sess.level);const {data:existing,error:findErr}=await supabase.from('comprehension_tests').select('id,status').eq('customer_id',customerId).eq('session_id',sess.session_id).maybeSingle();if(findErr)throw findErr;if(existing?.status==='COMPLETED')return Response.json({error:'COMPREHENSION_ALREADY_COMPLETED'},{status:409});const row={customer_id:customerId,session_id:sess.session_id,topic_title:sess.topic_title,program_name:sess.level,questions:b.questions||[],answers:b.answers||[],...result,status:'COMPLETED',raw_result:{...result,tier}};let error;if(existing?.id){({error}=await supabase.from('comprehension_tests').update(row).eq('id',existing.id))}else{({error}=await supabase.from('comprehension_tests').insert(row))}if(error)throw error}return Response.json({success:true,...result});
}
function weekStartVN(){const now=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh'}));const d=now.getDay()||7;now.setDate(now.getDate()-d+1);return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T00:00:00+07:00`}
async function handleRecentTestHistory(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
  const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');
  const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});
  const [progress,pronunciation,comprehension]=await Promise.all([
    supabase.from('progress_tests').select('id,created_at,program_name,topic_title,overall_score,summary_vi,improvements_vi,speaking_feedback_vi,recommended_study_focus_vi').eq('customer_id',customerId).eq('status','COMPLETED').order('created_at',{ascending:false}).limit(3),
    supabase.from('pronunciation_tests').select('id,created_at,overall_score,summary_vi,improvements_vi').eq('customer_id',customerId).eq('status','COMPLETED').order('created_at',{ascending:false}).limit(3),
    supabase.from('comprehension_tests').select('id,created_at,program_name,topic_title,overall_score,summary_vi,feedback_vi').eq('customer_id',customerId).eq('status','COMPLETED').order('created_at',{ascending:false}).limit(3)
  ]);
  for(const q of [progress,pronunciation,comprehension])if(q.error)throw q.error;
  const rows=[
    ...(progress.data||[]).map(x=>({...x,type:'PROGRESS'})),
    ...(pronunciation.data||[]).map(x=>({...x,type:'PRONUNCIATION',program_name:'Pronunciation'})),
    ...(comprehension.data||[]).map(x=>({...x,type:'COMPREHENSION'}))
  ].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,3);
  return Response.json({success:true,tests:rows});
}

async function handleTestDashboard(request){
  if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});const u=new URL(request.url),customerId=String(u.searchParams.get('customer_id')||''),token=String(u.searchParams.get('token')||'');const auth=await requireActiveCustomer(customerId,token);if(auth.error)return Response.json({error:auth.error},{status:auth.status});const ws=weekStartVN();
  async function counts(table){const [a,w]=await Promise.all([supabase.from(table).select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED'),supabase.from(table).select('*',{count:'exact',head:true}).eq('customer_id',customerId).eq('status','COMPLETED').gte('created_at',ws)]);if(a.error)throw a.error;if(w.error)throw w.error;return {all:a.count||0,week:w.count||0}}
  const [placement,progress,pronunciation,listening,grammar,comprehension]=await Promise.all([counts('placement_tests'),counts('progress_tests'),counts('pronunciation_tests'),counts('listening_tests'),counts('grammar_tests'),counts('comprehension_tests')]);return Response.json({success:true,placement,progress,pronunciation,listening,grammar,comprehension});
}

export default {
  async fetch(request){
    try{
      const url=new URL(request.url);
      const action=url.searchParams.get('action')||'';

      if(action==='login'){
        return await handleLogin(request);
      }

      if(action==='supporter-login') return await handleSupporterLogin(request);
      if(action.startsWith('supporter-')&&action!=='supporter-login'){
        const supporter=requireSupporter(request);
        if(!supporter)return Response.json({error:'UNAUTHORIZED'},{status:401});
        const scopedRequest=supporterScopedRequest(request,supporter.branch);
        if(action==='supporter-sessions') return await handleSupporterSessions(scopedRequest);
        if(action==='supporter-registration-sessions') return await handleSupporterRegistrationSessions(scopedRequest);
        if(action==='supporter-student-schedule') return await handleStudentSchedule(scopedRequest);
        if(action==='supporter-chat') return await runAdminActionWithRetry(()=>handleAdminChat(scopedRequest));
        if(action==='supporter-reminders') return await runAdminActionWithRetry(()=>handleReminders(scopedRequest));
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
      if(action==='pronunciation-prompt') return await handlePronunciationPrompt(request);
      if(action==='pronunciation-score') return await handlePronunciationScore(request);
      if(action==='listening-prompt') return await handleListeningPrompt(request);
      if(action==='listening-score') return await handleListeningScore(request);
      if(action==='grammar-prompt') return await handleGrammarPrompt(request);
      if(action==='grammar-score') return await handleGrammarScore(request);
      if(action==='daily-test-status') return await handleDailyTestStatus(request);
      if(action==='streak-status') return await handleStreakStatus(request);
      if(action==='comprehension-status') return await handleComprehensionStatus(request);
      if(action==='comprehension-quiz') return await handleComprehensionQuiz(request);
      if(action==='comprehension-score') return await handleComprehensionScore(request);
      if(action==='test-dashboard') return await handleTestDashboard(request);
      if(action==='test-recent-history') return await handleRecentTestHistory(request);
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
      if(action==='publisher-login') return await handlePublisherLogin(request);
      if(action==='publisher-report') return await handlePublisherPortal(request);
      if(action==='publisher-track') return await handlePublisherTrack(request);

      // Public read-only price config used by landing page and booking UI.
      // No admin secret is exposed; only landing_price + tiers are returned.
      if(action==='public-price') return await runAdminActionWithRetry(()=>handlePublicPrice());
      if(action==='public-discounts') return await runAdminActionWithRetry(()=>handlePublicDateDiscounts());

      if(!requireAdmin(request)){
        return Response.json({error:'UNAUTHORIZED'},{status:401});
      }

      if(action==='overview') return await runAdminActionWithRetry(()=>handleOverview(request));
      if(action==='reminders') return await runAdminActionWithRetry(()=>handleReminders(request));
      if(action==='discounts') return await runAdminActionWithRetry(()=>handleDateDiscounts(request));
      if(action==='streak-settings') return await runAdminActionWithRetry(()=>handleStreakSettings(request));
      if(action==='price') return await runAdminActionWithRetry(()=>handlePrice(request));
      if(action==='sessions') return await runAdminActionWithRetry(()=>handleSessions(request));
      if(action==='customer-search') return await runAdminActionWithRetry(()=>handleCustomerSearch(request));
      if(action==='student-schedule') return await runAdminActionWithRetry(()=>handleStudentSchedule(request));
      if(action==='customers') return await runAdminActionWithRetry(()=>handleCustomers(request));
      if(action==='bookings') return await runAdminActionWithRetry(()=>handleBookings(request));
      if(action==='teacher-users') return await runAdminActionWithRetry(()=>handleTeacherUsers(request));
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
      if(action==='topic-upload-init') return await runAdminActionWithRetry(()=>handleTopicUploadInit(request));
      if(action==='topic-upload-finalize') return await runAdminActionWithRetry(()=>handleTopicUploadFinalize(request));
      if(action==='topic-upload') return await runAdminActionWithRetry(()=>handleTopicUpload(request));
      if(action==='topic-page-upload') return await runAdminActionWithRetry(()=>handleTopicPageUpload(request));
      if(action==='topic-delete') return await runAdminActionWithRetry(()=>handleTopicDelete(request));
      if(action==='admin-chat') return await runAdminActionWithRetry(()=>handleAdminChat(request));
      if(action==='publishers') return await runAdminActionWithRetry(()=>handlePublisherAdmin(request));

      return Response.json({error:'UNKNOWN_ACTION'},{status:404});
    }catch(err){
      console.error('admin api error',err);
      return Response.json(
        {
          error:'ADMIN_API_ERROR',
          details:String(err?.message||err),
          code:String(err?.code||''),
          hint:String(err?.hint||'')
        },
        {status:500}
      );
    }
  }
};
