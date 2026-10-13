"use client";

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

type PrahariLiveHandlers = {
  onConnectionChange?: (connected: boolean) => void;
  onIncidentCreated?: (incident: unknown) => void;
  onIncidentUpdated?: (incident: unknown) => void;
  onTouristLocation?: (location: unknown) => void;
  onProbe?: (probe: unknown) => void;
};

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Subscribes an authority dashboard to the managed Supabase Realtime private
 * channel. A separate, short-lived Realtime JWT is requested from the app only
 * after its own server-side session has been checked for authority/admin role.
 */
export function subscribeToPrahariLive(
  handlers: PrahariLiveHandlers
): () => void {
  if (!projectUrl || !publishableKey) {
    handlers.onConnectionChange?.(false);
    return () => {};
  }

  let client: SupabaseClient | null = null;
  let channel: RealtimeChannel | null = null;
  let cancelled = false;

  void (async () => {
    try {
      const tokenResponse = await fetch("/api/realtime/token", { cache: "no-store" });
      if (!tokenResponse.ok || cancelled) {
        handlers.onConnectionChange?.(false);
        return;
      }
      const { token } = (await tokenResponse.json()) as { token?: string };
      if (!token || cancelled) {
        handlers.onConnectionChange?.(false);
        return;
      }

      // Loaded only when Realtime is configured, keeping it out of the page bundle.
      const { createClient } = await import("@supabase/supabase-js");
      if (cancelled) return;
      client = createClient(projectUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      client.realtime.setAuth(token);
      channel = client
        .channel("prahari:live", { config: { private: true } })
        .on("broadcast", { event: "incident:created" }, ({ payload }) => {
          handlers.onIncidentCreated?.(payload);
        })
        .on("broadcast", { event: "incident:updated" }, ({ payload }) => {
          handlers.onIncidentUpdated?.(payload);
        })
        .on("broadcast", { event: "tourist:location" }, ({ payload }) => {
          handlers.onTouristLocation?.(payload);
        })
        .on("broadcast", { event: "realtime:probe" }, ({ payload }) => {
          handlers.onProbe?.(payload);
        })
        .subscribe((status) => {
          handlers.onConnectionChange?.(status === "SUBSCRIBED");
        });
    } catch {
      handlers.onConnectionChange?.(false);
    }
  })();

  return () => {
    cancelled = true;
    if (client && channel) void client.removeChannel(channel);
  };
}
