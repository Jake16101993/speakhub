import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

const admin = url && secret
  ? createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

function validPhone(phone) {
  return /^0\d{9}$/.test(String(phone || '').trim());
}

function validFullName(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean).length >= 2;
}

async function getOrCreateCustomer(phone, fullName) {
  const cleanPhone = String(phone).trim();
  const cleanName = String(fullName).trim().replace(/\s+/g, ' ');

  // One DB roundtrip instead of:
  // SELECT -> UPDATE/INSERT -> optional retry SELECT.
  // phone is already the customer uniqueness key in SpeakHub.
  const { data: customer, error } = await admin
    .from('customers')
    .upsert(
      {
        phone: cleanPhone,
        full_name: cleanName,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: 'phone',
        ignoreDuplicates: false
      }
    )
    .select('id,device_token,status')
    .single();

  if (error) throw error;
  if (!customer?.id) throw new Error('CUSTOMER_NOT_FOUND');
  if (customer.status !== 'ACTIVE') throw new Error('CUSTOMER_NOT_ACTIVE');

  return { id: customer.id, token: customer.device_token };
}


async function applyDateDiscountsToOrder(orderData, sessionIds) {
  const orderId = orderData?.order_id;
  const unitPrice = Number(orderData?.unit_price || 0);
  const baseTotal = Number(orderData?.total_amount || 0);
  const originalTotal = Number(orderData?.original_total || baseTotal);
  const existingDiscount = Number(orderData?.discount_amount || Math.max(0, originalTotal - baseTotal));

  if (!orderId || !unitPrice || !Array.isArray(sessionIds) || !sessionIds.length) {
    return orderData;
  }

  const { data: sessions, error: sessionErr } = await admin
    .from('class_sessions')
    .select('id,session_date,programs(name)')
    .in('id', sessionIds);

  if (sessionErr) throw sessionErr;

  const sessionById = new Map(
    (sessions || []).map(s => [
      String(s.id),
      {
        session_date: String(s.session_date || ''),
        program_name: String(s.programs?.name || '')
      }
    ])
  );

  const dates = [...new Set(
    sessionIds.map(id => sessionById.get(String(id))?.session_date).filter(Boolean)
  )];

  if (!dates.length) return orderData;

  const { data: discounts, error: discountErr } = await admin
    .from('class_date_discounts')
    .select('discount_date,program_name,discount_percent')
    .in('discount_date', dates);

  if (discountErr) throw discountErr;

  const discountMap = new Map(
    (discounts || [])
      .map(x => [
        `${String(x.discount_date)}||${String(x.program_name || '')}`,
        Number(x.discount_percent || 0)
      ])
      .filter(([, pct]) => pct > 0 && pct < 100)
  );

  let dateDiscountAmount = 0;
  const appliedDiscounts = [];

  for (const sessionId of sessionIds) {
    const session = sessionById.get(String(sessionId));
    if (!session) continue;

    const key = `${session.session_date}||${session.program_name}`;
    const pct = Number(discountMap.get(key) || 0);
    if (!(pct > 0)) continue;

    const amount = Math.round(unitPrice * pct / 100);
    dateDiscountAmount += amount;
    appliedDiscounts.push({
      session_id: sessionId,
      session_date: session.session_date,
      program_name: session.program_name,
      discount_percent: pct,
      discount_amount: amount
    });
  }

  if (!(dateDiscountAmount > 0)) return orderData;

  const finalTotal = Math.max(0, baseTotal - dateDiscountAmount);
  const finalDiscountAmount = existingDiscount + dateDiscountAmount;

  const { error: updateErr } = await admin
    .from('orders')
    .update({
      total_amount: finalTotal,
      discount_amount: finalDiscountAmount
    })
    .eq('id', orderId)
    .eq('payment_status', 'PENDING');

  if (updateErr) throw updateErr;

  return {
    ...orderData,
    total_amount: finalTotal,
    discount_amount: finalDiscountAmount,
    date_discount_amount: dateDiscountAmount,
    applied_date_discounts: appliedDiscounts
  };
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (!admin) {
      return Response.json({ error: 'SERVER_ENV_MISSING' }, { status: 500 });
    }

    try {
      const body = await request.json();

      const phone = String(body?.phone || '').trim();
      const fullName = String(body?.full_name || '').trim();
      const sessionIds = Array.isArray(body?.session_ids)
        ? [...new Set(body.session_ids.filter(Boolean))]
        : [];

      if (!validPhone(phone)) {
        return Response.json({ error: 'INVALID_PHONE' }, { status: 400 });
      }

      if (!validFullName(fullName)) {
        return Response.json({ error: 'INVALID_FULL_NAME' }, { status: 400 });
      }

      if (!sessionIds.length) {
        return Response.json({ error: 'NO_SESSIONS_SELECTED' }, { status: 400 });
      }

      if (sessionIds.length > 20) {
        return Response.json({ error: 'TOO_MANY_SESSIONS' }, { status: 400 });
      }

      const customer = await getOrCreateCustomer(phone, fullName);
      const customerId = customer.id;

      const { data, error } = await admin.rpc('create_booking_order', {
        p_user_id: customerId,
        p_session_ids: sessionIds
      });

      if (error) {
        const msg = String(error.message || '');
        let code = 'BOOKING_FAILED';

        if (msg.includes('ALREADY_BOOKED')) code = 'ALREADY_BOOKED';
        else if (msg.includes('uq_user_active_session') || msg.includes('duplicate key value')) code = 'ALREADY_BOOKED';
        else if (msg.includes('SESSION_FULL')) code = 'SESSION_FULL';
        else if (msg.includes('SESSION_NOT_OPEN')) code = 'SESSION_NOT_OPEN';
        else if (msg.includes('SESSION_ALREADY_STARTED')) code = 'SESSION_ALREADY_STARTED';
        else if (msg.includes('SESSION_NOT_FOUND')) code = 'SESSION_NOT_FOUND';
        else if (msg.includes('CUSTOMER_NOT_FOUND')) code = 'CUSTOMER_NOT_FOUND';
        else if (msg.includes('CUSTOMER_NOT_ACTIVE')) code = 'CUSTOMER_NOT_ACTIVE';

        return Response.json(
          { error: code, details: msg },
          { status: 400 }
        );
      }

      const discountedOrder = await applyDateDiscountsToOrder(data, sessionIds);

      return Response.json(
        {
          order: discountedOrder,
          customer_id: customerId,
          customer_token: customer.token
        },
        { status: 201 }
      );
    } catch (err) {
      console.error('booking create error', err);

      return Response.json(
        {
          error: 'INTERNAL_SERVER_ERROR',
          details: String(err?.message || err)
        },
        { status: 500 }
      );
    }
  }
};
