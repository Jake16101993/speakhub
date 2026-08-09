import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
      const url = new URL(request.url);
      const orderId = url.searchParams.get('order_id');
      const token = url.searchParams.get('token');

      if (!orderId || !token) {
        return Response.json({ error: 'ORDER_TOKEN_REQUIRED' }, { status: 400 });
      }

      const { data: order, error } = await supabase
        .from('orders')
        .select(`
          id,order_code,session_count,unit_price,total_amount,
          payment_status,order_status,expires_at,paid_at,reschedule_limit,reschedule_used,
          bookings(
            id,status,
            class_sessions(
              id,session_date,session_period,starts_at,ends_at,
              programs(name,code),
              rooms(name),
              teachers(full_name,country),
              locations(name,district)
            )
          )
        `)
        .eq('id', orderId)
        .eq('checkout_token', token)
        .maybeSingle();

      if (error) throw error;
      if (!order) return Response.json({ error: 'ORDER_NOT_FOUND' }, { status: 404 });

      return Response.json({ order });
    } catch (err) {
      console.error(err);
      return Response.json(
        { error: 'STATUS_FAILED', details: String(err?.message || err) },
        { status: 500 }
      );
    }
  }
};
