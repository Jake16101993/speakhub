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
      const customerId = url.searchParams.get('customer_id');
      const token = url.searchParams.get('token');

      if (!customerId || !token) {
        return Response.json({ error: 'CUSTOMER_TOKEN_REQUIRED' }, { status: 401 });
      }

      const { data: customer, error: customerErr } = await supabase
        .from('customers')
        .select('id,status')
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

      const { data: bookings, error } = await supabase
        .from('bookings')
        .select(`
          id,status,confirmed_at,created_at,
          orders!inner(
            id,order_code,payment_status,order_status,
            reschedule_limit,reschedule_used
          ),
          class_sessions(
            id,session_date,session_period,starts_at,ends_at,topic_title,topic_storage_path,
            programs(name,code),
            rooms(name),
            teachers(full_name,country),
            locations(name,district)
          )
        `)
        .eq('user_id', customerId)
        .eq('status', 'CONFIRMED')
        .eq('orders.payment_status', 'PAID')
        .eq('orders.order_status', 'CONFIRMED')
        .order('session_date', { referencedTable: 'class_sessions', ascending: true });

      if (error) throw error;

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

      return Response.json({ upcoming, completed });
    } catch (err) {
      console.error('customer history error', err);
      return Response.json(
        { error: 'HISTORY_FAILED', details: String(err?.message || err) },
        { status: 500 }
      );
    }
  }
};
