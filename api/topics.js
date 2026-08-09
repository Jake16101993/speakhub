import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession:false, autoRefreshToken:false } }
);

async function verifyCustomerAndBooking(url){
  const customerId=url.searchParams.get('customer_id');
  const token=url.searchParams.get('token');
  const bookingId=url.searchParams.get('booking_id');

  if(!customerId||!token||!bookingId){
    return {error:Response.json({error:'MISSING_FIELDS'},{status:400})};
  }

  const {data:customer,error:customerErr}=await supabase
    .from('customers')
    .select('id,status')
    .eq('id',customerId)
    .eq('device_token',token)
    .maybeSingle();

  if(customerErr) throw customerErr;
  if(!customer){
    return {error:Response.json({error:'INVALID_CUSTOMER_TOKEN'},{status:401})};
  }
  if(customer.status!=='ACTIVE'){
    return {error:Response.json({error:'CUSTOMER_NOT_ACTIVE'},{status:403})};
  }

  const {data:booking,error:bookingErr}=await supabase
    .from('bookings')
    .select(`
      id,status,
      orders!inner(payment_status,order_status),
      class_sessions(topic_title,topic_storage_path)
    `)
    .eq('id',bookingId)
    .eq('user_id',customerId)
    .eq('status','CONFIRMED')
    .eq('orders.payment_status','PAID')
    .eq('orders.order_status','CONFIRMED')
    .maybeSingle();

  if(bookingErr) throw bookingErr;
  if(!booking){
    return {error:Response.json({error:'BOOKING_NOT_ELIGIBLE'},{status:403})};
  }

  return {booking};
}

async function handleOpen(request,url){
  if(request.method!=='GET'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const result=await verifyCustomerAndBooking(url);
  if(result.error) return result.error;

  const session=result.booking.class_sessions||{};
  const path=String(session.topic_storage_path||'').trim();

  if(!path){
    return Response.json({error:'TOPIC_NOT_READY'},{status:404});
  }

  const {data:signed,error:signedErr}=await supabase
    .storage
    .from('topics')
    .createSignedUrl(path,600);

  if(signedErr) throw signedErr;

  return Response.json({
    title:session.topic_title||'SpeakHub Topic',
    signed_url:signed.signedUrl,
    expires_in:600
  });
}

async function handleFile(request,url){
  if(request.method!=='GET'){
    return Response.json({error:'Method not allowed'},{status:405});
  }

  const result=await verifyCustomerAndBooking(url);
  if(result.error) return result.error;

  const session=result.booking.class_sessions||{};
  const path=String(session.topic_storage_path||'').trim();

  if(!path){
    return Response.json({error:'TOPIC_NOT_READY'},{status:404});
  }

  const {data:file,error:fileErr}=await supabase
    .storage
    .from('topics')
    .download(path);

  if(fileErr) throw fileErr;

  const bytes=await file.arrayBuffer();

  return new Response(bytes,{
    status:200,
    headers:{
      'Content-Type':'application/pdf',
      'Content-Disposition':'inline',
      'Cache-Control':'private, no-store',
      'X-Content-Type-Options':'nosniff'
    }
  });
}

export default {
  async fetch(request){
    try{
      const url=new URL(request.url);
      const action=url.searchParams.get('action')||'';

      if(action==='open') return await handleOpen(request,url);
      if(action==='file') return await handleFile(request,url);

      return Response.json({error:'UNKNOWN_ACTION'},{status:404});
    }catch(err){
      console.error('topics api error',err);
      return Response.json(
        {error:'TOPICS_API_FAILED',details:String(err?.message||err)},
        {status:500}
      );
    }
  }
};
