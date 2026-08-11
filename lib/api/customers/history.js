import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

function normalizePhone(value){
  const digits=String(value||'').replace(/\D/g,'');
  return digits ? digits.slice(-9) : '';
}

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
      const url = new URL(request.url);
      const customerId = url.searchParams.get('customer_id');
      const token = url.searchParams.get('token');

      if (!customerId || !token) {
        return Response.json({ error: 'CUSTOMER_TOKEN_REQUIRED' }, { status: 401 });
      }

      const { data: customer, error: customerErr } = await supabase
        .from('customers')
        .select('id,status,phone')
        .eq('id', customerId)
        .eq('device_token', token)
        .maybeSingle();

      if (customerErr) throw customerErr;
      if (!customer) {
        return Response.json({ error: 'INVALID_CUSTOMER_TOKEN' }, { status: 401 });
      }
      if (customer.status !== 'ACTIVE') {
        return Response.json({ error: 'CUSTOMER_NOT_ACTIVE' }, { status: 403 });
      }

      const normalizedCustomerPhone=normalizePhone(customer.phone);

      // Fetch all PAID + CONFIRMED bookings first.
      // Then identify ownership using BOTH booking.user_id and order.user_id.
      // Manual/admin bookings can have one of those IDs different from the login customer.
      const { data: rawBookings, error } = await supabase
        .from('bookings')
        .select(`
          id,user_id,status,confirmed_at,created_at,
          orders!inner(
            id,user_id,order_code,payment_status,order_status,
            reschedule_limit,reschedule_used
          ),
          class_sessions(
            id,session_date,session_period,starts_at,ends_at,topic_title,topic_storage_path,topic_vocabulary,
            programs(name,code),
            rooms(name),
            teachers(full_name,country),
            locations(name,district)
          )
        `)
        .eq('status','CONFIRMED')
        .eq('orders.payment_status','PAID')
        .order('session_date',{ referencedTable:'class_sessions', ascending:true })
        .limit(2000);

      if (error) throw error;

      // Collect every customer ID referenced by the paid bookings so phone
      // matching does not depend on an embedded FK relationship.
      const referencedIds=[...new Set(
        (rawBookings||[]).flatMap(b=>[
          b.user_id,
          b.orders?.user_id
        ]).filter(Boolean)
      )];

      const phoneByCustomerId={};
      if(referencedIds.length){
        const { data: referencedCustomers, error: referencedCustomersErr } = await supabase
          .from('customers')
          .select('id,phone')
          .in('id',referencedIds);

        if(referencedCustomersErr) throw referencedCustomersErr;

        for(const c of referencedCustomers||[]){
          phoneByCustomerId[c.id]=normalizePhone(c.phone);
        }
      }

      const bookings=(rawBookings||[]).filter(booking=>{
        const bookingUserId=String(booking.user_id||'');
        const orderUserId=String(booking.orders?.user_id||'');

        if(bookingUserId===String(customerId) || orderUserId===String(customerId)){
          return true;
        }

        if(!normalizedCustomerPhone) return false;

        return (
          phoneByCustomerId[booking.user_id]===normalizedCustomerPhone ||
          phoneByCustomerId[booking.orders?.user_id]===normalizedCustomerPhone
        );
      });

      console.log('CUSTOMER_HISTORY_DIAG',{
        customer_id:customerId,
        customer_phone_tail:normalizedCustomerPhone,
        raw_paid_confirmed:(rawBookings||[]).length,
        matched:bookings.length,
        matched_sessions:bookings.map(b=>b.class_sessions?.session_date).filter(Boolean),
        candidates:(rawBookings||[]).map(b=>({
          session_date:b.class_sessions?.session_date||null,
          booking_id:b.id,
          booking_user_id:b.user_id||null,
          order_user_id:b.orders?.user_id||null,
          booking_phone_tail:phoneByCustomerId[b.user_id]||null,
          order_phone_tail:phoneByCustomerId[b.orders?.user_id]||null,
          payment_status:b.orders?.payment_status||null,
          order_status:b.orders?.order_status||null
        }))
      });

      const now = new Date();
      const upcoming = [];
      const completed = [];

      for (const booking of bookings || []) {
        const s = booking.class_sessions;
        if (!s) continue;

        const start = new Date(`${s.session_date}T${String(s.starts_at).slice(0,8)}+07:00`);
        const order = booking.orders || {};
        const remaining = Math.max(
          0,
          Number(order.reschedule_limit || 0) - Number(order.reschedule_used || 0)
        );

        const row = { ...booking, remaining_reschedules: remaining };

        if (start.getTime() >= now.getTime()) upcoming.push(row);
        else completed.push(row);
      }

      completed.sort((a,b) => {
        const sa = a.class_sessions;
        const sb = b.class_sessions;
        return `${sb.session_date} ${sb.starts_at}`.localeCompare(`${sa.session_date} ${sa.starts_at}`);
      });

      return new Response(JSON.stringify({
        upcoming,
        completed,
        _history_meta:{
          matched_paid_confirmed_bookings:bookings.length,
          matched_sessions:bookings.map(b=>b.class_sessions?.session_date).filter(Boolean)
        }
      }),{
        status:200,
        headers:{
          'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store, no-cache, must-revalidate'
        }
      });
    } catch (err) {
      console.error('customer history error', err);
      return Response.json(
        { error: 'HISTORY_FAILED', details: String(err?.message || err) },
        { status: 500 }
      );
    }
  }
};
