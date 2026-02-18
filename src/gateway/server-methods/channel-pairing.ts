import type { GatewayRequestHandlers } from "./types.js";
import type { PairingChannel } from "../../pairing/pairing-store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
} from "../../pairing/pairing-store.js";
import { loadConfig } from "../../config/config.js";
import { notifyPairingApproved } from "../../channels/plugins/pairing.js";

/** Lenient channel validation — accepts any registered or extension channel name. */
function parseChannel(raw: unknown): PairingChannel {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`Invalid channel: ${value || "(empty)"}`);
  }
  return value as PairingChannel;
}

export const channelPairingHandlers: GatewayRequestHandlers = {
  "channel.pairing.list": async ({ params, respond }) => {
    try {
      const channel = parseChannel(params.channel);
      const requests = await listChannelPairingRequests(channel);
      respond(true, { channel, requests });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "channel.pairing.approve": async ({ params, respond }) => {
    try {
      const channel = parseChannel(params.channel);
      const code = String(params.code ?? "").trim();
      if (!code) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "code required"));
        return;
      }
      const approved = await approveChannelPairingCode({ channel, code });
      if (!approved) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "no pending request for that code"),
        );
        return;
      }

      // Best-effort notification to the approved user
      try {
        const cfg = loadConfig();
        await notifyPairingApproved({ channelId: channel, id: approved.id, cfg });
      } catch {
        // notification is optional
      }

      respond(true, { id: approved.id, channel });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
