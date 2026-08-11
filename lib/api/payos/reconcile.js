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
      const mode = String(body?.mode || 'reconcile');
      const orderId = body?.order_id;
      const checkoutToken = body?.checkout_token;

      if (!orderId || !checkoutToken) {
        return Response.json({ error: 'ORDER_TOKEN_REQUIRED' }, { status: 400 });
      }

      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select('id,order_code,total_amount,payment_status,order_status,expires_at,hold_last_seen_at,checkout_token')
        .eq('id', orderId)
        .eq('checkout_token', checkoutToken)
        .maybeSingle();

      if (orderErr) throw orderErr;
      if (!order) {
        return Response.json({ error: 'ORDER_NOT_FOUND' }, { status: 404 });
      }


      const now = Date.now();
      const expiresMs = new Date(order.expires_at || 0).getTime();
      const lastSeenMs = new Date(order.hold_last_seen_at || 0).getTime();
      const stale = !lastSeenMs || (now - lastSeenMs > 75 * 1000);
      const hardExpired = !expiresMs || expiresMs <= now;

      async function cancelPendingHold(reason='HOLD_RELEASED') {
        if (order.payment_status === 'PAID') {
          return { paid: true };
        }

        // Best-effort cancellation of any PayOS link already created.
        try {
          const { data: payment } = await supabase
            .from('payments')
            .select('provider_order_code,status')
            .eq('order_id', order.id)
            .eq('provider', 'PAYOS')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          const cancelFn = payOS?.paymentRequests?.cancel;
          if (payment?.provider_order_code && typeof cancelFn === 'function') {
            await cancelFn.call(
              payOS.paymentRequests,
              Number(payment.provider_order_code),
              reason
            );
          }
        } catch (cancelErr) {
          console.warn('PayOS hold cancel best-effort failed', cancelErr?.message || cancelErr);
        }

        const { error: bookingsErr } = await supabase
          .from('bookings')
          .update({ status: 'CANCELLED' })
          .eq('order_id', order.id)
          .neq('status', 'CANCELLED');
        if (bookingsErr) throw bookingsErr;

        const { error: orderCancelErr } = await supabase
          .from('orders')
          .update({
            payment_status: 'EXPIRED',
            order_status: 'CANCELLED'
          })
          .eq('id', order.id)
          .neq('payment_status', 'PAID');
        if (orderCancelErr) throw orderCancelErr;

        return { paid: false };
      }

      if (mode === 'release') {
        const released = await cancelPendingHold('USER_LEFT_OR_HOLD_EXPIRED');
        return Response.json({
          success: true,
          released: !released.paid,
          paid: released.paid
        });
      }

      if (mode === 'heartbeat') {
        if (order.payment_status === 'PAID' && order.order_status === 'CONFIRMED') {
          return Response.json({
            success: true,
            hold_active: false,
            paid: true,
            order
          });
        }

        if (hardExpired || stale || order.order_status !== 'PENDING') {
          await cancelPendingHold(hardExpired ? 'HOLD_MAX_EXPIRED' : 'HOLD_INACTIVE');
          return Response.json({
            success: true,
            hold_active: false,
            reason: hardExpired ? 'HOLD_EXPIRED' : 'HOLD_INACTIVE'
          });
        }

        const nowIso = new Date().toISOString();
        const { error: touchErr } = await supabase
          .from('orders')
          .update({ hold_last_seen_at: nowIso })
          .eq('id', order.id)
          .eq('payment_status', 'PENDING')
          .eq('order_status', 'PENDING');

        if (touchErr) throw touchErr;

        return Response.json({
          success: true,
          hold_active: true,
          expires_at: order.expires_at,
          last_seen_at: nowIso
        });
      }

      // Normal reconcile should not resurrect a stale hold.
      if (
        order.payment_status !== 'PAID' &&
        (hardExpired || stale || order.order_status !== 'PENDING')
      ) {
        await cancelPendingHold(hardExpired ? 'HOLD_MAX_EXPIRED' : 'HOLD_INACTIVE');
        return Response.json({
          success: false,
          error: hardExpired ? 'ORDER_EXPIRED' : 'HOLD_INACTIVE'
        }, { status: 410 });
      }

      if (order.payment_status === 'PAID' && order.order_status === 'CONFIRMED') {
        return Response.json({
          success: true,
          already_confirmed: true,
          order
        });
      }

      const { data: payment, error: paymentErr } = await supabase
        .from('payments')
        .select('id,provider_order_code,provider_payment_link_id,status,amount')
        .eq('order_id', order.id)
        .eq('provider', 'PAYOS')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (paymentErr) throw paymentErr;
      if (!payment?.provider_order_code) {
        return Response.json({ error: 'PAYMENT_NOT_FOUND' }, { status: 404 });
      }

      // payOS allows GET /v2/payment-requests/{id} where id can be merchant orderCode.
      const payosInfo = await payOS.get(
        `/v2/payment-requests/${encodeURIComponent(payment.provider_order_code)}`
      );

      const info = payosInfo?.data ?? payosInfo;

      const orderCode = String(info?.orderCode ?? payment.provider_order_code);
      const amountPaid = Number(info?.amountPaid ?? 0);
      const amount = Number(info?.amount ?? order.total_amount ?? payment.amount ?? 0);
      const status = String(info?.status ?? '').toUpperCase();
      const paymentLinkId = info?.id ?? info?.paymentLinkId ?? payment.provider_payment_link_id ?? null;

      const paid =
        amountPaid >= Number(order.total_amount) ||
        status === 'PAID';

      if (!paid) {
        return Response.json({
          success: true,
          payment_confirmed: false,
          payos: {
            orderCode,
            status,
            amount,
            amountPaid,
            paymentLinkId
          }
        });
      }

      const { data: result, error: confirmErr } = await supabase.rpc(
        'confirm_payos_payment',
        {
          p_provider_order_code: orderCode,
          p_amount: Number(order.total_amount),
          p_provider_payment_link_id: paymentLinkId,
          p_raw_payload: {
            source: 'reconcile',
            fetched_at: new Date().toISOString(),
            payos: info
          }
        }
      );

      if (confirmErr) throw confirmErr;

      return Response.json({
        success: true,
        payment_confirmed: true,
        result,
        payos: {
          orderCode,
          status,
          amount,
          amountPaid,
          paymentLinkId
        }
      });
    } catch (err) {
      console.error('reconcile error', err);
      return Response.json(
        {
          success: false,
          error: 'RECONCILE_FAILED',
          details: String(err?.message || err)
        },
        { status: 500 }
      );
    }
  }
};
