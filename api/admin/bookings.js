import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_auth.js';
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

export default {
 async fetch(request){
  if(!requireAdmin(request)) return Response.json({error:'UNAUTHORIZED'},{status:401});
  const {data,error}=await supabase.from('bookings').select(`
    id,status,created_at,
    customers:user_id(full_name,phone),
    orders!inner(payment_status,order_status),
    class_sessions(session_date,starts_at,ends_at,programs(name))
  `).eq('status','CONFIRMED').eq('orders.payment_status','PAID').order('created_at',{ascending:false}).limit(500);
  if(error) return Response.json({error:error.message},{status:500});
  return Response.json({bookings:(data||[]).map(x=>({
    id:x.id,full_name:x.customers?.full_name||'',phone:x.customers?.phone||'',payment_status:x.orders?.payment_status||'',
    session_date:x.class_sessions?.session_date||'',starts_at:x.class_sessions?.starts_at||'',ends_at:x.class_sessions?.ends_at||'',
    program_name:x.class_sessions?.programs?.name||''
  }))});
 }
};
