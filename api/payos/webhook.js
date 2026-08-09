import { createClient } from '@supabase/supabase-js';
import { PayOS } from '@payos/node';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const payOS = new PayOS({
  clientId: process.env.PAYOS_CLIENT_ID,
  apiKey: process.env.PAYOS_API_KEY,
  checksumKey: process.env.PAYOS_CHECKSUM_KEY
});

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
      const body = await request.json();

      // Official SDK verifies the payOS signature before we touch the DB.
      const verified = payOS.webhooks.verify(body);

      const orderCode = String(verified.orderCode);
      const amount = Number(verified.amount);
      const paymentLinkId = verified.paymentLinkId || null;

      const { data, error } = await supabase.rpc('confirm_payos_payment', {
        p_provider_order_code: orderCode,
        p_amount: amount,
        p_provider_payment_link_id: paymentLinkId,
        p_raw_payload: body
      });

      if (error) throw error;

      return Response.json({ success: true, result: data }, { status: 200 });
    } catch (err) {
      console.error('payOS webhook error', err);
      return Response.json(
        { success: false, error: 'INVALID_WEBHOOK' },
        { status: 400 }
      );
    }
  }
};
