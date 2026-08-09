import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../_auth.js';
const supabase=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

function slug(s){
  return String(s||'topic').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'topic';
}
export default {
 async fetch(request){
  if(!requireAdmin(request)) return Response.json({error:'UNAUTHORIZED'},{status:401});
  if(request.method!=='POST') return Response.json({error:'Method not allowed'},{status:405});
  try{
    const fd=await request.formData();
    const sessionId=String(fd.get('session_id')||'');
    const title=String(fd.get('title')||'').trim();
    const file=fd.get('file');
    if(!sessionId||!file) return Response.json({error:'MISSING_FIELDS'},{status:400});
    if(file.type && file.type!=='application/pdf') return Response.json({error:'PDF_ONLY'},{status:400});

    const {data:session,error:sErr}=await supabase.from('class_sessions').select('session_date,programs(name)').eq('id',sessionId).maybeSingle();
    if(sErr) throw sErr;
    if(!session) return Response.json({error:'SESSION_NOT_FOUND'},{status:404});

    const path=`${session.session_date}-${slug(session.programs?.name)}-${slug(title||file.name)}.pdf`;
    const bytes=await file.arrayBuffer();
    const {error:uErr}=await supabase.storage.from('topics').upload(path,bytes,{contentType:'application/pdf',upsert:true});
    if(uErr) throw uErr;

    const {error:updateErr}=await supabase.from('class_sessions').update({topic_title:title||file.name.replace(/\.pdf$/i,''),topic_storage_path:path}).eq('id',sessionId);
    if(updateErr) throw updateErr;

    return Response.json({success:true,path});
  }catch(e){
    console.error(e);
    return Response.json({error:'TOPIC_UPLOAD_FAILED',details:String(e?.message||e)},{status:500});
  }
 }
};
