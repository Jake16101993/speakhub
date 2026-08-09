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

      // @payos/node v2 returns a Promise here.
      const verified = await payOS.webhooks.verify(body);

      // In a valid webhook, verified contains the transaction data.
      // Keep body.data as a safe fallback for compatibility/debugging.
      const data = verified && typeof verified === 'object'
        ? verified
        : (body?.data || {});

      const orderCode = String(
        data?.orderCode ??
        body?.data?.orderCode ??
        ''
      );

      const amount = Number(
        data?.amount ??
        body?.data?.amount ??
        0
      );

      const paymentLinkId =
        data?.paymentLinkId ??
        body?.data?.paymentLinkId ??
        null;

      console.log('payOS webhook verified', {
        orderCode,
        amount,
        paymentLinkId,
        bodyCode: body?.code,
        bodySuccess: body?.success
      });

      // payOS sends a signed sample webhook while registering the URL.
      // If no matching SpeakHub payment exists, acknowledge with 200.
      const { data: payment, error: lookupError } = await supabase
        .from('payments')
        .select('id,order_id,status,amount,provider_order_code')
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

      const isSuccessfulPayment =
        body?.success === true &&
        String(body?.code ?? '') === '00' &&
        String(data?.code ?? body?.data?.code ?? '') === '00';

      if (!isSuccessfulPayment) {
        console.log('payOS webhook acknowledged; not a successful payment event', {
          orderCode,
          code: body?.code,
          dataCode: data?.code ?? body?.data?.code
        });

        return Response.json(
          {
            success: true,
            acknowledged: true,
            payment_confirmed: false,
            reason: 'NOT_SUCCESS_EVENT'
          },
          { status: 200 }
        );
      }

      const { data: result, error } = await supabase.rpc('confirm_payos_payment', {
        p_provider_order_code: orderCode,
        p_amount: amount,
        p_provider_payment_link_id: paymentLinkId,
        p_raw_payload: body
      });

      if (error) throw error;

      console.log('SpeakHub payment confirmed', {
        orderCode,
        amount,
        paymentLinkId,
        result
      });

      return Response.json(
        {
          success: true,
          acknowledged: true,
          payment_confirmed: true,
          result
        },
        { status: 200 }
      );
    } catch (err) {
      console.error('payOS webhook rejected', {
        message: String(err?.message || err),
        code: err?.code || null,
        details: err?.details || null
      });

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
