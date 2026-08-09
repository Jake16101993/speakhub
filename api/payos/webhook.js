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

      // IMPORTANT:
      // payOS sends a signed TEST webhook when the Webhook URL is registered.
      // We must verify the signature, but a test orderCode will not exist in our DB.
      const verified = payOS.webhooks.verify(body);

      const orderCode = String(verified.orderCode ?? '');
      const amount = Number(verified.amount ?? 0);
      const paymentLinkId = verified.paymentLinkId || null;

      // Only successful payment notifications should confirm a SpeakHub booking.
      const success =
        body?.success === true &&
        String(body?.code ?? '') === '00' &&
        String(verified?.code ?? '00') === '00';

      if (!success) {
        // Valid signed webhook, but not a successful payment event.
        // Acknowledge it so payOS does not retry / reject the URL.
        return Response.json(
          { success: true, acknowledged: true, payment_confirmed: false },
          { status: 200 }
        );
      }

      // Find our payment first. This is also what makes payOS's webhook test pass:
      // the signed test payload has no matching provider_order_code in SpeakHub.
      const { data: payment, error: lookupError } = await supabase
        .from('payments')
        .select('id,order_id,status')
        .eq('provider', 'PAYOS')
        .eq('provider_order_code', orderCode)
        .maybeSingle();

      if (lookupError) throw lookupError;

      if (!payment) {
        console.log('payOS webhook acknowledged; no matching SpeakHub payment', {
          orderCode,
          paymentLinkId
        });

        return Response.json(
          {
            success: true,
            acknowledged: true,
            payment_confirmed: false,
            reason: 'NO_MATCHING_PAYMENT'
          },
          { status: 200 }
        );
      }

      const { data, error } = await supabase.rpc('confirm_payos_payment', {
        p_provider_order_code: orderCode,
        p_amount: amount,
        p_provider_payment_link_id: paymentLinkId,
        p_raw_payload: body
      });

      if (error) throw error;

      return Response.json(
        {
          success: true,
          acknowledged: true,
          payment_confirmed: true,
          result: data
        },
        { status: 200 }
      );
    } catch (err) {
      console.error('payOS webhook rejected', err);

      // 400 only for an actually invalid/unverifiable webhook.
      return Response.json(
        {
          success: false,
          error: 'INVALID_WEBHOOK',
          details: String(err?.message || err)
        },
        { status: 400 }
      );
    }
  }
};
