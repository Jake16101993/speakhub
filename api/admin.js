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
      {data:teachers,error:tErr},
      {data:sessions,error:sErr}
    ]=await Promise.all([
      supabase.from('programs').select('id,code,name').order('name'),
      supabase.from('rooms').select('id,name,location_id').order('name'),
      supabase.from('teachers').select('id,full_name,country,is_active').eq('is_active',true).order('full_name'),
      supabase.from('class_sessions').select(`
        id,session_date,session_period,starts_at,ends_at,capacity,status,is_recurring,recurrence_source_id,
        teacher_id,topic_title,topic_storage_path,
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
  const weekStart=startOfCurrentWeekISO();
  const {count,error}=await supabase
    .from('placement_tests')
    .select('*',{count:'exact',head:true})
    .eq('customer_id',customerId)
    .gte('created_at',weekStart)
    .eq('status','COMPLETED');

  if(error) throw error;
  const used=Number(count||0);
  return {used,remaining:999,unlimited:true,week_start:weekStart};
}

async function handlePlacementStatus(request){
  if(request.method!=='GET'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const url=new URL(request.url);
  const customerId=url.searchParams.get('customer_id');
  const token=url.searchParams.get('token');

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  return Response.json(await placementUsage(customerId));
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
  const audio=fd.get('audio');

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  // TEST MODE: weekly placement limit temporarily disabled.
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
  if(request.method!=='POST'){
    return Response.json({error:'Method not allowed'},{status:405});
  }
  if(!process.env.OPENAI_API_KEY){
    return Response.json({error:'OPENAI_API_KEY_MISSING'},{status:500});
  }

  const b=await request.json().catch(()=>({}));
  const customerId=String(b.customer_id||'');
  const token=String(b.token||'');

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  // TEST MODE: weekly placement limit temporarily disabled.
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

  const allowedByAge=age<=9
    ? ['Kid Starter','Kid Communicator']
    : age<=14
      ? ['Kid Starter','Kid Communicator','Adult Beginner']
      : ['Adult Beginner','Adult Intermediate'];

  const prompt=`You are the SpeakHub English Placement Assessor.

Evaluate a learner for an OFFLINE English speaking club. Be consistent, practical, and supportive.
This is NOT an IELTS/academic English exam. The goal is to place learners into a speaking club where they can participate comfortably and improve.

AGE: ${age}
ALLOWED PROGRAMS FOR THIS AGE: ${allowedByAge.join(', ')}

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
    result.recommended_program_name=age<=14?'Kid Communicator':'Adult Beginner';
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
    customer_id:customerId,
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

  return Response.json({
    success:true,
    placement_test_id:saved.id,
    created_at:saved.created_at,
    program_id:program?.id||null,
    ...result,
    usage:await placementUsage(customerId)
  });
}


async function handlePlacementHistory(request){
  if(request.method!=='GET'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const url=new URL(request.url);
  const customerId=url.searchParams.get('customer_id');
  const token=url.searchParams.get('token');

  const auth=await requireActiveCustomer(customerId,token);
  if(auth.error) return Response.json({error:auth.error},{status:auth.status});

  const {data,error}=await supabase
    .from('placement_tests')
    .select(`
      id,created_at,birth_year,age_at_test,reading_score,
      grammar_score,vocabulary_score,fluency_score,pronunciation_score,
      comprehension_score,overall_score,cefr_estimate,
      recommended_program_id,recommended_program_name,ai_confidence,
      summary_vi,strengths_vi,improvements_vi,grammar_examples,raw_result,status
    `)
    .eq('customer_id',customerId)
    .eq('status','COMPLETED')
    .order('created_at',{ascending:false})
    .limit(30);

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
