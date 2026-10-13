/**
 * Publishes an operational event through Supabase's Realtime Broadcast API.
 * This is best-effort: a delivery failure must not make the SOS, location, or
 * E-FIR mutation fail after it has been stored.
 *
 * Calling the REST Broadcast API directly avoids the database Broadcast
 * replication slot and daily-partition lifecycle. Browser sessions can still
 * subscribe only when their short-lived staff JWT passes the private-channel
 * RLS policy on `realtime.messages`.
 */
type RealtimeDeliveryResult = {
  attempted: boolean;
  accepted: boolean;
};

export async function emitToGateway(event: string, payload: unknown): Promise<RealtimeDeliveryResult> {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const broadcastEvent = {
    "incident:create": "incident:created",
    "incident:update": "incident:updated",
    "tourist:location": "tourist:location",
  }[event] ?? event;

  if (!projectUrl || !serviceRoleKey) return { attempted: false, accepted: false };

  try {
    const topic = encodeURIComponent("prahari:live");
    const eventName = encodeURIComponent(broadcastEvent);
    const response = await fetch(
      `${projectUrl}/realtime/v1/api/broadcast/${topic}/events/${eventName}?private=true`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2_000),
      }
    );
    if (!response.ok) {
      console.warn(`[prahari] Realtime Broadcast API rejected HTTP ${response.status}.`);
    }
    return { attempted: true, accepted: response.ok };
  } catch {
    // Realtime is an enhancement; the durable API write has already succeeded.
    return { attempted: true, accepted: false };
  }
}
