import { createClient } from '@supabase/supabase-js';
import { PayOS } from '@payos/node';
import QRCode from 'qrcode';

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

function numericOrderCode() {
  // 13-digit millisecond timestamp remains inside JS safe integer range.
  return Date.now();
}

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

      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select('id,order_code,total_amount,payment_status,order_status,expires_at,checkout_token')
        .eq('id', order_id)
        .eq('checkout_token', checkout_token)
        .maybeSingle();

      if (orderErr) throw orderErr;
      if (!order) return Response.json({ error: 'ORDER_NOT_FOUND' }, { status: 404 });

      if (order.payment_status === 'PAID') {
        return Response.json({ error: 'ORDER_ALREADY_PAID' }, { status: 409 });
      }

      if (new Date(order.expires_at).getTime() <= Date.now()) {
        return Response.json({ error: 'ORDER_EXPIRED' }, { status: 410 });
      }

      // Reuse an existing pending payOS link for the same order.
      const { data: existing } = await supabase
        .from('payments')
        .select('*')
        .eq('order_id', order.id)
        .eq('provider', 'PAYOS')
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing?.checkout_url && existing?.qr_code) {
        const qrImage = await QRCode.toDataURL(existing.qr_code, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: 'M'
        });
        return Response.json({
          payment: {
            checkout_url: existing.checkout_url,
            qr_code: existing.qr_code,
            qr_image: qrImage,
            provider_order_code: existing.provider_order_code,
            amount: existing.amount
          }
        });
      }

      const orderCode = numericOrderCode();
      const baseUrl = process.env.PUBLIC_APP_URL || 'https://speakhub.vn';
      const returnUrl = `${baseUrl}/?payment=success&order_id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(checkout_token)}`;
      const cancelUrl = `${baseUrl}/?payment=cancel&order_id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(checkout_token)}`;

      const remainingSeconds = Math.max(
        60,
        Math.floor((new Date(order.expires_at).getTime() - Date.now()) / 1000)
      );

      const paymentLink = await payOS.paymentRequests.create({
        orderCode,
        amount: Number(order.total_amount),
        description: `SpeakHub ${String(order.order_code).slice(-10)}`,
        cancelUrl,
        returnUrl,
        expiredAt: Math.floor(Date.now() / 1000) + remainingSeconds
      });

      const { error: paymentErr } = await supabase.from('payments').insert({
        order_id: order.id,
        provider: 'PAYOS',
        provider_order_code: String(orderCode),
        provider_payment_link_id: paymentLink.paymentLinkId || paymentLink.id || null,
        checkout_url: paymentLink.checkoutUrl,
        qr_code: paymentLink.qrCode,
        amount: Number(order.total_amount),
        status: 'PENDING',
        raw_payload: paymentLink
      });

      if (paymentErr) throw paymentErr;

      const qrImage = await QRCode.toDataURL(paymentLink.qrCode, {
        width: 320,
        margin: 1,
        errorCorrectionLevel: 'M'
      });

      return Response.json({
        payment: {
          checkout_url: paymentLink.checkoutUrl,
          qr_code: paymentLink.qrCode,
          qr_image: qrImage,
          provider_order_code: String(orderCode),
          amount: Number(order.total_amount),
          expires_at: order.expires_at
        }
      }, { status: 201 });

    } catch (err) {
      console.error('payOS create error', err);
      return Response.json(
        { error: 'PAYOS_CREATE_FAILED', details: String(err?.message || err) },
        { status: 500 }
      );
    }
  }
};
