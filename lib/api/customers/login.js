import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession:false, autoRefreshToken:false } }
);

function validPhone(phone){
  return /^0\d{9}$/.test(String(phone||'').trim());
}

export default {
  async fetch(request){
    if(request.method !== 'POST'){
      return Response.json({error:'Method not allowed'},{status:405});
    }

    try{
      const body=await request.json().catch(()=>({}));
      const phone=String(body?.phone||'').trim();

      if(!validPhone(phone)){
        return Response.json({error:'INVALID_PHONE'},{status:400});
      }

      const {data:customer,error}=await supabase
        .from('customers')
        .select('id,phone,full_name,status,device_token')
        .eq('phone',phone)
        .maybeSingle();

      if(error) throw error;

      if(!customer){
        return Response.json({error:'CUSTOMER_NOT_FOUND'},{status:404});
      }

      if(customer.status !== 'ACTIVE'){
        return Response.json({error:'CUSTOMER_NOT_ACTIVE'},{status:403});
      }

      return Response.json({
        success:true,
        customer:{
          id:customer.id,
          phone:customer.phone,
          full_name:customer.full_name,
          device_token:customer.device_token
        }
      });
    }catch(err){
      console.error('customer login error',err);
      return Response.json(
        {error:'LOGIN_INTERNAL_ERROR',details:String(err?.message||err)},
        {status:500}
      );
    }
  }
};
