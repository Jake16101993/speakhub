import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession:false, autoRefreshToken:false } }
);

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json({error:'Method not allowed'},{status:405});
    }

    try {
      const body = await request.json();
      const customerId = body?.customer_id;
      const token = body?.token;
      const bookingId = body?.booking_id;
      const newSessionId = body?.new_session_id;

      if (!customerId || !token || !bookingId || !newSessionId) {
        return Response.json({error:'MISSING_FIELDS'},{status:400});
      }

      const {data: customer,error:customerErr} = await supabase
        .from('customers')
        .select('id,status')
        .eq('id',customerId)
        .eq('device_token',token)
        .maybeSingle();

      if (customerErr) throw customerErr;
      if (!customer) return Response.json({error:'INVALID_CUSTOMER_TOKEN'},{status:401});
      if (customer.status !== 'ACTIVE') return Response.json({error:'CUSTOMER_NOT_ACTIVE'},{status:403});

      const {data,error} = await supabase.rpc('reschedule_booking',{
        p_customer_id:customerId,
        p_booking_id:bookingId,
        p_new_session_id:newSessionId
      });

      if (error) {
        const msg=String(error.message||'');
        const known=[
          'BOOKING_NOT_FOUND','BOOKING_NOT_CONFIRMED','ORDER_NOT_PAID',
          'RESCHEDULE_LIMIT_REACHED','RESCHEDULE_TOO_LATE','OLD_SESSION_NOT_FOUND',
          'NEW_SESSION_NOT_FOUND','SAME_SESSION','PROGRAM_MISMATCH',
          'NEW_SESSION_NOT_OPEN','NEW_SESSION_ALREADY_STARTED',
          'DUPLICATE_BOOKING','NEW_SESSION_FULL'
        ];
        const code=known.find(x=>msg.includes(x))||'RESCHEDULE_FAILED';
        return Response.json({error:code,details:msg},{status:400});
      }

      return Response.json({success:true,result:data});
    } catch (err) {
      console.error('reschedule error',err);
      return Response.json(
        {error:'RESCHEDULE_INTERNAL_ERROR',details:String(err?.message||err)},
        {status:500}
      );
    }
  }
};
