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

  const { data: existing, error: findErr } = await admin
    .from('customers')
    .select('id,phone,full_name,status,device_token')
    .eq('phone', cleanPhone)
    .maybeSingle();

  if (findErr) throw findErr;

  if (existing?.id) {
    const { error: updateErr } = await admin
      .from('customers')
      .update({
        full_name: cleanName,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id);

    if (updateErr) throw updateErr;
    if (existing.status !== 'ACTIVE') throw new Error('CUSTOMER_NOT_ACTIVE');
    return { id: existing.id, token: existing.device_token };
  }

  const { data: created, error: createErr } = await admin
    .from('customers')
    .insert({
      phone: cleanPhone,
      full_name: cleanName
    })
    .select('id,device_token,status')
    .single();

  if (createErr) {
    // Handle a race where two requests create the same phone simultaneously.
    if (String(createErr.code) === '23505') {
      const { data: retry, error: retryErr } = await admin
        .from('customers')
        .select('id')
        .eq('phone', cleanPhone)
        .single();

      if (retryErr) throw retryErr;
      const { data: retryFull, error: retryFullErr } = await admin
        .from('customers')
        .select('id,device_token,status')
        .eq('id', retry.id)
        .single();
      if (retryFullErr) throw retryFullErr;
      if (retryFull.status !== 'ACTIVE') throw new Error('CUSTOMER_NOT_ACTIVE');
      return { id: retryFull.id, token: retryFull.device_token };
    }
    throw createErr;
  }

  if (created.status !== 'ACTIVE') throw new Error('CUSTOMER_NOT_ACTIVE');
  return { id: created.id, token: created.device_token };
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
