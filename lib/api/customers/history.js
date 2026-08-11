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

      // Some manually-added/older customers can exist under a second customer UUID
      // while using the same phone number. Login authenticates one customer ID, but
      // the paid booking may belong to the duplicate ID. Merge booking history by
      // phone so the user sees every paid/confirmed lesson belonging to their account.
      let customerIds = [customer.id];
      const phone = String(customer.phone || '').trim();

      if (phone) {
        const { data: samePhoneCustomers, error: samePhoneErr } = await supabase
          .from('customers')
          .select('id,status,phone')
          .eq('phone', phone);

        if (samePhoneErr) throw samePhoneErr;

        customerIds = [...new Set(
          [customer.id, ...(samePhoneCustomers || []).map(x => x.id)].filter(Boolean)
        )];
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
            id,session_date,session_period,starts_at,ends_at,topic_title,topic_storage_path,topic_vocabulary,
            programs(name,code),
            rooms(name),
            teachers(full_name,country),
            locations(name,district)
          )
        `)
        .in('user_id', customerIds)
        .eq('status', 'CONFIRMED')
        .eq('orders.payment_status', 'PAID')
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

      return new Response(JSON.stringify({
        upcoming,
        completed,
        _history_meta: {
          matched_customer_ids: customerIds.length
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
