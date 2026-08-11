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

      return Response.json(
        {
          order: data,
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
