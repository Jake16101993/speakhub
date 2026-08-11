import bookingCreate from '../lib/api/bookings/create.js';
import bookingReschedule from '../lib/api/bookings/reschedule.js';
import customerHistory from '../lib/api/customers/history.js';
import customerLogin from '../lib/api/customers/login.js';
import orderCancel from '../lib/api/orders/cancel.js';
import orderStatus from '../lib/api/orders/status.js';
import payosCreate from '../lib/api/payos/create.js';
import payosReconcile from '../lib/api/payos/reconcile.js';
import payosWebhook from '../lib/api/payos/webhook.js';

const routes = {
  '/api/bookings/create': bookingCreate,
  '/api/bookings/reschedule': bookingReschedule,
  '/api/customers/history': customerHistory,
  '/api/customers/login': customerLogin,
  '/api/orders/cancel': orderCancel,
  '/api/orders/status': orderStatus,
  '/api/payos/create': payosCreate,
  '/api/payos/reconcile': payosReconcile,
  '/api/payos/webhook': payosWebhook
};

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const handler = routes[url.pathname];

      if (!handler?.fetch) {
        return Response.json(
          { error: 'API_ROUTE_NOT_FOUND', path: url.pathname },
          { status: 404 }
        );
      }

      return await handler.fetch(request);
    } catch (error) {
      console.error('catch-all api error', error);
      return Response.json(
        {
          error: 'API_DISPATCH_FAILED',
          details: String(error?.message || error)
        },
        { status: 500 }
      );
    }
  }
};
