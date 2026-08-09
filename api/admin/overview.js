import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_auth.js';
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

export default {
 async fetch(request){
  if(!requireAdmin(request)) return Response.json({error:'UNAUTHORIZED'},{status:401});
  const [c,o,b,s]=await Promise.all([
   supabase.from('customers').select('*',{count:'exact',head:true}),
   supabase.from('orders').select('*',{count:'exact',head:true}).eq('payment_status','PAID'),
   supabase.from('bookings').select('*',{count:'exact',head:true}).eq('status','CONFIRMED'),
   supabase.from('class_sessions').select('*',{count:'exact',head:true}).eq('status','OPEN')
  ]);
  return Response.json({counts:{customers:c.count||0,paid_orders:o.count||0,confirmed_bookings:b.count||0,open_sessions:s.count||0}});
 }
};
