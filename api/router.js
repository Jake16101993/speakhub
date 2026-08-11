import bookingCreate from '../lib/api/bookings/create.js';
import bookingReschedule from '../lib/api/bookings/reschedule.js';
import customerHistory from '../lib/api/customers/history.js';
import customerLogin from '../lib/api/customers/login.js';
import orderCancel from '../lib/api/orders/cancel.js';
import orderStatus from '../lib/api/orders/status.js';
import payosCreate from '../lib/api/payos/create.js';
import payosReconcile from '../lib/api/payos/reconcile.js';
import payosWebhook from '../lib/api/payos/webhook.js';

const handlers = {
  'bookings:create': bookingCreate,
  'bookings:reschedule': bookingReschedule,
  'customers:history': customerHistory,
  'customers:login': customerLogin,
  'orders:cancel': orderCancel,
  'orders:status': orderStatus,
  'payos:create': payosCreate,
  'payos:reconcile': payosReconcile,
  'payos:webhook': payosWebhook
};

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const group = url.searchParams.get('group') || '';
      const action = url.searchParams.get('action') || '';
      const key = `${group}:${action}`;
      const handler = handlers[key];

      if (!handler?.fetch) {
        return Response.json(
          { error: 'API_ROUTE_NOT_FOUND', group, action },
          { status: 404 }
        );
      }

      return await handler.fetch(request);
    } catch (error) {
      console.error('router api error', error);
      return Response.json(
        { error: 'API_ROUTER_FAILED', details: String(error?.message || error) },
        { status: 500 }
      );
    }
  }
};
