import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from './_auth.js';
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

export default {
 async fetch(request){
  if(!requireAdmin(request)) return Response.json({error:'UNAUTHORIZED'},{status:401});
  const {data,error}=await supabase.from('customers').select('id,full_name,phone,status,created_at').order('created_at',{ascending:false}).limit(500);
  if(error) return Response.json({error:error.message},{status:500});
  return Response.json({customers:data||[]});
 }
};
