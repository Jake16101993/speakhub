import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

const admin = supabaseUrl && secretKey
  ? createClient(supabaseUrl, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : null;

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (!supabaseUrl || !publishableKey || !secretKey || !admin) {
      return Response.json(
        { error: 'Server environment variables are missing' },
        { status: 500 }
      );
    }

    try {
      // The browser must send the Supabase user access token:
      // Authorization: Bearer <access_token>
      const authHeader = request.headers.get('authorization') || '';
      const accessToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';

      if (!accessToken) {
        return Response.json(
          { error: 'AUTH_REQUIRED' },
          { status: 401 }
        );
      }

      // Verify the user's JWT with Supabase Auth.
      const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const user = await authRes.json();

      if (!authRes.ok || !user?.id) {
        return Response.json(
          { error: 'INVALID_SESSION' },
          { status: 401 }
        );
      }

      const body = await request.json();
      const sessionIds = Array.isArray(body?.session_ids)
        ? [...new Set(body.session_ids.filter(Boolean))]
        : [];

      if (!sessionIds.length) {
        return Response.json(
          { error: 'NO_SESSIONS_SELECTED' },
          { status: 400 }
        );
      }

      if (sessionIds.length > 20) {
        return Response.json(
          { error: 'TOO_MANY_SESSIONS' },
          { status: 400 }
        );
      }

      // Server/secret-key RPC. Browser never gets this secret.
      const { data, error } = await admin.rpc('create_booking_order', {
        p_user_id: user.id,
        p_session_ids: sessionIds,
      });

      if (error) {
        const msg = String(error.message || '');

        let code = 'BOOKING_FAILED';
        let status = 400;

        if (msg.includes('ALREADY_BOOKED')) code = 'ALREADY_BOOKED';
        else if (msg.includes('SESSION_FULL')) code = 'SESSION_FULL';
        else if (msg.includes('SESSION_NOT_OPEN')) code = 'SESSION_NOT_OPEN';
        else if (msg.includes('SESSION_ALREADY_STARTED')) code = 'SESSION_ALREADY_STARTED';
        else if (msg.includes('SESSION_NOT_FOUND')) code = 'SESSION_NOT_FOUND';
        else if (msg.includes('USER_NOT_FOUND')) {
          code = 'USER_NOT_FOUND';
          status = 401;
        }

        return Response.json(
          { error: code, details: msg },
          { status }
        );
      }

      return Response.json(
        { order: data },
        { status: 201 }
      );
    } catch (err) {
      console.error('create-booking error', err);
      return Response.json(
        { error: 'INTERNAL_SERVER_ERROR' },
        { status: 500 }
      );
    }
  }
};
