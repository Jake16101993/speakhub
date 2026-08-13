import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession:false, autoRefreshToken:false } }
);

function validPhone(phone){
  return /^0\d{9}$/.test(String(phone||'').trim());
}

function publicCustomer(c){
  return {
    id:c.id,
    phone:c.phone,
    full_name:c.full_name,
    device_token:c.device_token
  };
}

async function findCustomer(phone){
  const {data,error}=await supabase
    .from('customers')
    .select('id,phone,full_name,status,device_token')
    .eq('phone',phone)
    .maybeSingle();

  if(error) throw error;
  return data||null;
}

async function createCustomerForPhone(phone){
  // customers.id is tied to an auth user in the current SpeakHub production schema,
  // so create a passwordless/internal auth identity first.
  const email=`login-${phone}-${crypto.randomBytes(6).toString('hex')}@speakhub.local`;

  const {data:authData,error:authErr}=await supabase.auth.admin.createUser({
    email,
    email_confirm:true,
    user_metadata:{
      phone,
      full_name:'Học viên SpeakHub',
      source:'AUTO_PHONE_LOGIN'
    }
  });

  if(authErr) throw authErr;

  const userId=authData?.user?.id;
  if(!userId) throw new Error('AUTO_AUTH_USER_CREATE_FAILED');

  try{
    const {data:created,error:createErr}=await supabase
      .from('customers')
      .insert({
        id:userId,
        phone,
        full_name:'Học viên SpeakHub',
        status:'ACTIVE'
      })
      .select('id,phone,full_name,status,device_token')
      .single();

    if(createErr) throw createErr;
    return created;
  }catch(err){
    // Race-safe: if two requests create the same phone at almost the same time,
    // keep the first customer and remove the orphan auth identity from this request.
    const existing=await findCustomer(phone).catch(()=>null);

    if(existing){
      try{ await supabase.auth.admin.deleteUser(userId); }catch{}
      return existing;
    }

    // No customer survived; clean up the internal auth user before surfacing the error.
    try{ await supabase.auth.admin.deleteUser(userId); }catch{}
    throw err;
  }
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

      let customer=await findCustomer(phone);
      let created=false;

      if(!customer){
        customer=await createCustomerForPhone(phone);
        created=true;
      }

      // Never silently revive a deliberately disabled account.
      if(customer.status !== 'ACTIVE'){
        return Response.json({error:'CUSTOMER_NOT_ACTIVE'},{status:403});
      }

      return Response.json({
        success:true,
        created,
        customer:publicCustomer(customer)
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
