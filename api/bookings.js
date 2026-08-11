import createHandler from '../lib/api/bookings/create.js';
import rescheduleHandler from '../lib/api/bookings/reschedule.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'create') return createHandler.fetch(request);
    if (action === 'reschedule') return rescheduleHandler.fetch(request);

    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  }
};
