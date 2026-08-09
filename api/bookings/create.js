import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const authMode = process.env.SPEAKHUB_AUTH_MODE || 'dev_phone';

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

function toE164(phone) {
  return '+84' + String(phone).trim().slice(1);
}

async function getOrCreateDevUser(phone, fullName) {
  // Profile is the fast lookup and uses the local VN format 0xxxxxxxxx.
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id,phone,full_name')
    .eq('phone', phone)
    .maybeSingle();

  if (profileErr) throw profileErr;

  if (profile?.id) {
    await admin.from('profiles')
      .update({ full_name: fullName })
      .eq('id', profile.id);
    return profile.id;
  }

  // Temporary pre-OTP account. We deliberately do NOT phone-confirm it here.
  const { data, error } = await admin.auth.admin.createUser({
    phone: toE164(phone),
    phone_confirm: false,
    user_metadata: { full_name: fullName, source: 'dev_phone_checkout' }
  });

  if (error) throw error;

  const userId = data.user.id;

  await admin.from('profiles')
    .update({ phone, full_name: fullName })
    .eq('id', userId);

  return userId;
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
      const sessionIds = Array.isArray(body?.session_ids)
        ? [...new Set(body.session_ids.filter(Boolean))]
        : [];

      if (!sessionIds.length) {
        return Response.json({ error: 'NO_SESSIONS_SELECTED' }, { status: 400 });
      }

      let userId;

      if (authMode === 'dev_phone') {
        const phone = String(body?.phone || '').trim();
        const fullName = String(body?.full_name || '').trim();

        if (!validPhone(phone)) {
          return Response.json({ error: 'INVALID_PHONE' }, { status: 400 });
        }
        if (!validFullName(fullName)) {
          return Response.json({ error: 'INVALID_FULL_NAME' }, { status: 400 });
        }

        userId = await getOrCreateDevUser(phone, fullName);
      } else {
        const authHeader = request.headers.get('authorization') || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

        if (!token) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 });

        const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
        const authRes = await fetch(`${url}/auth/v1/user`, {
          headers: { apikey: publishable, Authorization: `Bearer ${token}` }
        });
        const user = await authRes.json();
        if (!authRes.ok || !user?.id) {
          return Response.json({ error: 'INVALID_SESSION' }, { status: 401 });
        }
        userId = user.id;
      }

      const { data, error } = await admin.rpc('create_booking_order', {
        p_user_id: userId,
        p_session_ids: sessionIds
      });

      if (error) {
        const msg = String(error.message || '');
        let code = 'BOOKING_FAILED';
        if (msg.includes('ALREADY_BOOKED')) code = 'ALREADY_BOOKED';
        else if (msg.includes('SESSION_FULL')) code = 'SESSION_FULL';
        else if (msg.includes('SESSION_NOT_OPEN')) code = 'SESSION_NOT_OPEN';
        else if (msg.includes('SESSION_ALREADY_STARTED')) code = 'SESSION_ALREADY_STARTED';
        else if (msg.includes('SESSION_NOT_FOUND')) code = 'SESSION_NOT_FOUND';

        return Response.json({ error: code, details: msg }, { status: 400 });
      }

      return Response.json({ order: data }, { status: 201 });
    } catch (err) {
      console.error(err);
      return Response.json(
        { error: 'INTERNAL_SERVER_ERROR', details: String(err?.message || err) },
        { status: 500 }
      );
    }
  }
};
