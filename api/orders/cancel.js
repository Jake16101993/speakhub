import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
      const { order_id, checkout_token } = await request.json();

      if (!order_id || !checkout_token) {
        return Response.json({ error: 'ORDER_TOKEN_REQUIRED' }, { status: 400 });
      }

      const { data: order, error } = await supabase
        .from('orders')
        .select('id,payment_status,order_status')
        .eq('id', order_id)
        .eq('checkout_token', checkout_token)
        .maybeSingle();

      if (error) throw error;
      if (!order) return Response.json({ error: 'ORDER_NOT_FOUND' }, { status: 404 });

      if (order.payment_status === 'PAID') {
        return Response.json({ error: 'ORDER_ALREADY_PAID' }, { status: 409 });
      }

      await supabase
        .from('orders')
        .update({ payment_status: 'EXPIRED', order_status: 'CANCELLED' })
        .eq('id', order.id)
        .eq('payment_status', 'PENDING');

      await supabase
        .from('bookings')
        .update({ status: 'CANCELLED' })
        .eq('order_id', order.id)
        .eq('status', 'PENDING');

      return Response.json({ success: true });
    } catch (err) {
      console.error(err);
      return Response.json(
        { error: 'CANCEL_FAILED', details: String(err?.message || err) },
        { status: 500 }
      );
    }
  }
};
