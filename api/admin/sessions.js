import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_auth.js';
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

export default {
 async fetch(request){
  if(!requireAdmin(request)) return Response.json({error:'UNAUTHORIZED'},{status:401});
  if(request.method==='GET'){
    const [{data:programs,error:pErr},{data:rooms,error:rErr},{data:sessions,error:sErr}]=await Promise.all([
      supabase.from('programs').select('id,code,name').order('name'),
      supabase.from('rooms').select('id,name').order('name'),
      supabase.from('class_sessions').select(`
        id,session_date,session_period,starts_at,ends_at,capacity,status,teacher_name,teacher_country,topic_title,topic_storage_path,
        programs(name),rooms(name)
      `).order('session_date',{ascending:false}).limit(200)
    ]);
    if(pErr||rErr||sErr) throw (pErr||rErr||sErr);
    const ids=(sessions||[]).map(x=>x.id);
    let counts={};
    if(ids.length){
      const {data:bs}=await supabase.from('bookings').select('session_id,status').in('session_id',ids).eq('status','CONFIRMED');
      (bs||[]).forEach(x=>counts[x.session_id]=(counts[x.session_id]||0)+1);
    }
    return Response.json({programs,rooms,sessions:(sessions||[]).map(x=>({...x,program_name:x.programs?.name||'',room_name:x.rooms?.name||'',booked_count:counts[x.id]||0}))});
  }
  if(request.method==='POST'){
    const b=await request.json();
    const {data,error}=await supabase.from('class_sessions').insert({
      program_id:b.program_id,session_date:b.session_date,session_period:b.session_period,starts_at:b.starts_at,ends_at:b.ends_at,
      room_id:b.room_id,teacher_name:b.teacher_name||null,teacher_country:b.teacher_country||null,capacity:Number(b.capacity||10),status:'OPEN'
    }).select('id').single();
    if(error) return Response.json({error:error.message},{status:400});
    return Response.json({success:true,id:data.id},{status:201});
  }
  return Response.json({error:'Method not allowed'},{status:405});
 }
};
