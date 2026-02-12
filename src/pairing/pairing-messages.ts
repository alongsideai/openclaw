import type { PairingChannel } from "./pairing-store.js";

export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
}): string {
  const { code } = params;
  return [
    "Hi! This bot requires access approval.",
    "",
    `Your pairing code is: ${code}`,
    "",
    "Your request has been sent to the bot owner. You'll be able to chat once they approve it.",
    "",
    "{{TODO}}/dashboard/telegram",
  ].join("\n");
}
