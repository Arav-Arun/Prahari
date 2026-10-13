import type { NextConfig } from "next";
import { config } from "dotenv";
import { resolve } from "node:path";

// Share the repository's server-only deployer settings with this workspace.
// A blank value in apps/web/.env.local must not mask the real server value in
// the root .env, but all other app-local settings remain untouched.
const rootEnv = config({ path: resolve(process.cwd(), '../../.env') }).parsed ?? {};
for (const name of [
  'DEPLOYER_PRIVATE_KEY',
  'ALCHEMY_SEPOLIA_URL',
  'SEPOLIA_IDENTITY_REGISTRY_ADDRESS',
  'SEPOLIA_INCIDENT_REGISTRY_ADDRESS',
  'SARVAM_API_KEY',
  'SARVAM_CHAT_MODEL',
  'SARVAM_STT_MODEL',
  'SARVAM_TTS_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_VISION_MODEL',
  'OPENAI_TEXT_MODEL',
  'RESEND_API_KEY',
  'EMERGENCY_FROM_EMAIL',
  'EMERGENCY_ALERT_RECIPIENT',
]) {
  if (!process.env[name] && rootEnv[name]) {
    process.env[name] = rootEnv[name];
  }
}

const nextConfig: NextConfig = {
  typedRoutes: true,
};

export default nextConfig;
