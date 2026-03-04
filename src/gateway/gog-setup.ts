import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { createCredentialStore } from "./credential-store.js";
import {
  execGogImport,
  updateToolsWithGogAuth,
  clearStaleSessions,
  type GogLogger,
} from "./server-http.js";

const execFileAsync = promisify(execFile);

/**
 * Runs on every gateway start. Idempotent.
 * 1. Ensures gog binary exists
 * 2. Sets up file-based keyring (EBS-persistent)
 * 3. Loads client credentials from env
 * 4. If already authenticated, just updates TOOLS.md
 * 5. Otherwise, restores tokens from DynamoDB credential store
 */
export async function setupGogOnStartup(log: GogLogger): Promise<void> {
  // Check if gog exists
  try {
    await execFileAsync("which", ["gog"], { timeout: 5_000 });
  } catch {
    return; // gog not installed — skip entirely
  }

  // Ensure file-based keyring on EBS
  try {
    await execFileAsync("gog", ["auth", "keyring", "file"], { timeout: 5_000 });
  } catch (err) {
    log.warn(`gog auth keyring file failed: ${String(err)}`);
  }

  // Load client credentials from env if available
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const clientJson = JSON.stringify({
      installed: {
        client_id: clientId,
        client_secret: clientSecret,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
      },
    });
    const tmpPath = "/tmp/gog-client-secret.json";
    try {
      await fs.writeFile(tmpPath, clientJson);
      await execFileAsync("gog", ["auth", "credentials", "set", tmpPath], { timeout: 5_000 });
    } catch (err) {
      log.warn(`gog auth credentials set failed: ${String(err)}`);
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  // Check if already authenticated
  try {
    const { stdout } = await execFileAsync("gog", ["auth", "list"], { timeout: 5_000 });
    const email = stdout
      .split("\n")
      .find((l) => l.includes("@"))
      ?.split("\t")[0]
      ?.trim();
    if (email) {
      log.info(`gog already authenticated as ${email}`);
      await updateToolsWithGogAuth(email, log);
      return;
    }
  } catch {
    // not authenticated or gog error — continue to restore
  }

  // Attempt to restore from DynamoDB
  const store = createCredentialStore();
  if (!store) return;

  const creds = await store.getGoogleCredentials();
  if (!creds) {
    log.info("no Google credentials in DynamoDB to restore");
    return;
  }

  log.info(`restoring gog credentials for ${creds.email} (services: ${creds.services.join(", ")})`);
  const importJson = JSON.stringify({
    email: creds.email,
    client: "default",
    refresh_token: creds.refreshToken,
    services: creds.services,
    scopes: creds.scopes,
  });

  await execGogImport(importJson);
  await updateToolsWithGogAuth(creds.email, log);
  await clearStaleSessions(log);
  log.info("gog credentials restored from DynamoDB");
}
